"""Worker request contract and the Flow callback worker's pre-runtime rejections.

Only validation paths are exercised: no episode runs, and an import guard proves
the rejections happen before Torch/ONNX/Flow/deploy modules would be imported.
"""
import copy
import hashlib
import importlib.abc
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from studio import flow_policy_worker as flow_worker
from studio import policy_bundle as pb
from studio import policy_worker
from studio.policy_worker import CRITERIA, LOADERS, task_thresholds, validate_request

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ID = 'flow-wx-rf-23326aa-s0'
RUNTIME_MODULES = ('torch', 'onnxruntime', 'humanoid_lfh', 'motion2scene_flow', 'g1deploy', 'sim',
                   'isaaclab', 'omni', 'zmq', 'unitree_sdk2py')


class RuntimeImportGuard(importlib.abc.MetaPathFinder):
    """Fails any first import of a policy runtime and records the attempt."""

    def __init__(self):
        self.attempts = []

    def find_spec(self, name, path=None, target=None):
        if name.split('.')[0] in RUNTIME_MODULES:
            self.attempts.append(name)
            raise ImportError(f'{name} imported during a validation-only test')
        return None

    def __enter__(self):
        sys.meta_path.insert(0, self)
        return self

    def __exit__(self, *exc):
        sys.meta_path.remove(self)


def base_request(**overrides):
    request = {'schema_version': 1, 'id': 'job-contract', 'goal_xy': [1, 0], 'duration_s': 2,
               'map': {'kind': 'boxes', 'boxes': []}}
    request.update(overrides)
    return request


def flow_request(bundle_id=BUNDLE_ID, **overrides):
    return base_request(policy={'id': 'flow-wx-rf-23326aa-s0', 'loader': 'flow-callback', 'bundle_id': bundle_id},
                        **overrides)


class ValidateRequestTests(unittest.TestCase):
    def test_actuators_default_to_source_for_requests_saved_before_profiles(self):
        self.assertEqual(validate_request(base_request())['actuators'], 'source')
        self.assertEqual(validate_request(base_request(actuators='g1-current'))['actuators'], 'g1-current')
        with self.assertRaises(ValueError):
            validate_request(base_request(actuators='unknown'))

    def test_default_policy_and_criterion_when_absent(self):
        clean = validate_request(base_request())
        self.assertEqual(clean['policy'], {'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle', 'identity_sha256': None})
        self.assertEqual(clean['criterion'], 'arrive_hold')
        self.assertEqual(LOADERS, ('deploy-bundle', 'flow-callback'))

    def test_criterion_allowlist(self):
        self.assertEqual(validate_request(base_request(criterion='arena_reach'))['criterion'], 'arena_reach')
        for value in ('bogus', None, 'Arena_Reach', 1):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'criterion must be one of'):
                validate_request(base_request(criterion=value))

    # Regression (fixed 2026-10-20): studio/policy_worker.py:104 tests `criterion not in CRITERIA` on raw JSON, so a list/object
    # criterion raises TypeError (unhashable) instead of the documented ValueError rejection.
    def test_unhashable_criterion_is_a_validation_error(self):
        for value in (['arrive_hold'], {'id': 'arrive_hold'}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'criterion must be one of'):
                validate_request(base_request(criterion=value))

    def test_policy_loader_and_identifier_validation(self):
        bad = [{'id': 'flow-bundle-20261008', 'loader': 'shell'}, {'id': 'flow-bundle-20261008'},
               {'id': 'flow-bundle-20261008', 'loader': None}, 'flow-bundle-20261008', ['deploy-bundle'],
               {'id': 'Flow-Bundle', 'loader': 'deploy-bundle'}, {'id': '../x', 'loader': 'deploy-bundle'},
               {'id': 'a' * 65, 'loader': 'deploy-bundle'}, {'id': '', 'loader': 'deploy-bundle'},
               {'id': 7, 'loader': 'deploy-bundle'}, {'loader': 'deploy-bundle'}]
        for policy in bad:
            with self.subTest(policy=policy), self.assertRaises(ValueError):
                validate_request(base_request(policy=policy))
        clean = validate_request(base_request(policy={'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle',
                                                      'identity_sha256': 'f' * 80, 'bundle_id': BUNDLE_ID,
                                                      'checkpoint': '/untrusted/model.pt'}))
        self.assertEqual(clean['policy'], {'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle',
                                           'identity_sha256': 'f' * 64})

    def test_flow_callback_requires_a_pinned_bundle_identifier(self):
        clean = validate_request(flow_request())
        self.assertEqual(clean['policy']['bundle_id'], BUNDLE_ID)
        self.assertEqual(clean['policy']['loader'], 'flow-callback')
        for bundle_id in (None, '', '../x', '../../etc/passwd', 'flow-wx-rf-23326aa-s3', 'flow-wx-rf-23326AA-s0',
                          f'{BUNDLE_ID}/../x', f'/abs/{BUNDLE_ID}', f'{BUNDLE_ID}\n', 123):
            with self.subTest(bundle_id=bundle_id), self.assertRaisesRegex(ValueError, 'Unknown policy bundle id'):
                validate_request(flow_request(bundle_id))
        missing = flow_request()
        del missing['policy']['bundle_id']
        with self.assertRaisesRegex(ValueError, 'Unknown policy bundle id'):
            validate_request(missing)

    def test_latency_anchor_passes_through_for_the_flow_callback(self):
        self.assertEqual(validate_request(flow_request(latency={'ms': 200, 'anchor': 'predict'}))['latency'],
                         {'ms': 200, 'anchor': 'predict'})
        self.assertEqual(validate_request(flow_request())['latency'], {'ms': 0, 'anchor': 'measured'})

    def test_latency_model_description(self):
        legacy = {'ms': 200, 'anchor': 'measured',
                  'implementation': 'Studio delayed execution around the Flow callback plan_target',
                  'basis': ('Each plan is executed from request tick + latency; the previous plan keeps '
                            'driving SONIC meanwhile (pipelined). The callback still anchors its next '
                            'replan on the latest computed plan, so this approximates, not reproduces, '
                            'an asynchronous planner.')}
        # 'measured' keeps the exact record it had before predictive anchoring existed.
        self.assertEqual(flow_worker.latency_model({'ms': 200, 'anchor': 'measured'}), legacy)
        self.assertEqual(flow_worker.latency_model({'ms': 0, 'anchor': 'measured'}),
                         dict(legacy, ms=0, basis='No latency: synchronous lockstep.'))
        predict = flow_worker.latency_model({'ms': 200, 'anchor': 'predict'})
        self.assertEqual((predict['ms'], predict['anchor']), (200, 'predict'))
        for key in ('implementation', 'basis', 'predicted', 'measured', 'not_predicted', 'prediction_source', 'clock'):
            self.assertTrue(predict[key], key)
        self.assertIn('landed', predict['prediction_source'])
        self.assertIn('Flow code is unchanged', predict['implementation'])
        self.assertTrue(any('route progress' in m for m in predict['measured']))
        json.dumps(predict, allow_nan=False)

    def test_task_thresholds_for_both_criteria(self):
        expected = {
            'arrive_hold': {'goal_radius_m': .3, 'goal_speed_m_s': .25, 'goal_hold_s': .4, 'fall_height_m': .35,
                            'fall_tilt_rad': 1.0, 'obstacle_contact_threshold_n': 100.0},
            'arena_reach': {'goal_radius_m': .4, 'goal_speed_m_s': 2.0, 'goal_hold_s': .1, 'fall_height_m': .38,
                            'fall_tilt_rad': .8, 'obstacle_contact_threshold_n': 5.0}}
        self.assertEqual(set(CRITERIA), set(expected))
        for criterion, values in expected.items():
            with self.subTest(criterion=criterion):
                thresholds = task_thresholds(criterion)
                self.assertEqual(thresholds, values)
                self.assertNotIn('label', thresholds)
                self.assertTrue(CRITERIA[criterion]['label'])
                thresholds['goal_radius_m'] = 99
                self.assertEqual(task_thresholds(criterion)['goal_radius_m'], values['goal_radius_m'])
        with self.assertRaises(KeyError):
            task_thresholds('bogus')


class FlowWorkerRejectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.policy_root = self.base / 'policies'
        self.policy_root.mkdir()
        # The worker resolves bundles under the Studio data root; point it at a temp root.
        patcher = patch.object(flow_worker, 'bundle_path', lambda bundle_id: pb.bundle_path(bundle_id, root=self.policy_root))
        patcher.start()
        self.addCleanup(patcher.stop)

    def assert_rejected_without_output(self, request, message):
        output = self.base / 'run'
        with RuntimeImportGuard() as guard, self.assertRaisesRegex(ValueError, message):
            flow_worker.execute(request, output)
        self.assertEqual(guard.attempts, [])
        self.assertFalse(output.exists(), 'Rejected requests must not create run output')

    def test_rejects_non_flow_loader_before_any_output_or_import(self):
        self.assert_rejected_without_output(base_request(), 'only pinned Flow callback bundles')
        self.assert_rejected_without_output(
            base_request(policy={'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle'}), 'only pinned Flow callback')

    def test_rejects_malformed_bundle_ids_before_any_output_or_import(self):
        for bundle_id in ('../x', '../../research-data', 'flow-wx-rf-23326aa-s9', None):
            with self.subTest(bundle_id=bundle_id):
                self.assert_rejected_without_output(flow_request(bundle_id), 'Unknown policy bundle id')

    def test_rejects_predictive_anchor_without_latency_before_any_output_or_import(self):
        for latency in ({'ms': 0, 'anchor': 'predict'}, {'ms': 9, 'anchor': 'predict'}):
            with self.subTest(latency=latency):
                self.assert_rejected_without_output(flow_request(latency=latency), 'at least one 20 ms tick')

    def test_unknown_bundle_fails_verification_before_runtime_import(self):
        output = self.base / 'run'
        with RuntimeImportGuard() as guard, self.assertRaisesRegex(ValueError, 'failed verification: manifest unavailable'):
            flow_worker.execute(flow_request('flow-wx-rf-0000000-s1'), output)
        self.assertEqual(guard.attempts, [])
        result = json.loads((output / 'result.json').read_text())
        self.assertEqual(result['status'], 'failed')
        self.assertIn('manifest unavailable', result['error'])
        self.assertFalse(result['recording_complete'])
        self.assertFalse(result['hardware_enabled'])
        latest = json.loads((output / 'latest.json').read_text())
        self.assertEqual(latest['status'], 'failed')
        self.assertIsNone(latest['frame'])
        self.assertEqual(json.loads((output / 'request.json').read_text())['policy']['bundle_id'], 'flow-wx-rf-0000000-s1')
        self.assertFalse((output / 'session.json').exists())

    def test_tampered_bundle_fails_verification_before_runtime_import(self):
        root = self.policy_root / BUNDLE_ID
        (root / 'src').mkdir(parents=True)
        (root / 'src/planner.py').write_text('PLAN = 1\n')
        (root / 'config.json').write_text('{"arms": []}')
        artifacts = []
        for rel in pb.ARTIFACT_LINKS:  # bundle links point at pinned external targets, as the builder makes them
            target = self.base / 'external' / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{}')
            artifacts.append({'path': str(target), 'bytes': 2, 'sha256': hashlib.sha256(b'{}').hexdigest()})
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).symlink_to(target)
        (root / 'manifest.json').write_text(json.dumps({
            'schema_version': 1, 'id': BUNDLE_ID, 'src_files': pb.tree_hashes(root / 'src'),
            'flow': {'config_sha256': hashlib.sha256(b'{"arms": []}').hexdigest()},
            'artifacts': artifacts, 'humanoid_lfh': {'files': []}, 'deploy': {'files': []}}))
        self.assertEqual(pb.verify(root), [])
        (root / 'src/planner.py').write_text('PLAN = 2  # edited after pinning\n')
        output = self.base / 'run'
        with RuntimeImportGuard() as guard, self.assertRaisesRegex(ValueError, 'src tree differs'):
            flow_worker.execute(flow_request(), output)
        self.assertEqual(guard.attempts, [])
        self.assertEqual(json.loads((output / 'result.json').read_text())['status'], 'failed')

    def test_deploy_worker_rejects_flow_callback_requests_before_output(self):
        output = self.base / 'deploy-run'
        with RuntimeImportGuard() as guard, self.assertRaisesRegex(ValueError, 'only the frozen deploy bundle'):
            policy_worker.execute(flow_request(), output)
        self.assertEqual(guard.attempts, [])
        self.assertFalse(output.exists())

    def test_clean_interpreter_rejection_imports_no_runtime(self):
        # Importing the module (not running it as a worker) in a fresh interpreter, so
        # sys.modules is not shared with other tests that legitimately load numpy/mujoco.
        code = f'''
import sys
from pathlib import Path
from studio import flow_policy_worker as w
out = Path(sys.argv[1])
for request in ({base_request()!r}, {flow_request('../x')!r}):
    try:
        w.execute(request, out)
    except ValueError:
        pass
    else:
        raise SystemExit('request was not rejected')
assert not out.exists()
heavy = [m for m in ("torch", "onnxruntime", "mujoco", "numpy", "zmq", "humanoid_lfh", "motion2scene_flow") if m in sys.modules]
assert not heavy, heavy
'''
        result = subprocess.run([sys.executable, '-c', code, str(self.base / 'clean-run')], cwd=ROOT,
                                capture_output=True, text=True, timeout=20,
                                env=dict(os.environ, PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE='1'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.base / 'clean-run').exists())


if __name__ == '__main__':
    unittest.main()
