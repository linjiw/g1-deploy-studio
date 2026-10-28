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


if __name__ == "__main__":
    unittest.main()
