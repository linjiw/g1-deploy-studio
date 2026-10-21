"""studio.robot_link against tools/fake_node.py (a protocol fixture, not a robot) on loopback only.

The fixture packs `odom`/`cloud`/`pose` with g1-student-deploy's own zmq_stream.pack and serves node.py's control
semantics. The scenario plays the operator: it presses Go on the fixture's control socket itself, because the
link must never send it.
"""
import json
import math
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import numpy as np

from studio.protocols import decode_packed_topic
from studio.robot_link import (GO_NOTE, MAP_LABEL, MAX_SESSION_BYTES, NODE_COMMANDS, PENDING_STAND_NOTE, ConfigError,
                               ControlRequest, DisplayMap, RobotLink, goal_to_ahead_left, load_config)

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = Path(os.environ.get("G1_STUDENT_DEPLOY") or "/home/linjiw/code/g1-student-deploy")
HAVE_SOURCE = (DEPLOY / "g1deploy/zmq_stream.py").is_file()
PY = sys.executable
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=str(ROOT))
CHECKED = {"ok": True, "checks": [], "note": "test: checked by the gateway"}  # what the gateway attaches when it passes
READY_IDS = ["node_status", "odometry", "frame", "still", "goal_verified", "goal_range", "stand"]


def quat(yaw):
    return [math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)]


def free_ports(n):
    socks = [socket.socket() for _ in range(n)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        return [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()


class ConfigTests(unittest.TestCase):
    GOOD = {"odom": "tcp://127.0.0.1:5561", "control": "tcp://127.0.0.1:5562"}

    def test_loopback_endpoints_only(self):
        self.assertEqual(load_config({"endpoints": self.GOOD})["endpoints"], self.GOOD)
        for key in ("odom", "cloud", "pose", "debug", "control"):
            for bad in ("tcp://192.168.123.164:5562", "tcp://localhost:5562", "tcp://0.0.0.0:5562",
                        "tcp://*:5562", "ipc:///tmp/node", "tcp://127.0.0.1:5562/x"):
                with self.subTest(key=key, endpoint=bad), self.assertRaises(ConfigError):
                    load_config({"endpoints": dict(self.GOOD, **{key: bad})})

    def test_unknown_keys_missing_endpoints_and_bad_limits_refused(self):
        for doc in ({"endpoints": {"odom": self.GOOD["odom"]}}, {"endpoints": dict(self.GOOD, lowcmd="tcp://127.0.0.1:1")},
                    {"endpoints": self.GOOD, "dds": True}, {"endpoints": self.GOOD, "limits": {"status_period_s": 0}},
                    {"endpoints": self.GOOD, "limits": {"readback_tolerance_m": True}},
                    {"endpoints": self.GOOD, "limits": {"go": 1}}, [], {"endpoints": self.GOOD, "capture": {"topics": ["lowcmd"]}}):
            with self.subTest(doc=doc), self.assertRaises(ConfigError):
                load_config(doc)

    def test_defaults_match_the_planner_memory_and_the_gateway_output_cap(self):
        cfg = load_config({"endpoints": self.GOOD, "capture": {"topics": ["odom"]}})
        lim = cfg["limits"]
        self.assertEqual((lim["map_half_extent_m"], lim["memory_half_extent_m"]), (6.0, 6.0))  # 12 x 12 m memory
        self.assertEqual(lim["max_goal_distance_m"], 3.0)
        self.assertEqual((lim["frame_tolerance_m"], lim["still_speed_mps"], lim["still_yaw_rate_rad_s"],
                          lim["still_for_s"], lim["phase_dwell_s"]), (0.10, 0.05, 0.05, 0.5, 1.0))
        self.assertLessEqual(cfg["capture"]["max_bytes"], 64 * 1024 * 1024)
        self.assertLessEqual(MAX_SESSION_BYTES, 60 * 1024 * 1024)
        for limits in ({"max_goal_distance_m": 0.4}, {"max_goal_distance_m": 12.5},
                       {"map_half_extent_m": 31}, {"map_half_extent_m": 20, "map_res_m": 0.02}):  # > 1201 cells a side
            with self.subTest(limits=limits), self.assertRaises(ConfigError):
                load_config({"endpoints": self.GOOD, "limits": limits})
        with self.assertRaises(ConfigError):
            load_config({"endpoints": self.GOOD, "capture": {"max_bytes": 129 * 1024 * 1024}})
        self.assertEqual(load_config({"endpoints": self.GOOD, "limits": {"map_half_extent_m": 30.0}})["limits"]
                         ["map_half_extent_m"], 30.0)  # 1201 cells at 5 cm: what goal_check loads

    def test_cli_refuses_a_non_loopback_config_without_connecting(self):
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "link.json"
            config.write_text(json.dumps({"endpoints": dict(self.GOOD, control="tcp://192.168.123.10:5562")}))
            out = Path(temp) / "run"
            proc = subprocess.run([PY, "-m", "studio.robot_link", "--config", str(config), "--output", str(out)],
                                  cwd=ROOT, env=ENV, capture_output=True, timeout=20)
            self.assertEqual(proc.returncode, 2)
            result = json.loads((out / "result.json").read_text())
            self.assertEqual(result["status"], "failed")
            self.assertIn("config refused", result["error"])
            self.assertFalse(result["hardware_enabled"])
            self.assertFalse((out / "latest.json").exists())


class CommandPathTests(unittest.TestCase):
    def test_only_status_goal_and_stand_can_reach_the_node(self):
        self.assertEqual(NODE_COMMANDS, frozenset({"status", "goal", "stand"}))
        for cmd in ("go", "quit", "estop", None):
            with self.subTest(cmd=cmd), self.assertRaises(ValueError):
                ControlRequest({"cmd": cmd}, 1.0)
        source = (ROOT / "studio/robot_link.py").read_text()
        for forbidden in ("zmq.PUB", "zmq.PUSH", "ChannelPublisher", "unitree_sdk2py", "bind("):
            self.assertNotIn(forbidden, source)

    def test_goal_conversion_inverts_the_node_formula(self):
        rng = np.random.default_rng(1)
        for _ in range(100):
            xy, goal = rng.uniform(-6, 6, 2), rng.uniform(-6, 6, 2)
            yaw = rng.uniform(-math.pi, math.pi)
            quat = [math.cos(yaw / 2), 0.0, 0.0, math.sin(yaw / 2)]
            ahead, left = goal_to_ahead_left(xy, quat, goal)
            # node.py handle_commands, verbatim arithmetic
            back = xy + np.array([math.cos(yaw) * ahead - math.sin(yaw) * left, math.sin(yaw) * ahead + math.cos(yaw) * left])
            np.testing.assert_allclose(back, goal, atol=1e-12)

    @unittest.skipUnless((DEPLOY / "g1deploy/node.py").is_file(), "g1-student-deploy reference not present")
    def test_goal_conversion_against_the_actual_node_handle_commands(self):
        # Imports node.py read-only (no bytecode written there) and runs its own handle_commands on a stand-in.
        script = r'''
import contextlib, io, json, math, os, sys, types
sys.dont_write_bytecode = True
sys.path.append(os.environ.get("G1_STUDENT_DEPLOY") or "/home/linjiw/code/g1-student-deploy")
import numpy as np
from g1deploy.node import StudentNode
from studio.robot_link import goal_to_ahead_left
rng = np.random.default_rng(3)
worst = 0.0
for _ in range(200):
    pos, goal = rng.uniform(-5, 5, 2), rng.uniform(-8, 8, 2)
    q = rng.normal(size=4) * [1, 0.05, 0.05, 1]
    q /= np.linalg.norm(q)
    qpos = np.r_[pos, 0.78, q, np.zeros(29)]
    ahead, left = goal_to_ahead_left(pos, q, goal)
    node = types.SimpleNamespace(commands=[{"cmd": "goal", "ahead": ahead, "left": left}], navigation_generation=0,
                                 goal=None, phase="WAIT", tick=0, streamer=None)
    with contextlib.redirect_stdout(io.StringIO()):
        StudentNode.handle_commands(node, qpos, None)
    worst = max(worst, float(np.linalg.norm(node.goal - goal)))
print(json.dumps({"worst": worst}))
'''
        proc = subprocess.run([PY, "-c", script], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertLess(json.loads(proc.stdout.strip().splitlines()[-1])["worst"], 1e-9)


class DisplayMapTests(unittest.TestCase):
    def cell(self, m, x, y):
        return int(round((x - m.lo[0]) / m.res)), int(round((y - m.lo[1]) / m.res))

    def test_cloud_memory_rules_on_raw_points(self):
        m = DisplayMap([0.0, 0.0], half_extent_m=5.0, res=0.05, range_m=4.0)
        origin = np.array([0.0, 0.0, 1.2])
        pts = [[1.0, 0.0, 0.01], [1.0, 0.0, 0.02],  # ground
               [0.5, 0.5, 0.3], [0.5, 0.5, 0.45], [0.5, 0.5, 1.0],  # a low obstacle (support = max z of the cell)
               # overhead above floor; returns are binned 3.5 cm past the surface along the ray (-x here)
               [-0.983, 0.0, 1.5], [-0.983, 0.0, 1.62], [-1.0, 0.0, 0.0],
               [0.0, -1.0, 2.5],  # room ceiling: ignored
               [3.5, 0.0, 0.0],  # ground inside the 4 m range
               [3.9, 0.0, 0.0]]  # beyond 4 m from the sensor: gated
        m.add(np.array(pts), origin, 1.0)
        self.assertEqual(m.support[self.cell(m, 1.0, 0.0)], 0.0)
        self.assertAlmostEqual(m.support[self.cell(m, 0.5, 0.5)], 1.0)
        self.assertTrue(math.isnan(m.ceiling[self.cell(m, 0.5, 0.5)]))
        self.assertAlmostEqual(m.ceiling[self.cell(m, -1.0, 0.0)], 1.5)
        self.assertEqual(m.support[self.cell(m, -1.0, 0.0)], 0.0)
        self.assertTrue(math.isnan(m.support[self.cell(m, 0.0, -1.0)]))
        self.assertEqual(m.support[self.cell(m, 3.5, 0.0)], 0.0)
        self.assertTrue(math.isnan(m.support[self.cell(m, 3.9, 0.0)]))
        observed = np.isfinite(m.support) | np.isfinite(m.ceiling)
        self.assertEqual(int(observed.sum()), 4)  # everything else stays unknown, never zero
        self.assertEqual(m.stats["range_gated"], 1)
        self.assertEqual(m.stats["above_band"], 1)
        # Fusion over scans: support keeps the max, ceiling the min.
        m.add(np.array([[0.5, 0.5, 0.2], [-0.983, 0.0, 1.45]]), origin, 2.0)
        self.assertAlmostEqual(m.support[self.cell(m, 0.5, 0.5)], 1.0)
        self.assertAlmostEqual(m.ceiling[self.cell(m, -1.0, 0.0)], 1.45)
        self.assertEqual(m.version, 2)
        self.assertEqual(m.describe()["label"], MAP_LABEL)
        self.assertFalse(m.describe()["planner_uses_this_map"])


class LinkLogicTests(unittest.TestCase):
    """The link's state machines on synthetic inputs: no sockets, no threads (RobotLink is not run)."""

    ENDPOINTS = {"odom": "tcp://127.0.0.1:5561", "cloud": "tcp://127.0.0.1:5561", "control": "tcp://127.0.0.1:5562"}

    def make(self, **limits):
        temp = tempfile.mkdtemp(prefix="robot-link-logic-")
        self.addCleanup(shutil.rmtree, temp, ignore_errors=True)
        link = RobotLink(load_config({"endpoints": self.ENDPOINTS, "limits": limits}), Path(temp) / "run")
        link._odom_fresh = lambda: True  # receipts below are synthetic times; freshness is tested with the fixture
        return link

    def feed(self, link, samples, start):
        """samples: (dt from start, x, y, yaw, wire lin_w, stamp or None)."""
        for dt, x, y, yaw, lin, stamp in samples:
            link._on_odom([x, y, 0.78], quat(yaw), lin, [0.0, 0.0, 0.0], stamp, start + dt)

    def test_stillness_uses_the_pose_not_only_the_wire_velocity(self):
        link = self.make()
        t0 = 1000.0
        # 1 s walking at 0.3 m/s while the wire says lin_w = ang_w = 0 (never measured), then 2 s standing.
        walk = [(0.02 * k, 0.3 * min(0.02 * k, 1.0), 0.0, 0.0, [0.0, 0.0, 0.0], 0.02 * k) for k in range(40)]
        self.feed(link, walk, t0)
        self.assertIsNone(link.still_since)
        self.assertAlmostEqual(link.motion["speed_mps"], 0.3, places=2)
        ok, why, _, _ = link._still_state(t0 + 0.8)
        self.assertFalse(ok)
        self.assertIn("moving (0.30 m/s", why)
        stand = [(0.02 * k, 0.3, 0.0, 0.0, [0.0, 0.0, 0.0], 0.02 * k) for k in range(51, 150)]
        self.feed(link, stand, t0)
        self.assertIsNotNone(link.still_since)
        self.assertGreater(link.still_since, t0 + 1.0 + 0.2 - 1e-9)  # the 0.2 s difference window must clear first
        link.phase_prev, link.phase_change_mono = "ARRIVED", t0 + 2.5
        ok, why, _, _ = link._still_state(t0 + 2.98)
        self.assertFalse(ok)
        self.assertIn("phase changed to ARRIVED 0.5 s ago (needs 1.0 s)", why)
        link.phase_change_mono = t0 + 1.0
        ok, why, held, _ = link._still_state(t0 + 2.98)
        self.assertTrue(ok, why)
        self.assertGreater(held, 1.0)
        # A turn in place at 0.5 rad/s with ang_w = 0 on the wire is not still either.
        turn = [(3.0 + 0.02 * k, 0.3, 0.0, 0.5 * 0.02 * k, [0.0, 0.0, 0.0], 3.0 + 0.02 * k) for k in range(30)]
        self.feed(link, turn, t0)
        self.assertIsNone(link.still_since)
        self.assertAlmostEqual(link.motion["yaw_rate_rad_s"], 0.5, places=2)
        # A wire velocity above the limit is enough on its own.
        self.feed(link, [(4.0 + 0.02 * k, 0.3, 0.0, 0.29, [0.08, 0.0, 0.0], 4.0 + 0.02 * k) for k in range(40)], t0)
        self.assertIsNone(link.still_since)
        self.assertGreaterEqual(link.motion["speed_mps"], 0.08)

    def test_odometry_resets_recentre_the_map_and_the_assumed_memory(self):
        link = self.make()
        t0 = 2000.0
        self.feed(link, [(0.02 * k, 0.0, 0.0, 0.0, [0.0] * 3, 10.0 + 0.02 * k) for k in range(10)], t0)
        self.assertEqual(link.memory_origin["xy"], [0.0, 0.0])
        first_map, version = link.map, link.map.version
        # 1. the bridge stamp goes backwards
        self.feed(link, [(0.2, 0.05, 0.0, 0.0, [0.0] * 3, 1.0)], t0)
        self.assertEqual(link.odom_resets, 1)
        self.assertIsNot(link.map, first_map)
        self.assertGreater(link.map.version, version)  # map seq never goes back
        # 2. a jump > 0.5 m between samples < 0.2 s apart
        self.feed(link, [(0.22, 2.0, 1.0, 0.0, [0.0] * 3, 1.02)], t0)
        self.assertEqual(link.odom_resets, 2)
        self.assertEqual(link.memory_origin["xy"], [2.0, 1.0])
        self.assertEqual(link.map.center, [2.0, 1.0])
        np.testing.assert_allclose(link.map.lo, [-4.0, -5.0])
        # a 0.3 m step is not a reset; neither is a jump after a 1 s gap without a transport reconnect
        self.feed(link, [(0.24, 2.3, 1.0, 0.0, [0.0] * 3, 1.04), (1.24, 3.1, 1.0, 0.0, [0.0] * 3, 2.04)], t0)
        self.assertEqual(link.odom_resets, 2)
        # 3. the transport reconnected after an outage (set by the receive thread's ZMQ monitor)
        link.odom_reconnected = True
        self.feed(link, [(3.0, 0.0, 0.0, 0.0, [0.0] * 3, 5.0)], t0)
        self.assertEqual(link.odom_resets, 3)
        self.assertFalse(link.odom_reconnected)
        self.assertEqual(link.memory_origin["xy"], [0.0, 0.0])
        events = [e["type"] for e in link.events]
        self.assertEqual(events.count("odom_reset"), 3)
        self.assertIn("odom_jump", events)
        self.assertAlmostEqual(link.path_m, 0.3, places=6)  # jumps and resets are not walked distance
        nav = link._navigation()
        self.assertEqual((nav["map"]["reset_count"], nav["memory"]["reset_count"], nav["odom_resets"]), (3, 3, 3))
        self.assertIn("re-centred after an odometry reset", nav["memory"]["note"])

    def test_node_frame_check_and_goal_range(self):
        link = self.make()
        now = time.monotonic()
        self.feed(link, [(-0.2 + 0.02 * k, 1.0, 0.0, 0.0, [0.0] * 3, None) for k in range(11)], now)
        status = {"phase": "WAIT", "tick": 50, "xy": [1.04, 0.0], "goal": [3.0, 0.0], "standing": False}
        with link.lock:
            link.status, link.status_mono = status, now
            link._check_frame(status, now - 0.001, now)
        self.assertEqual(link._frame_state()[:2], (True, None))
        status = dict(status, xy=[1.6, 0.5])  # a node on leg odometry: its own frame
        with link.lock:
            link.status, link.status_mono = status, now
            link._check_frame(status, now - 0.001, now)
        ok, why, _ = link._frame_state()
        self.assertFalse(ok)
        self.assertIn("not the LIO bridge's", why)
        self.assertIn("--odom zmq", why)
        self.assertAlmostEqual(link.frame_check["offset_m"], math.hypot(0.6, 0.5), places=6)
        with link.lock:
            link.status_mono = now + 0.001  # a newer status not compared yet: unknown, not healthy
        self.assertEqual(link._frame_state()[0], None)
        # Goal range: the ladder's distance limit and the assumed 12 x 12 m memory around the first pose (1, 0).
        self.assertEqual(link._goal_range([3.9, 0.0], [1.0, 0.0]), (True, None))
        ok, why = link._goal_range([4.1, 0.0], [1.0, 0.0])
        self.assertFalse(ok)
        self.assertIn("limit is 3.0 m", why)
        ok, why = link._goal_range([1.0, 5.6], [1.0, 3.0])
        self.assertFalse(ok)
        self.assertIn("outside the node's memory", why)
        self.assertEqual(link._goal_range([1.0, 5.4], [1.0, 3.0]), (True, None))

    def test_goal_provenance_external_verified_console_change_and_node_restart(self):
        link = self.make()

        def status(**fields):  # as the control thread stores a node status reply
            with link.lock:
                link._note_instance(fields)
                link.status, link.status_mono = fields, time.monotonic()
            link._track_status()
            return link._goal_view(link.status, True)

        goal, warning = status(phase="WAIT", tick=10, goal=[3.5, -0.05])
        self.assertEqual((goal["verification"], goal["seq"]), ("external", None))
        self.assertIn("launch goal (3.50, -0.05)", warning)
        # Studio verified command 3 at (1, 0) on this node.
        link.staged_on_node = 1
        link.goal_record = {"seq": 3, "xy": [1.0, 0.0], "readback": [1.0, 0.01], "error_m": 0.01, "time_s": 1.0}
        goal, warning = status(phase="WAIT", tick=20, goal=[1.0, 0.01])
        self.assertEqual((goal["verification"], goal["seq"], warning), ("verified", 3, None))
        # The console's n changes it: unverified, with a warning that says not to press g.
        goal, warning = status(phase="WAIT", tick=30, goal=[1.5, 0.0])
        self.assertEqual(goal["verification"], "unverified")
        self.assertIn("changed outside Studio after command 3", goal["detail"])
        self.assertEqual(warning, "The node holds an UNVERIFIED goal (1.50, 0.00): do not press g; stage a new goal from Studio.")
        self.assertIn("node_goal", [e["type"] for e in link.events])
        # The node restarts (its tick goes back): Studio staged nothing on the new instance.
        goal, warning = status(phase="WAIT", tick=2, goal=[3.5, -0.05])
        self.assertEqual(link.node_instance, 2)
        self.assertEqual(goal["verification"], "external")
        self.assertIn("node_restart", [e["type"] for e in link.events])
        # A console goal on a node Studio never staged on is external too, and says so.
        goal, warning = status(phase="WAIT", tick=5, goal=[2.0, 1.0])
        self.assertEqual(goal["verification"], "external")
        self.assertIn("set outside Studio", warning)
        # BOOT after running is a restart too.
        status(phase="BOOT")
        self.assertEqual(link.node_instance, 3)


class RecordingBoundTests(unittest.TestCase):
    def test_a_long_session_is_bounded_and_finalized_quickly(self):
        # 20000 frames / 200 snapshots: the default in-memory bounds. 60000 / 1000: a configured longer session;
        # finalize costs what the 60 MiB recording costs, not what the session held.
        for frames, snapshots in ((20000, 200), (60000, 1000)):
            with self.subTest(frames=frames, snapshots=snapshots):
                self.check_bound(frames, snapshots)

    def check_bound(self, n_frames, n_snapshots):
        temp = tempfile.mkdtemp(prefix="robot-link-bound-")
        self.addCleanup(shutil.rmtree, temp, ignore_errors=True)
        cfg = load_config({"endpoints": LinkLogicTests.ENDPOINTS})
        link = RobotLink(cfg, Path(temp) / "run")
        joints = [0.1 + 1e-7 * i for i in range(29)]
        link.debug = {"t": 0.0, "joints": joints, "velocity": joints, "sequence": 1, "temperature": None}
        link.pose = {"t": 0.0, "classification": "commanded", "joints": joints, "quaternion_wxyz": quat(0.1),
                     "position": None, "frame_index_first": 1, "frame_index_last": 60, "frames": 60,
                     "source_timestamp": 1.0, "frame_id": "odom"}
        link._on_odom([0.123456789, 0.987654321, 0.78], quat(0.3), [0.1, 0.2, 0.0], [0.0] * 3, 1.0, link.t0)
        frame = link._frame(0.0, live=False)
        link.frames = [dict(frame, time=0.02 * k, sequence=k) for k in range(n_frames)]
        pts = [[0.123 * i, 0.456, 0.789] for i in range(2000)]
        snap = {"available": True, "kind": "map-snapshot", "label": MAP_LABEL, "raw_lidar": pts[:1000],
                "support_points": pts, "ceiling_points": pts}
        link.snapshots = [dict(snap, time=0.02 * n_frames / n_snapshots * k) for k in range(n_snapshots)]
        size = len(json.dumps(link.frames[:100])) * n_frames / 100 + len(json.dumps(link.snapshots[:10])) * n_snapshots / 10
        self.assertGreater(size, 1.2 * MAX_SESSION_BYTES)
        started = time.monotonic()
        result = link.finalize()
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0)
        self.assertLess(result["report"]["finalize_s"], 5.0)
        body = (Path(temp) / "run/session.json").read_bytes()
        self.assertLessEqual(len(body), MAX_SESSION_BYTES)
        session = json.loads(body)
        meta = session["metadata"]["frame_decimation"]
        self.assertGreater(meta["session_snapshot_stride"] * meta["session_frame_stride"], 1)
        self.assertEqual(len(session["frames"]), result["report"]["frames"])
        self.assertEqual(len(session["trajectory"]), len(session["frames"]))
        self.assertGreaterEqual(len(session["perception"]["frames"]), 10)
        indices = [f["perception_index"] for f in session["frames"]]
        self.assertTrue(all(i is None or 0 <= i < len(session["perception"]["frames"]) for i in indices))
        k = len(session["frames"]) // 2  # perception_index points at the newest snapshot at or before the frame
        snap_times = [s["time"] for s in session["perception"]["frames"]]
        self.assertLessEqual(snap_times[indices[k]], session["frames"][k]["time"])
        self.assertTrue(all(f["navigation"] == {"phase": None, "walk": None, "goal_xy": None}
                            for f in session["frames"][:5]))
        self.assertEqual(result["status"], "completed")


class FixtureGeometryTests(unittest.TestCase):
    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("_fake_node_under_test", ROOT / "tools/fake_node.py")
        self.fake = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.fake)

    def test_ray_fan_hits_boxes_and_floor_only(self):
        box = {"center_xy": [2.0, 0.0], "half_xy": [0.1, 1.0], "yaw": 0.0, "z_bottom": 0.0, "z_top": 1.0}
        beam = {"center_xy": [-2.0, 0.0], "half_xy": [0.2, 1.0], "yaw": 0.3, "z_bottom": 1.5, "z_top": 1.7}
        fan = self.fake.RayFan(np, [box, beam], noise_m=0.0)
        pts = fan.cast([0.0, 0.0, 1.2], 0.0)
        self.assertGreater(len(pts), 1000)

        def surface(b, eps=1e-6):
            c, s = np.cos(b["yaw"]), np.sin(b["yaw"])
            rel = pts[:, :2] - b["center_xy"]
            local = np.column_stack([c * rel[:, 0] + s * rel[:, 1], -s * rel[:, 0] + c * rel[:, 1], pts[:, 2]])
            lo = np.array([-b["half_xy"][0], -b["half_xy"][1], b["z_bottom"]])
            hi = np.array([b["half_xy"][0], b["half_xy"][1], b["z_top"]])
            inside = ((local >= lo - eps) & (local <= hi + eps)).all(1)
            strictly = ((local > lo + eps) & (local < hi - eps)).all(1)
            return inside & ~strictly, strictly

        on_box, in_box = surface(box)
        on_beam, in_beam = surface(beam)
        on_floor = np.abs(pts[:, 2]) < 1e-6
        self.assertTrue(on_box.any() and on_beam.any() and on_floor.any())
        self.assertTrue((on_floor | on_box | on_beam).all())  # every return lies on a surface
        self.assertFalse((in_box | in_beam).any())  # and none inside an obstacle
        self.assertTrue((np.abs(pts[on_beam, 2] - 1.5) < 1e-6).any())  # the beam's underside is seen
        self.assertFalse((on_floor & (pts[:, 0] > 2.1) & (np.abs(pts[:, 1]) < 0.9)).any())  # floor behind the wall is hidden

    def test_arena_document_and_preset_start(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "arena.json"
            path.write_text(json.dumps({"kind": "boxes", "boxes": [{"center_xy": [1, 1], "half_xy": [0.2, 0.2],
                                                                     "z_bottom": 0, "z_top": 0.5}],
                                        "presets": [{"start_xy": [0.5, -0.5], "start_yaw_rad": 0.25, "goal_xy": [3, 0]}]}))
            boxes, start = self.fake.load_arena(str(path))
            self.assertEqual(len(boxes), 1)
            self.assertEqual(start, (0.5, -0.5, 0.25))
            path.write_text(json.dumps([{"center_xy": [1, 1], "half_xy": [0, 0.2], "z_bottom": 0, "z_top": 0.5}]))
            with self.assertRaises(ValueError):
                self.fake.load_arena(str(path))
        self.assertEqual(self.fake.load_arena("none"), ([], None))


class PressHelperTests(unittest.TestCase):
    def test_press_refuses_an_endpoint_that_is_not_the_fixture(self):
        import threading
        import zmq
        ctx = zmq.Context.instance()
        rep = ctx.socket(zmq.REP)
        rep.setsockopt(zmq.LINGER, 0)
        port = rep.bind_to_random_port("tcp://127.0.0.1")
        received, stop = [], threading.Event()

        def serve():  # answers like node.py: a status without "fixture"
            while not stop.is_set():
                if not rep.poll(50):
                    continue
                message = json.loads(rep.recv())
                received.append(message["cmd"])
                rep.send_string(json.dumps({"phase": "WAIT", "standing": False} if message["cmd"] == "status"
                                           else {"ok": True, "queued": message["cmd"]}))
        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        try:
            proc = subprocess.run([PY, str(ROOT / "tools/fake_node.py"), "--press", "go", "--control-connect",
                                   f"tcp://127.0.0.1:{port}"], cwd=ROOT, env=ENV, capture_output=True, timeout=20)
        finally:
            stop.set()
            thread.join(5)
            rep.close(0)
        self.assertEqual(proc.returncode, 2)
        self.assertIn(b"refused", proc.stderr)
        self.assertEqual(received, ["status"])  # go never left the helper
        with self.assertRaises(SystemExit):
            from contextlib import redirect_stderr
            import io
            import importlib.util
            spec = importlib.util.spec_from_file_location("_fake_node_cli", ROOT / "tools/fake_node.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with redirect_stderr(io.StringIO()):
                module.main(["--press", "go", "--control-connect", "tcp://192.168.123.164:5562"])


class Fixture:
    def __init__(self, temp, ports, *extra):
        self.ports, self.extra, self.temp = ports, extra, Path(temp)
        self.endpoints = {k: f"tcp://127.0.0.1:{p}" for k, p in zip(("odom", "pose", "debug", "control"), ports)}
        self.proc, self.starts = None, 0

    def start(self, debug=True):
        self.starts += 1
        args = [PY, str(ROOT / "tools/fake_node.py"), "--odom-bind", self.endpoints["odom"],
                "--pose-bind", self.endpoints["pose"], "--control-bind", self.endpoints["control"], *self.extra]
        if debug:
            args += ["--debug-bind", self.endpoints["debug"]]
        self.log = self.temp / f"fixture-{self.starts}.log"
        with self.log.open("w") as out:
            self.proc = subprocess.Popen(args, cwd=ROOT, env=ENV, stdout=out, stderr=subprocess.STDOUT)

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(5)

    def request(self, message):
        import zmq
        ctx = zmq.Context.instance()
        sock = ctx.socket(zmq.REQ)
        sock.setsockopt(zmq.LINGER, 0)
        sock.setsockopt(zmq.RCVTIMEO, 2000)
        sock.connect(self.endpoints["control"])
        try:
            sock.send_string(json.dumps(message))
            return json.loads(sock.recv())
        finally:
            sock.close(0)

    def commands_received(self):
        out = []
        for log in sorted(self.temp.glob("fixture-*.log")):
            for line in log.read_text().splitlines():
                if line.startswith("{") and json.loads(line).get("event") == "command":
                    out.append(json.loads(line)["cmd"])
        return out


class Link:
    def __init__(self, temp, config):
        self.dir = Path(temp) / "job" / "run"
        self.config = Path(temp) / "link.json"
        self.config.write_text(json.dumps(config))
        with (Path(temp) / "link.log").open("w") as out:
            self.proc = subprocess.Popen([PY, "-m", "studio.robot_link", "--config", str(self.config),
                                          "--output", str(self.dir)], cwd=ROOT, env=ENV,
                                         stdout=out, stderr=subprocess.STDOUT)

    def latest(self):
        return json.loads((self.dir / "latest.json").read_text())

    def wait(self, predicate, timeout=8.0, what="condition"):
        deadline, last = time.monotonic() + timeout, None
        while time.monotonic() < deadline:
            try:
                last = self.latest()
                if predicate(last):
                    return last
            except (OSError, ValueError, KeyError, IndexError, TypeError):
                pass
            time.sleep(0.03)
        raise AssertionError(f"timed out waiting for {what}; navigation: "
                             f"{json.dumps((last or {}).get('navigation'), default=str)[:2500]}")

    def send(self, seq, **command):
        tmp = self.dir / "inbox" / f".{seq:06d}.tmp"
        tmp.write_text(json.dumps({"seq": seq, **command}))
        os.replace(tmp, self.dir / "inbox" / f"{seq:06d}.json")

    def command(self, seq, timeout=6.0):
        state = self.wait(lambda d: any(c["seq"] == seq for c in d["navigation"]["commands"]), timeout, f"command {seq}")
        return next(c for c in state["navigation"]["commands"] if c["seq"] == seq)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(5)


def streams(state):
    return {s["id"]: s for s in state["navigation"]["streams"]}


@unittest.skipUnless(HAVE_SOURCE, "g1-student-deploy reference packer not present")
class RobotLinkFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.mkdtemp(prefix="robot-link-test-")
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)  # cleanups run last-in first-out
        keep = os.environ.get("STUDIO_TEST_KEEP")  # an existing directory: copy the session files there first
        if keep:
            self.addCleanup(lambda: shutil.copytree(self.temp, Path(keep) / f"{self.id().split('.')[-1]}",
                                                    dirs_exist_ok=True))

    def start(self, *fixture_args, debug=True, cloud=True, **config):
        fixture = Fixture(self.temp, free_ports(4), *fixture_args)
        fixture.start(debug=debug)
        self.addCleanup(fixture.kill)
        endpoints = {"odom": fixture.endpoints["odom"], "pose": fixture.endpoints["pose"],
                     "control": fixture.endpoints["control"]}
        if cloud:
            endpoints["cloud"] = fixture.endpoints["odom"]  # the bridge sends both topics on one socket
        if debug:
            endpoints["debug"] = fixture.endpoints["debug"]
        link = Link(self.temp, {"endpoints": endpoints, **config})
        self.addCleanup(link.stop)
        return fixture, link

    def ready(self, state):
        return {item["id"]: item for item in state["navigation"]["ready"]}

    def test_session_stage_walk_stand_outage_recovery_and_recording(self):
        fixture, link = self.start("--goal", "2", "0")
        state = link.wait(lambda d: d["navigation"]["can"]["goal"], 10, "can.goal")
        nav, frame, s = state["navigation"], state["frame"], streams(state)
        # Schema and labels.
        self.assertEqual((state["kind"], state["robot"], state["status"]), ("navigation", "real", "running"))
        self.assertEqual((frame["classification"], frame["frame_id"]), ("estimated", "odom"))
        self.assertEqual(frame["pose_source"], "LIO estimate (bridge odom)")
        self.assertEqual(len(frame["joints"]), 29)
        self.assertEqual(frame["joints_classification"], "measured")
        self.assertEqual(len(frame["qpos"]), 36)
        self.assertEqual(frame["navigation"], {"phase": "WAIT", "walk": None, "goal_xy": None})
        self.assertIn("linear_velocity_w", frame)
        self.assertEqual(nav["phase"], "WAIT")
        self.assertIs(nav["standing"], True)
        self.assertIsNone(nav["pending_stand"])
        self.assertEqual(nav["can"], {"goal": True, "go": False, "stand": False, "end": True})
        self.assertEqual(nav["go_note"], GO_NOTE)
        self.assertTrue(nav["node"]["fixture"])
        self.assertTrue(state["metadata"]["fixture"])
        self.assertIn("protocol fixture", state["metadata"]["title"])
        self.assertEqual(state["metadata"]["command_path_enabled"], "node goal/stand only")
        # The node's launch goal (node.py requires --goal): external, with a warning, and the checklist blocks.
        self.assertEqual(nav["goal"]["xy"], [2.0, 0.0])
        self.assertEqual((nav["goal"]["verification"], nav["goal"]["seq"], nav["goal"]["source"]),
                         ("external", None, "node status"))
        self.assertEqual(nav["goal_warning"],
                         "The node holds its launch goal (2.00, 0.00), not one from Studio: stage a goal before pressing g.")
        self.assertEqual([item["id"] for item in nav["ready"]], READY_IDS)
        ready = self.ready(state)
        self.assertEqual(ready["goal_verified"]["status"], "block")
        self.assertFalse(nav["ready_ok"])
        for item in ("node_status", "odometry", "frame", "still", "goal_range", "stand"):
            self.assertEqual(ready[item]["status"], "pass", ready[item])
        # The assumed planner memory: 12 x 12 m around the first odometry pose; the display map matches it.
        self.assertEqual((nav["memory"]["origin_xy"], nav["memory"]["half_extent_m"]), ([0.0, 0.0], 6.0))
        self.assertTrue(nav["memory"]["basis"].startswith("ASSUMED"))
        self.assertEqual((nav["map"]["shape"], nav["map"]["reset_count"]), ([241, 241], 0))
        self.assertEqual(nav["limits"]["max_goal_distance_m"], 3.0)
        self.assertTrue(nav["frame_check"]["ok"])
        self.assertLess(nav["frame_check"]["offset_m"], 0.05)
        self.assertEqual((nav["walks"], nav["arrived"], nav["motion_s"]), (0, 0, 0.0))
        for sid in ("odom", "cloud", "g1_debug", "node_status"):
            self.assertEqual(s[sid]["status"], "fresh", sid)
        self.assertEqual(s["pose"]["status"], "unavailable")  # the node streams no reference before it plans
        self.assertEqual({k: s[k]["threshold_s"] for k in s},
                         {"odom": 0.1, "cloud": 0.5, "pose": 0.5, "g1_debug": 0.5, "node_status": 1.5})
        self.assertTrue(30 < s["odom"]["rate_hz"] < 70, s["odom"]["rate_hz"])
        self.assertTrue(5 < s["cloud"]["rate_hz"] < 15, s["cloud"]["rate_hz"])
        p = state["perception"]
        self.assertEqual((p["label"], p["classification"], p["frame_id"]), (MAP_LABEL, "estimated", "odom"))
        self.assertTrue(0 < len(p["raw_lidar"]) <= 5000)
        self.assertTrue(p["support_points"])
        self.assertFalse(p["self_filter"])
        # latest.json is rewritten at >= 5 Hz.
        seen, until = set(), time.monotonic() + 1.0
        while time.monotonic() < until:
            seen.add(link.latest()["progress"]["elapsed_s"])
            time.sleep(0.02)
        self.assertGreaterEqual(len(seen), 5)

        # Fail closed: a goal the gateway did not check, or could not check, never reaches the node.
        link.send(1, cmd="goal", xy=[1.2, 0.6], operator="test")
        self.assertTrue(link.command(1)["reason"].startswith("not checked: the gateway could not check this goal"))
        link.send(2, cmd="goal", xy=[1.2, 0.6], check={"ok": None, "note": "not checked: No map yet"})
        c = link.command(2)
        self.assertEqual(c["status"], "rejected")
        self.assertIn("No map yet", c["reason"])
        # Beyond the distance limit (the ladder's first walks are 2-3 m): refused even when checked.
        link.send(3, cmd="goal", xy=[3.5, 0.0], check=CHECKED)
        c = link.command(3)
        self.assertEqual(c["status"], "rejected")
        self.assertIn("3.50 m from the robot; the limit is 3.0 m", c["reason"])
        self.assertNotIn("sent", c)

        # Stage a goal while standing: sent as ahead/left, read back from the node's status: verified.
        link.send(4, cmd="goal", xy=[1.2, 0.6], operator="test", check=CHECKED)
        c = link.command(4)
        self.assertEqual(c["status"], "applied", c)
        self.assertLessEqual(c["readback"]["error_m"], 0.05)
        self.assertEqual(c["sent"]["cmd"], "goal")
        self.assertEqual(set(c["sent"]), {"cmd", "ahead", "left"})
        state = link.wait(lambda d: d["navigation"]["goal"]["seq"] == 4 and d["navigation"]["ready_ok"], 3,
                          "goal seq 4, ready")
        nav = state["navigation"]
        np.testing.assert_allclose(nav["goal"]["xy"], [1.2, 0.6], atol=0.05)
        self.assertEqual((nav["goal"]["frame_id"], nav["goal"]["verification"]), ("odom", "verified"))
        self.assertIsNone(nav["goal_warning"])
        self.assertTrue(all(item["status"] == "pass" for item in nav["ready"]), nav["ready"])

        # Go is never sent: rejected with the note. Malformed and stale inbox files.
        link.send(5, cmd="go")
        c = link.command(5)
        self.assertEqual((c["status"], c["reason"]), ("rejected", GO_NOTE))
        (link.dir / "inbox" / "000006.json").write_text("{not json")
        self.assertIn("malformed", link.command(6)["reason"])
        link.send(7, cmd="goal", xy=[1, 0], check=CHECKED)  # valid
        (link.dir / "inbox" / "000008.json").write_text(json.dumps({"seq": 9, "cmd": "goal", "xy": [1, 1]}))
        link.send(1, cmd="goal", xy=[9, 9], check=CHECKED)  # seq <= last applied: ignored
        self.assertEqual(link.command(7)["status"], "applied")
        c8 = link.command(8)
        self.assertEqual(c8["status"], "rejected")
        self.assertIn("does not match", c8["reason"])
        link.send(9, cmd="goal", xy=[1.2, 0.6], check=CHECKED)
        self.assertEqual(link.command(9)["status"], "applied")
        state = link.wait(lambda d: d["navigation"]["goal"]["seq"] == 9, 3, "goal seq 9")
        self.assertEqual([c["seq"] for c in state["navigation"]["commands"]], list(range(1, 10)))

        # The operator presses Go (on the fixture, as the console would): walk 1 to ARRIVED, attributed to command 9.
        self.assertEqual(fixture.request({"cmd": "go"}), {"ok": True, "queued": "go"})
        state = link.wait(lambda d: d["navigation"]["phase"] == "RUN" and d["navigation"]["still"]["speed_mps"]
                          and d["navigation"]["still"]["speed_mps"] > 0.2, 5, "RUN and moving")
        nav = state["navigation"]
        self.assertFalse(nav["can"]["goal"])
        self.assertIn("not standing", nav["can_reasons"]["goal"])
        self.assertIn("the robot is moving", nav["can_reasons"]["goal"])
        self.assertTrue(nav["can"]["stand"])
        self.assertEqual(self.ready(state)["still"]["status"], "block")
        leg = nav["legs"][0]
        self.assertTrue(leg["in_progress"])
        self.assertEqual((leg["index"], leg["goal_source"], leg["staged_seq"]), (1, "studio", 9))
        link.send(10, cmd="goal", xy=[0, 0], check=CHECKED)
        self.assertIn("not standing", link.command(10)["reason"])
        state = link.wait(lambda d: streams(d)["pose"]["status"] == "fresh", 3, "pose fresh while walking")
        self.assertEqual(state["frame"]["reference"]["classification"], "commanded")
        self.assertEqual(state["frame"]["navigation"]["walk"], 1)
        if os.environ.get("STUDIO_TEST_KEEP"):
            shutil.copy(link.dir / "latest.json", Path(self.temp) / "latest-walking.json")
        # Right after it stops, the robot-still gate (and the phase dwell) still refuses a goal.
        state = link.wait(lambda d: d["navigation"]["phase"] == "ARRIVED", 10, "ARRIVED")
        link.send(11, cmd="goal", xy=[2.0, 0.6], check=CHECKED)
        c = link.command(11)
        self.assertEqual(c["status"], "rejected", c)
        self.assertTrue("ago (needs 1.0 s)" in c["reason"] or "still" in c["reason"] or "moving" in c["reason"],
                        c["reason"])
        state = link.wait(lambda d: d["navigation"]["legs"] and d["navigation"]["legs"][0]["outcome"], 3, "leg 1 end")
        leg = state["navigation"]["legs"][0]
        self.assertEqual(leg["outcome"], "arrived")
        np.testing.assert_allclose(leg["start_xy"], [0, 0], atol=0.05)
        self.assertGreater(leg["path_m"], 0.5)
        self.assertLessEqual(leg["final_dist_m"], 0.4)
        self.assertGreater(leg["duration_s"], 0.5)
        self.assertIsNone(leg["max_contact_n"])
        state = link.wait(lambda d: d["navigation"]["can"]["goal"], 4, "standing and still after arrival")
        self.assertEqual(state["navigation"]["phase"], "ARRIVED")
        self.assertIsNone(state["navigation"]["pending_stand"])
        self.assertEqual((state["navigation"]["walks"], state["navigation"]["arrived"]), (1, 1))

        # Second walk, stopped by Studio's stand mid-walk; a stand while standing is refused.
        link.send(12, cmd="goal", xy=[3.0, 0.6], check=CHECKED)
        self.assertEqual(link.command(12)["status"], "applied")
        press = subprocess.run([PY, str(ROOT / "tools/fake_node.py"), "--press", "go", "--control-connect",
                                fixture.endpoints["control"]], cwd=ROOT, env=ENV, capture_output=True, timeout=20)
        self.assertEqual(press.returncode, 0, press.stderr)  # the demo operator key, on the fixture only
        link.wait(lambda d: d["navigation"]["phase"] == "RUN" and d["frame"]["position"][0] > 1.8, 6, "RUN 2 past 1.8 m")
        link.send(13, cmd="stand")
        c = link.command(13)
        self.assertEqual(c["status"], "applied", c)
        self.assertIn("not an emergency stop", c["reason"])
        state = link.wait(lambda d: len(d["navigation"]["legs"]) == 2 and d["navigation"]["legs"][1]["outcome"], 5, "leg 2")
        leg = state["navigation"]["legs"][1]
        self.assertEqual((leg["index"], leg["outcome"], leg["goal_source"], leg["staged_seq"]), (2, "stopped", "studio", 12))
        self.assertGreater(leg["final_dist_m"], 0.4)
        link.send(14, cmd="stand")
        self.assertIn("while walking", link.command(14)["reason"])

        # Producer outage: streams go stale, goals are refused, the link keeps running.
        fixture.kill()
        state = link.wait(lambda d: streams(d)["odom"]["status"] == "stale" and streams(d)["node_status"]["status"] == "stale",
                          5, "stale streams")
        self.assertIsNone(link.proc.poll())
        nav = state["navigation"]
        self.assertFalse(nav["can"]["goal"])
        self.assertIsNone(nav["standing"])
        self.assertIsNone(nav["goal_dist_m"])
        self.assertEqual(nav["phase_status"], "stale")
        self.assertFalse(nav["ready_ok"])
        self.assertEqual(self.ready(state)["node_status"]["status"], "block")
        self.assertEqual(state["frame"]["validity"], "stale")
        self.assertIsNone(state["frame"]["joints"])  # stale g1_debug is not shown as measured
        self.assertIsNone(state["frame"]["navigation"]["phase"])  # unknown, not the last phase
        link.send(15, cmd="goal", xy=[1, 1], check=CHECKED)
        self.assertIn("stale", link.command(15)["reason"])
        before = link.latest()["progress"]["elapsed_s"]
        time.sleep(0.5)
        self.assertGreater(link.latest()["progress"]["elapsed_s"], before)

        # Restart on the same ports: the link recovers by itself (SUB reconnect, fresh REQ socket). The restarted
        # bridge starts a new odometry frame: the display map and the assumed memory are re-centred. The restarted
        # node holds its launch goal again: external.
        fixture.start()
        state = link.wait(lambda d: d["navigation"]["can"]["goal"] and streams(d)["odom"]["status"] == "fresh", 10, "recovery")
        nav = state["navigation"]
        self.assertEqual(nav["phase"], "WAIT")
        self.assertGreaterEqual(nav["map"]["reset_count"], 1)
        self.assertEqual(nav["map"]["center_xy"], [0.0, 0.0])
        self.assertEqual(nav["goal"]["verification"], "external")
        self.assertIn("launch goal", nav["goal_warning"])
        self.assertEqual(nav["node"]["instance"], 2)
        link.send(16, cmd="goal", xy=[1.0, -0.5], check=CHECKED)
        self.assertEqual(link.command(16)["status"], "applied")

        # End: nothing is sent to the node; the recording and the receipt are written, exit 0.
        link.send(17, cmd="end")
        self.assertEqual(link.proc.wait(15), 0)
        result = json.loads((link.dir / "result.json").read_text())
        self.assertEqual((result["status"], result["recording_complete"], result["hardware_enabled"]),
                         ("completed", True, False))
        report = result["report"]
        self.assertEqual(report["stopped_by"], "end")
        self.assertEqual(report["thread_errors"], [])
        self.assertEqual((report["walks"], report["arrived"], report["fixture"]), (2, 1, True))
        self.assertGreater(report["motion_s"], 2.0)
        self.assertEqual([leg["index"] for leg in report["legs"]], [1, 2])
        self.assertLess(report["finalize_s"], 5.0)
        self.assertGreaterEqual(report["odom_resets"], 1)
        self.assertEqual(link.latest()["errors"], [])
        final = link.latest()
        self.assertEqual((final["status"], final["navigation"]["phase"]), ("ended", "ENDED"))
        self.assertFalse(any(final["navigation"]["can"].values()))

        session = json.loads((link.dir / "session.json").read_text())
        meta = session["metadata"]
        self.assertEqual((meta["mode"], meta["recording_kind"], meta["hardware_validated"], meta["command_path_enabled"]),
                         ("replay", "robot-link", False, "node goal/stand only"))
        self.assertTrue(meta["fixture"])
        self.assertIn("protocol fixture", meta["title"])
        frames = session["frames"]
        self.assertGreater(len(frames), 200)
        gaps = np.diff([f["time"] for f in frames])
        self.assertGreaterEqual(gaps.min(), 0.015 - 1e-9)  # at most 50 Hz (with jitter tolerance)
        self.assertTrue(all(f["classification"] == "estimated" and f["frame_id"] == "odom" for f in frames))
        self.assertTrue(all(f["qpos"] is None or len(f["qpos"]) == 36 for f in frames))
        # Every frame carries the navigation block: phase, walk number and the node's goal during a walk.
        self.assertTrue(all(set(f["navigation"]) == {"phase", "walk", "goal_xy"} for f in frames))
        walk1 = [f for f in frames if f["navigation"]["walk"] == 1]
        self.assertTrue(walk1 and all(f["navigation"]["phase"] in ("PRESCAN", "RUN", None) for f in walk1))
        np.testing.assert_allclose(walk1[-1]["navigation"]["goal_xy"], [1.2, 0.6], atol=0.05)
        self.assertTrue(any(f["navigation"]["walk"] == 2 for f in frames))
        self.assertTrue(any(f["navigation"]["phase"] == "ARRIVED" and f["navigation"]["walk"] is None for f in frames))
        self.assertTrue(any(f["linear_velocity_w"] and abs(f["linear_velocity_w"][0]) > 0.2 for f in walk1))
        snaps = session["perception"]["frames"]
        self.assertGreater(len(snaps), 5)
        self.assertTrue(all(s["label"] == MAP_LABEL for s in snaps))
        indices = [f["perception_index"] for f in frames if f["perception_index"] is not None]
        self.assertTrue(indices and max(indices) < len(snaps))
        commands = [e["command"]["seq"] for e in session["events"] if e["type"] == "command"]
        self.assertEqual(commands, list(range(1, 18)))  # every command, once, in order
        phases = [(e["from"], e["to"]) for e in session["events"] if e["type"] == "phase"]
        self.assertIn(("RUN", "ARRIVED"), phases)
        self.assertIn(("RUN", "STOPPED"), phases)
        types = [e["type"] for e in session["events"]]
        self.assertIn("odom_reset", types)  # the restarted bridge's new frame
        self.assertIn("node_restart", types)
        self.assertEqual([leg["outcome"] for leg in session["navigation"]["legs"]], ["arrived", "stopped"])

        # The gateway's catalog loads the recording; causal replay sampling works on it.
        from studio.server import Catalog
        from studio.replay import frame_at
        catalog = Catalog()
        catalog.register("robot-link-test", link.dir / "session.json", "Robot link test")
        data, encoded = catalog.entry("robot-link-test")
        self.assertEqual(data["metadata"]["catalog_id"], "robot-link-test")
        self.assertGreater(len(encoded.body), 1000)
        self.assertEqual(frame_at(data, frames[10]["time"] + 0.001)["status"], "fresh")

        # memory.npz in the node dump format: 12 x 12 m at 5 cm, the planner memory's extent.
        with np.load(link.dir / "memory.npz", allow_pickle=False) as z:
            self.assertEqual(set(z.files), {"support", "ceiling", "lo", "res", "boxes", "stats"})
            self.assertEqual(z["support"].shape, (241, 241))
            self.assertEqual(json.loads(str(z["boxes"])), [])
            stats = json.loads(str(z["stats"]))
            self.assertEqual((stats["basis"], stats["frame_id"], stats["label"]), ("studio-reconstruction", "odom", MAP_LABEL))
            self.assertTrue(np.isnan(z["support"]).any() and np.isfinite(z["support"]).any())
            self.assertTrue(np.isfinite(z["ceiling"]).any())  # the demo arena's overhead beam
            self.assertFalse(np.isposinf(z["ceiling"]).any())
            np.testing.assert_allclose(z["lo"], [-6.0, -6.0], atol=1e-9)
            self.assertEqual(float(z["res"]), 0.05)

        # The fixture received go only from the operator (twice), never quit; the link sent goal/stand only.
        received = fixture.commands_received()
        self.assertEqual(received.count("go"), 2)
        self.assertNotIn("quit", received)
        self.assertTrue(set(received) <= {"go", "goal", "stand"})
        self.assertEqual(received.count("stand"), 1)
        self.assertEqual(received.count("goal"), 5)  # commands 4, 7, 9, 12, 16: every refused goal stayed here

    def test_readback_mismatch_leaves_an_unverified_goal_no_joints_no_cloud_capture_and_sigterm(self):
        fixture, link = self.start("--goal-error-m", "0.3", "0", "--no-cloud", "--goal", "3", "0", debug=False,
                                   cloud=False, limits={"readback_timeout_s": 1.0}, capture={"topics": ["odom"]})
        state = link.wait(lambda d: d["navigation"]["can"]["goal"], 10, "can.goal")
        frame, s = state["frame"], streams(state)
        self.assertIsNone(frame["joints"])
        self.assertIsNone(frame["qpos"])
        self.assertEqual(frame["joints_status"], "unavailable")
        self.assertEqual((s["g1_debug"]["status"], s["g1_debug"]["configured"]), ("unavailable", False))
        self.assertEqual((s["cloud"]["status"], s["cloud"]["configured"]), ("unavailable", False))
        self.assertFalse(state["perception"]["available"])
        self.assertIsNone(state["navigation"]["map"])  # no cloud: no display map, not an all-unknown one
        self.assertEqual(state["navigation"]["memory"]["origin_xy"], [0.0, 0.0])  # the assumed memory is still known
        link.send(1, cmd="goal", xy=[1.0, 0.5], check=CHECKED)
        c = link.command(1, timeout=8)
        self.assertEqual(c["status"], "rejected")
        self.assertTrue(c["reason"].startswith("readback mismatch"), c["reason"])
        self.assertIn("node reports goal [1.300, 0.500]", c["reason"])
        self.assertIn("the node keeps that goal", c["reason"])
        self.assertAlmostEqual(c["readback"]["error_m"], 0.3, places=6)
        state = link.latest()
        nav = state["navigation"]
        np.testing.assert_allclose(nav["goal"]["xy"], [1.3, 0.5])  # what the node holds
        self.assertEqual((nav["goal"]["verification"], nav["goal"]["seq"]), ("unverified", None))
        self.assertIn("command 1 was sent but not verified", nav["goal"]["detail"])
        self.assertEqual(nav["goal_warning"],
                         "The node holds an UNVERIFIED goal (1.30, 0.50): do not press g; stage a new goal from Studio.")
        self.assertEqual(self.ready(state)["goal_verified"]["status"], "block")
        self.assertFalse(nav["ready_ok"])
        # A blocking goal check refuses before anything is sent.
        link.send(2, cmd="goal", xy=[1.0, 0.5], check={"ok": False, "checks": [{"id": "free", "status": "block", "label": "Seen and free"}]})
        c = link.command(2)
        self.assertIn("goal check blocks: Seen and free", c["reason"])
        self.assertNotIn("sent", c)
        # The operator presses g anyway: the walk goes to the unverified goal and is not attributed to command 1.
        self.assertEqual(fixture.request({"cmd": "go"}), {"ok": True, "queued": "go"})
        state = link.wait(lambda d: d["navigation"]["legs"], 5, "walk 1")
        leg = state["navigation"]["legs"][0]
        self.assertEqual((leg["index"], leg["goal_source"], leg["staged_seq"], leg["staged_at_s"]),
                         (1, "unverified", None, None))
        np.testing.assert_allclose(leg["goal_xy"], [1.3, 0.5])
        link.wait(lambda d: d["navigation"]["legs"][0]["outcome"] == "arrived", 8, "arrived")
        time.sleep(0.3)
        link.proc.send_signal(signal.SIGTERM)
        self.assertEqual(link.proc.wait(15), 0)
        result = json.loads((link.dir / "result.json").read_text())
        self.assertEqual((result["status"], result["report"]["stopped_by"]), ("completed", "signal"))
        self.assertEqual((result["report"]["walks"], result["report"]["arrived"]), (1, 1))
        self.assertEqual(result["report"]["legs"][0]["goal_source"], "unverified")
        self.assertLess(result["report"]["finalize_s"], 5.0)
        session = json.loads((link.dir / "session.json").read_text())
        self.assertTrue(all(f["joints"] is None and f["qpos"] is None for f in session["frames"]))
        self.assertTrue(any(f["navigation"]["walk"] == 1 for f in session["frames"]))
        self.assertEqual(session["perception"]["frames"], [])
        self.assertFalse((link.dir / "memory.npz").exists())
        lines = [json.loads(line) for line in (link.dir / "capture.jsonl").read_text().splitlines()]
        self.assertEqual((lines[0]["record"], lines[-1]["record"]), ("capture_start", "capture_end"))
        odom = [e for e in lines if e.get("topic") == "odom"]
        self.assertGreater(len(odom), 20)
        import base64
        _, fields = decode_packed_topic(base64.b64decode(odom[-1]["wire_base64"]), b"odom")
        self.assertEqual(fields["pos"].tolist(), odom[-1]["payload"]["fields"]["pos"])
        self.assertEqual(fixture.commands_received().count("goal"), 1)  # only the checked-and-sent goal

    def test_a_node_on_another_odometry_frame_gets_no_goal(self):
        fixture, link = self.start("--odom-offset", "0.5", "0.0", "--no-cloud", debug=False, cloud=False)
        state = link.wait(lambda d: d["navigation"]["frame_check"] and d["navigation"]["frame_check"]["ok"] is False
                          and d["navigation"]["phase"] == "WAIT", 10, "frame mismatch")
        nav = state["navigation"]
        self.assertAlmostEqual(nav["frame_check"]["offset_m"], 0.5, places=3)
        item = self.ready(state)["frame"]
        self.assertEqual(item["status"], "block")
        self.assertIn("--odom zmq", item["detail"])
        self.assertFalse(nav["ready_ok"])
        self.assertFalse(nav["can"]["goal"])
        self.assertIn("not the LIO bridge's", nav["can_reasons"]["goal"])
        link.send(1, cmd="goal", xy=[1.0, 0.0], check=CHECKED)
        c = link.command(1)
        self.assertEqual(c["status"], "rejected")
        self.assertIn("start the node with --odom zmq", c["reason"])
        self.assertNotIn("sent", c)
        time.sleep(0.3)
        self.assertNotIn("goal", fixture.commands_received())

    def test_a_deferred_stand_is_inferred_from_node_status(self):
        fixture, link = self.start("--defer-stand", "2.0", "--arena", "none", "--goal", "1", "0")
        link.wait(lambda d: d["navigation"]["can"]["goal"], 10, "can.goal")
        link.send(1, cmd="goal", xy=[1.0, 0.0], check=CHECKED)
        self.assertEqual(link.command(1)["status"], "applied")
        link.wait(lambda d: d["navigation"]["goal"]["verification"] == "verified", 3, "verified")
        self.assertEqual(fixture.request({"cmd": "go"}), {"ok": True, "queued": "go"})
        state = link.wait(lambda d: d["navigation"]["pending_stand"] is not None, 10, "deferred stand")
        nav = state["navigation"]
        self.assertEqual(nav["pending_stand"], PENDING_STAND_NOTE)
        self.assertEqual(nav["phase"], "ARRIVED")
        self.assertIs(nav["standing"], False)
        self.assertIs(nav["node"]["status"]["standing"], False)
        self.assertIn("deferred stand pending", nav["can_reasons"]["goal"])
        item = self.ready(state)["stand"]
        self.assertEqual(item["status"], "block")
        self.assertIn("deferring its stand", item["detail"])
        self.assertFalse(nav["ready_ok"])
        # The fixture's fake low ceiling is on Studio's display map as overhead.
        state = link.wait(lambda d: d["perception"].get("ceiling_points"), 3, "overhead cells")
        z = [p[2] for p in state["perception"]["ceiling_points"]]
        self.assertTrue(z and min(z) < 1.35, z[:5])
        # After the deferral the node stands: pending_stand clears, standing is true.
        state = link.wait(lambda d: d["navigation"]["pending_stand"] is None and d["navigation"]["standing"] is True,
                          5, "stand issued")
        self.assertEqual(self.ready(state)["stand"]["status"], "pass")
        link.send(2, cmd="end")
        self.assertEqual(link.proc.wait(15), 0)
        report = json.loads((link.dir / "result.json").read_text())["report"]
        self.assertEqual((report["walks"], report["arrived"]), (1, 1))
        self.assertEqual(report["legs"][0]["goal_source"], "studio")


if __name__ == "__main__":
    unittest.main()
