"""Deploy's gateway side (studio/deploy_link.py, studio/server.py) against tools/fake_deploy_hub.py, in process, on
loopback ephemeral ports. The fake hub has non-identity frames: the scan's memory frame puts the robot at
start_S = [0.3, -0.2, 1.2], as the contract asks; nothing here talks to a robot, DDS or ZMQ.
"""
import http.client
import json
import math
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from studio import goal_check
from studio.deploy_link import (DeployError, Deploy, DeployLink, apply, compose, inverse, read_panel_target, sanitize)
from studio.server import Catalog, Gateway
from studio.workbench import Workbench

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import fake_deploy_hub as fake  # noqa: E402

TOKEN = os.environ.get("G1_PANEL_TOKEN") or "test-token"
START_S = [0.3, -0.2, 1.2]
CONFIRM = {"gantry": True, "estop": True, "remote": True, "rope": True}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FakeHubCase(unittest.TestCase):
    """A fake deploy hub, and a Deploy facade pointed at it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.hub, self.hub_server = fake.start(["--port", "0", "--panel-port", "0", "--token", TOKEN])
        self.hub_url = f"http://127.0.0.1:{self.hub_server.server_address[1]}"
        self.addCleanup(self._stop_hub)
        token_file = Path(self.tmp.name) / "panel_token"
        token_file.write_text(TOKEN)
        self.link = DeployLink(self.hub_url, token_file)
        self.audit = Path(self.tmp.name) / "audit.jsonl"
        self.deploy = self.make_deploy()

    def make_deploy(self, **kw):
        deploy = Deploy(link=self.link, audit_path=self.audit, **kw)
        self.addCleanup(deploy.close)
        return deploy

    def _stop_hub(self):
        for c in list(self.hub.slots.values()):
            if c is not None:
                c.ended = True
        try:
            self.hub_server.shutdown()
            self.hub_server.server_close()
        except OSError:
            pass
        shutil.rmtree(self.hub.day, ignore_errors=True)
        if self.hub.world.memory_file:
            shutil.rmtree(Path(self.hub.world.memory_file).parent, ignore_errors=True)

    def hub_post(self, path, body):
        return self.hub.post(path, body)

    def start_robot(self):
        code, out = self.hub_post("/api/v1/start", {"mode": "robot", "confirm": CONFIRM})
        self.assertEqual(code, 200, out)
        self.deploy.refresh_state()
        return self.hub.slots["robot"]

    def stop_hub_server(self):
        self.hub_server.shutdown()
        self.hub_server.server_close()


# --------------------------------------------------------------------------------------------- pure helpers
class HelperTests(unittest.TestCase):
    def test_sanitize_makes_strict_json(self):
        out = sanitize({"a": float("nan"), "b": [1.0, float("inf"), {"c": -float("inf")}], "d": "x"})
        self.assertEqual(out, {"a": None, "b": [1.0, None, {"c": None}], "d": "x"})
        json.dumps(out, allow_nan=False)

    def test_pose_helpers_agree_with_the_fake_hub(self):
        a, b = [0.3, -0.2, 1.2], [1.0, 0.5, -0.4]
        for got, want in ((compose(a, b), fake.compose(a, b)), (inverse(a), fake.inverse(a))):
            np.testing.assert_allclose(got, want, atol=1e-12)
        np.testing.assert_allclose(apply(a, [[1.0, 2.0]]), fake.apply(a, [[1.0, 2.0]]), atol=1e-12)
        np.testing.assert_allclose(apply(compose(inverse(a), a), [1.0, 2.0]), [1.0, 2.0], atol=1e-12)

    def test_panel_target_takes_the_hub_port_and_never_the_file_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "panel_url.txt"
            f.write_text("http://100.64.0.7:9001/?t=abc\n")
            self.assertEqual(read_panel_target(f, 8784), (8784, "abc"))
            self.assertEqual(read_panel_target(f, None), (9001, "abc"))
            with self.assertRaises(ValueError):
                read_panel_target(Path(tmp) / "token.txt", 8784)
            f.write_text("http://127.0.0.1:9001/\n")
            with self.assertRaises(ValueError):
                read_panel_target(f, 8784)

    def test_deploy_link_is_loopback_only(self):
        for url in ("http://10.0.0.5:8769", "https://127.0.0.1:8769", "http://example.com"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                DeployLink(url)


class GapAndBlockingTests(unittest.TestCase):
    """The Deploy additions to studio/goal_check.py (check_goal itself is unchanged: six checks)."""

    @staticmethod
    def corridor(width, pose=(0.0, 0.0, 0.0)):
        boxes = [{"center_xy": [0.0, s * (width / 2 + 0.25)], "half_xy": [1.0, 0.25], "yaw": 0.0, "z_bottom": 0.0,
                  "z_top": 1.5} for s in (1, -1)]
        boxes.append({"center_xy": [0.0, 0.0], "half_xy": [0.5, 0.5], "yaw": 0.0, "z_bottom": 1.6, "z_top": 1.7})
        moved = [dict(b, center_xy=apply(list(pose), b["center_xy"]), yaw=b["yaw"] + pose[2]) for b in boxes]
        path = apply(list(pose), [[-2.0, 0.0], [2.0, 0.0]])
        return moved, path

    def test_corridor_width_in_any_frame(self):
        for pose in ((0.0, 0.0, 0.0), (0.3, -0.2, 1.2), (-1.0, 2.0, -2.5)):
            boxes, path = self.corridor(0.8, pose)
            gap = goal_check.route_gap(boxes, path)
            self.assertAlmostEqual(gap["width_m"], 0.8, places=6, msg=pose)
            self.assertAlmostEqual(gap["left_m"], 0.4, places=6)
            self.assertAlmostEqual(np.hypot(*np.subtract(gap["sides_xy"][0], gap["sides_xy"][1])), 0.8, places=6)

    def test_open_sides_and_overhead_boxes_are_not_a_passage(self):
        boxes, path = self.corridor(0.8)
        self.assertIsNone(goal_check.route_gap(boxes[:1] + boxes[2:], path))  # one side open
        self.assertIsNone(goal_check.route_gap(boxes, [[-2.0, 3.0], [2.0, 3.0]]))  # far from both
        self.assertIsNone(goal_check.route_gap([], path))

    def test_gap_check_statuses(self):
        g = lambda w: {"width_m": w, "left_m": w / 2, "right_m": w / 2}
        self.assertEqual(goal_check.gap_check(g(0.5))["status"], "block")
        self.assertEqual(goal_check.gap_check(g(0.8))["status"], "warn")
        self.assertEqual(goal_check.gap_check(g(1.2))["status"], "pass")
        self.assertEqual(goal_check.gap_check(None)["status"], "pass")
        self.assertEqual(goal_check.gap_check(None, have_boxes=False)["status"], "warn")
        self.assertEqual(goal_check.gap_check(None, have_route=False)["status"], "warn")
        self.assertEqual(goal_check.gap_check(g(0.8))["id"], "gap")

    def test_blocking_cells_name_the_obstacle_at_the_goal(self):
        n, res = 81, 0.05
        support = np.zeros((n, n))
        support[45, 40] = 1.2  # a post 0.25 m from the goal (cell [40, 40] at the origin)
        ceiling = np.full((n, n), np.nan)
        grid = goal_check.grid_from_arrays(support, ceiling, [-2.0, -2.0], res)
        result = goal_check.check_goal(grid, [-1.5, 0.0], [0.0, 0.0])
        self.assertEqual(len(result["checks"]), 6)
        self.assertEqual(next(c for c in result["checks"] if c["id"] == "free")["status"], "block")
        cells = goal_check.blocking_cells(grid, result, [-1.5, 0.0], [0.0, 0.0])
        np.testing.assert_allclose(cells, [[0.25, 0.0]], atol=1e-6)
        self.assertEqual(goal_check.blocking_cells(grid, goal_check.check_goal(grid, [-1.5, 0], [-1.0, -1.0]),
                                                   [-1.5, 0], [-1.0, -1.0]), [])


# --------------------------------------------------------------------------------------------- the goal check
class GoalCheckFrameTests(FakeHubCase):
    def test_scene_goals_map_through_start_s(self):
        self.assertEqual(self.hub.world.start_S, START_S)
        out = self.deploy.goal_check("scan-fake", 1.0, 0.5)
        self.assertTrue(out["ok"], out["checks"])
        self.assertEqual(out["frame"], "scene")
        self.assertEqual(out["path_xy"][0], [0.0, 0.0])           # the scan pose is the scene origin
        self.assertEqual(out["path_xy"][-1], [1.0, 0.5])
        self.assertEqual([c["id"] for c in out["checks"]], list(goal_check.CHECK_IDS) + ["gap"])
        # Same answer as check_goal on the memory grid with the goal mapped by hand, geometry mapped back.
        grid = goal_check.load_grid(self.hub.world.memory_file)
        ref = goal_check.check_goal(grid, START_S[:2], apply(START_S, [1.0, 0.5]), arrival_radius_m=0.4)
        np.testing.assert_allclose(apply(inverse(START_S), ref["path_xy"]), out["path_xy"], atol=2e-4)
        self.assertAlmostEqual(ref["path_m"], out["path_m"], places=9)

    def test_an_identity_frame_would_check_a_different_place(self):
        # On the left tower in the scene (fake room: towers at x = 2, y = +-0.595) ...
        out = self.deploy.goal_check("scan-fake", 2.0, 0.6)
        self.assertEqual(next(c for c in out["checks"] if c["id"] == "free")["status"], "block")
        self.assertFalse(out["ok"])
        pts = np.asarray(out["blocking_xy"])
        self.assertTrue(len(pts))
        self.assertTrue(((np.abs(pts[:, 0] - 2.0) <= 0.3) & (np.abs(pts[:, 1] - 0.595) <= 0.3)).all(), pts)
        # ... while the same numbers read as memory_S coordinates are free floor.
        grid = goal_check.load_grid(self.hub.world.memory_file)
        raw = goal_check.check_goal(grid, START_S[:2], [2.0, 0.6], arrival_radius_m=0.4)
        self.assertNotEqual(next(c for c in raw["checks"] if c["id"] == "free")["status"], "block")

    def test_gap_between_the_towers_and_blocking_cells_in_scene(self):
        out = self.deploy.goal_check("scan-fake", 2.0, 0.0)  # between towers 0.69 m apart: inside the route margin
        self.assertFalse(out["ok"])
        self.assertEqual(next(c for c in out["checks"] if c["id"] == "reachable")["status"], "block")
        pts = np.asarray(out["blocking_xy"])
        self.assertLessEqual(len(pts), 200)
        self.assertTrue((np.abs(pts[:, 0] - 2.0) <= 0.75).all())  # the towers, not the far wall at x = 3.6
        out = self.deploy.goal_check("scan-fake", 3.0, 1.2)
        self.assertIsNotNone(out["path_xy"])
        if out["gap"] is not None:
            self.assertGreater(out["gap"]["width_m"], 0.0)
            self.assertEqual(len(out["gap"]["sides_xy"]), 2)

    def test_check_ids_gate_send_goal(self):
        clock = Clock()
        deploy = self.make_deploy(clock=clock, autostart=False)
        self.start_robot()
        lease = deploy.lease_take({"operator": "op"})["lease_id"]
        good = deploy.goal_check("scan-fake", 1.0, 0.5)
        bad = deploy.goal_check("scan-fake", 2.0, 0.6)
        send = lambda **kw: deploy.act(dict({"act": "send_goal", "slot": "robot", "scan": "scan-fake",
                                             "goal_scene": [1.0, 0.5], "lease_id": lease}, **kw))
        for kw, why in (({}, "needs a goal check"), ({"check_id": "nope"}, "needs a goal check"),
                        ({"check_id": good["check_id"], "goal_scene": [1.1, 0.5]}, "another scan or goal"),
                        ({"check_id": good["check_id"], "scan": "scan-other"}, "another scan or goal"),
                        ({"check_id": bad["check_id"], "goal_scene": [2.0, 0.6]}, "blocked")):
            with self.subTest(kw=kw), self.assertRaisesRegex(DeployError, why) as ctx:
                send(**kw)
            self.assertEqual(ctx.exception.status, 409)
        before = len(self.hub.actions)
        status, out = send(check_id=good["check_id"])
        self.assertEqual(self.hub.actions[before]["path"], "/api/v1/send_goal")  # relayed (the fake refuses: not armed)
        self.assertEqual(self.hub.actions[before]["body"]["check_id"], good["check_id"])
        clock.t += 601.0                                            # (the lease lapsed too: take a fresh one)
        lease = deploy.lease_take({"operator": "op", "take_over": True})["lease_id"]
        with self.assertRaisesRegex(DeployError, "last 10 min"):
            send(check_id=good["check_id"], lease_id=lease)

    def test_unknown_scan_and_bad_numbers(self):
        with self.assertRaises(DeployError) as ctx:
            self.deploy.goal_check("no-such-scan", 1.0, 0.0)
        self.assertEqual(ctx.exception.status, 404)
        with self.assertRaises(DeployError):
            self.deploy.goal_check("../etc", 1.0, 0.0)
        with self.assertRaises(DeployError):
            self.deploy.goal_check("scan-fake", float("nan"), 0.0)


# --------------------------------------------------------------------------------------------- lease and acts
class LeaseAndActTests(FakeHubCase):
    def test_one_holder_heartbeat_expiry_and_take_over(self):
        clock = Clock()
        d = self.make_deploy(clock=clock, autostart=False)
        a = d.lease_take({"operator": "Linji"})
        self.assertEqual(a["holder"], "Linji")
        with self.assertRaises(DeployError) as ctx:
            d.lease_take({"operator": "Other"})
        self.assertEqual((ctx.exception.status, ctx.exception.extra["holder"]), (409, "Linji"))
        clock.t += 2.9
        d.lease_renew({"lease_id": a["lease_id"]})
        clock.t += 2.9
        self.assertEqual(d.lease_holder(a["lease_id"]), "Linji")  # renewed 2.9 s ago
        clock.t += 0.2
        self.assertIsNone(d.lease_holder(a["lease_id"]))           # 3.1 s without a heartbeat: lost
        with self.assertRaises(DeployError):
            d.lease_renew({"lease_id": a["lease_id"]})
        b = d.lease_take({"operator": "Other"})                     # free again
        c = d.lease_take({"operator": "Third", "take_over": True})  # taken over (logged)
        with self.assertRaisesRegex(DeployError, "Third holds"):
            d.lease_renew({"lease_id": b["lease_id"]})
        self.assertEqual(d.lease_release({"lease_id": b["lease_id"]}), {"released": False})
        self.assertEqual(d.lease_release({"lease_id": c["lease_id"]}), {"released": True})
        self.assertIsNone(d.lease_public())
        rows = [json.loads(l) for l in self.audit.read_text().splitlines()]
        self.assertIn({"kind": "lease_take", "holder": "Third", "took_over_from": "Other"},
                      [{k: r.get(k) for k in ("kind", "holder", "took_over_from")} for r in rows])
        with self.assertRaises(DeployError):
            d.lease_take({"operator": "  "})

    def test_motion_acts_need_the_lease_and_safety_acts_never(self):
        clock = Clock()
        d = self.make_deploy(clock=clock, autostart=False)
        for act in ("start", "arm", "s", "c", "send_goal", "g", "rehearse", "practice_scan", "scan", "stop"):
            with self.subTest(act=act), self.assertRaises(DeployError) as ctx:
                d.act({"act": act, "slot": "robot"})
            self.assertEqual((ctx.exception.status, ctx.exception.extra["need"]), (409, "lease"))
        for act in ("h", "t", "tag", "note", "doctor", "start_check"):
            before = len(self.hub.actions)
            d.act({"act": act, "slot": "robot"})                     # relayed (the fake answers 404: no session)
            self.assertEqual(len(self.hub.actions), before + 1, act)
        lease = d.lease_take({"operator": "Linji"})["lease_id"]
        clock.t += 3.5
        with self.assertRaises(DeployError):
            d.act({"act": "arm", "slot": "robot", "lease_id": lease})  # an expired lease is no lease
        for act in ("estop", "quit", "goal", "lease", "goal_odom", None):
            with self.subTest(act=act), self.assertRaisesRegex(DeployError, "not relayed") as ctx:
                d.act({"act": act, "slot": "robot"})
            self.assertEqual(ctx.exception.status, 400)

    def test_gateway_fills_id_source_and_operator(self):
        self.start_robot()
        lease = self.deploy.lease_take({"operator": "Linji"})["lease_id"]
        status, out = self.deploy.act({"act": "arm", "slot": "robot", "lease_id": lease, "source": "panel",
                                       "operator": "someone else"})
        self.assertEqual(status, 200, out)
        body = self.hub.actions[-1]["body"]
        self.assertEqual((body["source"], body["operator"]), ("studio", "Linji"))
        self.assertTrue(body["id"])
        self.assertNotIn("lease_id", body)
        status, out = self.deploy.act({"act": "tag", "slot": "robot", "id": "fixed-id", "operator": "Tagger", "n": 1})
        body = self.hub.actions[-1]["body"]
        self.assertEqual((body["id"], body["operator"], body["source"]), ("fixed-id", "Tagger", "studio"))

    def test_the_lease_reaches_each_live_console_and_locks_the_phone_go(self):
        console = self.start_robot()
        self.deploy.touch()                                         # the refresher runs while a page is active
        lease = self.deploy.lease_take({"operator": "Linji"})
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not (console.lease or {}).get("holder"):
            time.sleep(0.05)
        self.assertEqual(console.lease["holder"], "Linji")
        self.assertGreater(console.lease["until"], time.time() + 1.0)
        self.assertIn("Studio holds the operator lease", " ".join(console.go_locks(source="panel")))
        self.assertNotIn("Studio holds the operator lease", " ".join(console.go_locks(source="studio")))
        self.deploy.lease_release({"lease_id": lease["lease_id"]})
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and console.lease.get("holder"):
            time.sleep(0.05)
        self.assertIsNone(console.lease["holder"])
        self.assertNotIn("Studio holds the operator lease", " ".join(console.go_locks(source="panel")))


# --------------------------------------------------------------------------------------------- guards
class GuardTests(FakeHubCase):
    def test_guards_follow_the_deploy_service_and_stay_when_it_goes_away(self):
        clock = Clock()
        d = self.make_deploy(clock=clock, autostart=False)
        self.assertIsNone(d.robot_guard())
        self.assertIsNone(d.cpu_guard())
        code, _ = self.hub_post("/api/v1/start", {"mode": "robot", "confirm": CONFIRM})
        self.assertIsNone(d.robot_guard())                          # asked 0 s ago: not again yet
        clock.t += 2.5
        console = self.hub.slots["robot"]
        self.assertIn(console.name, d.robot_guard())
        self.assertIn("deploy service", d.robot_guard())
        self.assertIn("robot session", d.cpu_guard())
        self.stop_hub_server()                                      # unreachable: the last answer stays in force
        clock.t += 2.5
        self.assertIn("last known", d.robot_guard())
        self.assertIn("robot session", d.cpu_guard())

    def test_a_practice_session_blocks_cpu_jobs_but_not_the_robot_link(self):
        self.hub.slots["sim"] = fake.FakeConsole(self.hub, "sim", self.hub.world, practice=True)
        self.deploy.refresh_state()
        self.assertIsNone(self.deploy.robot_guard())
        self.assertIn("practice session", self.deploy.cpu_guard())

    def test_never_reached_means_none_known(self):
        d = Deploy(link=DeployLink("http://127.0.0.1:9", Path(self.tmp.name) / "panel_token"))
        self.addCleanup(d.close)
        self.assertIsNone(d.robot_guard())
        self.assertIsNone(d.cpu_guard())
        self.assertEqual(d.sessions()["basis"], "none known")

    def test_workbench_refuses_cpu_jobs_and_direct_robot_commands(self):
        catalog_file = Path(self.tmp.name) / "catalog.json"
        catalog_file.write_text(json.dumps({"sessions": []}))
        w = Workbench(Catalog(catalog_file), Path(self.tmp.name) / "data", worker_python=sys.executable)
        w.deploy_guard = self.deploy
        sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(lambda: (sleeper.kill(), sleeper.wait()))
        out = Path(self.tmp.name) / "data" / "jobs" / "job-aaaaaaaaaaaa"
        (out / "run" / "inbox").mkdir(parents=True)
        w.jobs["job-aaaaaaaaaaaa"] = {"id": "job-aaaaaaaaaaaa", "status": "running", "kind": "robot", "output": out,
                                      "process": sleeper, "latest": None, "navigation": {"robot": "real"},
                                      "scenario": {"label": "x"}}
        w.nav_command("job-aaaaaaaaaaaa", {"cmd": "end"})            # nothing live: the guard is quiet
        self.start_robot()
        for call in (lambda: w.start_job("scenario-aaaaaaaaaaaa"), lambda: w.start_suite({"scenario_ids": ["x"]})):
            with self.assertRaisesRegex(ValueError, "deploy kit runs a robot session"):
                call()
        for cmd in ({"cmd": "stand"}, {"cmd": "goal", "xy": [1.0, 0.0]}):
            with self.assertRaisesRegex(ValueError, "not sent: the deploy kit runs a robot session"):
                w.nav_command("job-aaaaaaaaaaaa", cmd)
        self.assertEqual(w.nav_command("job-aaaaaaaaaaaa", {"cmd": "end"})["cmd"], "end")  # End is never refused
        self.assertEqual(sorted(p.name for p in (out / "run" / "inbox").iterdir()), ["000001.json", "000002.json"])
        self.assertEqual(w._deploy_service(), {"url": self.hub_url, "token_file": str(self.link.token_file)})

    def test_robot_link_refuses_goal_and_stand_while_the_kit_runs_a_robot_session(self):
        from studio.robot_link import ConfigError, RobotLink, load_config
        endpoints = {"odom": "tcp://127.0.0.1:5561", "control": "tcp://127.0.0.1:5562"}
        service = {"url": self.hub_url, "token_file": str(self.link.token_file)}
        self.assertEqual(load_config({"endpoints": endpoints, "deploy_service": service})["deploy_service"], service)
        self.assertIsNone(load_config({"endpoints": endpoints})["deploy_service"])
        for bad in ({"url": "http://10.1.2.3:8769"}, {"url": self.hub_url, "extra": 1}, "http://127.0.0.1:8769"):
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                load_config({"endpoints": endpoints, "deploy_service": bad})
        link = RobotLink(load_config({"endpoints": endpoints, "deploy_service": service}), Path(self.tmp.name) / "run")
        watcher = threading.Thread(target=link._deploy_loop, daemon=True)
        watcher.start()
        self.addCleanup(link.stop_event.set)
        console = self.start_robot()
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline and link.deploy_session is None:
            time.sleep(0.05)
        self.assertEqual(link.deploy_session, console.name)
        can, reasons = link._can()
        self.assertFalse(can["goal"] or can["stand"])
        self.assertIn("deploy kit runs a robot session", reasons["goal"])
        self.assertTrue(can["end"])
        self.stop_hub_server()                                      # unreachable: still refused
        time.sleep(1.3)
        self.assertEqual(link.deploy_session, console.name)

    @unittest.skipUnless(shutil.which("bash") and shutil.which("curl"), "bash and curl")
    def test_service_script_refuses_release_while_a_session_is_live(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            unused = s.getsockname()[1]
        env = dict(os.environ, G1_DEPLOY_SERVICE=self.hub_url, G1_PANEL_TOKEN=TOKEN, STUDIO_PORT=str(unused),
                   STUDIO_DATA=self.tmp.name)
        run = lambda *a: subprocess.run(["bash", str(ROOT / "tools/studio_service.sh"), "guard", *a], env=env,
                                        capture_output=True, text=True, timeout=60)
        self.assertEqual(run().returncode, 0)
        self.start_robot()
        refused = run()
        self.assertEqual(refused.returncode, 3, refused.stderr)
        self.assertIn("Refusing", refused.stderr)
        self.assertIn("robot", refused.stderr)
        forced = run("--force")
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertIn("Forced", forced.stderr)


# --------------------------------------------------------------------------------------------- the gateway (HTTP)
class GatewayCase(FakeHubCase):
    def setUp(self):
        super().setUp()
        catalog_file = Path(self.tmp.name) / "catalog.json"
        catalog_file.write_text(json.dumps({"sessions": []}))
        self.catalog = Catalog(catalog_file)
        self.catalog.enable_workbench(Path(self.tmp.name) / "data")
        self.server = Gateway(("127.0.0.1", 0), self.catalog, self.deploy)
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))

    def call(self, method, path, body=None, headers=None, origin=True, timeout=10):
        h = {"Content-Type": "application/json", **({"Origin": self.base} if origin else {}), **(headers or {})}
        req = urllib.request.Request(self.base + path, method=method, headers=h,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            with OPENER.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read()
            return e.code, json.loads(raw) if raw.strip() else {}

    def csrf(self):
        return {"X-Studio-Token": self.catalog.workbench.token}

    def estop(self, path="/api/deploy/estop", body=None, headers=None, timeout=5):
        """A raw E-STOP POST on a fresh connection; returns (status, body, seconds)."""
        t0 = time.monotonic()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request("POST", path, body=json.dumps(body or {}).encode(),
                         headers={"Content-Type": "application/json", "Origin": self.base, "X-Studio-Estop": "1",
                                  **(headers or {})})
            r = conn.getresponse()
            out = r.status, json.loads(r.read() or b"{}")
        finally:
            conn.close()
        return out[0], out[1], time.monotonic() - t0


class GatewayTests(GatewayCase):
    def test_passthrough_state_carries_the_gateways_view(self):
        status, state = self.call("GET", "/api/deploy/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["api"], 1)
        self.assertEqual(set(state["studio"]), {"estop_targets", "hub", "lease", "refresher"})
        console = self.start_robot()
        status, link = self.call("GET", "/api/deploy/link")
        self.assertEqual([t["name"] for t in link["estop_targets"]], [console.name])
        self.assertNotIn(TOKEN, json.dumps(link))                   # the panel token never reaches the browser
        self.stop_hub_server()
        status, state = self.call("GET", "/api/deploy/state")
        self.assertEqual(status, 503)
        self.assertIn("not reachable", state["error"])
        self.assertEqual([t["name"] for t in state["studio"]["estop_targets"]], [console.name])  # still shown

    def test_passthrough_rejects_bad_names_and_resanitises(self):
        self.assertEqual(self.call("GET", "/api/deploy/scan/scene?name=../x")[0], 400)
        self.assertEqual(self.call("GET", "/api/deploy/live?slot=")[0], 400)

        class NaNHub(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"api": 1, "x": NaN, "y": [Infinity, 1.5], "live": {}}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), NaNHub)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        self.deploy._link = DeployLink(f"http://127.0.0.1:{srv.server_address[1]}", self.link.token_file)
        status, state = self.call("GET", "/api/deploy/state")
        self.assertEqual((status, state["x"], state["y"]), (200, None, [None, 1.5]))

    def test_posts_need_the_csrf_token_and_estop_needs_its_header_instead(self):
        self.assertEqual(self.call("POST", "/api/deploy/lease", {"operator": "x"})[0], 403)
        self.assertEqual(self.call("POST", "/api/deploy/act", {"act": "h", "slot": "robot"})[0], 403)
        status, lease = self.call("POST", "/api/deploy/lease", {"operator": "Linji"}, self.csrf())
        self.assertEqual((status, lease["holder"]), (200, "Linji"))
        self.assertEqual(self.call("POST", "/api/deploy/lease", {"operator": "B"}, self.csrf())[0], 409)
        self.assertEqual(self.call("POST", "/api/deploy/lease/renew", {"lease_id": lease["lease_id"]}, self.csrf())[0], 200)
        self.assertEqual(self.call("POST", "/api/deploy/lease/renew", {"lease_id": "x"}, self.csrf())[0], 409)
        self.assertEqual(self.call("POST", "/api/deploy/act", {"act": "arm", "slot": "robot"}, self.csrf())[0], 409)
        # E-STOP: no CSRF token, but X-Studio-Estop: 1 and a same-origin Origin.
        self.assertEqual(self.call("POST", "/api/deploy/estop", {})[0], 403)
        self.assertEqual(self.call("POST", "/api/deploy/estop", {}, {"X-Studio-Estop": "1"}, origin=False)[0], 403)
        self.assertEqual(self.call("POST", "/api/deploy/estop", {}, {"X-Studio-Estop": "1",
                                                                     "Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(self.call("POST", "/api/deploy/estop", {}, {"X-Studio-Estop": "1",
                                                                     "Sec-Fetch-Site": "cross-site"})[0], 403)
        status, out = self.call("POST", "/api/deploy/estop", {}, {"X-Studio-Estop": "1"})
        self.assertEqual((status, out["ok"], out["targets"]), (200, False, []))  # nothing live: honest, not ok
        self.assertIn("physical E-stop", out["error"])

    def test_estop_reaches_every_live_console_without_the_hub(self):
        robot = self.start_robot()
        sim = fake.FakeConsole(self.hub, "sim", self.hub.world, practice=True)
        self.hub.slots["sim"] = sim
        self.call("GET", "/api/deploy/state")                       # a state poll fills the cache
        self.stop_hub_server()
        status, out, dt = self.estop()
        self.assertEqual(status, 200)
        self.assertTrue(out["ok"], out)
        self.assertEqual({t["slot"] for t in out["targets"]}, {"robot", "sim"})
        self.assertTrue(all(t["key_sent"] and t["confirmed"] and t["latency_ms"] is not None for t in out["targets"]))
        self.assertEqual((robot.runner, sim.runner), ("E-STOP", "E-STOP"))
        self.assertLess(dt, 0.3)
        rows = [json.loads(l) for l in self.audit.read_text().splitlines()]
        self.assertEqual(rows[-1]["kind"], "estop")

    def test_heartbeat_reads_each_console_on_the_direct_path(self):
        robot = self.start_robot()
        self.stop_hub_server()
        status, out = self.call("GET", "/api/deploy/heartbeat")
        self.assertEqual(status, 200)
        (row,) = out["targets"]
        self.assertEqual((row["slot"], row["name"], row["ok"]), ("robot", robot.name, True))
        self.assertLess(row["console_age_s"], 0.5)
        robot.ended = True                                          # the console ends: its panel closes
        time.sleep(0.2)
        row = self.call("GET", "/api/deploy/heartbeat")[1]["targets"][0]
        self.assertFalse(row["ok"])
        self.assertTrue(row["error"])

    def test_a_hung_console_costs_one_second_and_never_hides_the_other(self):
        self.start_robot()
        sim = fake.FakeConsole(self.hub, "sim", self.hub.world, practice=True)
        self.hub.slots["sim"] = sim
        self.deploy.refresh_state()
        sim.panel_delay_s = 3.0
        status, out, dt = self.estop()
        rows = {t["slot"]: t for t in out["targets"]}
        self.assertFalse(out["ok"])
        self.assertTrue(rows["robot"]["ok"])
        self.assertFalse(rows["sim"]["ok"])
        self.assertTrue(rows["sim"]["error"])
        self.assertLess(dt, 1.6)

    def test_direct_stand_and_takeover(self):
        robot = self.start_robot()
        status, out = self.call("POST", "/api/deploy/direct", {"slot": "robot", "act": "h"}, {"X-Studio-Estop": "1"})
        self.assertEqual((status, out["ok"], out["slot"]), (200, True, "robot"))
        self.assertEqual(robot.acts[-1]["source"], "studio")
        self.assertEqual(self.call("POST", "/api/deploy/direct", {"slot": "robot", "act": "g"}, {"X-Studio-Estop": "1"})[0], 400)
        self.assertEqual(self.call("POST", "/api/deploy/direct", {"slot": "sim", "act": "t"}, {"X-Studio-Estop": "1"})[0], 404)
        self.assertEqual(self.call("POST", "/api/deploy/direct", {"slot": "robot", "act": "h"})[0], 403)

    def test_act_relay_end_to_end_with_the_lease(self):
        _, lease = self.call("POST", "/api/deploy/lease", {"operator": "Linji"}, self.csrf())
        status, out = self.call("POST", "/api/deploy/act", {"act": "start", "mode": "robot", "confirm": CONFIRM,
                                                            "lease_id": lease["lease_id"]}, self.csrf())
        self.assertEqual((status, out["slot"]), (200, "robot"))
        self.assertEqual(self.hub.actions[-1]["body"]["operator"], "Linji")
        status, check = self.call("GET", "/api/deploy/goal_check?scan=scan-fake&x=1.0&y=0.5")
        self.assertEqual(status, 200)
        self.assertTrue(check["check_id"])
        status, out = self.call("POST", "/api/deploy/act", {"act": "send_goal", "slot": "robot", "scan": "scan-fake",
                                                            "goal_scene": [1.0, 0.5], "check_id": check["check_id"],
                                                            "lease_id": lease["lease_id"]}, self.csrf())
        self.assertEqual(self.hub.actions[-1]["path"], "/api/v1/send_goal")
        self.assertEqual(self.call("GET", "/api/deploy/goal_check?scan=scan-fake&x=a&y=0")[0], 422)

    def test_safety_states_the_relay_model(self):
        status, safety = self.call("GET", "/api/safety")
        self.assertEqual((safety["hardware_enabled"], safety["motor_command_path"], safety["dds_participants"]),
                         (False, False, 0))
        self.assertEqual(safety["deploy"]["role"], "relay")
        self.assertEqual(safety["deploy"]["independent_of_the_console"], ["the physical E-stop"])

    def test_model_for_deploy_without_a_session(self):
        from studio.replay import FLOW_ROOT, JOINT_NAMES
        if not (FLOW_ROOT / "sim/assets/g1_29dof.xml").is_file():
            self.skipTest("deploy root model not on this machine")
        status, model = self.call("GET", "/api/deploy/model")
        self.assertEqual(status, 200)
        self.assertEqual(model["joint_names"], list(JOINT_NAMES))
        self.assertEqual(model["spec"]["nq"], 36)

        def meshes(body):
            return [g["url"] for g in body["geometries"] if "url" in g] + [u for c in body["children"] for u in meshes(c)]
        url = meshes(model["spec"]["root"])[0]
        with OPENER.open(urllib.request.Request(self.base + url), timeout=10) as r:
            self.assertEqual(r.status, 200)


class AdmissionTests(GatewayCase):
    """Review B4: the E-STOP is served while the 12 general slots are held and the deploy service is gone."""

    def hold_general_slots(self):
        held = []
        for _ in range(12):
            s = socket.create_connection(("127.0.0.1", self.port))
            s.sendall(b"GET /api/deploy/state HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n" % self.port)  # never finished
            held.append(s)
        self.addCleanup(lambda: [s.close() for s in held])
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if not self.server.slots.acquire(blocking=False):
                return held
            self.server.slots.release()
            time.sleep(0.01)
        self.fail("the 12 general slots never filled")

    def test_estop_acknowledged_under_300_ms_with_12_slow_requests_and_the_hub_stopped(self):
        robot = self.start_robot()
        self.stop_hub_server()
        self.hold_general_slots()
        status, body = self.call("GET", "/api/version", timeout=3)
        self.assertEqual(status, 503)                               # the reserve tier serves nothing else
        times = []
        for _ in range(3):
            status, out, dt = self.estop()
            self.assertEqual(status, 200)
            self.assertTrue(out["ok"], out)
            times.append(dt)
        self.assertEqual(robot.runner, "E-STOP")
        self.assertLess(max(times), 0.3, times)
        status, out, dt = self.estop("/api/deploy/direct", {"slot": "robot", "act": "h"})
        self.assertIn(status, (200, 409))                           # served (the console refuses h after E-STOP)
        self.assertEqual(out["slot"], "robot")

    def test_estop_with_12_requests_waiting_on_a_hung_deploy_service(self):
        robot = self.start_robot()
        hung = socket.socket()
        hung.bind(("127.0.0.1", 0))
        hung.listen(64)                                              # accepts, never answers
        self.addCleanup(hung.close)
        self.deploy._link = DeployLink(f"http://127.0.0.1:{hung.getsockname()[1]}", self.link.token_file)
        threads = [threading.Thread(target=self.call, args=("GET", "/api/deploy/live?slot=robot"), daemon=True)
                   for _ in range(12)]
        for th in threads:
            th.start()
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if not self.server.slots.acquire(blocking=False):
                break
            self.server.slots.release()
            time.sleep(0.01)
        status, out, dt = self.estop()
        self.assertTrue(out["ok"], out)
        self.assertLess(dt, 0.3)
        self.assertEqual(robot.runner, "E-STOP")

    def test_a_reserve_slot_is_given_back_after_one_second_of_silence(self):
        self.start_robot()
        self.hold_general_slots()
        silent = [socket.create_connection(("127.0.0.1", self.port)) for _ in range(4)]  # take the reserve slots
        self.addCleanup(lambda: [s.close() for s in silent])
        time.sleep(0.2)
        try:
            status = self.estop()[0]
        except (ConnectionError, OSError, http.client.HTTPException):
            status = None
        self.assertIn(status, (503, None))                           # all 16 slots taken
        time.sleep(1.2)                                              # the silent ones are cut at 1 s
        status, out, dt = self.estop()
        self.assertEqual(status, 200)
        self.assertTrue(out["ok"])


if __name__ == "__main__":
    unittest.main()
