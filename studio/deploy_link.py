"""Deploy link: the gateway's side of the Deploy workspace (docs/DEPLOY.md).

The deploy kit owns every process and every motor gate: its console runs the SONIC runner and the planner node, and its
deploy service (`g1 lab --headless`, API v1) starts sessions, scans and rehearsals. Studio owns the experience. This
module is everything the gateway does for Deploy:

* an allowlisted, re-sanitised proxy to the deploy service (GET_ROUTES; POST acts through `Deploy.act`);
* the operator lease: one controlling page at a time, renewed by the page's 1 s heartbeat and lost 3 s after the last
  one (a hidden tab sends none). The gateway forwards it to every live console as act `lease {holder, until}`, so the
  phone panel's GO is refused while a Studio page holds it. Motion-enabling acts need it; Stand, Takeover, E-STOP never;
* goal checks on a scan's memory with the session profile's route configuration from the kit (Studio's generic
  parameters when the kit has none), scene frame in and out, each a receipt (`check_id`, good for 10 min) bound to the
  scan, its memory sha, the goal and the configuration's sha, that send_goal must carry;
* uncertain acts: a relayed act whose reply is lost answers 202 `{state: "unknown"}` and is never sent again; the
  console's act record says what happened (`act_status`);
* Review: a session's detail from the deploy service plus the exact Replay catalog id (forcing the catalog's
  discovery), and tags on ended sessions;
* the direct console heartbeat (each console measured now, on the E-STOP's path, while the deploy service is down);
* the audit log's health (write failures are counted and shown, never silent, never in the E-STOP's way);
* the E-STOP fast path: straight to the panel of every console the gateway last knew as live (port and token from the
  session's panel_url.txt, cached), never through the deploy service, in parallel with 1 s timeouts;
* the guards: what the deploy service says is live, for the workbench, Navigate's robot link and the service script.

Studio relays an operator's press and never makes one up; the gateway retries nothing. It has no DDS participant and no
motor path. Every gate is the console's, so Studio's E-STOP, the phone panel, the remote's Select while streaming and
the node's own stops all go through the console process: only the physical E-stop does not.

Frames (docs/DEPLOY.md): poses are [x, y, yaw]; "A_from_B" is the pose of B's origin in A. A scan's memory frame
(memory_S) has the robot at start_S; the scene is the scan robot frame (start_S at the origin), so
scene_from_memory = inverse(start_S) and goals cross the API only as goal_scene.

Configuration: `config/local.json` -> `deploy_service: {url, token_file}`; defaults http://127.0.0.1:8769 and
~/.config/g1-deploy/panel_token. G1_DEPLOY_SERVICE (a URL) and G1_PANEL_TOKEN win when set. The token stays in the gateway: the browser never sees
it. Loopback only, and no HTTP proxy is ever used.

Standard library only (numpy only inside the goal check, lazily): Navigate's robot link and tools/studio_service.sh
(`python -m studio.deploy_link live`) import it too.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import paths

DEFAULT_URL = "http://127.0.0.1:8769"
DEFAULT_TOKEN_FILE = Path.home() / ".config/g1-deploy/panel_token"
GET_TIMEOUT_S = 2.0
POST_TIMEOUT_S = 8.0
STATE_TIMEOUT_S = 1.0          # the background refresh and the guards: the hub serves its state from a 1 Hz cache
REFRESH_PERIOD_S = 1.0         # the refresher's period while a Deploy page was active in the last CLIENT_ACTIVE_S
CLIENT_ACTIVE_S = 60.0
GUARD_MAX_AGE_S = 2.0          # a guard asks the deploy service again when what it knows is older than this
LEASE_TTL_S = 3.0              # lost 3 s after the last heartbeat (the page renews every 1 s)
LEASE_FORWARD_S = 2.0          # re-sent to each live console this often while held ...
LEASE_FORWARD_MARGIN_S = 2.0   # ... with `until` this far past the lease's own expiry, so it never lapses in between
CHECK_TTL_S = 600.0            # a goal check's check_id is good for send_goal for 10 min
MAX_CHECKS = 512
HEARTBEAT_STALE_S = 1.0        # a console heartbeat older than this: CONSOLE NOT RESPONDING (the page's rule)
FORCED_DISCOVERY_S = 2.0       # Review forces the catalog's robot-sessions discovery at most this often
AUDIT_QUEUE = 1000             # E-STOP and the direct path hand their audit rows to a writer thread
# Studio's generic goal-check parameters (studio/goal_check.py defaults), used when the kit has no route configuration
# for the profile. Names as the kit's GET /api/v1/profile/<name>/route.
GENERIC_ROUTE = {"robot_radius_m": 0.30, "route_margin_m": 0.35, "step_over_m": 0.25, "ceiling_below_m": 1.35,
                 "ceiling_near_m": 0.8, "grow_unknown_m": 0.1, "goal_lookahead_m": None, "guards": None}
ROUTE_LIMITS = {"robot_radius_m": (0.05, 1.0), "route_margin_m": (0.0, 2.0), "step_over_m": (0.0, 1.0),
                "ceiling_below_m": (0.5, 3.0), "ceiling_near_m": (0.0, 3.0), "grow_unknown_m": (0.0, 2.0)}
ESTOP_TIMEOUT_S = 1.0          # per console; all consoles in parallel
DIRECT_TIMEOUT_S = 1.5         # Stand / Takeover: the console waits up to 1.0 s for its main loop before it answers
HEARTBEAT_TIMEOUT_S = 0.5      # GET /state of each console on the direct path
MAX_BLOCKING_CELLS = 200
AUDIT_MAX_BYTES = 16 * 1024 * 1024

# Studio route -> (hub path template, query keys passed through). {name} / {slot} come from the query.
GET_ROUTES = {
    "/api/deploy/state": ("/api/v1/state", ()),
    "/api/deploy/readiness": ("/api/v1/readiness", ("scan", "slot")),
    "/api/deploy/scan/live": ("/api/v1/scan/live", ()),
    "/api/deploy/scan/scene": ("/api/v1/scan/{name}/scene", ()),
    "/api/deploy/live": ("/api/v1/live/{slot}/view", ("cloud_after", "mem_after")),
    "/api/deploy/rehearsal/track": ("/api/v1/rehearsal/{name}/track", ()),
    "/api/deploy/manifest": ("/api/v1/session/{name}/manifest", ()),
    "/api/deploy/panel": ("/api/v1/panel/{slot}/state", ()),
    "/api/deploy/sessions": ("/api/v1/sessions", ("offset", "limit")),
    # contract v3
    "/api/deploy/rehearsal/match": ("/api/v1/rehearsal/match", ("scan", "x", "y", "profile", "odom")),
    "/api/deploy/session/receipt": ("/api/v1/session/{name}/receipt", ()),
    "/api/deploy/recording": ("/api/v1/session/{name}/recording", ()),
    "/api/deploy/profile/route": ("/api/v1/profile/{name}/route", ()),
}
# The v3 capability each v3 route needs (the deploy service's state lists its capabilities). A service without it
# answers 404 "unknown endpoint"; the gateway then answers {supported: false, capability} instead of guessing.
V3_CAPABILITY = {"/api/deploy/rehearsal/match": "rehearsal_match", "/api/deploy/session/receipt": "session_receipt",
                 "/api/deploy/recording": "recording_health", "/api/deploy/profile/route": "profile_route",
                 "/api/deploy/session": "session_detail", "/api/deploy/act_status": "act_status",
                 "/api/deploy/tag": "session_tag"}
V3_CAPABILITIES = ("session_receipt", "rehearsal_match", "rehearsal_identity", "passage", "act_status",
                   "session_detail", "session_tag", "profile_route", "recording_health", "manifest_v2")
# Where the gateway adds `source_age_s` (now - the source's own monotonic time; the deploy service, its consoles and
# this gateway share one host and one monotonic clock: loopback only).
SOURCE_CLOCK = {"/api/deploy/state": "t_mono", "/api/deploy/live": "t_mono", "/api/deploy/panel": "console_t_mono",
                "/api/deploy/recording": "t_mono"}
# Studio's POST /api/deploy/act {act, ...}: act -> hub path. Console acts go through /api/v1/act.
HUB_ACTS = {
    "start": "/api/v1/start", "stop": "/api/v1/stop", "scan": "/api/v1/scan", "practice_scan": "/api/v1/practice/scan",
    "rehearse": "/api/v1/rehearse", "start_check": "/api/v1/start_check", "send_goal": "/api/v1/send_goal",
    "doctor": "/api/v1/doctor",
}
CONSOLE_ACTS = {"arm", "s", "c", "g", "h", "t", "tag", "note"}
# Acts that start, arm, aim or move something need the operator lease. h (Stand), t (Takeover), E-STOP never do.
LEASED_ACTS = frozenset({"start", "arm", "s", "c", "send_goal", "g", "rehearse", "practice_scan", "scan", "stop"})
DIRECT_ACTS = ("h", "t")
# Served on the gateway's reserve admission tier too (studio/server.py): no CSRF token, X-Studio-Estop: 1 instead.
ESTOP_PATHS = ("/api/deploy/estop", "/api/deploy/direct")
SAFE_NAME = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
LOOPBACK = ("127.0.0.1", "localhost", "::1")
# Never route the deploy service or a console through an HTTP proxy from the environment.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class DeployError(Exception):
    """The deploy service refused or could not be reached; `status` is the HTTP status to answer with and `extra`
    fields go into the JSON error body."""

    def __init__(self, message, status=502, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra

    def body(self):
        return {"error": str(self), **self.extra}


class ReplyLost(DeployError):
    """The request reached the deploy service (it was sent) but its reply never came: timed out, or the connection
    closed first. What it did is unknown; an act in this state is reconciled through the console's act record."""


def unsupported(status, obj):
    """The deploy service does not have this endpoint (a kit before v3): its 404 says "unknown endpoint"."""
    return status == 404 and isinstance(obj, dict) and str(obj.get("error") or "").startswith("unknown endpoint")


def source_age(obj, key):
    """now - obj[key] (a host monotonic time), rounded; None when absent."""
    t = obj.get(key) if isinstance(obj, dict) else None
    if isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t):
        return round(max(0.0, time.monotonic() - t), 3)
    return None


def sanitize(value):
    """Strict JSON: non-finite floats become null (the gateway answers with allow_nan=False)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def safe_name(value):
    value = str(value or "")
    return bool(value) and set(value) <= SAFE_NAME and not value.startswith(".") and len(value) <= 128


def clean_operator(value, default=None):
    """An operator name as people type it: 1-64 printable characters, or `default`."""
    if not isinstance(value, str):
        return default
    value = re.sub(r"[\x00-\x1f\x7f]", "", value).strip()[:64]
    return value or default


# ----------------------------------------------------------------------------------------------- poses
def compose(a, b):
    """a ∘ b for poses [x, y, yaw]."""
    c, s = math.cos(a[2]), math.sin(a[2])
    return [a[0] + c * b[0] - s * b[1], a[1] + s * b[0] + c * b[1], a[2] + b[2]]


def inverse(a):
    c, s = math.cos(a[2]), math.sin(a[2])
    return [-(c * a[0] + s * a[1]), -(-s * a[0] + c * a[1]), -a[2]]


def apply(a, xy):
    """Points [x, y] (one or a list) given in B, in A, for the pose a = A_from_B."""
    c, s = math.cos(a[2]), math.sin(a[2])
    one = lambda p: [a[0] + c * p[0] - s * p[1], a[1] + s * p[0] + c * p[1]]
    if xy and isinstance(xy[0], (list, tuple)):
        return [one(p) for p in xy]
    return one(xy)


def _pose(value, name):
    if (not isinstance(value, (list, tuple)) or len(value) != 3
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)):
        raise DeployError(f"the deploy service sent no usable {name} (expected [x, y, yaw])", 502)
    return [float(v) for v in value]


# ----------------------------------------------------------------------------------------------- the deploy service
class DeployLink:
    """HTTP client of the deploy service (API v1, `?t=TOKEN` on every request)."""

    def __init__(self, url=None, token_file=None):
        cfg = paths.local_config().get("deploy_service", {})
        self.url = (url or os.environ.get("G1_DEPLOY_SERVICE") or cfg.get("url") or DEFAULT_URL).rstrip("/")
        parsed = urllib.parse.urlparse(self.url)
        if parsed.scheme != "http" or parsed.hostname not in LOOPBACK:
            raise ValueError("deploy_service.url must be an http:// loopback address")
        self.token_file = Path(token_file or cfg.get("token_file") or DEFAULT_TOKEN_FILE).expanduser()

    def token(self):
        env = os.environ.get("G1_PANEL_TOKEN")
        if env:
            return env
        try:
            return self.token_file.read_text().strip()
        except OSError:
            raise DeployError(f"no deploy service token: set G1_PANEL_TOKEN or create {self.token_file}", 503)

    def _request(self, method, path, query=None, body=None, timeout=GET_TIMEOUT_S):
        q = dict(query or {}, t=self.token())
        url = f"{self.url}{path}?{urllib.parse.urlencode(q)}"
        data = json.dumps(body, allow_nan=False).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"} if data is not None else {})
        try:
            with _OPENER.open(req, timeout=timeout) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except urllib.error.URLError as e:  # connecting or sending failed: the request never reached the service
            raise DeployError(f"the deploy service at {self.url} is not reachable ({getattr(e, 'reason', e)}); "
                              "start it on the deploy PC with ./g1 lab --headless", 503)
        except (OSError, http.client.HTTPException) as e:  # sent, then no reply (a timeout, a closed connection)
            raise ReplyLost(f"the deploy service did not answer {method} {path} "
                            f"({type(e).__name__}{': ' + str(e) if str(e) else ''})", 504)
        try:
            obj = json.loads(raw or b"{}")
        except ValueError:
            raise DeployError(f"the deploy service answered {status} with non-JSON", 502)
        return status, sanitize(obj)

    def get(self, route, query):
        """A proxied GET: route is a Studio path in GET_ROUTES, query a dict of single values."""
        template, passthrough = GET_ROUTES[route]
        fields = {}
        for key in ("name", "slot"):
            if "{" + key + "}" in template:
                value = str(query.get(key, ""))
                if not safe_name(value):
                    raise DeployError(f"a valid {key} is required", 400)
                fields[key] = value
        path = template.format(**fields)
        q = {k: str(query[k]) for k in passthrough if k in query}
        return self._request("GET", path, q)

    def state(self, timeout=STATE_TIMEOUT_S):
        return self._request("GET", "/api/v1/state", timeout=timeout)

    def get_path(self, path, query=None, timeout=GET_TIMEOUT_S):
        return self._request("GET", path, query, timeout=timeout)

    def post_path(self, path, body, timeout=POST_TIMEOUT_S):
        return self._request("POST", path, body=body, timeout=timeout)

    def act(self, body, timeout=POST_TIMEOUT_S):
        """A proxied operator act: hub acts by name, console acts through /api/v1/act."""
        act = body.get("act")
        if act in HUB_ACTS:
            return self._request("POST", HUB_ACTS[act], body={k: v for k, v in body.items() if k != "act"},
                                 timeout=timeout)
        if act in CONSOLE_ACTS or act == "lease":
            return self._request("POST", "/api/v1/act", body=body, timeout=timeout)
        raise DeployError(f"act {act!r} is not relayed by Studio", 400)


def read_panel_target(token_file, port_hint=None):
    """(port, token) of a console's panel from its panel_url.txt (`http://HOST:PORT/?t=TOKEN`). The host is ignored:
    Studio only ever sends to 127.0.0.1 (the panel binds there; a tailnet name in the file is for the phone)."""
    p = Path(str(token_file or ""))
    if p.name != "panel_url.txt":
        raise ValueError("the deploy service named no panel_url.txt for this console")
    with p.open("rb") as f:
        text = f.read(4096).decode("utf-8", "replace").strip()
    u = urllib.parse.urlparse(text.splitlines()[0] if text else "")
    token = urllib.parse.parse_qs(u.query).get("t", [None])[0]
    port = port_hint if isinstance(port_hint, int) and not isinstance(port_hint, bool) else u.port
    if not token or not isinstance(port, int) or not 0 < port < 65536:
        raise ValueError(f"{p} holds no panel port and token")
    return port, token


def console_get_state(port, token, timeout):
    """GET /state of a console's panel on 127.0.0.1. Returns (status, reply dict); raises OSError/ValueError."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", "/state?" + urllib.parse.urlencode({"t": token}))
        r = conn.getresponse()
        status, raw = r.status, r.read(4 * 1024 * 1024)
    finally:
        conn.close()
    obj = json.loads(raw or b"{}")
    return status, sanitize(obj if isinstance(obj, dict) else {})


def console_post(port, token, body, timeout):
    """POST /act to a console's panel on 127.0.0.1. Returns (status, reply dict); raises OSError/ValueError."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("POST", "/act?" + urllib.parse.urlencode({"t": token}),
                     body=json.dumps(body, allow_nan=False).encode(), headers={"Content-Type": "application/json"})
        r = conn.getresponse()
        status, raw = r.status, r.read(256 * 1024)
    finally:
        conn.close()
    obj = json.loads(raw or b"{}")
    return status, sanitize(obj if isinstance(obj, dict) else {"reply": obj})


# ----------------------------------------------------------------------------------------------- live consoles
class Consoles:
    """The consoles the gateway last knew as live, from the deploy service's state: E-STOP's targets and the guards'
    evidence. A console leaves only on a positive "not live" from the deploy service; when the service cannot be
    reached the last known set stays (review M1: never hide a live console because the hub went away)."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.targets = {}            # slot -> {slot, name, mode, practice, port, token, dir, seen, error}
        self.state_ok = None         # monotonic time of the last good state
        self.state_try = None        # ... of the last attempt
        self.state_error = None
        self.ever_ok = False
        self.capabilities = None     # the deploy service's capability list at the last good state (None: never seen)
        self.version = None

    def update(self, state):
        live = state.get("live") if isinstance(state, dict) else None
        if not isinstance(live, dict):
            self.failed("the deploy service's state has no live block")
            return
        now = self.clock()
        fresh = {}
        for slot, entry in live.items():
            if not safe_name(slot) or not isinstance(entry, dict) or entry.get("running") is False:
                continue
            name = str(entry.get("name") or "")
            with self.lock:
                prev = self.targets.get(slot)
            receipt = entry.get("receipt") if isinstance(entry.get("receipt"), dict) else None
            if prev and prev["name"] == name and prev["token"] and prev["port_hint"] == entry.get("panel_port"):
                fresh[slot] = dict(prev, seen=now, receipt=receipt)
                continue
            target = {"slot": slot, "name": name, "mode": entry.get("mode"), "practice": bool(entry.get("practice")),
                      "dir": entry.get("dir"), "port_hint": entry.get("panel_port"), "port": None, "token": None,
                      "error": None, "seen": now, "receipt": receipt}
            try:
                target["port"], target["token"] = read_panel_target(entry.get("panel_token_file"), entry.get("panel_port"))
            except (OSError, ValueError) as error:
                target["error"] = f"panel token not readable: {error}"[:300]
            fresh[slot] = target
        caps = state.get("capabilities")
        with self.lock:
            self.targets = fresh
            self.state_ok = self.state_try = now
            self.state_error = None
            self.ever_ok = True
            self.capabilities = [c for c in caps if isinstance(c, str)] if isinstance(caps, list) else []
            self.version = state.get("version") if isinstance(state.get("version"), dict) else None

    def has(self, capability):
        """True / False from the last good state's capability list; None when the service never answered."""
        with self.lock:
            return None if self.capabilities is None else capability in self.capabilities

    def failed(self, error):
        with self.lock:
            self.state_try = self.clock()
            self.state_error = str(error)[:300]

    def snapshot(self):
        with self.lock:
            return [dict(t) for t in self.targets.values()]

    def get(self, slot):
        with self.lock:
            t = self.targets.get(slot)
            return dict(t) if t else None

    def age(self):
        with self.lock:
            return None if self.state_ok is None else self.clock() - self.state_ok

    def public(self):
        """For the page and the service script: never the token."""
        now = self.clock()
        with self.lock:
            targets = [{"slot": t["slot"], "name": t["name"], "mode": t["mode"], "practice": t["practice"],
                        "port": t["port"], "reachable_token": bool(t["token"]), "error": t["error"],
                        "seen_age_s": round(now - t["seen"], 2)} for t in self.targets.values()]
            hub = {"ok": self.state_error is None and self.state_ok is not None,
                   "age_s": None if self.state_ok is None else round(now - self.state_ok, 2),
                   "error": self.state_error, "ever_ok": self.ever_ok}
        return targets, hub


# ----------------------------------------------------------------------------------------------- the facade
class Deploy:
    """One per gateway process (shared by its IPv4 and IPv6 listeners): the link, the lease, the check ids, the live
    consoles and the background refresher. Nothing here touches the network at construction."""

    def __init__(self, link=None, audit_path=None, clock=time.monotonic, autostart=True, wall=time.time,
                 post_timeout_s=POST_TIMEOUT_S):
        self._link = link
        self._link_error = None
        self.clock = clock
        self.wall = wall             # unix time for receipts (issued_at / expires_at); tests drive both clocks
        self.post_timeout_s = post_timeout_s
        self.lock = threading.RLock()
        self.consoles = Consoles(clock)
        self.lease = None            # {lease_id, holder, until (monotonic), since (unix)}
        self.forwarded = {}          # slot -> {"holder": str|None, "at": monotonic} what each console was last told
        self.checks = OrderedDict()  # check_id -> the goal check's receipt (see goal_check)
        self.scenes = OrderedDict()  # scan name -> (monotonic, meta)
        self.grids = OrderedDict()   # (path, mtime_ns, size) -> grid
        self.client_at = None
        self.catalog = None          # Studio's catalog (studio/server.py wire_deploy): Review's Replay ids
        self.discovered_at = None
        self.audit_path = Path(audit_path) if audit_path else None
        self.audit_lock = threading.Lock()
        self.audit_start_lock = threading.Lock()
        self.audit_stats = {"writes": 0, "errors": 0, "last_error": None, "at": None, "last_ok": None}
        self.audit_queue = queue.Queue(maxsize=AUDIT_QUEUE)
        self.audit_thread = None
        self.wake = threading.Event()
        self.closed = False
        self.autostart = autostart
        self.thread = None
        self.refresh_lock = threading.Lock()

    # -- plumbing
    @property
    def link(self):
        if self._link is None:
            try:
                self._link = DeployLink()
            except ValueError as error:
                raise DeployError(f"config/local.json deploy_service: {error}", 503) from None
        return self._link

    def touch(self):
        """A Deploy page asked for something: keep the refresher running for CLIENT_ACTIVE_S."""
        self.client_at = self.clock()
        if self.autostart and self.thread is None:
            with self.lock:
                if self.thread is None:
                    self.thread = threading.Thread(target=self._loop, name="deploy-link", daemon=True)
                    self.thread.start()

    def close(self):
        self.closed = True
        self.wake.set()

    # -- the audit log (<data root>/deploy/gateway_actions.jsonl): failures are counted and shown, never silent
    def audit(self, kind, sync=True, **fields):
        """Append one row. sync=False hands it to the writer thread (E-STOP and the direct path never wait on a disk)."""
        if self.audit_path is None:
            return
        try:
            row = json.dumps({"wall": round(time.time(), 3), "kind": kind, **fields}, default=str, allow_nan=False)
        except ValueError as error:
            self._audit_failed(f"row not encodable: {error}")
            return
        if sync:
            self._audit_write(row)
            return
        try:
            self.audit_queue.put_nowait(row)
        except queue.Full:
            self._audit_failed("the audit writer is stuck (queue full): row dropped")
            return
        if self.audit_thread is None:
            with self.audit_start_lock:  # never audit_lock: a sync writer may hold it on a hung disk
                if self.audit_thread is None:
                    self.audit_thread = threading.Thread(target=self._audit_loop, name="deploy-audit", daemon=True)
                    self.audit_thread.start()

    def _audit_loop(self):
        while True:
            row = self.audit_queue.get()
            try:
                self._audit_write(row)
            finally:
                self.audit_queue.task_done()

    def _audit_write(self, row):
        with self.audit_lock:
            try:
                self.audit_path.parent.mkdir(parents=True, exist_ok=True)
                if self.audit_path.is_file() and self.audit_path.stat().st_size > AUDIT_MAX_BYTES:
                    self.audit_path.replace(self.audit_path.with_suffix(".jsonl.1"))
                with self.audit_path.open("a") as f:
                    f.write(row + "\n")
                self.audit_stats["writes"] += 1
                self.audit_stats["last_ok"] = time.time()
            except OSError as error:
                self._audit_failed(f"{type(error).__name__}: {error}")

    def _audit_failed(self, error):
        self.audit_stats["errors"] += 1
        self.audit_stats["last_error"] = str(error)[:300]
        self.audit_stats["at"] = round(time.time(), 3)
        print(f"deploy link: audit write failed ({self.audit_path}): {error}", file=sys.stderr, flush=True)

    def audit_flush(self, timeout=2.0):
        """Wait until the writer thread has written what it was handed (tests)."""
        deadline = time.monotonic() + timeout
        while self.audit_queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.01)

    def audit_public(self):
        st = dict(self.audit_stats)
        ok = st["at"] is None or (st["last_ok"] is not None and st["last_ok"] > st["at"])
        return {"ok": ok if self.audit_path is not None else None, "errors": st["errors"],
                "last_error": st["last_error"], "at": st["at"], "writes": st["writes"],
                "path": str(self.audit_path) if self.audit_path else None}

    def refresh_state(self, timeout=STATE_TIMEOUT_S):
        """Ask the deploy service for its state once and update the live consoles. Returns (status, obj) or raises."""
        with self.refresh_lock:
            try:
                status, obj = self.link.state(timeout=timeout)
            except DeployError as error:
                self.consoles.failed(error)
                raise
            if status == 200:
                self.consoles.update(obj)
            else:
                self.consoles.failed(f"state answered {status}: {obj.get('error') if isinstance(obj, dict) else obj}")
            return status, obj

    def _loop(self):
        while not self.closed:
            self.wake.wait(0.5)
            self.wake.clear()
            if self.closed:
                return
            now = self.clock()
            with self.lock:
                active = (self.client_at is not None and now - self.client_at < CLIENT_ACTIVE_S) or self.lease is not None
            last = self.consoles.state_try
            if active and (last is None or now - last >= REFRESH_PERIOD_S):
                try:
                    self.refresh_state()
                except DeployError:
                    pass
            try:
                self.forward_lease()
            except Exception as error:  # the refresher must survive anything a broken hub answers
                print(f"deploy link: lease forwarding failed: {type(error).__name__}: {error}", file=sys.stderr)

    def capabilities_public(self):
        """Each v3 capability of the deploy service: true / false, null while it never answered."""
        return {c: self.consoles.has(c) for c in V3_CAPABILITIES}

    def link_status(self):
        targets, hub = self.consoles.public()
        with self.consoles.lock:
            hub = dict(hub, version=self.consoles.version)
        return {"estop_targets": targets, "hub": hub, "lease": self.lease_public(),
                "refresher": self.thread is not None and self.client_at is not None
                and self.clock() - self.client_at < CLIENT_ACTIVE_S,
                "audit": self.audit_public(), "capabilities": self.capabilities_public()}

    def unsupported(self, capability):
        version = (self.consoles.version or {}).get("kit_commit")
        return {"supported": False, "capability": capability,
                "detail": f"the deploy service{' (kit ' + str(version)[:12] + ')' if version else ''} has no "
                          f"{capability}: it predates contract v3; update the kit"}

    # -- passthrough
    def get(self, route, query):
        self.touch()
        if route == "/api/deploy/state":
            try:
                status, obj = self.refresh_state(timeout=GET_TIMEOUT_S)
            except DeployError as error:
                return error.status, dict(error.body(), studio=self.link_status())
            if isinstance(obj, dict):
                obj = dict(obj, studio=self.link_status(), source_age_s=source_age(obj, "t_mono"))
            return status, obj
        status, obj = self.link.get(route, query)
        if route in V3_CAPABILITY and unsupported(status, obj):
            return 200, self.unsupported(V3_CAPABILITY[route])
        if status in (404, 502) and route in ("/api/deploy/live", "/api/deploy/panel", "/api/deploy/rehearsal/track"):
            # a slot that just ended (404), a console still starting or not answering (502), a run not started yet:
            # an answer, not an error (the page polls it until the state changes)
            return 200, dict(obj if isinstance(obj, dict) else {}, ok=False, ended=status == 404, starting=status == 502)
        if status == 200 and route in SOURCE_CLOCK and isinstance(obj, dict):
            obj = dict(obj, source_age_s=source_age(obj, SOURCE_CLOCK[route]))
        return status, obj

    # -- the operator lease
    def _live_lease(self):
        lease = self.lease
        if lease is not None and lease["until"] <= self.clock():
            self.audit("lease_lost", holder=lease["holder"], reason="no heartbeat for 3 s")
            self.lease = lease = None
            self.wake.set()
        return lease

    def lease_public(self):
        with self.lock:
            lease = self._live_lease()
            if lease is None:
                return None
            return {"holder": lease["holder"], "until": round(time.time() + lease["until"] - self.clock(), 3),
                    "since": lease["since"]}

    def lease_holder(self, lease_id):
        """The holder's name when lease_id is the live lease, else None."""
        if not isinstance(lease_id, str) or not lease_id:
            return None
        with self.lock:
            lease = self._live_lease()
            return lease["holder"] if lease is not None and lease["lease_id"] == lease_id else None

    def lease_take(self, document):
        operator = clean_operator(document.get("operator"))
        if operator is None:
            raise DeployError("an operator name is required to hold the operator lease", 400)
        take_over = document.get("take_over") is True
        self.touch()
        with self.lock:
            current = self._live_lease()
            if current is not None and not take_over:
                raise DeployError(f"{current['holder']} holds the operator lease in another page", 409,
                                  holder=current["holder"], take_over="send take_over: true to take it (logged)")
            lease = {"lease_id": uuid.uuid4().hex, "holder": operator, "until": self.clock() + LEASE_TTL_S,
                     "since": round(time.time(), 3)}
            self.lease = lease
        self.audit("lease_take", holder=operator, took_over_from=current["holder"] if current else None)
        if current is not None:
            print(f"deploy link: operator lease taken over by {operator!r} from {current['holder']!r}", flush=True)
        self.wake.set()
        return {"lease_id": lease["lease_id"], "holder": operator,
                "until": round(time.time() + LEASE_TTL_S, 3), "ttl_s": LEASE_TTL_S}

    def lease_renew(self, document):
        lease_id = document.get("lease_id")
        self.touch()
        with self.lock:
            lease = self._live_lease()
            if lease is None or lease["lease_id"] != lease_id:
                raise DeployError("this page no longer holds the operator lease" if lease is None or not lease_id
                                  else f"{lease['holder']} holds the operator lease now", 409,
                                  holder=lease["holder"] if lease else None)
            lease["until"] = self.clock() + LEASE_TTL_S
        return {"until": round(time.time() + LEASE_TTL_S, 3), "holder": lease["holder"]}

    def lease_release(self, document):
        lease_id = document.get("lease_id")
        with self.lock:
            lease = self._live_lease()
            released = lease is not None and lease["lease_id"] == lease_id
            if released:
                self.lease = None
        if released:
            self.audit("lease_release", holder=lease["holder"])
            self.wake.set()
        return {"released": released}

    def forward_lease(self):
        """Tell each live console who holds the lease (act `lease {holder, until}` through the deploy service): at once
        on a change, then every LEASE_FORWARD_S while held; `holder: null, until: 0` once it is gone."""
        with self.lock:
            lease = self._live_lease()
            holder = lease["holder"] if lease else None
            until = round(time.time() + lease["until"] - self.clock() + LEASE_FORWARD_MARGIN_S, 3) if lease else 0.0
        now = self.clock()
        slots = [t["slot"] for t in self.consoles.snapshot()]
        for slot in list(self.forwarded):
            if slot not in slots:
                self.forwarded.pop(slot, None)
        for slot in slots:
            last = self.forwarded.get(slot)
            if last is None and holder is None:
                continue  # a console starts without a lease: nothing to clear
            if last is not None and last["holder"] == holder and (holder is None or now - last["at"] < LEASE_FORWARD_S):
                continue
            body = {"act": "lease", "slot": slot, "holder": holder, "until": until, "id": uuid.uuid4().hex,
                    "source": "studio", "operator": holder or "studio"}
            try:
                status, _ = self.link.act(body, timeout=STATE_TIMEOUT_S)
            except DeployError:
                continue  # retried on the next tick
            if status < 500:
                self.forwarded[slot] = {"holder": holder, "at": now}

    # -- acts
    def act(self, document):
        body = dict(document)
        act = body.get("act")
        if act not in HUB_ACTS and act not in CONSOLE_ACTS:
            raise DeployError(f"act {act!r} is not relayed by Studio", 400)
        self.touch()
        holder = self.lease_holder(body.pop("lease_id", None))
        if act in LEASED_ACTS and holder is None:
            current = self.lease_public()
            raise DeployError(f"{act} needs the operator lease" + (f": {current['holder']} holds it" if current
                              else ": take it first (Deploy, Operator)"), 409, need="lease",
                              holder=current["holder"] if current else None)
        if "slot" in body and not safe_name(body["slot"]):
            raise DeployError("slot must be a slot name (robot or sim)", 400)
        if act == "send_goal":
            self._require_check(body)
        if not isinstance(body.get("id"), str) or not body["id"]:
            body["id"] = uuid.uuid4().hex
        body["source"] = "studio"
        body["operator"] = holder or clean_operator(body.get("operator"), "studio (no lease)")
        try:
            status, obj = self.link.act(body, timeout=self.post_timeout_s)
        except ReplyLost as error:
            return self._unknown(act, body, str(error))
        except DeployError as error:
            self.audit("act", act=act, slot=body.get("slot"), id=body["id"], operator=body["operator"],
                       status=error.status, error=str(error))
            raise
        lost = self._lost_console_reply(act, status, obj)
        if lost:
            return self._unknown(act, body, lost)
        self.audit("act", act=act, slot=body.get("slot"), id=body["id"], operator=body["operator"], status=status,
                   ok=obj.get("ok") if isinstance(obj, dict) else None,
                   reason=(obj.get("reason") or obj.get("error")) if isinstance(obj, dict) else None)
        return status, obj

    @staticmethod
    def _lost_console_reply(act, status, obj):
        """The deploy service answered, but the console's reply was lost on its side (the kit's hub: 502 "panel
        unreachable" / a console that does not answer): what the console did is unknown. Returns the reason or None."""
        if act in CONSOLE_ACTS and status in (502, 504):
            return (obj.get("error") or obj.get("reason") or f"the deploy service answered {status}") \
                if isinstance(obj, dict) else f"the deploy service answered {status}"
        if act == "send_goal" and isinstance(obj, dict) and isinstance(obj.get("act"), dict):
            reply = obj["act"]
            text = str(reply.get("error") or "")
            if reply.get("result") is None and reply.get("ok") is False and \
                    re.search(r"panel unreachable|does not answer|timed out|no reply", text):
                return f"the console's reply to goal_odom was lost ({text[:160]})"
        return None

    def _unknown(self, act, body, reason):
        """HTTP 202 {state: "unknown"}: the act may have been carried out. Never sent again; reconcile through the
        console's act record (GET /api/deploy/act_status?slot=&id=) or, for the service's own acts, its state."""
        slot = body.get("slot") or ("robot" if act in CONSOLE_ACTS or act == "send_goal" else None)
        expect = body.get("expect") if isinstance(body.get("expect"), dict) else {}
        target = self.consoles.get(slot) if slot else None
        session = expect.get("session") or (target or {}).get("name")
        out = {"state": "unknown", "id": body["id"], "act": act, "slot": slot, "session": session,
               "reconcile": "act_status" if act in CONSOLE_ACTS or act == "send_goal" else "state",
               "retried": False, "detail": reason,
               "message": "acknowledgement unavailable: checking the console's state (the act is not sent again)"}
        self.audit("act_unknown", act=act, slot=slot, id=body["id"], operator=body["operator"], session=session,
                   reason=reason)
        return 202, out

    def act_status(self, slot, act_id, session=None):
        """GET /api/deploy/act_status?slot=&id=: the console's record of an act (through the deploy service)."""
        self.touch()
        if not safe_name(slot) or not safe_name(act_id) or (session is not None and not safe_name(session)):
            raise DeployError("a valid slot and id are required", 400)
        status, obj = self.link.get_path(f"/api/v1/act/{slot}/{act_id}", {"session": session} if session else None)
        if unsupported(status, obj):
            return 200, self.unsupported("act_status")
        return status, obj

    def _require_check(self, body):
        """send_goal's goal-check receipt: issued here, in the last CHECK_TTL_S, for this scan (and its memory as it is
        now), this goal, not blocked, and with the route configuration of the profile the live session runs."""
        check_id = body.get("check_id")
        with self.lock:
            self._expire_checks()
            check = self.checks.get(check_id) if isinstance(check_id, str) else None
        if check is None:
            raise DeployError("send_goal needs a goal check from the last 10 min: check the goal again", 409,
                              need="goal_check", why="missing")
        if self.clock() - check["at"] >= CHECK_TTL_S:
            raise DeployError(f"this goal check expired (issued {time.strftime('%H:%M:%S', time.localtime(check['issued_at']))}"
                              f"; send_goal needs a goal check from the last 10 min): check the goal again", 409,
                              need="goal_check", why="expired", expires_at=check["expires_at"])
        goal = body.get("goal_scene")
        try:
            same_goal = (len(goal) == 2 and max(abs(float(goal[0]) - check["goal_scene"][0]),
                                                abs(float(goal[1]) - check["goal_scene"][1])) <= 1e-3)
        except (TypeError, ValueError):
            same_goal = False
        if body.get("scan") != check["scan"] or not same_goal:
            raise DeployError("this check_id was issued for another scan or goal: check the goal again", 409,
                              need="goal_check", why="other goal")
        if not check["ok"]:
            raise DeployError("the goal check blocked this goal (" + ", ".join(check["blocked"]) + "): pick another goal",
                              409, need="goal_check", why="blocked")
        try:  # the scan's memory as it is now (a rescan under the same name, an edited file)
            now_sha = self._grid(self.scan_meta(check["scan"])["memory_file"])["sha256"]
        except DeployError:
            now_sha = check["memory_sha"]  # the deploy service will answer for itself; nothing to compare
        if now_sha != check["memory_sha"]:
            raise DeployError("the scan's memory changed since this goal check: check the goal again", 409,
                              need="goal_check", why="memory changed")
        slot = body.get("slot") or "robot"
        target = self.consoles.get(slot)
        if target is None or target.get("receipt") is None:  # a session started a moment ago: ask for its receipt
            try:
                self.refresh_state(timeout=STATE_TIMEOUT_S)
            except DeployError:
                pass
            target = self.consoles.get(slot)
        receipt = (target or {}).get("receipt") or {}
        prof = receipt.get("profile") if isinstance(receipt.get("profile"), dict) else {}
        config = check["config"]
        if prof.get("sha"):
            if config["basis"] == "profile route config":
                if config["sha"] != prof["sha"] or config["profile"] != prof.get("name"):
                    raise DeployError(
                        f"this goal was checked with profile {config['profile']} (route config {str(config['sha'])[:12]}), "
                        f"but the {target['slot']} session runs {prof.get('name')} ({str(prof['sha'])[:12]}): check the "
                        f"goal again with the session's profile", 409, need="goal_check", why="config mismatch",
                        session_profile=prof)
            elif self.consoles.has("profile_route"):
                raise DeployError(
                    f"this goal was checked with Studio's generic parameters, but the {target['slot']} session runs "
                    f"profile {prof.get('name')}, whose route configuration the deploy service provides: check the goal "
                    f"again with that profile", 409, need="goal_check", why="config mismatch", session_profile=prof)
        scan = receipt.get("scan") if isinstance(receipt.get("scan"), dict) else {}
        if scan.get("memory_sha") and scan.get("name") == check["scan"] and scan["memory_sha"] != check["memory_sha"]:
            raise DeployError(f"the {target['slot']} session's scan {scan['name']} has other memory than the one this goal "
                              "was checked on: check the goal again", 409, need="goal_check", why="memory mismatch")

    def _expire_checks(self):
        """Forget receipts twice their TTL old (an expired one stays a while so send_goal can say "expired")."""
        now = self.clock()
        while self.checks:
            key, first = next(iter(self.checks.items()))
            if now - first["at"] < 2 * CHECK_TTL_S and len(self.checks) <= MAX_CHECKS:
                break
            self.checks.popitem(last=False)

    # -- Review: a session's detail, its Replay id, tags
    def session(self, name):
        """GET /api/deploy/session?name=: the deploy service's session detail plus `replay`: the exact Studio catalog id
        or why there is none (the catalog's robot-sessions discovery is forced when the id is not listed yet)."""
        self.touch()
        if not safe_name(name):
            raise DeployError("a valid session name is required", 400)
        status, obj = self.link.get_path(f"/api/v1/session/{name}")
        if unsupported(status, obj):
            return 200, dict(self.unsupported("session_detail"), name=name, replay=self.replay_state(name, {}))
        if status != 200 or not isinstance(obj, dict):
            return status, obj
        hint = obj.get("replay") if isinstance(obj.get("replay"), dict) else {}
        return 200, dict(obj, replay=self.replay_state(name, dict(hint, dir=obj.get("dir"), ended=obj.get("ended"))))

    def replay_state(self, name, hint):
        """{catalog_id, state: registered|not_registered|indexing|error, detail} for a kit session in Studio's catalog."""
        catalog = self.catalog
        out = {"catalog_id": None, "state": "error", "detail": "", "studio_id": hint.get("studio_id")}
        if catalog is None:
            return dict(out, detail="this gateway has no catalog")
        want_dir = None
        if isinstance(hint.get("dir"), str) and hint["dir"]:
            try:
                want_dir = Path(hint["dir"]).resolve()
            except OSError:
                want_dir = None

        def find():
            with catalog.lock:
                entries = list(catalog.entries.items())
            ids = dict(entries)
            if hint.get("studio_id") in ids:
                return hint["studio_id"]
            for key, entry in entries:
                if entry.get("kind") != "robot-session":
                    continue
                path = Path(str(entry.get("path", "")))
                try:
                    if (want_dir is not None and path.resolve() == want_dir) or (want_dir is None and path.name == name):
                        return key
                except OSError:
                    continue
            return None

        try:
            key = find()
            if key is None:
                now = self.clock()
                if self.discovered_at is None or now - self.discovered_at >= FORCED_DISCOVERY_S:
                    self.discovered_at = now
                    catalog.discover_console(force=True)
                    key = find()
        except Exception as error:  # a broken directory must not break Review
            return dict(out, detail=f"Studio's catalog discovery failed: {type(error).__name__}: {error}"[:300])
        if key is not None:
            return dict(out, catalog_id=key, state="registered",
                        detail="Replay lists this session" + ("" if hint.get("ended") is not False
                                                              else " (still recording: Replay shows it so far)"))
        base = getattr(catalog, "console_base", None)
        where = None
        if base is not None and Path(base).is_dir():
            where = next((d for d in [Path(base) / name, *Path(base).glob(f"*/{name}")] if d.is_dir()), None)
        if hint.get("linked") is False:
            return dict(out, state="not_registered",
                        detail="the deploy service did not link its day directory into Studio's robot-sessions "
                               f"({base}); link it there (the kit does unless started with --no-studio-link)")
        if where is not None and not (where / "rec" / "meta.json").is_file() and not (where / "meta.json").is_file():
            if hint.get("ended") is False:
                return dict(out, state="indexing", detail="the session is live and its recording has not started yet: "
                                                          "Replay lists it once rec/meta.json exists")
            return dict(out, state="not_registered", detail=f"{where} has no recording (rec/meta.json)")
        if where is None and hint.get("ended") is False:
            return dict(out, state="indexing", detail="the session is live and not under Studio's robot-sessions yet")
        return dict(out, state="not_registered",
                    detail=f"no session {name} under Studio's robot-sessions ({base}): the kit links its day "
                           "directory there unless started with --no-studio-link")

    def tag(self, document):
        """POST /api/deploy/tag {name, n, tag, note}: a tag or note on an attempt of a live or ended session, through
        the deploy service (append-only history there). The operator is the lease holder, else a named viewer."""
        self.touch()
        name = document.get("name")
        if not safe_name(name):
            raise DeployError("a valid session name is required", 400)
        n = document.get("n")
        if not isinstance(n, int) or isinstance(n, bool) or n < 1:
            raise DeployError("n must be an attempt number (1, 2, ...)", 400)
        tag, note = document.get("tag"), document.get("note")
        if tag is not None and (not isinstance(tag, str) or len(tag) > 64):
            raise DeployError("tag must be text (at most 64 characters) or null", 400)
        if note is not None and (not isinstance(note, str) or len(note) > 1000):
            raise DeployError("note must be text (at most 1000 characters) or null", 400)
        operator = self.lease_holder(document.get("lease_id")) or clean_operator(document.get("operator"))
        if operator is None:
            raise DeployError("tagging needs an operator name (the lease holder's, or yours as a viewer)", 400,
                              need="operator")
        body = {"n": n, "tag": tag, "note": note, "operator": operator, "source": "studio",
                "id": document.get("id") if isinstance(document.get("id"), str) and document.get("id") else uuid.uuid4().hex}
        try:
            status, obj = self.link.post_path(f"/api/v1/session/{name}/tag", body, timeout=self.post_timeout_s)
        except ReplyLost as error:
            self.audit("tag", session=name, n=n, tag=tag, operator=operator, id=body["id"], error=str(error))
            return 202, {"state": "unknown", "id": body["id"], "act": "tag", "session": name, "detail": str(error),
                         "reconcile": "session", "retried": False}
        if unsupported(status, obj):
            return 200, self.unsupported("session_tag")
        self.audit("tag", session=name, n=n, tag=tag, note=note, operator=operator, id=body["id"], status=status,
                   ok=obj.get("ok") if isinstance(obj, dict) else None)
        return status, obj

    # -- E-STOP and the direct path
    def _send(self, target, body, timeout):
        row = {"slot": target["slot"], "name": target["name"], "ok": False, "key_sent": None, "runner_alive": None,
               "confirmed": None, "latency_ms": None, "error": target.get("error")}
        if not target.get("token") or not target.get("port"):
            row["error"] = row["error"] or "no panel port and token for this console"
            return row, None
        t0 = time.monotonic()
        try:
            status, reply = console_post(target["port"], target["token"], body, timeout)
        except (OSError, ValueError, http.client.HTTPException) as error:
            row.update(latency_ms=round(1000 * (time.monotonic() - t0), 1),
                       error=f"{type(error).__name__}: {error}"[:200] or "no reply")
            return row, None
        row.update(latency_ms=round(1000 * (time.monotonic() - t0), 1), ok=status == 200 and reply.get("ok") is True,
                   key_sent=reply.get("key_sent"), runner_alive=reply.get("runner_alive"),
                   confirmed=reply.get("confirmed"),
                   error=None if status == 200 and reply.get("ok") is True
                   else (reply.get("reason") or reply.get("error") or f"the console answered {status}"))
        return row, reply

    def estop(self, document=None):
        """E-STOP to every console the gateway last knew as live, in parallel, 1 s each. Never calls the deploy
        service. `ok` only when every target acknowledged."""
        t0 = time.monotonic()
        targets = self.consoles.snapshot()
        operator = (self.lease_public() or {}).get("holder") or "studio"
        if not targets:
            out = {"ok": False, "targets": [], "t": round(time.time(), 3),
                   "error": "Studio knows no live console (the deploy service has not reported one): "
                            "use the physical E-stop"}
            self.audit("estop", sync=False, targets=[], error=out["error"])
            return out
        rows = [None] * len(targets)
        body = {"act": "estop", "source": "studio", "operator": operator}

        def one(i, target):
            rows[i] = self._send(target, body, ESTOP_TIMEOUT_S)[0]

        threads = [threading.Thread(target=one, args=(i, t), daemon=True) for i, t in enumerate(targets)]
        for th in threads:
            th.start()
        deadline = time.monotonic() + ESTOP_TIMEOUT_S + 0.2
        for th in threads:
            th.join(max(0.0, deadline - time.monotonic()))
        for i, target in enumerate(targets):
            if rows[i] is None:
                rows[i] = {"slot": target["slot"], "name": target["name"], "ok": False, "key_sent": None,
                           "runner_alive": None, "confirmed": None, "latency_ms": None,
                           "error": f"no reply within {ESTOP_TIMEOUT_S:.1f} s"}
        out = {"ok": all(r["ok"] for r in rows), "targets": rows, "t": round(time.time(), 3),
               "gateway_ms": round(1000 * (time.monotonic() - t0), 1)}
        self.audit("estop", sync=False, operator=operator, ok=out["ok"], targets=rows)
        return out

    def heartbeat(self):
        """GET /api/deploy/heartbeat (the page polls it at 1 Hz, whatever the deploy service does): each console the
        gateway last knew as live, measured NOW on the direct path (its panel's /state, not the deploy service, 0.5 s
        each): console_age_s = now - its console_t_mono (one host, one monotonic clock). A console that does not answer
        is `reached: false` with console_age_s null: unknown, never healthy. Above 1 s the page says CONSOLE NOT
        RESPONDING (use the physical E-stop)."""
        self.touch()
        targets = self.consoles.snapshot()
        rows = [None] * len(targets)

        def row_for(target, **kw):
            return dict({"slot": target["slot"], "session": target["name"], "reached": False, "console_age_s": None,
                         "latency_ms": None, "at": None, "state": "unknown", "error": target.get("error")}, **kw)

        def one(i, target):
            row = row_for(target)
            if target.get("token") and target.get("port"):
                t0 = time.monotonic()
                try:
                    status, state = console_get_state(target["port"], target["token"], HEARTBEAT_TIMEOUT_S)
                    t_mono = state.get("console_t_mono")
                    ok_t = status == 200 and isinstance(t_mono, (int, float)) and not isinstance(t_mono, bool)
                    row.update(reached=ok_t, error=None if ok_t else f"the console answered {status}"
                               + ("" if isinstance(t_mono, (int, float)) else " without console_t_mono"),
                               console_age_s=round(max(0.0, time.monotonic() - t_mono), 3) if ok_t else None)
                    if ok_t and state.get("session") not in (None, target["name"]):
                        row["error"] = f"the panel on this port serves session {state.get('session')}"
                        row["reached"], row["console_age_s"] = False, None
                except (OSError, ValueError, http.client.HTTPException) as error:
                    row["error"] = f"{type(error).__name__}: {error}"[:200]
                row["latency_ms"] = round(1000 * (time.monotonic() - t0), 1)
            row["at"] = round(time.time(), 3)
            if row["reached"]:
                row["state"] = "fresh" if row["console_age_s"] <= HEARTBEAT_STALE_S else "stale"
            rows[i] = row

        threads = [threading.Thread(target=one, args=(i, t), daemon=True) for i, t in enumerate(targets)]
        for th in threads:
            th.start()
        deadline = time.monotonic() + HEARTBEAT_TIMEOUT_S + 0.2
        for th in threads:
            th.join(max(0.0, deadline - time.monotonic()))
        rows = [r or row_for(t, at=round(time.time(), 3), error=f"no reply within {HEARTBEAT_TIMEOUT_S:.1f} s")
                for r, t in zip(rows, targets)]
        _, hub = self.consoles.public()
        return {"consoles": rows, "hub": hub, "stale_after_s": HEARTBEAT_STALE_S, "t": round(time.time(), 3)}

    def direct(self, document):
        """Stand (h) or Takeover (t) to one live console, on the E-STOP's path (no deploy service, no lease)."""
        slot, act = document.get("slot"), document.get("act")
        if act not in DIRECT_ACTS:
            raise DeployError("the direct path carries only h (Stand) and t (Takeover)", 400)
        if not safe_name(slot):
            raise DeployError("slot must be a slot name (robot or sim)", 400)
        target = self.consoles.get(slot)
        if target is None:
            raise DeployError(f"Studio knows no live console in the {slot} slot", 404)
        operator = (self.lease_public() or {}).get("holder") or "studio"
        body = {"act": act, "id": document.get("id") if isinstance(document.get("id"), str) and document.get("id")
                else uuid.uuid4().hex, "source": "studio", "operator": operator}
        row, reply = self._send(target, body, DIRECT_TIMEOUT_S)
        self.audit("direct", sync=False, act=act, slot=slot, id=body["id"], operator=operator, ok=row["ok"],
                   error=row["error"])
        if reply is None:
            raise DeployError(f"the {slot} console did not answer: {row['error']}", 504, slot=slot,
                              latency_ms=row["latency_ms"])
        return (200 if reply.get("ok") is True else 409), dict(reply, slot=slot, latency_ms=row["latency_ms"])

    # -- guards
    def sessions(self, max_age_s=GUARD_MAX_AGE_S):
        """What is live as far as the deploy service said (asking it again when older than max_age_s). Returns
        {targets, basis}: basis 'deploy service' (fresh), 'last known (the deploy service is not reachable)' or
        'none known' (it never answered)."""
        age = self.consoles.age()
        if age is None or age > max_age_s:
            try:
                self.refresh_state(timeout=STATE_TIMEOUT_S)
            except DeployError:
                pass
        with self.consoles.lock:
            answered = self.consoles.state_ok is not None and self.consoles.state_error is None
        basis = ("deploy service" if answered else "last known (the deploy service is not reachable)"
                 if self.consoles.ever_ok else "none known")
        return {"targets": self.consoles.snapshot(), "basis": basis}

    def robot_guard(self):
        """A reason to refuse Navigate's direct robot commands (goal, stand), or None."""
        s = self.sessions()
        robot = [t for t in s["targets"] if t["mode"] == "robot" and not t["practice"]]
        if not robot:
            return None
        return (f"the deploy kit runs a robot session ({robot[0]['name']}; {s['basis']}): Navigate's robot link only "
                "observes while it does. Use the Deploy workspace, where every press goes through the kit's console")

    def cpu_guard(self):
        """A reason to refuse Studio's CPU jobs (rehearsals, suites, Navigate's simulated robot), or None."""
        s = self.sessions()
        if not s["targets"]:
            return None
        t = next((t for t in s["targets"] if t["mode"] == "robot" and not t["practice"]), s["targets"][0])
        what = ("a robot session" if t["mode"] == "robot" and not t["practice"]
                else "a practice session" if t["practice"] else "a real-time rehearsal")
        return (f"the deploy kit runs {what} ({t['name']}; {s['basis']}): Studio starts no CPU job while it does, "
                "so the real-time chain keeps the machine to itself")

    # -- the goal check
    def scan_meta(self, scan):
        if not safe_name(scan):
            raise DeployError("a valid scan name is required", 400)
        now = self.clock()
        with self.lock:
            hit = self.scenes.get(scan)
            if hit and now - hit[0] < 60.0:
                return hit[1]
        status, obj = self.link.get("/api/deploy/scan/scene", {"name": scan})
        if status != 200 or not isinstance(obj, dict):
            raise DeployError((obj or {}).get("error") or f"the deploy service answered {status} for scan {scan}",
                              status if status >= 400 else 502)
        meta = {"name": scan, "start_S": _pose(obj.get("start_S"), "start_S"), "memory_file": obj.get("memory_file"),
                "twin": obj.get("twin") if isinstance(obj.get("twin"), list) else None}
        if not isinstance(meta["memory_file"], str) or not meta["memory_file"].endswith(".npz"):
            raise DeployError(f"the deploy service named no memory file for scan {scan}", 502)
        with self.lock:
            self.scenes[scan] = (now, meta)
            while len(self.scenes) > 8:
                self.scenes.popitem(last=False)
        return meta

    def _grid(self, path):
        from studio import goal_check
        p = Path(path)
        try:
            st = p.stat()
        except OSError:
            raise DeployError(f"the scan's memory file is not on this PC: {path}", 404)
        key = (str(p), st.st_mtime_ns, st.st_size)
        with self.lock:
            grid = self.grids.get(key)
        if grid is None:
            grid = goal_check.load_grid(p, basis="scan memory")
            with self.lock:
                self.grids[key] = grid
                while len(self.grids) > 4:
                    self.grids.popitem(last=False)
        return grid

    def route_config(self, profile=None):
        """The route configuration the goal check uses: the kit's for `profile` (GET /api/v1/profile/<name>/route),
        else Studio's generic parameters. {profile, sha, params, basis, source_basis, detail}."""
        def generic(detail):
            sha = hashlib.sha256(json.dumps({"generic": GENERIC_ROUTE}, sort_keys=True).encode()).hexdigest()
            return {"profile": profile, "sha": sha, "params": dict(GENERIC_ROUTE), "basis": "Studio generic check",
                    "source_basis": None, "detail": detail}
        if profile in (None, ""):
            return generic("no profile asked: Studio's generic parameters")
        if not safe_name(profile):
            raise DeployError("profile must be a profile name", 400)
        status, obj = self.link.get_path(f"/api/v1/profile/{profile}/route")
        if unsupported(status, obj):
            return generic("the deploy service has no route configuration (a kit before contract v3): Studio's generic "
                           "parameters, not the profile's")
        if status == 404:
            raise DeployError((obj or {}).get("error") or f"no deploy profile {profile!r}", 404)
        if status != 200 or not isinstance(obj, dict) or not isinstance(obj.get("params"), dict) \
                or not isinstance(obj.get("sha"), str) or not obj["sha"]:
            raise DeployError(f"the deploy service answered {status} without a usable route configuration for "
                              f"{profile}", 502)
        params, defaults = {}, []
        for key, generic_value in GENERIC_ROUTE.items():
            value = obj["params"].get(key)
            if key in ROUTE_LIMITS:
                lo, hi = ROUTE_LIMITS[key]
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) \
                        or not lo <= value <= hi:
                    if value is not None:
                        raise DeployError(f"the profile's {key} ({value!r}) is outside {lo}-{hi}", 502)
                    value = generic_value
                    defaults.append(key)
                value = float(value)
            params[key] = value
        return {"profile": obj.get("profile") or profile, "sha": obj["sha"], "params": params,
                "basis": "profile route config", "source_basis": obj.get("basis"),
                "detail": "the kit's route configuration for this profile" + (
                    f" (Studio's generic value for {', '.join(defaults)})" if defaults else "")}

    def goal_check(self, scan, x, y, profile=None):
        """Studio's goal check on a scan's memory for goal_scene [x, y] with a profile's route configuration: scene ->
        memory_S with start_S, the six checks of studio/goal_check.py from the scan pose, plus `gap` (the narrowest
        passage along the route between the scan twin's boxes); geometry back in the scene frame; a receipt (check_id,
        issued_at, expires_at) bound to the scan, its memory sha, the goal and the configuration's sha."""
        from studio import goal_check
        self.touch()
        goal_scene = [float(x), float(y)]
        if not all(math.isfinite(v) and abs(v) <= 1e3 for v in goal_scene):
            raise DeployError("x and y must be finite metres in the scene frame", 400)
        meta = self.scan_meta(scan)
        config = self.route_config(profile)
        cp = config["params"]
        start = meta["start_S"]                     # memory_S_from_scene
        scene_from_memory = inverse(start)
        grid = self._grid(meta["memory_file"])
        robot_mem, goal_mem = start[:2], apply(start, goal_scene)
        result = goal_check.check_goal(grid, robot_mem, goal_mem, arrival_radius_m=0.4, basis="scan memory",
                                       robot_radius_m=cp["robot_radius_m"], inflate_m=cp["route_margin_m"],
                                       step_over_m=cp["step_over_m"], low_obstacle_m=min(0.05, cp["step_over_m"]),
                                       head_height_m=cp["ceiling_below_m"], overhead_radius_m=cp["ceiling_near_m"],
                                       grow_unknown_m=cp["grow_unknown_m"])
        twin = None
        if meta["twin"] is not None:
            try:
                twin = [goal_check._clean_box(b, i) for i, b in enumerate(meta["twin"])]
            except ValueError:
                twin = None
        path_mem = result.get("path_xy")
        gap_kw = {"step_over_m": cp["step_over_m"], "head_height_m": cp["ceiling_below_m"]}
        gap = goal_check.route_gap(twin, path_mem, **gap_kw) if twin is not None and path_mem else None
        result["checks"].append(goal_check.gap_check(gap, twin is not None, path_mem is not None,
                                                     robot_radius_m=cp["robot_radius_m"], inflate_m=cp["route_margin_m"]))
        # The straight line too: the route pads obstacles by its margin, so it walks around a gap narrower than twice
        # that (the 0.69 m towers of 2026-10-27) and never measures it, while a policy may still go through it.
        direct = goal_check.route_gap(twin, [robot_mem, goal_mem], **gap_kw) if twin is not None else None
        if direct is not None and (gap is None or direct["width_m"] < gap["width_m"] - 0.05):
            row = result["checks"][-1]
            around = (f"; the route goes around it ({result['path_m']:.1f} m instead of {result['straight_m']:.1f} m)"
                      if result.get("path_m") and result.get("straight_m") else "")
            row["detail"] = (row.get("detail") or "").rstrip(".") + (". " if row.get("detail") else "") + \
                f"The straight line to the goal passes a {direct['width_m']:.2f} m gap{around}."
            if row["status"] == "pass" and direct["width_m"] < goal_check.GAP_WARN_M:
                row["status"], row["label"] = "warn", "Narrow gap on the straight line"
        result["ok"] = not any(c["status"] == "block" for c in result["checks"])
        blocking = goal_check.blocking_cells(grid, result, robot_mem, goal_mem, gap=gap, limit=MAX_BLOCKING_CELLS)
        r4 = lambda p: [round(p[0], 4), round(p[1], 4)]
        out = dict(result)
        out.update(goal_xy=r4(goal_scene), robot_xy=r4(apply(scene_from_memory, robot_mem)),
                   path_xy=[r4(p) for p in apply(scene_from_memory, path_mem)] if path_mem else None,
                   blocking_xy=[r4(p) for p in apply(scene_from_memory, blocking)] if blocking else [],
                   gap=None if gap is None else {"width_m": round(gap["width_m"], 3),
                                                 "at_xy": r4(apply(scene_from_memory, gap["at_xy"])),
                                                 "sides_xy": [r4(p) for p in apply(scene_from_memory, gap["sides_xy"])]},
                   direct_gap=None if direct is None else {
                       "width_m": round(direct["width_m"], 3), "at_xy": r4(apply(scene_from_memory, direct["at_xy"])),
                       "sides_xy": [r4(p) for p in apply(scene_from_memory, direct["sides_xy"])]},
                   frame="scene", scan=scan, goal_scene=goal_scene, start_S=[round(v, 6) for v in start])
        out["grid"] = dict(result["grid"], frame="memory_S (scan memory; geometry above is in scene)")
        check_id = uuid.uuid4().hex
        issued = round(self.wall(), 3)
        receipt = {"scan": scan, "goal_scene": goal_scene, "ok": out["ok"], "at": self.clock(),
                   "blocked": [c["id"] for c in out["checks"] if c["status"] == "block"],
                   "memory_sha": grid.get("sha256"), "config": config, "issued_at": issued,
                   "expires_at": round(issued + CHECK_TTL_S, 3)}
        with self.lock:
            self._expire_checks()
            self.checks[check_id] = receipt
        out.update(check_id=check_id, check_ttl_s=CHECK_TTL_S, issued_at=receipt["issued_at"],
                   expires_at=receipt["expires_at"], config=config, memory_sha=receipt["memory_sha"],
                   binding={"scan": scan, "memory_sha": receipt["memory_sha"], "goal_scene": goal_scene,
                            "config_sha": config["sha"]})
        return out


# ----------------------------------------------------------------------------------------------- the CLI (service guard)
def live_report(gateway=None, timeout=STATE_TIMEOUT_S):
    """(code, text) for tools/studio_service.sh: 0 nothing live, 1 a console is live, 2 nobody could say.
    Asks the deploy service; when it cannot be reached, asks the served gateway what it last knew."""
    try:
        status, state = DeployLink().state(timeout=timeout)
        if status == 200 and isinstance(state.get("live"), dict):
            live = [f"{slot}: {e.get('name')} ({'practice' if e.get('practice') else e.get('mode')})"
                    for slot, e in state["live"].items() if isinstance(e, dict) and e.get("running") is not False]
            return (1, "the deploy service reports live sessions: " + "; ".join(live)) if live else \
                (0, "the deploy service reports no live session")
        hub_error = f"the deploy service answered {status}"
    except (DeployError, ValueError) as error:
        hub_error = str(error)
    if gateway:
        try:
            req = urllib.request.Request(gateway.rstrip("/") + "/api/deploy/link")
            with _OPENER.open(req, timeout=timeout) as r:
                info = json.loads(r.read())
            targets = info.get("estop_targets") or []
            if targets:
                return 1, (f"{hub_error}; the gateway last knew live consoles: "
                           + "; ".join(f"{t['slot']}: {t['name']}" for t in targets))
            return 2, f"{hub_error}; the gateway knows no live console"
        except (OSError, ValueError, urllib.error.URLError):
            pass
    return 2, hub_error


def main(argv=None):
    ap = argparse.ArgumentParser(description="Ask the deploy kit's deploy service whether a session is live.")
    ap.add_argument("command", choices=["live"])
    ap.add_argument("--gateway", default=None, help="the served gateway's URL, asked when the deploy service is not")
    args = ap.parse_args(argv)
    code, text = live_report(args.gateway)
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())
