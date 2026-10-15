import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from studio.server import Catalog, Gateway
from studio.workbench import Workbench, point_status, validate_map


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        config = self.root/'catalog.json'
        config.write_text(json.dumps({'sessions': []}))
        self.catalog = Catalog(config)
        self.workbench = Workbench(self.catalog, self.root/'data')
        self.request = dict(self.workbench.description()['defaults'])

    def tearDown(self):
        self.tmp.cleanup()

    def test_goal_validated_against_exact_map_and_settings(self):
        prepared = self.workbench.save_scenario(self.request)
        self.assertTrue(prepared['validation']['valid'])
        scenario = prepared['scenario']
        self.assertEqual(scenario['map_sha256'], self.workbench.map('flat-ground')['sha256'])
        self.assertTrue((self.root/'data/scenarios'/f"{scenario['id']}.json").is_file())
        self.assertIn('differ from deployed', ' '.join(prepared['validation']['warnings']))
        self.assertFalse(self.workbench.prepare(dict(self.request, goal_xy=[6,0]))['validation']['valid'])
        self.assertFalse(self.workbench.prepare(dict(self.request, goal_xy=[0,0]))['validation']['valid'])

    def test_rotated_obstacle_clearance_and_unknown_scan(self):
        m = validate_map({'kind':'boxes','label':'rotated','boxes':[{'center_xy':[1,1], 'half_xy':[1,.1],
                         'yaw':1.5707963267948966, 'z_bottom':0, 'z_top':1}]})
        self.assertEqual(point_status(m, [1,1.8])['status'], 'blocked')
        self.assertEqual(point_status(m, [2,1])['status'], 'configured_free')
        scan = self.workbench.import_map({'kind':'scan','label':'observed floor','frame_id':'world','points':[[0,0,0],[1,1,0]]})
        self.assertFalse(scan['runnable'])
        self.assertEqual(point_status(scan, [0,0])['status'], 'observed_surface')
        self.assertEqual(point_status(scan, [.5,.5])['status'], 'unknown')
        result = self.workbench.save_scenario(dict(self.request, map_id=scan['id']))
        self.assertFalse(result['validation']['valid'])
        with self.assertRaisesRegex(ValueError, 'collision geometry'):
            self.workbench.start_job(result['scenario']['id'])

    def test_map_and_job_inputs_are_bounded_and_no_paths_execute(self):
        bad = [dict(self.request, backend_id='hardware'), dict(self.request, duration_s=100),
               dict(self.request, goal_xy=[float('nan'),0]), dict(self.request, seed=True),
               dict(self.request, planner={'candidates':17,'ode_steps':4}),
               dict(self.request, start_xy=[0]), dict(self.request, goal_xy=[51,0])]
        for request in bad:
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.workbench.prepare(request)
        for m in [{'label':'bad','kind':'mesh','path':'/etc/passwd'},
                  {'label':'bad','kind':'scan','points':[[0,0,float('inf')]]},
                  {'label':'bad','kind':'boxes','frame_id':'sensor','boxes':[]}]:
            with self.subTest(map=m), self.assertRaises(ValueError):
                self.workbench.import_map(m)
        with self.assertRaises(KeyError):
            self.workbench.cancel_job('someone-elses-job')

    def test_single_owned_job_limit_and_persistent_maps(self):
        scenario = self.workbench.save_scenario(self.request)['scenario']
        self.workbench.jobs['test'] = {'status':'running'}
        with patch.object(self.workbench, 'capabilities', return_value={'available': True}):
            with self.assertRaisesRegex(ValueError, 'already active'):
                self.workbench.start_job(scenario['id'])
        m = self.workbench.import_map({'kind':'boxes','label':'my map','frame_id':'world','boxes':[]})
        reopened = Workbench(self.catalog, self.root/'data')
        self.assertEqual(reopened.map(m['id'])['sha256'], m['sha256'])

    def test_import_requires_frame_and_rejects_explicit_wrong_units_or_version(self):
        valid = {'kind':'scan', 'label':'aligned scan', 'frame_id':'world',
                 'units':'m', 'schema_version':1, 'points':[[0,0,0]]}
        self.assertEqual(self.workbench.import_map(valid)['units'], 'm')
        missing_frame = dict(valid)
        del missing_frame['frame_id']
        with self.assertRaisesRegex(ValueError, 'explicitly declare'):
            self.workbench.import_map(missing_frame)
        for overrides in ({'units':'cm'}, {'units':'mm'}, {'units':None},
                          {'schema_version':2}, {'schema_version':True}, {'schema_version':'1'}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.workbench.import_map(dict(valid, **overrides))


class WorkbenchHttpTests(PreparationTests):
    def setUp(self):
        super().setUp()
        self.catalog.workbench = self.workbench
        self.server = Gateway(('127.0.0.1',0), self.catalog)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        super().tearDown()

    def post(self, path, data, *, token=True, origin='http://localhost:64842'):
        headers = {'Host':'localhost:64842', 'Content-Type':'application/json'}
        if token:
            headers['X-Studio-Token'] = self.workbench.token
        if origin is not None:
            headers['Origin'] = origin
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request('POST', path, json.dumps(data), headers)
        r = conn.getresponse()
        result = r.status, json.loads(r.read())
        conn.close()
        return result

    def test_preparation_mutations_require_same_origin_token(self):
        self.assertEqual(self.post('/api/scenarios', self.request, token=False)[0],403)
        self.assertEqual(self.post('/api/scenarios', self.request, origin=None)[0],403)
        self.assertEqual(self.post('/api/scenarios', self.request, origin='https://example.com')[0],403)
        status, value = self.post('/api/scenarios', self.request)
        self.assertEqual(status,201)
        self.assertTrue(value['validation']['valid'])
        self.assertEqual(self.post('/api/hardware/start', {})[0],405)
        self.assertEqual(self.post('/api/jobs/cancel', {'id':'foreign'})[0],404)
        self.assertEqual(self.post('/api/jobs', {'scenario_id':'foreign'})[0],404)
        self.assertEqual(self.post('/api/scenarios', dict(self.request,duration_s=100))[0],422)


if __name__ == '__main__':
    unittest.main()
