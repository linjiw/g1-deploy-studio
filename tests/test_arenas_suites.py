"""Arena maps, policy-aware preparation, sequential suites and the runs table.

Workers are faked by a tiny real child process (this test interpreter running an
inline script that writes receipts), never the policy interpreter and never
studio/*policy_worker.py. Policy profiles are synthetic, so no reference
checkpoint is hashed and no reference Git checkout is queried. All data roots
are temporary directories.
"""
import copy
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from studio import policies
from studio import workbench as wb
from studio.workbench import Workbench, _ms, atomic_json, point_status

DEPLOY_ID = 'flow-bundle-20261008'
FLOW_ID = 'flow-wx-rf-abcdef0-s1'
REAL_POPEN = subprocess.Popen

# Writes the same receipt files the real worker writes; no policy, physics or IO beyond run/.
FAKE_WORKER = r'''
import json, pathlib, sys, time
run, mode, outcome = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
def put(name, value):
    tmp = run / (name + '.partial')
    tmp.write_text(json.dumps(value))
    tmp.replace(run / name)
run.mkdir()
put('latest.json', {'schema_version': 1, 'status': 'running', 'frame': {'time': 0.0}})
if mode == 'hang':
    time.sleep(60)
time.sleep(0.3)
with (run / 'progress.jsonl').open('w') as f:
    for i in range(400):
        f.write(json.dumps({'time': i * 0.02, 'qpos': [i * 0.001, -i * 0.0005, 0.79]}) + '\n')
put('session.json', {'schema_version': 1, 'metadata': {'fixture': True}, 'frames': [{'time': 0.0}]})
if mode == 'fail':
    put('result.json', {'schema_version': 1, 'status': 'failed', 'error': 'fake worker failure', 'wall_time_s': 0.3})
    sys.exit(3)
put('result.json', {'schema_version': 1, 'status': 'completed', 'wall_time_s': 0.3,
                    'report': {'outcome': outcome, 'elapsed_s': 7.98, 'final_goal_distance_xy_m': 0.12,
                               'plan_latency_s': {'p50': 0.0125, 'p95': 0.05}}})
'''


def deploy_profile(**overrides):
    profile = {'id': DEPLOY_ID, 'label': 'Synthetic deploy bundle', 'family': 'flow', 'research_block': None,
               'loader': 'deploy-bundle',
               'planner': {'name': 'fixture', 'deployed_budget': {'candidates': 16, 'ode_steps': 10}},
               'artifacts': [], 'repositories': [],
               'limits': {'candidates': [1, 16], 'ode_steps': [1, 10], 'duration_s': [1, 10], 'wall_s': 180},
               'limitations': ['Synthetic deploy profile limitation.']}
    profile.update(overrides)
    return profile


def flow_profile(**overrides):
    profile = {'id': FLOW_ID, 'label': 'Synthetic WX-RF bundle', 'family': 'flow', 'research_block': 'WX',
               'loader': 'flow-callback', 'bundle_id': FLOW_ID, 'config_sha256': 'c' * 64, 'revision': 'abcdef0',
               'planner': {'name': 'wx-rf', 'deployed_budget': {'candidates': 8, 'ode_steps': 6}},
               'artifacts': [], 'repositories': [], 'available': True, 'missing': [],
               'limits': {'candidates': [1, 8], 'ode_steps': [1, 6], 'duration_s': [1, 10], 'wall_s': 480},
               'limitations': ['Synthetic privileged-map limitation.']}
    profile.update(overrides)
    return profile


class FakeCatalog:
    def __init__(self):
        self.entries, self.providers = {}, {}

    def session(self, key):
        raise KeyError(key)

    def register(self, key, path, label, provider=None, extra=None):
        self.entries[key] = {'path': str(path), 'label': label, **(extra or {})}
        if provider:
            self.providers[key] = provider
        else:
            self.providers.pop(key, None)


class SubprocessProxy:
    """Only the workbench module sees the fake Popen; everything else is real."""

    def __init__(self, popen):
        self.Popen = popen

    def __getattr__(self, name):
        return getattr(subprocess, name)


def scenario_request(**overrides):
    request = {'backend_id': 'flow-sonic-cpu', 'map_id': 'flat-ground', 'label': 'Fixture rehearsal',
               'duration_s': 2, 'start_xy': [0, 0], 'goal_xy': [1, 0], 'start_yaw_rad': 0, 'seed': 0,
               'planner': {'candidates': 2, 'ode_steps': 4}}
    request.update(overrides)
    return request


WALL = {'center_xy': [2.0, 0.0], 'half_xy': [0.5, 0.5], 'z_bottom': 0.0, 'z_top': 1.0}


def arena_document(**overrides):
    document = {'label': 'Wall arena', 'boxes': [dict(WALL)], 'description': 'One wall in front of the start',
                'presets': [{'label': 'Around the wall', 'start_xy': [0, 0], 'goal_xy': [4, 0]},
                            {'label': 'Left lane', 'start_xy': [0, 1], 'start_yaw_rad': 0.5, 'goal_xy': [3.5, 1.5]}]}
    document.update(overrides)
    return document


class WorkbenchCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'data'
        self.builders = [lambda: deploy_profile(), lambda: [flow_profile()]]
        for patcher in (patch.object(wb, 'REFERENCE_ROOT', self.base / 'no-reference-checkout'),
                        patch.object(policies, 'PROFILE_BUILDERS', self.builders)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.catalog = FakeCatalog()
        self.w = self.make()

    def make(self):
        return Workbench(self.catalog, self.root, worker_python=sys.executable)

    def wait_for(self, predicate, timeout=15, message='condition'):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(.02)
        self.fail(f'Timed out waiting for {message}')


class ArenaTests(WorkbenchCase):
    def test_save_creates_new_immutable_arena_maps_with_presets(self):
        first = self.w.save_arena(arena_document())
        self.assertRegex(first['id'], r'^arena-[0-9a-f]{12}$')
        path = self.root / 'maps' / f"{first['id']}.json"
        self.assertTrue(path.is_file())
        saved_bytes = path.read_bytes()
        self.assertEqual(first['kind'], 'boxes')
        self.assertTrue(first['runnable'])
        self.assertEqual(first['classification'], 'configured_simulation_geometry')
        self.assertEqual(first['origin'], 'arena-editor')
        self.assertEqual(first['description'], 'One wall in front of the start')
        self.assertIsNone(first['provenance']['base_map_id'])
        self.assertEqual(first['presets'], [
            {'label': 'Around the wall', 'start_xy': [0.0, 0.0], 'start_yaw_rad': 0.0, 'goal_xy': [4.0, 0.0]},
            {'label': 'Left lane', 'start_xy': [0.0, 1.0], 'start_yaw_rad': 0.5, 'goal_xy': [3.5, 1.5]}])
        self.assertEqual(first['boxes'], [dict(WALL, yaw=0.0)])
        # Saving the same layout again never overwrites: a second immutable map appears.
        second = self.w.save_arena(arena_document())
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(first['sha256'], second['sha256'], 'Geometry hash depends only on geometry')
        self.assertEqual(path.read_bytes(), saved_bytes)
        self.assertEqual(len(list((self.root / 'maps').glob('arena-*.json'))), 2)
        # Returned/served maps are copies; callers cannot mutate the stored arena.
        served = self.w.map(first['id'])
        served['presets'].clear()
        self.assertEqual(len(self.w.map(first['id'])['presets']), 2)
        # The arena is a normal runnable map for preparation.
        prepared = self.w.prepare(scenario_request(map_id=first['id'], goal_xy=[4, 0]))
        self.assertTrue(prepared['validation']['valid'], prepared['validation'])
        self.assertEqual(prepared['map_sha256'], first['sha256'])
        blocked = self.w.prepare(scenario_request(map_id=first['id'], goal_xy=[2, 0]))
        self.assertFalse(blocked['validation']['valid'])

    def test_unnamed_preset_gets_ordinal_label_and_base_map_is_recorded(self):
        arena = self.w.save_arena(arena_document(base_map_id='flat-ground',
                                                 presets=[{'start_xy': [0, 0], 'goal_xy': [4, 0]}]))
        self.assertEqual(arena['presets'][0]['label'], 'Preset 1')
        self.assertEqual(arena['provenance']['base_map_id'], 'flat-ground')
        self.assertEqual(arena['provenance']['base_map_sha256'], self.w.map('flat-ground')['sha256'])
        with self.assertRaisesRegex(ValueError, 'Unknown base map'):
            self.w.save_arena(arena_document(base_map_id='map-does-not-exist'))

    def test_presets_inside_box_footprint_clearance_are_rejected(self):
        # Box spans x in [1.5, 2.5]; the standing-footprint clearance is 0.25 m.
        self.assertEqual(point_status(self.w.save_arena(arena_document(presets=[])), [2.74, 0])['status'], 'blocked')
        cases = {'goal in box': {'start_xy': [0, 0], 'goal_xy': [2, 0]},
                 'goal in clearance margin': {'start_xy': [0, 0], 'goal_xy': [2.74, 0]},
                 'start in clearance margin': {'start_xy': [1.26, 0], 'goal_xy': [0, 0]},
                 'goal outside bounds': {'start_xy': [0, 0], 'goal_xy': [40, 0]}}
        for name, preset in cases.items():
            with self.subTest(name), self.assertRaisesRegex(ValueError, 'Blocked preset'):
                self.w.save_arena(arena_document(presets=[dict(preset, label='Blocked preset')]))
        accepted = self.w.save_arena(arena_document(presets=[{'start_xy': [0, 0], 'goal_xy': [2.76, 0]}]))
        self.assertEqual(accepted['presets'][0]['goal_xy'], [2.76, 0.0])

    def test_start_and_goal_must_be_separated(self):
        with self.assertRaisesRegex(ValueError, 'at least 0.2 m apart'):
            self.w.save_arena(arena_document(presets=[{'start_xy': [0, 0], 'goal_xy': [0.19, 0]}]))
        self.assertEqual(len(self.w.save_arena(arena_document(
            presets=[{'start_xy': [0, 0], 'goal_xy': [0.21, 0]}]))['presets']), 1)

    def test_preset_and_box_count_limits(self):
        presets = [{'start_xy': [0, 0], 'goal_xy': [1, 0.1 * i]} for i in range(wb.MAX_PRESETS)]
        self.assertEqual(len(self.w.save_arena(arena_document(presets=presets))['presets']), 16)
        with self.assertRaisesRegex(ValueError, 'at most 16'):
            self.w.save_arena(arena_document(presets=presets + [{'start_xy': [0, 0], 'goal_xy': [1, 0]}]))
        boxes = [{'center_xy': [5 + (i % 16) * .3, 5 + (i // 16) * .3], 'half_xy': [.05, .05],
                  'z_bottom': 0, 'z_top': .5} for i in range(wb.MAX_BOXES)]
        self.assertEqual(len(self.w.save_arena(arena_document(boxes=boxes))['boxes']), 128)
        with self.assertRaisesRegex(ValueError, 'at most 128 boxes'):
            self.w.save_arena(arena_document(boxes=boxes + [dict(WALL)]))

    def test_rejects_non_box_arenas_and_bad_fields_without_persisting(self):
        bad = {'not an object': ['boxes'],
               'scan kind': arena_document(kind='scan'),
               'description too long': arena_document(description='x' * 501),
               'description not text': arena_document(description=123),
               'presets not a list': arena_document(presets={'label': 'x'}),
               'preset not an object': arena_document(presets=['start']),
               'preset without goal': arena_document(presets=[{'start_xy': [0, 0]}]),
               'boxes missing': arena_document(boxes=None),
               'empty label': arena_document(label='  ')}
        for name, document in bad.items():
            with self.subTest(name), self.assertRaises(ValueError):
                self.w.save_arena(document)
        self.assertEqual(list((self.root / 'maps').glob('arena-*')), [])
        self.assertFalse(any(key.startswith('arena-') for key in self.w.maps))
        self.assertEqual(len(self.w.save_arena(arena_document(description='x' * 500))['description']), 500)

    def test_arena_count_limit(self):
        with patch.object(wb, 'MAX_ARENAS', 2):
            self.w.save_arena(arena_document())
            self.w.save_arena(arena_document())
            with self.assertRaisesRegex(ValueError, 'Arena limit reached'):
                self.w.save_arena(arena_document())
        self.assertEqual(len(list((self.root / 'maps').glob('arena-*.json'))), 2)

    def test_reload_restores_arenas_with_presets_and_hash(self):
        saved = self.w.save_arena(arena_document())
        reopened = self.make()
        restored = reopened.map(saved['id'])
        for field in ('presets', 'description', 'boxes', 'bounds', 'sha256', 'origin', 'kind', 'runnable'):
            self.assertEqual(restored[field], saved[field], field)
        self.assertEqual(restored['provenance']['source'], 'Studio arena editor')
        self.assertEqual(reopened.map_warnings, [])
        # A scenario prepared against the restored arena pins the same geometry hash.
        self.assertEqual(reopened.prepare(scenario_request(map_id=saved['id'], goal_xy=[4, 0]))['map_sha256'],
                         saved['sha256'])

    def test_corrupted_or_tampered_arena_is_hidden_with_warning(self):
        good = self.w.save_arena(arena_document())
        tampered = self.w.save_arena(arena_document())
        maps = self.root / 'maps'
        (maps / 'arena-corrupt0000.json').write_text('{"label": "half written', encoding='utf-8')
        data = json.loads((maps / f"{tampered['id']}.json").read_text())
        data['presets'][0]['goal_xy'] = [2.0, 0.0]  # now inside the wall
        (maps / f"{tampered['id']}.json").write_text(json.dumps(data))
        reopened = self.make()
        self.assertIn(good['id'], reopened.maps)
        self.assertNotIn(tampered['id'], reopened.maps)
        self.assertNotIn('arena-corrupt0000', reopened.maps)
        warnings = ' | '.join(reopened.map_warnings)
        self.assertEqual(len(reopened.map_warnings), 2, reopened.map_warnings)
        self.assertIn(tampered['id'], warnings)
        self.assertIn('arena-corrupt0000', warnings)
        with self.assertRaises(KeyError):
            reopened.map(tampered['id'])

    # Regression (fixed 2026-10-20): studio/workbench.py:325 slices sorted('arena-*.json')[:MAX_ARENAS] *before* validation,
    # so hidden (corrupt) files consume reload slots. save_arena's limit counts only loaded arenas,
    # so a valid saved arena can silently vanish on restart with no map_warnings entry.
    def test_hidden_arena_files_do_not_silently_drop_valid_arenas(self):
        with patch.object(wb, 'MAX_ARENAS', 2):
            valid = [self.w.save_arena(arena_document())['id'] for _ in range(2)]
            (self.root / 'maps' / ('arena-' + '0' * 12 + '.json')).write_text('{"corrupt": ')  # sorts first
            reopened = self.make()
        warnings = ' '.join(reopened.map_warnings)
        for key in valid:
            with self.subTest(arena=key):
                self.assertTrue(key in reopened.maps or key in warnings,
                                f'{key} was neither loaded nor reported: {reopened.map_warnings}')


class PolicyPreparationTests(WorkbenchCase):
    def test_actuator_profile_defaults_to_current_g1_and_is_validated(self):
        self.assertEqual(self.w.prepare(scenario_request())['actuators'], 'g1-current')
        self.assertEqual(self.w.prepare(scenario_request(actuators='g1-rev1'))['actuators'], 'g1-rev1')
        for bad in ('mode15', 88, ['source']):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.w.prepare(scenario_request(actuators=bad))

    def test_default_policy_and_criterion(self):
        scenario = self.w.prepare(scenario_request())
        self.assertEqual(scenario['policy_id'], DEPLOY_ID)
        self.assertEqual(wb.DEFAULT_POLICY_ID, DEPLOY_ID)
        self.assertEqual(scenario['criterion'], 'arrive_hold')
        self.assertTrue(scenario['validation']['valid'])
        self.assertIn('Synthetic deploy profile limitation.', scenario['validation']['warnings'])

    def test_explicit_policy_profile_and_deployed_budget_warning(self):
        scenario = self.w.prepare(scenario_request(policy_id=FLOW_ID, planner={'candidates': 8, 'ode_steps': 6}))
        self.assertEqual(scenario['policy_id'], FLOW_ID)
        warnings = ' '.join(scenario['validation']['warnings'])
        self.assertIn('Synthetic privileged-map limitation.', warnings)
        self.assertNotIn('differ from deployed budget', warnings)
        reduced = self.w.prepare(scenario_request(policy_id=FLOW_ID))
        self.assertIn('differ from deployed budget of this policy profile (8 candidates / 6 ODE steps)',
                      ' '.join(reduced['validation']['warnings']))

    def test_unknown_or_malformed_policy_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unknown policy profile'):
            self.w.prepare(scenario_request(policy_id='flow-wx-rf-0000000-s0'))
        for value in (5, None, ['flow-bundle-20261008'], {'id': DEPLOY_ID}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'policy_id must be a string'):
                self.w.prepare(scenario_request(policy_id=value))

    def test_criterion_must_be_known(self):
        from studio.policy_worker import CRITERIA
        self.assertEqual(sorted(CRITERIA), ['arena_reach', 'arrive_hold'])
        self.assertEqual(self.w.prepare(scenario_request(criterion='arena_reach'))['criterion'], 'arena_reach')
        for value in ('bogus', None, 'ARRIVE_HOLD', 1):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'Success criterion'):
                self.w.prepare(scenario_request(criterion=value))

    def test_planner_limits_follow_selected_profile(self):
        flow = dict(policy_id=FLOW_ID)
        self.assertEqual(self.w.prepare(scenario_request(planner={'candidates': 8, 'ode_steps': 6}, **flow))['planner'],
                         {'candidates': 8, 'ode_steps': 6})
        for planner in ({'candidates': 9, 'ode_steps': 4}, {'candidates': 2, 'ode_steps': 7}):
            with self.subTest(planner=planner), self.assertRaises(ValueError):
                self.w.prepare(scenario_request(planner=planner, **flow))
        self.assertEqual(self.w.prepare(scenario_request(planner={'candidates': 16, 'ode_steps': 10}))['planner'],
                         {'candidates': 16, 'ode_steps': 10})
        with self.assertRaises(ValueError):
            self.w.prepare(scenario_request(planner={'candidates': 17, 'ode_steps': 4}))

    # Regression (fixed 2026-10-20): membership tests on raw JSON values raise TypeError (unhashable) instead of a validation
    # error: studio/workbench.py Workbench._criterion (`value not in CRITERIA`), Workbench.map
    # (`key not in self.maps`), save_arena (`base not in self.maps`), start_suite
    # (`scenario_id not in self.scenarios`), start_job, cancel_suite and cancel_job. The HTTP POST
    # handler catches only KeyError/ValueError/OSError, so these drop the connection (see
    # tests/test_server_delivery.py).
    def test_unhashable_identifiers_are_rejected_as_invalid_input(self):
        calls = {'criterion': lambda: self.w.prepare(scenario_request(criterion=['arrive_hold'])),
                 'map_id': lambda: self.w.prepare(scenario_request(map_id=['flat-ground'])),
                 'base_map_id': lambda: self.w.save_arena(arena_document(base_map_id=['flat-ground'])),
                 'scenario_ids': lambda: self.w.start_suite({'scenario_ids': [['scenario-x']]}),
                 'job scenario': lambda: self.w.start_job({'id': 'scenario-x'}),
                 'cancel suite': lambda: self.w.cancel_suite(['suite-x']),
                 'cancel job': lambda: self.w.cancel_job({'id': 'job-x'})}
        for name, call in calls.items():
            with self.subTest(name), self.assertRaises((ValueError, KeyError)):
                call()

    def test_saved_scenario_persists_policy_and_criterion(self):
        saved = self.w.save_scenario(scenario_request(policy_id=FLOW_ID, criterion='arena_reach'))['scenario']
        reopened = self.make()
        restored = reopened.scenarios[saved['id']]
        self.assertEqual((restored['policy_id'], restored['criterion']), (FLOW_ID, 'arena_reach'))


class WorkerCase(WorkbenchCase):
    """Jobs launched through a fake Popen that starts a harmless receipt-writing child."""

    def setUp(self):
        super().setUp()
        self.launches, self.children, self.modes = [], [], []
        for patcher in (patch.object(wb, 'subprocess', SubprocessProxy(self.stub_popen)),
                        patch.object(Workbench, 'capabilities', lambda _self: {'available': True})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.stop_workers)

    def stub_popen(self, args, **kwargs):
        self.launches.append((list(args), dict(kwargs)))
        mode, outcome = self.modes.pop(0) if self.modes else ('complete', 'reached')
        run = args[args.index('--output') + 1]
        child = REAL_POPEN([sys.executable, '-I', '-c', FAKE_WORKER, run, mode, str(outcome)], **kwargs)
        self.children.append(child)
        return child

    def stop_workers(self):
        with self.w.lock:
            for suite in self.w.suites.values():
                if suite['status'] in wb.SUITE_ACTIVE:
                    suite['status'] = 'cancelling'
        for child in self.children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child.wait(timeout=5)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with self.w.lock:
                busy = (any(s['status'] in wb.SUITE_ACTIVE for s in self.w.suites.values())
                        or any('_lease_fd' in j or (j.get('process') and j['status'] in wb.ACTIVE_STATES)
                               for j in self.w.jobs.values()))
            if not busy and not self.w._lease_held():
                return
            time.sleep(.05)

    def scenario(self, **overrides):
        return self.w.save_scenario(scenario_request(**overrides))['scenario']['id']

    def wait_job(self, key):
        return self.wait_for(lambda: (lambda j: j if j['status'] in wb.TERMINAL_STATES
                                      and '_lease_fd' not in self.w.jobs[key] else None)(self.w.job(key)),
                             message=f'job {key} to finish')

    def wait_suite(self, key):
        return self.wait_for(lambda: (lambda s: s if s['status'] not in wb.SUITE_ACTIVE else None)(self.w.suite(key)),
                             timeout=30, message=f'suite {key} to finish')


class JobLaunchTests(WorkerCase):
    def test_worker_script_follows_profile_loader_and_wall_limit_is_per_profile(self):
        cases = [(DEPLOY_ID, 'policy_worker.py', 180.0, {}),
                 (FLOW_ID, 'flow_policy_worker.py', 480.0, {'bundle_id': FLOW_ID})]
        for policy_id, script, wall, extra in cases:
            with self.subTest(policy_id=policy_id):
                job = self.w.start_job(self.scenario(policy_id=policy_id))
                args, kwargs = self.launches[-1]
                output = self.root / 'jobs' / job['id']
                self.assertEqual(args, [sys.executable, '-u', str(wb.ROOT / 'studio' / script),
                                        '--request', str(output / 'request.json'), '--output', str(output / 'run')])
                self.assertTrue(kwargs['start_new_session'])
                self.assertEqual(len(kwargs['pass_fds']), 1)
                self.assertEqual(kwargs['env']['CUDA_VISIBLE_DEVICES'], '')
                self.assertEqual(self.w.jobs[job['id']]['wall_limit_s'], wall)
                request = json.loads((output / 'request.json').read_text())
                loader = 'flow-callback' if extra else 'deploy-bundle'
                self.assertEqual({k: request['policy'][k] for k in ('id', 'loader')}, {'id': policy_id, 'loader': loader})
                self.assertEqual(request['policy'].get('bundle_id'), extra.get('bundle_id'))
                self.assertEqual(len(request['policy']['identity_sha256']), 64)
                for hidden in ('validation', 'label', 'backend_id', 'map_id', 'map_sha256', 'frame_id', 'policy_id'):
                    self.assertNotIn(hidden, request)
                self.assertEqual(request['map']['kind'], 'boxes')
                self.assertEqual(request['criterion'], 'arrive_hold')
                final = self.wait_job(job['id'])
                self.assertEqual(final['status'], 'completed')
                self.assertEqual(final['policy_id'], policy_id)
                self.assertEqual(final['result_session_id'], job['id'])

    def test_profile_wall_limit_terminates_hanging_worker(self):
        self.builders[0] = lambda: deploy_profile(limits={'candidates': [1, 16], 'ode_steps': [1, 10], 'wall_s': 0.6})
        self.modes.append(('hang', 'none'))
        job = self.w.start_job(self.scenario())
        self.assertEqual(self.w.jobs[job['id']]['wall_limit_s'], 0.6)
        final = self.wait_job(job['id'])
        self.assertEqual(final['status'], 'failed')
        self.assertIn('wall-time', final['error'])
        self.assertIsNotNone(self.children[-1].poll(), 'Hanging owned child must be terminated')
        # The monitor closes its descriptor right after popping it; allow that close to land.
        self.wait_for(lambda: not self.w._lease_held(), timeout=5, message='worker lease release')

    def test_unavailable_profile_cannot_launch(self):
        self.builders[1] = lambda: [flow_profile(available=False, missing=['bundle verification pending'])]
        scenario = self.scenario(policy_id=FLOW_ID)
        with self.assertRaisesRegex(ValueError, 'bundle verification pending'):
            self.w.start_job(scenario)
        self.assertEqual(self.launches, [])
        self.assertFalse(self.w._lease_held())


class SuiteTests(WorkerCase):
    def test_start_suite_validation(self):
        valid = self.scenario()
        invalid = self.scenario(label='Off-map goal', goal_xy=[6, 0])
        for document, error in [(['not', 'a', 'dict'], ValueError), ({}, ValueError),
                                ({'scenario_ids': valid}, ValueError), ({'scenario_ids': []}, ValueError),
                                ({'scenario_ids': [valid] * (wb.MAX_SUITE_RUNS + 1)}, ValueError),
                                ({'scenario_ids': [valid, 'scenario-unknown']}, KeyError),
                                ({'scenario_ids': [valid], 'label': ''}, ValueError)]:
            with self.subTest(document=document), self.assertRaises(error):
                self.w.start_suite(document)
        with self.assertRaisesRegex(ValueError, 'Off-map goal: Goal: Point is outside'):
            self.w.start_suite({'scenario_ids': [valid, invalid]})
        self.w.suites['suite-busy'] = {'id': 'suite-busy', 'status': 'running', 'runs': []}
        with self.assertRaisesRegex(ValueError, 'suite is already running'):
            self.w.start_suite({'scenario_ids': [valid]})
        del self.w.suites['suite-busy']
        self.w.jobs['job-busy'] = {'id': 'job-busy', 'status': 'running', 'output': self.root / 'jobs/job-busy'}
        with self.assertRaisesRegex(ValueError, 'simulation job is already active'):
            self.w.start_suite({'scenario_ids': [valid]})
        del self.w.jobs['job-busy']
        self.assertEqual(list((self.root / 'suites').iterdir()), [])
        self.assertEqual(self.w.suites, {})
        self.assertEqual(self.launches, [])
        with self.assertRaises(KeyError):
            self.w.suite('suite-unknown')
        with self.assertRaises(KeyError):
            self.w.cancel_suite('suite-unknown')

    def test_suite_runs_sequentially_with_status_transitions_and_outcomes(self):
        ids = [self.scenario(label=f'Goal {i}', goal_xy=[1 + i, 0]) for i in range(3)]
        self.modes.extend([('complete', 'reached'), ('fail', 'none'), ('complete', 'timeout')])
        with patch.object(wb.threading, 'Thread') as thread_class:
            suite = self.w.start_suite({'scenario_ids': ids, 'label': 'Three goals'})
        self.assertEqual(suite['status'], 'queued')
        self.assertRegex(suite['id'], r'^suite-[0-9a-f]{12}$')
        self.assertEqual([r['status'] for r in suite['runs']], ['queued'] * 3)
        self.assertEqual([r['label'] for r in suite['runs']], ['Goal 0', 'Goal 1', 'Goal 2'])
        self.assertEqual(json.loads((self.root / 'suites' / f"{suite['id']}.json").read_text())['status'], 'queued')
        launch = thread_class.call_args.kwargs
        self.assertTrue(launch['daemon'])
        threading.Thread(target=launch['target'], args=launch['args'], daemon=True).start()

        seen = []
        def observe():
            current = self.w.suite(suite['id'])
            if not seen or seen[-1] != current['status']:
                seen.append(current['status'])
            return current if current['status'] not in wb.SUITE_ACTIVE else None
        final = self.wait_for(observe, timeout=30, message='suite completion')
        # The first poll may land before the suite thread takes the lock.
        self.assertIn(seen, (['running', 'completed'], ['queued', 'running', 'completed']))
        self.assertIsNotNone(final['finished_unix_s'])
        self.assertEqual([r['status'] for r in final['runs']], ['completed', 'failed', 'completed'])
        self.assertEqual([r['outcome'] for r in final['runs']], ['reached', 'runtime_error', 'timeout'])
        self.assertEqual(final['runs'][1]['error'], 'fake worker failure')
        job_ids = [r['job_id'] for r in final['runs']]
        self.assertEqual(len(set(job_ids)), 3)
        self.assertEqual(len(self.launches), 3)
        jobs = [self.w.job(key) for key in job_ids]
        for job in jobs:
            self.assertEqual(job['suite_id'], suite['id'])
        for earlier, later in zip(jobs, jobs[1:]):
            self.assertGreaterEqual(later['started_unix_s'], earlier['finished_unix_s'], 'Suite runs must not overlap')
        self.assertEqual(json.loads((self.root / 'suites' / f"{suite['id']}.json").read_text()), final)
        self.assertEqual(self.w.list_suites()['suites'][0]['id'], suite['id'])
        rows = {row['id']: row for row in self.w.runs_table()['runs']}
        self.assertEqual(rows[job_ids[0]]['outcome'], 'reached')
        self.assertAlmostEqual(rows[job_ids[0]]['metrics']['planner_p50_ms'], 12.5)
        self.assertEqual(rows[job_ids[1]]['outcome'], 'runtime_error')
        self.assertTrue(all(rows[k]['suite_id'] == suite['id'] for k in job_ids))
        self.assertIn(job_ids[0], self.catalog.entries)
        self.assertNotIn(job_ids[0], self.catalog.providers, 'Finished run must not stay a live provider')

    def test_cancel_suite_terminates_current_run_and_skips_the_rest(self):
        ids = [self.scenario(label=f'Goal {i}', goal_xy=[1 + i, 0]) for i in range(3)]
        self.modes.append(('hang', 'none'))
        suite = self.w.start_suite({'scenario_ids': ids})
        self.wait_for(lambda: self.w.suite(suite['id'])['runs'][0]['status'] == 'running'
                      and self.w.job(self.w.suite(suite['id'])['runs'][0]['job_id'])['status'] == 'running',
                      message='first suite run to start')
        cancelling = self.w.cancel_suite(suite['id'])
        self.assertEqual(cancelling['status'], 'cancelling')
        final = self.wait_suite(suite['id'])
        self.assertEqual(final['status'], 'cancelled')
        self.assertEqual([r['status'] for r in final['runs']], ['cancelled', 'skipped', 'skipped'])
        self.assertEqual([r['job_id'] is None for r in final['runs']], [False, True, True])
        self.assertEqual(len(self.launches), 1, 'Skipped runs must not launch')
        self.assertIsNotNone(self.children[0].poll())
        self.assertEqual(self.w.job(final['runs'][0]['job_id'])['status'], 'cancelled')
        self.assertEqual(json.loads((self.root / 'suites' / f"{suite['id']}.json").read_text())['status'], 'cancelled')
        with self.assertRaisesRegex(ValueError, 'not running'):
            self.w.cancel_suite(suite['id'])

    # Regression (fixed 2026-10-20): cancel_suite accepts a 'queued' suite (studio/workbench.py:941), but _run_suite then sets
    # suite['status'] = 'running' unconditionally when its thread starts (workbench.py:891), erasing
    # the 'cancelling' request; every run is launched and the suite ends 'completed'.
    def test_cancel_while_queued_is_not_lost(self):
        ids = [self.scenario(label='Only goal')]
        with patch.object(wb.threading, 'Thread') as thread_class:
            suite = self.w.start_suite({'scenario_ids': ids})
        self.assertEqual(self.w.cancel_suite(suite['id'])['status'], 'cancelling')
        launch = thread_class.call_args.kwargs
        threading.Thread(target=launch['target'], args=launch['args'], daemon=True).start()
        final = self.wait_suite(suite['id'])
        self.assertEqual(final['status'], 'cancelled')
        self.assertEqual([r['status'] for r in final['runs']], ['skipped'])
        self.assertEqual(self.launches, [])

    def test_restart_marks_active_suites_interrupted(self):
        jobs = self.root / 'jobs'
        done = jobs / 'job-recovered000'
        (done / 'run').mkdir(parents=True)
        atomic_json(done / 'job.json', {'status': 'completed', 'suite_id': 'suite-aaaaaaaaaaaa'})
        atomic_json(done / 'run/session.json', {'schema_version': 1, 'frames': [{'time': 0}]})
        atomic_json(done / 'run/result.json', {'status': 'completed', 'report': {'outcome': 'reached'}})
        lost = jobs / 'job-recovered001'
        lost.mkdir()
        atomic_json(lost / 'job.json', {'status': 'running', 'suite_id': 'suite-aaaaaaaaaaaa'})

        def run(job_id, status):
            return {'scenario_id': 'scenario-x', 'label': 'x', 'job_id': job_id, 'status': status, 'outcome': None}
        suites = self.root / 'suites'
        atomic_json(suites / 'suite-aaaaaaaaaaaa.json', {
            'schema_version': 1, 'id': 'suite-aaaaaaaaaaaa', 'label': 'Interrupted', 'status': 'running',
            'created_unix_s': 1.0, 'finished_unix_s': None,
            'runs': [run('job-recovered000', 'running'), run('job-recovered001', 'running'), run(None, 'queued')]})
        atomic_json(suites / 'suite-bbbbbbbbbbbb.json', {
            'schema_version': 1, 'id': 'suite-bbbbbbbbbbbb', 'label': 'Done', 'status': 'completed',
            'created_unix_s': 2.0, 'finished_unix_s': 3.0, 'runs': [run('job-recovered000', 'completed')]})
        atomic_json(suites / 'suite-cccccccccccc.json', {
            'schema_version': 1, 'id': 'suite-cccccccccccc', 'label': 'Cancelling', 'status': 'cancelling',
            'created_unix_s': 4.0, 'finished_unix_s': None, 'runs': [run(None, 'queued')]})
        with patch('studio.workbench.os.killpg') as kill:
            reopened = self.make()
        kill.assert_not_called()
        interrupted = reopened.suite('suite-aaaaaaaaaaaa')
        self.assertEqual(interrupted['status'], 'interrupted')
        self.assertEqual([r['status'] for r in interrupted['runs']], ['completed', 'failed', 'not_started'])
        self.assertEqual(reopened.suite('suite-cccccccccccc')['status'], 'interrupted')
        self.assertEqual(reopened.suite('suite-bbbbbbbbbbbb')['status'], 'completed')
        on_disk = json.loads((suites / 'suite-aaaaaaaaaaaa.json').read_text())
        self.assertEqual(on_disk, interrupted)
        self.assertEqual([s['id'] for s in reopened.list_suites()['suites']],
                         ['suite-cccccccccccc', 'suite-bbbbbbbbbbbb', 'suite-aaaaaaaaaaaa'])
        self.assertFalse(any(s['status'] in wb.SUITE_ACTIVE for s in reopened.suites.values()))


class RunsTableTests(WorkbenchCase):
    REPORT = {'outcome': 'reached', 'elapsed_s': 8.0, 'final_goal_distance_xy_m': .12,
              'minimum_goal_distance_xy_m': .05, 'maximum_obstacle_contact_n': 3.5, 'maximum_root_tilt_rad': .1,
              'minimum_root_height_m': .7, 'plan_latency_s': {'p50': .0125, 'p95': .25},
              'sonic_inference_ms': {'p50': 1.0, 'p95': 1.5}, 'replans': 7, 'selection_rules': {'route': 7}}

    def make_job(self, key, status, *, result=None, session=True, progress=0, scenario=None, record=None):
        output = self.root / 'jobs' / key
        (output / 'run').mkdir(parents=True)
        saved = {'id': key, 'status': status, 'scenario_id': 'scenario-fixture', 'started_unix_s': 100.0,
                 'finished_unix_s': 110.0, 'suite_id': None, 'policy_id': FLOW_ID,
                 'policy_identity': {'identity_sha256': 'ab' * 32},
                 'scenario': scenario if scenario is not None else {
                     'label': 'Fixture run', 'map_id': 'flat-ground', 'map_sha256': 'f' * 64,
                     'start_xy': [0.0, 0.0], 'start_yaw_rad': 0.0, 'goal_xy': [2.0, 0.0], 'duration_s': 8.0,
                     'seed': 3, 'planner': {'candidates': 8, 'ode_steps': 6}, 'policy_id': FLOW_ID}}
        saved.update(record or {})
        atomic_json(output / 'job.json', saved)
        if session:
            atomic_json(output / 'run/session.json', {'schema_version': 1, 'frames': [{'time': 0}]})
        if result is not None:
            atomic_json(output / 'run/result.json', result)
        if progress:
            with (output / 'run/progress.jsonl').open('w') as handle:
                for i in range(progress):
                    handle.write(json.dumps({'time': i * .02, 'qpos': [i * .001, -i * .002, .79]}) + '\n')
                handle.write('{"time": 99, "qpos": [1, 2\n')  # torn final line from a live writer
        return output

    def test_rows_report_metrics_outcomes_and_replayability(self):
        self.make_job('job-000000000001', 'completed', progress=1000,
                      result={'status': 'completed', 'wall_time_s': 30.0, 'report': self.REPORT})
        self.make_job('job-000000000002', 'failed', result={'status': 'failed', 'error': 'route failure'},
                      record={'error': 'route failure'})
        self.make_job('job-000000000003', 'failed', session=False, record={'error': 'launch failure'})
        self.make_job('job-000000000004', 'completed', result={'status': 'completed', 'report': {'outcome': 'timeout'}},
                      scenario={'label': 'Legacy run'}, record={'policy_id': None, 'policy_identity': None})
        w = self.make()
        table = w.runs_table()
        self.assertEqual(table['schema_version'], 1)
        rows = {row['id']: row for row in table['runs']}
        self.assertEqual([row['id'] for row in table['runs']],
                         ['job-000000000004', 'job-000000000003', 'job-000000000002', 'job-000000000001'])
        done = rows['job-000000000001']
        self.assertEqual((done['status'], done['outcome'], done['replayable']), ('completed', 'reached', True))
        self.assertEqual((done['policy_id'], done['policy_identity_sha256']), (FLOW_ID, 'ab' * 32))
        self.assertEqual((done['label'], done['map_id'], done['goal_xy'], done['seed']), ('Fixture run', 'flat-ground', [2.0, 0.0], 3))
        self.assertEqual(done['planner'], {'candidates': 8, 'ode_steps': 6})
        metrics = done['metrics']
        self.assertEqual(metrics['final_goal_distance_m'], .12)
        self.assertEqual(metrics['minimum_goal_distance_m'], .05)
        self.assertEqual(metrics['max_contact_n'], 3.5)
        self.assertEqual(metrics['max_tilt_rad'], .1)
        self.assertEqual(metrics['min_root_height_m'], .7)
        self.assertAlmostEqual(metrics['planner_p50_ms'], 12.5)
        self.assertAlmostEqual(metrics['planner_p95_ms'], 250.0)
        self.assertEqual(metrics['sonic_p95_ms'], 1.5, 'SONIC latency is already recorded in ms')
        self.assertEqual((metrics['replans'], metrics['wall_time_s'], metrics['elapsed_s']), (7, 30.0, 8.0))
        self.assertEqual(metrics['selection_rules'], {'route': 7})
        self.assertEqual(done['clock_domain'], 'simulation')
        self.assertLessEqual(len(done['trajectory']), 161)
        self.assertEqual(done['trajectory'][0], [0.0, 0.0, 0.0])
        self.assertEqual(done['trajectory'][-1], [round(999 * .02, 3), .999, -1.998])

        failed = rows['job-000000000002']
        self.assertEqual((failed['outcome'], failed['replayable'], failed['error']), ('runtime_error', True, 'route failure'))
        self.assertIsNone(failed['metrics']['planner_p50_ms'])
        self.assertIsNone(failed['trajectory'])
        unrecorded = rows['job-000000000003']
        self.assertEqual((unrecorded['outcome'], unrecorded['replayable']), (None, False))
        legacy = rows['job-000000000004']
        self.assertEqual((legacy['policy_id'], legacy['policy_identity_sha256'], legacy['outcome']),
                         (wb.DEFAULT_POLICY_ID, None, 'timeout'))

    def test_ms_conversion_never_turns_missing_into_zero(self):
        self.assertAlmostEqual(_ms(.0125), 12.5)
        self.assertEqual(_ms(0), 0)
        for value in (None, '0.1', float('nan'), float('inf'), [0.1]):
            with self.subTest(value=value):
                self.assertIsNone(_ms(value))

    def test_trajectory_decimation_is_bounded_and_keeps_endpoints(self):
        for count in (1, 2, 159, 160, 161, 320, 321, 1000, 4999):
            with self.subTest(count=count):
                key = f'job-traj{count:08d}'
                output = self.make_job(key, 'completed', progress=count)
                points = self.w._trajectory({'output': output})
                self.assertLessEqual(len(points), 161)
                self.assertEqual(points[0], [0.0, 0.0, 0.0])
                self.assertEqual(points[-1], [round((count - 1) * .02, 3), round((count - 1) * .001, 3),
                                              round(-(count - 1) * .002, 3)])
                times = [p[0] for p in points]
                self.assertEqual(times, sorted(set(times)), 'Decimation must not duplicate the final sample')
                if count <= 160:
                    self.assertEqual(len(points), count)
        small = self.w._trajectory({'output': self.make_job('job-trajbudget', 'completed', progress=50)}, budget=10)
        self.assertLessEqual(len(small), 11)
        self.assertIsNone(self.w._trajectory({'output': self.root / 'jobs/job-missing'}))

    def test_terminal_rows_are_cached_and_live_rows_are_not(self):
        self.make_job('job-000000000001', 'completed', progress=10,
                      result={'status': 'completed', 'report': self.REPORT})
        w = self.make()
        first = w.run_row('job-000000000001')
        atomic_json(self.root / 'jobs/job-000000000001/run/result.json',
                    {'status': 'completed', 'report': dict(self.REPORT, outcome='changed')})
        again = w.run_row('job-000000000001')
        self.assertEqual(again, first)
        again['metrics']['elapsed_s'] = -1  # callers get copies; the cached row is not shared
        self.assertEqual(w.run_row('job-000000000001')['metrics']['elapsed_s'], first['metrics']['elapsed_s'])
        self.assertEqual(w.run_row('job-000000000001')['outcome'], 'reached')
        live = self.make_job('job-live00000000', 'running', session=False, progress=5)
        w.jobs['job-live00000000'] = {'id': 'job-live00000000', 'status': 'running', 'output': live,
                                      'process': None, 'latest': None, 'error': None, 'result_session_id': None}
        before = w.run_row('job-live00000000')
        self.assertIsNone(before['outcome'])
        atomic_json(live / 'run/result.json', {'status': 'completed', 'report': {'outcome': 'reached'}})
        after = w.run_row('job-live00000000')
        self.assertIsNot(before, after)
        self.assertEqual(after['outcome'], 'reached')
        with self.assertRaises(KeyError):
            w.run_row('job-unknown')


class LightJobTests(WorkbenchCase):
    def setUp(self):
        super().setUp()
        output = self.root / 'jobs/job-light0000000'
        (output / 'run').mkdir(parents=True)
        self.latest = {
            'schema_version': 1, 'status': 'running', 'frame': {'time': 1.0, 'qpos': [0.0] * 36},
            'progress': {'simulation_time_s': 1.0, 'wall_time_s': 3.0},
            'pipeline': {'schema_version': 1, 'flow_samples': [], 'sonic_samples': []},
            'metadata': {'id': 'job-light0000000', 'title': 'heavy metadata'},
            'graph': {'nodes': [1], 'edges': []}, 'environment': {'boxes': [WALL]},
            'joint_names': ['j'] * 29,
            'perception': {'available': True, 'time': .8, 'support_points': [[1.0, 0.0, 0.0]],
                           'support_observed_indices': [1, 2, 3], 'ceiling_observed_indices': [4],
                           'observed_points': [[1.0, 0.0, 0.0]], 'observed_cells': {'support': 3}}}
        self.w.jobs['job-light0000000'] = {'id': 'job-light0000000', 'status': 'running', 'output': output,
                                           'process': None, 'latest': self.latest, 'error': None,
                                           'result_session_id': None}

    def test_light_payload_omits_heavy_static_fields(self):
        latest = self.w.job('job-light0000000', light=True)['latest']
        self.assertTrue(latest['light'])
        for field in ('metadata', 'graph', 'environment', 'joint_names'):
            self.assertNotIn(field, latest)
        self.assertEqual(latest['frame'], self.latest['frame'])
        self.assertEqual(latest['progress'], self.latest['progress'])
        self.assertEqual(latest['perception'], {'available': True, 'time': .8, 'support_points': [[1.0, 0.0, 0.0]],
                                                'observed_cells': {'support': 3}})
        # The stored live record is untouched by the lightweight view.
        stored = self.w.jobs['job-light0000000']['latest']
        self.assertIn('metadata', stored)
        self.assertEqual(stored['perception']['support_observed_indices'], [1, 2, 3])

    def test_perception_is_sent_only_when_newer_than_client_copy(self):
        self.assertIn('perception', self.w.job('job-light0000000', light=True, perception_after=.5)['latest'])
        for after in (.8, 1.0):
            with self.subTest(after=after):
                self.assertNotIn('perception', self.w.job('job-light0000000', light=True, perception_after=after)['latest'])
        self.latest['perception']['time'] = None
        self.assertNotIn('perception', self.w.job('job-light0000000', light=True)['latest'])

    def test_full_payload_is_unchanged_and_missing_latest_stays_missing(self):
        full = self.w.job('job-light0000000')['latest']
        self.assertEqual(full, self.latest)
        self.assertNotIn('light', full)
        self.w.jobs['job-light0000000']['latest'] = None
        self.assertIsNone(self.w.job('job-light0000000', light=True)['latest'])
        self.assertEqual(self.w.job('job-light0000000', light=True)['telemetry']['status'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
