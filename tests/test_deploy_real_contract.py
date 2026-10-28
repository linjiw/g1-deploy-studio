"""Deploy's Review against a response recorded from the deploy kit's REAL deploy service (2026-10-28, a practice
session on the real chain; private names scrubbed). The fake hub's own tests passed while the real service answered
the session detail with a manifest summary only, and a fresh browser's Review listed no evidence: this pins every
field the browser's Review reads (apps/web/js/deploy.js reviewBody / replayTime) to what the real service sends."""
import json
import unittest
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures/deploy_v1/session_detail_practice_real.json"
# What Review reads from GET /api/deploy/session (contract v3 E, docs/DEPLOY.md)
TOP = {"name", "receipt", "ended", "attempts", "replay", "manifest", "recording"}
ATTEMPT = {"n", "result", "tag", "note", "tag_history", "t_go", "replay_t_s", "goal_scene", "scan", "rehearsal",
           "start_check", "check_id", "end_goal_dist_m", "passage"}
RECEIPT = {"session", "kind", "robot", "profile", "odom", "kit"}
MANIFEST = {"version", "complete", "finalized", "items", "state"}
ITEM = {"id", "status", "required"}


class RealSessionDetailTests(unittest.TestCase):
    def setUp(self):
        self.d = json.loads(FIXTURE.read_text())

    def test_review_fields_are_all_there(self):
        self.assertLessEqual(TOP, set(self.d))
        self.assertTrue(self.d["attempts"])
        for a in self.d["attempts"]:
            self.assertLessEqual(ATTEMPT, set(a), a.get("n"))
        self.assertLessEqual(RECEIPT, set(self.d["receipt"]))
        self.assertLessEqual({"name", "sha"}, set(self.d["receipt"]["profile"]))

    def test_the_manifest_lists_its_items(self):
        m = self.d["manifest"]
        self.assertLessEqual(MANIFEST, set(m))
        self.assertTrue(m["items"], "Review needs the items, not a summary")
        for item in m["items"]:
            self.assertLessEqual(ITEM, set(item), item.get("id"))

    def test_replay_points_at_this_session_at_its_attempt(self):
        self.assertTrue(self.d["replay"].get("studio_id"))
        self.assertIsInstance(self.d["attempts"][0]["replay_t_s"], (int, float))

    def test_no_private_names(self):
        text = FIXTURE.read_text().lower()
        for word in ("st1", "flow"):
            self.assertNotIn(word, text)


class FakeAnswersLikeTheRealServiceTests(unittest.TestCase):
    """The fake hub (tools/fake_deploy_hub.py) against the recorded real session detail: every field Review reads, and
    the same state vocabularies (a fake without the recording `state` hid a finalized recording shown as dead)."""

    def setUp(self):
        import shutil
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
        import fake_deploy_hub as fake
        self.fake = fake
        self.real = json.loads(FIXTURE.read_text())
        self.hub, self.srv = fake.start(["--port", "0", "--panel-port", "0", "--token", "t"])
        self.addCleanup(lambda: (self.srv.shutdown(), self.srv.server_close(),
                                 shutil.rmtree(self.hub.day, ignore_errors=True)))
        code, out = self.hub.post("/api/v1/start", {"mode": "sim", "practice": True, "scan": "scan-fake",
                                                    "confirm": {"gantry": True, "estop": True, "remote": True,
                                                                "rope": True}})
        self.c = self.hub.slots["sim"]
        self.addCleanup(setattr, self.c, "ended", True)
        self.c.attempts.append({"n": 1, "t_go": 1.0, "t_end": 4.0, "outcome": "arrived", "result": "arrived",
                                "tag": None, "note": None, "tag_history": [], "goal_scene": [1.0, 0.0],
                                "scan": "scan-fake", "start_check": None, "rehearsal": None, "check_id": "c",
                                "end_goal_dist_m": 0.2, "passage": None, "passage_basis": None, "passage_gate": None,
                                "rehearsal_override": None})
        self.c.end()

    def test_the_fake_session_detail_has_every_field_the_real_one_has(self):
        d = self.hub.session_detail(self.c)
        self.assertLessEqual(set(self.real) - {"rehearsal_run"}, set(d) | {"rehearsal_run"})
        self.assertLessEqual(set(self.real["manifest"]), set(d["manifest"]))
        self.assertLessEqual(set(self.real["manifest"]["items"][0]) - {"chunks", "unreadable"},
                             set(d["manifest"]["items"][0]))
        self.assertLessEqual(set(self.real["recording"]), set(d["recording"]))
        self.assertLessEqual(set(self.real["recording"]["streams"][0]), set(d["recording"]["streams"][0]))
        self.assertLessEqual(set(self.real["recording"]["recorder"]), set(d["recording"]["recorder"]))
        review = ATTEMPT | {"passage_basis", "passage_gate", "rehearsal_override"}
        self.assertLessEqual(review, set(d["attempts"][0]))

    def test_the_same_recording_and_manifest_states(self):
        self.assertIn(self.real["recording"]["state"], self.fake.RECORDING_STATES)
        self.assertLessEqual({s["state"] for s in self.real["recording"]["streams"]}, set(self.fake.STREAM_STATES))
        d = self.hub.session_detail(self.c)
        self.assertEqual((d["recording"]["state"], self.real["recording"]["state"]), ("finalized", "finalized"))
        self.assertEqual((d["manifest"]["state"], self.real["manifest"]["state"]), ("ended", "ended"))
        self.assertEqual({s["id"] for s in d["recording"]["streams"]}, {s["id"] for s in self.real["recording"]["streams"]})


if __name__ == "__main__":
    unittest.main()
