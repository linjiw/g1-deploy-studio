#!/usr/bin/env python3
"""Protocol fixture for Studio's robot link. NOT a robot and NOT g1deploy/node.py.

It speaks the deploy PC's loopback wire formats so that `studio.robot_link` can be tested and
demonstrated without a robot. Every endpoint is a literal loopback address given on the command line.

  PUB  --odom-bind     `odom` with the LIO bridge's fields (pos, quat_wxyz, lin_w, ang_w = 0, stamp) at 50 Hz and,
                       on the same socket like the bridge's --forward-cloud, `cloud` (points [N,3] f32 in odom,
                       origin [3], stamp) at 10 Hz: a 360-degree ray fan cast against the arena's boxes and the floor
  PUB  --pose-bind     `pose`, SONIC protocol v1 packed by g1deploy.zmq_stream.pose_message (the source packer),
                       sent while walking as the node does on each plan; the joints are the default stand pose
  PUB  --debug-bind    optional `g1_debug` msgpack map (fixture values, the field names of the C++ writer)
  REP  --control-bind  node.py's ControlServer semantics: status | go | stand | goal (ahead, left from the current
                       pose) | quit, the status dict keys of node.py plus "fixture": true

Motion is a kinematic unicycle (at most --speed m/s): WAIT (until `go`, as the console's --wait-go) -> PRESCAN
(0.5 s) -> RUN -> ARRIVED within --goal-radius; `stand` -> STOPPED. There is no planner, no physics, no obstacle
avoidance, no robot body in the cloud and no DDS. The odom frame is the start pose (floor z = 0, yaw 0 = start
heading), as the bridge defines it; the arena is in Studio's world frame. Like the bridge, `odom` carries ang_w = 0.

Status semantics are node.py's: `standing` is true only in ARRIVED/STOPPED with no deferred stand; a `go` in
ARRIVED/STOPPED walks again and drops a deferred stand; `stand` applies in PRESCAN/RUN.

Fault and hazard injection (for Studio's tests and UI):
  --goal-error-m DX DY   every goal the control socket applies is offset (a readback mismatch)
  --odom-offset DX DY    the node's own odometry differs from the bridge's: status `xy` and `goal` are reported in a
                         frame shifted by (DX, DY), as a node started with `--odom leg` would (Studio must refuse goals)
  --defer-stand S        every stand issued while walking (arrival or `stand`) is deferred for S s, as node.py defers it
                         under a low ceiling: a fake overhead box (underside 1.25 m) appears 0.5 m ahead of the robot in
                         the cloud, the robot holds its pose, `standing` stays false, then the stand is issued

  .venv/bin/python tools/fake_node.py --odom-bind tcp://127.0.0.1:5561 --pose-bind tcp://127.0.0.1:5556 \
      --debug-bind tcp://127.0.0.1:5557 --control-bind tcp://127.0.0.1:5562 [--arena arena.json] [--goal 3 0]

For demos, `--press go|stand --control-connect tcp://127.0.0.1:5562` plays the operator's console key against a
running fixture. It first asks for the status and refuses unless the answer carries "fixture": true, which
node.py's status never does, so it cannot start a walk on a real node.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import signal
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = Path(os.environ.get("G1_STUDENT_DEPLOY") or "/home/linjiw/code/g1-student-deploy")
DT = 0.02
BANNER = ("fake_node: PROTOCOL FIXTURE - not a robot, not g1deploy/node.py. Loopback only. "
          "Kinematic unicycle; no planner, physics, robot body or DDS.")
# Studio world frame, start at the origin facing +x (used when no --arena is given).
DEMO_BOXES = [
    {"center_xy": [1.6, 1.0], "half_xy": [0.3, 0.3], "yaw": 0.0, "z_bottom": 0.0, "z_top": 0.45},
    {"center_xy": [2.6, -1.1], "half_xy": [0.2, 0.2], "yaw": 0.4, "z_bottom": 0.0, "z_top": 1.8},
    {"center_xy": [3.6, 0.0], "half_xy": [0.15, 1.4], "yaw": 0.0, "z_bottom": 1.45, "z_top": 1.7},
    {"center_xy": [5.5, 0.0], "half_xy": [0.1, 2.5], "yaw": 0.0, "z_bottom": 0.0, "z_top": 1.2},
]


def _source_modules():
    """The deploy repository's own packer, imported read-only (no bytecode written there)."""
    sys.dont_write_bytecode = True
    if str(DEPLOY) not in sys.path:
        sys.path.append(str(DEPLOY))
    from g1deploy import contract, zmq_stream
    return contract, zmq_stream


def emit(event, **kw):
    print(json.dumps({"event": event, "t": round(time.monotonic(), 3), "fixture": True, **kw}, default=float),
          flush=True)


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def quat_yaw(yaw):
    return [math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)]


def load_arena(spec):
    """(boxes, start (x, y, yaw) or None) from 'demo', 'none', a box list or a Studio arena document."""
    if spec in (None, "demo"):
        return [dict(b) for b in DEMO_BOXES], None
    if spec == "none":
        return [], None
    doc = json.loads(Path(spec).read_text())
    start = None
    if isinstance(doc, dict):
        boxes = doc.get("boxes", [])
        presets = doc.get("presets") or []
        if presets:
            p = presets[0]
            start = (float(p["start_xy"][0]), float(p["start_xy"][1]), float(p.get("start_yaw_rad", 0.0)))
    else:
        boxes = doc
    if not isinstance(boxes, list) or len(boxes) > 256:
        raise ValueError("arena boxes must be a list of at most 256 boxes")
    clean = []
    for b in boxes:
        box = {"center_xy": [float(v) for v in b["center_xy"]], "half_xy": [float(v) for v in b["half_xy"]],
               "yaw": float(b.get("yaw", 0.0)), "z_bottom": float(b["z_bottom"]), "z_top": float(b["z_top"])}
        values = box["center_xy"] + box["half_xy"] + [box["yaw"], box["z_bottom"], box["z_top"]]
        if (len(box["center_xy"]) != 2 or len(box["half_xy"]) != 2 or not all(map(math.isfinite, values))
                or min(box["half_xy"]) <= 0 or box["z_top"] <= box["z_bottom"]):
            raise ValueError(f"invalid box {b}")
        clean.append(box)
    return clean, start


class RayFan:
    """A 360-degree fan of rays (azimuth x elevation) cast against yawed boxes and the floor z = 0."""

    def __init__(self, np, boxes, az_step_deg=2.0, el_deg=(-52.0, 28.0), el_step_deg=4.0, max_range_m=8.0,
                 noise_m=0.01, seed=0):
        self.np, self.boxes, self.max_range, self.noise = np, boxes, max_range_m, noise_m
        az = np.deg2rad(np.arange(0.0, 360.0, az_step_deg))
        el = np.deg2rad(np.arange(el_deg[0], el_deg[1] + 1e-9, el_step_deg))
        a, e = np.meshgrid(az, el, indexing="ij")
        self.dirs = np.stack([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)], -1).reshape(-1, 3)
        self.rng = np.random.default_rng(seed)

    def cast(self, origin, heading):
        np = self.np
        c, s = math.cos(heading), math.sin(heading)
        d = self.dirs @ np.array([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]])  # rotate the fan with the robot
        o = np.asarray(origin, dtype=float)
        t = np.full(len(d), np.inf)
        with np.errstate(divide="ignore", invalid="ignore"):
            down = d[:, 2] < -1e-9
            t[down] = -o[2] / d[down, 2]
            for box in self.boxes:
                cy, sy = math.cos(box["yaw"]), math.sin(box["yaw"])
                rel = o[:2] - box["center_xy"]
                ol = np.array([cy * rel[0] + sy * rel[1], -sy * rel[0] + cy * rel[1], o[2]])
                dl = np.stack([cy * d[:, 0] + sy * d[:, 1], -sy * d[:, 0] + cy * d[:, 1], d[:, 2]], -1)
                lo = np.array([-box["half_xy"][0], -box["half_xy"][1], box["z_bottom"]])
                hi = np.array([box["half_xy"][0], box["half_xy"][1], box["z_top"]])
                t1, t2 = (lo - ol) / dl, (hi - ol) / dl
                tmin, tmax = np.minimum(t1, t2), np.maximum(t1, t2)
                parallel = np.abs(dl) < 1e-12  # inside the slab: no constraint; outside: never hits
                inside = (ol >= lo) & (ol <= hi)
                tmin = np.where(parallel, np.where(inside, -np.inf, np.inf), tmin)
                tmax = np.where(parallel, np.where(inside, np.inf, -np.inf), tmax)
                near, far = tmin.max(1), tmax.min(1)
                hit = (near <= far) & (near > 0)
                t = np.where(hit & (near < t), near, t)
        ok = np.isfinite(t) & (t > 0.1) & (t <= self.max_range)
        r = t[ok] + self.rng.normal(0.0, self.noise, int(ok.sum()))
        return o + d[ok] * r[:, None]


class FakeNode:
    def __init__(self, args):
        import numpy as np
        import zmq

        sys.path.insert(0, str(ROOT))
        from studio.recorder import validate_endpoint

        self.np, self.zmq, self.args = np, zmq, args
        self.C, self.zs = _source_modules()
        binds = {"odom": args.odom_bind, "pose": args.pose_bind, "debug": args.debug_bind, "control": args.control_bind}
        for name, bind in binds.items():
            if bind is not None:
                validate_endpoint(bind)
        self.boxes, arena_start = load_arena(args.arena)
        sx, sy, syaw = args.start if args.start is not None else (arena_start or (0.0, 0.0, 0.0))
        self.start = (float(sx), float(sy), float(syaw))
        self.fan = RayFan(np, self.boxes, seed=args.seed)
        ctx = zmq.Context.instance()
        self.ctx = ctx
        self.pub_odom = ctx.socket(zmq.PUB)
        self.pub_odom.setsockopt(zmq.LINGER, 0)
        self.pub_odom.setsockopt(zmq.SNDHWM, 64)
        self.pub_odom.bind(args.odom_bind)
        self.pub_pose = self._pub(args.pose_bind)
        self.pub_debug = self._pub(args.debug_bind)
        self.rep = ctx.socket(zmq.REP)
        self.rep.setsockopt(zmq.LINGER, 0)
        self.rep.bind(args.control_bind)
        # Robot state in the odom frame (the start pose is the origin).
        self.x, self.y, self.yaw, self.v = 0.0, 0.0, 0.0, 0.0
        self.goal = np.array([args.goal[0], args.goal[1]], dtype=float)  # --goal-frame start (bridge odom frame)
        self.goal_error = np.array(args.goal_error_m, dtype=float)
        self.odom_offset = np.array(args.odom_offset, dtype=float)  # the node's frame = bridge odom + this offset
        self.tick, self.phase, self.go_event = 0, "WAIT", False
        self.prescan_until = None
        self.active = False  # node.py's self.active: a plan (or a stand chunk) is playing
        self.pending_stand, self.defer_until = None, None
        self.commands, self.status = [], {"phase": "BOOT"}
        self.stop_flag = threading.Event()
        self.plans, self.clouds, self.last_cloud, self.debug_index = 0, 0, -1.0, 0
        self.last_plan_tick, self.stream_end = -10**9, -1

    def _pub(self, bind):
        if bind is None:
            return None
        sock = self.ctx.socket(self.zmq.PUB)
        sock.setsockopt(self.zmq.LINGER, 0)
        sock.setsockopt(self.zmq.SNDHWM, 16)
        sock.bind(bind)
        return sock

    # -- control socket (node.py ControlServer semantics) -------------------------------------------
    def control_loop(self):
        while not self.stop_flag.is_set():
            if not self.rep.poll(100):
                continue
            try:
                msg = json.loads(self.rep.recv())
                if not isinstance(msg, dict):
                    raise ValueError("expected a JSON object")
            except Exception as exc:  # malformed request: answer, never die
                self.rep.send_string(json.dumps({"ok": False, "error": str(exc)}))
                continue
            if msg.get("cmd") == "status":
                self.rep.send_string(json.dumps(self.status, default=float))
            else:
                self.commands.append(msg)
                self.rep.send_string(json.dumps({"ok": True, "queued": msg.get("cmd")}))

    def handle_commands(self):
        """node.py StudentNode.handle_commands, on the fixture's kinematic state."""
        np = self.np
        while self.commands:
            c = self.commands.pop(0)
            cmd = c.get("cmd")
            emit("command", cmd=cmd, args={k: v for k, v in c.items() if k != "cmd"})
            if cmd == "go":
                self.go_event = True
                if self.phase in ("ARRIVED", "STOPPED"):  # walk again from the stand
                    self.phase, self.prescan_until = "PRESCAN", self.tick + int(self.args.prescan_s / DT)
                    self.pending_stand, self.defer_until = None, None
                    emit("prescan")
            elif cmd == "stand" and self.phase in ("RUN", "PRESCAN"):
                self.phase = "STOPPED"
                if self.active:
                    self.stand("operator")
            elif cmd == "goal":
                yaw = self.yaw
                ahead, left = float(c.get("ahead", 0.0)), float(c.get("left", 0.0))
                self.goal = np.array([self.x, self.y]) + np.array([math.cos(yaw) * ahead - math.sin(yaw) * left,
                                                                   math.sin(yaw) * ahead + math.cos(yaw) * left])
                self.goal = self.goal + self.goal_error  # fault injection for readback tests (default 0)
                emit("goal", frame="current", goal_odom=(self.goal + self.odom_offset).tolist())
            elif cmd == "quit":
                if self.active and self.phase == "RUN":
                    self.stand("quit")
                return True
        return False

    # -- motion and streams ---------------------------------------------------------------------
    def stand(self, reason):
        """node.py stand(): deferred (--defer-stand) while a plan plays, else the settle chunk is streamed."""
        self.v = 0.0  # the fixture holds its pose at once (node.py plays the current plan out first)
        if self.args.defer_stand > 0 and self.pending_stand is None and self.defer_until is None and self.active:
            self.pending_stand = reason
            self.defer_until = self.tick + int(self.args.defer_stand / DT)
            heading = self.yaw + self.start[2]
            wx, wy = self.world(self.x, self.y)
            self.fan.boxes.append({"center_xy": [wx + 0.5 * math.cos(heading), wy + 0.5 * math.sin(heading)],
                                   "half_xy": [0.3, 0.3], "yaw": heading, "z_bottom": 1.25, "z_top": 1.4})
            emit("stand_deferred", reason=reason, tick=self.tick, seconds=self.args.defer_stand)
            return
        self.pending_stand, self.defer_until = None, None
        self.send_pose(stand=True)
        emit("stand", reason=reason, tick=self.tick)

    def send_pose(self, stand=False):
        np, n = self.np, 60
        self.active = True  # a plan (or the stand chunk) now plays, as node.py's self.active
        if not stand:
            self.plans += 1
        if self.pub_pose is None:
            return
        ticks = np.arange(self.tick, self.tick + n, dtype=np.int64)
        q = np.repeat(np.asarray(self.C.DEFAULT_MJ, dtype=np.float32)[None], n, 0)
        quat = np.repeat(np.asarray(quat_yaw(self.yaw), dtype=np.float32)[None], n, 0)
        msg = self.zs.pose_message(ticks, q, np.zeros_like(q), quat, timestamp=time.monotonic())
        self.pub_pose.send(msg)
        self.stream_end = int(ticks[-1])

    def world(self, x, y):
        sx, sy, syaw = self.start
        c, s = math.cos(syaw), math.sin(syaw)
        return sx + c * x - s * y, sy + s * x + c * y

    def send_cloud(self):
        np = self.np
        wx, wy = self.world(self.x, self.y)
        origin_w = np.array([wx, wy, self.args.lidar_height])
        pts_w = self.fan.cast(origin_w, self.yaw + self.start[2])
        sx, sy, syaw = self.start
        c, s = math.cos(syaw), math.sin(syaw)
        rel = pts_w[:, :2] - [sx, sy]
        pts = np.column_stack([c * rel[:, 0] + s * rel[:, 1], -s * rel[:, 0] + c * rel[:, 1], pts_w[:, 2]])
        origin = np.array([self.x, self.y, self.args.lidar_height])
        self.pub_odom.send(self.zs.pack([("points", pts.astype(np.float32)), ("origin", origin),
                                         ("stamp", np.array([time.monotonic()]))], topic=b"cloud"))
        self.clouds += 1
        self.last_cloud = time.monotonic()

    def send_odom(self):
        np = self.np
        vel = np.array([self.v * math.cos(self.yaw), self.v * math.sin(self.yaw), 0.0])
        self.pub_odom.send(self.zs.pack([("pos", np.array([self.x, self.y, self.args.pelvis_z])),
                                         ("quat_wxyz", np.array(quat_yaw(self.yaw))), ("lin_w", vel),
                                         ("ang_w", np.zeros(3)), ("stamp", np.array([time.monotonic()]))],
                                        topic=b"odom"))

    def send_debug(self):
        if self.pub_debug is None:
            return
        import msgpack

        q = [float(v) for v in self.C.DEFAULT_MJ]
        if self.phase == "RUN":  # a visible swing of the hips while "walking" (fixture values)
            phase = self.tick * DT * 2 * math.pi * 1.6
            q[0] += 0.3 * math.sin(phase)
            q[6] -= 0.3 * math.sin(phase)
        self.debug_index += 1
        fields = {"index": self.debug_index, "ros_timestamp": 0.0, "body_q": q, "body_q_measured": q,
                  "body_dq": [0.0] * 29, "last_action": q, "base_quat": quat_yaw(self.yaw),
                  "base_trans_measured": [0, -1, 0.793], "token_state": [], "fixture": True}
        self.pub_debug.send(b"g1_debug" + msgpack.packb(fields))

    def walk(self):
        np = self.np
        d = self.goal - [self.x, self.y]
        err = wrap(math.atan2(d[1], d[0]) - self.yaw)
        self.yaw = wrap(self.yaw + max(-1.5, min(1.5, 3.0 * err)) * DT)
        self.v = self.args.speed * max(0.0, math.cos(err)) * min(1.0, float(np.linalg.norm(d)) / 0.5 + 0.2)
        self.x += self.v * math.cos(self.yaw) * DT
        self.y += self.v * math.sin(self.yaw) * DT

    def update_status(self):
        np = self.np
        cloud_age = time.monotonic() - self.last_cloud if self.last_cloud > 0 else 1e9
        node_xy = np.array([self.x, self.y]) + self.odom_offset  # the node's own odometry frame
        self.status = dict(phase=self.phase, tick=self.tick, goal=(self.goal + self.odom_offset).tolist(),
                           goal_dist_m=float(np.linalg.norm([self.x - self.goal[0], self.y - self.goal[1]])),
                           pelvis_z_m=self.args.pelvis_z, tilt_rad=0.0, xy=node_xy.tolist(), plans=self.plans,
                           latency_s=0.05 if self.plans else None, latency_est_s=0.3, cloud_age_s=float(cloud_age),
                           lidar_frames=self.clouds, overruns=0, rule="fixture" if self.plans else None,
                           stream_ahead=int(self.stream_end - self.tick) if self.stream_end >= 0 else None,
                           standing=self.pending_stand is None and self.phase in ("ARRIVED", "STOPPED"), fixture=True)

    def run(self):
        threading.Thread(target=self.control_loop, daemon=True).start()
        t0 = time.monotonic()
        boot_ticks = int(self.args.boot_s / DT)
        emit("node_up", fixture=True, goal=self.goal.tolist())
        while not self.stop_flag.is_set():
            tick_t = t0 + self.tick * DT
            if (rest := tick_t - time.monotonic()) > 0:
                time.sleep(rest)
            if self.tick % 5 == 0 and not self.args.no_cloud:
                self.send_cloud()
            self.send_odom()
            self.send_debug()
            if self.tick < boot_ticks:  # node.py answers {"phase": "BOOT"} until it has robot state
                self.tick += 1
                continue
            if self.handle_commands():
                emit("node_exit", result="quit")
                return "quit"
            self.update_status()
            if self.phase == "WAIT" and self.go_event:
                self.phase, self.prescan_until = "PRESCAN", self.tick + int(self.args.prescan_s / DT)
                emit("prescan")
            elif self.phase == "PRESCAN" and self.tick >= self.prescan_until:
                self.phase = "RUN"
                emit("run", tick=self.tick)
            elif self.phase == "RUN":
                self.walk()
                if self.tick - self.last_plan_tick >= 10:
                    self.send_pose()
                    self.last_plan_tick = self.tick
                if float(self.np.linalg.norm(self.goal - [self.x, self.y])) <= self.args.goal_radius and self.active:
                    self.phase = "ARRIVED"
                    emit("arrived", tick=self.tick)
                    self.stand("arrived")
            if self.pending_stand is not None and self.tick >= self.defer_until:  # the fake ceiling "clears"
                self.stand(self.pending_stand)
            self.tick += 1
        return "stopped"

    def close(self):
        self.stop_flag.set()
        for sock in (self.pub_odom, self.pub_pose, self.pub_debug, self.rep):
            if sock is not None:
                sock.close(0)


def press(endpoint, cmd, timeout_s=1.0):
    """The operator's key for a demo: only against an endpoint whose status says fixture: true."""
    import zmq

    sock = zmq.Context.instance().socket(zmq.REQ)
    sock.setsockopt(zmq.LINGER, 0)
    sock.setsockopt(zmq.RCVTIMEO, int(timeout_s * 1000))
    sock.connect(endpoint)
    try:
        sock.send_string(json.dumps({"cmd": "status"}))
        status = json.loads(sock.recv())
        if not isinstance(status, dict) or status.get("fixture") is not True:
            print(f"fake_node --press: refused, {endpoint} does not report fixture: true (not this fixture)",
                  file=sys.stderr)
            return 2
        sock.send_string(json.dumps({"cmd": cmd}))
        print(sock.recv().decode())
        return 0
    except zmq.Again:
        print(f"fake_node --press: no reply from {endpoint}", file=sys.stderr)
        return 2
    finally:
        sock.close(0)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--press", choices=("go", "stand"), default=None,
                    help="demo operator key: send it to --control-connect if that endpoint is this fixture")
    ap.add_argument("--control-connect", default=None, help="with --press: the fixture's control endpoint")
    ap.add_argument("--odom-bind", help="PUB for `odom` and `cloud` (the bridge's socket)")
    ap.add_argument("--pose-bind", default=None, help="PUB for `pose` (node.py --stream-bind)")
    ap.add_argument("--debug-bind", default=None, help="PUB for `g1_debug` (the runner's output)")
    ap.add_argument("--control-bind", help="REP (node.py --control)")
    ap.add_argument("--arena", default="demo", help="'demo', 'none', a JSON box list or a Studio arena document")
    ap.add_argument("--start", type=float, nargs=3, default=None, metavar=("X", "Y", "YAW"),
                    help="start pose in the arena frame (default: the arena's first preset, else the origin)")
    ap.add_argument("--goal", type=float, nargs=2, default=(2.0, 0.0), metavar=("AHEAD", "LEFT"),
                    help="initial goal relative to the start pose (as the console's --goal-frame start)")
    ap.add_argument("--speed", type=float, default=0.7)
    ap.add_argument("--goal-radius", type=float, default=0.4)
    ap.add_argument("--prescan-s", type=float, default=0.5)
    ap.add_argument("--boot-s", type=float, default=0.2)
    ap.add_argument("--pelvis-z", type=float, default=0.78)
    ap.add_argument("--lidar-height", type=float, default=1.2)
    ap.add_argument("--no-cloud", action="store_true")
    ap.add_argument("--goal-error-m", type=float, nargs=2, default=(0.0, 0.0), metavar=("DX", "DY"),
                    help="fault injection: offset added to every goal the control socket applies")
    ap.add_argument("--odom-offset", type=float, nargs=2, default=(0.0, 0.0), metavar=("DX", "DY"),
                    help="fault injection: the node's odometry frame differs from the bridge's by this offset")
    ap.add_argument("--defer-stand", type=float, default=0.0, metavar="S",
                    help="hazard: defer every stand issued while walking for S s (a fake low ceiling)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)
    if args.press:
        sys.path.insert(0, str(ROOT))
        from studio.recorder import validate_endpoint

        try:
            validate_endpoint(args.control_connect or "")
        except ValueError as exc:
            ap.error(f"--press needs a loopback --control-connect: {exc}")
        return press(args.control_connect, args.press)
    if not args.odom_bind or not args.control_bind:
        ap.error("--odom-bind and --control-bind are required")
    if not 0 < args.speed <= 0.7:
        ap.error("--speed must be in (0, 0.7] m/s")
    if not 0 <= args.defer_stand <= 120:
        ap.error("--defer-stand must be in [0, 120] s")
    print(BANNER, file=sys.stderr, flush=True)
    print(f"fake_node: odom/cloud {args.odom_bind}  pose {args.pose_bind}  g1_debug {args.debug_bind}  "
          f"control {args.control_bind}", file=sys.stderr, flush=True)
    node = FakeNode(args)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: node.stop_flag.set())
    try:
        node.run()
    finally:
        node.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
