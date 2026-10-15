"""Causal transport replay tests; fixtures are explicitly not controller data."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from studio.capture_replay import load_capture
from studio.protocols import HEADER_SIZE, ISAAC_JOINTS, MJ_JOINTS, decode_packet
from studio.replay import ReplayError, frame_at

REAL_CAPTURE = Path('/home/linjiw/research-data/g1-deploy-studio/evidence/wire-20261015/wire_capture.jsonl')
ENDPOINT = 'tcp://127.0.0.1:34567'


def fixture_events():
    fields = [('joint_pos', np.arange(58, dtype=np.float32).reshape(2, 29)),
              ('joint_vel', np.ones((2, 29), dtype=np.float32)),
              ('body_quat', np.array([[1, 0, 0, 0]]*2, dtype=np.float32)),
              ('frame_index', np.array([10, 15], dtype=np.int64)),
              ('timestamp_monotonic', np.array([9000.], dtype=np.float64))]
    dtypes = {'float32':'f32', 'float64':'f64', 'int64':'i64'}
    header = {'v':1, 'endian':'le', 'count':2,
              'fields':[{'name':n, 'dtype':dtypes[str(a.dtype)], 'shape':list(a.shape)} for n,a in fields]}
    wire = b'pose' + json.dumps(header).encode().ljust(HEADER_SIZE, b'\0') + b''.join(a.tobytes() for _,a in fields)
    envelope = decode_packet(wire, b'pose', receipt_monotonic=101., receipt_unix=1000.,
                             source_id=ENDPOINT, session_id='fixture')
    envelope['wire_base64'] = base64.b64encode(wire).decode()
    snapshot = {'status':'stale', 'transport':'connected', 'receipt_age_s':.6,
                'observed_rate_hz':None, 'sequence_gaps':None}
    return [
        {'record':'capture_start', 'schema_version':1, 'session_id':'fixture', 'receipt_timestamp':100.,
         'receipt_clock':'collector_host_monotonic', 'endpoints':[ENDPOINT], 'topics':['pose'],
         'hardware_command_path':False, 'dds_participant':False},
        {'record':'transport', 'receipt_timestamp':100.1, 'endpoint':ENDPOINT, 'state':'connected'},
        envelope,
        {'record':'health', 'receipt_timestamp':101.6, 'streams':{ENDPOINT+'#pose':snapshot},
         'recorder':{'queue_drops':0}},
        {'record':'transport', 'receipt_timestamp':102., 'endpoint':ENDPOINT, 'state':'disconnected'},
        {'record':'capture_end', 'receipt_timestamp':102.5,
         'streams':{ENDPOINT+'#pose':dict(snapshot, status='disconnected', transport='disconnected', receipt_age_s=1.5)}}]


class CaptureReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'wire_capture.jsonl'
        self.events = fixture_events()

    def write(self, events=None):
        self.path.write_text(''.join(json.dumps(e)+'\n' for e in (self.events if events is None else events)))
        return self.path

    def test_no_state_or_root_created_and_receipt_time_is_causal(self):
        session = load_capture(self.write())
        self.assertEqual(session['metadata']['recording_kind'], 'recorded-wire-transport')
        self.assertEqual(session['metadata']['duration_s'], 2.5)
        self.assertIsNone(session['metadata']['model_path'])
        self.assertEqual(session['trajectory'], [])
        for frame in session['frames']:
            for key in ('state','position','quaternion_wxyz','qpos','joints','sequence'):
                self.assertIsNone(frame[key])
            for key in ('state_age_ms','tracking_rmse_rad','source_latency_ms','sequence_gaps'):
                self.assertIsNone(frame['health'][key])
        self.assertIsNone(frame_at(session,.99)['frame']['reference'])
        reference = frame_at(session,1.)['frame']['reference']
        self.assertIsNone(reference['position'])
        self.assertEqual(reference['window'][1]['offset_s'], .1)
        self.assertIsNone(reference['playback_cursor'])
        self.assertEqual(reference['shape'], [2,29])
        for i,name in enumerate(MJ_JOINTS):
            self.assertEqual(reference['joints'][i], ISAAC_JOINTS.index(name))
        self.assertEqual(session['frames'][2]['source_time'], 9000.)
        self.assertEqual(session['frames'][2]['receipt_time'], 101.)
        self.assertEqual(session['frames'][-1]['health']['reference_age_ms'], 1500.)
        json.dumps(session, allow_nan=False)

    def test_observed_graph_tracks_actual_status_without_static_runtime_discovery_claim(self):
        session = load_capture(self.write())
        self.assertEqual(frame_at(session,1.)['frame']['health']['stream_status'], 'fresh')
        self.assertEqual(frame_at(session,1.7)['frame']['health']['stream_status'], 'stale')
        self.assertEqual(frame_at(session,2.1)['frame']['health']['stream_status'], 'disconnected')
        self.assertFalse(session['graph']['runtime_discovered'])
        self.assertTrue(session['graph']['runtime_observed'])
        edge = session['frames'][-1]['observed_graph']['edges'][0]
        self.assertEqual(edge['status'], 'disconnected')
        self.assertIsNone(edge['drops'])
        self.assertIsNone(edge['publisher_identity'])
        self.assertIn('stream-stale', [e['type'] for e in session['events']])
        self.assertIn('transport-disconnected', [e['type'] for e in session['events']])

    def test_original_bytes_must_agree_with_normalized_envelope(self):
        for mutation in ('fields','names','clock','bytes','sequence'):
            events = copy.deepcopy(self.events)
            event = events[2]
            if mutation == 'fields': event['payload']['fields']['joint_pos'][0][0] = 100
            if mutation == 'names': event['payload']['joint_names'].reverse()
            if mutation == 'clock': event['source_timestamp'] += 1
            if mutation == 'bytes': event['wire_base64'] = 'invalid!!!'
            if mutation == 'sequence': event['sequence'] = 10
            with self.subTest(mutation=mutation), self.assertRaises(ReplayError):
                load_capture(self.write(events))

    def test_backward_time_and_fake_packet_loss_rejected(self):
        bad_time = copy.deepcopy(self.events)
        bad_time[3]['receipt_timestamp'] = 100.5
        bad_gap = copy.deepcopy(self.events)
        bad_gap[3]['streams'][ENDPOINT+'#pose']['sequence_gaps'] = 0
        for events in (bad_time,bad_gap):
            with self.assertRaises(ReplayError):
                load_capture(self.write(events))

    def test_missing_model_and_unverified_receipt_do_not_gain_identity(self):
        path = self.write()
        receipt_path = path.with_name('wire_acceptance.json')
        receipt = {'kind':'recorded_data_transport_rehearsal', 'controller_executed':False,
                   'hardware_command_path':False, 'capture':{'output':str(path)}}
        receipt_path.write_text(json.dumps(receipt))
        session = load_capture(path)
        self.assertIsNone(session['metadata']['provenance']['publisher_identity_receipt'])
        self.assertIsNone(session['metadata']['model_path'])
        receipt['capture']['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        receipt_path.write_text(json.dumps(receipt))
        session = load_capture(path)
        self.assertIsNotNone(session['metadata']['provenance']['publisher_identity_receipt'])
        self.assertIn('verified receipt',session['graph']['nodes'][0]['label'])
        # Even verified test provenance cannot turn into an observed model/policy.
        self.assertIsNone(session['metadata']['model_path'])
        self.assertIsNone(session['graph']['edges'][0]['publisher_identity'])

    def test_bounded_frame_budget_preserves_diagnostics_or_rejects(self):
        with self.assertRaises(ReplayError):
            load_capture(self.write(),max_frames=3)  # five diagnostic events cannot be omitted
        session = load_capture(self.path,max_frames=5)
        self.assertEqual(len(session['frames']),5)
        self.assertEqual(session['frames'][-1]['health']['stream_status'],'disconnected')
        self.assertEqual(session['metadata']['source_samples'],1)

    def test_partial_capture_is_explicit_and_empty_capture_is_unavailable(self):
        partial = load_capture(self.write(self.events[:-1]))
        self.assertFalse(partial['metadata']['capture_complete'])
        empty = load_capture(self.write(self.events[:2]))
        self.assertEqual(empty['metadata']['source_samples'],0)
        self.assertTrue(all(f['reference'] is None for f in empty['frames']))
        self.assertTrue(all(f['health']['reference_age_ms'] is None for f in empty['frames']))


@unittest.skipUnless(REAL_CAPTURE.is_file(),'designated local wire evidence unavailable')
class RealCaptureTests(unittest.TestCase):
    def test_actual_wire_receipts_redecode_and_replay_failure_transitions(self):
        session = load_capture(REAL_CAPTURE)
        raw = [json.loads(line) for line in REAL_CAPTURE.read_text().splitlines()]
        envelopes = [row for row in raw if row.get('topic') == 'pose' and 'payload' in row]
        self.assertEqual(session['metadata']['source_samples'],len(envelopes))
        self.assertEqual(len(envelopes),40)
        self.assertEqual(session['metadata']['duration_s'],raw[-1]['receipt_timestamp']-raw[0]['receipt_timestamp'])
        for i in (0,17,39):
            envelope = envelopes[i]
            frame = next(f for f in session['frames'] if f['receipt_time']==envelope['receipt_timestamp'])
            source = envelope['payload']
            for j,name in enumerate(MJ_JOINTS):
                np.testing.assert_array_equal([row['joints'][j] for row in frame['reference']['window']],
                                              np.asarray(source['fields']['joint_pos'])[:,source['joint_names'].index(name)])
            self.assertEqual(frame['source_time'],envelope['source_timestamp'])
        self.assertEqual({f['health']['stream_status'] for f in session['frames']},
                         {'unavailable','fresh','stale','disconnected'})
        self.assertIsNone(session['frames'][-1]['health']['sequence_gaps'])
        self.assertGreater(session['frames'][-1]['health']['reference_age_ms'],1000)
        self.assertFalse(session['metadata']['command_path_enabled'])
