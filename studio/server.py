"""Loopback replay and owned CPU simulation gateway. No hardware control interface."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import re
import secrets
import socket
import threading
from urllib.parse import parse_qs, unquote, urlparse

from studio.model import RobotModel

ROOT = Path(__file__).resolve().parents[1]


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
        self.cache = {}
        self.models = {}
        self.lock = threading.RLock()
        self.providers = {}
        self.workbench = None

    def enable_workbench(self, data_root=None):
        from studio.workbench import Workbench, DATA_ROOT
        self.workbench = Workbench(self, data_root or DATA_ROOT)

    def register(self, key, path, label, provider=None):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', key):
            raise ValueError('Invalid session ID')
        with self.lock:
            self.entries[key] = {'id': key, 'path': str(path), 'label': label}
            if provider:
                self.providers[key] = provider
            self.cache.pop(key, None)

    def listing(self):
        return {"sessions": [{"id": k, "label": v.get("label", k),
                              "description": v.get("description", ""),
                              "available": Path(v["path"]).exists() or k in self.providers}
                             for k, v in self.entries.items()],
                "mode": "replay", "hardware_enabled": False, "read_only": True}

    def session(self, key):
        from studio.replay import load_session
        with self.lock:
            if key not in self.entries:
                raise KeyError("Unknown session")
            if key not in self.cache or key in self.providers:
                item = self.entries[key]
                if key in self.providers:
                    data = self.providers[key]()
                elif Path(item['path']).suffix.lower() == '.json':
                    from studio.workbench import read_json
                    data = read_json(item['path'])
                    if data.get('schema_version') != 1 or not data.get('frames'):
                        raise ValueError('Invalid owned simulation recording')
                elif Path(item["path"]).suffix.lower() == ".jsonl":
                    from studio.capture_replay import load_capture
                    data = load_capture(item["path"])
                elif Path(item["path"]).suffix.lower() == ".mcap":
                    from studio.export import load_mcap
                    data = load_mcap(item["path"])
                else:
                    data = load_session(item["path"], environment_path=item.get("environment_path"))
                data["metadata"]["catalog_id"] = key
                # JSON encoding validates finite values before any response is served.
                body = json.dumps(data, allow_nan=False, separators=(",", ":")).encode()
                if len(body) > 64 * 1024 * 1024:
                    raise ValueError("Session exceeds 64 MiB browser replay limit; split recording")
                self.cache[key] = (data, body)
            return self.cache[key]

    def model(self, key):
        with self.lock:
            if key not in self.models:
                data, _ = self.session(key)
                if not data["metadata"].get("model_path"):
                    raise ValueError("Robot model and pose were not captured in this diagnostics session")
                self.models[key] = RobotModel(data["metadata"]["model_path"], key)
            return self.models[key]


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


def loopback_gateways(port, catalog):
    """Bind both localhost families or fail without leaving a partial service."""
    ipv4 = Gateway(("127.0.0.1", port), catalog)
    try:
        ipv6 = Gateway(("::1", ipv4.server_port), catalog)
    except Exception:
        ipv4.server_close()
        raise
    return [ipv4, ipv6]


def loopback_authority(authority):
    """Accept only local authorities, including a tunnel's different local port."""
    if not isinstance(authority, str):
        return False
    match = re.fullmatch(r"(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?", authority)
    return bool(match and (match[1] is None or int(match[1]) <= 65535))


class Handler(BaseHTTPRequestHandler):
    server_version = "G1Replay/0.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        # Keep mesh requests from overwhelming the terminal.
        if args and not str(args[0]).startswith("GET /assets/"):
            super().log_message(fmt, *args)

    def respond(self, data, kind="application/json", status=200):
        if not isinstance(data, bytes):
            data = json.dumps(data, allow_nan=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=3600" if kind == "application/octet-stream" else "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

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
            if path == '/api/workbench' and workbench:
                return self.respond(workbench.description())
            if path == '/api/map' and workbench:
                return self.respond(workbench.map(query.get('id', ['flat-ground'])[0]))
            if path == '/api/scenarios' and workbench:
                key = query.get('id', [None])[0]
                with workbench.lock:
                    return self.respond(workbench.scenarios[key] if key else {'scenarios': list(workbench.scenarios.values())})
            if path == '/api/jobs' and workbench:
                key = query.get('id', [None])[0]
                return self.respond(workbench.job(key) if key else workbench.list_jobs())
            if path == '/api/sensors':
                from studio.sensors import get_sensor_snapshot
                key = query.get('session', [next(iter(catalog.entries))])[0]
                at = float(query.get('time', ['0'])[0])
                return self.respond(get_sensor_snapshot(catalog.session(key)[0], at))
            if path == "/api/sessions":
                return self.respond(catalog.listing())
            if path == "/api/safety":
                return self.respond({"mode": "replay", "hardware_enabled": False, "publishers": [],
                                     "dds_participants": 0, "binding": self.server.server_address[0], "read_only": not bool(workbench),
                                     "hardware_read_only": True, "simulation_jobs_enabled": bool(workbench),
                                     "allowed_mutations": ['local scenarios', 'map imports', 'owned CPU simulation jobs'] if workbench else []})
            if path in ("/api/session", "/api/model", "/api/kinematics", "/api/export"):
                key = query.get("id", [next(iter(catalog.entries))])[0]
                if path == "/api/session":
                    return self.respond(catalog.session(key)[1])
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
            if path.startswith("/assets/model/"):
                parts = path.split("/")
                if len(parts) != 5:
                    raise KeyError("Unknown asset")
                asset = catalog.model(parts[3]).assets[parts[4]]
                return self.respond(asset.read_bytes(), "application/octet-stream")
            if path.startswith("/vendor/three/"):
                base = ROOT / "node_modules/three"
                relative = path[len("/vendor/three/"):]
            else:
                base = ROOT / "apps/web"
                relative = "index.html" if path == "/" else path.lstrip("/")
            target = (base / relative).resolve()
            if not target.is_relative_to(base.resolve()) or not target.is_file():
                raise KeyError("Not found")
            kind = mimetypes.guess_type(target)[0] or "application/octet-stream"
            return self.respond(target.read_bytes(), kind)
        except (BrokenPipeError, ConnectionResetError):
            return
        except KeyError:
            self.respond({"error": "Unknown session or resource"}, status=404)
        except (ValueError, FileNotFoundError) as error:
            self.respond({"error": str(error)}, status=422)

    def do_POST(self):
        if not self.authorize_local():
            return
        path = urlparse(self.path).path
        workbench = self.server.catalog.workbench
        if not workbench or path not in ('/api/scenarios', '/api/maps/import', '/api/jobs', '/api/jobs/cancel'):
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
            elif path == '/api/jobs':
                result = workbench.start_job(data.get('scenario_id'))
            else:
                result = workbench.cancel_job(data.get('id'))
            return self.respond(result, status=201)
        except KeyError:
            self.respond({'error': 'Unknown map, scenario or owned job'}, status=404)
        except (ValueError, OSError) as error:
            self.respond({'error': str(error)}, status=422)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--config", type=Path, default=ROOT / "config/sessions.json")
    args = parser.parse_args()
    catalog = Catalog(args.config)
    catalog.enable_workbench()
    servers = loopback_gateways(args.port, catalog)
    ipv4, ipv6 = servers
    worker = threading.Thread(target=ipv6.serve_forever, daemon=True)
    worker.start()
    print(f"G1 Deploy Studio: http://127.0.0.1:{ipv4.server_port}  "
          f"[REPLAY + CPU SIMULATION; HARDWARE DISABLED; IPv4 + IPv6 loopback]", flush=True)
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
