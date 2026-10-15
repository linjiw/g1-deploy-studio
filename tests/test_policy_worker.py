"""Worker boundaries: validation and optional actual short CPU execution.

Fresh source-backed execution is an acceptance run, not fabricated policy output.
Unit tests deliberately avoid importing Torch/ONNX into the gateway environment.
"""
import copy
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from studio.policy_worker import capabilities, validate_request, _atomic, contact_interval, executed_native_recording


class WorkerBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.request = {'schema_version': 1, 'goal_xy': [1, 0], 'map': {'kind': 'boxes', 'boxes': []}}

    def test_default_request_is_bounded_and_explicit(self):
        result = validate_request(self.request)
        self.assertEqual(result['planner'], {'candidates': 2, 'ode_steps': 4})
        self.assertEqual(result['duration_s'], 2)
        self.assertEqual(result['map']['frame_id'], 'world')
        self.assertEqual(result['start_xy'], [0, 0])

    def test_scan_cannot_become_implicit_collision_geometry(self):
        self.request['map']['kind'] = 'scan'
        with self.assertRaisesRegex(ValueError, 'inspection only'):
            validate_request(self.request)

    def test_rejects_clock_frame_and_compute_ambiguity(self):
        for mutate in [lambda r: r.update(schema_version=True),
                       lambda r: r.update(duration_s=11), lambda r: r.update(duration_s=True),
                       lambda r: r.update(goal_xy=[math.nan, 0]), lambda r: r.update(goal_xy=[1000, 0]),
                       lambda r: r['map'].update(frame_id='lidar'),
                       lambda r: r.update(planner={'candidates': 17}),
                       lambda r: r.update(planner={'ode_steps': 11}),
                       lambda r: r.update(planner={'candidates': True}),
                       lambda r: r.update(seed=-1), lambda r: r.update(id='../escape')]:
            with self.subTest(mutate=mutate):
                r = copy.deepcopy(self.request)
                mutate(r)
                with self.assertRaises(ValueError):
                    validate_request(r)

    def test_collision_boxes_preserve_world_geometry(self):
        box = {'center_xy': [2, -1], 'half_xy': [.4, .5], 'yaw': .2, 'z_bottom': .8, 'z_top': 1.1}
        self.request['map']['boxes'] = [box]
        self.assertEqual(validate_request(self.request)['map']['boxes'], [box])
        box['half_xy'] = [0, 1]
        with self.assertRaises(ValueError):
            validate_request(self.request)

    def test_no_passthrough_backend_command_or_unknown_options(self):
        self.request.update(command='launch-hardware', device='cuda', dds_domain=0)
        self.request['planner'] = {'run': '/untrusted/model.pt'}
        result = validate_request(self.request)
        for k in ('command', 'device', 'dds_domain'):
            self.assertNotIn(k, result)
        self.assertNotIn('run', result['planner'])

    def test_capabilities_does_not_import_policy_or_middleware(self):
        p = subprocess.run([sys.executable, '-c',
            'import sys; from studio.policy_worker import capabilities; c=capabilities(); '
            'assert not c["dds"] and not c["hardware_enabled"]; '
            'assert all(n not in sys.modules for n in ("torch","mujoco","onnxruntime","zmq","unitree_sdk2py"))'],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_atomic_snapshot_is_json_and_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'latest.json'
            _atomic(path, {'frame': None, 'status': 'initializing'})
            _atomic(path, {'frame': {'time': .02}, 'status': 'running'})
            self.assertEqual(json.loads(path.read_text())['frame']['time'], .02)
            self.assertFalse(path.with_suffix('.json.tmp').exists())

    def test_physics_contact_preserves_substeps_and_interval(self):
        interval = contact_interval([0., 23., 101., 8.], .02, .04)
        self.assertEqual(interval['samples_n'], [0., 23., 101., 8.])
        self.assertEqual(interval['max_force_n'], 101.)
        self.assertEqual(interval['end_s'], .04)
        self.assertEqual(interval['sample_period_s'], .005)
        self.assertEqual(interval['classification'], 'simulator-ground-truth')
        for forces, start, end in [([], 0., .02), ([math.nan], 0., .02),
                                   ([-1.], 0., .02), ([1.], .02, .02)]:
            with self.subTest(forces=forces, start=start, end=end), self.assertRaises(ValueError):
                contact_interval(forces, start, end)

    def test_failed_native_recording_preserves_original_and_only_excludes_unexecuted_tail(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            native = output/'native'
            native.mkdir()
            pre = np.arange(108.).reshape(3, 36)
            post = np.arange(72.).reshape(2, 36)
            refs = np.arange(1340.).reshape(2, 10, 67)
            np.savez_compressed(native/'closed_loop.npz', pre_action_qpos=pre, realized_qpos=post,
                                references=refs, estimated_qpos=np.empty((0,)))
            original_bytes = (native/'closed_loop.npz').read_bytes()
            _atomic(native/'plans.json', [{'tick': 0, 'waypoint_xy': [1., 2.]}])
            _atomic(native/'run_config.json', {'start': 'stand'})
            selected, extraction = executed_native_recording(output, 2)
            self.assertEqual(extraction['excluded_unexecuted_pre_states'], 1)
            self.assertEqual((native/'closed_loop.npz').read_bytes(), original_bytes)
            with np.load(selected/'closed_loop.npz') as result:
                np.testing.assert_array_equal(result['pre_action_qpos'], pre[:2])
                np.testing.assert_array_equal(result['realized_qpos'], post)
                np.testing.assert_array_equal(result['references'], refs)
            self.assertEqual(json.loads((selected/'plans.json').read_text())[0]['waypoint_xy'], [1., 2.])

    def test_failed_native_recording_rejects_missing_executed_data(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            native = output/'native'
            native.mkdir()
            np.savez_compressed(native/'closed_loop.npz', pre_action_qpos=np.zeros((3,36)),
                                realized_qpos=np.zeros((1,36)), references=np.zeros((2,10,67)))
            with self.assertRaisesRegex(ValueError, 'does not match executed frame count'):
                executed_native_recording(output, 2)
            self.assertFalse((output/'native_executed').exists())


if __name__ == '__main__':
    unittest.main()
