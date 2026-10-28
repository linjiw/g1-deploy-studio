#!/usr/bin/env python3
"""A stand-in for the deploy kit's deploy service (`g1 lab --headless`, API v1 + the v3 additions) and its console
panel, for developing and testing Studio's Deploy workspace without the kit, the robot or a GPU. The contract is
docs/DEPLOY.md.

It serves the hub on `--port` (default 8779). Every console serves its own panel, as the kit's consoles do: the robot
slot on `--panel-port` (default 8780), the sim slot (practice, rehearsal runs) on a free port; each session's
panel_url.txt and the hub state's `live.<slot>.panel_port` say which. Studio's E-STOP goes there directly, with the token
from panel_url.txt. The hub relays acts to a console over HTTP, as the kit's hub does (a lost console reply is the
hub's 502 "panel unreachable"). The robot is a kinematic puppet: it stands, walks toward a confirmed goal at 0.4 m/s
once GO passes the console's gates, and stops on E-STOP or Stand. The scene is a synthetic room with two towers 0.69 m
apart, or a real scan's memory.npz + twin.json (`--scan-dir`).

Frames are deliberately not the identity (docs/DEPLOY.md, Frames): the scan's memory frame has the robot at
start_S = [0.3, -0.2, 1.2]; a session's odometry frame starts at the robot with a yaw of 0.9 rad, and the robot stands
0.2 m and 20 degrees off its scan pose (as every walk did on 2026-10-27). A frame bug in Studio shows up here.

Like the kit's service (and unlike the first fake): rehearsal sets and sessions are listed NEWEST FIRST; a POST to the
service answers 200 with `ok: false` and a `reason` when it refuses; a console answers 200 with `result: "refused"`.

v3 (docs/DEPLOY.md, contract v3): session receipts (`live.<slot>.receipt`, GET /api/v1/session/<name>/receipt);
rehearsal sets with identity, state and per-run axes, GET /api/v1/rehearsal/match, passage scoring; act records
(GET /act_result on the panel, GET /api/v1/act/<slot>/<id>); GET /api/v1/session/<name> and POST .../tag (live and
ended); GET /api/v1/profile/<name>/route (profiles deploy, low-margin and near differ); GET .../recording and
manifest v2. `--v1-only` serves the v1 service alone (v3 paths answer 404 "unknown endpoint", as the kit's service
before v3 does).

Fault switches (GET/POST /api/fake/faults?t=TOKEN, JSON; in process: `hub.faults.set(...)`). Counters are the number
of requests to fail (-1: until cleared); `{"reset": true}` clears everything:
  console_drop_reply N     the console applies the next N acts and drops the HTTP reply (the hub answers 502)
  console_drop_acts [..]   ... only these acts (default: any act but estop and the lease renewals)
  hub_drop_reply N         the hub applies the next N POSTs and closes the connection without a reply
  act_delay_s S            the hub holds each POST /api/v1/act and send_goal S seconds before relaying it
  hub_delay_s S            every hub request waits S seconds first (a stalled service)
  hub_down_s S             the hub stops listening for S seconds (connection refused), then comes back
  freeze_panel BOOL        the hub serves the panel state (and state's panel summary) frozen; the console itself runs
  freeze_view BOOL         the hub serves the node view frozen (t_mono stays; served_age_s grows)
  hang_console BOOL|SLOT   the console's panel stops answering (GET /state, /act, /act_result, E-STOP); the hub runs
  manifest_fail N / recording_fail N / track_fail N / session_fail N   503 for the next N requests of that kind
  manifest_mode ok|failing         failing: a required stream partial (gaps), complete false
  recording_mode ok|degraded       degraded: a required stream stalled, low disk, recorder errors
  rehearsal_fail_run exact|drift|offset    that run errors: the set ends "failed"
  rehearsal_stop_after exact|drift         the set stops after that run: "partial"
POST /api/fake/rehearsals {preset: "f02", scan?, goal_scene?, profile?, odom?} seeds rehearsal sets for Astra's F02
cases (older pass, newer failure, rerun in progress, other odometry, changed profile contents, other start, missing
identity field). POST /api/fake/profile {name, params} changes a profile's contents (its sha changes, its name not).

Nothing here talks to a robot, DDS or ZMQ.

usage: .venv/bin/python tools/fake_deploy_hub.py [--port 8779] [--panel-port 8780] [--token T] [--scan-dir DIR]
                                                 [--studio-data DIR] [--v1-only] [--practice-only]

Tests start it in-process: `hub, server = start(["--port", "0", "--panel-port", "0"])`; `server.shutdown()` stops the
hub while the consoles' panels keep serving (the E-STOP path never needs the hub). `FakeConsole.panel_delay_s` makes a
panel answer slowly.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import http.client
import json
import math
import re
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import numpy as np

JOINT_NAMES = (
    [f"{side}_{name}_joint" for side in ("left", "right")
     for name in ("hip_pitch", "hip_roll", "hip_yaw", "knee", "ankle_pitch", "ankle_roll")]
    + [f"waist_{name}_joint" for name in ("yaw", "roll", "pitch")]
    + [f"{side}_{name}_joint" for side in ("left", "right")
       for name in ("shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow", "wrist_roll", "wrist_pitch", "wrist_yaw")])
STAND = np.zeros(29)
STAND[[0, 6]] = -0.312   # hip pitch
STAND[[3, 9]] = 0.669    # knee
STAND[[4, 10]] = -0.363  # ankle pitch
STAND[[18, 25]] = 0.6    # elbows
STAND[16], STAND[23] = 0.2, -0.2  # shoulder roll
PELVIS_Z = 0.78
START_S = (0.3, -0.2, 1.2)            # where the robot stood in the scan's memory frame
ODOM_START_YAW = 0.9                  # a session's odometry frame: origin at the robot, IMU yaw
OFFSET_SCENE = (0.19, -0.07, math.radians(-20.0))  # the robot now vs its scan pose (scene frame)
MOUNT = {"pos_torso": [0.0465, 0.0, 0.4005], "rot_torso": [[0.97, 0.0, 0.24], [0.0, 1.0, 0.0], [-0.24, 0.0, 0.97]]}
TRUTH_ARRIVE_M = 0.5                  # the kit's hub: a rehearsal run arrived on the simulator's truth within this
MATCH_GOAL_M = 0.08                   # rehearsal/match: the set's goal within this of the asked goal
RUN_KINDS = ("exact", "drift", "offset")
STARTS = {"exact": [0.0, 0.0, 0.0], "drift": [0.0, 0.0, 0.0], "offset": [round(v, 4) for v in OFFSET_SCENE]}
DRIFT_MODEL = "lab-g1-leg"
CONSOLE_FORMAT = "g1deploy.recording.v1"
V1_CAPABILITIES = ["state", "readiness", "sessions", "scan", "scan_live", "scan_scene", "practice", "start", "stop",
                   "start_check", "send_goal", "rehearse", "track", "live_view", "act", "panel_state", "manifest",
                   "doctor", "confirm"]
V3_CAPABILITIES = ["session_receipt", "rehearsal_match", "rehearsal_identity", "passage", "act_status",
                   "session_detail", "session_tag", "profile_route", "recording_health", "manifest_v2"]
BUNDLE_MANIFEST_SHA = hashlib.sha256(b"fake bundle MANIFEST.json").hexdigest()
ROBOT_STREAMS = ["lowstate", "lowcmd", "lidar_raw", "node_status", "node_events", "plans", "console_events", "attempts"]
LIO_STREAMS = ["lio_odom", "lio_cloud"]
OPTIONAL_STREAMS = ["video", "runner_log", "report"]
EXPECTED_HZ = {"lowstate": 500.0, "lowcmd": 50.0, "lidar_raw": 10.0, "node_status": 5.0, "node_events": None,
               "plans": 5.0, "console_events": None, "attempts": None, "lio_odom": 10.0, "lio_cloud": 10.0,
               "sim_truth": 50.0, "runner_log": None, "video": None, "report": None}
PROFILES = {  # route configuration: what the kit's planner node uses for this profile (contract v3 F)
    "deploy": {"label": "Deploy default", "featured": True, "note": "the baseline",
               "params": {"robot_radius_m": 0.30, "route_margin_m": 0.30, "step_over_m": 0.25, "ceiling_below_m": 1.35,
                          "ceiling_near_m": 0.8, "grow_unknown_m": 0.1, "goal_lookahead_m": 1.0, "guards": "deploy"},
               "basis": "profile"},
    "low-margin": {"label": "Low route margin", "featured": True, "note": "route keep-out 0.25 m (deploy 0.30)",
                   "params": {"robot_radius_m": 0.30, "route_margin_m": 0.25, "step_over_m": 0.25,
                              "ceiling_below_m": 1.35, "ceiling_near_m": 0.8, "grow_unknown_m": 0.1,
                              "goal_lookahead_m": 1.0, "guards": "deploy"},
                   "basis": "profile"},
    "near": {"label": "Keeps its distance", "featured": True, "note": "never through gaps",
             "params": {"robot_radius_m": 0.30, "route_margin_m": 0.45, "step_over_m": 0.25, "ceiling_below_m": 1.35,
                        "ceiling_near_m": 0.8, "grow_unknown_m": 0.1, "goal_lookahead_m": None, "guards": None},
             "basis": "bundle default"},
}
DROP = object()  # a handler's answer: close the connection without a reply


# ---------------------------------------------------------------------------------------------- poses
def compose(a, b):
    """a ∘ b for poses [x, y, yaw]: p_A = a ∘ (b ∘ p)."""
    c, s = math.cos(a[2]), math.sin(a[2])
    return [a[0] + c * b[0] - s * b[1], a[1] + s * b[0] + c * b[1], a[2] + b[2]]


def inverse(a):
    c, s = math.cos(a[2]), math.sin(a[2])
    return [-(c * a[0] + s * a[1]), -(-s * a[0] + c * a[1]), -a[2]]


def apply(a, xy):
    xy = np.asarray(xy, dtype=float)
    c, s = math.cos(a[2]), math.sin(a[2])
    return np.stack([a[0] + c * xy[..., 0] - s * xy[..., 1], a[1] + s * xy[..., 0] + c * xy[..., 1]], -1)


def box_in(frame_from_scene, b):
    """A box (scene frame) in another frame."""
    c = apply(frame_from_scene, b["center_xy"]).tolist()
    return dict(b, center_xy=c, yaw=b["yaw"] + frame_from_scene[2])


def quat_yaw(yaw):
    return [math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)]


def crosses(walk_xy, a, b):
    """Whether a polyline crosses the segment a-b (the operator's passage)."""
    a, b = np.asarray(a, float), np.asarray(b, float)

    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    pts = np.asarray(walk_xy, float).reshape(-1, 2)
    for p, q in zip(pts[:-1], pts[1:]):
        d1, d2 = side(a, b, p), side(a, b, q)
        d3, d4 = side(p, q, a), side(p, q, b)
        if d1 * d2 <= 0 and d3 * d4 <= 0 and (d1 != 0 or d2 != 0):
            return True
    return False


def profile_sha(name):
    p = PROFILES[name]
    return hashlib.sha256(json.dumps({"name": name, "params": p["params"], "bundle": BUNDLE_MANIFEST_SHA, "rules": None},
                                     sort_keys=True).encode()).hexdigest()


def studio_id(day: Path, session_name: str) -> str:
    """Deploy Studio's Replay id of a console session linked one level down (as the kit's hub.studio_id)."""
    return "robot-" + re.sub(r"[^a-zA-Z0-9_-]", "-", f"{day.name}-{session_name}")[:60]


# ---------------------------------------------------------------------------------------------- encodings
def enc_points(xyz, origin):
    """int16 centimetres relative to origin, little-endian, base64."""
    a = np.asarray(xyz, dtype=np.float64) - np.asarray(origin, dtype=np.float64)
    a = a[np.isfinite(a).all(axis=1)]
    a = np.clip(np.round(a * 100.0), -32767, 32767).astype("<i2")
    return base64.b64encode(a.tobytes()).decode()


def enc_u8(a):
    return base64.b64encode(np.asarray(a, dtype=np.uint8).tobytes()).decode()


def memory_block(seq, epoch, support, ceiling, lo, res):
    """§2 memory: support 255 never seen, else round(min(h, 5.08)/0.02); ceiling 255 no overhead return."""
    s = np.asarray(support, dtype=float)
    sup = np.full(s.shape, 255, dtype=np.uint8)
    seen = np.isfinite(s)
    sup[seen] = np.round(np.minimum(np.maximum(s[seen], 0.0), 5.08) / 0.02).astype(np.uint8)
    c = np.asarray(ceiling, dtype=float)
    ceil = np.full(c.shape, 255, dtype=np.uint8)
    fin = np.isfinite(c)
    ceil[fin] = np.round(np.minimum(np.maximum(c[fin], 0.0), 5.08) / 0.02).astype(np.uint8)
    return {"seq": seq, "epoch": epoch, "lo": [float(lo[0]), float(lo[1])], "res": float(res), "n": list(s.shape),
            "order": "C, first index x", "support_b64": enc_u8(sup), "ceiling_b64": enc_u8(ceil),
            "near_b64": enc_u8(np.zeros(s.shape, dtype=np.uint8))}


def rasterize(boxes, center, res=0.05, half=6.0, seen_r=4.0, behind=-1.0, frame_from_scene=(0.0, 0.0, 0.0),
              robot_scene=(0.0, 0.0, 0.0)):
    """A memory grid in some frame: boxes (scene) drawn into cells centred at lo + (i, j) res, first index x.
    Seen: within seen_r of the robot and not far behind it (the lidar looks ahead)."""
    n = int(round(2 * half / res)) + 1
    lo = np.array([center[0] - half, center[1] - half])
    ii, jj = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    xy = np.stack([lo[0] + ii * res, lo[1] + jj * res], -1)
    scene_from_frame = inverse(list(frame_from_scene))
    p = apply(scene_from_frame, xy)  # cell centres in scene
    rx, ry, ryaw = robot_scene
    d = p - [rx, ry]
    ahead = d[..., 0] * math.cos(ryaw) + d[..., 1] * math.sin(ryaw)
    seen = (np.hypot(d[..., 0], d[..., 1]) < seen_r) & (ahead > behind)
    support = np.where(seen, 0.0, np.nan)
    ceiling = np.full((n, n), np.nan)
    for b in boxes:
        c, s = math.cos(b["yaw"]), math.sin(b["yaw"])
        dx, dy = p[..., 0] - b["center_xy"][0], p[..., 1] - b["center_xy"][1]
        inside = (np.abs(c * dx + s * dy) <= b["half_xy"][0]) & (np.abs(-s * dx + c * dy) <= b["half_xy"][1]) & seen
        if b["z_bottom"] > 0.5:
            ceiling[inside] = np.fmin(np.nan_to_num(ceiling[inside], nan=np.inf), b["z_bottom"])
        else:
            support[inside] = np.fmax(support[inside], b["z_top"])
    return support, ceiling, lo, res


# ---------------------------------------------------------------------------------------------- fault switches
class Faults:
    """The fake's fault switches (module docstring). Counters: > 0 fail that many more requests, -1 until cleared."""
    DEFAULTS = {"console_drop_reply": 0, "console_drop_acts": None, "hub_drop_reply": 0, "act_delay_s": 0.0,
                "hub_delay_s": 0.0, "hub_down_s": 0.0, "freeze_panel": False, "freeze_view": False,
                "hang_console": False, "manifest_fail": 0, "recording_fail": 0, "track_fail": 0, "session_fail": 0,
                "manifest_mode": "ok", "recording_mode": "ok", "rehearsal_fail_run": None,
                "rehearsal_stop_after": None}

    def __init__(self):
        self.lock = threading.Lock()
        self.v = dict(self.DEFAULTS)

    def set(self, **kw):
        with self.lock:
            if kw.pop("reset", False):
                self.v = dict(self.DEFAULTS)
            unknown = [k for k in kw if k not in self.DEFAULTS]
            if unknown:
                raise KeyError(", ".join(unknown))
            self.v.update(kw)
            return dict(self.v)

    def get(self, key):
        with self.lock:
            return self.v[key]

    def take(self, key):
        """One failure of counter `key` if it is armed (decrements it)."""
        with self.lock:
            n = self.v[key]
            if not n:
                return False
            if n > 0:
                self.v[key] = n - 1
            return True

    def snapshot(self):
        with self.lock:
            return dict(self.v)


# ---------------------------------------------------------------------------------------------- the world
class World:
    """Boxes in the scene frame (the scan robot frame), and the scan's memory in memory_S."""

    def __init__(self, scan_dir=None):
        self.memory_file = None
        if scan_dir:
            d = Path(scan_dir)
            m = np.load(d / "memory.npz", allow_pickle=True)
            self.support, self.ceiling = m["support"].astype(float), m["ceiling"].astype(float)
            self.lo, self.res = np.asarray(m["lo"], dtype=float), float(m["res"])
            self.start_S = [float(m["start_xy"][0]), float(m["start_xy"][1]), float(m["start_yaw"])]
            twin = json.loads((d / "twin.json").read_text())["boxes"]
            scene_from_memory = inverse(self.start_S)
            self.boxes = [box_in(scene_from_memory, b) for b in twin]  # scene
            self.name = d.name
            self.memory_file = str(d / "memory.npz")
        else:
            self.name = "scan-fake"
            self.start_S = list(START_S)
            gap = 0.69
            self.boxes = [  # scene frame: x ahead of the robot at scan time
                {"center_xy": [2.0, gap / 2 + 0.25], "half_xy": [0.25, 0.25], "yaw": 0.0, "z_bottom": 0.0, "z_top": 1.6},
                {"center_xy": [2.0, -gap / 2 - 0.25], "half_xy": [0.25, 0.25], "yaw": 0.0, "z_bottom": 0.0, "z_top": 1.6},
                {"center_xy": [1.2, 1.6], "half_xy": [0.4, 0.3], "yaw": 0.3, "z_bottom": 0.0, "z_top": 0.75},
                {"center_xy": [3.6, 0.0], "half_xy": [0.08, 2.5], "yaw": 0.0, "z_bottom": 0.0, "z_top": 2.2},
                {"center_xy": [0.8, -1.4], "half_xy": [0.3, 0.3], "yaw": 0.0, "z_bottom": 0.0, "z_top": 0.18},
                {"center_xy": [2.8, -1.4], "half_xy": [0.4, 0.5], "yaw": 0.0, "z_bottom": 1.1, "z_top": 1.2},
            ]
            memory_from_scene = self.start_S
            self.support, self.ceiling, self.lo, self.res = rasterize(
                self.boxes, self.start_S[:2], frame_from_scene=memory_from_scene, robot_scene=(0.0, 0.0, 0.0))
            tmp = Path(tempfile.mkdtemp(prefix="fake-scan-"))
            np.savez(tmp / "memory.npz", support=self.support, ceiling=self.ceiling, lo=self.lo, res=self.res,
                     boxes=json.dumps([box_in(memory_from_scene, b) for b in self.boxes]), stats="{}",
                     start_xy=np.array(self.start_S[:2]), start_yaw=self.start_S[2])
            self.memory_file = str(tmp / "memory.npz")
        self.scene_from_memory = inverse(self.start_S)
        # sha256 of the memory file's bytes: the receipts' scan.memory_sha (Studio's goal check hashes the same bytes)
        self.memory_sha = hashlib.sha256(Path(self.memory_file).read_bytes()).hexdigest()

    def twin_memory(self):
        return [box_in(self.start_S, b) for b in self.boxes]

    def cloud(self, rng, robot_scene, k=2500):
        """A lidar-like frame in the scene frame, with classes: 0 fused, 1 self-filtered (arms), 2 rear-blind (a rope)."""
        pts = []
        for b in self.boxes:
            m = max(20, int(400 * b["half_xy"][0] * b["half_xy"][1] * 4))
            u = rng.uniform(-1, 1, (m, 2)) * b["half_xy"]
            c, s = math.cos(b["yaw"]), math.sin(b["yaw"])
            pts.append(np.c_[b["center_xy"][0] + c * u[:, 0] - s * u[:, 1], b["center_xy"][1] + s * u[:, 0] + c * u[:, 1],
                             rng.uniform(b["z_bottom"], b["z_top"], m)])
        rx, ry, ryaw = robot_scene
        r, a = rng.uniform(0.3, 4.0, k // 2), rng.uniform(-math.pi / 2, math.pi / 2, k // 2) + ryaw
        pts.append(np.c_[rx + r * np.cos(a), ry + r * np.sin(a), rng.normal(0, 0.01, k // 2)])
        p = np.vstack(pts)
        p = p[rng.choice(len(p), min(k, len(p)), replace=False)]
        cls = np.zeros(len(p), dtype=np.uint8)
        arms = np.c_[rx + rng.normal(0.1, 0.05, 60), ry + rng.choice([-0.25, 0.25], 60), rng.uniform(0.7, 1.0, 60)]
        h = np.linspace(0.3, 1.5, 80)  # a rope from the back hook up to a spotter's hand behind the robot
        back = np.c_[rx - (0.15 + 0.5 * (h - 0.3)) * math.cos(ryaw), ry - (0.15 + 0.5 * (h - 0.3)) * math.sin(ryaw), h]
        return np.vstack([p, arms, back]), np.concatenate([cls, np.ones(60, np.uint8), np.full(80, 2, np.uint8)])


# ---------------------------------------------------------------------------------------------- one console
class FakeConsole:
    """A console session: gates, acts with ids and their records, a kinematic robot in its odometry frame, its node
    view, attempts, a small recording (rec/meta.json, lowstate, node status) that Studio's Replay can open."""

    def __init__(self, hub, slot, world, start_scene=(0.0, 0.0, 0.0), odom_start_yaw=ODOM_START_YAW, profile="deploy",
                 odom="fused", practice=False, scripted_goal_scene=None, drift_deg=None, name=None, operator=None,
                 confirm=None, scan=None, rehearsal=None):
        self.hub, self.slot, self.world = hub, slot, world
        self.t0 = time.monotonic()
        self.started_wall = time.time()
        self.lock = threading.Lock()
        self.runner, self.phase = "not started", None
        self.armed_t = self.control_t = self.cleared_t = None
        self.goal_t = None
        self.robot_scene = list(start_scene)  # the truth
        # odom frame: the robot starts at [0, 0, odom_start_yaw] in it
        self.odom_from_scene = compose([0.0, 0.0, odom_start_yaw], inverse(list(start_scene)))
        self.goal_odom, self.goal_seq = None, 0
        self.goal_meta = {}
        self.walk_scene, self.events, self.attempts, self.contacts, self.acts = [], [], [], [], []
        self.seen_ids = {}
        self.act_records = OrderedDict()  # id -> {known, id, act, result, reason, t_mono} (GET /act_result)
        self.cloud_seq, self.mem_seq, self.epoch = 0, 0, 0
        self.rng = np.random.default_rng(1 if slot == "robot" else 2)
        self.profile, self.odom, self.practice, self.drift_deg = profile, odom, practice, drift_deg
        self.kind = "rehearsal" if scripted_goal_scene is not None else "practice" if practice else \
            "robot" if slot == "robot" else "practice"
        self.lease = None
        self.ended = False
        self.ended_wall = None
        self.name = name or f"{'robot' if slot == 'robot' and not practice else 'practice' if practice else 'rehearse'}-" \
                            f"{time.strftime('%H%M%S')}-{profile}"
        self.dir = Path(hub.day) / self.name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.receipt = hub.make_receipt(self, operator=operator, confirm=confirm, scan=scan,
                                        start_offset=list(start_scene) if practice else None)
        self.rehearsal = rehearsal
        self.write_session_files()
        self.panel_delay_s = 0.0
        self.samples = []  # (t_mono, joints, yaw, x, y) at 20 Hz for the recording
        self.panel = panel_server(self, hub.args.panel_port if slot == "robot" else 0, hub.args.token)
        self.panel_port = self.panel.server_address[1]
        (self.dir / "panel_url.txt").write_text(f"http://127.0.0.1:{self.panel_port}/?t={hub.args.token}\n")
        self.script = scripted_goal_scene
        self.memory_cache = None
        threading.Thread(target=self.loop, daemon=True).start()

    def t(self):
        return time.monotonic() - self.t0

    def event(self, text, kind="console"):
        self.events.append({"t": round(self.t(), 2), "kind": kind, "text": text})
        self.events = self.events[-200:]

    def pose_odom(self):
        return compose(self.odom_from_scene, self.robot_scene)

    def write_session_files(self):
        info = {"mode": "robot" if self.kind == "robot" else "sim", "practice": self.practice, "kind": self.kind,
                "profile": {"name": self.profile, "sha256": self.receipt["profile"]["sha"]}, "odom": self.odom,
                "operator": self.receipt.get("operator"), "confirm": self.receipt.get("confirmations"),
                "started": self.started_wall, "receipt": self.receipt}
        (self.dir / "session.json").write_text(json.dumps(info))
        rec = self.dir / "rec"
        rec.mkdir(exist_ok=True)
        (rec / "meta.json").write_text(json.dumps({"format": CONSOLE_FORMAT, "session": self.name, "fake": True,
                                                   "started": self.started_wall}))

    # -- acts (the console's gates)
    def record(self, aid, act, result, reason):
        self.act_records[aid] = {"known": True, "id": aid, "act": act, "result": result, "reason": reason,
                                 "t_mono": round(time.monotonic(), 3), "session": self.name}
        while len(self.act_records) > 500:
            self.act_records.popitem(last=False)

    def act_result(self, aid):
        rec = self.act_records.get(aid)
        return dict(rec) if rec else {"known": False, "id": aid, "act": None, "result": None,
                                      "reason": "this console has no act with that id", "t_mono": None,
                                      "session": self.name}

    def act(self, msg, source="panel"):
        act = msg.get("act")
        if act == "estop":
            with self.lock:
                self.runner, self.phase = "E-STOP", "STOPPED" if self.phase else None
                self._close("estop")
            self.event(f"{source}: E-STOP", "estop")
            if msg.get("id"):
                self.record(msg["id"], "estop", "done", "")
            return {"ok": True, "key_sent": True, "runner_alive": True, "runner": "E-STOP", "confirmed": True,
                    "t_mono": round(self.t(), 3), "session": self.name}
        aid = msg.get("id") or str(uuid.uuid4())
        if aid in self.seen_ids and act != "lease":
            return dict(self.seen_ids[aid], repeat=True)
        with self.lock:
            expect = msg.get("expect") or {}
            mismatch = [k for k, v in expect.items() if self._state_field(k) != v]
            if mismatch:
                ok, reason = False, f"the console's state changed ({', '.join(mismatch)}): look again"
            else:
                ok, reason = self._act(act, msg, source)
        out = {"ok": ok, "id": aid, "act": act, "result": "done" if ok else "refused", "reason": reason,
               "session": self.name}
        self.seen_ids[aid] = out
        self.record(aid, act, out["result"], reason)
        self.acts = (self.acts + [dict(out, source=source, t=round(self.t(), 2))])[-20:]
        self.event(f"{source}: {act} {'ok' if ok else 'refused: ' + reason}", "act")
        return out

    def _state_field(self, k):
        return {"session": self.name, "runner": self.runner, "phase": self.phase, "goal_seq": self.goal_seq,
                "attempts": len(self.attempts)}.get(k)

    def cycle_start(self):
        ends = [a["t_end"] for a in self.attempts if a.get("t_end") is not None]
        return max([x for x in (self.control_t, self.cleared_t, max(ends) if ends else None) if x is not None], default=0.0)

    def go_locks(self, source="studio"):
        locks = []
        if self.runner == "E-STOP":
            return ["E-STOP is active: end the session"]
        if self.runner != "CONTROL":
            locks.append("SONIC is not in CONTROL (Start SONIC)")
        elif self.t() - self.control_t < 2.0:
            locks.append(f"settling after CONTROL ({2.0 - (self.t() - self.control_t):.1f} s)")
        if self.phase not in ("WAIT", "ARRIVED", "STOPPED"):
            locks.append("the robot is not standing ready" if self.phase else "the planner node is not up (Arm)")
        if self.cleared_t is not None and self.t() - self.cleared_t < 10.0:
            locks.append(f"the map is rescanning after Clear map ({10.0 - (self.t() - self.cleared_t):.0f} s)")
        if self.goal_t is None or self.goal_t < self.cycle_start():
            locks.append("no goal confirmed since the last Start SONIC / Clear map / walk (Send goal)")
        if self.slot == "robot" and self.hub.live("sim") is not None and not self.hub.live("sim").practice:
            locks.append("a rehearsal is running")
        if source == "panel" and self.lease and self.lease["until"] > time.time():
            locks.append(f"Studio holds the operator lease ({self.lease['holder']})")
        return locks

    def _act(self, act, msg, source):
        if self.runner == "E-STOP" and act not in ("tag", "note", "lease"):
            return False, "E-STOP is active: end the session"
        if act == "arm":
            if self.armed_t is not None:
                return False, "already armed"
            self.armed_t, self.runner, self.phase = self.t(), "INIT done", "BOOT"
            return True, ""
        if act == "s":
            if self.armed_t is None:
                return False, "Arm first"
            if self.phase == "BOOT":
                return False, "the planner node is still starting"
            self.runner, self.control_t = "CONTROL", self.t()
            return True, ""
        if act == "c":
            if self.phase is None:
                return False, "the planner node is not up (Arm)"
            if self.phase in ("PRESCAN", "RUN"):
                return False, "the robot is walking"
            self.cleared_t, self.epoch = self.t(), self.epoch + 1
            self.event("map cleared: 10 s scan", "node")
            return True, ""
        if act == "goal_odom":
            if self.phase not in ("WAIT", "ARRIVED", "STOPPED"):
                return False, "goals are taken while the robot stands ready"
            self.goal_odom = np.array([float(msg["x"]), float(msg["y"])])
            self.goal_seq, self.goal_t = int(msg.get("seq", self.goal_seq + 1)), self.t()
            self.check_id = msg.get("check_id")
            # what the operator saw, kept with the attempt (the kit's send_goal adds these to the act)
            self.goal_meta = {k: msg.get(k) for k in ("scan", "goal_scene", "start_check", "rehearsal", "passage",
                                                      "goal_check")}
            self.event(f"goal confirmed ({self.goal_odom[0]:.2f}, {self.goal_odom[1]:.2f}) odom", "node")
            return True, ""
        if act == "g":
            locks = self.go_locks(source)
            if locks:
                return False, locks[0]
            self.phase = "PRESCAN"
            meta = self.goal_meta or {}
            self.attempts.append({"n": len(self.attempts) + 1, "t_go": round(self.t(), 2),
                                  "goal_odom": self.goal_odom.tolist(), "start_odom": self.pose_odom(),
                                  "start_scene": [round(v, 4) for v in self.robot_scene],
                                  "outcome": None, "result": None, "tag": None, "note": None, "tag_history": [],
                                  "check_id": getattr(self, "check_id", None),
                                  "start_check": meta.get("start_check") or self.hub.last_check.get(self.slot),
                                  "rehearsal": meta.get("rehearsal") or self.hub.rehearsal_for_goal(self),
                                  "scan": meta.get("scan"), "goal_scene": meta.get("goal_scene"),
                                  "passage_ab": meta.get("passage"), "passage": None,
                                  "profile": self.profile, "odom": self.odom, "walk_from": len(self.walk_scene)})
            self.event("GO", "node")
            return True, ""
        if act in ("h", "t"):
            if self.phase in ("PRESCAN", "RUN"):
                self.phase = "STOPPED"
                self._close("stopped" if act == "h" else "takeover")
            return True, ""
        if act == "lease":
            self.lease = {"holder": msg.get("holder"), "until": float(msg.get("until", 0))}
            return True, ""
        if act == "tag":
            n = int(msg.get("n", 0))
            for a in self.attempts:
                if a["n"] == n:
                    a["tag"], a["note"] = msg.get("tag"), msg.get("note")
                    a["tag_history"].append({"tag": msg.get("tag"), "note": msg.get("note"),
                                             "operator": msg.get("operator"), "wall": round(time.time(), 3),
                                             "via": "console"})
                    return True, ""
            return False, f"no attempt {n}"
        if act == "note":
            return True, ""
        return False, f"unknown act {act}"

    def _close(self, outcome):
        if self.attempts and self.attempts[-1]["outcome"] is None:
            a = self.attempts[-1]
            dist = round(float(np.hypot(*(self.goal_odom - self.pose_odom()[:2]))), 2)
            walk = [p[:2] for p in self.walk_scene[a.get("walk_from", 0):]]
            passage = None
            if a.get("passage_ab"):
                passage = "crossed" if len(walk) > 1 and crosses(walk, a["passage_ab"]["a"], a["passage_ab"]["b"]) \
                    else "missed"
            # the console's own field names (g1deploy/attempts.py: result, end_goal_dist_m) beside the older ones
            a.update(outcome=outcome, result=outcome, t_end=round(self.t(), 2), end_odom=self.pose_odom(),
                     final_dist_m=dist, end_goal_dist_m=dist, passage=passage)

    def end(self):
        """The session ends (stop, the hub's end, or a rehearsal run's arrival): its recording is finalized."""
        if not self.ended:
            self.ended = True
            self.ended_wall = time.time()

    # -- the robot
    def loop(self):
        last = time.monotonic()
        k = 0
        while not self.ended:
            time.sleep(0.02)
            now = time.monotonic()
            dt, last = now - last, now
            with self.lock:
                self.step(dt)
                k += 1
                if k % 2 == 0 and len(self.samples) < 40000:
                    self.samples.append((now, self.joints(), *self.robot_scene))
        self.ended_wall = self.ended_wall or time.time()
        self.write_recording()
        self.panel.shutdown()  # an ended console's panel goes away with it
        self.panel.server_close()

    def write_recording(self):
        """rec/lowstate/000000.npz and rec/node_status.jsonl (scene poses), console_summary.json: enough for Studio's
        Replay to open the session."""
        try:
            rec = self.dir / "rec"
            (rec / "lowstate").mkdir(parents=True, exist_ok=True)
            s = self.samples or [(time.monotonic(), self.joints(), *self.robot_scene)]
            if len(s) < 2:
                s = s + [(s[0][0] + 0.05, s[0][1], *s[0][2:])]
            t = np.array([r[0] for r in s])
            q = np.array([r[1] for r in s])
            imu = np.array([quat_yaw(r[4]) for r in s])
            np.savez(rec / "lowstate" / "000000.npz", t=t, q=q, imu_quat=imu)
            with (rec / "node_status.jsonl").open("w") as f:
                for r in s[::10]:
                    f.write(json.dumps({"t": r[0], "status": {"xy": [r[2], r[3]], "pelvis_z_m": PELVIS_Z,
                                                              "yaw_rad": r[4], "phase": None}}) + "\n")
            (self.dir / "console_summary.json").write_text(json.dumps({"ended": self.ended_wall,
                                                                       "attempts": len(self.attempts)}))
        except OSError:
            pass

    def step(self, dt):
        if self.phase == "BOOT" and self.t() - self.armed_t > 3.0:
            self.phase = "WAIT"
            self.event("node up: waiting for GO", "node")
            if self.script is not None:  # a scripted rehearsal runs its own ladder
                self.runner, self.control_t = "CONTROL", self.t() - 2.5
                self.goal_odom = apply(self.odom_from_scene, self.script)
                self.goal_t = self.t()
                if self.rehearsal and self.rehearsal.get("passage"):
                    self.goal_meta = {"passage": self.rehearsal["passage"], "goal_scene": list(self.script)}
        if self.script is not None and self.phase == "WAIT" and not self.attempts and self.runner == "CONTROL":
            self._act("g", {}, "script")
        if self.phase == "PRESCAN" and self.attempts and self.t() - self.attempts[-1]["t_go"] > 1.0:
            self.phase = "RUN"
        if self.phase == "RUN":
            goal_scene = apply(inverse(self.odom_from_scene), self.goal_odom)
            d = goal_scene - self.robot_scene[:2]
            dist = float(np.hypot(*d))
            if dist < 0.25:
                self.phase = "ARRIVED"
                self.event(f"arrived ({dist:.2f} m)", "node")
                self._close("arrived")
                if self.script is not None:
                    self.end()
                return
            want = math.atan2(d[1], d[0]) + (math.radians(self.drift_deg) if self.drift_deg else 0.0)
            err = (want - self.robot_scene[2] + math.pi) % (2 * math.pi) - math.pi
            self.robot_scene[2] += max(-dt, min(dt, err))
            v = 0.4 if abs(err) < 0.6 else 0.1
            self.robot_scene[0] += v * dt * math.cos(self.robot_scene[2])
            self.robot_scene[1] += v * dt * math.sin(self.robot_scene[2])
            self.walk_scene.append([round(v_, 4) for v_ in self.robot_scene])
            for b in self.world.boxes:
                if b["z_bottom"] > 0.5:
                    continue
                c, s = math.cos(b["yaw"]), math.sin(b["yaw"])
                dx, dy = self.robot_scene[0] - b["center_xy"][0], self.robot_scene[1] - b["center_xy"][1]
                if abs(c * dx + s * dy) < b["half_xy"][0] + 0.2 and abs(-s * dx + c * dy) < b["half_xy"][1] + 0.2:
                    self.contacts.append({"t": round(self.t(), 2), "root_xy": self.robot_scene[:2], "n": 60.0})
                    break

    def joints(self):
        j = STAND.copy()
        if self.phase == "RUN":
            ph = 2 * math.pi * 1.6 * self.t()
            j[[0, 6]] += 0.35 * np.array([math.sin(ph), -math.sin(ph)])
            j[[3, 9]] += 0.3 * np.array([max(0, math.sin(ph)), max(0, -math.sin(ph))])
            j[[15, 22]] = 0.25 * np.array([-math.sin(ph), math.sin(ph)])
        return j

    def qpos_in(self, pose):
        return [round(float(v), 4) for v in [pose[0], pose[1], PELVIS_Z, *quat_yaw(pose[2]), *self.joints()]]

    def view(self, cloud_after=-1, mem_after=-1, max_points=4000):
        with self.lock:
            if self.phase is None:
                return {"ok": False, "error": "the student node is not up yet (it starts on Arm)"}
            po = self.pose_odom()
            goal = self.goal_odom.tolist() if self.goal_odom is not None else None
            out = {"ok": True, "t_mono": round(self.t0 + self.t(), 3), "phase": self.phase, "frame": "odom",
                   "joint_names": JOINT_NAMES, "mount": MOUNT, "qpos": self.qpos_in(po), "state_age_s": 0.004,
                   "pose_hist": [[round(self.t0 + self.t() - 0.05 * k, 3), po[0], po[1], po[2]] for k in range(10)][::-1],
                   "goal": goal, "goal_seq": self.goal_seq,
                   "goal_dist_m": round(float(np.hypot(*(self.goal_odom - po[:2]))), 3) if goal else None,
                   "standing": self.phase not in ("RUN", "PRESCAN"), "tilt_rad": 0.03, "latency_s": 0.21,
                   "odom": {"mode": self.odom, "lio_age_s": 0.06 if self.odom in ("fused", "zmq") else None,
                            "doubt": False, "lost": None, "watchdog": None},
                   "rear_blind_deg": 180.0, "rear_blind_range_m": 1.0, "session": self.name}
            if goal is not None:
                route = np.linspace(po[:2], self.goal_odom, 12)
                out["route"] = np.round(route, 3).tolist()
                if self.phase in ("PRESCAN", "RUN"):
                    d = self.goal_odom - po[:2]
                    u = d / max(1e-6, float(np.hypot(*d)))
                    frames = [self.qpos_in([po[0] + u[0] * min(dt * 0.4, float(np.hypot(*d))),
                                            po[1] + u[1] * min(dt * 0.4, float(np.hypot(*d))), math.atan2(u[1], u[0])])
                              for dt in (0.4, 0.9)]
                    out["plan"] = {"seq": len(self.walk_scene) // 25, "frames": frames,
                                   "path": [[round(po[0] + u[0] * k * 0.1, 3), round(po[1] + u[1] * k * 0.1, 3)]
                                            for k in range(0, 11)]}
                else:
                    out["plan"] = None
            else:
                out["route"], out["plan"] = None, None
            self.cloud_seq += 1
            if self.cloud_seq > cloud_after:
                pts_scene, cls = self.world.cloud(self.rng, self.robot_scene, min(max_points, 3000))
                pts = np.c_[apply(self.odom_from_scene, pts_scene[:, :2]), pts_scene[:, 2]]
                origin = [round(po[0], 3), round(po[1], 3), 1.2]
                out["cloud"] = {"seq": self.cloud_seq, "t_mono": out["t_mono"], "n": len(pts), "origin": origin,
                                "points_b64": enc_points(pts, origin), "class_b64": enc_u8(cls)}
            else:
                out["cloud"] = None
            mem_seq = int(self.t())
            if mem_seq > mem_after:
                if self.memory_cache is None or self.memory_cache[0] != (mem_seq // 3, self.epoch):
                    sup, ceil, lo, res = rasterize(self.world.boxes, po[:2], frame_from_scene=self.odom_from_scene,
                                                   robot_scene=self.robot_scene)
                    self.memory_cache = ((mem_seq // 3, self.epoch), memory_block(mem_seq, self.epoch, sup, ceil, lo, res))
                out["memory"] = dict(self.memory_cache[1], seq=mem_seq)
            else:
                out["memory"] = None
            return out

    def align(self):
        """The last start check of this session as the contract's align block (truth-based in the fake)."""
        chk = self.hub.last_check.get(self.slot)
        if chk is None and self.script is None:
            return None
        P_c = self.pose_odom() if chk is None else chk["P_c"]
        scene_from_odom = inverse(self.odom_from_scene)
        return {"scene_from_odom": [round(v, 5) for v in scene_from_odom], "P_c": P_c,
                "theta": chk["theta"] if chk else 0.0, "t": chk["t"] if chk else [0.0, 0.0],
                "at": chk["at"] if chk else time.time(), "overlap": 0.81, "ok": True,
                "moved_m": chk["moved_m"] if chk else 0.0, "turned_deg": chk["turned_deg"] if chk else 0.0,
                "basis": "start check" if chk else "course"}

    def state(self):
        with self.lock:
            locks = self.go_locks()
            steps = [("arm", "Arm", self.armed_t is not None), ("sonic", "Start SONIC", self.runner == "CONTROL"),
                     ("map", "Clear map", self.cleared_t is not None and self.t() - self.cleared_t >= 10.0),
                     ("goal", "Send goal", self.goal_t is not None and self.goal_t >= self.cycle_start()),
                     ("go", "GO", self.phase in ("PRESCAN", "RUN"))]
            ladder, now_set = [], False
            for key, label, done in steps:
                st = "done" if done else ("now" if not now_set else "todo")
                now_set = now_set or not done
                ladder.append({"key": key, "label": label, "state": st, "detail": ""})
            return {"t": round(self.t(), 2), "console_t_mono": round(self.t0 + self.t(), 3), "session": self.name,
                    "mode": "ROBOT eno1" if self.kind == "robot" else "SIMULATION",
                    "runner": self.runner, "driving": "student stream" if self.phase in ("PRESCAN", "RUN") else
                    ("SONIC planner (standing set)" if self.runner == "CONTROL" else "Unitree controller"),
                    "phase": self.phase, "latency_s": 0.21, "tilt_rad": 0.03,
                    "events": [f"{e['t']:6.1f}  {e['text']}" for e in self.events[-12:]][::-1],
                    "ladder": ladder, "go_locks": locks, "attempts": [public_attempt(a) for a in self.attempts],
                    "acts": self.acts, "remote": {"connected": True, "last": None},
                    "standing_s": round(self.t() - self.control_t, 1) if self.control_t is not None else 0.0,
                    "temps": {"max_c": 47.0 + 0.02 * self.t(), "max_joint": "left_ankle_pitch_joint"},
                    "checks": [{"key": "lowstate", "label": "lowstate", "level": "ok", "detail": "1000 Hz"},
                               {"key": "lidar", "label": "lidar", "level": "ok", "detail": "10 Hz"}],
                    "near_body": {"close": 0, "close_cells": [], "behind_tall": 3, "self_like": 0},
                    "odom": {"mode": self.odom, "doubt": False, "lost": None},
                    "tags": ["clean", "touched", "stumble", "caught", "aborted", "setup issue"],
                    "setup": {"profile": self.profile}}


def public_attempt(a):
    return {k: v for k, v in a.items() if k not in ("walk_from", "passage_ab")}


# ---------------------------------------------------------------------------------------------- the hub
class FakeHub:
    def __init__(self, args):
        self.args = args
        self.v3 = not args.v1_only
        self.day = tempfile.mkdtemp(prefix="fake-day-")
        self.world = World(args.scan_dir)
        self.faults = Faults()
        self.slots = {"robot": None, "sim": None}
        self.consoles = OrderedDict()  # every session ever started (name -> FakeConsole), oldest first
        self.scan = {"running": False, "t0": None, "name": None}
        self.scans = [self.scan_row(self.world.name)]
        self.rehearsals = {}
        self.last_check = {}
        self.actions, self.sessions = [], []
        self.doctor = None
        self.goal_last = None
        self.frozen = {}  # what freeze_panel / freeze_view / hang_console hold: key -> (monotonic, snapshot)
        self.server = None
        self.studio_link = self.link_studio(args.studio_data) if args.studio_data else None

    def link_studio(self, studio_data):
        """The day directory under Studio's robot-sessions (as the kit's hub.link_studio)."""
        base = Path(studio_data) / "robot-sessions"
        base.mkdir(parents=True, exist_ok=True)
        link = base / Path(self.day).name
        if not link.exists():
            link.symlink_to(self.day, target_is_directory=True)
        return str(link)

    def scan_row(self, name, practice=False):
        return {"name": name, "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "verdict": "CHECK", "practice": practice,
                "reasons": ["the lidar did not see behind the robot (rear blind 180 deg, 1.0 m)"],
                "walked_since": False, "age_s": 0.0, "rehearsals": 0, "memory_sha": self.world.memory_sha}

    def live(self, slot):
        c = self.slots.get(slot)
        return c if c is not None and not c.ended else None

    # -- receipts (contract v3 A)
    def make_receipt(self, c, operator=None, confirm=None, scan=None, start_offset=None):
        return {"session": c.name, "slot": c.slot, "kind": c.kind, "robot": "lab-g1", "operator": operator,
                "started": round(c.started_wall, 3),
                "profile": {"name": c.profile, "sha": profile_sha(c.profile) if c.profile in PROFILES else None},
                "bundle": {"name": "bundle", "manifest_sha": BUNDLE_MANIFEST_SHA}, "rules": None, "odom": c.odom,
                "mount_calib_sha": None,
                "scan": {"name": scan, "memory_sha": self.world.memory_sha} if scan else None,
                "start_offset": [round(v, 4) for v in start_offset] if start_offset is not None else None,
                "confirmations": confirm or None, "kit": {"commit": "fake", "dirty": False}, "private_commit": None,
                "runner_commit": None}

    # -- state
    def panel_summary(self, slot, c):
        key = ("summary", slot)
        hung = self.console_hung(c)
        if (self.faults.get("freeze_panel") or hung) and key in self.frozen:
            at, snap = self.frozen[key]
            return snap, time.monotonic() - at
        summary = {"runner": c.runner, "phase": c.phase, "attempts": len(c.attempts), "go_locks": c.go_locks(),
                   "driving": None, "remote": {"connected": True},
                   "temps": {"max_c": 47.0, "max_joint": "left_ankle_pitch_joint"}, "standing_s": 0.0}
        self.frozen[key] = (time.monotonic(), summary)
        return summary, 0.1

    def console_hung(self, c):
        h = self.faults.get("hang_console")
        return bool(h) and (h is True or h == c.slot)

    def state(self):
        live = {}
        for slot, c in self.slots.items():
            if c is None:
                live[slot] = None
                continue
            panel, age = self.panel_summary(slot, c)
            live[slot] = {"name": c.name, "dir": str(c.dir), "mode": "sim" if (slot == "sim" or c.practice) else "robot",
                          "practice": c.practice, "profile": c.profile, "odom": c.odom, "running": not c.ended,
                          "panel_port": c.panel_port, "panel_token_file": str(c.dir / "panel_url.txt"),
                          "started": c.t0, "console_t_mono_age_s": round(age, 3), "panel": panel}
            if self.v3:
                live[slot]["receipt"] = c.receipt
        for s in self.scans:
            s["age_s"] = round(time.time() - time.mktime(time.strptime(s["time"], "%Y-%m-%dT%H:%M:%S")), 1)
        return {"api": 1, "capabilities": V1_CAPABILITIES + (V3_CAPABILITIES if self.v3 else []),
                "version": {"kit_commit": "fake", "kit_dirty": False, "private_commit": None}, "day": self.day,
                "t": round(time.time(), 3), "t_mono": round(time.monotonic(), 3), "state_age_s": 0.0,
                "pc": {"load": 1.2, "cpus": 28, "gpu": {"used_mib": 2000, "total_mib": 16376}, "busy": [], "chains": [],
                       "disk_free_gb": 812.0},
                "robot_link": {"iface": "eno1", "carrier": not self.args.practice_only, "livox_driver": True,
                               "lidar_hz": 10.0, "lio_bridge": True, "lio_pose_age_s": 0.07, "robot": "lab-g1"},
                "profiles": [{"name": n, "label": p["label"], "featured": p["featured"], "note": p["note"],
                              "bundle_ok": True, "error": None} for n, p in PROFILES.items()],
                "default_profile": "deploy", "default_odom": "fused", "live": live, "scans": self.scans,
                "scan_job": {"running": self.scan["running"], "name": self.scan["name"]},
                "sessions": self.sessions_v1(), "rehearsals": self.rehearsal_rows(),
                "rehearsal_job": next(({"name": r["name"], "current": r["current"]} for r in self.rehearsal_rows()
                                       if r["state"] == "running" and not r.get("seeded")), None),
                "gpu": {"free_mib": 14000, "rehearsal_mib": 8500}, "doctor": self.doctor,
                "phone_panel": f"http://100.64.0.1:{self.args.panel_port}/?t=…", "studio_link": self.studio_link,
                "lease_seen": self.lease_seen()}

    def lease_seen(self):
        """What each live console was last told about Studio's operator lease (a fake-only field for tests)."""
        return {slot: (c.lease if c is not None and not c.ended else None) for slot, c in self.slots.items()}

    def session_row(self, c):
        return {"name": c.name, "dir": str(c.dir), "mode": "robot" if c.kind == "robot" else "sim", "kind": c.kind,
                "practice": c.practice, "started": round(c.started_wall, 3), "profile": c.profile, "odom": c.odom,
                "attempts": [{k: a.get(k) for k in ("n", "result", "tag", "note")} for a in c.attempts],
                "studio": studio_id(Path(self.day), c.name), "ended": c.ended}

    def sessions_v1(self, offset=0, limit=40):
        rows = [self.session_row(c) for c in reversed(self.consoles.values())]  # newest first, as the kit
        robot = [r for r in rows if r["mode"] == "robot"]
        other = [r for r in rows if r["mode"] != "robot"]
        return {"robot": robot, "other": other[offset:offset + limit], "other_total": len(other), "offset": offset,
                "limit": limit}

    def scan_live(self):
        s = self.scan
        if not s["running"]:
            return {"running": False, "name": s["name"]}
        el = time.monotonic() - s["t0"]
        if el > 8.0:
            s["running"] = False
            return {"running": False, "name": s["name"]}
        w = self.world
        frac = min(1.0, el / 8.0)
        n = w.support.shape[0]
        ii, jj = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        r = np.hypot(w.lo[0] + ii * w.res - w.start_S[0], w.lo[1] + jj * w.res - w.start_S[1])
        mask = r < 0.5 + 3.5 * frac
        pts, cls = w.cloud(np.random.default_rng(int(el * 10)), (0.0, 0.0, 0.0), 2500)
        origin = [0.0, 0.0, 1.2]
        return {"running": True, "name": s["name"], "t": round(el, 2), "n_frames": int(el * 10),
                "joint_names": JOINT_NAMES, "start_S": w.start_S,
                "qpos": [0.0, 0.0, PELVIS_Z, 1.0, 0.0, 0.0, 0.0, *[round(float(v), 4) for v in STAND]],
                "cloud": {"n": len(pts), "origin": origin, "points_b64": enc_points(pts, origin), "class_b64": enc_u8(cls)},
                "memory": memory_block(int(el * 2), 0, np.where(mask, w.support, np.nan), np.where(mask, w.ceiling, np.nan),
                                       w.lo, w.res)}

    def scene(self, name):
        w = self.world
        sc = next((s for s in self.scans if s["name"] == name), None)
        if sc is None:
            return None
        return {"name": name, "time": sc["time"], "verdict": sc["verdict"], "reasons": sc["reasons"], "frames": 80,
                "start_S": w.start_S, "scene_from_memory": [round(v, 6) for v in w.scene_from_memory],
                "memory": memory_block(0, 0, w.support, w.ceiling, w.lo, w.res), "twin": w.twin_memory(),
                "course_boxes": w.boxes, "memory_file": w.memory_file, "memory_sha": w.memory_sha}

    def readiness(self, slot="robot"):
        c = self.live(slot)
        now = time.time()

        def chk(id_, group, label, status, evidence, detail, after, anchor=None, fix=None, max_age=60):
            return {"id": id_, "group": group, "label": label, "status": status, "evidence": evidence, "detail": detail,
                    "at": now, "max_age_s": max_age, "measurable_after": after, "anchor": anchor, "fix": fix}
        live_ok = c is not None and c.phase is not None
        return {"slot": slot, "scan": None, "session": c.name if c else None, "t": now, "checks": [
            chk("link", "link", "Network link to the robot", "pass", "MEASURED", "eno1 carrier up", "connect"),
            chk("lidar", "link", "Lidar publishing", "pass", "MEASURED", "10.0 Hz", "connect",
                {"kind": "frame", "at": [0.05, 0.0, 1.2]}),
            chk("lio", "link", "FAST-LIO bridge", "pass", "MEASURED", "pose age 70 ms", "connect"),
            chk("gpu", "link", "GPU memory free", "pass", "MEASURED", "14.0 GB free", "connect"),
            chk("temps", "robot", "Motor temperatures", "pass" if c else "unknown", "MEASURED",
                "max 47 C (left ankle)" if c else "", "session"),
            chk("remote", "robot", "Remote connected", "pass" if c else "unknown", "MEASURED", "", "session"),
            chk("scan", "perception", "Scan verdict", "warn", "DERIVED", self.scans[0]["reasons"][0], "scan",
                fix={"hint": "Rescan after people step out of view"}),
            chk("behind", "perception", "Tall returns behind the robot (rope)", "warn" if live_ok else "unknown", "MEASURED",
                "3 cells 1.0-1.6 m high within 1 m behind: hold the rope above 1.6 m" if live_ok else "", "node",
                {"kind": "wedge", "frame": "robot", "yaw": math.pi, "deg": 180, "range_m": 1.0}),
            chk("moved", "scene", "Robot moved since the scan", "warn" if self.last_check.get(slot) else "unknown",
                "DERIVED", "0.20 m, 20 deg right: inside the rehearsed start-offset envelope" if self.last_check.get(slot)
                else "", "goal", {"kind": "pose", "frame": "scene", "pose": [0.0, 0.0, 0.0]}),
            chk("operator", "operator", "Gantry or spotter ready; E-stop tested; remote holder briefed (Select = "
                "E-STOP, D-up = stand only); rope held above 1.6 m", "pass" if c else "unknown", "OPERATOR",
                "confirmed at session start" if c else "", "session"),
        ]}

    def start_check(self, slot, scan):
        c = self.live(slot)
        if c is None or c.phase is None:
            return {"ok": False, "error": "the planner node is not up (Arm)", "reason": "the planner node is not up (Arm)"}
        q = c.robot_scene  # the robot now in scene (truth: the fake's registration is perfect)
        theta = -q[2]
        ct, st = math.cos(theta), math.sin(theta)
        t = [-(ct * q[0] - st * q[1]), -(st * q[0] + ct * q[1])]
        moved = float(np.hypot(q[0], q[1]))
        chk = {"ok": True, "overlap": 0.81, "theta": theta, "t": t, "P_c": c.pose_odom(),
               "scene_from_odom": [round(v, 5) for v in inverse(c.odom_from_scene)], "moved_m": round(moved, 3),
               "turned_deg": round(math.degrees(q[2]), 1), "at": time.time(), "warn": moved > 0.1 or abs(q[2]) > 0.087,
               "within_offset_envelope": moved <= 0.25 and abs(math.degrees(q[2])) <= 25, "scan": scan}
        # as the kit (hub.start_check): the envelope covers the first walk from the scan pose; after a walk, None
        chk["closed_attempts"] = sum(1 for a in c.attempts if a.get("outcome") is not None)
        if chk["closed_attempts"]:
            chk["within_offset_envelope"] = None
        self.last_check[slot] = chk
        return chk

    # -- rehearsal sets (contract v3 B)
    def identity_now(self, scan, goal_scene, profile, odom):
        """The identity a set rehearsed now for these inputs would carry."""
        return {"scan": scan, "scan_memory_sha": self.world.memory_sha,
                "goal_scene": [round(float(v), 4) for v in goal_scene], "profile": profile,
                "profile_sha": profile_sha(profile) if profile in PROFILES else None,
                "bundle_sha": BUNDLE_MANIFEST_SHA, "rules_sha": None, "odom": odom,
                "starts": copy.deepcopy(STARTS), "drift_model": DRIFT_MODEL}

    def new_set(self, scan, goal, profile, odom, passage=None, started=None, name=None):
        started = time.time() if started is None else started
        base = name or f"rehearse-{time.strftime('%H%M%S', time.localtime(started))}-{profile}"
        while base in self.rehearsals:
            base += "x"
        rec = {"name": base, "scan": scan, "goal_scene": [round(float(v), 4) for v in goal], "profile": profile,
               "odom": odom, "state": "running", "started": round(started, 3), "finished": None,
               "identity": self.identity_now(scan, goal, profile, odom),
               "runs": {k: {"name": f"{base}-{k}", "state": "pending", "result_node": None, "arrival": None,
                            "final_dist_m": None, "passage": None, "contact_max_n": None, "timing_valid": None,
                            "timing_note": None} for k in RUN_KINDS},
               "passage": passage, "verdict": None, "apart_m": None, "offset_ok": None, "current": None,
               "_results": {}}
        self.rehearsals[base] = rec
        return rec

    def rehearsal_rows(self):
        rows = sorted(self.rehearsals.values(), key=lambda r: (r["started"], r["name"]), reverse=True)  # NEWEST FIRST
        return [self.public_set(r) for r in rows]

    @staticmethod
    def public_set(r):
        out = {k: copy.deepcopy(v) for k, v in r.items() if not k.startswith("_")}
        out["running"] = r["state"] == "running"
        return out

    def rehearse(self, req):
        goal = [float(v) for v in req["goal_scene"]]
        self.goal_last = np.asarray(goal)
        passage = req.get("passage") if self.v3 else None
        if passage is not None:
            passage = {"a": [float(v) for v in passage["a"]], "b": [float(v) for v in passage["b"]]}
        rec = self.new_set(req.get("scan"), goal, req.get("profile", "deploy"), req.get("odom", "fused"), passage)
        fail_run, stop_after = self.faults.get("rehearsal_fail_run"), self.faults.get("rehearsal_stop_after")

        def run():
            for which, start, drift in (("exact", (0, 0, 0), None), ("drift", (0, 0, 0), 6.0), ("offset", OFFSET_SCENE, None)):
                rec["current"] = which
                row = rec["runs"][which]
                row["state"] = "running"
                if which == fail_run:
                    row.update(state="error", timing_note="fake fault: the run did not start")
                    rec.update(state="failed", finished=round(time.time(), 3), current=None)
                    return
                c = FakeConsole(self, "sim", self.world, start_scene=start, odom_start_yaw=0.0, profile=rec["profile"],
                                odom="dds", scripted_goal_scene=goal, drift_deg=drift, name=row["name"],
                                scan=rec["scan"], rehearsal=rec)
                self.slots["sim"] = c
                self.consoles[c.name] = c
                c.act({"act": "arm", "id": str(uuid.uuid4())}, "hub")
                while not c.ended and c.t() < 40:
                    time.sleep(0.1)
                c.end()
                a = c.attempts[-1] if c.attempts else {}
                final = float(np.hypot(*(np.asarray(c.robot_scene[:2]) - goal)))
                rec["_results"][which] = {"walk": c.walk_scene[::2], "contacts": c.contacts, "duration_s": round(c.t(), 1),
                                          "arrived": final <= TRUTH_ARRIVE_M}
                row.update(state="done", result_node=a.get("result"), arrival=final <= TRUTH_ARRIVE_M,
                           final_dist_m=round(final, 3), passage=a.get("passage") if passage else None,
                           contact_max_n=max([x["n"] for x in c.contacts], default=0.0), timing_valid=True,
                           timing_note="fake hub: a kinematic puppet, no real-time chain")
                if which == stop_after:
                    rec.update(state="partial", finished=round(time.time(), 3), current=None)
                    return
            ex = np.asarray(rec["_results"]["exact"]["walk"] or [[0, 0, 0]])[:, :2]
            dr = np.asarray(rec["_results"]["drift"]["walk"] or [[0, 0, 0]])[:, :2]
            apart = max(float(np.min(np.hypot(*(ex - p).T))) for p in dr) if len(ex) and len(dr) else 0.0
            runs = rec["runs"]
            arrived = {k: bool(runs[k]["arrival"]) for k in RUN_KINDS}
            missed = passage is not None and any(runs[k]["passage"] != "crossed" for k in ("exact", "drift"))
            rec["apart_m"] = round(apart, 2)
            rec["offset_ok"] = arrived["offset"] and (passage is None or runs["offset"]["passage"] == "crossed")
            rec["verdict"] = ("missed passage" if missed and arrived["exact"] else
                              "robust" if arrived["exact"] and arrived["drift"] and apart <= 0.5 else
                              "other way" if arrived["exact"] and arrived["drift"] else
                              "fails with drift" if arrived["exact"] else "fails")
            rec.update(state="complete", finished=round(time.time(), 3), current=None)

        threading.Thread(target=run, daemon=True).start()
        return dict(self.public_set(rec), ok=True)

    def match(self, scan, x, y, profile, odom):
        """GET /api/v1/rehearsal/match: the newest complete set whose identity matches, the newest running one, and
        every other set of that scan with what differs (an empty mismatch: superseded by a newer matching set)."""
        want = self.identity_now(scan, [x, y], profile, odom)
        complete = running = None
        others = []
        for r in sorted(self.rehearsals.values(), key=lambda r: (r["started"], r["name"]), reverse=True):
            if r["scan"] != scan:
                continue
            ident = r.get("identity") or {}
            missing = [k for k in want if k not in ident]
            mismatch = [k for k in want if k in ident and k != "goal_scene" and ident[k] != want[k]]
            g = ident.get("goal_scene")
            if "goal_scene" in ident and (not g or math.hypot(g[0] - x, g[1] - y) > MATCH_GOAL_M):
                mismatch.append("goal_scene")
            if not missing and not mismatch:
                if r["state"] == "complete" and complete is None:
                    complete = self.public_set(r)
                    continue
                if r["state"] == "running" and running is None:
                    running = self.public_set(r)
                    continue
            others.append({"name": r["name"], "state": r["state"], "mismatch": mismatch + missing, "missing": missing})
        return {"complete": complete, "running": running, "others": others, "identity": want,
                "goal_tolerance_m": MATCH_GOAL_M}

    def rehearsal_for_goal(self, console):
        """The rehearsal set in force for the console's goal (stored with the attempt)."""
        meta = console.goal_meta or {}
        goal = meta.get("goal_scene") if meta.get("goal_scene") is not None else (
            self.goal_last.tolist() if self.goal_last is not None else None)
        scan = meta.get("scan") or (console.receipt.get("scan") or {}).get("name")
        if goal is None or scan is None:
            return None
        m = self.match(scan, float(goal[0]), float(goal[1]), console.profile, console.odom)
        r = m["complete"]
        return {k: r.get(k) for k in ("name", "verdict", "state", "offset_ok", "apart_m", "profile")} if r else None

    def seed_rehearsals(self, req):
        """POST /api/fake/rehearsals: canned sets for Astra's F02 cases (newest first in the state)."""
        scan = req.get("scan") or self.scans[0]["name"]
        goal = [float(v) for v in (req.get("goal_scene") or [3.0, 0.0])]
        profile, odom = req.get("profile") or "deploy", req.get("odom") or "fused"
        now = time.time()
        made = []

        def seed(minutes_ago, state, verdict, label, **ident):
            started = now - 60 * minutes_ago
            rec = self.new_set(scan, goal, profile, odom, started=started,
                               name=f"rehearse-{time.strftime('%H%M%S', time.localtime(started))}-{label}")
            rec["seeded"] = True
            for k, v in ident.items():
                if v is None and k.startswith("drop_"):
                    rec["identity"].pop(k[5:], None)
                    continue
                rec["identity"][k] = v
                if k in ("odom", "profile"):
                    rec[k] = v
            ok = verdict == "robust"
            for k in RUN_KINDS:
                done = state == "complete" or (state == "running" and k == "exact")
                rec["runs"][k].update(state="done" if done else "running" if state == "running" and k == "drift"
                                      else "pending", result_node="arrived" if done and (ok or k == "exact") else
                                      "stopped" if done else None,
                                      arrival=(ok or k == "exact") if done else None,
                                      final_dist_m=(0.2 if ok or k == "exact" else 1.4) if done else None,
                                      contact_max_n=0.0 if done else None, timing_valid=True if done else None,
                                      timing_note="seeded by the fake hub" if done else None)
            rec.update(state=state, verdict=verdict if state == "complete" else None,
                       apart_m=0.2 if state == "complete" else None,
                       offset_ok=ok if state == "complete" else None,
                       finished=round(started + 90, 3) if state != "running" else None,
                       current="drift" if state == "running" else None)
            made.append(rec["name"])
        if req.get("preset") == "f02":
            seed(60, "complete", "robust", "old-pass")
            seed(30, "complete", "fails with drift", "new-failure")
            seed(20, "complete", "robust", "other-odom", odom="leg" if odom != "leg" else "fused")
            seed(15, "complete", "robust", "old-profile", profile_sha="0" * 64)
            seed(10, "complete", "robust", "other-start", starts=dict(copy.deepcopy(STARTS), offset=[0.4, 0.1, -0.6]))
            seed(8, "complete", "robust", "no-bundle-sha", drop_bundle_sha=None)
            seed(5, "running", None, "rerun")
        for s in req.get("sets") or []:
            seed(float(s.get("minutes_ago", 1)), s.get("state", "complete"), s.get("verdict", "robust"),
                 s.get("label", "seeded"), **(s.get("identity") or {}))
        return {"ok": True, "seeded": made}

    def track(self, name):
        if self.faults.take("track_fail"):
            return 503, {"ok": False, "error": "fake fault: the track is not readable right now"}
        for r in self.rehearsals.values():
            for which, run in r["runs"].items():
                if run["name"] != name:
                    continue
                res = r["_results"].get(which)
                if res is None:
                    return 200, {"name": name, "running": True, "progress": r["current"], "state": run["state"]}
                walk = res["walk"] or [[0.0, 0.0, 0.0]]
                qpos = [[p[0], p[1], PELVIS_Z, *quat_yaw(p[2]), *[round(float(v), 4) for v in STAND]] for p in walk]
                return 200, {"name": name, "running": False, "arrived": res["arrived"], "frame": "scene",
                             "joint_names": JOINT_NAMES, "t": [round(0.04 * k, 3) for k in range(len(qpos))], "qpos": qpos,
                             "contacts": res["contacts"],
                             "contact_max_n": max([c["n"] for c in res["contacts"]], default=0.0),
                             "final_dist_m": run["final_dist_m"], "duration_s": res["duration_s"],
                             "verdict": r["verdict"], "passage": run["passage"], "arrival": run["arrival"],
                             "result_node": run["result_node"]}
        return 404, {"ok": False, "error": "no such run"}

    # -- evidence (contract v3 G)
    @staticmethod
    def required_streams(c):
        req = list(ROBOT_STREAMS)
        if c.odom in ("zmq", "fused", "lio"):
            req += LIO_STREAMS
        if c.kind == "rehearsal":
            req.append("sim_truth")
        return req

    def recording(self, c):
        mode = self.faults.get("recording_mode")
        req = self.required_streams(c)
        age = time.monotonic() - c.t0
        span = (c.ended_wall or time.time()) - c.started_wall
        streams = []
        for sid in req + ["runner_log"]:
            hz = EXPECTED_HZ.get(sid)
            active = not c.ended
            row = {"id": sid, "required": sid in req, "active": active, "rate_hz": hz if (active and hz) else 0.0 if hz else None,
                   "expected_hz": hz, "last_write_age_s": 0.1 if active else round(time.time() - (c.ended_wall or 0), 1),
                   "dropped": 0, "gaps": 0, "bytes": int(max(1.0, span) * (hz or 1.0) * 200)}
            if mode == "degraded" and sid == "lidar_raw":
                row.update(active=False, rate_hz=0.0, last_write_age_s=12.0, gaps=3, dropped=41)
            streams.append(row)
        errors = []
        disk = 812.0
        if mode == "degraded":
            disk = 0.4
            errors = ["lidar_raw: no write for 12.0 s (3 gaps)", "disk free 0.4 GB, below the 2 GB floor"]
        return {"session": c.name, "streams": streams, "disk_free_gb": disk, "errors": errors,
                "finalized": c.ended, "recorder_alive": not c.ended, "t_mono": round(time.monotonic(), 3),
                "age_s": round(age, 1)}

    def manifest(self, c):
        mode = self.faults.get("manifest_mode")
        req = self.required_streams(c)
        span = round((c.ended_wall or time.time()) - c.started_wall, 1)
        ids = list(dict.fromkeys(req + ["node_memory", "start_checks", "scan", "rehearsal", "identity",
                                        "operator_confirmations"] + LIO_STREAMS + OPTIONAL_STREAMS))
        items = []
        for i in ids:
            row = {"id": i, "required": i in req, "status": "present", "bytes": 1000 + 10 * len(i), "span_s": span,
                   "gaps": 0, "reason": None}
            if i in LIO_STREAMS and i not in req:
                row.update(status="n/a", bytes=0, span_s=None, reason=f"odometry {c.odom}: no LIO streams")
            elif i == "video":
                row.update(status="n/a", bytes=0, span_s=None, reason="no camera configured")
            elif i == "report":
                row.update(status="present" if c.ended else "missing", bytes=4000 if c.ended else 0,
                           span_s=None, reason=None if c.ended else "written when the session ends")
            elif i == "rehearsal" and c.kind != "rehearsal" and not any(a.get("rehearsal") for a in c.attempts):
                row.update(status="n/a", bytes=0, span_s=None, reason="no rehearsal set in force")
            if mode == "failing" and i == "lidar_raw":
                row.update(status="partial", gaps=3, reason="3 gaps (12.0 s without a frame); last chunk truncated")
            items.append(row)
        complete = c.ended and all(r["status"] == "present" for r in items if r["required"])
        return {"name": c.name, "version": 2, "kind": c.kind, "odom": c.odom, "finalized": c.ended,
                "complete": complete, "items": items,
                "missing_required": [r["id"] for r in items if r["required"] and r["status"] != "present"]}

    def session_detail(self, c):
        return {"name": c.name, "dir": str(c.dir), "receipt": c.receipt, "ended": c.ended,
                "started": round(c.started_wall, 3), "ended_at": round(c.ended_wall, 3) if c.ended_wall else None,
                "attempts": [self.attempt_row(c, a) for a in c.attempts],
                "replay": {"studio_id": studio_id(Path(self.day), c.name), "linked": self.studio_link is not None},
                "manifest": self.manifest(c), "recording": self.recording(c)}

    @staticmethod
    def attempt_row(c, a):
        row = public_attempt(a)
        row.setdefault("tag_history", [])
        return row

    def tag(self, name, body):
        c = self.consoles.get(name)
        if c is None:
            return 404, {"ok": False, "error": "no such session"}
        try:
            n = int(body.get("n"))
        except (TypeError, ValueError):
            return 200, {"ok": False, "error": "n must be an attempt number", "reason": "n must be an attempt number"}
        a = next((a for a in c.attempts if a["n"] == n), None)
        if a is None:
            return 200, {"ok": False, "error": f"no attempt {n}", "reason": f"no attempt {n}"}
        if not c.ended:  # a live session: through its console (the console keeps the history)
            code, reply = self.relay(c, {"act": "tag", "n": n, "tag": body.get("tag"), "note": body.get("note"),
                                         "operator": body.get("operator"), "id": body.get("id") or str(uuid.uuid4()),
                                         "source": "studio"})
            if code != 200 or not reply.get("ok"):
                return 200, {"ok": False, "error": reply.get("reason") or reply.get("error"),
                             "reason": reply.get("reason") or reply.get("error"), "act": reply}
        else:  # an ended session: append-only attempt_tags.jsonl, the newest tag wins
            entry = {"n": n, "tag": body.get("tag"), "note": body.get("note"), "operator": body.get("operator"),
                     "wall": round(time.time(), 3), "via": "service"}
            with (c.dir / "attempt_tags.jsonl").open("a") as f:
                f.write(json.dumps(entry) + "\n")
            a["tag"], a["note"] = entry["tag"], entry["note"]
            a.setdefault("tag_history", []).append({k: v for k, v in entry.items() if k != "n"})
        return 200, {"ok": True, "session": name, "n": n, "tag": a["tag"], "note": a["note"],
                     "tag_history": a["tag_history"], "ended": c.ended}

    # -- the console path (the kit's hub.panel_proxy)
    def relay(self, c, body, timeout=2.5):
        """POST /act to the console's panel over HTTP, as the kit's hub does: a lost reply is 502 panel unreachable."""
        try:
            conn = http.client.HTTPConnection("127.0.0.1", c.panel_port, timeout=timeout)
            try:
                conn.request("POST", "/act?" + urlencode({"t": self.args.token}), body=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json"})
                r = conn.getresponse()
                code, raw = r.status, r.read()
            finally:
                conn.close()
            reply = json.loads(raw or b"{}")
            return code, reply if isinstance(reply, dict) else {"reply": reply}
        except (OSError, ValueError, http.client.HTTPException) as exc:
            return 502, {"ok": False, "error": f"panel unreachable: {type(exc).__name__}: {exc}"}

    def console_get(self, c, path, query=None, timeout=1.5):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", c.panel_port, timeout=timeout)
            try:
                conn.request("GET", path + "?" + urlencode(dict(query or {}, t=self.args.token)))
                r = conn.getresponse()
                code, raw = r.status, r.read()
            finally:
                conn.close()
            return code, json.loads(raw or b"{}")
        except (OSError, ValueError, http.client.HTTPException):
            return 502, {"ok": False, "error": "the console does not answer"}

    def panel_state(self, slot):
        c = self.live(slot)
        if c is None:
            return 404, {"ok": False, "error": f"no {slot} session is live"}
        key = ("panel", slot)
        if self.faults.get("freeze_panel") and key in self.frozen:
            at, snap = self.frozen[key]
            return 200, dict(snap)
        code, s = self.console_get(c, "/state")
        if code != 200:
            return code, s
        s["hub_received_t_mono"] = round(time.monotonic(), 3)
        self.frozen[key] = (time.monotonic(), s)
        return 200, s

    def live_view(self, slot, cloud_after, mem_after):
        c = self.live(slot)
        if c is None:
            return 404, {"ok": False, "error": f"no {slot} session is live"}
        key = ("view", slot)
        if self.faults.get("freeze_view") and key in self.frozen:
            at, v = self.frozen[key]
            return 200, dict(v, served_age_s=round(0.05 + time.monotonic() - at, 3), cloud=None, memory=None)
        v = c.view(cloud_after, mem_after)
        if v.get("ok"):
            v["served_age_s"] = 0.05
            v["align"] = c.align()
            self.frozen[key] = (time.monotonic(), v)
        return 200, v

    def act_status(self, slot, aid, session=None):
        c = self.consoles.get(session) if session else self.live(slot)
        if c is None:
            return 404, {"ok": False, "error": f"no {slot} session is live" if not session else "no such session"}
        if c.ended:
            return 200, dict(c.act_result(aid), session=c.name, slot=c.slot)
        code, rec = self.console_get(c, "/act_result", {"id": aid})
        if code != 200:
            return code, dict(rec, session=c.name, slot=c.slot)
        return 200, dict(rec, session=c.name, slot=c.slot)

    # -- POST handlers (as the kit: 200 with ok false and a reason when refused)
    @staticmethod
    def refuse(reason, **extra):
        return 200, {"ok": False, "error": reason, "reason": reason, **extra}

    def post(self, path, body):
        self.actions.append({"t": time.time(), "path": path, "body": body})
        if path in ("/api/v1/act", "/api/v1/send_goal") and self.faults.get("act_delay_s"):
            time.sleep(self.faults.get("act_delay_s"))
        if path == "/api/v1/scan" or path == "/api/v1/practice/scan":
            if self.live("robot") or self.live("sim"):
                return self.refuse("a session is running: end it before scanning")
            practice = path.endswith("practice/scan")
            name = ("practice-" if practice else "scan-") + time.strftime("%H%M%S")
            self.scan.update(running=True, t0=time.monotonic(), name=name)
            self.scans.insert(0, self.scan_row(name, practice))
            return 200, {"ok": True, "name": name}
        if path == "/api/v1/start":
            practice = bool(body.get("practice"))
            slot = "robot" if body.get("mode") == "robot" else "sim"
            other = self.live("sim" if slot == "robot" else "robot")
            if self.live(slot) or (practice and self.live("robot")) or (slot == "robot" and other and other.practice):
                return self.refuse("a robot and a practice session never run together; end the other first")
            conf = body.get("confirm") or {}
            if slot == "robot" or practice:
                missing = [k for k in ("gantry", "estop", "remote", "rope") if not conf.get(k)]
                if missing:
                    return self.refuse("confirm first: " + ", ".join(missing))
            profile = body.get("profile", "deploy")
            if profile not in PROFILES:
                return self.refuse(f"no deploy profile {profile!r}")
            start = tuple(body.get("start_offset") or OFFSET_SCENE)
            c = FakeConsole(self, slot, self.world, start_scene=start, profile=profile,
                            odom=body.get("odom", "fused"), practice=practice, operator=body.get("operator"),
                            confirm=conf or None, scan=body.get("scan") or self.scans[0]["name"])
            self.slots[slot] = c
            self.consoles[c.name] = c
            self.sessions.insert(0, {"name": c.name, "practice": practice, "started": time.time()})
            out = {"ok": True, "slot": slot, "name": c.name}
            if self.v3:
                out["receipt"] = c.receipt
            return 200, out
        if path == "/api/v1/stop":
            c = self.live(body.get("slot", "robot"))
            if c and c.phase in ("PRESCAN", "RUN"):
                return self.refuse("the robot is walking: Stand or E-STOP first")
            if c:
                c.end()
            return 200, {"ok": True}
        if path == "/api/v1/start_check":
            return 200, self.start_check(body.get("slot", "robot"), body.get("scan"))
        if path == "/api/v1/send_goal":
            slot = body.get("slot", "robot")
            c = self.live(slot)
            if c is None:
                return self.refuse("no session running")
            if not body.get("check_id"):
                return self.refuse("send_goal needs the goal check's check_id")
            chk = self.start_check(slot, body.get("scan"))
            if not chk.get("ok"):
                return self.refuse(chk.get("error"), check=chk)
            goal_odom = apply(inverse(chk["scene_from_odom"]), body["goal_scene"]).tolist()
            self.goal_last = np.asarray(body["goal_scene"], dtype=float)
            act = {"act": "goal_odom", "x": goal_odom[0], "y": goal_odom[1], "seq": c.goal_seq + 1,
                   "check_id": body["check_id"], "id": body.get("id") or str(uuid.uuid4()), "expect": body.get("expect"),
                   "source": body.get("source") or "studio", "operator": body.get("operator"),
                   "scan": body.get("scan"), "goal_scene": [round(float(v), 4) for v in body["goal_scene"]],
                   "start_check": {k: chk.get(k) for k in ("ok", "moved_m", "turned_deg", "overlap", "at",
                                                           "within_offset_envelope")},
                   "passage": body.get("passage"), "goal_check": body.get("goal_check")}
            code, res = self.relay(c, act)
            ok = code == 200 and bool(res.get("ok")) and res.get("result") != "refused"
            return 200, {"ok": ok, "reason": None if ok else (res.get("reason") or res.get("error") or f"HTTP {code}"),
                         "check": chk, "goal_odom": {"x": goal_odom[0], "y": goal_odom[1]}, "act": res}
        if path == "/api/v1/rehearse":
            r = self.live("robot")
            if r and r.phase in ("PRESCAN", "RUN"):
                return self.refuse("the robot is walking")
            if self.live("sim"):
                return self.refuse("a simulation is already running")
            return 200, self.rehearse(body)
        if path == "/api/v1/act":
            slot = body.get("slot") or "robot"
            c = self.live(slot)
            if c is None:
                return 404, {"ok": False, "error": f"no {slot} session is live"}
            msg = {k: v for k, v in body.items() if k != "slot"}
            msg.setdefault("source", "studio")
            code, reply = self.relay(c, msg)
            if code != 200:
                reply.setdefault("ok", False)
            return code, reply
        if path == "/api/v1/doctor":
            self.doctor = {"t": time.time(), "exit": 0, "text": "all checks passed (fake)"}
            return 200, dict(self.doctor, ok=True)
        m = re.fullmatch(r"/api/v1/session/([^/]+)/tag", path)
        if m and self.v3:
            return self.tag(m[1], body)
        return 404, {"ok": False, "error": "unknown endpoint"}

    def fake_post(self, path, body):
        """The fake's own control endpoints (never relayed by Studio)."""
        if path == "/api/fake/faults":
            try:
                v = self.faults.set(**body)
            except KeyError as e:
                return 400, {"ok": False, "error": f"unknown fault switch: {e}"}
            down = float(body.get("hub_down_s") or 0)
            if down > 0:
                self.faults.set(hub_down_s=0.0)
                threading.Thread(target=self.go_down, args=(down,), daemon=True).start()
            return 200, {"ok": True, "faults": v}
        if path == "/api/fake/rehearsals":
            return 200, self.seed_rehearsals(body)
        if path == "/api/fake/profile":
            name = body.get("name")
            if name not in PROFILES:
                return 404, {"ok": False, "error": "no such profile"}
            PROFILES[name]["params"].update(body.get("params") or {})
            return 200, {"ok": True, "profile": name, "sha": profile_sha(name), "params": PROFILES[name]["params"]}
        if path == "/api/fake/end":
            c = self.live(body.get("slot", "robot"))
            if c:
                c.end()
            return 200, {"ok": True}
        return 404, {"ok": False, "error": "unknown fake endpoint"}

    def go_down(self, seconds):
        """hub_down_s: stop listening, then listen again on the same port."""
        time.sleep(0.2)  # let the switch's own reply go out
        srv = self.server
        port = srv.server_address[1]
        srv.shutdown()
        srv.server_close()
        time.sleep(seconds)
        for _ in range(100):
            try:
                serve(self, port, self.args.token)
                return
            except OSError:
                time.sleep(0.05)

    def get(self, path, q):
        parts = path.split("/")
        if path == "/api/fake/faults":
            return 200, {"ok": True, "faults": self.faults.snapshot()}
        if path == "/api/v1/state":
            return 200, self.state()
        if path == "/api/v1/readiness":
            return 200, self.readiness(q.get("slot", "robot"))
        if path == "/api/v1/sessions":
            return 200, self.sessions_v1(int(q.get("offset", 0)), int(q.get("limit", 40)))
        if path == "/api/v1/scan/live":
            return 200, self.scan_live()
        if len(parts) == 6 and path.startswith("/api/v1/scan/") and parts[5] == "scene":
            s = self.scene(parts[4])
            return (200, s) if s else (404, {"ok": False, "error": "no such scan"})
        if len(parts) == 6 and path.startswith("/api/v1/live/") and parts[5] == "view":
            if parts[4] not in ("robot", "sim"):
                return 404, {"ok": False, "error": "slot must be robot or sim"}
            return self.live_view(parts[4], int(q.get("cloud_after", -1)), int(q.get("mem_after", -1)))
        if len(parts) == 6 and path.startswith("/api/v1/rehearsal/") and parts[5] == "track":
            return self.track(parts[4])
        if len(parts) == 6 and path.startswith("/api/v1/panel/") and parts[5] == "state":
            if parts[4] not in ("robot", "sim"):
                return 404, {"ok": False, "error": "slot must be robot or sim"}
            return self.panel_state(parts[4])
        if len(parts) == 6 and path.startswith("/api/v1/session/") and parts[5] == "manifest":
            if self.faults.take("manifest_fail"):
                return 503, {"ok": False, "error": "fake fault: the manifest could not be written"}
            c = self.consoles.get(parts[4])
            return (200, self.manifest(c)) if c else (404, {"ok": False, "error": "no such session"})
        if not self.v3:
            return 404, {"ok": False, "error": "unknown endpoint"}
        # ------------------------------------------------------------------ v3
        if path == "/api/v1/rehearsal/match":
            try:
                x, y = float(q.get("x")), float(q.get("y"))
            except (TypeError, ValueError):
                return 400, {"ok": False, "error": "x and y must be numbers (scene frame)"}
            return 200, self.match(q.get("scan"), x, y, q.get("profile") or "deploy", q.get("odom") or "fused")
        if len(parts) == 5 and path.startswith("/api/v1/session/"):
            if self.faults.take("session_fail"):
                return 503, {"ok": False, "error": "fake fault: the session could not be read"}
            c = self.consoles.get(parts[4])
            return (200, self.session_detail(c)) if c else (404, {"ok": False, "error": "no such session"})
        if len(parts) == 6 and path.startswith("/api/v1/session/") and parts[5] in ("receipt", "recording"):
            c = self.consoles.get(parts[4])
            if c is None:
                return 404, {"ok": False, "error": "no such session"}
            if parts[5] == "receipt":
                return 200, c.receipt
            if self.faults.take("recording_fail"):
                return 503, {"ok": False, "error": "fake fault: the recorder's stats are not readable"}
            return 200, self.recording(c)
        if len(parts) == 6 and path.startswith("/api/v1/act/"):
            return self.act_status(parts[4], parts[5], q.get("session"))
        if len(parts) == 6 and path.startswith("/api/v1/profile/") and parts[5] == "route":
            name = parts[4]
            if name not in PROFILES:
                return 404, {"ok": False, "error": f"no deploy profile {name!r}"}
            p = PROFILES[name]
            return 200, {"profile": name, "sha": profile_sha(name), "params": dict(p["params"]), "basis": p["basis"]}
        return 404, {"ok": False, "error": "unknown endpoint"}


def make_handler(handler_get, handler_post, token, delay=lambda: 0.0, before=None):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            if obj is DROP:
                self.close_connection = True
                return
            data = json.dumps(obj, allow_nan=False).encode()
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the client gave up (Studio's 1 s E-STOP timeout against a slow panel)

        def _q(self):
            u = urlparse(self.path)
            return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

        def do_GET(self):
            path, q = self._q()
            if q.get("t") != token:
                return self._send(403, {"ok": False, "error": "token"})
            if before:
                before(path, "GET")
            code, obj = handler_get(path, q)
            self._send(code, obj)

        def do_POST(self):
            path, q = self._q()
            if q.get("t") != token:
                return self._send(403, {"ok": False, "error": "token"})
            n = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"ok": False, "error": "json"})
            if before:
                before(path, "POST")
            if delay():
                time.sleep(delay())
            code, obj = handler_post(path, body)
            self._send(code, obj)
    return H


def panel_server(console, port, token):
    """A console's own panel (GET /state, GET /act_result, POST /act, `?t=TOKEN`), as panel.py serves it."""
    faults = console.hub.faults

    def hang(path, method):
        deadline = time.monotonic() + 60.0
        while console.hub.console_hung(console) and time.monotonic() < deadline and not console.ended:
            time.sleep(0.05)

    def get(path, q):
        if path == "/state":
            return 200, console.state()
        if path == "/act_result":
            return 200, console.act_result(q.get("id", ""))
        return 404, {"error": f"unknown {path}"}

    def post(path, body):
        if path != "/act":
            return 404, {"ok": False}
        res = console.act(body, body.get("source", "panel"))
        acts = faults.get("console_drop_acts")
        if (body.get("act") in acts if acts is not None else body.get("act") not in ("estop", "lease")) \
                and faults.take("console_drop_reply"):
            return 200, DROP  # applied, the reply lost
        return 200, res

    srv = None
    for attempt in range(50):  # the robot slot's fixed port: the previous console's panel may still be closing
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(get, post, token, lambda: console.panel_delay_s,
                                                                        before=hang))
            break
        except OSError:
            if attempt == 49:
                raise
            time.sleep(0.05)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def serve(hub, port, token):
    """The hub on 127.0.0.1:port; returns the server (shutdown() stops the hub; the consoles' panels keep serving)."""
    def hub_get(path, q):
        if not path.startswith("/api/fake/") and hub.faults.get("hub_delay_s"):
            time.sleep(hub.faults.get("hub_delay_s"))
        return hub.get(path, q)

    def hub_post(path, body):
        if path.startswith("/api/fake/"):
            return hub.fake_post(path, body)
        if hub.faults.get("hub_delay_s"):
            time.sleep(hub.faults.get("hub_delay_s"))
        code, obj = hub.post(path, body)
        if hub.faults.take("hub_drop_reply"):
            return code, DROP
        return code, obj

    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(hub_get, hub_post, token))
    srv.daemon_threads = True
    hub.server = srv
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def parse(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8779)
    ap.add_argument("--panel-port", type=int, default=8780, help="the robot slot console's panel (0: a free port)")
    ap.add_argument("--token", default="fake-token")
    ap.add_argument("--scan-dir", default=None, help="a kit scan directory (memory.npz + twin.json) instead of the room")
    ap.add_argument("--practice-only", action="store_true", help="no robot link (eno1 carrier down), as on a practice day")
    ap.add_argument("--studio-data", default=None, help="link the fake day into DIR/robot-sessions (a dev gateway's "
                                                        "--data-root), as the kit links its day into Studio's")
    ap.add_argument("--v1-only", action="store_true", help="the service before v3: no v3 endpoints or capabilities")
    return ap.parse_args(argv)


def start(argv=None):
    """(hub, hub server) for in-process use."""
    args = parse(argv)
    hub = FakeHub(args)
    return hub, serve(hub, args.port, args.token)


def main(argv=None):
    hub, srv = start(argv)
    print(f"fake deploy hub on http://127.0.0.1:{srv.server_address[1]}/api/v1/state?t={hub.args.token}  "
          f"robot panel :{hub.args.panel_port}  day {hub.day}  {'v1 only' if hub.args.v1_only else 'v1 + v3'}"
          + (f"  Studio link {hub.studio_link}" if hub.studio_link else ""), flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
