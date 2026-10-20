"""Opt-in integration tests of the real WX-RF worker (deploy interpreter, CPU, ~1 min).

    STUDIO_INTEGRATION=1 .venv/bin/python -m unittest tests.test_flow_worker_integration -v
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY_PYTHON = Path('/home/linjiw/code/g1-student-deploy/.venv/bin/python')
BUNDLE = Path.home() / 'research-data/g1-deploy-studio/policies/flow-wx-rf-23326aa-s0'
ENABLED = os.environ.get('STUDIO_INTEGRATION') == '1' and DEPLOY_PYTHON.is_file() and (BUNDLE / 'manifest.json').is_file()


def run_driver(output, fail_at):
    env = dict(os.environ, PYTHONPATH=str(ROOT), CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
    done = subprocess.run([str(DEPLOY_PYTHON), '-B', str(ROOT / 'tests/integration/wx_failure_driver.py'), str(output), str(fail_at)],
                          capture_output=True, text=True, timeout=300, env=env, cwd=ROOT)
    return json.loads(done.stdout.strip().splitlines()[-1])


@unittest.skipUnless(ENABLED, 'set STUDIO_INTEGRATION=1 (needs the deploy interpreter and the pinned WX-RF bundle)')
class FlowWorkerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_flat_map_with_infinite_clearance_completes(self):
        # Empty map: the planner reports infinite clearance; strict JSON must still be written.
        out = Path(self.tmp.name) / 'flat'
        self.assertIsNone(run_driver(out, 10 ** 6)['raised'])
        result = json.loads((out / 'result.json').read_text())
        self.assertEqual(result['status'], 'completed')
        session = json.loads((out / 'session.json').read_text())
        self.assertEqual(len(session['frames']), 100)  # 2 s at 50 Hz
        self.assertTrue(session['metadata']['privileged_map'])

    def test_predictive_anchor_episode_records_its_anchors(self):
        # 2 s, 200 ms latency, predict: each predicted plan is anchored at request + 10 ticks and its landing is checked.
        out = Path(self.tmp.name) / 'predict'
        request = {'schema_version': 1, 'id': 'wx-predict', 'goal_xy': [2.0, 0.0], 'start_xy': [0, 0], 'start_yaw_rad': 0,
                   'duration_s': 2, 'seed': 0, 'planner': {'candidates': 2, 'ode_steps': 2}, 'criterion': 'arrive_hold',
                   'latency': {'ms': 200, 'anchor': 'predict'},
                   'policy': {'id': 'flow-wx-rf-23326aa-s0', 'loader': 'flow-callback', 'bundle_id': 'flow-wx-rf-23326aa-s0'},
                   'map': {'id': 'flat', 'label': 'Flat', 'kind': 'boxes', 'frame_id': 'world', 'boxes': []}}
        path = Path(self.tmp.name) / 'request.json'
        path.write_text(json.dumps(request))
        env = dict(os.environ, PYTHONPATH=str(ROOT), CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
        done = subprocess.run([str(DEPLOY_PYTHON), '-B', str(ROOT / 'studio/flow_policy_worker.py'), '--request', str(path),
                               '--output', str(out)], capture_output=True, text=True, timeout=300, env=env, cwd=ROOT)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        result = json.loads((out / 'result.json').read_text())
        self.assertEqual(result['status'], 'completed')
        report = result['report']
        self.assertEqual(report['latency_model']['anchor'], 'predict')
        self.assertTrue(report['anchor_mode'].startswith('predict'))
        plans = json.loads((out / 'latency_anchor.json').read_text())['plans']
        self.assertEqual(plans[0]['mode'], 'measured')  # the first plan: nothing has landed yet
        predicted = [p for p in plans[1:] if p['mode'] == 'predict']
        self.assertEqual(len(predicted), len(plans) - 1)
        self.assertTrue(all(p['anchor_tick'] == p['request_tick'] + 10 for p in predicted))
        self.assertTrue(all(p['prediction_error'] for p in predicted if p['anchor_tick'] < 100))
        self.assertEqual(report['anchor_prediction']['predicted_plans'], len(predicted))
        session = json.loads((out / 'session.json').read_text())
        self.assertEqual(session['metadata']['fidelity'], 'L2-approx')
        self.assertTrue(any((f.get('plan') or {}).get('anchor_mode') == 'predict' for f in session['frames']))

    def test_mid_episode_failure_keeps_real_error_and_executed_replay(self):
        out = Path(self.tmp.name) / 'fail'
        self.assertIn('injected test failure at tick 10', run_driver(out, 10)['raised'])
        result = json.loads((out / 'result.json').read_text())
        self.assertEqual(result['status'], 'failed')
        self.assertIn('injected test failure', result['error'])
        self.assertEqual(result['native_extraction']['executed_rows'], 10)
        session = json.loads((out / 'session.json').read_text())
        self.assertEqual(len(session['frames']), 10)
        self.assertTrue(session['metadata']['incomplete'])
        self.assertIn('injected test failure', session['metadata']['termination_reason'])



@unittest.skipUnless(ENABLED, 'set STUDIO_INTEGRATION=1 (needs the deploy interpreter and the frozen bundle)')
class BundleWorkerLatencyIntegrationTests(unittest.TestCase):
    """Under latency the bundle worker shows the executing plan, not the newest in-flight one (review N8)."""

    def test_frames_are_attributed_to_the_executing_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'bundle-latency'
            request = {'schema_version': 1, 'id': 'bundle-latency', 'goal_xy': [2.0, 0.0], 'start_xy': [0, 0], 'start_yaw_rad': 0,
                       'duration_s': 3, 'seed': 0, 'planner': {'candidates': 2, 'ode_steps': 4}, 'criterion': 'arrive_hold',
                       'latency': {'ms': 200, 'anchor': 'measured'},
                       'policy': {'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle'},
                       'map': {'id': 'flat', 'label': 'Flat', 'kind': 'boxes', 'frame_id': 'world', 'boxes': []}}
            path = Path(tmp) / 'request.json'
            path.write_text(json.dumps(request))
            env = dict(os.environ, PYTHONPATH=str(ROOT), CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
            done = subprocess.run([str(DEPLOY_PYTHON), '-B', str(ROOT / 'studio/policy_worker.py'), '--request', str(path),
                                   '--output', str(out)], capture_output=True, text=True, timeout=600, env=env, cwd=ROOT)
            self.assertEqual(done.returncode, 0, done.stderr[-2000:])
            session = json.loads((out / 'session.json').read_text())
            plans = json.loads((out / 'native/plans.json').read_text())
        starts = session['metadata']['latency_model']['executing_plan_starts']
        requests = sorted(p['tick'] for p in plans)
        self.assertEqual(starts[0], [requests[0], requests[0]])  # the first plan drives SONIC at once
        self.assertGreater(len(starts), 1)
        self.assertTrue(all(start == request + 10 for start, request in starts[1:]))  # 200 ms = 10 ticks
        for i, frame in enumerate(session['frames']):
            plan = frame['plan']
            current = max(s for s in starts if s[0] <= i)
            self.assertAlmostEqual(plan['executing_since_s'], current[0] * 0.02)
            self.assertAlmostEqual(plan['requested_at_s'], current[1] * 0.02)
            self.assertAlmostEqual(plan['age_s'], (i - current[0]) * 0.02)
            self.assertIn('executing plan', plan['attribution'])
        # Some frames fall inside a latency window, where the newest request is not the executing plan.
        newest = lambda i: max(r for r in requests if r <= i)
        self.assertTrue(any(newest(i) * 0.02 != f['plan']['requested_at_s'] for i, f in enumerate(session['frames'])))


if __name__ == '__main__':
    unittest.main()
