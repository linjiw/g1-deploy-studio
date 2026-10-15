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

from studio.policy_worker import capabilities, validate_request, _atomic


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


if __name__ == '__main__':
    unittest.main()
