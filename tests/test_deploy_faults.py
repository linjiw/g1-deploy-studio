"""Combined faults from the 2026-11-06 review (R01, R02, R05): conditions that each pass alone in test_deploy_link.py
but interact. Fake services only, on loopback ephemeral ports; nothing here talks to a robot, DDS or ZMQ.
"""
import json
from pathlib import Path
import shutil
import socket
import tempfile
import threading
import time
import unittest

from studio.deploy_link import DeployLink

from tests.test_deploy_link import GatewayCase, wait_for


class EmergencyUnderCombinedFaultsTests(GatewayCase):
    """R01: an expired lease, a hung audit writer, the 12 general slots held and the deploy service gone, together.
    E-STOP and Stand still reach the console within their budget; attribution may be missing, never late."""

    def hold_general_slots(self):
        held = []
        for _ in range(12):
            s = socket.create_connection(("127.0.0.1", self.port))
            s.sendall(b"GET /api/deploy/state HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n" % self.port)  # never finished
            held.append(s)
        self.addCleanup(lambda: [s.close() for s in held])
        self.assertTrue(wait_for(lambda: not self._slot_free(), timeout=3.0), "the 12 general slots never filled")
        return held

    def _slot_free(self):
        if self.server.slots.acquire(blocking=False):
            self.server.slots.release()
            return True
        return False

    def hang_audit(self, seconds):
        held = threading.Event()

        def hung_disk():                                   # a writer stuck on the disk holds the audit lock
            with self.deploy.audit_lock:
                held.set()
                time.sleep(seconds)
        threading.Thread(target=hung_disk, daemon=True).start()
        self.assertTrue(held.wait(1))

    def expire_lease(self):
        status, out = self.call("POST", "/api/deploy/lease", {"operator": "Linji"}, self.csrf())
        self.assertEqual(status, 200, out)
        self.deploy.lease["until"] = self.deploy.clock() - 1.0   # expired, not yet noticed by anyone

    def test_expired_lease_and_hung_audit_never_delay_the_estop_or_stand(self):
        robot = self.start_robot()
        self.expire_lease()
        self.hang_audit(2.0)
        status, out, dt = self.estop()
        self.assertEqual(status, 200)
        self.assertTrue(out["ok"], out)
        self.assertLess(dt, 0.3, out)
        self.assertEqual(robot.runner, "E-STOP")
        status, out, dt = self.estop("/api/deploy/direct", {"slot": "robot", "act": "t"})
        self.assertIn(status, (200, 409), out)               # served (the console decides)
        self.assertLess(dt, 0.3, out)

    def test_all_four_faults_together(self):
        robot = self.start_robot()
        self.expire_lease()
        self.stop_hub_server()
        self.hold_general_slots()
        self.hang_audit(3.0)
        times = []
        for _ in range(3):
            status, out, dt = self.estop()
            self.assertEqual(status, 200)
            self.assertTrue(out["ok"], out)
            times.append(dt)
        self.assertEqual(robot.runner, "E-STOP")
        self.assertLess(max(times), 0.3, times)
        status, out, dt = self.estop("/api/deploy/direct", {"slot": "robot", "act": "h"})
        self.assertIn(status, (200, 409), out)
        self.assertEqual(out["slot"], "robot")
        self.assertLess(dt, 0.3)

    def test_the_lease_lock_is_never_held_across_a_disk_write(self):
        """Anything that notices the expiry (a renewal, the page's state poll) queues the audit row and moves on."""
        self.start_robot()
        self.expire_lease()
        self.hang_audit(1.5)
        t0 = time.monotonic()
        self.assertIsNone(self.deploy.lease_public())        # notices the expiry: queued, not written
        self.assertLess(time.monotonic() - t0, 0.1)
        self.deploy.audit_flush(3.0)
        kinds = [json.loads(line)["kind"] for line in self.audit.read_text().splitlines()]
        self.assertIn("lease_lost", kinds)                   # written once the disk came back

    def test_estop_attribution_is_the_live_holder(self):
        self.start_robot()
        self.call("POST", "/api/deploy/lease", {"operator": "Linji"}, self.csrf())
        self.estop()
        self.deploy.audit_flush(3.0)
        rows = [json.loads(line) for line in self.audit.read_text().splitlines()]
        self.assertEqual([r["operator"] for r in rows if r["kind"] == "estop"], ["Linji"])
        relayed = [a for a in self.hub.actions if a["body"].get("act") == "estop"]
        self.assertTrue(all(a["body"].get("operator") == "Linji" for a in relayed), relayed)


class GrowingRecordingTests(unittest.TestCase):
    """R05: a console recording opened while it is written is decoded again once it grew (at most every
    LIVE_REDECODE_S while live) and once it is finalized; a finalized one is decoded once."""

    def setUp(self):
        from tests.test_console_replay import MODEL
        if not MODEL.is_file():
            self.skipTest("needs the deploy stack (sim/assets/g1_29dof.xml)")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name) / "robot-sessions"
        self.session = self.base / "robot-120000-deploy"

    def write(self, seconds, final=False):
        from tests.test_console_replay import write_session
        shutil.rmtree(self.session, ignore_errors=True)
        write_session(self.session, seconds=seconds)
        if final:
            meta = self.session / "rec" / "meta.json"
            meta.write_text(json.dumps(dict(json.loads(meta.read_text()), stopped_unix=1.7e9 + seconds)))

    def test_open_live_grow_finalize_reopen(self):
        from studio import server
        self.write(1.0)
        catalog = server.Catalog()
        catalog.discover_console(self.base, force=True)
        key = "robot-robot-120000-deploy"
        first = catalog.entry(key)[0]
        self.assertAlmostEqual(first["metadata"]["duration_s"], 1.0, delta=0.01)
        self.assertFalse(first["metadata"]["recording_revision"]["finalized"])
        self.assertIs(catalog.entry(key)[0], first)                  # unchanged: the cached decode
        self.write(3.0)
        catalog.revisions[key] = catalog.revisions[key][:2] + (time.monotonic() - server.LIVE_REDECODE_S - 1,)
        grown = catalog.entry(key)[0]
        self.assertAlmostEqual(grown["metadata"]["duration_s"], 3.0, delta=0.01)
        self.write(4.0, final=True)                                  # finalized: decoded at once, whatever the throttle
        final = catalog.entry(key)[0]
        self.assertAlmostEqual(final["metadata"]["duration_s"], 4.0, delta=0.01)
        self.assertTrue(final["metadata"]["recording_revision"]["finalized"])
        self.assertIs(catalog.entry(key)[0], final)                  # finalized and unchanged: decoded once
        other = server.Catalog()                                     # a second gateway (another browser) agrees
        other.discover_console(self.base, force=True)
        self.assertEqual(other.entry(key)[0]["metadata"]["duration_s"], final["metadata"]["duration_s"])
        self.assertEqual(other.entry(key)[0]["metadata"]["recording_revision"]["signature"],
                         final["metadata"]["recording_revision"]["signature"])

    def test_a_live_recording_is_not_decoded_on_every_request(self):
        from studio import server
        self.write(1.0)
        catalog = server.Catalog()
        catalog.discover_console(self.base, force=True)
        key = "robot-robot-120000-deploy"
        first = catalog.entry(key)[0]
        self.write(2.0)                                              # grew a moment ago: still the snapshot
        self.assertIs(catalog.entry(key)[0], first)


if __name__ == "__main__":
    unittest.main()
