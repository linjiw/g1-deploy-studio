import json
from pathlib import Path
import tempfile
import unittest

from mcap.reader import make_reader
from studio.export import encode_mcap, load_mcap


class McapTests(unittest.TestCase):
    def test_real_recording_roundtrip_and_index(self):
        from studio.replay import DEFAULT_SESSION, load_session
        if not (DEFAULT_SESSION / 'closed_loop.npz').exists():
            self.skipTest('Local integration recording not installed')
        source = load_session(DEFAULT_SESSION, max_frames=20)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'replay.mcap'
            path.write_bytes(encode_mcap(source))
            restored = load_mcap(path)
            self.assertEqual(restored['frames'], source['frames'])
            self.assertEqual(restored['metadata'], source['metadata'])
            with path.open('rb') as f:
                reader = make_reader(f)
                self.assertIsNotNone(reader.get_summary())
                messages = list(reader.iter_messages(start_time=1_000_000_000, end_time=2_000_000_000))
                self.assertGreater(len(messages), 0)
                for _, channel, message in messages:
                    self.assertEqual(channel.metadata['time_basis'], 'not Unix acquisition time')
                    self.assertGreaterEqual(json.loads(message.data)['time'], 1)
                    self.assertLess(json.loads(message.data)['time'], 2)

    def test_time_regression_rejected(self):
        with self.assertRaises(ValueError):
            encode_mcap({'metadata': {'clock_domain': 'simulation'},
                         'frames': [{'time': 1}, {'time': .5}]})

    def test_capture_mcap_preserves_unknown_pose_and_observed_graph(self):
        from studio.capture_replay import load_capture
        source_path = Path.home() / 'research-data/g1-deploy-studio/evidence/wire-20261015/wire_capture.jsonl'
        if not source_path.exists():
            self.skipTest('Local wire acceptance capture not installed')
        source = load_capture(source_path)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'wire.mcap'
            path.write_bytes(encode_mcap(source))
            restored = load_mcap(path)
        self.assertEqual(restored['frames'], source['frames'])
        self.assertIsNone(restored['metadata']['model_path'])
        self.assertTrue(all(f['position'] is None for f in restored['frames']))
        self.assertEqual(restored['frames'][-1]['health']['stream_status'], 'disconnected')


if __name__ == '__main__':
    unittest.main()
