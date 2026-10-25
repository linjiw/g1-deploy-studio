"""Replay of real robot sessions recorded by the deploy kit's console (g1deploy/recorder.py, g1deploy.recording.v1).

The fixture writes the recorder's on-disk layout (rec/meta.json, rec/<stream>/NNNNNN.npz chunks, node_status.jsonl,
session.json, node.log, node_plans.json) as documented by the deploy-PC session; no deploy code is imported."""
import json
import math
from pathlib import Path
import tempfile
import unittest

import numpy as np

from studio import paths, protocols, replay

MODEL = paths.get('deploy_root') / 'sim/assets/g1_29dof.xml'


def yaw_quat(yaw, tilt=0.0):
    """wxyz: heading `yaw`, then a small roll `tilt`."""
    cy, sy, cr, sr = math.cos(yaw / 2), math.sin(yaw / 2), math.cos(tilt / 2), math.sin(tilt / 2)
    return np.array([cy * cr, cy * sr, -sy * sr, sy * cr])  # Rz(yaw) * Rx(tilt)


def pack(topic, fields):
    """g1deploy.zmq_stream.pack, protocol v1 single-part framing."""
    specs, blobs = [], []
    for name, arr in fields:
        a = np.ascontiguousarray(arr, dtype='<f8')
        specs.append({'name': name, 'dtype': 'f64', 'shape': list(a.shape)})
        blobs.append(a.tobytes())
    header = json.dumps({'v': 1, 'endian': 'le', 'count': 1, 'fields': specs}, separators=(',', ':')).encode()
    return topic + header.ljust(protocols.HEADER_SIZE, b'\0') + b''.join(blobs)


def write_session(root, *, lio=False, seconds=2.0, rate=1000, chunk_s=1.0):
    rec = root / 'rec'
    (rec / 'lowstate').mkdir(parents=True)
    (rec / 'meta.json').write_text(json.dumps({'format': 'g1deploy.recording.v1', 'clock': 'time.monotonic',
                                               'iface': 'eno1', 'domain': 0, 'status_hz': 5, 'host': 'g1-deploy-pc'}))
    t0 = 5000.0
    t = t0 + np.arange(int(seconds * rate)) / rate
    t = np.sort(np.r_[t, t[::20]])  # about 5 % duplicate samples, as rt/lowstate at 1 kHz on the lab G1
    q = np.zeros((len(t), 35), dtype=np.float32)
    q[:, 3] = 0.3 + 0.1 * np.sin(t - t0)  # left knee
    imu = np.tile(yaw_quat(0.2, 0.05), (len(t), 1)).astype(np.float32)
    per = int(chunk_s * rate)
    for k in range(0, len(t), per):
        np.savez(rec / 'lowstate' / f'{k // per:06d}.npz', t=t[k:k + per], t_unix=t[k:k + per] + 1.7e9, q=q[k:k + per],
                 imu_quat=imu[k:k + per], dq=np.zeros_like(q[k:k + per]), tick=np.arange(k, min(k + per, len(t))))
    (rec / 'lowstate' / '000099.npz.tmp').write_bytes(b'partial')  # a chunk being written: ignored
    rows = []
    for k, ts in enumerate(np.arange(t0, t0 + seconds, 0.2)):
        rows.append(json.dumps({'t': ts, 't_unix': ts + 1.7e9, 'status': {
            'phase': 'RUN' if k else 'PRESCAN', 'xy': [0.5 * (ts - t0), 0.0], 'yaw_rad': 0.2, 'pelvis_z_m': 0.78,
            'goal': [2.0, 0.0], 'goal_dist_m': 2.0 - 0.5 * (ts - t0), 'guards': 'walls'}}))
    (rec / 'node_status.jsonl').write_text('\n'.join(rows) + '\n{"t": 1, "sta')  # a line cut by power loss
    if lio:
        (rec / 'zmq_odom').mkdir()
        ot = np.arange(t0, t0 + seconds, 0.05)
        msgs = [pack(b'odom', [('pos', [0.4 * (x - t0), 0.1, 0.8]), ('quat_wxyz', yaw_quat(0.5)), ('lin_w', [0.4, 0, 0]),
                               ('ang_w', [0, 0, 0]), ('stamp', [x])]) for x in ot]
        off = np.cumsum([0] + [len(m) for m in msgs])
        np.savez(rec / 'zmq_odom' / '000000.npz', t=ot, t_unix=ot + 1.7e9,
                 msg=np.frombuffer(b''.join(msgs), dtype=np.uint8), msg_off=off)
    (root / 'session.json').write_text(json.dumps({'mode': 'robot', 'robot': 'lab-g1', 'odom': 'zmq' if lio else 'leg',
                                                  'guards': 'walls', 'goal_lookahead': 1.0, 'note': 'h5 2 m', 't0': t0}))
    (root / 'node.log').write_text(f'{t0 + 0.1:.3f} {{"event": "node_up", "t": {t0 + 0.1}}}\n'
                                   f'noise line\n{t0 + 0.6:.3f} {{"event": "run", "t": {t0 + 0.6}}}\n')
    (root / 'node_plans.json').write_text(json.dumps({'plans': [{'tick': 25, 'req_tick': 25, 'anchor_tick': 25, 'latency_s': 0.08,
                                                                 'rule': 'safe_min_goal_distance', 'guard': None}]}))
    return t0


@unittest.skipUnless(MODEL.is_file(), 'needs the deploy stack (sim/assets/g1_29dof.xml)')
class ConsoleReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'h5-2m'

    def test_leg_odometry_session(self):
        t0 = write_session(self.root)
        s = replay.load_session(self.root, max_frames=400)
        m = s['metadata']
        self.assertEqual((m['recording_kind'], m['robot'], m['pose_source']), ('robot-console-session', 'real', 'node-status'))
        self.assertEqual(m['console']['guards'], 'walls')
        self.assertEqual(m['frame_id'], 'odom')  # the robot's odometry frame, as every frame
        frames = s['frames']
        self.assertEqual(len(frames), 400)
        self.assertTrue(all(f['joints_classification'] == 'measured' and f['classification'] == 'estimated' for f in frames))
        times = [f['time'] for f in frames]
        self.assertEqual(times, sorted(times))
        self.assertLess(m['recorded_state_rate_hz'], 1001)  # duplicates dropped
        mid = frames[200]
        expected_x = 0.5 * (mid['source_time'] - t0)  # node status xy, interpolated at 5 Hz
        self.assertAlmostEqual(mid['position'][0], expected_x, places=2)
        self.assertAlmostEqual(mid['position'][2], 0.78, places=6)
        q = np.asarray(mid['quaternion_wxyz'])
        self.assertAlmostEqual(float(replay._yaw(q[None])[0]), 0.2, places=5)  # heading from the node
        self.assertAlmostEqual(mid['health']['tilt_rad'], 0.05, places=3)  # tilt from the pelvis IMU
        self.assertAlmostEqual(mid['joints'][3], 0.3 + 0.1 * math.sin(mid['source_time'] - t0), places=5)
        self.assertEqual([e['type'] for e in s['events']], ['node_up', 'run'])
        planned = [f for f in frames if f['plan']]
        self.assertTrue(planned and abs(planned[0]['time'] - (0.1 + 25 * 0.02)) < 0.01)
        json.dumps(s, allow_nan=False)  # the gateway's encoder refuses NaN

    def test_lio_session_prefers_the_lio_pose(self):
        t0 = write_session(self.root, lio=True)
        s = replay.load_session(self.root, max_frames=100)
        self.assertEqual(s['metadata']['pose_source'], 'lio')
        f = s['frames'][50]
        self.assertAlmostEqual(f['position'][0], 0.4 * (f['source_time'] - t0), places=2)
        self.assertAlmostEqual(f['position'][1], 0.1, places=6)
        self.assertAlmostEqual(float(replay._yaw(np.asarray(f['quaternion_wxyz'])[None])[0]), 0.5, places=4)

    def test_rec_dir_itself_and_refusals(self):
        write_session(self.root)
        self.assertEqual(replay.console_rec_dir(self.root / 'rec'), self.root / 'rec')
        (self.root / 'rec' / 'node_status.jsonl').write_text('')
        with self.assertRaisesRegex(replay.ReplayError, 'no pose'):
            replay.load_session(self.root)
        other = Path(self.tmp.name) / 'other'
        other.mkdir()
        (other / 'meta.json').write_text(json.dumps({'format': 'something.else'}))
        with self.assertRaises(replay.ReplayError):
            replay.load_session(other)

    def test_catalog_lists_sessions_and_robot_days(self):
        from studio.server import Catalog
        base = Path(self.tmp.name) / 'robot-sessions'
        write_session(base / 'robot-day-20261024' / 'h5-2m')
        write_session(base / 'door-1')
        catalog = Catalog()
        catalog.discover_console(base, force=True)
        rows = {k: v for k, v in catalog.entries.items() if k.startswith('robot-')}
        self.assertEqual(sorted(rows), ['robot-door-1', 'robot-robot-day-20261024-h5-2m'])
        self.assertTrue(all(v['robot'] == 'real' and v['group'].startswith('Robot sessions') for v in rows.values()))
        data, encoded = catalog.entry('robot-door-1')  # through the gateway's decode and finite-JSON encoder
        self.assertEqual(data['metadata']['recording_kind'], 'robot-console-session')
        self.assertEqual(data['metadata']['catalog_id'], 'robot-door-1')
        self.assertGreater(len(encoded.body), 1000)


if __name__ == '__main__':
    unittest.main()
