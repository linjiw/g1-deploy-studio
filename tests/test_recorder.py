import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from studio.recorder import BoundedRecorder, StreamHealth, validate_endpoint


class EndpointTests(unittest.TestCase):
    def test_loopback_only_fails_closed(self):
        for endpoint in ("tcp://127.0.0.1:35557", "tcp://[::1]:5557"):
            self.assertEqual(validate_endpoint(endpoint), endpoint)
        for endpoint in ("tcp://localhost:5557", "tcp://192.168.123.10:5557", "tcp://0.0.0.0:5557",
                         "ipc:///tmp/test", "tcp://127.0.0.1:5557/", "tcp://127.0.0.1:5557?x=1",
                         "tcp://user@127.0.0.1:5557", "tcp://127.0.0.1", "tcp://127.0.0.1:70000"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                validate_endpoint(endpoint)


class HealthTests(unittest.TestCase):
    def test_sequence_loss_restart_and_stale_disconnect_distinguished(self):
        health = StreamHealth()
        self.assertEqual(health.snapshot(10)["status"], "unavailable")
        self.assertIsNone(health.snapshot(10)["observed_rate_hz"])
        health.observe(10, 10)
        health.observe(13, 10.02)
        self.assertEqual(health.snapshot(10.1)["sequence_gaps"], 2)
        self.assertAlmostEqual(health.snapshot(10.1)["observed_rate_hz"], 50)
        self.assertEqual(health.snapshot(11)["status"], "stale")
        self.assertEqual(health.snapshot(13)["status"], "silent")
        health.transport = "disconnected"
        self.assertEqual(health.snapshot(13)["status"], "disconnected")
        health.observe(1, 13.1)
        self.assertEqual(health.sequence_restarts, 1)
        self.assertIsNone(health.snapshot(13.1)["source_latency_s"])
        with self.assertRaises(ValueError):
            health.observe(2, 9)

    def test_reference_chunks_have_no_packet_sequence_gap_metric(self):
        health = StreamHealth()
        health.observe(None, 1)
        health.observe(None, 2)
        self.assertIsNone(health.snapshot(2)["sequence_gaps"])


class RecorderTests(unittest.TestCase):
    def test_slow_writer_drops_oldest_without_blocking_ingest(self):
        gate = threading.Event()
        class SlowRecorder(BoundedRecorder):
            def _write_loop(self):
                gate.wait(timeout=2)
                super()._write_loop()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "capture.jsonl"
            recorder = SlowRecorder(path, queue_size=4)
            before = time.monotonic()
            for i in range(100):
                recorder.submit({"index": i})
            elapsed = time.monotonic() - before
            self.assertLess(elapsed, 0.5)
            self.assertEqual(recorder.queue.qsize(), 4)
            self.assertEqual(recorder.dropped, 96)
            gate.set()
            stats = recorder.close()
            self.assertIsNone(stats["writer_error"])
            self.assertEqual([json.loads(line)["index"] for line in path.read_text().splitlines()], list(range(96, 100)))
            self.assertFalse(recorder.submit({"index": 100}))

    def test_disk_limit_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "capture.jsonl"
            recorder = BoundedRecorder(path, max_bytes=20)
            recorder.submit({"large": "x" * 100})
            stats = recorder.close()
            self.assertTrue(stats["file_limit_reached"])
            self.assertEqual(path.stat().st_size, 0)
            with self.assertRaises(FileExistsError):
                BoundedRecorder(path)
