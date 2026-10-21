"""Real-robot link for the Navigate workspace (docs/NAVIGATE.md, the "Real robot" column).

    python -m studio.robot_link --config link.json --output <session>/run

A separate process the gateway spawns; the HTTP server never imports ZMQ. On the deploy PC it

* subscribes (ZMQ SUB only, literal loopback endpoints only) to the LIO bridge's `odom` and `cloud`, node.py's
  `pose` reference and the SONIC runner's `g1_debug`, through bounded drop-oldest buffers, so it can never block
  a producer;
* talks to node.py's control socket (REQ, lazy pirate: receive timeout, LINGER 0, a fresh socket after every
  timeout) with exactly three requests: `status` (2 Hz), `goal` and `stand`. It never sends `go` or `quit`, and it
  has no motor, DDS or hand-command path. Go stays with the operator (console `g`, remote F1);
* keeps the session directory of NAVIGATE.md §2: `latest.json` (10 Hz), `memory.npz` (Studio's display map from
  the LIO cloud, node dump format), commands from `inbox/NNNNNN.json` in sequence order, and on `end` or SIGTERM
  `session.json` (a replayable recording) and, last, `result.json`.

Config: {"endpoints": {"odom", "control", optional "cloud", "pose", "debug"}, "limits": {...}, optional "label",
"capture": {"topics": [...], "max_bytes": n}}. A non-loopback endpoint, an unknown key or an out-of-range limit
refuses the whole config (exit 2, result.json says why).

Labels: the pose is the LIO estimate (`estimated`, frame `odom`); joints are `measured` (g1_debug) or null; the
reference is `commanded`; phase, goal and standing are what the node reports. Stale or missing data is shown as
stale or unavailable, never as a healthy default.
"""
from __future__ import annotations

import argparse
import base64
import bisect
from collections import deque
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import signal
import sys
import threading
import time
import uuid

from .protocols import (ISAAC_JOINTS, MAX_PACKET_BYTES, MJ_JOINTS, ProtocolError, decode_debug, decode_packed_topic,
                        decode_packet, decode_pose)
from .recorder import BoundedRecorder, validate_endpoint

ADAPTER = "studio.robot_link.v1"
GO_NOTE = "Start the walk with g on the console or F1 on the remote. Studio never sends Go to the robot."
MAP_LABEL = "Studio reconstruction from the LIO cloud · the planner does not use this map"
# The only requests this process may put on the node's control socket. Checked before every send.
NODE_COMMANDS = frozenset({"status", "goal", "stand"})
INBOX_COMMANDS = ("goal", "go", "stand", "end")
WALKING = ("PRESCAN", "RUN")
STANDING_PHASES = ("WAIT", "ARRIVED", "STOPPED")
# id, label, topic, endpoint key, freshness threshold (s), classification
STREAMS = (
    ("odom", "LIO odometry (bridge odom)", b"odom", "odom", 0.1, "estimated"),
    ("cloud", "LIO cloud (bridge cloud)", b"cloud", "cloud", 0.5, "estimated"),
    ("pose", "Node reference (pose)", b"pose", "pose", 0.5, "commanded"),
    ("g1_debug", "SONIC runner (g1_debug)", b"g1_debug", "debug", 0.5, "measured"),
    ("node_status", "Node status (control socket)", None, "control", 1.5, "reported"),
)
STREAM_KEYS = {sid: key for sid, _, _, key, _, _ in STREAMS}
ENDPOINT_KEYS = {"odom": True, "control": True, "cloud": False, "pose": False, "debug": False}
# name: (default, minimum, maximum)
LIMITS = {
    "status_period_s": (0.5, 0.1, 5.0),
    "request_timeout_s": (0.4, 0.05, 5.0),
    "command_timeout_s": (1.0, 0.1, 5.0),
    "readback_timeout_s": (3.0, 0.5, 10.0),
    "readback_tolerance_m": (0.05, 0.001, 0.5),
    "publish_period_s": (0.1, 0.05, 0.2),
    "map_period_s": (0.5, 0.1, 5.0),
    "map_half_extent_m": (12.0, 2.0, 50.0),
    "map_res_m": (0.05, 0.02, 0.5),
    "map_range_m": (4.0, 0.5, 30.0),
    "cloud_points": (5000, 100, 20000),
    "map_points": (5000, 100, 50000),
    "frame_rate_hz": (50.0, 1.0, 50.0),
    "snapshot_period_s": (0.5, 0.1, 10.0),
    "max_frames": (20000, 100, 200000),  # reaching it halves the recorded rate, so a recording stays bounded
    "max_snapshots": (300, 10, 5000),
    "max_duration_s": (4 * 3600.0, 1.0, 24 * 3600.0),
}
MAX_CONFIG_BYTES = 64 * 1024
MAX_INBOX_BYTES = 64 * 1024
MAX_SESSION_BYTES = 60 * 1024 * 1024
DISPLAY_MODEL = Path("/home/linjiw/code/g1-student-deploy/sim/assets/g1_29dof.xml")
ISAAC_TO_MJ_INDEX = [ISAAC_JOINTS.index(name) for name in MJ_JOINTS]
# Constant per-frame labels: on every live frame, once in a recording's metadata (frame_conventions).
FRAME_LABELS = {
    "sequence_basis": "odometry receive order (no wire sequence)",
    "source_clock_note": "bridge stamp: host-monotonic forwarding time per its source; not verified here",
    "pose_source": "LIO estimate (bridge odom)",
    "joints_source": "g1_debug body_q_measured (or body_q)",
    "qpos_basis": "estimated LIO pose + measured g1_debug joints; null when either is missing",
}
REFERENCE_LABELS = {
    "kind": "node reference chunk (SONIC protocol v1)",
    "joint_order": "named MuJoCo (converted from wire IsaacLab order)",
    "row_basis": "first row of the newest chunk; the runner's playback cursor is not observed",
}


class ConfigError(ValueError):
    """The link refuses a configuration as a whole; nothing is connected."""


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def load_config(document):
    """Validate a config document (dict). Loopback endpoints only; unknown keys and bad limits refuse it."""
    if not isinstance(document, dict):
        raise ConfigError("config must be a JSON object")
    unknown = set(document) - {"endpoints", "limits", "label", "capture", "session_id"}
    if unknown:
        raise ConfigError(f"unknown config keys: {sorted(unknown)}")
    endpoints = document.get("endpoints")
    if not isinstance(endpoints, dict):
        raise ConfigError("config needs an endpoints object")
    unknown = set(endpoints) - set(ENDPOINT_KEYS)
    if unknown:
        raise ConfigError(f"unknown endpoints: {sorted(unknown)}")
    clean = {}
    for key, required in ENDPOINT_KEYS.items():
        value = endpoints.get(key)
        if value is None:
            if required:
                raise ConfigError(f"endpoint {key} is required")
            continue
        if not isinstance(value, str):
            raise ConfigError(f"endpoint {key} must be a string")
        try:
            clean[key] = validate_endpoint(value)
        except ValueError as exc:
            raise ConfigError(f"endpoint {key} refused ({value!r}): {exc}") from None
    limits = document.get("limits", {})
    if not isinstance(limits, dict):
        raise ConfigError("limits must be an object")
    unknown = set(limits) - set(LIMITS)
    if unknown:
        raise ConfigError(f"unknown limits: {sorted(unknown)}")
    values = {}
    for name, (default, low, high) in LIMITS.items():
        value = limits.get(name, default)
        if not _finite(value) or isinstance(value, bool) or not low <= value <= high:
            raise ConfigError(f"limit {name} must be a number in [{low}, {high}]")
        values[name] = float(value)
    cells = (2 * values["map_half_extent_m"] / values["map_res_m"] + 1) ** 2
    if cells > 4_000_000:
        raise ConfigError("display map exceeds 4 million cells; use a coarser resolution or a smaller extent")
    label = document.get("label")
    if label is not None and (not isinstance(label, str) or len(label) > 120):
        raise ConfigError("label must be a string of at most 120 characters")
    session_id = document.get("session_id")
    if session_id is not None and (not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session_id)):
        raise ConfigError("session_id must be a URL-safe identifier")
    capture = document.get("capture")
    if capture is not None:
        if not isinstance(capture, dict) or set(capture) - {"topics", "max_bytes"}:
            raise ConfigError("capture must be {topics, max_bytes}")
        topics = capture.get("topics", ["odom", "pose", "g1_debug"])
        if (not isinstance(topics, list) or not topics
                or any(t not in ("odom", "cloud", "pose", "g1_debug") for t in topics)):
            raise ConfigError("capture topics must be a non-empty subset of odom, cloud, pose, g1_debug")
        max_bytes = capture.get("max_bytes", 256 * 1024 * 1024)
        if type(max_bytes) is not int or not 1024 <= max_bytes <= 1024 ** 3:
            raise ConfigError("capture max_bytes must be an integer in [1 KiB, 1 GiB]")
        capture = {"topics": list(dict.fromkeys(topics)), "max_bytes": max_bytes}
    return {"endpoints": clean, "limits": values, "label": label, "capture": capture, "session_id": session_id}


def yaw_of(quat_wxyz):
    """Heading exactly as node.py's handle_commands computes it from the odometry quaternion."""
    w, x, y, z = quat_wxyz
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def goal_to_ahead_left(xy_now, quat_wxyz, goal_xy):
    """Invert node.py: goal = q[:2] + R(yaw) @ (ahead, left)  =>  (ahead, left) = R(yaw)^T (goal - q[:2])."""
    yaw = yaw_of(quat_wxyz)
    dx, dy = goal_xy[0] - xy_now[0], goal_xy[1] - xy_now[1]
    c, s = math.cos(yaw), math.sin(yaw)
    return c * dx + s * dy, -s * dx + c * dy


def _clean(value):
    """JSON-safe copy of a node status: non-finite numbers become null, other types are kept."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, bool, int, float)) or value is None:
        return value
    return str(value)


def _xy(value):
    if (isinstance(value, (list, tuple)) and len(value) == 2 and all(_finite(v) and not isinstance(v, bool)
                                                                     for v in value)):
        return [float(value[0]), float(value[1])]
    return None


def atomic_write(path, text):
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def atomic_json(path, value):
    atomic_write(path, json.dumps(value, allow_nan=False, separators=(",", ":")))


def _hash(path):
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


class DisplayMap:
    """Studio's display map from the LIO-registered cloud, in the planner memory's layer format.

    A bounded square grid centred on the first odometry pose, `i` along x, cell [i, j] centred at lo + (i, j) * res
    (Flow sensor_map, indexing "ij"). The rules mirror the g1deploy/perception/cloud_memory.py docstring on raw
    points: returns farther than `range_m` from the sensor origin are dropped (the planner's 4 m gate); ground
    (z < 0.05 m) -> support 0; per cell, any non-ground return below 0.8 m makes it solid with support = the
    highest return of the cell; a cell with only returns from 0.8 m to 2.2 m is overhead with ceiling = its lowest
    return; returns at 2.2 m and above are ignored (room ceiling). Returns are binned `face_push_m` past the
    surface along their ray, as the memory does. Evidence accumulates over scans (support max, ceiling min).
    """

    SKIPPED = ("no self filter: the robot's own arms and hands can appear as obstacles",
               "no per-slice deskew: the bridge's registered cloud is used as received",
               "no free-space carving: ceiling is never +inf (observed clear), unseen cells stay NaN",
               "no noise thresholds (min_low_points, low_ratio) and no edge attachment of overhead returns",
               "no memory_boxes: boxes is an empty list")
    RULES = ("ground z < 0.05 m -> support 0; any return below 0.8 m in a cell -> support = max z of the cell; "
             "only returns in [0.8, 2.2) m -> ceiling = min z; >= 2.2 m ignored; 4 m range gate from the sensor origin")

    def __init__(self, center_xy, *, half_extent_m=12.0, res=0.05, range_m=4.0, ground_tol_m=0.05,
                 overhead_min_m=0.8, ceiling_max_m=2.2, face_push_m=0.035):
        import numpy as np

        self.np = np
        self.center = [float(center_xy[0]), float(center_xy[1])]
        self.lo = np.asarray(center_xy, dtype=float) - half_extent_m
        self.res, self.range_m = float(res), float(range_m)
        self.n = int(round(2 * half_extent_m / res)) + 1
        self.ground_tol, self.over_min, self.ceil_max, self.face_push = ground_tol_m, overhead_min_m, ceiling_max_m, face_push_m
        flat = self.n * self.n
        self.n_ground = np.zeros(flat, dtype=np.int32)
        self.n_low = np.zeros(flat, dtype=np.int32)
        self.zmax = np.full(flat, -np.inf)
        self.zmin_high = np.full(flat, np.inf)
        self.support = np.full((self.n, self.n), np.nan)
        self.ceiling = np.full((self.n, self.n), np.nan)
        self.lock = threading.Lock()
        self.version, self.updated_s, self.observed = 0, None, 0
        self.stats = {"clouds": 0, "points": 0, "used_points": 0, "ground_points": 0, "range_gated": 0,
                      "above_band": 0, "outside_grid": 0, "solid_cells": 0, "overhead_cells": 0, "ground_cells": 0}

    def _cells(self, xy):
        np = self.np
        ij = np.round((np.asarray(xy, dtype=float).reshape(-1, 2) - self.lo) / self.res).astype(np.int64)
        ok = (ij >= 0).all(1) & (ij < self.n).all(1)
        return ij[:, 0] * self.n + ij[:, 1], ok

    def add(self, points, origin, t):
        np = self.np
        pts = np.asarray(points, dtype=np.float64).reshape(-1, 3)
        total = len(pts)
        keep = np.ones(total, dtype=bool)
        if origin is not None:
            keep &= np.linalg.norm(pts - origin, axis=1) <= self.range_m
        gated = int((~keep).sum())
        band = pts[:, 2] < self.ceil_max
        above = int((keep & ~band).sum())
        pts = pts[keep & band]
        ground = pts[:, 2] < self.ground_tol
        gi, gok = self._cells(pts[ground, :2])
        obj = pts[~ground]
        if origin is not None and len(obj):
            ray = obj - origin
            unit = ray / np.maximum(np.linalg.norm(ray, axis=1), 1e-9)[:, None]
            oxy = obj[:, :2] + self.face_push * unit[:, :2]
        else:
            oxy = obj[:, :2]
        oi, ook = self._cells(oxy)
        idx, z = oi[ook], obj[ook, 2]
        low = z < self.over_min
        with self.lock:
            np.add.at(self.n_ground, gi[gok], 1)
            np.add.at(self.n_low, idx[low], 1)
            np.maximum.at(self.zmax, idx, z)
            np.minimum.at(self.zmin_high, idx[~low], z[~low])
            solid = self.n_low > 0
            high = ~solid & np.isfinite(self.zmin_high)
            sup = np.where(self.n_ground > 0, 0.0, np.nan)
            sup = np.where(solid, self.zmax, sup)
            self.support.reshape(-1)[:] = sup
            self.ceiling.reshape(-1)[:] = np.where(high, self.zmin_high, np.nan)
            s = self.stats
            s["clouds"] += 1
            s["points"] += total
            s["used_points"] += len(pts)
            s["ground_points"] += int(ground.sum())
            s["range_gated"] += gated
            s["above_band"] += above
            s["outside_grid"] += int((~gok).sum() + (~ook).sum())
            s["solid_cells"], s["overhead_cells"] = int(solid.sum()), int(high.sum())
            s["ground_cells"] = int(((self.n_ground > 0) & ~solid).sum())
            self.observed = int(((self.n_ground > 0) | solid | high).sum())
            self.version += 1
            self.updated_s = float(t)

    def snapshot(self):
        """Copies of the layers and stats, consistent with each other."""
        with self.lock:
            return self.support.copy(), self.ceiling.copy(), self.version, self.updated_s, dict(self.stats)

    def describe(self):
        """What the map is, its version and coverage; no array copies."""
        with self.lock:
            version, updated_s, observed = self.version, self.updated_s, self.observed
        return {"basis": "studio-reconstruction", "label": MAP_LABEL, "classification": "estimated",
                "frame_id": "odom", "planner_uses_this_map": False, "center_xy": self.center,
                "lo": self.lo.tolist(), "res_m": self.res, "shape": [self.n, self.n], "range_m": self.range_m,
                "seq": version, "updated_s": updated_s, "observed_fraction": observed / (self.n * self.n),
                "rules": self.RULES, "skipped": list(self.SKIPPED)}

    def points(self, layer, budget):
        np = self.np
        flat = np.flatnonzero(np.isfinite(layer.reshape(-1)))
        flat = flat[::max(1, math.ceil(len(flat) / budget))] if len(flat) else flat
        i, j = np.divmod(flat, self.n)
        pts = np.column_stack([self.lo[0] + i * self.res, self.lo[1] + j * self.res, layer.reshape(-1)[flat]])
        return np.round(pts, 3).tolist()


class Stream:
    """Receipt-time health of one input. Age counts from the last valid message; rate from all arrivals."""

    def __init__(self, sid, label, threshold_s, endpoint, classification):
        self.id, self.label, self.threshold_s = sid, label, threshold_s
        self.endpoint, self.classification = endpoint, classification
        self.arrivals = deque(maxlen=256)
        self.last_valid = None
        self.received = self.valid = self.malformed = self.superseded = self.dropped = 0
        self.transport = "unknown" if endpoint else "not configured"
        self.last_error = None

    def snapshot(self, now_mono, t0):
        if self.endpoint is None:
            status, age = "unavailable", None
        elif self.last_valid is None:
            status, age = "unavailable", None
        else:
            age = max(0.0, now_mono - self.last_valid)
            status = "fresh" if age <= self.threshold_s else "stale"
        window = [t for t in self.arrivals if now_mono - t <= 2.0]
        rate = (len(window) - 1) / (window[-1] - window[0]) if len(window) >= 2 and window[-1] > window[0] else None
        return {"id": self.id, "label": self.label, "endpoint": self.endpoint, "configured": self.endpoint is not None,
                "classification": self.classification, "age_s": age, "rate_hz": rate,
                "rate_basis": "arrivals in the last 2 s on this host", "threshold_s": self.threshold_s,
                "status": status, "transport": self.transport, "received": self.received, "valid": self.valid,
                "malformed": self.malformed, "superseded": self.superseded, "dropped": self.dropped,
                "last_error": self.last_error,
                "last_valid_s": None if self.last_valid is None else self.last_valid - t0}


class ControlRequest:
    def __init__(self, message, timeout_s):
        if message.get("cmd") not in NODE_COMMANDS:
            raise ValueError(f"the robot link never sends {message.get('cmd')!r} to the node")
        self.message, self.timeout_s = message, timeout_s
        self.done = threading.Event()
        self.reply, self.error, self.replied_mono = None, None, None


class RobotLink:
    def __init__(self, config, output):
        self.cfg = config
        self.limits = config["limits"]
        self.endpoints = config["endpoints"]
        self.output = Path(output)
        self.inbox = self.output / "inbox"
        self.inbox.mkdir(parents=True, exist_ok=True)
        self.t0 = time.monotonic()
        self.started_unix = time.time()
        self.session_id = config.get("session_id") or self.output.parent.name or "robot-link"
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.stopped_by = None
        self.ended = False
        self.streams = {sid: Stream(sid, label, thr, self.endpoints.get(key), cls)
                        for sid, label, _, key, thr, cls in STREAMS}
        # Latest decoded inputs (written by their owning thread under self.lock).
        self.odom = self.debug = self.pose = self.cloud = None
        self.status = self.status_mono = None
        self.fixture = False
        self.map = None
        self.cloud_queue = deque(maxlen=2)  # drop-oldest between the receiver and the map thread
        self.cloud_ready = threading.Event()
        self.clouds_before_odom = 0
        self.control_queue = queue.Queue(maxsize=4)
        self.fast_poll = False
        # Recording.
        self.frames, self.snapshots, self.events = [], [], []
        self.frame_period = 1.0 / self.limits["frame_rate_hz"]
        self.frame_thinning = 0
        self.snapshot_thinning = 0
        self.snapshot_period = self.limits["snapshot_period_s"]
        self.last_frame_t = -math.inf
        self.path_m, self.last_xy, self.odom_jumps = 0.0, None, 0
        self.commands = deque(maxlen=20)
        self.legs, self.leg_open = [], None
        self.phase_prev = None
        self.last_goal_cmd = None  # the last applied goal command: {seq, xy, time_s}
        self.pending = None
        self.last_seq = 0
        self.stream_status = {}
        self.perception_json, self.perception_t = "null", -math.inf
        self.last_cloud_seen = None
        self.map_written = -1
        self.capture = None
        self.threads, self.thread_errors = [], []
        here = Path(__file__).resolve()
        self.artifacts = [h for h in (_hash(here), _hash(here.with_name("protocols.py"))) if h]

    # ------------------------------------------------------------------ helpers
    def now(self):
        return time.monotonic() - self.t0

    def event(self, kind, message, **extra):
        with self.lock:
            if len(self.events) < 20000 or kind in ("command", "phase", "leg"):
                self.events.append({"time": self.now(), "type": kind, "message": message,
                                    "source": "studio.robot_link", **extra})

    def request_stop(self, reason):
        if self.stopped_by is None:
            self.stopped_by = reason
        self.stop_event.set()

    # ------------------------------------------------------------------ telemetry (SUB only)
    def _receive_loop(self):
        import zmq
        from zmq.utils.monitor import recv_monitor_message

        ctx = self.ctx
        poller = zmq.Poller()
        sockets, monitors = {}, {}
        for sid, _, topic, key, _, _ in STREAMS:
            endpoint = self.endpoints.get(key)
            if topic is None or endpoint is None:
                continue
            sock = ctx.socket(zmq.SUB)
            sock.setsockopt(zmq.LINGER, 0)
            sock.setsockopt(zmq.RCVHWM, 8 if sid == "cloud" else 64)
            sock.setsockopt(zmq.MAXMSGSIZE, MAX_PACKET_BYTES)
            if "[" in endpoint:
                sock.setsockopt(zmq.IPV6, 1)
            sock.setsockopt(zmq.SUBSCRIBE, topic)
            monitor = sock.get_monitor_socket(events=zmq.EVENT_CONNECTED | zmq.EVENT_DISCONNECTED)
            sock.connect(endpoint)
            sockets[sock] = (sid, topic)
            monitors[monitor] = sid
            poller.register(sock, zmq.POLLIN)
            poller.register(monitor, zmq.POLLIN)
        try:
            while not self.stop_event.is_set():
                for sock, _ in poller.poll(50):
                    if sock in monitors:
                        event = recv_monitor_message(sock)
                        state = "connected" if event["event"] == zmq.EVENT_CONNECTED else "disconnected"
                        with self.lock:
                            self.streams[monitors[sock]].transport = state
                        continue
                    sid, topic = sockets[sock]
                    batch = []
                    while len(batch) < 512:
                        try:
                            batch.append(sock.recv_multipart(flags=zmq.NOBLOCK))
                        except zmq.Again:
                            break
                    self._handle_batch(sid, topic, batch)
        finally:
            for sock in sockets:
                sock.disable_monitor()
                sock.close(0)
            for monitor in monitors:
                monitor.close(0)

    def _handle_batch(self, sid, topic, batch):
        stream = self.streams[sid]
        receipt = time.monotonic()
        with self.lock:
            for _ in batch:
                stream.arrivals.append(receipt)
            stream.received += len(batch)
        if not batch:
            return
        # Odometry is cheap: every message (the trail, path length and 50 Hz frames). Other streams keep the newest
        # message of a burst; older ones are counted as superseded, never queued.
        todo = batch if sid == "odom" else batch[-1:]
        with self.lock:
            stream.superseded += len(batch) - len(todo)
        for parts in todo:
            if len(parts) != 1:
                with self.lock:
                    stream.malformed += 1
                    stream.last_error = "multipart message"
                continue
            message = parts[0]
            try:
                self._decode(sid, topic, message, receipt)
            except (ProtocolError, ValueError, TypeError, OverflowError, KeyError) as exc:
                with self.lock:
                    stream.malformed += 1
                    stream.last_error = f"{type(exc).__name__}: {exc}"[:200]
                continue
            with self.lock:
                stream.valid += 1
                stream.last_valid = receipt
                stream.last_error = None
            if self.capture is not None and sid in self.cfg["capture"]["topics"]:
                self._capture(sid, topic, message, receipt)

    def _decode(self, sid, topic, message, receipt):
        t = receipt - self.t0
        if sid == "odom":
            _, f = decode_packed_topic(message, topic)
            pos = [float(v) for v in f["pos"]]
            quat = [float(v) for v in f["quat_wxyz"]]
            lin = [float(v) for v in f["lin_w"]] if "lin_w" in f and f["lin_w"].shape == (3,) else None
            stamp = float(f["stamp"][0]) if "stamp" in f else None
            with self.lock:
                count = (self.odom["count"] + 1) if self.odom else 1
                self.odom = {"pos": pos, "quat": quat, "lin": lin, "stamp": stamp, "t": t, "receipt": receipt,
                             "count": count}
                if self.last_xy is not None:
                    step = math.dist(self.last_xy, pos[:2])
                    if step > 1.0:  # a LIO reset or a restarted bridge: not walked distance
                        self.odom_jumps += 1
                        self.event("odom_jump", f"odometry jumped {step:.2f} m between two messages",
                                   jump_m=step)
                    else:
                        self.path_m += step
                self.last_xy = pos[:2]
                if self.map is None and self.endpoints.get("cloud") is not None:
                    lim = self.limits
                    self.map = DisplayMap(pos[:2], half_extent_m=lim["map_half_extent_m"], res=lim["map_res_m"],
                                          range_m=lim["map_range_m"])
                    self.event("map", f"display map centred on the first odometry pose {pos[0]:.2f}, {pos[1]:.2f}")
                if t - self.last_frame_t >= 0.75 * self.frame_period:  # 50 Hz input jitters around 20 ms
                    self.last_frame_t = t
                    self._record_frame()
        elif sid == "cloud":
            _, f = decode_packed_topic(message, topic)
            import numpy as np

            points = np.asarray(f["points"], dtype=np.float64)
            origin = np.asarray(f["origin"], dtype=np.float64) if "origin" in f else None
            budget = int(self.limits["cloud_points"])
            stride = max(1, math.ceil(len(points) / budget))
            cloud = {"t": t, "receipt": receipt, "count": len(points), "display": points[::stride],
                     "stride": stride, "origin": None if origin is None else origin.tolist(),
                     "stamp": float(f["stamp"][0]) if "stamp" in f else None}
            with self.lock:
                self.cloud = cloud
                if len(self.cloud_queue) == self.cloud_queue.maxlen:
                    self.streams["cloud"].dropped += 1
                self.cloud_queue.append((points, origin, t))
            self.cloud_ready.set()
        elif sid == "pose":
            decoded = decode_pose(message)
            fields = decoded["fields"]
            row = fields["joint_pos"][0]
            ref = {"t": t, "classification": "commanded", "joints": [row[i] for i in ISAAC_TO_MJ_INDEX],
                   "quaternion_wxyz": fields["body_quat"][0], "position": None,
                   "frame_index_first": fields["frame_index"][0], "frame_index_last": fields["frame_index"][-1],
                   "frames": decoded["header"]["count"], "source_timestamp": decoded["source_timestamp"],
                   "frame_id": decoded["frame_id"]}
            with self.lock:
                self.pose = ref
        elif sid == "g1_debug":
            decoded = decode_debug(message, topic)
            measured = decoded["measured"]
            with self.lock:
                self.debug = {"t": t, "joints": measured["joint_position"], "velocity": measured["joint_velocity"],
                              "sequence": decoded["sequence"], "temperature": decoded["fields"].get("motor_temperature")}

    def _capture(self, sid, topic, message, receipt):
        try:
            event = decode_packet(message, topic, receipt_monotonic=receipt, receipt_unix=time.time(),
                                  source_id=self.endpoints[STREAM_KEYS[sid]],
                                  session_id=self.session_id)
        except (ProtocolError, ValueError, TypeError, OverflowError):
            return
        event["wire_base64"] = base64.b64encode(message).decode("ascii")
        self.capture.submit(event)

    # ------------------------------------------------------------------ recording frames
    def _record_frame(self):
        """Called under self.lock on an odometry receipt, at most frame_rate_hz."""
        frame = self._frame(self.odom["t"], live=False)
        self.frames.append(frame)
        if len(self.frames) >= self.limits["max_frames"]:
            self.frames = self.frames[::2]
            self.frame_period *= 2
            self.frame_thinning += 1

    def _frame(self, now, live=True):
        odom, debug, pose = self.odom, self.debug, self.pose
        if odom is None:
            return None
        age = max(0.0, now - odom["t"])
        if debug is None or debug["joints"] is None:  # no runner debug, or a packet without a joint vector
            joints_status = "unavailable"
        else:
            joints_status = "fresh" if now - debug["t"] <= 0.5 else "stale"
        joints = debug["joints"] if joints_status == "fresh" else None
        pose_fresh = pose is not None and now - pose["t"] <= 0.5
        reference = None
        if pose_fresh:
            reference = {k: v for k, v in pose.items() if k != "t"}
            reference["age_s"] = now - pose["t"]
            if live:
                reference.update(REFERENCE_LABELS)
        status = self.status if self._status_fresh() else None
        latency = status.get("latency_s") if status else None
        frame = {
            "time": odom["t"], "sequence": odom["count"],
            "source_time": odom["stamp"], "source_clock_domain": "unknown",
            "receipt_time": odom["receipt"], "receipt_clock_domain": "host-monotonic", "sim_time": None,
            "position": list(odom["pos"]), "quaternion_wxyz": list(odom["quat"]),
            "classification": "estimated", "frame_id": "odom",
            "validity": "valid" if age <= 0.1 else "stale",
            "linear_velocity_w": odom["lin"], "linear_velocity_classification": "estimated" if odom["lin"] else None,
            "joints": joints, "joints_classification": "measured" if joints else None, "joints_status": joints_status,
            "joint_velocity_rad_s": debug["velocity"] if joints else None,
            "qpos": list(odom["pos"]) + list(odom["quat"]) + list(joints) if joints else None,
            "reference": reference, "command": None, "plan": None, "imu": None, "perception_index": None,
            "health": {"state_age_ms": age * 1000, "reference_age_ms": None if pose is None else (now - pose["t"]) * 1000,
                       "planner_latency_ms": latency * 1000 if _finite(latency) else None,
                       "planner_latency_basis": "node status latency_s (reported)" if _finite(latency) else None,
                       "tilt_rad": status.get("tilt_rad") if status else None,
                       "tracking_rmse_rad": None, "lowcmd_age_ms": None, "sonic_inference_ms": None,
                       "contact_force_n": None, "gpu_utilization": None},
        }
        if live:
            frame.update(FRAME_LABELS, age_s=age)
        return frame

    # ------------------------------------------------------------------ display map
    def _map_loop(self):
        while not self.stop_event.is_set():
            if not self.cloud_ready.wait(0.1):
                continue
            with self.lock:
                item = self.cloud_queue.popleft() if self.cloud_queue else None
                if not self.cloud_queue:
                    self.cloud_ready.clear()
                display_map = self.map
            if item is None:
                continue
            if display_map is None:
                with self.lock:
                    self.clouds_before_odom += 1
                continue
            points, origin, t = item
            try:
                display_map.add(points, origin, t)
            except (ValueError, FloatingPointError, MemoryError) as exc:
                with self.lock:
                    self.streams["cloud"].last_error = f"map: {type(exc).__name__}: {exc}"[:200]

    def _write_map(self, force=False):
        display_map = self.map
        if display_map is None:
            return
        import numpy as np

        support, ceiling, version, updated_s, stats = display_map.snapshot()
        if version == self.map_written and not force:
            return
        stats.update(display_map.describe(), seq=version, updated_s=updated_s,
                     source="LIO cloud (bridge `cloud`) via " + str(self.endpoints.get("cloud")),
                     boxes_note="boxes is empty: Studio does not derive memory_boxes from its display map",
                     clouds_before_first_odom=self.clouds_before_odom)
        tmp = self.output / f".memory.npz.{uuid.uuid4().hex}.tmp"
        try:
            with tmp.open("wb") as handle:
                np.savez_compressed(handle, support=support, ceiling=ceiling, lo=display_map.lo.copy(),
                                    res=np.float64(display_map.res), boxes=json.dumps([]),
                                    stats=json.dumps(stats, allow_nan=False))
            os.replace(tmp, self.output / "memory.npz")
        finally:
            tmp.unlink(missing_ok=True)
        self.map_written = version

    def _perception(self, now, budget_raw, budget_map, round_raw=True):
        display_map, cloud = self.map, self.cloud
        cloud_stream = self.streams["cloud"]
        if self.endpoints.get("cloud") is None:
            return {"available": False, "reason": "No cloud endpoint configured (bridge --forward-cloud)",
                    "label": MAP_LABEL, "classification": "estimated", "frame_id": "odom"}
        if display_map is None and cloud is None:
            return {"available": False, "reason": "No LIO cloud or odometry received yet", "label": MAP_LABEL,
                    "classification": "estimated", "frame_id": "odom"}
        import numpy as np

        p = {"available": True, "kind": "map-snapshot", "classification": "estimated", "label": MAP_LABEL,
             "source": "studio.robot_link.DisplayMap from the LIO-registered cloud", "time": now,
             "clock_domain": "host-monotonic (robot link start = 0)", "frame_id": "odom", "synchronized": False,
             "self_filter": False, "filtered_lidar": None,
             "filtered_lidar_basis": "unavailable: Studio applies no self filter", "decimated": True,
             "mask_convention": "grid[x][y]; NaN cells unknown; only finite cells are rendered",
             "planner_memory": "unavailable until the node publishes its memory (U2)"}
        if cloud is not None:
            raw = cloud["display"]
            if len(raw) > budget_raw:
                raw = raw[::math.ceil(len(raw) / budget_raw)]
            p.update(raw_lidar=np.round(raw, 3).tolist() if round_raw else raw.tolist(),
                     raw_lidar_basis="LIO-registered cloud as received (odom frame), uniform stride, rounded to 1 mm",
                     raw_points_count=cloud["count"], sensor_capture_time=cloud["t"],
                     sensor_capture_basis="receipt time on this host (the stamp has no clock-domain tag)",
                     sensor_origin=cloud["origin"], cloud_age_s=now - cloud["t"])
        else:
            p.update(raw_lidar=[], raw_points_count=0, sensor_capture_time=None, sensor_origin=None, cloud_age_s=None)
        with self.lock:
            p["cloud_status"] = cloud_stream.snapshot(time.monotonic(), self.t0)["status"]
        if display_map is not None:
            support, ceiling, version, updated_s, stats = display_map.snapshot()
            desc = display_map.describe()
            p.update(map_time=updated_s, map_seq=version, support_points=display_map.points(support, budget_map),
                     ceiling_points=display_map.points(ceiling, budget_map), origin=desc["lo"],
                     resolution_m=desc["res_m"], grid_shape=desc["shape"],
                     observed_cells={"support": int(np.isfinite(support).sum()), "ceiling": int(np.isfinite(ceiling).sum())},
                     unknown_cells=int((np.isnan(support) & np.isnan(ceiling)).sum()),
                     observed_fraction=desc["observed_fraction"], rules=desc["rules"], skipped=desc["skipped"],
                     filter_stats=stats, point_budget=budget_map)
        else:
            p.update(support_points=[], ceiling_points=[], map_time=None, map_seq=0)
        return p

    # ------------------------------------------------------------------ node control (REQ, lazy pirate)
    def _control_loop(self):
        import zmq

        endpoint = self.endpoints["control"]
        sock = None
        next_status = 0.0

        def fresh_socket(timeout_s):
            s = self.ctx.socket(zmq.REQ)
            s.setsockopt(zmq.LINGER, 0)
            s.setsockopt(zmq.RCVTIMEO, int(timeout_s * 1000))
            s.setsockopt(zmq.SNDTIMEO, int(timeout_s * 1000))
            if "[" in endpoint:
                s.setsockopt(zmq.IPV6, 1)
            s.connect(endpoint)
            return s

        def exchange(message, timeout_s):
            nonlocal sock
            if message.get("cmd") not in NODE_COMMANDS:  # defence in depth: go/quit can never leave this process
                raise RuntimeError(f"refusing to send {message.get('cmd')!r} to the node")
            if sock is None:
                sock = fresh_socket(timeout_s)
            sock.setsockopt(zmq.RCVTIMEO, int(timeout_s * 1000))
            try:
                sock.send(json.dumps(message, allow_nan=False).encode())
                raw = sock.recv()
            except zmq.ZMQError as exc:  # timeout (EAGAIN) or a broken REQ state machine: start over
                sock.close(0)
                sock = None
                return None, ("no reply within %.2f s" % timeout_s) if exc.errno == zmq.EAGAIN else f"ZMQ error: {exc}"
            try:
                reply = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                return None, "reply is not JSON"
            if not isinstance(reply, dict):
                return None, "reply is not a JSON object"
            return _clean(reply), None

        try:
            while not self.stop_event.is_set():
                try:
                    req = self.control_queue.get(timeout=0.02)
                except queue.Empty:
                    req = None
                if req is not None:
                    reply, error = exchange(req.message, req.timeout_s)
                    req.reply, req.error, req.replied_mono = reply, error, time.monotonic()
                    req.done.set()
                    next_status = 0.0  # read the effect back promptly
                    continue
                if time.monotonic() < next_status:
                    continue
                period = 0.1 if self.fast_poll else self.limits["status_period_s"]
                next_status = time.monotonic() + period
                reply, error = exchange({"cmd": "status"}, self.limits["request_timeout_s"])
                receipt = time.monotonic()
                stream = self.streams["node_status"]
                with self.lock:
                    if reply is not None:
                        stream.arrivals.append(receipt)
                    if reply is None:
                        stream.last_error = error
                        stream.transport = "no reply"
                    elif not isinstance(reply.get("phase"), str):
                        stream.received += 1
                        stream.malformed += 1
                        stream.last_error = "status reply without a phase"
                    else:
                        stream.received += 1
                        stream.valid += 1
                        stream.last_valid = receipt
                        stream.last_error = None
                        stream.transport = "replying"
                        self.status, self.status_mono = reply, receipt
                        if reply.get("fixture") is True and not self.fixture:
                            self.fixture = True
                            self.event("fixture", "the node reports fixture: true (tools/fake_node.py, not a robot)")
        finally:
            if sock is not None:
                sock.close(0)

    def _status_fresh(self):
        return self.status_mono is not None and time.monotonic() - self.status_mono <= 1.5

    def _odom_fresh(self):
        return self.odom is not None and time.monotonic() - self.odom["receipt"] <= 0.1

    def _standing(self):
        """WAIT, or ARRIVED/STOPPED with the node's standing flag (no deferred stand pending). None if unknown."""
        if not self._status_fresh():
            return None
        phase = self.status.get("phase")
        if phase == "WAIT":
            return True
        if phase in ("ARRIVED", "STOPPED"):
            return self.status.get("standing") is True
        return False

    def _can(self):
        phase = self.status.get("phase") if self.status else None
        reasons = {"goal": None, "go": GO_NOTE, "stand": None, "end": None}
        standing = self._standing()
        if self.ended:
            reasons.update(goal="the link has ended", stand="the link has ended", end="the link has ended")
        elif self.pending is not None:
            reasons["goal"] = reasons["stand"] = f"waiting for the node on command {self.pending['seq']}"
        else:
            why = []
            if not self._status_fresh():
                why.append("node status is " + ("unavailable" if self.status is None else "stale"))
            elif not standing:
                why.append(f"the robot is not standing (node phase {phase}"
                           + (", deferred stand pending)" if phase in ("ARRIVED", "STOPPED") else ")"))
            if not self._odom_fresh():
                why.append("odometry is " + ("unavailable" if self.odom is None else "stale"))
            reasons["goal"] = "; ".join(why) or None
            if phase not in WALKING:
                reasons["stand"] = f"stand applies while walking (PRESCAN or RUN); node phase {phase}"
        can = {"goal": reasons["goal"] is None, "go": False, "stand": reasons["stand"] is None,
               "end": not self.ended}
        return can, reasons

    # ------------------------------------------------------------------ commands
    def _record_command(self, seq, cmd, status, reason, **extra):
        entry = {"seq": seq, "cmd": cmd, "status": status, "reason": reason, "time_s": self.now(), **extra}
        with self.lock:
            self.commands.append(entry)
        self.event("command", f"{cmd} {status}" + (f": {reason}" if reason else ""), command=entry)
        return entry

    def _poll_inbox(self):
        if self.pending is not None or self.ended:
            return
        try:
            names = os.listdir(self.inbox)
        except OSError:
            return
        items = sorted((int(m.group(1)), name) for name in names if (m := re.fullmatch(r"(\d{6,9})\.json", name)))
        for seq, name in items:
            if seq <= self.last_seq:
                continue
            self.last_seq = seq
            self._take(seq, self.inbox / name)
            if self.pending is not None or self.stop_event.is_set():
                return

    def _take(self, seq, path):
        try:
            if path.stat().st_size > MAX_INBOX_BYTES:
                raise ValueError("command file exceeds 64 KiB")
            doc = json.loads(path.read_text(), parse_constant=lambda s: (_ for _ in ()).throw(ValueError(s)))
            if not isinstance(doc, dict):
                raise ValueError("command must be a JSON object")
            if doc.get("seq") != seq or type(doc.get("seq")) is not int:
                raise ValueError(f"seq field {doc.get('seq')!r} does not match the file name {seq}")
            cmd = doc.get("cmd")
            if cmd not in INBOX_COMMANDS:
                raise ValueError(f"unknown command {cmd!r}")
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            self._record_command(seq, None, "rejected", f"malformed command file: {exc}"[:300])
            return
        extra = {k: doc[k] for k in ("operator", "check") if k in doc}
        if cmd == "go":
            self._record_command(seq, "go", "rejected", GO_NOTE, **extra)
        elif cmd == "end":
            self._record_command(seq, "end", "applied", "link stopped; nothing was sent to the node", **extra)
            self.request_stop("end")
        elif cmd == "stand":
            can, reasons = self._can()
            if not can["stand"]:
                self._record_command(seq, "stand", "rejected", reasons["stand"], **extra)
                return
            self._send(seq, "stand", {"cmd": "stand"}, extra)
        else:
            xy = _xy(doc.get("xy"))
            if xy is None or max(abs(xy[0]), abs(xy[1])) > 1000:
                self._record_command(seq, "goal", "rejected", "xy must be two finite numbers (metres, odom)", **extra)
                return
            check = doc.get("check")
            if isinstance(check, dict) and check.get("ok") is False:
                blocking = [c.get("label") or c.get("id") for c in check.get("checks", [])
                            if isinstance(c, dict) and c.get("status") == "block"]
                self._record_command(seq, "goal", "rejected", "the goal check blocks: " + (", ".join(map(str, blocking)) or "not ok"),
                                     xy=xy, **extra)
                return
            can, reasons = self._can()
            if not can["goal"]:
                self._record_command(seq, "goal", "rejected", reasons["goal"], xy=xy, **extra)
                return
            with self.lock:
                odom = dict(self.odom)
            ahead, left = goal_to_ahead_left(odom["pos"][:2], odom["quat"], xy)
            conversion = {"from_xy": odom["pos"][:2], "from_yaw_rad": yaw_of(odom["quat"]), "ahead": ahead,
                          "left": left, "odom_age_s": time.monotonic() - odom["receipt"],
                          "basis": "relative to the current odom pose, inverting node.py handle_commands"}
            self._send(seq, "goal", {"cmd": "goal", "ahead": ahead, "left": left}, dict(extra, xy=xy,
                                                                                      conversion=conversion))

    def _send(self, seq, cmd, message, extra):
        timeout = self.limits["command_timeout_s"]
        req = ControlRequest(message, timeout)
        try:
            self.control_queue.put_nowait(req)
        except queue.Full:
            self._record_command(seq, cmd, "rejected", "control queue full", **extra)
            return
        self.pending = {"seq": seq, "cmd": cmd, "req": req, "extra": extra, "sent_mono": time.monotonic(),
                        "stage": "ack", "ack_mono": None, "reported": None}
        if cmd == "goal":
            self.fast_poll = True

    def _advance_pending(self):
        p = self.pending
        if p is None:
            return
        req, extra = p["req"], p["extra"]
        if p["stage"] == "ack":
            if not req.done.is_set():
                return
            reply = req.reply
            if reply is None or reply.get("ok") is not True:
                why = (f"the node did not acknowledge ({req.error}); it may still apply the command, "
                       "and the goal shown is the one the node reports") if reply is None else \
                      f"the node refused: {reply.get('error', reply)}"
                self._finish(p, "rejected", why)
                return
            if p["cmd"] == "stand":
                self._finish(p, "applied", "node acknowledged (queued); a settle-to-stand, not an emergency stop")
                return
            p["stage"], p["ack_mono"] = "readback", req.replied_mono
        if p["stage"] == "readback":
            tol = self.limits["readback_tolerance_m"]
            xy = extra["xy"]
            with self.lock:
                status, status_mono = self.status, self.status_mono
            if status_mono is not None and status_mono > p["ack_mono"]:
                reported = _xy(status.get("goal"))
                p["reported"] = reported
                if reported is not None:
                    dist = math.dist(reported, xy)
                    if dist <= tol:
                        self.last_goal_cmd = {"seq": p["seq"], "xy": xy, "time_s": self.now()}
                        self._finish(p, "applied", f"read back from node status: goal [{reported[0]:.3f}, "
                                     f"{reported[1]:.3f}], {dist * 100:.1f} cm from the request",
                                     readback={"goal": reported, "error_m": dist, "tolerance_m": tol})
                        return
            if time.monotonic() - p["ack_mono"] > self.limits["readback_timeout_s"]:
                reported = p["reported"]
                if reported is None:
                    why = (f"readback unavailable: no node status with a goal within "
                           f"{self.limits['readback_timeout_s']:.1f} s of the command")
                else:
                    why = (f"readback mismatch: node reports goal [{reported[0]:.3f}, {reported[1]:.3f}], "
                           f"{math.dist(reported, xy):.3f} m from the requested [{xy[0]:.3f}, {xy[1]:.3f}] "
                           f"(tolerance {tol * 100:.0f} cm); the node keeps the goal it reports")
                self._finish(p, "rejected", why, readback={"goal": reported, "tolerance_m": tol,
                                                         "error_m": None if reported is None else math.dist(reported, xy)})

    def _finish(self, p, status, reason, **more):
        self.pending = None
        self.fast_poll = False
        extra = dict(p["extra"], sent=p["req"].message, **more)
        self._record_command(p["seq"], p["cmd"], status, reason, **extra)

    # ------------------------------------------------------------------ phases and legs
    def _track_phase(self):
        with self.lock:
            status, status_mono = self.status, self.status_mono
        if status is None:
            return
        phase = status.get("phase")
        t_status = status_mono - self.t0
        if self.leg_open is not None:  # the node accepts a new goal mid-walk (e.g. from the console's n key)
            goal = _xy(status.get("goal"))
            last = self.leg_open["last_goal"]
            if goal is not None and last is not None and math.dist(goal, last) > 1e-6:
                self.leg_open["retargets"] += 1
            if goal is not None:
                self.leg_open["last_goal"] = goal
        if phase == self.phase_prev:
            return
        prev = self.phase_prev
        self.phase_prev = phase
        self.event("phase", f"node phase {prev} -> {phase}", **{"from": prev, "to": phase,
                   "observed_s": t_status, "basis": "node status poll"})
        if phase in WALKING and prev not in WALKING:
            self._start_leg(status, t_status)
        elif prev in WALKING and phase not in WALKING:
            outcome = {"ARRIVED": "arrived", "STOPPED": "stopped"}.get(phase, f"ended in {phase}")
            self._end_leg(status, t_status, outcome)

    def _start_leg(self, status, t_status):
        with self.lock:
            odom_xy = list(self.odom["pos"][:2]) if self._odom_fresh() else None
            path = self.path_m
        staged = self.last_goal_cmd
        if staged is not None and self.legs and self.legs[-1]["go_at_s"] is not None \
                and staged["time_s"] < self.legs[-1]["go_at_s"]:
            staged = None  # staged before the previous leg: not this leg's staging
        plans = status.get("plans")
        leg = {"index": len(self.legs), "goal_xy": _xy(status.get("goal")),
               "staged_at_s": staged["time_s"] if staged else None, "staged_seq": staged["seq"] if staged else None,
               "go_at_s": t_status,
               "go_basis": "first node status showing PRESCAN/RUN (polled); the operator's Go came up to one poll earlier",
               "start_xy": odom_xy, "end_s": None, "outcome": None, "duration_s": None, "path_m": None,
               "final_dist_m": None, "max_contact_n": None, "max_contact_basis": "not observable on the real robot",
               "plans": None, "retargets": 0, "in_progress": True,
               "_path0": path, "_plans0": plans if type(plans) is int else None, "last_goal": _xy(status.get("goal"))}
        self.legs.append(leg)
        self.leg_open = leg
        self.event("leg", f"leg {leg['index']} started (node phase {status.get('phase')})", leg=leg["index"])

    def _end_leg(self, status, t_status, outcome):
        leg = self.leg_open
        if leg is None:
            return
        with self.lock:
            path = self.path_m
        plans = status.get("plans") if status else None
        dist = status.get("goal_dist_m") if status else None
        leg.update(end_s=t_status, outcome=outcome, duration_s=t_status - leg["go_at_s"], path_m=path - leg["_path0"],
                   final_dist_m=dist if _finite(dist) else None,
                   plans=plans - leg["_plans0"] if type(plans) is int and leg["_plans0"] is not None else None,
                   in_progress=False)
        self.leg_open = None
        self.event("leg", f"leg {leg['index']} ended: {outcome}", leg=leg["index"], outcome=outcome)

    def _legs_public(self):
        out = []
        for leg in self.legs:
            item = {k: v for k, v in leg.items() if not k.startswith("_") and k != "last_goal"}
            if leg["in_progress"]:
                item["duration_s"] = self.now() - leg["go_at_s"]
                with self.lock:
                    item["path_m"] = self.path_m - leg["_path0"]
            out.append(item)
        return out

    # ------------------------------------------------------------------ snapshot
    def _navigation(self):
        mono = time.monotonic()
        with self.lock:
            streams = [s.snapshot(mono, self.t0) for s in self.streams.values()]
            status, status_mono = self.status, self.status_mono
            commands = list(self.commands)
        fresh = self._status_fresh()
        phase = "ENDED" if self.ended else (status.get("phase") if status else None)
        goal_xy = _xy(status.get("goal")) if status else None
        staged = self.last_goal_cmd
        goal = None
        if goal_xy is not None:
            matches = staged is not None and math.dist(staged["xy"], goal_xy) <= self.limits["readback_tolerance_m"]
            goal = {"xy": goal_xy, "frame_id": "odom", "seq": staged["seq"] if matches else None,
                    "staged_at_s": staged["time_s"] if matches else None, "source": "node status",
                    "status": "fresh" if fresh else "stale"}
        can, reasons = self._can()
        dist = status.get("goal_dist_m") if (status and fresh) else None
        display_map = self.map
        map_info = None
        if display_map is not None:
            map_info = dict(display_map.describe(), file="memory.npz",
                            file_seq=self.map_written if self.map_written >= 0 else None)
        return {
            "phase": phase, "phase_status": "ended" if self.ended else ("fresh" if fresh else ("stale" if status else "unavailable")),
            "phase_age_s": None if status_mono is None else mono - status_mono, "phase_source": "node status",
            "standing": self._standing(),
            "standing_basis": "node phase WAIT, or ARRIVED/STOPPED with node status standing = true",
            "goal": goal, "goal_dist_m": dist if _finite(dist) else None, "goal_dist_source": "node status",
            "legs": self._legs_public(), "commands": commands, "can": can, "can_reasons": reasons,
            "go_note": GO_NOTE, "streams": streams, "map": map_info, "check": None,
            "node": {"status": status, "age_s": None if status_mono is None else mono - status_mono,
                     "fresh": fresh, "fixture": self.fixture, "classification": "reported by the node"},
            "pending_command": None if self.pending is None else {"seq": self.pending["seq"], "cmd": self.pending["cmd"],
                                                                  "stage": self.pending["stage"]},
        }

    def _graph(self, streams):
        by_id = {s["id"]: s for s in streams}
        edges = []
        for sid, source, transport in (("odom", "lio_bridge", "ZMQ SUB"), ("cloud", "lio_bridge", "ZMQ SUB"),
                                       ("pose", "node", "ZMQ SUB"), ("g1_debug", "runner", "ZMQ SUB"),
                                       ("node_status", "node", "ZMQ REQ/REP")):
            s = by_id[sid]
            if not s["configured"]:
                continue
            edges.append({"source": source if sid != "node_status" else "studio", "target": "studio" if sid != "node_status" else "node",
                          "transport": transport, "topic": "control: status, goal, stand" if sid == "node_status" else sid,
                          "endpoint": s["endpoint"], "status": s["status"], "observed_rate_hz": s["rate_hz"],
                          "age_ms": None if s["age_s"] is None else s["age_s"] * 1000, "drops": s["dropped"],
                          "qos": None, "publisher_identity": None, "connection_state": s["transport"],
                          "basis": "observed receipts on this host; publisher processes are configured, not discovered"})
        fixture = " · FIXTURE" if self.fixture else ""
        return {"basis": "observed-zmq-receive", "runtime_discovered": False, "runtime_observed": True,
                "nodes": [{"id": "lio_bridge", "label": "LIO bridge (configured)" + fixture, "kind": "estimator"},
                          {"id": "node", "label": "Planner node (configured)" + fixture, "kind": "planner"},
                          {"id": "runner", "label": "SONIC runner (configured)" + fixture, "kind": "controller"},
                          {"id": "studio", "label": "Studio robot link", "kind": "observer",
                           "process_identity": ADAPTER}],
                "edges": edges, "ros2": {"available": False, "reason": "No ROS graph collector ran"},
                "dds_domain": None, "dds_domain_note": "The robot link opens no DDS participant"}

    def _metadata(self, mode):
        limitations = [
            "Pose is the LIO estimate from the bridge's odom (frame odom, floor z = 0, yaw 0 = start heading); "
            "there is no ground truth on a real robot.",
            "Joints are measured values from the SONIC runner's g1_debug while that stream was fresh, otherwise null.",
            "The map is Studio's reconstruction from the LIO cloud (no self filter, no per-slice deskew, no carving "
            "or noise thresholds). The planner does not use it.",
            "Phase, goal, standing and legs come from the node's status, polled at "
            f"{1 / self.limits['status_period_s']:.0f} Hz: transitions are observed up to one poll late.",
            "Studio sent only status, goal and stand to the node. Go stayed with the operator (console g, remote F1).",
            "Stream stamps carry no clock-domain tag; ages are receipt ages on this host, not end-to-end latency.",
        ]
        if self.fixture:
            limitations.insert(0, "Recorded against tools/fake_node.py, a protocol fixture: no robot, planner or physics.")
        return {"id": self.session_id, "title": ("Robot link · protocol fixture" if self.fixture else "Robot link")
                + (f" · {self.cfg['label']}" if self.cfg.get("label") else ""),
                "mode": mode, "kind": "navigation", "robot": "real", "recording_kind": "robot-link",
                "backend_id": "sonic", "source_path": str(self.output),
                "model_path": str(DISPLAY_MODEL) if DISPLAY_MODEL.is_file() else None,
                "model_variant": "G1 29 DoF · display model only (the robot's hand variant is not verified)",
                "duration_s": self.frames[-1]["time"] if self.frames else 0.0, "source_time_origin": 0.0,
                "clock_domain": "host-monotonic (robot link start = 0)", "started_unix_s": self.started_unix,
                "frame_id": "odom", "quaternion_convention": "wxyz",
                "units": {"position": "m", "joint": "rad", "time": "s"},
                "hardware_validated": False, "hardware_enabled": False, "command_path_enabled": "node goal/stand only",
                "node_commands": sorted(NODE_COMMANDS), "go_note": GO_NOTE, "dds_participants": 0,
                "fixture": self.fixture, "endpoints": dict(self.endpoints), "limits": dict(self.limits),
                "policy_identity": None, "calibration_identity": None,
                "frame_conventions": dict(FRAME_LABELS, reference=REFERENCE_LABELS),
                "frame_decimation": {"max_rate_hz": self.limits["frame_rate_hz"], "period_s": self.frame_period,
                                     "thinning_passes": self.frame_thinning,
                                     "snapshot_thinning_passes": self.snapshot_thinning},
                "provenance": {"adapter": ADAPTER,
                               "artifacts": self.artifacts,
                               "publisher_identity": "fixture (node status fixture = true)" if self.fixture
                               else "unknown loopback publishers (configured, not discovered)"},
                "limitations": limitations}

    def _publish(self, status="running"):
        now = self.now()
        nav = self._navigation()
        with self.lock:
            frame = self._frame(now, live=True)
            events = self.events[-50:]
            frames = len(self.frames)
        if now - self.perception_t >= 0.2 or status != "running":
            perception = self._perception(now, int(self.limits["cloud_points"]), int(self.limits["map_points"]))
            self.perception_json = json.dumps(perception, allow_nan=False, separators=(",", ":"))
            self.perception_t = now
        payload = {"schema_version": 1, "status": status, "kind": "navigation", "robot": "real", "frame": frame,
                   "navigation": nav, "metadata": self._metadata("live" if status == "running" else "replay"),
                   "environment": {"boxes": [], "classification": "unavailable",
                                   "note": "No ground-truth geometry on a real robot; the display map is an estimate."},
                   "graph": self._graph(nav["streams"]), "events": events, "joint_names": list(MJ_JOINTS),
                   "errors": list(self.thread_errors),
                   "progress": {"elapsed_s": now, "wall_time_s": now, "simulation_time_s": None, "frames": frames,
                                "clock": "host-monotonic since the link started"}}
        body = json.dumps(payload, allow_nan=False, separators=(",", ":"))
        atomic_write(self.output / "latest.json", body[:-1] + ',"perception":' + self.perception_json + "}")
        self._stream_events(nav["streams"])

    def _stream_events(self, streams):
        for s in streams:
            previous = self.stream_status.get(s["id"])
            if previous != s["status"]:
                self.stream_status[s["id"]] = s["status"]
                if previous is not None or s["status"] != "unavailable":
                    self.event("stream", f"{s['id']} {previous or 'unavailable'} -> {s['status']}", stream=s["id"],
                               status=s["status"], age_s=s["age_s"])

    def _snapshot(self):
        now = self.now()
        p = self._perception(now, 1000, 2000)  # smaller budgets than live: a recording holds hundreds of these
        if not p.get("available"):
            return
        p.pop("filter_stats", None)
        self.snapshots.append(p)
        if len(self.snapshots) >= self.limits["max_snapshots"]:
            self.snapshots = self.snapshots[::2]
            self.snapshot_period *= 2
            self.snapshot_thinning += 1

    # ------------------------------------------------------------------ lifecycle
    def _guard(self, target, name):
        try:
            target()
        except Exception as exc:  # the link stays up; the affected streams go stale and say why
            message = f"{name} thread failed: {type(exc).__name__}: {exc}"
            self.thread_errors.append(message)
            self.event("error", message)

    def run(self):
        import zmq

        self.ctx = zmq.Context()
        if self.cfg.get("capture"):
            self.capture = BoundedRecorder(self.output / "capture.jsonl", queue_size=256,
                                           max_bytes=self.cfg["capture"]["max_bytes"])
            self.capture.submit({"record": "capture_start", "schema_version": 1, "session_id": self.session_id,
                                 "receipt_timestamp": self.t0, "receipt_clock": "collector_host_monotonic",
                                 "receipt_unix": self.started_unix, "endpoints": sorted(set(self.endpoints.values())),
                                 "topics": self.cfg["capture"]["topics"], "mode": "loopback_read_only_telemetry",
                                 "hardware_command_path": False, "dds_participant": False,
                                 "note": "Robot link capture; the link also sent status/goal/stand on the control socket."})
        for target, name in ((self._receive_loop, "link-receive"), (self._map_loop, "link-map"),
                             (self._control_loop, "link-control")):
            thread = threading.Thread(target=self._guard, args=(target, name), name=name, daemon=True)
            thread.start()
            self.threads.append(thread)
        self.event("link_start", "robot link started", endpoints=dict(self.endpoints))
        lim = self.limits
        next_publish = next_map = next_snapshot = 0.0
        error = None
        try:
            while not self.stop_event.is_set():
                now = self.now()
                self._poll_inbox()
                self._advance_pending()
                self._track_phase()
                if now >= next_publish:
                    self._publish()
                    next_publish = now + lim["publish_period_s"]
                if now >= next_map:
                    self._write_map()
                    next_map = now + lim["map_period_s"]
                if now >= next_snapshot:
                    self._snapshot()
                    next_snapshot = now + self.snapshot_period
                if now >= lim["max_duration_s"]:
                    self.request_stop("max_duration")
                self.stop_event.wait(0.02)
        except Exception as exc:  # recorded in result.json; whatever was recorded is still written
            error = f"{type(exc).__name__}: {exc}"
            self.request_stop("error")
        return self.finalize(error)

    def finalize(self, error=None):
        self.stop_event.set()
        for thread in self.threads:
            thread.join(timeout=max(3.0, self.limits["command_timeout_s"] + 1.0))
        if self.pending is not None:
            self._finish(self.pending, "rejected", "the link ended before the node confirmed the command")
        self._track_phase()
        if self.leg_open is not None:
            self._end_leg(self.status if self._status_fresh() else None, self.now(), "link ended during the leg")
        self.ended = True
        self.event("link_end", f"robot link stopped ({self.stopped_by})", stopped_by=self.stopped_by)
        try:
            self._write_map(force=True)
        except OSError as exc:
            error = error or f"memory.npz: {exc}"
        capture_stats = None
        if self.capture is not None:
            self.capture.submit({"record": "capture_end", "receipt_timestamp": time.monotonic(),
                                 "duration_s": self.now(), "stopped_by": self.stopped_by})
            capture_stats = self.capture.close()
        session = self._session()
        complete = bool(session["frames"])
        try:
            atomic_write(self.output / "session.json", self._bounded(session))
        except (OSError, ValueError) as exc:
            error, complete = error or f"session.json: {exc}", False
        try:
            self._publish(status="ended")
        except (OSError, ValueError):
            pass
        if not any(thread.is_alive() for thread in self.threads):
            self.ctx.term()  # a stuck socket thread would block term(); the process exit reclaims it instead
        report = {"stopped_by": self.stopped_by, "duration_s": self.now(), "frames": len(session["frames"]),
                  "snapshots": len(session["perception"].get("frames", [])), "legs": session["navigation"]["legs"],
                  "commands": [e["command"] for e in session["events"] if e["type"] == "command"],
                  "streams": session["navigation"]["streams"], "odom_jumps": self.odom_jumps,
                  "fixture": self.fixture, "capture": capture_stats, "thread_errors": list(self.thread_errors)}
        if not complete and error is None:
            error = "no odometry was received: the recording has no frames to replay"
        result = {"schema_version": 1, "status": "completed" if complete and error is None else "failed",
                  "report": report, "error": error, "recording_complete": complete, "hardware_enabled": False,
                  "dds_participants": 0, "session_path": str(self.output / "session.json"),
                  "wall_time_s": self.now()}
        atomic_json(self.output / "result.json", result)
        return result

    def _session(self):
        nav = self._navigation()
        with self.lock:
            frames = list(self.frames)
            events = sorted(self.events, key=lambda e: e["time"])
        times = [s["time"] for s in self.snapshots]
        for frame in frames:
            k = bisect.bisect_right(times, frame["time"]) - 1
            frame["perception_index"] = k if k >= 0 else None
        last = self.snapshots[-1] if self.snapshots else {"available": False, "reason": "No perception recorded"}
        return {"schema_version": 1, "kind": "navigation", "robot": "real",
                "metadata": dict(self._metadata("replay"), recording_complete=bool(frames),
                                 stopped_by=self.stopped_by, source_samples=nav["streams"][0]["valid"],
                                 incomplete=not frames),
                "joint_names": list(MJ_JOINTS), "frames": frames, "events": events,
                "perception": dict(last, kind="time-series", frames=list(self.snapshots), synchronized=False),
                "environment": {"boxes": [], "classification": "unavailable",
                                "note": "No ground-truth geometry on a real robot; the display map is an estimate."},
                "graph": self._graph(nav["streams"]), "trajectory": [f["position"] for f in frames],
                "navigation": nav}

    def _bounded(self, session):
        body = json.dumps(session, allow_nan=False, separators=(",", ":"))
        while len(body) > MAX_SESSION_BYTES:
            snaps = session["perception"]["frames"]
            if len(snaps) > 10:
                session["perception"]["frames"] = snaps[::2]
                self.snapshot_thinning += 1
                times = [s["time"] for s in session["perception"]["frames"]]
                for frame in session["frames"]:
                    k = bisect.bisect_right(times, frame["time"]) - 1
                    frame["perception_index"] = k if k >= 0 else None
            elif len(session["frames"]) > 100:
                session["frames"] = session["frames"][::2]
                session["trajectory"] = [f["position"] for f in session["frames"]]
                self.frame_thinning += 1
            else:
                raise ValueError("recording exceeds the session size bound")
            session["metadata"]["frame_decimation"].update(thinning_passes=self.frame_thinning,
                                                           snapshot_thinning_passes=self.snapshot_thinning)
            body = json.dumps(session, allow_nan=False, separators=(",", ":"))
        return body


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args(argv)
    args.output.mkdir(parents=True, exist_ok=True)
    try:
        if args.config.stat().st_size > MAX_CONFIG_BYTES:
            raise ConfigError("config exceeds 64 KiB")
        config = load_config(json.loads(args.config.read_text()))
    except (OSError, ValueError) as exc:
        message = f"config refused: {exc}"
        atomic_json(args.output / "result.json", {"schema_version": 1, "status": "failed", "report": None,
                                                  "error": message, "recording_complete": False,
                                                  "hardware_enabled": False, "dds_participants": 0})
        print(json.dumps({"status": "failed", "error": message}), file=sys.stderr)
        return 2
    link = RobotLink(config, args.output)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: link.request_stop("signal"))
    result = link.run()
    print(json.dumps({k: result[k] for k in ("status", "error", "recording_complete", "session_path")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
