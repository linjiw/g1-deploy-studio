"""tools/fake_deploy_hub.py: the executable contract (v3) the Deploy page and the gateway are developed against. Its
ordering and its answers follow the kit's deploy service (newest first; 200 with ok false when refused), and its fault
switches reproduce Astra's review cases. In process, loopback ephemeral ports; nothing here talks to a robot."""
import http.client
import json
import math
import shutil
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import fake_deploy_hub as fake  # noqa: E402

TOKEN = "test-token"
CONFIRM = {"gantry": True, "estop": True, "remote": True, "rope": True}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class HubCase(unittest.TestCase):
    argv = []

    def setUp(self):
        self.hub, self.server = fake.start(["--port", "0", "--panel-port", "0", "--token", TOKEN, *self.argv])
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.addCleanup(self.stop)
        self._profiles = json.loads(json.dumps({k: v["params"] for k, v in fake.PROFILES.items()}))

    def stop(self):
        for c in list(self.hub.consoles.values()) + [c for c in self.hub.slots.values() if c]:
            c.ended = True
        for k, v in self._profiles.items():  # /api/fake/profile edits the module's table
            fake.PROFILES[k]["params"] = v
        try:
            self.hub.server.shutdown()
            self.hub.server.server_close()
        except OSError:
            pass
        shutil.rmtree(self.hub.day, ignore_errors=True)
        shutil.rmtree(Path(self.hub.world.memory_file).parent, ignore_errors=True)

    def get(self, path, **q):
        url = f"{self.base}{path}?{urllib.parse.urlencode(dict(q, t=TOKEN))}"
        try:
            with OPENER.open(url, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def post(self, path, body, timeout=10):
        req = urllib.request.Request(f"{self.base}{path}?t={TOKEN}", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with OPENER.open(req, timeout=timeout) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def start_robot(self, **kw):
        code, out = self.post("/api/v1/start", dict({"mode": "robot", "confirm": CONFIRM, "operator": "Linji",
                                                    "scan": "scan-fake"}, **kw))
        self.assertTrue(out.get("ok"), out)
        return self.hub.slots[out["slot"]]


class ContractTests(HubCase):
    def test_refusals_answer_200_with_a_reason_as_the_kit(self):
        code, out = self.post("/api/v1/start", {"mode": "robot"})
        self.assertEqual((code, out["ok"]), (200, False))
        self.assertIn("confirm first", out["reason"])
        self.start_robot()
        code, out = self.post("/api/v1/act", {"slot": "robot", "act": "s", "id": "a1"})
        self.assertEqual((code, out["ok"], out["result"], out["reason"]), (200, False, "refused", "Arm first"))

    def test_receipt_in_state_start_reply_and_its_endpoint(self):
        c = self.start_robot(profile="low-margin", odom="leg")
        code, state = self.get("/api/v1/state")
        r = state["live"]["robot"]["receipt"]
        self.assertEqual((r["session"], r["kind"], r["operator"], r["odom"]), (c.name, "robot", "Linji", "leg"))
        self.assertEqual(r["profile"], {"name": "low-margin", "sha": fake.profile_sha("low-margin")})
        self.assertEqual(r["scan"], {"name": "scan-fake", "memory_sha": self.hub.world.memory_sha})
        self.assertEqual(r["confirmations"], CONFIRM)
        self.assertIn("session_receipt", state["capabilities"])
        self.assertEqual(self.get(f"/api/v1/session/{c.name}/receipt"), (200, r))

    def test_profile_route_configs_differ_and_contents_change_the_sha(self):
        _, a = self.get("/api/v1/profile/deploy/route")
        _, b = self.get("/api/v1/profile/low-margin/route")
        self.assertEqual(set(a["params"]), {"robot_radius_m", "route_margin_m", "step_over_m", "ceiling_below_m",
                                            "ceiling_near_m", "grow_unknown_m", "goal_lookahead_m", "guards"})
        self.assertNotEqual(a["params"]["route_margin_m"], b["params"]["route_margin_m"])
        self.assertNotEqual(a["sha"], b["sha"])
        self.assertEqual(self.get("/api/v1/profile/nope/route")[0], 404)
        _, edited = self.post("/api/fake/profile", {"name": "deploy", "params": {"route_margin_m": 0.2}})
        self.assertNotEqual(edited["sha"], a["sha"])
        self.assertEqual(self.get("/api/v1/profile/deploy/route")[1]["sha"], edited["sha"])

    def test_rehearsal_sets_newest_first_and_the_match(self):
        _, seeded = self.post("/api/fake/rehearsals", {"preset": "f02", "goal_scene": [3.0, 0.0], "odom": "fused"})
        _, state = self.get("/api/v1/state")
        started = [r["started"] for r in state["rehearsals"]]
        self.assertEqual(started, sorted(started, reverse=True))                 # newest first, as the kit
        self.assertEqual(state["rehearsals"][0]["state"], "running")
        self.assertIsNone(state["rehearsals"][0]["verdict"])                     # a verdict only for a complete set
        _, m = self.get("/api/v1/rehearsal/match", scan="scan-fake", x=3.03, y=0.0, profile="deploy", odom="fused")
        self.assertIn("new-failure", m["complete"]["name"])                      # the newer failure, not the old pass
        self.assertEqual(m["complete"]["verdict"], "fails with drift")
        self.assertIn("rerun", m["running"]["name"])
        why = {o["name"].split("-", 2)[2]: o["mismatch"] for o in m["others"]}
        self.assertEqual(why["old-pass"], [])                                    # matches, superseded by a newer set
        self.assertEqual(why["other-odom"], ["odom"])
        self.assertEqual(why["old-profile"], ["profile_sha"])
        self.assertEqual(why["other-start"], ["starts"])
        self.assertEqual(why["no-bundle-sha"], ["bundle_sha"])
        _, far = self.get("/api/v1/rehearsal/match", scan="scan-fake", x=3.1, y=0.0, profile="deploy", odom="fused")
        self.assertIsNone(far["complete"])                                       # 0.1 m away: another goal
        self.post("/api/fake/profile", {"name": "deploy", "params": {"route_margin_m": 0.2}})
        _, m = self.get("/api/v1/rehearsal/match", scan="scan-fake", x=3.0, y=0.0, profile="deploy", odom="fused")
        self.assertIsNone(m["complete"])                                         # same name, other contents
        self.assertTrue(all("profile_sha" in o["mismatch"] for o in m["others"]))

    def test_dropped_console_reply_then_the_act_record(self):
        c = self.start_robot()
        self.post("/api/fake/faults", {"console_drop_reply": 1})
        code, out = self.post("/api/v1/act", {"slot": "robot", "act": "arm", "id": "arm-1", "source": "studio"})
        self.assertEqual(code, 502)                                              # as the kit's panel_proxy
        self.assertIn("panel unreachable", out["error"])
        self.assertIsNotNone(c.armed_t)                                          # ... but the console armed
        code, rec = self.get("/api/v1/act/robot/arm-1")
        self.assertEqual((code, rec["known"], rec["result"], rec["act"], rec["session"]),
                         (200, True, "done", "arm", c.name))
        self.assertFalse(self.get("/api/v1/act/robot/never-sent")[1]["known"])
        code, again = self.post("/api/v1/act", {"slot": "robot", "act": "arm", "id": "arm-1"})
        self.assertTrue(again["repeat"])                                         # the same id never acts twice

    def test_session_detail_and_tags_on_a_live_then_an_ended_session(self):
        c = self.start_robot()
        c.attempts.append({"n": 1, "t_go": 1.0, "outcome": "arrived", "result": "arrived", "tag": None, "note": None,
                           "tag_history": [], "goal_scene": [1.0, 0.5], "scan": "scan-fake", "passage": None,
                           "end_goal_dist_m": 0.2, "t_end": 5.0})
        _, out = self.post(f"/api/v1/session/{c.name}/tag", {"n": 1, "tag": "clean", "operator": "Linji"})
        self.assertEqual((out["ok"], out["tag"], out["ended"]), (True, "clean", False))
        self.post("/api/v1/stop", {"slot": "robot"})
        _, out = self.post(f"/api/v1/session/{c.name}/tag", {"n": 1, "tag": "touched", "note": "brushed the left tower",
                                                            "operator": "Joe"})
        self.assertEqual((out["ok"], out["tag"], out["ended"]), (True, "touched", True))
        self.assertEqual([h["tag"] for h in out["tag_history"]], ["clean", "touched"])
        self.assertEqual(json.loads((c.dir / "attempt_tags.jsonl").read_text())["operator"], "Joe")
        code, d = self.get(f"/api/v1/session/{c.name}")
        self.assertEqual((code, d["ended"], d["attempts"][0]["tag"]), (200, True, "touched"))
        self.assertEqual(d["replay"]["studio_id"], fake.studio_id(Path(self.hub.day), c.name))
        self.assertEqual(d["receipt"]["session"], c.name)
        self.assertEqual(d["manifest"]["version"], 2)
        self.assertFalse(self.post(f"/api/v1/session/{c.name}/tag", {"n": 9, "tag": "x"})[1]["ok"])
        self.assertEqual(self.get("/api/v1/session/nope")[0], 404)

    def test_manifest_v2_recording_health_and_their_failures(self):
        c = self.start_robot(odom="fused")
        _, m = self.get(f"/api/v1/session/{c.name}/manifest")
        req = {i["id"] for i in m["items"] if i["required"]}
        self.assertTrue({"lowstate", "lidar_raw", "attempts", "lio_odom", "lio_cloud"} <= req)
        self.assertFalse(m["complete"])                                          # live: not finalized
        _, h = self.get(f"/api/v1/session/{c.name}/recording")
        self.assertTrue(h["recorder_alive"])
        self.assertEqual(h["errors"], [])
        self.post("/api/fake/faults", {"manifest_fail": 1, "recording_mode": "degraded", "manifest_mode": "failing"})
        self.assertEqual(self.get(f"/api/v1/session/{c.name}/manifest")[0], 503)
        _, m = self.get(f"/api/v1/session/{c.name}/manifest")                   # recovered
        self.assertIn("lidar_raw", m["partial_required"])
        self.assertIn("required records partial: lidar_raw", m["incomplete_reasons"])
        _, h = self.get(f"/api/v1/session/{c.name}/recording")
        self.assertEqual(len(h["errors"]), 2)
        self.assertFalse(next(s for s in h["streams"] if s["id"] == "lidar_raw")["active"])
        self.post("/api/fake/faults", {"reset": True})
        self.post("/api/v1/stop", {"slot": "robot"})
        _, m = self.get(f"/api/v1/session/{c.name}/manifest")
        self.assertTrue(m["complete"] and m["finalized"])

    def test_freeze_view_freeze_panel_and_hang_console(self):
        c = self.start_robot()
        self.post("/api/v1/act", {"slot": "robot", "act": "arm", "id": "a"})
        _, v1 = self.get("/api/v1/live/robot/view")
        _, p1 = self.get("/api/v1/panel/robot/state")
        self.post("/api/fake/faults", {"freeze_view": True, "freeze_panel": True})
        time.sleep(0.3)
        _, v2 = self.get("/api/v1/live/robot/view")
        _, p2 = self.get("/api/v1/panel/robot/state")
        self.assertEqual(v2["t_mono"], v1["t_mono"])
        self.assertGreater(v2["served_age_s"], 0.3)
        self.assertEqual(p2["console_t_mono"], p1["console_t_mono"])
        self.assertGreater(c.state()["console_t_mono"], p1["console_t_mono"])   # the console itself runs on
        self.post("/api/fake/faults", {"reset": True, "hang_console": True})
        t0 = time.monotonic()
        code, out = self.get("/api/v1/panel/robot/state")
        self.assertEqual(code, 502)
        self.assertLess(time.monotonic() - t0, 2.5)
        self.assertEqual(self.get("/api/v1/state")[0], 200)                      # the hub answers
        conn = http.client.HTTPConnection("127.0.0.1", c.panel_port, timeout=0.5)
        with self.assertRaises(OSError):
            conn.request("GET", f"/state?t={TOKEN}")
            conn.getresponse()
        conn.close()
        self.post("/api/fake/faults", {"hang_console": False})
        self.assertEqual(self.get("/api/v1/panel/robot/state")[0], 200)

    def test_hub_down_then_back(self):
        port = self.server.server_address[1]
        self.post("/api/fake/faults", {"hub_down_s": 0.6})
        time.sleep(0.4)
        with self.assertRaises(OSError):
            self.get("/api/v1/state")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if self.get("/api/v1/state")[0] == 200:
                    break
            except OSError:
                time.sleep(0.1)
        self.assertEqual(self.hub.server.server_address[1], port)
        self.assertEqual(self.get("/api/v1/state")[0], 200)


class KitFidelityTests(HubCase):
    """Where the fake once differed from the kit and two defects hid (an independent verification, D2-D4, D11, D1):
    recording states, the robot GO rehearsal gate, the start-offset envelope, passage on a repeated trial, and
    session names from an earlier day."""

    def ready_robot(self, practice=False):
        """A session standing in CONTROL, settled, with a goal sent through the service: GO passes the console's
        gates; only the service's rehearsal gate remains."""
        if practice:
            code, out = self.post("/api/v1/start", {"mode": "sim", "practice": True, "confirm": CONFIRM, "scan": "scan-fake",
                                                    "operator": "Linji"})
            c = self.hub.slots["sim"]
        else:
            c = self.start_robot()
        slot = c.slot
        self.post("/api/v1/act", {"slot": slot, "act": "arm", "id": f"arm-{c.name}"})
        deadline = time.monotonic() + 6
        while c.phase != "WAIT" and time.monotonic() < deadline:
            time.sleep(0.05)
        self.post("/api/v1/act", {"slot": slot, "act": "s", "id": f"s-{c.name}"})
        time.sleep(2.1)
        _, out = self.post("/api/v1/send_goal", {"slot": slot, "scan": "scan-fake", "goal_scene": [1.0, 0.0],
                                                 "check_id": "chk", "id": f"goal-{c.name}"})
        self.assertTrue(out["ok"], out)
        return c

    def go(self, c, **kw):
        return self.post("/api/v1/act", dict({"slot": c.slot, "act": "g", "id": uuid_hex(), "expect": {"session": c.name}},
                                             **kw))

    def test_recording_health_states_like_the_kits(self):
        c = self.start_robot(odom="fused")
        _, h = self.get(f"/api/v1/session/{c.name}/recording")
        state = {r["id"]: r["state"] for r in h["streams"]}
        self.assertEqual((h["state"], h["recorder_alive"], h["finalized"]), ("recording", True, False))
        self.assertEqual((state["lowstate"], state["lowcmd"], state["sim_truth"], state["lio_odom"], state["lidar_imu"]),
                         ("active", "n/a", "n/a", "active", "absent"))     # lowcmd before Arm; no truth on a robot
        self.assertLessEqual(set(state.values()), set(fake.STREAM_STATES))
        self.post("/api/fake/faults", {"recording_mode": "stalled"})
        _, h = self.get(f"/api/v1/session/{c.name}/recording")
        self.assertEqual((h["state"], h["recorder_alive"], h["ok"]), ("stalled", False, False))
        self.assertEqual(next(r for r in h["streams"] if r["id"] == "lowstate")["state"], "stalled")
        self.assertIn("no recorder heartbeat", " ".join(h["problems"]))
        self.post("/api/fake/faults", {"reset": True})
        self.post("/api/v1/stop", {"slot": "robot"})
        _, h = self.get(f"/api/v1/session/{c.name}/recording")
        self.assertEqual((h["state"], h["finalized"], h["ok"]), ("finalized", True, True))
        self.assertEqual(next(r for r in h["streams"] if r["id"] == "lowstate")["state"], "stopped")
        _, m = self.get(f"/api/v1/session/{c.name}/manifest")
        self.assertEqual((m["state"], m["complete"], m["console_closed"]), ("ended", True, True))
        lost = self.start_robot()                                           # killed: not closed, not finalized
        self.post("/api/fake/end", {"slot": "robot", "abrupt": True})
        _, h = self.get(f"/api/v1/session/{lost.name}/recording")
        self.assertEqual((h["state"], h["finalized"]), ("not finalized", False))
        self.assertIn("without finalizing", " ".join(h["problems"]))
        _, m = self.get(f"/api/v1/session/{lost.name}/manifest")
        self.assertEqual((m["state"], m["complete"]), ("lost", False))
        self.assertEqual(next(i for i in m["items"] if i["id"] == "report")["status"], "missing")

    def test_robot_go_needs_a_robust_matching_set_or_the_override(self):
        c = self.ready_robot()
        code, out = self.go(c)
        self.assertEqual((code, out["result"], out["rehearsal_required"]), (409, "refused", True))
        self.assertIn("GO needs a robust complete rehearsal set", out["reason"])
        self.assertEqual(c.phase, "WAIT")                                  # never reached the console
        self.post("/api/fake/rehearsals", {"goal_scene": [1.0, 0.0], "sets": [
            {"minutes_ago": 2, "verdict": "fails with drift", "label": "failing"}]})
        code, out = self.go(c)                                             # a complete matching set that is not robust
        self.assertEqual(code, 409)
        self.assertIn("is not robust: fails with drift", out["reason"])
        self.assertEqual(out["rehearsal"]["match"], True)
        code, out = self.go(c, rehearsal_override={"reason": "no name"})
        self.assertIn("needs the operator's name", out["reason"])
        code, out = self.go(c, rehearsal_override={"operator": "Linji", "reason": "rehearsed by hand"})
        self.assertEqual((code, out["result"]), (200, "done"))
        a = c.attempts[-1]
        self.assertEqual((a["rehearsal_override"]["operator"], a["rehearsal"]["verdict"]), ("Linji", "fails with drift"))
        self.assertIn("not robust", a["rehearsal_override"]["without"])
        self.assertIn("go_rehearsal_gate", self.get("/api/v1/state")[1]["capabilities"])

    def test_robot_go_with_a_robust_set_and_practice_never_refused(self):
        self.post("/api/fake/rehearsals", {"goal_scene": [1.0, 0.0], "sets": [{"minutes_ago": 1, "verdict": "robust"}]})
        c = self.ready_robot()
        code, out = self.go(c)
        self.assertEqual((code, out["result"]), (200, "done"))
        self.assertEqual((c.attempts[-1]["rehearsal"]["verdict"], c.attempts[-1]["rehearsal_override"]), ("robust", None))
        self.post("/api/v1/act", {"slot": "robot", "act": "h", "id": "stand"})
        self.post("/api/fake/end", {"slot": "robot"})
        self.hub.rehearsals.clear()
        p = self.ready_robot(practice=True)                                 # Practice: recorded, never refused
        code, out = self.go(p)
        self.assertEqual((code, out["result"]), (200, "done"))
        self.assertEqual(p.attempts[-1]["rehearsal"]["match"], False)

    def test_the_start_check_envelope_is_the_set_in_force_for_that_goal(self):
        c = self.start_robot()                                              # 0.2 m / 20 deg off the scan pose
        self.post("/api/v1/act", {"slot": "robot", "act": "arm", "id": "arm"})
        check = lambda goal: self.post("/api/v1/start_check", {"slot": "robot", "scan": "scan-fake",
                                                               "goal_scene": goal})[1]
        self.assertIsNone(check([1.0, 0.0])["within_offset_envelope"])     # no set for this goal
        self.post("/api/fake/rehearsals", {"goal_scene": [1.0, 0.0], "sets": [{"minutes_ago": 9, "verdict": "robust"}]})
        chk = check([1.0, 0.0])
        self.assertIs(chk["within_offset_envelope"], True)
        self.assertTrue(chk["offset_envelope"]["set"].endswith("-seeded"))
        self.assertEqual(chk["offset_envelope"]["moved_m"], round(math.hypot(*fake.OFFSET_SCENE[:2]), 3))
        self.assertIsNone(check([2.4, 0.0])["within_offset_envelope"])     # another goal: that set says nothing
        self.post("/api/fake/rehearsals", {"goal_scene": [1.0, 0.0], "sets": [{"minutes_ago": 1, "verdict": "fails"}]})
        self.assertIsNone(check([1.0, 0.0])["within_offset_envelope"])     # the set in force: its offset case failed
        self.assertTrue(c.name)

    def test_a_repeated_trial_from_past_the_gate_is_passage_na(self):
        c = self.start_robot()
        gate = {"a": [2.0, -0.35], "b": [2.0, 0.35]}
        goal_scene = [2.4, 0.0]
        c.goal_odom = fake.apply(c.odom_from_scene, goal_scene)

        def attempt(start, walk):
            c.robot_scene = list(start)
            c.walk_scene += [[x, y, 0.0] for x, y in walk]
            c.attempts.append({"n": len(c.attempts) + 1, "t_go": 1.0, "outcome": None, "start_scene": list(start),
                               "goal_scene": goal_scene, "passage_ab": gate, "walk_from": len(c.walk_scene) - len(walk),
                               "tag_history": []})
            c._close("arrived")
            return c.attempts[-1]
        first = attempt((0.19, -0.07, 0.0), [(0.5, 0.0), (1.5, 0.0), (2.4, 0.0)])
        self.assertEqual((first["passage"], first["passage_basis"]), ("crossed", "odometry estimate"))
        detour = attempt((0.19, -0.07, 0.0), [(1.0, 1.5), (2.4, 1.5), (2.4, 0.0)])
        self.assertEqual(detour["passage"], "missed")                       # around the gate: no task pass
        again = attempt((2.35, 0.02, 0.0), [(2.4, 0.0)])                    # "Send this goal again" from the arrival
        self.assertEqual((again["passage"], again["passage_basis"]), ("n/a", "started past the gate"))

    def test_a_session_from_an_earlier_day_resolves_by_name(self):
        _, seeded = self.post("/api/fake/previous_day", {})
        self.addCleanup(shutil.rmtree, str(Path(seeded["dir"]).parent), True)
        _, state = self.get("/api/v1/state")
        self.assertNotIn(seeded["name"], json.dumps(state["sessions"]))     # the kit lists its own day only
        code, d = self.get(f"/api/v1/session/{seeded['name']}")
        self.assertEqual((code, d["day"], d["ended"], d["attempts"][0]["tag"]), (200, seeded["day"], True, "clean"))
        self.assertEqual(d["replay"]["studio_id"], fake.studio_id(Path(seeded["dir"]).parent, seeded["name"]))
        _, out = self.post(f"/api/v1/session/{seeded['name']}/tag", {"n": 1, "tag": "touched", "operator": "Joe"})
        self.assertTrue(out["ok"], out)
        self.assertEqual(self.get(f"/api/v1/session/{seeded['name']}/manifest")[1]["state"], "ended")
        code, out = self.get("/api/v1/session/robot-000000-nowhere")
        self.assertEqual((code, out["session"]), (404, "robot-000000-nowhere"))
        self.assertIn("lab-day-*", out["error"])

    def test_an_act_for_another_session_is_refused_by_the_service_but_a_stop_never(self):
        c = self.start_robot()
        code, out = self.post("/api/v1/act", {"slot": "robot", "act": "arm", "id": "a1", "expect": {"session": "old"}})
        self.assertEqual((code, out["session_mismatch"], out["session"]), (409, True, c.name))
        code, out = self.post("/api/v1/act", {"slot": "robot", "act": "h", "id": "h1", "expect": {"session": "old"}})
        self.assertEqual((code, "session_mismatch" in out), (200, False))  # the service passes a stop on (the console
        self.assertEqual(out["session"], c.name)                              # applies its own expect, as the kit's)


def uuid_hex():
    import uuid
    return uuid.uuid4().hex


class RehearsalRunTests(HubCase):
    def test_a_set_runs_scores_passage_and_reports_per_run_axes(self):
        _, out = self.post("/api/v1/rehearse", {"scan": "scan-fake", "goal_scene": [1.0, 0.0], "profile": "deploy",
                                                "odom": "fused", "passage": {"a": [0.5, -0.6], "b": [0.5, 0.6]}})
        self.assertEqual((out["ok"], out["state"]), (True, "running"))
        self.assertEqual(out["identity"]["profile_sha"], fake.profile_sha("deploy"))
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            row = next(r for r in self.get("/api/v1/state")[1]["rehearsals"] if r["name"] == out["name"])
            if row["state"] != "running":
                break
            self.assertIsNone(row["verdict"])
            time.sleep(0.5)
        self.assertEqual(row["state"], "complete")
        for k in fake.RUN_KINDS:
            run = row["runs"][k]
            self.assertEqual((run["state"], run["arrival"], run["passage"], run["timing_valid"]),
                             ("done", True, "crossed", True), k)
        self.assertEqual(row["verdict"], "robust")
        code, tr = self.get(f"/api/v1/rehearsal/{row['runs']['exact']['name']}/track")
        self.assertEqual((code, tr["passage"], tr["arrival"]), (200, "crossed", True))
        _, m = self.get("/api/v1/rehearsal/match", scan="scan-fake", x=1.0, y=0.0, profile="deploy", odom="fused")
        self.assertEqual(m["complete"]["name"], row["name"])
        _, m = self.get("/api/v1/rehearsal/match", scan="scan-fake", x=1.0, y=0.0, profile="deploy", odom="leg")
        self.assertIsNone(m["complete"])                                         # changed odometry: no match
        self.assertEqual(m["others"][0]["mismatch"], ["odom"])


class V1OnlyTests(HubCase):
    argv = ["--v1-only"]

    def test_the_service_before_v3_answers_unknown_endpoint(self):
        c = self.start_robot()
        _, state = self.get("/api/v1/state")
        self.assertNotIn("receipt", state["live"]["robot"])
        self.assertNotIn("rehearsal_match", state["capabilities"])
        for path in ("/api/v1/rehearsal/match", f"/api/v1/session/{c.name}", f"/api/v1/session/{c.name}/receipt",
                     f"/api/v1/session/{c.name}/recording", "/api/v1/act/robot/x", "/api/v1/profile/deploy/route"):
            self.assertEqual(self.get(path), (404, {"ok": False, "error": "unknown endpoint"}), path)


if __name__ == "__main__":
    unittest.main()
