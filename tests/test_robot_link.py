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
from studio.robot_link import (GO_NOTE, MAP_LABEL, NODE_COMMANDS, ConfigError, ControlRequest, DisplayMap,
                               goal_to_ahead_left, load_config)

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = Path("/home/linjiw/code/g1-student-deploy")
HAVE_SOURCE = (DEPLOY / "g1deploy/zmq_stream.py").is_file()
PY = sys.executable
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONPATH=str(ROOT))


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
import contextlib, io, json, math, sys, types
sys.dont_write_bytecode = True
sys.path.append("/home/linjiw/code/g1-student-deploy")
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
        self.assertEqual(nav["phase"], "WAIT")
        self.assertIs(nav["standing"], True)
        self.assertEqual(nav["can"], {"goal": True, "go": False, "stand": False, "end": True})
        self.assertEqual(nav["go_note"], GO_NOTE)
        self.assertTrue(nav["node"]["fixture"])
        self.assertTrue(state["metadata"]["fixture"])
        self.assertEqual(state["metadata"]["command_path_enabled"], "node goal/stand only")
        self.assertEqual(nav["goal"]["xy"], [2.0, 0.0])
        self.assertIsNone(nav["goal"]["seq"])  # the launch goal, not staged by Studio
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

        # Stage a goal while standing: sent as ahead/left, read back from the node's status.
        link.send(1, cmd="goal", xy=[1.2, 0.6], operator="test")
        c = link.command(1)
        self.assertEqual(c["status"], "applied", c)
        self.assertLessEqual(c["readback"]["error_m"], 0.05)
        self.assertEqual(c["sent"]["cmd"], "goal")
        self.assertEqual(set(c["sent"]), {"cmd", "ahead", "left"})
        state = link.wait(lambda d: d["navigation"]["goal"]["seq"] == 1, 3, "goal seq 1")
        np.testing.assert_allclose(state["navigation"]["goal"]["xy"], [1.2, 0.6], atol=0.05)
        self.assertEqual(state["navigation"]["goal"]["frame_id"], "odom")

        # Go is never sent: rejected with the note.
        link.send(2, cmd="go")
        c = link.command(2)
        self.assertEqual((c["status"], c["reason"]), ("rejected", GO_NOTE))
        # Malformed and stale inbox files.
        (link.dir / "inbox" / "000003.json").write_text("{not json")
        self.assertIn("malformed", link.command(3)["reason"])
        link.send(4, cmd="goal", xy=[1, 0], seq_note="x")  # valid
        (link.dir / "inbox" / "000005.json").write_text(json.dumps({"seq": 9, "cmd": "goal", "xy": [1, 1]}))
        link.send(1, cmd="goal", xy=[9, 9])  # seq <= last applied: ignored
        self.assertEqual(link.command(4)["status"], "applied")
        c5 = link.command(5)
        self.assertEqual(c5["status"], "rejected")
        self.assertIn("does not match", c5["reason"])
        link.send(6, cmd="goal", xy=[1.2, 0.6])
        self.assertEqual(link.command(6)["status"], "applied")
        state = link.latest()
        self.assertEqual([c["seq"] for c in state["navigation"]["commands"]], [1, 2, 3, 4, 5, 6])

        # The operator presses Go (on the fixture, as the console would): one leg to ARRIVED.
        self.assertEqual(fixture.request({"cmd": "go"}), {"ok": True, "queued": "go"})
        state = link.wait(lambda d: d["navigation"]["phase"] == "RUN", 5, "RUN")
        self.assertFalse(state["navigation"]["can"]["goal"])
        self.assertTrue(state["navigation"]["can"]["stand"])
        self.assertTrue(state["navigation"]["legs"][0]["in_progress"])
        link.send(7, cmd="goal", xy=[0, 0])
        self.assertIn("not standing", link.command(7)["reason"])
        state = link.wait(lambda d: streams(d)["pose"]["status"] == "fresh", 3, "pose fresh while walking")
        self.assertEqual(state["frame"]["reference"]["classification"], "commanded")
        if os.environ.get("STUDIO_TEST_KEEP"):
            shutil.copy(link.dir / "latest.json", Path(self.temp) / "latest-walking.json")
        state = link.wait(lambda d: d["navigation"]["legs"] and d["navigation"]["legs"][0]["outcome"], 10, "leg 0 end")
        leg = state["navigation"]["legs"][0]
        self.assertEqual(leg["outcome"], "arrived")
        self.assertEqual(leg["staged_seq"], 6)
        np.testing.assert_allclose(leg["start_xy"], [0, 0], atol=0.05)
        self.assertGreater(leg["path_m"], 0.5)
        self.assertLessEqual(leg["final_dist_m"], 0.4)
        self.assertGreater(leg["duration_s"], 0.5)
        self.assertIsNone(leg["max_contact_n"])
        state = link.wait(lambda d: d["navigation"]["can"]["goal"], 3, "standing after arrival")
        self.assertEqual(state["navigation"]["phase"], "ARRIVED")

        # Second leg, stopped by Studio's stand mid-walk; a stand while standing is refused.
        link.send(8, cmd="goal", xy=[4.0, 0.6])
        self.assertEqual(link.command(8)["status"], "applied")
        fixture.request({"cmd": "go"})
        link.wait(lambda d: d["navigation"]["phase"] == "RUN" and d["frame"]["position"][0] > 1.8, 6, "RUN 2 past 1.8 m")
        link.send(9, cmd="stand")
        c = link.command(9)
        self.assertEqual(c["status"], "applied", c)
        self.assertIn("not an emergency stop", c["reason"])
        state = link.wait(lambda d: len(d["navigation"]["legs"]) == 2 and d["navigation"]["legs"][1]["outcome"], 5, "leg 1")
        self.assertEqual(state["navigation"]["legs"][1]["outcome"], "stopped")
        self.assertGreater(state["navigation"]["legs"][1]["final_dist_m"], 0.4)
        link.send(10, cmd="stand")
        self.assertIn("while walking", link.command(10)["reason"])

        # Producer outage: streams go stale, goals are refused, the link keeps running.
        fixture.kill()
        state = link.wait(lambda d: streams(d)["odom"]["status"] == "stale" and streams(d)["node_status"]["status"] == "stale",
                          5, "stale streams")
        self.assertIsNone(link.proc.poll())
        self.assertFalse(state["navigation"]["can"]["goal"])
        self.assertIsNone(state["navigation"]["standing"])
        self.assertIsNone(state["navigation"]["goal_dist_m"])
        self.assertEqual(state["navigation"]["phase_status"], "stale")
        self.assertEqual(state["frame"]["validity"], "stale")
        self.assertIsNone(state["frame"]["joints"])  # stale g1_debug is not shown as measured
        link.send(11, cmd="goal", xy=[1, 1])
        self.assertIn("stale", link.command(11)["reason"])
        before = link.latest()["progress"]["elapsed_s"]
        time.sleep(0.5)
        self.assertGreater(link.latest()["progress"]["elapsed_s"], before)

        # Restart on the same ports: the link recovers by itself (SUB reconnect, fresh REQ socket).
        fixture.start()
        state = link.wait(lambda d: d["navigation"]["can"]["goal"] and streams(d)["odom"]["status"] == "fresh", 10, "recovery")
        self.assertEqual(state["navigation"]["phase"], "WAIT")
        link.send(12, cmd="goal", xy=[1.0, -0.5])
        self.assertEqual(link.command(12)["status"], "applied")

        # End: nothing is sent to the node; the recording and the receipt are written, exit 0.
        link.send(13, cmd="end")
        self.assertEqual(link.proc.wait(15), 0)
        result = json.loads((link.dir / "result.json").read_text())
        self.assertEqual((result["status"], result["recording_complete"], result["hardware_enabled"]),
                         ("completed", True, False))
        self.assertEqual(result["report"]["stopped_by"], "end")
        self.assertEqual(result["report"]["thread_errors"], [])
        self.assertEqual(link.latest()["errors"], [])
        final = link.latest()
        self.assertEqual((final["status"], final["navigation"]["phase"]), ("ended", "ENDED"))
        self.assertFalse(any(final["navigation"]["can"].values()))

        session = json.loads((link.dir / "session.json").read_text())
        meta = session["metadata"]
        self.assertEqual((meta["mode"], meta["recording_kind"], meta["hardware_validated"], meta["command_path_enabled"]),
                         ("replay", "robot-link", False, "node goal/stand only"))
        self.assertTrue(meta["fixture"])
        frames = session["frames"]
        self.assertGreater(len(frames), 200)
        gaps = np.diff([f["time"] for f in frames])
        self.assertGreaterEqual(gaps.min(), 0.015 - 1e-9)  # at most 50 Hz (with jitter tolerance)
        self.assertTrue(all(f["classification"] == "estimated" and f["frame_id"] == "odom" for f in frames))
        self.assertTrue(all(f["qpos"] is None or len(f["qpos"]) == 36 for f in frames))
        snaps = session["perception"]["frames"]
        self.assertGreater(len(snaps), 5)
        self.assertTrue(all(s["label"] == MAP_LABEL for s in snaps))
        indices = [f["perception_index"] for f in frames if f["perception_index"] is not None]
        self.assertTrue(indices and max(indices) < len(snaps))
        commands = [e["command"]["seq"] for e in session["events"] if e["type"] == "command"]
        self.assertEqual(commands, list(range(1, 14)))  # every command, once, in order
        phases = [(e["from"], e["to"]) for e in session["events"] if e["type"] == "phase"]
        self.assertIn(("RUN", "ARRIVED"), phases)
        self.assertIn(("RUN", "STOPPED"), phases)
        self.assertTrue(any(e["type"] == "odom_jump" for e in session["events"]))  # the restarted odom frame
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

        # memory.npz in the node dump format.
        with np.load(link.dir / "memory.npz", allow_pickle=False) as z:
            self.assertEqual(set(z.files), {"support", "ceiling", "lo", "res", "boxes", "stats"})
            self.assertEqual(z["support"].shape, (481, 481))
            self.assertEqual(json.loads(str(z["boxes"])), [])
            stats = json.loads(str(z["stats"]))
            self.assertEqual((stats["basis"], stats["frame_id"], stats["label"]), ("studio-reconstruction", "odom", MAP_LABEL))
            self.assertTrue(np.isnan(z["support"]).any() and np.isfinite(z["support"]).any())
            self.assertTrue(np.isfinite(z["ceiling"]).any())  # the demo arena's overhead beam
            self.assertFalse(np.isposinf(z["ceiling"]).any())
            np.testing.assert_allclose(z["lo"], [-12.0, -12.0], atol=1e-9)
            self.assertEqual(float(z["res"]), 0.05)

        # The fixture received go only from the operator (twice), never quit; the link sent goal/stand only.
        received = fixture.commands_received()
        self.assertEqual(received.count("go"), 2)
        self.assertNotIn("quit", received)
        self.assertTrue(set(received) <= {"go", "goal", "stand"})
        self.assertEqual(received.count("stand"), 1)

    def test_readback_mismatch_no_joints_no_cloud_capture_and_sigterm(self):
        fixture, link = self.start("--goal-error-m", "0.2", "0", "--no-cloud", debug=False, cloud=False,
                                   limits={"readback_timeout_s": 1.0}, capture={"topics": ["odom"]})
        state = link.wait(lambda d: d["navigation"]["can"]["goal"], 10, "can.goal")
        frame, s = state["frame"], streams(state)
        self.assertIsNone(frame["joints"])
        self.assertIsNone(frame["qpos"])
        self.assertEqual(frame["joints_status"], "unavailable")
        self.assertEqual((s["g1_debug"]["status"], s["g1_debug"]["configured"]), ("unavailable", False))
        self.assertEqual((s["cloud"]["status"], s["cloud"]["configured"]), ("unavailable", False))
        self.assertFalse(state["perception"]["available"])
        self.assertIsNone(state["navigation"]["map"])  # no cloud: no display map, not an all-unknown one
        link.send(1, cmd="goal", xy=[1.0, 0.5])
        c = link.command(1, timeout=8)
        self.assertEqual(c["status"], "rejected")
        self.assertTrue(c["reason"].startswith("readback mismatch"), c["reason"])
        self.assertIn("node reports goal [1.200, 0.500]", c["reason"])
        self.assertAlmostEqual(c["readback"]["error_m"], 0.2, places=6)
        state = link.latest()
        np.testing.assert_allclose(state["navigation"]["goal"]["xy"], [1.2, 0.5])  # what the node holds
        self.assertIsNone(state["navigation"]["goal"]["seq"])
        # A blocking goal check refuses before anything is sent.
        link.send(2, cmd="goal", xy=[1.0, 0.5], check={"ok": False, "checks": [{"id": "free", "status": "block", "label": "Seen and free"}]})
        c = link.command(2)
        self.assertIn("goal check blocks: Seen and free", c["reason"])
        self.assertNotIn("sent", c)
        time.sleep(0.3)
        link.proc.send_signal(signal.SIGTERM)
        self.assertEqual(link.proc.wait(15), 0)
        result = json.loads((link.dir / "result.json").read_text())
        self.assertEqual((result["status"], result["report"]["stopped_by"]), ("completed", "signal"))
        session = json.loads((link.dir / "session.json").read_text())
        self.assertTrue(all(f["joints"] is None and f["qpos"] is None for f in session["frames"]))
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


if __name__ == "__main__":
    unittest.main()
