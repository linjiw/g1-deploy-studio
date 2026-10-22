"""Gateway side of navigation sessions and the robot link (no worker runs here)."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from studio.workbench import Workbench, atomic_json


class Catalog:
    def __init__(self):
        self.entries, self.providers = {}, {}

    def session(self, key):
        raise KeyError(key)

    def register(self, key, path, label, provider=None, extra=None):
        self.entries[key] = {'path': path, 'label': label, **(extra or {})}
        if provider:
            self.providers[key] = provider
        else:
            self.providers.pop(key, None)


class NavGatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.w = Workbench(Catalog(), self.root, worker_python=sys.executable)
        self.sleeper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.addCleanup(lambda: (self.sleeper.kill(), self.sleeper.wait()))

    def job(self, key, kind='navigation', status='running'):
        output = self.root / 'jobs' / key
        (output / 'run' / 'inbox').mkdir(parents=True)
        job = {'id': key, 'status': status, 'kind': kind, 'output': output, 'process': self.sleeper, 'latest': None,
               'navigation': {'robot': 'real' if kind == 'robot' else 'simulated'}, 'scenario': {'label': key}}
        self.w.jobs[key] = job
        return job

    def test_commands_continue_after_the_files_already_in_the_inbox(self):
        """Verification NEW-1: after a gateway restart the in-memory counter starts at 0; End must not reuse 000001."""
        job = self.job('job-aaaaaaaaaaaa')
        inbox = job['output'] / 'run' / 'inbox'
        for seq in (1, 2, 3):
            atomic_json(inbox / f'{seq:06d}.json', {'seq': seq, 'cmd': 'goal', 'xy': [1, 0]})
        job['_seq'] = 0  # what a restarted gateway knows
        reply = self.w.nav_command(job['id'], {'cmd': 'end'})
        self.assertEqual(reply['seq'], 4)
        self.assertEqual(json.loads((inbox / '000001.json').read_text())['cmd'], 'goal')  # never overwritten
        self.assertEqual(json.loads((inbox / '000004.json').read_text())['cmd'], 'end')
        self.assertEqual(self.w.nav_command(job['id'], {'cmd': 'stand'})['seq'], 5)

    def test_a_detached_session_can_still_be_ended(self):
        job = self.job('job-bbbbbbbbbbbb', status='detached')
        job['process'] = None
        self.assertEqual(self.w.nav_command(job['id'], {'cmd': 'end'})['cmd'], 'end')
        with self.assertRaises(ValueError):
            self.w.nav_command(job['id'], {'cmd': 'go'})

    def test_a_null_report_never_breaks_the_job_list(self):
        """Verification NEW-2: a robot link that refused its config writes result.json with report: null."""
        job = self.job('job-cccccccccccc', kind='robot', status='failed')
        job['process'] = None
        atomic_json(job['output'] / 'run' / 'result.json', {'schema_version': 1, 'status': 'failed', 'report': None, 'error': 'refused'})
        listing = self.w.list_jobs()
        row = next(j for j in listing['jobs'] if j['id'] == job['id'])
        self.assertIsNone(row['summary']['outcome'])

    def test_real_robot_goals_fail_closed_without_a_map(self):
        job = self.job('job-dddddddddddd', kind='robot')
        with self.assertRaisesRegex(ValueError, 'could not be checked'):
            self.w.nav_command(job['id'], {'cmd': 'goal', 'xy': [1.0, 0.0]})
        self.assertEqual(list((job['output'] / 'run' / 'inbox').iterdir()), [])
        for cmd in ('takeover', 'clear'):
            with self.assertRaises(ValueError):
                self.w.nav_command(job['id'], {'cmd': cmd})


class NavDeploySettingsTests(unittest.TestCase):
    """Navigate's "Use deploy settings" preset (apps/web/js/navigate.js) resolves to the robot's deploy configuration."""
    ROOT = Path(__file__).resolve().parents[1]

    def js_object(self, name):
        import re
        text = (self.ROOT / 'apps/web/js/navigate.js').read_text()
        body = re.search(r'const %s = \{(.*?)\};' % name, text, re.S).group(1)
        return text, body

    def test_preset_maps_to_valid_gateway_options(self):
        import re
        from studio import nav_worker
        from studio.workbench import NAV_ODOMETRY, NAV_PLANNER
        _, body = self.js_object('DEPLOY_SETTINGS')
        preset = dict(re.findall(r"(\w+): '([\w-]+)'", body))
        self.assertEqual(preset, {'planner': 'deployed', 'latency': 'node', 'actuators': 'g1-current', 'odometry': 'lio',
                                  'map_mode': 'keep'})
        self.assertEqual({k: NAV_PLANNER['deployed'][k] for k in ('candidates', 'ode_steps')}, {'candidates': 16, 'ode_steps': 10})
        self.assertIn(preset['odometry'], NAV_ODOMETRY)
        _, latency = self.js_object('LATENCY')
        node = re.search(r"\n  node: \{.*?value: \{ mode: '(\w+)', preset: '([\w-]+)' \}", latency)
        self.assertEqual(node.groups(), ('node', 'bundle-fused'))
        clean = Workbench._nav_latency({'mode': 'node', 'preset': 'bundle-fused'}, {'loader': 'deploy-bundle'})
        self.assertEqual(clean, nav_worker.validate_nav_latency({'mode': 'node', 'preset': 'bundle-fused'}))
        self.assertEqual(clean['distribution'], {'kind': 'lognormal', 'p50_s': 0.119, 'p95_s': 0.167})

    def test_gateway_latency_and_stand_mode(self):
        from studio import nav_worker
        profile = {'loader': 'deploy-bundle'}
        self.assertEqual(Workbench._nav_latency({'ms': 160, 'anchor': 'predict'}, profile), {'ms': 160, 'anchor': 'predict'})
        self.assertEqual(Workbench._nav_latency(None, profile), {'ms': 0, 'anchor': 'measured'})
        self.assertEqual(Workbench._nav_latency({'mode': 'node', 'preset': 'flow-sk1'}, profile)['preset'], 'flow-sk1')
        with self.assertRaises(ValueError):
            Workbench._nav_latency({'mode': 'node', 'preset': 'nope'}, profile)
        self.assertEqual(nav_worker.validate_stand_mode('hold_upper'), 'hold_upper')
        with self.assertRaises(ValueError):
            nav_worker.validate_stand_mode('arms_up')


if __name__ == '__main__':
    unittest.main()
