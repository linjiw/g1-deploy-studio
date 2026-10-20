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


if __name__ == '__main__':
    unittest.main()
