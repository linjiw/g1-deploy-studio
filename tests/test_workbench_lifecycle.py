import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from studio.workbench import Workbench, atomic_json


class Catalog:
    def __init__(self):
        self.entries = {}

    def session(self, key):
        raise KeyError(key)

    def register(self, key, path, label, **kwargs):
        self.entries[key] = (path, kwargs)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.w = Workbench(Catalog(), self.root, worker_python=sys.executable)
        self.scenario = self.w.save_scenario(self.w.description()['defaults'])['scenario']['id']
        self.real_popen = subprocess.Popen
        self.children = []

    def tearDown(self):
        for p in self.children:
            if p.poll() is None:
                p.terminate()
            p.wait(timeout=5)
        deadline = time.monotonic()+3
        while self.w._lease_held() and time.monotonic() < deadline:
            time.sleep(.02)
        self.tmp.cleanup()

    def stub_popen(self, args, **kwargs):
        # Real child lifecycle / inherited fd; intentionally no policy inference.
        run = args[args.index('--output')+1]
        program = ('import pathlib,time,json; p=pathlib.Path(__import__("sys").argv[1]); '
                   'p.mkdir(); time.sleep(.5); '
                   '(p/"session.json").write_text(json.dumps({"schema_version":1,"frames":[{"time":0}]})); '
                   '(p/"result.json").write_text(json.dumps({"status":"completed","report":{"outcome":"timeout"}}))')
        self.assertTrue(kwargs['pass_fds'])
        child = self.real_popen([sys.executable, '-c', program, run], **kwargs)
        self.children.append(child)
        return child

    def wait_terminal(self, job_id):
        deadline = time.monotonic()+5
        while time.monotonic() < deadline:
            job = self.w.job(job_id)
            if job['status'] not in ('starting', 'running', 'cancelling'):
                return job
            time.sleep(.02)
        self.fail('Owned stub did not reach terminal state')

    def test_two_managers_contend_and_child_keeps_lock_after_parent_fd_closes(self):
        with patch.object(self.w, 'capabilities', return_value={'available': True}), patch('studio.workbench.subprocess.Popen', side_effect=self.stub_popen):
            job = self.w.start_job(self.scenario)
        second = Workbench(Catalog(), self.root, worker_python=sys.executable)
        with patch.object(second, 'capabilities', return_value={'available': True}):
            with self.assertRaisesRegex(ValueError, 'holds this data root'):
                second.start_job(self.scenario)
        self.assertEqual(second.job(job['id'])['status'], 'detached')
        with self.assertRaises(ValueError):
            second.cancel_job(job['id'])
        # Model a gateway exit: close only its descriptor, never LOCK_UN.
        with self.w.lock:
            self.w._close_lease(self.w.jobs[job['id']])
        self.assertTrue(second._lease_held())
        final = self.wait_terminal(job['id'])
        self.assertEqual(final['status'], 'completed')
        self.assertFalse(second._lease_held())
        self.assertEqual(second.job(job['id'])['status'], 'completed')

    def test_launch_failure_persists_failure_and_releases_lock(self):
        with patch.object(self.w, 'capabilities', return_value={'available': True}), patch('studio.workbench.subprocess.Popen', side_effect=OSError('intentional launch failure')):
            with self.assertRaises(OSError):
                self.w.start_job(self.scenario)
        self.assertFalse(self.w._lease_held())
        records = self.w.list_jobs()['jobs']
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['status'], 'failed')
        self.assertIn('intentional launch failure', records[0]['error'])
        reopened = Workbench(Catalog(), self.root)
        self.assertEqual(reopened.list_jobs()['jobs'][0]['status'], 'failed')

    def test_compact_history_reloads_and_does_not_embed_heavy_snapshot(self):
        with patch.object(self.w, 'capabilities', return_value={'available': True}), patch('studio.workbench.subprocess.Popen', side_effect=self.stub_popen):
            job = self.w.start_job(self.scenario)
        self.wait_terminal(job['id'])
        self.w.jobs[job['id']]['latest'] = {'large': 'x'*200000}
        self.w._persist_job(self.w.jobs[job['id']])
        record = self.root/'jobs'/job['id']/'job.json'
        self.assertLess(record.stat().st_size, 20000)
        self.assertNotIn('latest', json.loads(record.read_text()))
        self.assertNotIn('latest', self.w.list_jobs()['jobs'][0])
        self.assertNotIn('log_tail', self.w.list_jobs()['jobs'][0])
        reopened = Workbench(Catalog(), self.root)
        restored = reopened.job(job['id'])
        self.assertEqual(restored['status'], 'completed')
        self.assertIsNone(restored['runtime']['worker_pid'])
        self.assertIsNone(restored['runtime']['telemetry_age_ms'])

    def test_incomplete_record_without_lock_is_failed_without_signalling_pid(self):
        output = self.root/'jobs/job-interrupted'
        output.mkdir()
        atomic_json(output/'job.json', {'status': 'running', 'worker_pid': os.getpid()})
        with patch('studio.workbench.os.killpg') as kill:
            reopened = Workbench(Catalog(), self.root)
            self.assertEqual(reopened.job('job-interrupted')['status'], 'failed')
            kill.assert_not_called()

    def test_failed_recording_remains_inspectable_after_restart(self):
        output = self.root/'jobs/job-failed-replay'
        (output/'run').mkdir(parents=True)
        atomic_json(output/'job.json', {'status': 'failed', 'error': 'source route failure'})
        session = {'schema_version': 1, 'metadata': {'incomplete': True}, 'frames': [{'time': 0}]}
        atomic_json(output/'run/session.json', session)
        atomic_json(output/'run/result.json', {'status': 'failed', 'error': 'source route failure',
                                             'report': {'outcome': 'runtime_error'}})
        catalog = Catalog()
        with patch('studio.workbench.os.killpg') as kill:
            reopened = Workbench(catalog, self.root)
            job = reopened.job('job-failed-replay')
            self.assertEqual(job['status'], 'failed')
            self.assertEqual(job['result_session_id'], 'job-failed-replay')
            self.assertIn('job-failed-replay', catalog.entries)
            self.assertEqual(reopened.session_data('job-failed-replay'), session)
            kill.assert_not_called()

    def test_termination_race_ignores_already_exited_owned_process(self):
        process = Mock(pid=123)
        process.poll.return_value = None
        with patch('studio.workbench.os.killpg', side_effect=ProcessLookupError):
            Workbench._terminate(process)

    def test_observed_map_option_retains_unknown_timing_and_disables_physics(self):
        c = Catalog()
        c.session = lambda key: ({'metadata': {}, 'perception': {'available': True,
            'support_points': [[0,0,0]], 'ceiling_points': [[1,0,1]], 'resolution_m': .05,
            'source': 'recorded-map.npz'}}, b'')
        w = Workbench(c, self.root)
        m = w.map('dds-observed-map')
        self.assertEqual(m['points'], [[0,0,0], [1,0,1]])
        self.assertFalse(m['runnable'])
        self.assertIsNone(m['capture_time'])
        self.assertEqual(m['classification'], 'estimated')


if __name__ == '__main__':
    unittest.main()
