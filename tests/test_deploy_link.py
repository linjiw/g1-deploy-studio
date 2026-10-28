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
import urllib.parse
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
    hub_args = ()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.hub, self.hub_server = fake.start(["--port", "0", "--panel-port", "0", "--token", TOKEN, *self.hub_args])
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
        for c in list(self.hub.slots.values()) + list(self.hub.consoles.values()):
            if c is not None:
                c.ended = True
        try:
            self.hub.server.shutdown()
            self.hub.server.server_close()
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
        good = deploy.goal_check("scan-fake", 1.0, 0.5, "deploy")    # the session's profile
        bad = deploy.goal_check("scan-fake", 2.0, 0.6, "deploy")
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
        self.assertEqual(set(state["studio"]), {"estop_targets", "hub", "lease", "refresher", "audit", "capabilities"})
        self.assertIsNotNone(state["source_age_s"])
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
        self.deploy.audit_flush()                                   # E-STOP's audit row is written off its path
        rows = [json.loads(l) for l in self.audit.read_text().splitlines()]
        self.assertEqual(rows[-1]["kind"], "estop")

    def test_heartbeat_reads_each_console_on_the_direct_path(self):
        robot = self.start_robot()
        self.stop_hub_server()
        status, out = self.call("GET", "/api/deploy/heartbeat")
        self.assertEqual(status, 200)
        (row,) = out["consoles"]
        self.assertEqual((row["slot"], row["session"], row["reached"], row["state"]), ("robot", robot.name, True, "fresh"))
        self.assertLess(row["console_age_s"], 0.5)
        self.assertIsNotNone(out["hub"]["age_s"])                   # measured now, while the deploy service is down
        robot.ended = True                                          # the console ends: its panel closes
        time.sleep(0.2)
        row = self.call("GET", "/api/deploy/heartbeat")[1]["consoles"][0]
        self.assertEqual((row["reached"], row["console_age_s"], row["state"]), (False, None, "unknown"))
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
        status, check = self.call("GET", "/api/deploy/goal_check?scan=scan-fake&x=1.0&y=0.5&profile=deploy")
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



# --------------------------------------------------------------------------------------------- contract v3 (Astra's review)
def wait_for(pred, timeout=5.0, step=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(step)
    return False


class HeartbeatV3Tests(GatewayCase):
    """C: each console measured now on the direct path; unknown is never healthy."""

    def test_frozen_panel_keeps_a_fresh_heartbeat_and_a_hung_console_is_unknown(self):
        robot = self.start_robot()
        self.hub.faults.set(freeze_panel=True)                      # the hub's view of the panel freezes ...
        row = self.call("GET", "/api/deploy/heartbeat")[1]["consoles"][0]
        self.assertEqual((row["reached"], row["state"]), (True, "fresh"))  # ... the console itself answers
        self.hub.faults.set(freeze_panel=False, hang_console=True)
        t0 = time.monotonic()
        status, out = self.call("GET", "/api/deploy/heartbeat")
        row = out["consoles"][0]
        self.assertLess(time.monotonic() - t0, 1.0)
        self.assertEqual((row["slot"], row["session"], row["reached"], row["console_age_s"], row["state"]),
                         ("robot", robot.name, False, None, "unknown"))
        self.assertIsNotNone(row["at"])
        self.hub.faults.set(hang_console=False)
        self.assertTrue(wait_for(lambda: self.call("GET", "/api/deploy/heartbeat")[1]["consoles"][0]["reached"]))

    def test_source_ages_for_the_view_the_panel_and_the_state(self):
        self.start_robot()
        self.hub.post("/api/v1/act", {"slot": "robot", "act": "arm", "id": "arm"})
        _, view = self.call("GET", "/api/deploy/live?slot=robot")
        self.assertLess(view["source_age_s"], 0.5)
        self.hub.faults.set(freeze_view=True, freeze_panel=True)
        self.call("GET", "/api/deploy/panel?slot=robot")
        time.sleep(1.1)
        _, view = self.call("GET", "/api/deploy/live?slot=robot")
        _, panel = self.call("GET", "/api/deploy/panel?slot=robot")
        self.assertGreater(view["source_age_s"], 1.0)                # stale, measured on this host's clock
        self.assertGreater(panel["source_age_s"], 1.0)
        self.assertLess(self.call("GET", "/api/deploy/state")[1]["source_age_s"], 0.5)


class UncertainActTests(GatewayCase):
    """D / F07: a reply that never came is "unknown", never "refused", never sent again."""

    def take_lease(self):
        return self.call("POST", "/api/deploy/lease", {"operator": "Linji"}, self.csrf())[1]["lease_id"]

    def relayed(self, act):
        return [a for a in self.hub.actions if a["path"] == "/api/v1/act" and a["body"].get("act") == act]

    def test_a_lost_console_reply_is_unknown_never_resent_then_reconciled(self):
        robot = self.start_robot()
        lease = self.take_lease()
        self.hub.faults.set(console_drop_reply=1, console_drop_acts=["arm"])
        status, out = self.call("POST", "/api/deploy/act", {"act": "arm", "slot": "robot", "lease_id": lease,
                                                            "expect": {"session": robot.name}}, self.csrf())
        self.assertEqual(status, 202, out)
        self.assertEqual((out["state"], out["act"], out["slot"], out["session"], out["retried"]),
                         ("unknown", "arm", "robot", robot.name, False))
        self.assertNotIn("refused", json.dumps(out))
        self.assertEqual(len(self.relayed("arm")), 1)                # sent once
        self.assertIsNotNone(robot.armed_t)                           # and carried out
        status, rec = self.call("GET", f"/api/deploy/act_status?slot=robot&id={out['id']}")
        self.assertEqual((status, rec["known"], rec["result"], rec["session"]), (200, True, "done", robot.name))
        self.assertFalse(self.call("GET", "/api/deploy/act_status?slot=robot&id=never")[1]["known"])
        self.assertEqual(self.call("GET", "/api/deploy/act_status?slot=robot&id=../x")[0], 400)
        self.assertIn("act_unknown", [json.loads(l)["kind"] for l in self.audit.read_text().splitlines()])

    def test_a_reply_the_service_lost_or_never_sent_in_time_is_unknown(self):
        self.start_robot()
        self.hub.faults.set(hub_drop_reply=1)                         # applied, then the connection closed
        status, out = self.deploy.act({"act": "note", "slot": "robot", "operator": "x"})
        self.assertEqual((status, out["state"]), (202, "unknown"))
        quick = self.make_deploy(post_timeout_s=0.5, autostart=False)
        quick.refresh_state()
        self.hub.faults.set(act_delay_s=1.0)                          # a stalled request mid-confirmation
        status, out = quick.act({"act": "note", "slot": "robot", "operator": "x"})
        self.assertEqual((status, out["state"], out["reconcile"]), (202, "unknown", "act_status"))
        self.assertTrue(wait_for(lambda: quick.act_status("robot", out["id"])[1]["known"], timeout=3))
        self.assertEqual(quick.act_status("robot", out["id"])[1]["result"], "done")
        self.assertEqual(len(self.relayed("note")), 2)                # two presses, two sends: none repeated

    def test_send_goal_whose_console_reply_is_lost_is_unknown(self):
        robot = self.start_robot()
        self.hub.post("/api/v1/act", {"slot": "robot", "act": "arm", "id": "arm"})
        self.assertTrue(wait_for(lambda: robot.phase == "WAIT", timeout=6))
        lease = self.deploy.lease_take({"operator": "Linji"})["lease_id"]
        check = self.deploy.goal_check("scan-fake", 1.0, 0.5, "deploy")
        self.hub.faults.set(console_drop_reply=1, console_drop_acts=["goal_odom"])
        status, out = self.deploy.act({"act": "send_goal", "slot": "robot", "scan": "scan-fake", "goal_scene": [1.0, 0.5],
                                       "check_id": check["check_id"], "lease_id": lease})
        self.assertEqual((status, out["state"], out["act"]), (202, "unknown", "send_goal"))
        self.assertEqual(self.deploy.act_status("robot", out["id"])[1]["result"], "done")
        self.assertEqual(robot.goal_seq, 1)

    def test_refusals_and_missing_sessions_stay_answers(self):
        status, out = self.deploy.act({"act": "note", "slot": "robot"})
        self.assertEqual(status, 404)                                  # no session: an answer, not "unknown"
        robot = self.start_robot()
        status, out = self.deploy.act({"act": "c", "slot": "robot", "lease_id": self.deploy.lease_take(
            {"operator": "x"})["lease_id"]})
        self.assertEqual((status, out["result"]), (200, "refused"))
        robot.panel.shutdown()                                         # the panel no longer listens: not delivered
        robot.panel.server_close()
        status, out = self.deploy.act({"act": "note", "slot": "robot"})
        self.assertEqual(status, 502)
        self.assertIn("Connection refused", out["error"])


class ReviewTests(GatewayCase):
    """E / F05: the session's detail, its exact Replay id (discovery forced), tags on ended sessions."""

    def link_day(self):
        self.hub.studio_link = self.hub.link_studio(Path(self.tmp.name) / "data")

    def test_session_detail_with_the_exact_replay_id_after_forced_discovery(self):
        self.link_day()
        self.catalog.discover_console()                               # throttled for 10 s from now
        robot = self.start_robot()
        status, d = self.call("GET", f"/api/deploy/session?name={robot.name}")
        self.assertEqual(status, 200)
        self.assertEqual(d["receipt"]["session"], robot.name)
        self.assertEqual(d["replay"]["state"], "registered")
        self.assertEqual(d["replay"]["catalog_id"], fake.studio_id(Path(self.hub.day), robot.name))
        self.assertIn("still recording", d["replay"]["detail"])
        self.assertIn(d["replay"]["catalog_id"], [s["id"] for s in self.catalog.listing()["sessions"]])
        self.hub.post("/api/v1/stop", {"slot": "robot"})
        self.assertTrue(wait_for(lambda: (robot.dir / "console_summary.json").is_file()))
        d = self.call("GET", f"/api/deploy/session?name={robot.name}")[1]
        self.assertEqual((d["ended"], d["replay"]["state"]), (True, "registered"))
        from studio.replay import FLOW_ROOT
        if (FLOW_ROOT / "sim/assets/g1_29dof.xml").is_file():          # Replay opens that session
            status, body = self.call("GET", f"/api/session?id={d['replay']['catalog_id']}")
            self.assertEqual(status, 200, body)
        self.assertEqual(self.call("GET", "/api/deploy/session?name=nope")[0], 404)
        self.assertEqual(self.call("GET", "/api/deploy/session?name=../x")[0], 400)

    def test_an_unlinked_day_is_not_registered_with_the_reason(self):
        robot = self.start_robot()
        d = self.call("GET", f"/api/deploy/session?name={robot.name}")[1]
        self.assertEqual((d["replay"]["state"], d["replay"]["catalog_id"]), ("not_registered", None))
        self.assertIn("did not link", d["replay"]["detail"])

    def test_tag_an_ended_session_as_a_named_viewer(self):
        robot = self.start_robot()
        robot.attempts.append({"n": 1, "t_go": 1.0, "outcome": "arrived", "result": "arrived", "tag": None,
                               "note": None, "tag_history": []})
        self.hub.post("/api/v1/stop", {"slot": "robot"})
        body = {"name": robot.name, "n": 1, "tag": "touched", "note": "left tower"}
        self.assertEqual(self.call("POST", "/api/deploy/tag", body)[0], 403)            # CSRF as every POST
        status, out = self.call("POST", "/api/deploy/tag", body, self.csrf())
        self.assertEqual((status, out["need"]), (400, "operator"))                    # no lease, no name
        status, out = self.call("POST", "/api/deploy/tag", dict(body, operator="Viewer"), self.csrf())
        self.assertEqual((status, out["ok"], out["ended"]), (200, True, True))
        self.assertEqual(out["tag_history"][-1]["operator"], "Viewer")
        d = self.call("GET", f"/api/deploy/session?name={robot.name}")[1]
        self.assertEqual(d["attempts"][0]["tag"], "touched")
        rows = [json.loads(l) for l in self.audit.read_text().splitlines()]
        self.assertIn(("tag", "Viewer"), [(r["kind"], r.get("operator")) for r in rows])
        self.assertEqual(self.call("POST", "/api/deploy/tag", dict(body, n=0, operator="V"), self.csrf())[0], 400)

    def test_a_session_from_an_earlier_day_opens_in_replay(self):
        seeded = self.hub.seed_previous_day({"studio_data": str(Path(self.tmp.name) / "data")})
        self.addCleanup(shutil.rmtree, str(Path(seeded["dir"]).parent), True)
        self.assertTrue(wait_for(lambda: (Path(seeded["dir"]) / "console_summary.json").is_file()))
        status, d = self.call("GET", f"/api/deploy/session?name={seeded['name']}")
        self.assertEqual((status, d["day"], d["replay"]["state"]), (200, seeded["day"], "registered"))
        self.assertEqual(d["replay"]["catalog_id"], fake.studio_id(Path(seeded["dir"]).parent, seeded["name"]))
        self.assertEqual(d["recording"]["state"], "finalized")
        status, rec = self.call("GET", f"/api/deploy/recording?name={seeded['name']}")
        self.assertEqual((status, rec["state"]), (200, "finalized"))
        self.assertLess(rec["source_age_s"], 5.0)                       # aged from the kit's `at` (wall clock)
        status, out = self.call("GET", "/api/deploy/session?name=robot-000000-nowhere")
        self.assertEqual(status, 404)
        self.assertIn("lab-day-*", out["error"])


class GoGateTests(GatewayCase):
    """The kit's GO rehearsal gate through the gateway: a refusal is an answer (409), never "unknown"."""

    def test_the_gate_refusal_passes_through_and_the_override_reaches_the_console(self):
        robot = self.start_robot()
        lease = self.call("POST", "/api/deploy/lease", {"operator": "Linji"}, self.csrf())[1]["lease_id"]
        body = {"act": "g", "slot": "robot", "lease_id": lease, "expect": {"session": robot.name}}
        status, out = self.call("POST", "/api/deploy/act", body, self.csrf())
        self.assertEqual((status, out["result"], out["rehearsal_required"]), (409, "refused", True))
        self.assertIn("rehearsal set", out["reason"])
        self.assertFalse([a for a in robot.acts if a["act"] == "g"])     # the console never saw it
        status, out = self.call("POST", "/api/deploy/act", dict(body, rehearsal_override={
            "operator": "Linji", "reason": "rehearsed by hand"}), self.csrf())
        self.assertEqual((status, out["result"]), (200, "refused"))      # past the gate: the console's own locks
        self.assertEqual([a["act"] for a in robot.acts if a["act"] == "g"], ["g"])
        status, out = self.call("POST", "/api/deploy/act", dict(body, act="arm", expect={"session": "old"}), self.csrf())
        self.assertEqual((status, out["session_mismatch"]), (409, True))


class GoalCheckConfigTests(FakeHubCase):
    """F / F06: the profile's route configuration, receipts bound to scan, memory, goal and configuration, a TTL."""

    def setUp(self):
        super().setUp()
        saved = {k: dict(v["params"]) for k, v in fake.PROFILES.items()}
        self.addCleanup(lambda: [fake.PROFILES[k].__setitem__("params", v) for k, v in saved.items()])

    def test_the_profiles_route_configuration_decides_the_check(self):
        generic = self.deploy.goal_check("scan-fake", 2.0, 0.0)
        deploy = self.deploy.goal_check("scan-fake", 2.0, 0.0, "deploy")
        self.assertEqual((generic["config"]["basis"], deploy["config"]["basis"]),
                         ("Studio generic check", "profile route config"))
        self.assertEqual(deploy["config"]["sha"], fake.profile_sha("deploy"))
        self.assertEqual(deploy["config"]["params"]["route_margin_m"], 0.30)
        self.assertFalse(generic["ok"])                                 # the 0.35 m generic margin closes the gap
        self.assertTrue(deploy["ok"], deploy["checks"])                 # the profile's 0.30 m leaves a way
        near = self.deploy.goal_check("scan-fake", 2.4, 0.0, "near")
        self.assertTrue(self.deploy.goal_check("scan-fake", 2.4, 0.0, "deploy")["ok"])
        self.assertFalse(near["ok"])
        self.assertEqual(near["config"]["params"]["route_margin_m"], 0.45)
        self.assertEqual(deploy["binding"], {"scan": "scan-fake", "memory_sha": self.hub.world.memory_sha,
                                             "goal_scene": [2.0, 0.0], "config_sha": deploy["config"]["sha"]})
        with self.assertRaises(DeployError) as ctx:
            self.deploy.goal_check("scan-fake", 1.0, 0.0, "no-such-profile")
        self.assertEqual(ctx.exception.status, 404)

    def send(self, deploy, check, lease, goal=(1.0, 0.5)):
        return deploy.act({"act": "send_goal", "slot": "robot", "scan": "scan-fake", "goal_scene": list(goal),
                           "check_id": check["check_id"], "lease_id": lease})

    def test_a_receipt_expires_after_ten_minutes_on_a_controlled_clock(self):
        clock, wall = Clock(), Clock()
        wall.t = 1_800_000_000.0
        deploy = self.make_deploy(clock=clock, wall=wall, autostart=False)
        self.start_robot()
        check = deploy.goal_check("scan-fake", 1.0, 0.5, "deploy")
        self.assertEqual((check["issued_at"], check["expires_at"]), (wall.t, wall.t + 600.0))
        clock.t += 599.0
        lease = deploy.lease_take({"operator": "op", "take_over": True})["lease_id"]
        before = len(self.hub.actions)
        self.send(deploy, check, lease)
        self.assertIn("/api/v1/send_goal", [a["path"] for a in self.hub.actions[before:]])  # 599 s: still good
        clock.t += 2.0
        with self.assertRaisesRegex(DeployError, "expired") as ctx:
            self.send(deploy, check, lease)
        self.assertEqual((ctx.exception.status, ctx.exception.extra["why"]), (409, "expired"))

    def test_send_goal_needs_the_sessions_profile_and_its_current_contents(self):
        code, out = self.hub_post("/api/v1/start", {"mode": "robot", "confirm": CONFIRM, "profile": "deploy"})
        self.assertTrue(out["ok"], out)
        lease = self.deploy.lease_take({"operator": "op"})["lease_id"]
        for profile in ("low-margin", None):
            check = self.deploy.goal_check("scan-fake", 1.0, 0.5, profile)
            with self.subTest(profile=profile), self.assertRaisesRegex(DeployError, "session runs") as ctx:
                self.send(self.deploy, check, lease)
            self.assertEqual(ctx.exception.extra["why"], "config mismatch")
        before = len(self.hub.actions)
        self.send(self.deploy, self.deploy.goal_check("scan-fake", 1.0, 0.5, "deploy"), lease)
        self.assertIn("/api/v1/send_goal", [a["path"] for a in self.hub.actions[before:]])
        self.hub.fake_post("/api/fake/profile", {"name": "deploy", "params": {"route_margin_m": 0.28}})
        check = self.deploy.goal_check("scan-fake", 1.0, 0.5, "deploy")             # the new contents' sha ...
        with self.assertRaisesRegex(DeployError, "session runs"):                   # ... is not what the session runs
            self.send(self.deploy, check, lease)

    def test_a_changed_scan_memory_voids_the_receipt(self):
        self.start_robot()
        lease = self.deploy.lease_take({"operator": "op"})["lease_id"]
        check = self.deploy.goal_check("scan-fake", 1.0, 0.5, "deploy")
        path = Path(self.hub.world.memory_file)
        with np.load(path, allow_pickle=True) as z:
            data = {k: z[k] for k in z.files}
        data["support"] = np.where(np.isnan(data["support"]), np.nan, data["support"] + 0.01)
        time.sleep(0.01)
        np.savez(path, **data)
        with self.assertRaisesRegex(DeployError, "memory changed"):
            self.send(self.deploy, check, lease)


class GoalCheckOldServiceTests(FakeHubCase):
    hub_args = ("--v1-only",)

    def test_without_the_kits_route_config_the_check_says_generic_and_send_goal_works(self):
        self.start_robot()
        check = self.deploy.goal_check("scan-fake", 1.0, 0.5, "deploy")
        self.assertEqual(check["config"]["basis"], "Studio generic check")
        self.assertIn("before contract v3", check["config"]["detail"])
        lease = self.deploy.lease_take({"operator": "op"})["lease_id"]
        before = len(self.hub.actions)
        self.deploy.act({"act": "send_goal", "slot": "robot", "scan": "scan-fake", "goal_scene": [1.0, 0.5],
                         "check_id": check["check_id"], "lease_id": lease})
        self.assertIn("/api/v1/send_goal", [a["path"] for a in self.hub.actions[before:]])


class AuditHealthTests(GatewayCase):
    """G: audit write failures counted and shown; never in the E-STOP's way."""

    def test_failures_are_counted_shown_and_never_slow_the_estop(self):
        self.start_robot()
        self.assertEqual(self.call("GET", "/api/deploy/link")[1]["audit"]["errors"], 0)
        good = self.deploy.audit_path
        self.deploy.audit_path = Path(self.tmp.name)                   # a directory: every write fails
        self.deploy.act({"act": "note", "slot": "robot", "operator": "x"})
        audit = self.call("GET", "/api/deploy/link")[1]["audit"]
        self.assertEqual((audit["ok"], audit["errors"]), (False, 1))
        self.assertIn("IsADirectoryError", audit["last_error"])
        self.assertIsNotNone(audit["at"])
        held = threading.Event()

        def hung_disk():                                               # a writer stuck on the disk holds the lock
            with self.deploy.audit_lock:
                held.set()
                time.sleep(1.5)
        threading.Thread(target=hung_disk, daemon=True).start()
        held.wait(1)
        status, out, dt = self.estop()
        self.assertTrue(out["ok"], out)
        self.assertLess(dt, 0.3)
        self.deploy.audit_path = good
        self.deploy.audit_flush(3.0)
        self.deploy.act({"act": "note", "slot": "robot", "operator": "x"})
        audit = self.call("GET", "/api/deploy/link")[1]["audit"]
        self.assertEqual(audit["ok"], True)
        self.assertGreaterEqual(audit["errors"], 1)                     # the history stays visible


class VersionAndCapabilityTests(GatewayCase):
    def test_version_says_installed_or_candidate(self):
        from studio.server import release_info
        status, v = self.call("GET", "/api/version")
        self.assertEqual(set(v["release"]), {"served_from", "commit", "dirty", "installed_commit", "is_installed"})
        self.assertEqual(v["release"]["commit"], v["commit"])
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "release").mkdir()
            (Path(tmp) / "release.commit").write_text("abc123\n")
            r = release_info(Path(tmp) / "release", "abc123", False, data_root=tmp)
            self.assertEqual((r["served_from"], r["installed_commit"], r["is_installed"]), ("release", "abc123", True))
            r = release_info(ROOT, "def456", True, data_root=tmp)
            self.assertEqual((r["served_from"], r["is_installed"]), ("worktree", False))

    def test_v3_passthrough_with_capabilities(self):
        self.hub.seed_rehearsals({"preset": "f02", "goal_scene": [3.0, 0.0]})
        self.call("GET", "/api/deploy/state")
        caps = self.call("GET", "/api/deploy/link")[1]["capabilities"]
        self.assertTrue(all(caps.values()), caps)
        status, m = self.call("GET", "/api/deploy/rehearsal/match?scan=scan-fake&x=3&y=0&profile=deploy&odom=fused")
        self.assertIn("new-failure", m["complete"]["name"])
        robot = self.start_robot()
        status, rec = self.call("GET", f"/api/deploy/recording?name={robot.name}")
        self.assertEqual((status, rec["recorder_alive"]), (200, True))
        self.assertIsNotNone(rec["source_age_s"])
        self.assertEqual(self.call("GET", f"/api/deploy/session/receipt?name={robot.name}")[1]["session"], robot.name)
        self.assertEqual(self.call("GET", "/api/deploy/profile/route?name=low-margin")[1]["params"]["route_margin_m"], 0.25)
        self.hub.faults.set(manifest_fail=1)
        self.assertEqual(self.call("GET", f"/api/deploy/manifest?name={robot.name}")[0], 503)
        self.assertEqual(self.call("GET", f"/api/deploy/manifest?name={robot.name}")[1]["version"], 2)


class OldServiceTests(GatewayCase):
    """F09: a deploy service without the v3 capabilities: {supported: false, capability}, never a guess."""
    hub_args = ("--v1-only",)

    def test_every_v3_endpoint_says_unsupported(self):
        robot = self.start_robot()
        self.call("GET", "/api/deploy/state")
        self.assertEqual(set(self.call("GET", "/api/deploy/link")[1]["capabilities"].values()), {False})
        for path, cap in (("/api/deploy/rehearsal/match?scan=scan-fake&x=1&y=0", "rehearsal_match"),
                          (f"/api/deploy/recording?name={robot.name}", "recording_health"),
                          (f"/api/deploy/session/receipt?name={robot.name}", "session_receipt"),
                          ("/api/deploy/profile/route?name=deploy", "profile_route"),
                          ("/api/deploy/act_status?slot=robot&id=x", "act_status"),
                          (f"/api/deploy/session?name={robot.name}", "session_detail")):
            status, out = self.call("GET", path)
            self.assertEqual((status, out["supported"], out["capability"]), (200, False, cap), path)
        status, out = self.call("POST", "/api/deploy/tag", {"name": robot.name, "n": 1, "tag": "x", "operator": "V"},
                                self.csrf())
        self.assertEqual((status, out["supported"], out["capability"]), (200, False, "session_tag"))


class FixtureHub(BaseHTTPRequestHandler):
    """Replays the recorded replies of the kit's real deploy service (tests/fixtures/deploy_v1)."""
    replies = {}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = sorted((k, v) for k, v in urllib.parse.parse_qsl(u.query) if k != "t")
        status, body = self.replies.get((u.path, tuple(q)), (404, b'{"ok": false, "error": "unknown endpoint"}'))
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class RealServiceFixtureTests(unittest.TestCase):
    """F09: replies recorded from the kit's real deploy service (read-only GETs, tokens scrubbed) through the gateway's
    sanitize / passthrough, and the fake hub's shapes against them."""
    FIXTURES = ROOT / "tests/fixtures/deploy_v1"

    @classmethod
    def setUpClass(cls):
        index = json.loads((cls.FIXTURES / "index.json").read_text())
        cls.fixtures = {}
        for row in index["responses"]:
            u = urllib.parse.urlparse(row["path"])
            key = (u.path, tuple(sorted(urllib.parse.parse_qsl(u.query))))
            raw = (cls.FIXTURES / row["file"]).read_bytes()
            FixtureHub.replies[key] = (row["status"], raw)
            cls.fixtures[row["path"]] = (row["status"], json.loads(raw))
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHub)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        token = Path(self.tmp.name) / "panel_token"
        token.write_text("x")
        self.deploy = Deploy(link=DeployLink(f"http://127.0.0.1:{self.srv.server_address[1]}", token), autostart=False)
        self.addCleanup(self.deploy.close)

    def test_the_fixtures_hold_no_token_or_private_names(self):
        text = "".join(p.read_text() for p in self.FIXTURES.glob("*.json")).lower()
        for word in ("st1", "kcsc", "/home/robotixx", "?t=", "&t="):
            self.assertNotIn(word, text)

    def test_recorded_replies_through_the_gateway(self):
        status, state = self.deploy.get("/api/deploy/state", {})
        self.assertEqual(status, 200)
        json.dumps(state, allow_nan=False)
        self.assertEqual(state["api"], 1)
        self.assertEqual(set(state["studio"]), {"estop_targets", "hub", "lease", "refresher", "audit", "capabilities"})
        self.assertEqual(state["studio"]["estop_targets"], [])         # live {robot: null, sim: null}
        self.assertTrue(state["studio"]["hub"]["ok"])
        self.assertEqual(set(state["studio"]["capabilities"].values()), {False})  # the recorded service predates v3
        self.assertIsNotNone(state["source_age_s"])
        for route, query, want in (("/api/deploy/readiness", {}, "/api/v1/readiness"),
                                   ("/api/deploy/readiness", {"slot": "robot"}, "/api/v1/readiness?slot=robot"),
                                   ("/api/deploy/sessions", {}, "/api/v1/sessions"),
                                   ("/api/deploy/scan/live", {}, "/api/v1/scan/live")):
            self.assertEqual(self.deploy.get(route, query), (200, self.fixtures[want][1]), route)
        self.assertEqual(self.deploy.get("/api/deploy/scan/scene", {"name": "no-such-scan"}),
                         (404, {"ok": False, "error": "no such scan"}))
        self.assertEqual(self.deploy.get("/api/deploy/manifest", {"name": "no-such-session"})[0], 404)
        for route, query in (("/api/deploy/live", {"slot": "robot", "cloud_after": "-1", "mem_after": "-1"}),
                             ("/api/deploy/panel", {"slot": "robot"}),
                             ("/api/deploy/rehearsal/track", {"name": "no-such-run"})):
            status, out = self.deploy.get(route, query)
            self.assertEqual((status, out["ok"], out["ended"]), (200, False, True), route)
        for route, query, cap in (("/api/deploy/rehearsal/match", {"scan": "x", "x": "1", "y": "0", "profile": "deploy",
                                                                   "odom": "leg"}, "rehearsal_match"),
                                  ("/api/deploy/recording", {"name": "no-such-session"}, "recording_health"),
                                  ("/api/deploy/session/receipt", {"name": "no-such-session"}, "session_receipt"),
                                  ("/api/deploy/profile/route", {"name": "deploy"}, "profile_route")):
            self.assertEqual(self.deploy.get(route, query)[1]["capability"], cap)
        self.assertFalse(self.deploy.session("no-such-session")[1]["supported"])
        self.assertFalse(self.deploy.act_status("robot", "abc123")[1]["supported"])
        hb = self.deploy.heartbeat()
        self.assertEqual((hb["consoles"], hb["hub"]["ok"]), ([], True))

    def test_the_fake_hub_answers_every_field_the_real_one_does(self):
        hub, srv = fake.start(["--port", "0", "--panel-port", "0", "--token", TOKEN])
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close(), shutil.rmtree(hub.day, ignore_errors=True)))
        real = {p: obj for p, (status, obj) in self.fixtures.items()}
        state = hub.state()
        self.assertLessEqual(set(real["/api/v1/state"]), set(state))
        for key in ("pc", "robot_link", "doctor", "scan_job", "sessions"):
            self.assertLessEqual(set(real["/api/v1/state"][key]), set(state[key]), key)
        self.assertLessEqual(set(real["/api/v1/state"]["profiles"][0]), set(state["profiles"][0]))
        self.assertLessEqual(set(real["/api/v1/readiness"]), set(hub.readiness()))
        self.assertLessEqual(set(real["/api/v1/readiness"]["checks"][0]), set(hub.readiness()["checks"][0]))
        self.assertLessEqual(set(real["/api/v1/sessions"]), set(hub.sessions_v1()))
        self.assertLessEqual(set(real["/api/v1/scan/live"]), set(hub.scan_live()))
        self.assertEqual(hub.get("/api/v1/scan/no-such-scan/scene", {}), (404, real["/api/v1/scan/no-such-scan/scene"]))
        status, body = hub.get("/api/v1/session/no-such-session/manifest", {})  # the kit now names the days it looked in
        self.assertEqual((status, body["ok"]), (404, False))
        self.assertLessEqual(set(real["/api/v1/session/no-such-session/manifest"]), set(body))
        self.assertEqual(hub.track("no-such-run"), (404, real["/api/v1/rehearsal/no-such-run/track"]))
        self.assertEqual(hub.get("/api/v1/live/bogus/view", {}), (404, real["/api/v1/live/bogus/view"]))


if __name__ == "__main__":
    unittest.main()
