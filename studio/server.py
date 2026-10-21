"""Loopback replay and owned CPU simulation gateway. No hardware control interface."""
from __future__ import annotations

import argparse
import base64
from collections import OrderedDict
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import re
import secrets
import socket
import subprocess
import threading
import time
from urllib.parse import parse_qs, unquote, urlparse

from studio.model import RobotModel

ROOT = Path(__file__).resolve().parents[1]
MAX_SESSION_BYTES = 64 * 1024 * 1024
CACHE_ENTRIES = 4
# Encoded bytes plus decoded Python objects (about 4x the JSON size) per entry.
CACHE_BUDGET_BYTES = 768 * 1024 * 1024
SEND_CHUNK = 256 * 1024
COMPRESSIBLE = ('application/json', 'text/', 'application/javascript', 'model/stl',
                'image/svg+xml')
QUIET_PREFIXES = ('/api/sensors', '/api/jobs', '/assets/', '/vendor/', '/api/version')
# Runs written by tools/l3_rehearsal.sh (outside Git). Discovered read-only; never launched from here.
L3_BASE = Path.home() / 'research-data/g1-deploy-studio/l3'
L3_RESCAN_S = 10.0
L3_GROUP = 'Real-time rehearsals (L3)'
INDEX_HTML = ROOT / 'apps/web/index.html'
INLINE_SCRIPT = re.compile(rb'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', re.S)
_script_policy = {}


def script_policy(index=INDEX_HTML):
    """script-src allowing only same-origin files and the hashed inline scripts of index.html (the importmap)."""
    try:
        stat = index.stat()
        key = (str(index), stat.st_mtime_ns, stat.st_size)
        if _script_policy.get('key') != key:
            hashes = [f"'sha256-{base64.b64encode(hashlib.sha256(body).digest()).decode()}'"
                      for body in INLINE_SCRIPT.findall(index.read_bytes())]
            _script_policy.update(key=key, value=' '.join(["script-src 'self'", *hashes]))
        return _script_policy['value']
    except OSError:
        return "script-src 'self'"



class Encoded:
    """One immutable response body with a lazily computed gzip variant."""

    def __init__(self, body: bytes, kind: str):
        self.body = body
        self.kind = kind
        self.etag = '"' + hashlib.sha1(body).hexdigest() + '"'
        self._gzip = None
        self._lock = threading.Lock()

    def gzip(self) -> bytes:
        with self._lock:
            if self._gzip is None:
                self._gzip = gzip.compress(self.body, compresslevel=5, mtime=0)
            return self._gzip

    @property
    def cost(self):
        return len(self.body) * 5 + len(self._gzip or b'')


def build_identity(root=ROOT):
    """Served revision of this checkout. Read once; never trusted as a lock."""
    def git(*args):
        try:
            return subprocess.run(['git', '--no-optional-locks', '-C', str(root), *args], capture_output=True, text=True,
                                  timeout=3, check=True).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
    status = git('status', '--porcelain', '--untracked-files=no')
    return {'commit': git('rev-parse', 'HEAD'), 'describe': git('log', '-1', '--format=%h %s'),
            'committed_at': git('log', '-1', '--format=%cI'),
            'dirty': None if status is None else bool(status), 'root': str(root),
            'started_unix_s': time.time()}


def mark_l3(data, provenance_path):
    """Label a recording made by tools/l3_rehearsal.sh as L3, with its isolation receipt."""
    try:
        provenance = json.loads(Path(provenance_path).read_text())
    except (OSError, ValueError):
        provenance = None
    m = data['metadata']
    m['fidelity'] = 'L3'
    m['l3_provenance'] = provenance
    m['title'] = f"L3 real-time · {Path(provenance_path).parent.name}"
    note = ('Recorded by tools/l3_rehearsal.sh: the unchanged simulator, C++ SONIC runner and planner node as separate '
            'processes inside a user+net+pid namespace with only a private loopback (DDS domain 0 cannot leave it). '
            'Timing ran on a shared GPU under contention. Not hardware evidence.')
    m['limitations'] = [note] + [x for x in m.get('limitations', []) if 'Historical simulator configuration' not in x]
    limits = (provenance or {}).get('actuator_limits')
    if limits:
        # The L3 simulator clips the hips itself; expose it like a rehearsal's actuator profile so an
        # L3 vs L1/L2 comparison is made against the matching (`source`) profile.
        hips = {f'{side}_hip_{j}_joint': {'before_nm': limits[f'hip_{j}_nm'], 'after_nm': limits[f'hip_{j}_nm']}
                for side in ('left', 'right') for j in ('pitch', 'roll', 'yaw')}
        m['actuators'] = {'profile': 'source', 'label': f"L3 simulator clip · {limits['hip_pitch_nm']}/{limits['hip_roll_nm']}/{limits['hip_yaw_nm']}",
                          'hips': hips, 'basis': limits.get('source')}


class NoRecording(LookupError):
    """A known session whose recording does not exist (e.g. a run cancelled before writing one)."""


class Catalog:
    def __init__(self, config=ROOT / "config/sessions.json"):
        document = json.loads(Path(config).read_text())
        entries = document["sessions"]
        self.entries = {}
        for item in entries:
            key = item["id"]
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", key) or key in self.entries:
                raise ValueError("Session IDs must be unique URL-safe identifiers")
            self.entries[key] = item
        self.cache = OrderedDict()
        self.models = {}
        self.meshes = {}
        self.lock = threading.RLock()
        self._loading = {}
        self.providers = {}
        self.workbench = None
        self.policies = None
        self.l3_base = L3_BASE

    def enable_workbench(self, data_root=None):
        from studio.workbench import Workbench, DATA_ROOT
        self.workbench = Workbench(self, data_root or DATA_ROOT)

    def register(self, key, path, label, provider=None, extra=None):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', key):
            raise ValueError('Invalid session ID')
        with self.lock:
            self.entries[key] = {'id': key, 'path': str(path), 'label': label, **(extra or {})}
            if provider:
                self.providers[key] = provider
            else:
                self.providers.pop(key, None)
            self.cache.pop(key, None)

    def discover_l3(self, base=None, *, force=False):
        """Register completed L3 runs (rehearse/sim.npz) and their wire captures. Read-only, throttled."""
        base = Path(base) if base is not None else self.l3_base
        now = time.monotonic()
        if not force and now - getattr(self, '_l3_scanned', -L3_RESCAN_S) < L3_RESCAN_S:
            return
        self._l3_scanned = now
        if base is None or not base.is_dir():
            return
        for run in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith('.')):
            slug = re.sub(r'[^a-zA-Z0-9_-]', '-', run.name)[:50]
            provenance = run / 'l3_provenance.json'
            rehearse = run / 'rehearse'
            started = (run / 't0').stat().st_mtime if (run / 't0').exists() else None
            extra = {'group': L3_GROUP, 'started_unix_s': started, 'l3_provenance': str(provenance) if provenance.is_file() else None}
            with self.lock:
                if (rehearse / 'sim.npz').is_file() and f'l3-{slug}' not in self.entries:
                    boxes = rehearse / 'boxes.json'
                    self.entries[f'l3-{slug}'] = {'id': f'l3-{slug}', 'path': str(rehearse), 'label': f'L3 real-time · {run.name}',
                                                  'environment_path': str(boxes) if boxes.is_file() else None, **extra}
                if (run / 'capture.jsonl').is_file() and f'l3-{slug}-wire' not in self.entries:
                    self.entries[f'l3-{slug}-wire'] = {'id': f'l3-{slug}-wire', 'path': str(run / 'capture.jsonl'),
                                                       'label': f'L3 wire capture · {run.name}', **extra}

    def listing(self):
        self.discover_l3()
        with self.lock:
            items = list(self.entries.items())
            live = set(self.providers)
        sessions = []
        for k, v in items:
            row = {"id": k, "label": v.get("label", k), "description": v.get("description", ""),
                   "available": Path(v["path"]).exists() or k in live,
                   "group": v.get("group") or ('CPU rehearsals' if k.startswith('job-') else 'Recordings')}
            for field in ('outcome', 'policy_id', 'started_unix_s', 'scenario_label', 'map_id', 'status', 'suite_id'):
                if v.get(field) is not None:
                    row[field] = v[field]
            sessions.append(row)
        return {"sessions": sessions, "mode": "replay", "hardware_enabled": False, "read_only": True}

    def _decode(self, key, item):
        from studio.replay import load_session
        if not Path(item['path']).exists():
            status = item.get('status')
            raise NoRecording(f"{key} has no replayable recording" + (f" (status: {status})" if status else ''))
        suffix = Path(item['path']).suffix.lower()
        if suffix == '.json':
            from studio.workbench import read_json
            data = read_json(item['path'])
            if data.get('schema_version') != 1 or not data.get('frames'):
                raise ValueError('Invalid owned simulation recording')
        elif suffix == ".jsonl":
            from studio.capture_replay import load_capture
            data = load_capture(item["path"])
        elif suffix == ".mcap":
            from studio.export import load_mcap
            data = load_mcap(item["path"])
        else:
            data = load_session(item["path"], environment_path=item.get("environment_path"))
        if item.get('l3_provenance'):
            mark_l3(data, Path(item['l3_provenance']))
        return data

    def _finish(self, key, data):
        data["metadata"]["catalog_id"] = key
        # JSON encoding validates finite values before any response is served.
        body = json.dumps(data, allow_nan=False, separators=(",", ":")).encode()
        if len(body) > MAX_SESSION_BYTES:
            raise ValueError("Session exceeds 64 MiB browser replay limit; split recording")
        return data, Encoded(body, 'application/json')

    def entry(self, key):
        """Return (data, Encoded). Decodes run outside the catalog-wide lock."""
        with self.lock:
            if key not in self.entries:
                raise KeyError("Unknown session")
            item = dict(self.entries[key])
            provider = self.providers.get(key)
            if provider is None and key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            gate = self._loading.setdefault(key, threading.Lock())
        if provider is not None:
            # Live providers refresh every request and are never cached.
            return self._finish(key, provider())
        with gate:
            with self.lock:
                if key in self.cache:
                    self.cache.move_to_end(key)
                    return self.cache[key]
            result = self._finish(key, self._decode(key, item))
            with self.lock:
                if self.entries.get(key, {}).get('path') == item['path'] and key not in self.providers:
                    self.cache[key] = result
                    self.cache.move_to_end(key)
                    while len(self.cache) > CACHE_ENTRIES or (
                            len(self.cache) > 1 and sum(e[1].cost for e in self.cache.values()) > CACHE_BUDGET_BYTES):
                        self.cache.popitem(last=False)
                self._loading.pop(key, None)
            return result

    def session(self, key):
        data, encoded = self.entry(key)
        # Stable pair per cached decode, so repeated reads share one object.
        pair = encoded.__dict__.get('pair')
        if pair is None or pair[0] is not data:
            pair = encoded.pair = (data, encoded.body)
        return pair

    def model(self, key):
        data, _ = self.entry(key)
        path = data["metadata"].get("model_path")
        if not path:
            raise ValueError("Robot model and pose were not captured in this diagnostics session")
        resolved = str(Path(path).resolve())
        with self.lock:
            model = self.models.get(resolved)
        if model is None:
            model = RobotModel(resolved, key)
            with self.lock:
                model = self.models.setdefault(resolved, model)
                self.meshes.update(model.assets)
        return model

    def mesh(self, token):
        with self.lock:
            return self.meshes[token]


class Gateway(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16
    allow_reuse_address = True

    def __init__(self, address, catalog):
        if address[0] not in {"127.0.0.1", "::1"}:
            raise ValueError("Replay gateway binds only literal loopback addresses; use an authenticated SSH tunnel")
        self.address_family = socket.AF_INET6 if address[0] == "::1" else socket.AF_INET
        self.catalog = catalog
        self.slots = threading.BoundedSemaphore(12)
        self.static = {}
        self.static_lock = threading.Lock()
        self.identity = build_identity()
        super().__init__(address, Handler)

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            # An explicit IPv6 loopback listener, never a wildcard or dual-stack bind.
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            # A bounded, small response explains overload instead of resetting the
            # tunnel's TCP connection without an HTTP response.
            try:
                request.settimeout(0.1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\n"
                                b"Content-Length: 0\r\nRetry-After: 1\r\n"
                                b"Connection: close\r\n\r\n")
            except OSError:
                pass
            request.close()
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def static_file(self, target: Path, kind: str) -> Encoded:
        """Small in-memory cache of served files keyed by path, size and mtime."""
        stat = target.stat()
        key = (str(target), stat.st_size, stat.st_mtime_ns)
        with self.static_lock:
            hit = self.static.get(str(target))
            if hit and hit[0] == key:
                return hit[1]
        encoded = Encoded(target.read_bytes(), kind)
        with self.static_lock:
            self.static[str(target)] = (key, encoded)
            if len(self.static) > 256:
                self.static.pop(next(iter(self.static)))
        return encoded


def loopback_gateways(port, catalog):
    """Bind both localhost families or fail without leaving a partial service."""
    ipv4 = Gateway(("127.0.0.1", port), catalog)
    try:
        ipv6 = Gateway(("::1", ipv4.server_port), catalog)
    except Exception:
        ipv4.server_close()
        raise
    ipv6.identity = ipv4.identity
    return [ipv4, ipv6]


def loopback_authority(authority):
    """Accept only local authorities, including a tunnel's different local port."""
    if not isinstance(authority, str):
        return False
    match = re.fullmatch(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?", authority)
    return bool(match and (match[1] is None or int(match[1]) <= 65535))


class Handler(BaseHTTPRequestHandler):
    server_version = "G1Replay/0.2"

    def setup(self):
        super().setup()
        # Per socket operation; bodies are written in bounded chunks below so a
        # slow authenticated tunnel is not limited to a 15 s total transfer.
        self.connection.settimeout(15)

    def log_request(self, code='-', size='-'):
        # Keep polling and mesh requests from overwhelming the service journal.
        try:
            ok = int(code) < 400
        except (TypeError, ValueError):
            ok = False
        if ok and self.command in ('GET', 'HEAD') and urlparse(self.path).path.startswith(QUIET_PREFIXES):
            return
        super().log_request(code, size)

    def _headers(self, kind, length, cache, etag=None, encoding=None):
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", f"default-src 'self'; {script_policy()}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()

    def _write(self, data):
        if self.command == "HEAD":
            return
        view = memoryview(data)
        for offset in range(0, len(view), SEND_CHUNK):
            self.wfile.write(view[offset:offset + SEND_CHUNK])

    def respond(self, data, kind="application/json", status=200):
        if not isinstance(data, bytes):
            data = json.dumps(data, allow_nan=False, separators=(",", ":")).encode()
        gz = (status == 200 and len(data) > 4096 and kind.startswith(COMPRESSIBLE)
              and 'gzip' in self.headers.get('Accept-Encoding', ''))
        if gz:
            data = gzip.compress(data, compresslevel=4, mtime=0)
        self.send_response(status)
        self._headers(kind, len(data), "no-store", encoding='gzip' if gz else None)
        self._write(data)

    def respond_cached(self, encoded: Encoded, cache="private, no-cache"):
        """Revalidated (ETag) response with a reusable gzip body."""
        gz = (len(encoded.body) > 1024 and encoded.kind.startswith(COMPRESSIBLE)
              and 'gzip' in self.headers.get('Accept-Encoding', ''))
        # Each encoding is a distinct representation with its own strong validator.
        gz_etag = encoded.etag[:-1] + '-gz"'
        etag = gz_etag if gz else encoded.etag
        # Either validator identifies the same content, so both revalidate.
        if self.headers.get('If-None-Match') in (encoded.etag, gz_etag):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            return
        body, encoding = (encoded.gzip(), 'gzip') if gz else (encoded.body, None)
        self.send_response(200)
        self._headers(encoded.kind, len(body), cache, etag, encoding)
        self._write(body)

    def do_HEAD(self):
        self.do_GET()

    def authorize_local(self):
        # Reject cross-site fetches and DNS rebinding even on a loopback listener.
        # SSH/app forwarding can preserve the browser's local authority, whose
        # port need not equal the backend port. Never trust arbitrary hostnames
        # or X-Forwarded-* headers to establish that local boundary.
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1 or not loopback_authority(hosts[0]):
            self.respond({"error": "Loopback Host required"}, status=403)
            return False
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1 or (origins and origins[0] != f"http://{hosts[0]}"):
            self.respond({"error": "Cross-origin telemetry access denied"}, status=403)
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.respond({"error": "Cross-site access denied"}, status=403)
            return False
        return True

    def do_GET(self):
        if not self.authorize_local():
            return
        try:
            route = urlparse(self.path)
            path = unquote(route.path)
            query = parse_qs(route.query)
            catalog = self.server.catalog
            workbench = catalog.workbench
            if path == '/api/version':
                return self.respond(dict(self.server.identity, hardware_enabled=False))
            if path == '/api/workbench' and workbench:
                return self.respond(workbench.description())
            if path == '/api/map' and workbench:
                return self.respond(workbench.map(query.get('id', ['flat-ground'])[0]))
            if path == '/api/scenarios' and workbench:
                key = query.get('id', [None])[0]
                with workbench.lock:  # copy under the lock; never write a response while holding it
                    body = json.dumps(workbench.scenarios[key] if key else {'scenarios': list(workbench.scenarios.values())},
                                      allow_nan=False, separators=(',', ':')).encode()
                return self.respond(body)
            if path == '/api/jobs' and workbench:
                key = query.get('id', [None])[0]
                if not key:
                    return self.respond(workbench.list_jobs())
                after = query.get('perception_after', [None])[0]
                try:
                    after = float(after) if after not in (None, '', '-Infinity') else None
                except ValueError:
                    raise ValueError('perception_after must be a number') from None
                return self.respond(workbench.job(key, light=query.get('light', ['0'])[0] == '1', perception_after=after))
            if path == '/api/suites' and workbench:
                key = query.get('id', [None])[0]
                return self.respond(workbench.suite(key) if key else workbench.list_suites())
            if path == '/api/runs' and workbench:
                return self.respond(workbench.runs_table())
            if path == '/api/nav/check' and workbench:
                key = query.get('id', [None])[0]
                try:
                    xy = [float(query.get('x', [''])[0]), float(query.get('y', [''])[0])]
                except ValueError:
                    raise ValueError('x and y must be numbers in metres') from None
                return self.respond(workbench.nav_check(key, xy))
            if path == '/api/nav/map' and workbench:
                return self.respond(workbench.nav_map(query.get('id', [None])[0]))
            if path == '/api/nav/robot' and workbench:
                return self.respond(workbench.robot_link_status())
            if path == '/api/nav/options' and workbench:
                from studio.workbench import NAV_PLANNER, NAV_ODOMETRY
                return self.respond({'planner': {k: v['label'] for k, v in NAV_PLANNER.items()}, 'odometry': list(NAV_ODOMETRY)})
            if path == '/api/policies' and workbench:
                return self.respond(workbench.policy_catalog())
            if path == '/api/robot':
                from studio.robot_profile import load_profile
                return self.respond(load_profile())
            if path == '/api/sensors':
                from studio.sensors import get_sensor_snapshot
                key = query.get('session', [next(iter(catalog.entries), None)])[0]
                if key is None:
                    raise KeyError('No session')
                at = float(query.get('time', ['0'])[0])
                snapshot = get_sensor_snapshot(catalog.session(key)[0], at,
                                               include_masks=query.get('masks', ['0'])[0] == '1')
                return self.respond(snapshot)
            if path == "/api/sessions":
                return self.respond(catalog.listing())
            if path == "/api/safety":
                return self.respond({"mode": "replay", "hardware_enabled": False, "publishers": [],
                                     "dds_participants": 0, "binding": self.server.server_address[0], "read_only": not bool(workbench),
                                     "hardware_read_only": True, "simulation_jobs_enabled": bool(workbench),
                                     "allowed_mutations": ['local scenarios', 'map imports', 'owned CPU simulation jobs'] if workbench else []})
            if path in ("/api/session", "/api/model", "/api/kinematics", "/api/export"):
                key = query.get("id", [next(iter(catalog.entries), None)])[0]
                if key is None:
                    raise KeyError("No session")
                if path == "/api/session":
                    data, encoded = catalog.entry(key)
                    live = key in catalog.providers
                    return self.respond_cached(encoded, "no-store" if live else "private, no-cache")
                if path == "/api/export":
                    from studio.export import encode_mcap
                    return self.respond(encode_mcap(catalog.session(key)[0]), "application/octet-stream")
                model = catalog.model(key)
                if path == "/api/model":
                    return self.respond(model.description)
                data, _ = catalog.session(key)
                index = int(query.get("frame", ["0"])[0])
                if index < 0 or index >= len(data["frames"]):
                    raise ValueError("Frame out of range")
                return self.respond(model.body_poses(data["frames"][index]["qpos"]))
            if path.startswith("/assets/mesh/"):
                match = re.fullmatch(r"/assets/mesh/([0-9a-f]{64})\.stl", path)
                if not match:
                    raise KeyError("Unknown asset")
                target = catalog.mesh(match[1])
                encoded = self.server.static_file(target, "model/stl")
                return self.respond_cached(encoded, "private, max-age=31536000, immutable")
            if path.startswith("/vendor/three/"):
                base = ROOT / "node_modules/three"
                relative = path[len("/vendor/three/"):]
                cache = "private, max-age=86400"
            else:
                base = ROOT / "apps/web"
                relative = "index.html" if path == "/" else path.lstrip("/")
                cache = "private, no-cache"
            target = (base / relative).resolve()
            if not target.is_relative_to(base.resolve()) or not target.is_file():
                raise KeyError("Not found")
            kind = mimetypes.guess_type(target)[0] or "application/octet-stream"
            if kind == 'text/javascript':
                kind = 'application/javascript'
            return self.respond_cached(self.server.static_file(target, kind), cache)
        except (BrokenPipeError, ConnectionResetError):
            return
        except NoRecording as error:
            self.respond({"error": str(error)}, status=404)
        except KeyError:
            self.respond({"error": "Unknown session or resource"}, status=404)
        except (ValueError, FileNotFoundError) as error:
            self.respond({"error": str(error)}, status=422)
        except TypeError as error:
            self.respond({"error": f"Invalid request value: {error}"}, status=422)

    POST_ROUTES = ('/api/scenarios', '/api/maps/import', '/api/jobs', '/api/jobs/cancel',
                   '/api/arenas', '/api/suites', '/api/suites/cancel', '/api/nav/start', '/api/nav/command', '/api/nav/twin')

    def do_POST(self):
        if not self.authorize_local():
            return
        path = urlparse(self.path).path
        workbench = self.server.catalog.workbench
        if not workbench or path not in self.POST_ROUTES:
            return self.respond({'error': 'No hardware/control endpoint; only local preparation and owned CPU tests are supported'}, status=405)
        if not self.headers.get('Origin') or not secrets.compare_digest(self.headers.get('X-Studio-Token', ''), workbench.token):
            return self.respond({'error': 'Same-origin preparation token required'}, status=403)
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.respond({'error': 'JSON body required'}, status=415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4*1024*1024:
                raise ValueError('Request must contain 1 byte to 4 MiB of JSON')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete request body')
            data = json.loads(raw, parse_constant=lambda s: (_ for _ in ()).throw(ValueError(f'Invalid JSON number {s}')))
            if not isinstance(data, dict):
                raise ValueError('JSON object required')
            if path == '/api/scenarios':
                result = workbench.save_scenario(data)
            elif path == '/api/maps/import':
                result = workbench.import_map(data)
            elif path == '/api/arenas':
                result = workbench.save_arena(data)
            elif path == '/api/jobs':
                result = workbench.start_job(data.get('scenario_id'))
            elif path == '/api/suites':
                result = workbench.start_suite(data)
            elif path == '/api/suites/cancel':
                result = workbench.cancel_suite(data.get('id'))
            elif path == '/api/nav/start':
                result = workbench.start_navigation(data)
            elif path == '/api/nav/command':
                result = workbench.nav_command(data.get('id'), data)
            elif path == '/api/nav/twin':
                result = workbench.nav_twin(data)
            else:
                result = workbench.cancel_job(data.get('id'))
            return self.respond(result, status=201)
        except KeyError:
            self.respond({'error': 'Unknown map, scenario, suite or owned job'}, status=404)
        except (ValueError, OSError) as error:
            self.respond({'error': str(error)}, status=422)
        except TypeError as error:
            # Malformed JSON value types are invalid input, never a dropped connection.
            self.respond({'error': f'Invalid request value: {error}'}, status=422)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--config", type=Path, default=ROOT / "config/sessions.json")
    parser.add_argument("--data-root", type=Path, default=None,
                        help="Workbench data root (default ~/research-data/g1-deploy-studio/workbench)")
    args = parser.parse_args()
    catalog = Catalog(args.config)
    catalog.enable_workbench(args.data_root)
    servers = loopback_gateways(args.port, catalog)
    ipv4, ipv6 = servers
    worker = threading.Thread(target=ipv6.serve_forever, daemon=True)
    worker.start()
    print(f"G1 Deploy Studio: http://127.0.0.1:{ipv4.server_port}  "
          f"[REPLAY + CPU SIMULATION; HARDWARE DISABLED; IPv4 + IPv6 loopback] "
          f"build {ipv4.identity.get('commit') or 'unknown'}", flush=True)
    try:
        ipv4.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        ipv4.server_close()
        ipv6.shutdown()
        ipv6.server_close()
        worker.join()


if __name__ == "__main__":
    main()
