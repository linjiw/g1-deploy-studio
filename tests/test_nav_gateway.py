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


if __name__ == '__main__':
    unittest.main()
