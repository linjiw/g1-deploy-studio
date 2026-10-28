#!/usr/bin/env python3
"""A stand-in for the deploy kit's deploy service (`g1 lab --headless`, API v1) and its console panel, for developing
and testing Studio's Deploy workspace without the kit, the robot or a GPU. The contract is docs/DEPLOY.md.

It serves the hub on `--port` (default 8779). Every console serves its own panel, as the kit's consoles do: the robot
slot on `--panel-port` (default 8780), the sim slot (practice, rehearsal runs) on a free port; each session's
panel_url.txt and the hub state's `live.<slot>.panel_port` say which. Studio's E-STOP goes there directly, with the token
from panel_url.txt. The robot is a kinematic puppet: it stands, walks toward a confirmed goal at 0.4 m/s once GO passes the console's gates, and stops on E-STOP or
Stand. The scene is a synthetic room with two towers 0.69 m apart, or a real scan's memory.npz + twin.json
(`--scan-dir`).

Frames are deliberately not the identity (docs/DEPLOY.md, Frames): the scan's memory frame has the robot at
start_S = [0.3, -0.2, 1.2]; a session's odometry frame starts at the robot with a yaw of 0.9 rad, and the robot stands
0.2 m and 20 degrees off its scan pose (as every walk did on 2026-10-27). A frame bug in Studio shows up here.

Nothing here talks to a robot, DDS or ZMQ.

usage: .venv/bin/python tools/fake_deploy_hub.py [--port 8779] [--panel-port 8780] [--token T] [--scan-dir DIR]

Tests start it in-process: `hub, server = start(["--port", "0", "--panel-port", "0"])`; `server.shutdown()` stops the
hub while the consoles' panels keep serving (the E-STOP path never needs the hub). `FakeConsole.panel_delay_s` makes a
panel answer slowly.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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
    """A console session: gates, acts with ids, a kinematic robot in its odometry frame, its node view, attempts."""

    def __init__(self, hub, slot, world, start_scene=(0.0, 0.0, 0.0), odom_start_yaw=ODOM_START_YAW, profile="deploy",
                 odom="fused", practice=False, scripted_goal_scene=None, drift_deg=None, name=None):
        self.hub, self.slot, self.world = hub, slot, world
        self.t0 = time.monotonic()
        self.lock = threading.Lock()
        self.runner, self.phase = "not started", None
        self.armed_t = self.control_t = self.cleared_t = None
        self.goal_t = None
        self.robot_scene = list(start_scene)  # the truth
        # odom frame: the robot starts at [0, 0, odom_start_yaw] in it
        self.odom_from_scene = compose([0.0, 0.0, odom_start_yaw], inverse(list(start_scene)))
        self.goal_odom, self.goal_seq = None, 0
        self.walk_scene, self.events, self.attempts, self.contacts, self.acts = [], [], [], [], []
        self.seen_ids = {}
        self.cloud_seq, self.mem_seq, self.epoch = 0, 0, 0
        self.rng = np.random.default_rng(1 if slot == "robot" else 2)
        self.profile, self.odom, self.practice, self.drift_deg = profile, odom, practice, drift_deg
        self.lease = None
        self.ended = False
        self.name = name or f"{'robot' if slot == 'robot' and not practice else 'practice' if practice else 'rehearse'}-" \
                            f"{time.strftime('%H%M%S')}-{profile}"
        self.dir = Path(hub.day) / self.name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.panel_delay_s = 0.0
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

    # -- acts (the console's gates)
    def act(self, msg, source="panel"):
        act = msg.get("act")
        if act == "estop":
            with self.lock:
                self.runner, self.phase = "E-STOP", "STOPPED" if self.phase else None
                self._close("estop")
            self.event(f"{source}: E-STOP", "estop")
            return {"ok": True, "key_sent": True, "runner_alive": True, "runner": "E-STOP", "confirmed": True,
                    "t_mono": round(self.t(), 3)}
        aid = msg.get("id") or str(uuid.uuid4())
        if aid in self.seen_ids:
            return self.seen_ids[aid]
        with self.lock:
            expect = msg.get("expect") or {}
            mismatch = [k for k, v in expect.items() if self._state_field(k) != v]
            if mismatch:
                ok, reason = False, f"the console's state changed ({', '.join(mismatch)}): look again"
            else:
                ok, reason = self._act(act, msg, source)
        out = {"ok": ok, "id": aid, "result": "done" if ok else "refused", "reason": reason}
        self.seen_ids[aid] = out
        self.acts = (self.acts + [dict(out, act=act, source=source, t=round(self.t(), 2))])[-20:]
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
            self.event(f"goal confirmed ({self.goal_odom[0]:.2f}, {self.goal_odom[1]:.2f}) odom", "node")
            return True, ""
        if act == "g":
            locks = self.go_locks(source)
            if locks:
                return False, locks[0]
            self.phase = "PRESCAN"
            self.attempts.append({"n": len(self.attempts) + 1, "t_go": round(self.t(), 2),
                                  "goal_odom": self.goal_odom.tolist(), "start_odom": self.pose_odom(),
                                  "outcome": None, "tag": None, "note": None, "check_id": getattr(self, "check_id", None),
                                  "start_check": self.hub.last_check.get(self.slot),
                                  "rehearsal": self.hub.rehearsal_for_goal(), "profile": self.profile, "odom": self.odom})
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
                    return True, ""
            return False, f"no attempt {n}"
        if act == "note":
            return True, ""
        return False, f"unknown act {act}"

    def _close(self, outcome):
        if self.attempts and self.attempts[-1]["outcome"] is None:
            a = self.attempts[-1]
            a.update(outcome=outcome, t_end=round(self.t(), 2), end_odom=self.pose_odom(),
                     final_dist_m=round(float(np.hypot(*(self.goal_odom - self.pose_odom()[:2]))), 2))

    # -- the robot
    def loop(self):
        last = time.monotonic()
        while not self.ended:
            time.sleep(0.02)
            now = time.monotonic()
            dt, last = now - last, now
            with self.lock:
                self.step(dt)
        self.panel.shutdown()  # an ended console's panel goes away with it
        self.panel.server_close()

    def step(self, dt):
        if self.phase == "BOOT" and self.t() - self.armed_t > 3.0:
            self.phase = "WAIT"
            self.event("node up: waiting for GO", "node")
            if self.script is not None:  # a scripted rehearsal runs its own ladder
                self.runner, self.control_t = "CONTROL", self.t() - 2.5
                self.goal_odom = apply(self.odom_from_scene, self.script)
                self.goal_t = self.t()
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
                    self.ended = True
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
                   "rear_blind_deg": 180.0, "rear_blind_range_m": 1.0}
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
            return {"t": round(self.t(), 2), "console_t_mono": round(self.t0 + self.t(), 3),
                    "mode": "ROBOT eno1" if self.slot == "robot" and not self.practice else "SIMULATION",
                    "runner": self.runner, "driving": "student stream" if self.phase in ("PRESCAN", "RUN") else
                    ("SONIC planner (standing set)" if self.runner == "CONTROL" else "Unitree controller"),
                    "phase": self.phase, "latency_s": 0.21, "tilt_rad": 0.03,
                    "events": [f"{e['t']:6.1f}  {e['text']}" for e in self.events[-12:]][::-1],
                    "ladder": ladder, "go_locks": locks, "attempts": self.attempts, "acts": self.acts,
                    "remote": {"connected": True, "last": None}, "standing_s": round(self.t() - self.control_t, 1)
                    if self.control_t is not None else 0.0,
                    "temps": {"max_c": 47.0 + 0.02 * self.t(), "max_joint": "left_ankle_pitch_joint"},
                    "checks": [{"key": "lowstate", "label": "lowstate", "level": "ok", "detail": "1000 Hz"},
                               {"key": "lidar", "label": "lidar", "level": "ok", "detail": "10 Hz"}],
                    "near_body": {"close": 0, "close_cells": [], "behind_tall": 3, "self_like": 0},
                    "odom": {"mode": self.odom, "doubt": False, "lost": None},
                    "tags": ["clean", "touched", "stumble", "caught", "aborted", "setup issue"],
                    "setup": {"profile": self.profile}}


# ---------------------------------------------------------------------------------------------- the hub
class FakeHub:
    def __init__(self, args):
        self.args = args
        self.day = tempfile.mkdtemp(prefix="fake-day-")
        self.world = World(args.scan_dir)
        self.slots = {"robot": None, "sim": None}
        self.scan = {"running": False, "t0": None, "name": None}
        self.scans = [self.scan_row(self.world.name)]
        self.rehearsals = {}
        self.last_check = {}
        self.actions, self.sessions = [], []
        self.doctor = None
        self.goal_last = None

    @staticmethod
    def scan_row(name, practice=False):
        return {"name": name, "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "verdict": "CHECK", "practice": practice,
                "reasons": ["the lidar did not see behind the robot (rear blind 180 deg, 1.0 m)"],
                "walked_since": False, "age_s": 0.0, "rehearsals": 0}

    def live(self, slot):
        c = self.slots.get(slot)
        return c if c is not None and not c.ended else None

    def rehearsal_for_goal(self):
        for r in self.rehearsals.values():
            if r.get("verdict") and self.goal_last is not None and np.hypot(*(np.asarray(r["goal_scene"]) - self.goal_last)) < 0.2:
                return {"runs": r["runs"], "verdict": r["verdict"]}
        return None

    def state(self):
        live = {}
        for slot, c in self.slots.items():
            if c is None:
                live[slot] = None
                continue
            live[slot] = {"name": c.name, "dir": str(c.dir), "mode": "sim" if (slot == "sim" or c.practice) else "robot",
                          "practice": c.practice, "profile": c.profile, "odom": c.odom, "running": not c.ended,
                          "panel_port": c.panel_port, "panel_token_file": str(c.dir / "panel_url.txt"),
                          "started": c.t0, "console_t_mono_age_s": 0.1,
                          "panel": {"runner": c.runner, "phase": c.phase, "attempts": len(c.attempts),
                                    "go_locks": c.go_locks(), "driving": None, "remote": {"connected": True},
                                    "temps": {"max_c": 47.0, "max_joint": "left_ankle_pitch_joint"}, "standing_s": 0.0}}
        for s in self.scans:
            s["age_s"] = round(time.time() - time.mktime(time.strptime(s["time"], "%Y-%m-%dT%H:%M:%S")), 1)
        return {"api": 1, "capabilities": ["view", "scan_live", "practice", "rehearsal_track", "manifest", "readiness"],
                "version": {"kit_commit": "fake", "kit_dirty": False, "private_commit": None}, "day": self.day,
                "pc": {"load": 1.2, "cpus": 28, "gpu": {"used_mib": 2000, "total_mib": 16376}, "busy": [], "chains": [],
                       "disk_free_gb": 812.0},
                "robot_link": {"iface": "eno1", "carrier": not self.args.practice_only, "livox_driver": True,
                               "lidar_hz": 10.0, "lio_bridge": True, "lio_pose_age_s": 0.07, "robot": "lab-g1"},
                "profiles": [{"name": "deploy", "label": "Deploy default", "featured": True, "note": "the baseline"},
                             {"name": "near", "label": "Keeps its distance", "featured": True, "note": "never through gaps"}],
                "default_profile": "deploy", "live": live, "scans": self.scans,
                "scan_job": {"running": self.scan["running"], "name": self.scan["name"]},
                "sessions": {"robot": self.sessions, "other": []}, "rehearsals": list(self.rehearsals.values()),
                "gpu": {"free_mib": 14000, "rehearsal_mib": 8500}, "doctor": self.doctor,
                "phone_panel": f"http://100.64.0.1:{self.args.panel_port}/?t=…", "lease_seen": self.lease_seen()}

    def lease_seen(self):
        """What each live console was last told about Studio's operator lease (a fake-only field for tests)."""
        return {slot: (c.lease if c is not None and not c.ended else None) for slot, c in self.slots.items()}

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
                "course_boxes": w.boxes, "memory_file": w.memory_file}

    def readiness(self, slot="robot"):
        c = self.live(slot)
        now = time.time()

        def chk(id_, group, label, status, evidence, detail, after, anchor=None, fix=None, max_age=60):
            return {"id": id_, "group": group, "label": label, "status": status, "evidence": evidence, "detail": detail,
                    "at": now, "max_age_s": max_age, "measurable_after": after, "anchor": anchor, "fix": fix}
        live_ok = c is not None and c.phase is not None
        return {"checks": [
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
            return {"ok": False, "error": "the planner node is not up (Arm)"}
        q = c.robot_scene  # the robot now in scene (truth: the fake's registration is perfect)
        theta = -q[2]
        ct, st = math.cos(theta), math.sin(theta)
        t = [-(ct * q[0] - st * q[1]), -(st * q[0] + ct * q[1])]
        moved = float(np.hypot(q[0], q[1]))
        chk = {"ok": True, "overlap": 0.81, "theta": theta, "t": t, "P_c": c.pose_odom(),
               "scene_from_odom": [round(v, 5) for v in inverse(c.odom_from_scene)], "moved_m": round(moved, 3),
               "turned_deg": round(math.degrees(q[2]), 1), "at": time.time(), "warn": moved > 0.1 or abs(q[2]) > 0.087,
               "within_offset_envelope": moved <= 0.25 and abs(math.degrees(q[2])) <= 25, "scan": scan}
        self.last_check[slot] = chk
        return chk

    def rehearse(self, req):
        goal = [float(v) for v in req["goal_scene"]]
        self.goal_last = np.asarray(goal)
        base = f"rehearse-{time.strftime('%H%M%S')}-{req.get('profile', 'deploy')}"
        rec = {"name": base, "scan": req.get("scan"), "goal_scene": goal, "profile": req.get("profile", "deploy"),
               "runs": {"exact": base + "-exact", "drift": base + "-drift", "offset": base + "-offset"},
               "running": "exact", "verdict": None, "apart_m": None, "offset_ok": None, "results": {}}
        self.rehearsals[base] = rec

        def run():
            for which, start, drift in (("exact", (0, 0, 0), None), ("drift", (0, 0, 0), 6.0), ("offset", OFFSET_SCENE, None)):
                rec["running"] = which
                c = FakeConsole(self, "sim", self.world, start_scene=start, odom_start_yaw=0.0, profile=rec["profile"],
                                odom="dds", scripted_goal_scene=goal, drift_deg=drift, name=rec["runs"][which])
                self.slots["sim"] = c
                c.act({"act": "arm", "id": str(uuid.uuid4())}, "hub")
                while not c.ended and c.t() < 40:
                    time.sleep(0.1)
                c.ended = True
                rec["results"][which] = {"arrived": bool(c.attempts and c.attempts[-1]["outcome"] == "arrived"),
                                         "walk": c.walk_scene[::2], "contacts": c.contacts, "duration_s": round(c.t(), 1)}
            ex, dr = np.asarray(rec["results"]["exact"]["walk"])[:, :2], np.asarray(rec["results"]["drift"]["walk"])[:, :2]
            apart = max(float(np.min(np.hypot(*(ex - p).T))) for p in dr) if len(ex) and len(dr) else 0.0
            arrived = {k: v["arrived"] for k, v in rec["results"].items()}
            rec["apart_m"] = round(apart, 2)
            rec["verdict"] = ("robust" if arrived["exact"] and arrived["drift"] and apart <= 0.5 else
                              "other way" if arrived["exact"] and arrived["drift"] else
                              "fails with drift" if arrived["exact"] else "fails")
            rec["offset_ok"] = arrived["offset"]
            rec["running"] = None

        threading.Thread(target=run, daemon=True).start()
        return {k: v for k, v in rec.items() if k != "results"}

    def track(self, name):
        for r in self.rehearsals.values():
            for which, run in r["runs"].items():
                if run != name:
                    continue
                res = r["results"].get(which)
                if res is None:
                    return {"name": name, "running": True, "progress": r["running"]}
                walk = res["walk"] or [[0.0, 0.0, 0.0]]
                qpos = [[p[0], p[1], PELVIS_Z, *quat_yaw(p[2]), *[round(float(v), 4) for v in STAND]] for p in walk]
                return {"name": name, "running": False, "arrived": res["arrived"], "frame": "scene",
                        "joint_names": JOINT_NAMES, "t": [round(0.04 * k, 3) for k in range(len(qpos))], "qpos": qpos,
                        "contacts": res["contacts"], "contact_max_n": max([c["n"] for c in res["contacts"]], default=0.0),
                        "final_dist_m": 0.2 if res["arrived"] else None, "duration_s": res["duration_s"],
                        "verdict": r["verdict"]}
        return None

    def manifest(self, name):
        rows = [("lowstate", "present", 712_000_000), ("lowcmd", "present", 300_000_000), ("lidar_raw", "present", 1_000_000_000),
                ("lio_cloud", "present", 240_000_000), ("lio_odom", "present", 9_000_000), ("node_status", "present", 3_000_000),
                ("node_events", "present", 210_000), ("plans", "present", 4_200_000), ("node_memory", "present", 1_300_000),
                ("console_events", "present", 90_000), ("attempts", "present", 3_000), ("start_checks", "present", 2_000),
                ("scan", "present", 900_000), ("rehearsal", "present", 0), ("identity", "present", 4_000),
                ("operator_confirmations", "present", 400), ("runner_log", "present", 2_000_000),
                ("report", "missing", 0), ("video", "n/a", 0)]
        reasons = {"report": "written when the session ends", "video": "no camera configured"}
        return {"name": name, "complete": True,
                "items": [{"id": i, "status": s, "bytes": b, "path": None, "reason": reasons.get(i)} for i, s, b in rows]}

    # -- POST handlers
    def post(self, path, body):
        self.actions.append({"t": time.time(), "path": path, "body": body})
        if path == "/api/v1/scan" or path == "/api/v1/practice/scan":
            if self.live("robot") or self.live("sim"):
                return 409, {"error": "a session is running: end it before scanning"}
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
                return 409, {"error": "a robot and a practice session never run together; end the other first"}
            conf = body.get("confirm") or {}
            if slot == "robot" or practice:
                missing = [k for k in ("gantry", "estop", "remote", "rope") if not conf.get(k)]
                if missing:
                    return 400, {"error": "confirm first: " + ", ".join(missing)}
            start = tuple(body.get("start_offset") or OFFSET_SCENE)
            c = FakeConsole(self, slot, self.world, start_scene=start, profile=body.get("profile", "deploy"),
                            odom=body.get("odom", "fused"), practice=practice)
            self.slots[slot] = c
            self.sessions.insert(0, {"name": c.name, "practice": practice, "started": time.time()})
            return 200, {"ok": True, "slot": slot, "name": c.name}
        if path == "/api/v1/stop":
            c = self.live(body.get("slot", "robot"))
            if c and c.phase in ("PRESCAN", "RUN"):
                return 409, {"error": "the robot is walking: Stand or E-STOP first"}
            if c:
                c.ended = True
            return 200, {"ok": True}
        if path == "/api/v1/start_check":
            return 200, self.start_check(body.get("slot", "robot"), body.get("scan"))
        if path == "/api/v1/send_goal":
            slot = body.get("slot", "robot")
            c = self.live(slot)
            if c is None:
                return 404, {"error": "no session running"}
            if not body.get("check_id"):
                return 400, {"error": "send_goal needs the goal check's check_id"}
            chk = self.start_check(slot, body.get("scan"))
            if not chk.get("ok"):
                return 409, {"ok": False, "reason": chk.get("error"), "check": chk}
            goal_odom = apply(inverse(chk["scene_from_odom"]), body["goal_scene"]).tolist()
            self.goal_last = np.asarray(body["goal_scene"], dtype=float)
            res = c.act({"act": "goal_odom", "x": goal_odom[0], "y": goal_odom[1], "seq": c.goal_seq + 1,
                         "check_id": body["check_id"], "id": body.get("id"), "expect": body.get("expect")}, "studio")
            return (200 if res["ok"] else 409), {"ok": res["ok"], "reason": res["reason"], "check": chk,
                                                 "goal_odom": goal_odom, "act": res}
        if path == "/api/v1/rehearse":
            r = self.live("robot")
            if r and r.phase in ("PRESCAN", "RUN"):
                return 409, {"error": "the robot is walking"}
            if self.live("sim"):
                return 409, {"error": "a simulation is already running"}
            return 200, self.rehearse(body)
        if path == "/api/v1/act":
            c = self.live(body.get("slot", "robot"))
            if c is None:
                return 404, {"error": "no session running in this slot"}
            res = c.act(body, body.get("source", "studio"))
            return (200 if res.get("ok") else 409), res
        if path == "/api/v1/doctor":
            self.doctor = {"t": time.time(), "exit": 0, "text": "all checks passed (fake)"}
            return 200, self.doctor
        return 404, {"error": f"unknown {path}"}


def make_handler(handler_get, handler_post, token, delay=lambda: 0.0):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            data = json.dumps(obj, allow_nan=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _q(self):
            u = urlparse(self.path)
            return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

        def do_GET(self):
            path, q = self._q()
            if q.get("t") != token:
                return self._send(403, {"error": "token"})
            code, obj = handler_get(path, q)
            self._send(code, obj)

        def do_POST(self):
            path, q = self._q()
            if q.get("t") != token:
                return self._send(403, {"error": "token"})
            n = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except json.JSONDecodeError:
                return self._send(400, {"error": "json"})
            if delay():
                time.sleep(delay())
            code, obj = handler_post(path, body)
            self._send(code, obj)
    return H


def panel_server(console, port, token):
    """A console's own panel (GET /state, POST /act, `?t=TOKEN`), as panel.py serves it."""
    def get(path, q):
        return (200, console.state()) if path == "/state" else (404, {"error": f"unknown {path}"})

    def post(path, body):
        if path != "/act":
            return 404, {"ok": False}
        res = console.act(body, body.get("source", "panel"))
        return (200 if res.get("ok") else 409), res

    srv = None
    for attempt in range(50):  # the robot slot's fixed port: the previous console's panel may still be closing
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(get, post, token, lambda: console.panel_delay_s))
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
        parts = path.split("/")
        if path == "/api/v1/state":
            return 200, hub.state()
        if path == "/api/v1/readiness":
            return 200, hub.readiness(q.get("slot", "robot"))
        if path == "/api/v1/scan/live":
            return 200, hub.scan_live()
        if path.startswith("/api/v1/scan/") and path.endswith("/scene"):
            s = hub.scene(parts[4])
            return (200, s) if s else (404, {"error": "no such scan"})
        if path.startswith("/api/v1/live/") and path.endswith("/view"):
            c = hub.live(parts[4])
            if c is None:
                return 404, {"error": "no session running in this slot"}
            v = c.view(int(q.get("cloud_after", -1)), int(q.get("mem_after", -1)))
            if v.get("ok"):
                v["served_age_s"] = 0.05
                v["align"] = c.align()
            return 200, v
        if path.startswith("/api/v1/rehearsal/") and path.endswith("/track"):
            tr = hub.track(parts[4])
            return (200, tr) if tr else (404, {"error": "no such rehearsal run"})
        if path.startswith("/api/v1/session/") and path.endswith("/manifest"):
            return 200, hub.manifest(parts[4])
        if path.startswith("/api/v1/panel/") and path.endswith("/state"):
            c = hub.live(parts[4])
            return (200, c.state()) if c else (404, {"error": "no session running in this slot"})
        return 404, {"error": f"unknown {path}"}

    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(hub_get, hub.post, token))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def parse(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8779)
    ap.add_argument("--panel-port", type=int, default=8780, help="the robot slot console's panel (0: a free port)")
    ap.add_argument("--token", default="fake-token")
    ap.add_argument("--scan-dir", default=None, help="a kit scan directory (memory.npz + twin.json) instead of the room")
    ap.add_argument("--practice-only", action="store_true", help="no robot link (eno1 carrier down), as on a practice day")
    return ap.parse_args(argv)


def start(argv=None):
    """(hub, hub server) for in-process use."""
    args = parse(argv)
    hub = FakeHub(args)
    return hub, serve(hub, args.port, args.token)


def main(argv=None):
    hub, srv = start(argv)
    print(f"fake deploy hub on http://127.0.0.1:{srv.server_address[1]}/api/v1/state?t={hub.args.token}  "
          f"robot panel :{hub.args.panel_port}  day {hub.day}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
