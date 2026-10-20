"""HTTP delivery: revalidation, compression, sensor masks, mesh/static routes,
new mutation routes, and the session catalog's single-flight decode and bounded cache.

Every gateway binds loopback port 0 on a temporary catalog. No route here can start
a worker: the attached workbench reports its backend as unavailable.
"""
import base64
import copy
import gzip
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from studio import server as server_module
from studio import workbench as wb
from studio.server import Catalog, Gateway, Handler, build_identity
from studio.workbench import Workbench

HOST = 'localhost:64842'
ORIGIN = 'http://' + HOST


def make_session(frames=100):
    return {'schema_version': 1,
            'metadata': {'id': 'fixture', 'mode': 'replay', 'frame_id': 'world', 'clock_domain': 'simulation',
                         'fixture': True},
            'joint_names': ['test_joint'],
            'frames': [{'time': round(i * .02, 3), 'sequence': i, 'position': [i * .01, 0., .8],
                        'quaternion_wxyz': [1., 0., 0., 0.], 'joints': [.1], 'frame_id': 'world',
                        'classification': 'simulator-ground-truth'} for i in range(frames)],
            'events': [],
            'perception': {'available': True, 'kind': 'time-series', 'frames': [
                {'time': 0.0, 'map_time': 0.0, 'frame_id': 'world', 'classification': 'estimated',
                 'support_points': [[1., 0., 0.], [1.1, 0., 0.]], 'ceiling_points': [[1., 0., 1.5]],
                 'grid_shape': [4, 4], 'resolution_m': .1, 'map_origin': [0., 0.],
                 'support_observed_indices': [0, 5], 'ceiling_observed_indices': [3],
                 'observed_cells': {'support': 2, 'ceiling': 1}}]}}


class GatewayCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.session = make_session()
        self.session_path = self.base / 'fixture.json'
        self.session_path.write_text(json.dumps(self.session))
        config = self.base / 'sessions.json'
        config.write_text(json.dumps({'sessions': [{'id': 'fixture', 'path': str(self.session_path), 'label': 'Fixture'}]}))
        quiet = patch.object(Handler, 'log_message', lambda *args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.catalog = Catalog(config)
        self.attach()
        self.server = Gateway(('127.0.0.1', 0), self.catalog)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.stop)

    def attach(self):
        """Subclasses attach a workbench before the gateway starts."""

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()

    def call(self, path, headers=None, method='GET', body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=dict({'Host': HOST}, **(headers or {})))
            response = conn.getresponse()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
        finally:
            conn.close()

    def get_json(self, path, headers=None):
        status, headers, body = self.call(path, headers)
        self.assertEqual(status, 200, body)
        if headers.get('content-encoding') == 'gzip':
            body = gzip.decompress(body)
        return json.loads(body)


class SessionDeliveryTests(GatewayCase):
    def expected(self):
        expected = copy.deepcopy(self.session)
        expected['metadata']['catalog_id'] = 'fixture'
        return expected

    def test_session_gzip_and_etag(self):
        status, headers, body = self.call('/api/session?id=fixture', {'Accept-Encoding': 'gzip, deflate'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-encoding'], 'gzip')
        self.assertEqual(headers['content-type'], 'application/json')
        self.assertEqual(headers['cache-control'], 'private, no-cache')
        self.assertEqual(headers['vary'], 'Accept-Encoding')
        self.assertEqual(int(headers['content-length']), len(body))
        identity = json.dumps(self.expected(), allow_nan=False, separators=(',', ':')).encode()
        self.assertEqual(gzip.decompress(body), identity)
        # Each encoding is its own representation: the gzip validator carries a -gz suffix.
        self.assertEqual(headers['etag'], '"' + hashlib.sha1(identity).hexdigest() + '-gz"')
        self.assertLess(len(body), len(identity))
        plain_status, plain_headers, plain = self.call('/api/session?id=fixture')
        self.assertEqual(plain_status, 200)
        self.assertNotIn('content-encoding', plain_headers)
        self.assertEqual(json.loads(plain), self.expected())
        self.assertEqual(plain_headers['etag'], '"' + hashlib.sha1(identity).hexdigest() + '"')
        self.assertEqual(self.call('/api/session?id=fixture', {'If-None-Match': plain_headers['etag'], 'Accept-Encoding': 'gzip'})[0], 304,
                         'Either validator revalidates the same cached body')

    def test_if_none_match_returns_empty_304(self):
        _, headers, _ = self.call('/api/session?id=fixture')
        status, revalidated, body = self.call('/api/session?id=fixture',
                                              {'If-None-Match': headers['etag'], 'Accept-Encoding': 'gzip'})
        self.assertEqual(status, 304)
        self.assertEqual(body, b'')
        # The 304 reports the validator of the requested (gzip) representation.
        self.assertIn(revalidated['etag'], (headers['etag'], headers['etag'][:-1] + '-gz"'))
        self.assertEqual(revalidated['cache-control'], 'private, no-cache')
        stale, _, body = self.call('/api/session?id=fixture', {'If-None-Match': '"0000"'})
        self.assertEqual(stale, 200)
        self.assertEqual(json.loads(body), self.expected())

    def test_head_sends_headers_without_body(self):
        status, headers, body = self.call('/api/session?id=fixture', method='HEAD')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'')
        self.assertIn('etag', headers)

    def test_live_provider_session_is_never_stored(self):
        live = copy.deepcopy(self.session)
        calls = []

        def provider():
            calls.append(1)
            return copy.deepcopy(live)
        self.catalog.register('job-live', self.base / 'pending.json', 'LIVE', provider=provider)
        status, headers, body = self.call('/api/session?id=job-live', {'Accept-Encoding': 'gzip'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['cache-control'], 'no-store')
        self.assertEqual(json.loads(gzip.decompress(body))['metadata']['catalog_id'], 'job-live')
        live['frames'].append({'time': 9.0})
        self.assertEqual(len(self.get_json('/api/session?id=job-live')['frames']), 101)
        self.assertEqual(len(calls), 2)
        self.assertNotIn('job-live', self.catalog.cache)

    def test_run_without_recording_is_a_clean_404(self):
        # A run cancelled before writing session.json stays listed, but a replay
        # request gets a plain "no recording" answer, not a filesystem error.
        missing = self.base / 'jobs/job-cancelled/run/session.json'
        self.catalog.register('job-cancelled', missing, 'Cancelled · no recording', extra={'status': 'cancelled'})
        status, _, body = self.call('/api/session?id=job-cancelled')
        self.assertEqual(status, 404)
        error = json.loads(body)['error']
        self.assertIn('no replayable recording', error)
        self.assertIn('cancelled', error)
        self.assertNotIn(str(self.base), error)

    def test_sensor_masks_are_omitted_unless_requested(self):
        default = {s['id']: s for s in self.get_json('/api/sensors?session=fixture&time=0.5')['sensors']}
        for layer in ('map_support', 'map_ceiling'):
            payload = default[layer]['payload']
            self.assertTrue(default[layer]['available'])
            self.assertNotIn('observed_indices', payload)
            self.assertNotIn('observed_mask', payload)
            self.assertIn('masks=1', payload['observed_mask_omitted'])
            self.assertTrue(payload['points'])
        masked = {s['id']: s for s in self.get_json('/api/sensors?session=fixture&time=0.5&masks=1')['sensors']}
        self.assertEqual(masked['map_support']['payload']['observed_indices'], [0, 5])
        self.assertEqual(masked['map_ceiling']['payload']['observed_indices'], [3])
        self.assertNotIn('observed_mask_omitted', masked['map_support']['payload'])
        # Rows without masks (pose) are unchanged by the omission.
        self.assertEqual(default['base_pose'], masked['base_pose'])

    def test_version_reports_served_build(self):
        version = self.get_json('/api/version')
        for field in ('commit', 'describe', 'committed_at', 'dirty', 'root', 'started_unix_s'):
            self.assertIn(field, version)
        self.assertIs(version['hardware_enabled'], False)
        self.assertEqual(version['root'], str(server_module.ROOT))
        self.assertIsInstance(version['started_unix_s'], float)

    def test_build_identity_is_unknown_without_git(self):
        with patch('studio.server.subprocess.run', side_effect=OSError('git missing')):
            identity = build_identity(self.base)
        self.assertEqual({k: identity[k] for k in ('commit', 'describe', 'committed_at', 'dirty')},
                         {'commit': None, 'describe': None, 'committed_at': None, 'dirty': None})
        self.assertEqual(identity['root'], str(self.base))

    def test_content_addressed_mesh_route(self):
        token = hashlib.sha256(b'mesh').hexdigest()
        mesh = self.base / 'part.stl'
        mesh.write_bytes(b'solid part\n' + b'facet normal 0 0 1\n' * 200 + b'endsolid part\n')
        self.assertEqual(self.call(f'/assets/mesh/{token}.stl')[0], 404, 'Unknown token')
        with self.catalog.lock:
            self.catalog.meshes[token] = mesh
        status, headers, body = self.call(f'/assets/mesh/{token}.stl', {'Accept-Encoding': 'gzip'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['content-type'], 'model/stl')
        self.assertEqual(headers['cache-control'], 'private, max-age=31536000, immutable')
        self.assertEqual(headers['content-encoding'], 'gzip')
        self.assertEqual(gzip.decompress(body), mesh.read_bytes())
        self.assertEqual(self.call(f'/assets/mesh/{token}.stl', {'If-None-Match': headers['etag']})[0], 304)
        for bad in (f'/assets/mesh/{token[:-1]}.stl', f'/assets/mesh/{token.upper()}.stl',
                    f'/assets/mesh/{token}.obj', f'/assets/mesh/{token}0.stl', '/assets/mesh/../../AGENTS.md',
                    '/assets/mesh/%2e%2e/%2e%2e/AGENTS.md', f'/assets/mesh/{token}.stl/..', '/assets/mesh/'):
            with self.subTest(path=bad):
                status, _, body = self.call(bad)
                self.assertEqual(status, 404)
                self.assertNotIn(b'facet', body)

    def test_script_policy_hashes_the_importmap_instead_of_unsafe_inline(self):
        status, headers, _ = self.call('/')
        self.assertEqual(status, 200)
        policy = dict(part.strip().split(' ', 1) for part in headers['content-security-policy'].split(';'))
        self.assertNotIn('unsafe-inline', policy['script-src'])
        html = (server_module.ROOT / 'apps/web/index.html').read_bytes()
        importmap = html.split(b'<script type="importmap">', 1)[1].split(b'</script>', 1)[0]
        digest = base64.b64encode(hashlib.sha256(importmap).digest()).decode()
        self.assertEqual(policy['script-src'], f"'self' 'sha256-{digest}'")

    def test_static_files_revalidate_with_etag(self):
        web = self.base / 'site/apps/web'
        (web / 'js').mkdir(parents=True)
        (web / 'index.html').write_text('<!doctype html><title>fixture</title>' + '<p>x</p>' * 300)
        (web / 'js/app.js').write_text('export const fixture = 1;\n')
        (self.base / 'site/secret.txt').write_text('outside the web root')
        with patch.object(server_module, 'ROOT', self.base / 'site'):
            status, headers, body = self.call('/', {'Accept-Encoding': 'gzip'})
            self.assertEqual(status, 200)
            self.assertEqual(headers['content-type'], 'text/html')
            self.assertEqual(headers['cache-control'], 'private, no-cache')
            self.assertEqual(gzip.decompress(body), (web / 'index.html').read_bytes())
            status, _, body = self.call('/', {'If-None-Match': headers['etag']})
            self.assertEqual((status, body), (304, b''))
            status, script, _ = self.call('/js/app.js')
            self.assertEqual(status, 200)
            self.assertEqual(script['content-type'], 'application/javascript')
            self.assertNotIn('content-encoding', script, 'Small files are not compressed')
            (web / 'index.html').write_text('<!doctype html><title>changed</title>')
            status, changed, _ = self.call('/', {'If-None-Match': headers['etag']})
            self.assertEqual(status, 200, 'An edited file must not revalidate against the old ETag')
            self.assertNotEqual(changed['etag'], headers['etag'])
            for path in ('/../secret.txt', '/%2e%2e/secret.txt', '/js/../../secret.txt', '/missing.js'):
                with self.subTest(path=path):
                    self.assertEqual(self.call(path)[0], 404)

    def test_mutations_without_workbench_are_not_routes(self):
        for path in ('/api/arenas', '/api/suites', '/api/suites/cancel'):
            with self.subTest(path=path):
                status, _, _ = self.call(path, {'Origin': ORIGIN, 'Content-Type': 'application/json'},
                                         method='POST', body=b'{}')
                self.assertEqual(status, 405)


class WorkbenchRouteTests(GatewayCase):
    def attach(self):
        for patcher in (patch.object(wb, 'REFERENCE_ROOT', self.base / 'no-reference-checkout'),
                        patch.object(Workbench, 'capabilities', lambda _self: {'available': False})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.workbench = Workbench(self.catalog, self.base / 'data', worker_python=self.base / 'no-python')
        self.catalog.workbench = self.workbench

    def post(self, path, data, *, token=True, origin=ORIGIN, kind='application/json'):
        headers = {'Content-Type': kind}
        if token:
            headers['X-Studio-Token'] = self.workbench.token
        if origin:
            headers['Origin'] = origin
        status, _, body = self.call(path, headers, method='POST', body=json.dumps(data).encode())
        return status, json.loads(body)

    def test_new_mutation_routes_require_same_origin_token(self):
        arena = {'label': 'HTTP arena', 'boxes': [{'center_xy': [2, 0], 'half_xy': [.5, .5], 'z_bottom': 0, 'z_top': 1}],
                 'presets': [{'start_xy': [0, 0], 'goal_xy': [4, 0]}]}
        for path, body in (('/api/arenas', arena), ('/api/suites', {'scenario_ids': ['scenario-x']}),
                           ('/api/suites/cancel', {'id': 'suite-x'})):
            with self.subTest(path=path):
                self.assertEqual(self.post(path, body, token=False)[0], 403)
                self.assertEqual(self.post(path, body, origin=None)[0], 403)
                self.assertEqual(self.post(path, body, origin='http://attacker.invalid')[0], 403)
                self.assertEqual(self.post(path, body, kind='text/plain')[0], 415)
        self.assertEqual(list((self.base / 'data/maps').glob('arena-*')), [], 'Rejected requests must not save')
        status, saved = self.post('/api/arenas', arena)
        self.assertEqual(status, 201)
        self.assertRegex(saved['id'], r'^arena-[0-9a-f]{12}$')
        self.assertEqual(self.get_json(f"/api/map?id={saved['id']}")['presets'], saved['presets'])
        blocked = dict(arena, presets=[{'start_xy': [0, 0], 'goal_xy': [2, 0]}])
        self.assertEqual(self.post('/api/arenas', blocked)[0], 422)
        self.assertEqual(self.post('/api/suites', {'scenario_ids': ['scenario-x']})[0], 404)
        self.assertEqual(self.post('/api/suites', {'scenario_ids': []})[0], 422)
        self.assertEqual(self.post('/api/suites/cancel', {'id': 'suite-x'})[0], 404)
        for path in ('/api/suites/start', '/api/arenas/delete', '/api/robot', '/api/lowcmd'):
            with self.subTest(path=path):
                self.assertEqual(self.post(path, {})[0], 405)

    # Regression (fixed 2026-10-20): studio/server.py Handler.do_POST catches only KeyError/ValueError/OSError. A JSON list or
    # object where an id/criterion string is expected raises TypeError inside the workbench
    # (unhashable membership test), the handler thread dies, and the client gets no HTTP response
    # (http.client.RemoteDisconnected) instead of a 4xx.
    def test_malformed_identifier_types_get_an_http_error_response(self):
        quiet = patch.object(self.server, 'handle_error', lambda *args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        scenario = {'backend_id': 'flow-sonic-cpu', 'map_id': 'flat-ground', 'goal_xy': [1, 0]}
        cases = [('/api/scenarios', dict(scenario, criterion=[])), ('/api/scenarios', dict(scenario, map_id=[])),
                 ('/api/arenas', {'label': 'a', 'boxes': [], 'base_map_id': []}),
                 ('/api/suites', {'scenario_ids': [['scenario-x']]}), ('/api/suites/cancel', {'id': ['suite-x']}),
                 ('/api/jobs', {'scenario_id': {}}), ('/api/jobs/cancel', {'id': []})]
        for path, body in cases:
            with self.subTest(path=path, body=body):
                self.assertIn(self.post(path, body)[0], (404, 422))

    def test_suite_runs_and_job_read_routes(self):
        self.assertEqual(self.get_json('/api/suites'), {'suites': []})
        self.assertEqual(self.call('/api/suites?id=suite-x')[0], 404)
        self.assertEqual(self.get_json('/api/runs')['runs'], [])
        output = self.base / 'data/jobs/job-live00000000'
        (output / 'run').mkdir(parents=True)
        self.workbench.jobs['job-live00000000'] = {
            'id': 'job-live00000000', 'status': 'running', 'output': output, 'process': None, 'error': None,
            'result_session_id': None,
            'latest': {'frame': {'time': 1.0}, 'metadata': {'heavy': True},
                       'perception': {'time': .5, 'support_observed_indices': [1], 'support_points': []}}}
        light = self.get_json('/api/jobs?id=job-live00000000&light=1&perception_after=0.25')['latest']
        self.assertTrue(light['light'])
        self.assertNotIn('metadata', light)
        self.assertEqual(light['perception'], {'time': .5, 'support_points': []})
        newer = self.get_json('/api/jobs?id=job-live00000000&light=1&perception_after=0.5')['latest']
        self.assertNotIn('perception', newer)
        first = self.get_json('/api/jobs?id=job-live00000000&light=1&perception_after=-Infinity')['latest']
        self.assertIn('perception', first)
        self.assertEqual(self.call('/api/jobs?id=job-live00000000&light=1&perception_after=soon')[0], 422)
        self.assertEqual(self.call('/api/jobs?id=job-unknown')[0], 404)
        full = self.get_json('/api/jobs?id=job-live00000000')['latest']
        self.assertEqual(full['metadata'], {'heavy': True})


class L3DiscoveryTests(unittest.TestCase):
    """Runs written by tools/l3_rehearsal.sh appear as sessions; nothing is launched."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        config = base / 'sessions.json'
        config.write_text(json.dumps({'sessions': []}))
        self.catalog = Catalog(config)
        self.l3 = base / 'l3'
        run = self.l3 / 'l3-clutter-r1-a'
        (run / 'rehearse').mkdir(parents=True)
        (run / 'rehearse/sim.npz').write_bytes(b'')
        (run / 'rehearse/boxes.json').write_text('[]')
        (run / 'capture.jsonl').write_text('')
        (run / 'l3_provenance.json').write_text(json.dumps({'dds_domain': 0, 'isolation': 'user+net+pid+mount namespace, lo only'}))
        (run / 't0').write_text('')
        (self.l3 / 'incomplete-run').mkdir()  # no recording yet: not listed
        self.catalog.l3_base = self.l3

    def test_completed_runs_and_wire_captures_are_registered_once(self):
        self.catalog.discover_l3(force=True)
        self.catalog.discover_l3(force=True)
        rows = {r['id']: r for r in self.catalog.listing()['sessions']}
        self.assertEqual(sorted(rows), ['l3-l3-clutter-r1-a', 'l3-l3-clutter-r1-a-wire'])
        self.assertTrue(all(r['group'] == server_module.L3_GROUP and r['available'] for r in rows.values()))
        entry = self.catalog.entries['l3-l3-clutter-r1-a']
        self.assertTrue(entry['environment_path'].endswith('rehearse/boxes.json'))
        self.assertTrue(entry['l3_provenance'].endswith('l3_provenance.json'))

    def test_rescans_are_throttled(self):
        self.catalog.discover_l3(force=True)
        late = self.l3 / 'late-run/rehearse'; late.mkdir(parents=True); (late / 'sim.npz').write_bytes(b'')
        self.catalog.discover_l3()
        self.assertNotIn('l3-late-run', self.catalog.entries)
        self.catalog.discover_l3(force=True)
        self.assertIn('l3-late-run', self.catalog.entries)

    def test_mark_l3_labels_fidelity_and_replaces_the_historical_caveat(self):
        data = {'metadata': {'limitations': ['Historical simulator configuration used loopback, but did not record a nonzero DDS domain.', 'other']}}
        server_module.mark_l3(data, self.l3 / 'l3-clutter-r1-a/l3_provenance.json')
        m = data['metadata']
        self.assertEqual(m['fidelity'], 'L3')
        self.assertEqual(m['l3_provenance']['dds_domain'], 0)
        self.assertTrue(m['limitations'][0].startswith('Recorded by tools/l3_rehearsal.sh'))
        self.assertNotIn('Historical simulator configuration', ' '.join(m['limitations']))
        self.assertIn('other', m['limitations'])

    def test_mark_l3_exposes_the_simulator_actuator_limits(self):
        prov = self.l3 / 'l3-clutter-r1-a/l3_provenance.json'
        prov.write_text(json.dumps({'dds_domain': 0, 'actuator_limits': {'hip_pitch_nm': 88, 'hip_roll_nm': 88, 'hip_yaw_nm': 88, 'source': 'yaml'}}))
        data = {'metadata': {'limitations': []}}
        server_module.mark_l3(data, prov)
        acts = data['metadata']['actuators']
        self.assertEqual(acts['profile'], 'source')
        self.assertEqual(acts['hips']['left_hip_roll_joint']['after_nm'], 88)


class EmptyCatalogTests(GatewayCase):
    def attach(self):
        self.catalog.entries.clear()  # a valid {"sessions": []} configuration, as in a fresh Studio

    # Regression (fixed 2026-10-20): studio/server.py:411 and :424 evaluate the default `next(iter(catalog.entries))` eagerly,
    # even when ?id=/?session= is supplied. With an empty catalog this raises StopIteration, which
    # do_GET does not catch, so the client gets no HTTP response instead of 404.
    def test_explicit_unknown_session_on_empty_catalog_is_404(self):
        quiet = patch.object(self.server, 'handle_error', lambda *args: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        for path in ('/api/session?id=job-x', '/api/sensors?session=job-x&time=0', '/api/model?id=job-x'):
            with self.subTest(path=path):
                self.assertEqual(self.call(path)[0], 404)

    def test_listing_still_works_on_empty_catalog(self):
        self.assertEqual(self.get_json('/api/sessions')['sessions'], [])


class CatalogCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        config = self.base / 'sessions.json'
        config.write_text(json.dumps({'sessions': [{'id': f's{i}', 'path': str(self.base / f's{i}.json')}
                                                   for i in range(6)]}))
        self.catalog = Catalog(config)
        self.calls = []
        self.lock = threading.Lock()

    def counting_decode(self, delay=0.0, hook=None):
        def decode(_catalog, key, item):
            with self.lock:
                self.calls.append(key)
            if hook:
                hook(key)
            time.sleep(delay)
            return {'schema_version': 1, 'metadata': {'key': key}, 'frames': [{'time': 0}]}
        return decode

    def test_concurrent_requests_for_one_key_decode_once(self):
        barrier = threading.Barrier(4)
        results, errors = [], []

        def fetch():
            try:
                barrier.wait(timeout=5)
                results.append(self.catalog.entry('s0'))
            except Exception as error:  # surfaced below
                errors.append(error)
        with patch.object(Catalog, '_decode', self.counting_decode(delay=.2)):
            threads = [threading.Thread(target=fetch) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
        self.assertEqual(errors, [])
        self.assertEqual(self.calls, ['s0'])
        self.assertEqual(len(results), 4)
        self.assertTrue(all(result is results[0] for result in results), 'Waiters share the single decode')
        self.assertEqual(self.catalog._loading, {})
        self.assertEqual(results[0][0]['metadata']['catalog_id'], 's0')

    def test_different_keys_decode_concurrently(self):
        started = {key: threading.Event() for key in ('s0', 's1')}
        overlapped = []

        def hook(key):
            started[key].set()
            other = 's1' if key == 's0' else 's0'
            overlapped.append(started[other].wait(timeout=3))
        with patch.object(Catalog, '_decode', self.counting_decode(hook=hook)):
            threads = [threading.Thread(target=self.catalog.entry, args=(key,)) for key in ('s0', 's1')]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
        self.assertEqual(overlapped, [True, True], 'One slow decode must not serialize other sessions')

    def test_cache_eviction_respects_entry_limit_and_recency(self):
        with patch.object(server_module, 'CACHE_ENTRIES', 2), \
                patch.object(Catalog, '_decode', self.counting_decode()):
            for key in ('s0', 's1', 's2'):
                self.catalog.entry(key)
            self.assertEqual(list(self.catalog.cache), ['s1', 's2'])
            self.catalog.entry('s1')  # cache hit refreshes recency
            self.catalog.entry('s3')
            self.assertEqual(list(self.catalog.cache), ['s1', 's3'])
            self.assertEqual(self.calls, ['s0', 's1', 's2', 's3'])
            self.catalog.entry('s0')
            self.assertEqual(self.calls[-1], 's0', 'Evicted entries decode again')
            self.assertLessEqual(len(self.catalog.cache), 2)

    def test_cache_budget_keeps_only_most_recent_entry(self):
        with patch.object(server_module, 'CACHE_BUDGET_BYTES', 1), \
                patch.object(Catalog, '_decode', self.counting_decode()):
            for key in ('s0', 's1', 's2'):
                self.catalog.entry(key)
            self.assertEqual(list(self.catalog.cache), ['s2'])

    def test_failed_decode_is_not_cached_and_can_retry(self):
        attempts = []

        def flaky(_catalog, key, item):
            attempts.append(key)
            if len(attempts) == 1:
                raise ValueError('transient decode failure')
            return {'schema_version': 1, 'metadata': {}, 'frames': [{'time': 0}]}
        with patch.object(Catalog, '_decode', flaky):
            with self.assertRaisesRegex(ValueError, 'transient'):
                self.catalog.entry('s0')
            self.assertNotIn('s0', self.catalog.cache)
            data, encoded = self.catalog.entry('s0')
        self.assertEqual(attempts, ['s0', 's0'])
        self.assertEqual(data['metadata']['catalog_id'], 's0')

    def test_reregistering_a_key_drops_its_cached_decode(self):
        with patch.object(Catalog, '_decode', self.counting_decode()):
            first = self.catalog.entry('s0')
            self.catalog.register('s0', self.base / 'replaced.json', 'Replaced')
            self.assertNotIn('s0', self.catalog.cache)
            self.assertIsNot(self.catalog.entry('s0'), first)
        self.assertEqual(self.calls, ['s0', 's0'])


if __name__ == '__main__':
    unittest.main()
