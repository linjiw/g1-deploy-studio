"""tools/doctor.py: read-only readiness report, levels and exit status."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DoctorTests(unittest.TestCase):
    def run_doctor(self, *args, env=None):
        return subprocess.run([sys.executable, str(ROOT / 'tools/doctor.py'), *args], cwd=ROOT, capture_output=True,
                              text=True, timeout=300, env=dict(os.environ, **(env or {})))

    def test_missing_deploy_stack_blocks_simulation_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {'G1_STUDENT_DEPLOY': str(Path(tmp, 'deploy')), 'LUCID_DEPLOY_ROOT': str(Path(tmp, 'lucid')),
                   'STUDIO_DATA': str(Path(tmp, 'data')), 'STUDIO_ROBOT_LINK': str(Path(tmp, 'robot_link.json'))}
            out = self.run_doctor('--json', '--quick', env=env)
            self.assertEqual(out.returncode, 1, out.stderr)
            report = json.loads(out.stdout)
            self.assertFalse(report['ready']['sim'])
            self.assertFalse(report['ready']['robot'])
            failed = {(r['section'], r['check']) for r in report['checks'] if r['status'] == 'fail'}
            self.assertIn(('Deploy stack', 'Checkout'), failed)
            self.assertIn(('Robot (deploy PC)', 'Robot link config'), failed)
            self.assertTrue(all(r.get('fix') for r in report['checks'] if r['status'] == 'fail'), 'every failure says how to fix it')
            self.assertFalse(Path(tmp, 'data').exists(), 'the doctor writes nothing')
            human = self.run_doctor('--quick', '--for', 'replay', env=env)
            self.assertIn('Ready for: Replay', human.stdout)
            self.assertEqual(human.returncode, 0 if report['ready']['replay'] else 1)


if __name__ == '__main__':
    unittest.main()
