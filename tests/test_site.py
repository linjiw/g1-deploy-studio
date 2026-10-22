"""The public site's data path (tools/site): worlds, map codes, the compact walk format and its decoding rules.

No worker runs here: the walk export is exercised on a small synthetic session in the nav worker's format.
"""
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from studio import nav_worker
from studio.goal_check import MAP_CODES, map_codes
from studio.policy_worker import clean_map
from tools.site import export, worlds


def decode_changes(base, steps):
    """What site/js/viewer.js applyMapChanges does: gaps between flat indices, code or code * 1000 + height."""
    codes, heights = base[0].ravel().copy(), base[1].ravel().copy()
    for step in steps:
        idx = 0
        for gap, v in zip(step['g'], step['v']):
            idx += gap
            codes[idx], heights[idx] = (v // 1000, v % 1000) if v >= 1000 else (v, 0)
    return codes, heights


class MapCodeTests(unittest.TestCase):
    def test_codes_follow_the_route_thresholds(self):
        support = np.array([[np.nan, 0.0, 0.1, 0.4]])
        ceiling = np.array([[np.inf, 1.2, np.inf, np.inf]])
        codes, heights = map_codes(support, ceiling)
        self.assertEqual(codes.tolist(), [[0, 4, 2, 3]])  # unseen, floor under a 1.2 m ceiling, low step, obstacle
        self.assertEqual(heights.tolist(), [[0, 120, 10, 40]])
        self.assertEqual(set(MAP_CODES), {0, 1, 2, 3, 4})

    def test_changes_round_trip(self):
        rng = np.random.default_rng(3)
        before = rng.integers(0, 5, (20, 20)).astype(np.uint8), rng.integers(0, 200, (20, 20)).astype(np.uint8)
        after = before[0].copy(), before[1].copy()
        flip = rng.choice(400, 60, replace=False)
        after[0].ravel()[flip] = rng.integers(0, 5, 60)
        after[1].ravel()[flip] = rng.integers(0, 200, 60)
        changed = np.flatnonzero((after[0] != before[0]).ravel() | ((after[1] != before[1]).ravel() & (after[0].ravel() >= 2)))
        codes, heights = decode_changes(before, [export._cell_changes(changed, after[0].ravel(), after[1].ravel())])
        np.testing.assert_array_equal(codes, after[0].ravel())
        keep = after[0].ravel() >= 2  # heights are carried only where the site draws them
        np.testing.assert_array_equal(heights[keep], after[1].ravel()[keep])


class WorldTests(unittest.TestCase):
    def test_every_world_is_a_valid_request_map_with_a_free_start(self):
        for world_id in worlds.WORLDS:
            try:
                m, bounds = worlds.world_map(world_id)
            except (OSError, StopIteration, ValueError) as error:  # Flow scenes need the deploy checkout
                self.skipTest(f'{world_id}: {error}')
            clean = clean_map(m)
            self.assertGreater(len(clean['boxes']), 0)
            start = worlds.WORLDS[world_id]['start_xy']
            for b in clean['boxes']:
                c, s, h = np.asarray(b['center_xy']), np.cos(b['yaw']), np.sin(b['yaw'])
                local = np.array([[c[0] - start[0]], [c[1] - start[1]]])
                rx, ry = abs(s * local[0, 0] + h * local[1, 0]), abs(-h * local[0, 0] + s * local[1, 0])
                self.assertFalse(rx < b['half_xy'][0] + 0.35 and ry < b['half_xy'][1] + 0.35, f'{world_id}: start inside a box')
            self.assertLess(bounds['min'][0], start[0])

    def test_record_grids_is_opt_in_and_strict(self):
        base = {'schema_version': 1, 'id': 'x', 'map': {'kind': 'boxes', 'boxes': []}}
        self.assertFalse(nav_worker.validate_request(base)['record_grids'])
        self.assertTrue(nav_worker.validate_request(dict(base, record_grids=True))['record_grids'])
        with self.assertRaises(ValueError):
            nav_worker.validate_request(dict(base, record_grids=1))


class RecorderStopTests(unittest.TestCase):
    def test_a_stopping_batch_starts_no_worker(self):
        from tools.site import record_goals
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'g00-00'
            record_goals._STOP.set()
            try:
                r = record_goals.walk('detour', 'deploy', folder, {'id': 'g00-00', 'xy': [1.0, 0.0]})
            finally:
                record_goals._STOP.clear()
            self.assertEqual(r['error'], 'batch stopped')
            self.assertFalse(r['finished'])
            self.assertFalse(folder.exists())  # no session folder, so no worker process was started


class WalkExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.run_dir = Path(self.tmp.name)
        n = 5
        self.base = (np.zeros((n, n), np.uint8), np.zeros((n, n), np.uint8))
        step = (self.base[0].copy(), self.base[1].copy())
        step[0][2, 3], step[1][2, 3] = 3, 55
        step[0][1, 1] = 1
        np.savez_compressed(self.run_dir / 'grids.npz', time=np.array([0.0, 1.0]), codes=np.stack([self.base[0], step[0]]),
                            height_cm=np.stack([self.base[1], step[1]]), lo=np.array([-1.0, -1.0]), res=np.float64(0.5))
        self.step = step
        frames = []
        for k in range(7):
            qpos = [0.1 * k, 0.0, 0.79, 1.0, 0.0, 0.0, 0.0] + [0.01 * j for j in range(29)]
            # The reference SONIC tracks: 0.2 m ahead of the estimate and 2 cm higher, every joint 0.1 rad off;
            # the first frame has none.
            reference = None if k == 0 else {'position': [0.1 * k + 0.21, 0.0, 0.81], 'quaternion_wxyz': [1.0, 0.0, 0.0, 0.0],
                                              'joints': [0.01 * j + 0.1 for j in range(29)], 'position_basis': 'planner-diagnostic-not-consumed-by-sonic'}
            frames.append({'time': 0.02 * k, 'qpos': qpos, 'estimate': {'position': [0.1 * k + 0.01, 0.0, 0.79]},
                           'reference': reference, 'navigation': {'phase': 'PRESCAN' if k < 2 else 'RUN'},
                           'health': {'tilt_rad': 0.01, 'contact_force_n': 0.0, 'goal_dist_m': 1.0 - 0.1 * k}})
        session = {'frames': frames, 'events': [{'time': 0.0, 'type': 'goal', 'message': 'walk 1'},
                                                {'time': 0.04, 'type': 'replan', 'message': 'x'}],
                   'plans': [{'tick': 2, 'rule': 'safe_min_goal_distance', 'chosen_clearance_m': float('inf'),
                              'waypoint_xy': [1.0, 0.0], 'plan_xy': [[0.0, 0.0], [0.5, 0.0]], 'plan_root_z': [0.79, 0.78]}],
                   'perception': {'frames': [{'time': 0.0, 'filtered_lidar': [[1.0, 2.0, 0.5]] * 3, 'sensor_origin': [0, 0, 1.2],
                                              'observed_fraction': 0.1}]},
                   'metadata': {'navigation': {'legs': [{'goal_xy': [1.0, 0.0], 'outcome': 'arrived', 'reason': None, 'duration_s': 0.12,
                                                         'final_dist_true_m': 0.3, 'final_dist_m': 0.31, 'path_m': 0.6,
                                                         'max_contact_n': 0.0, 'plans': 1}]},
                                'latency_model': {'executing_plan_starts': [[10, 0]]}, 'test_result': {}}}
        (self.run_dir / 'session.json').write_text(json.dumps(session))

    def test_walk_quantizes_and_keeps_what_the_recording_holds(self):
        d = export.walk_data('w', 'g00-00', self.run_dir, *self.base)
        self.assertEqual(d['n'], 4)  # every second tick, plus the last frame
        self.assertEqual(d['time'], [0.0, 0.04, 0.08, 0.12])
        self.assertEqual(d['q'][36:39], [200, 0, 790])  # frame 2: x = 0.2 m in mm
        self.assertEqual(d['q'][39:43], [10000, 0, 0, 0])
        self.assertEqual(d['q'][43 + 28], 280)  # joint 29 in mrad
        self.assertEqual(d['phases'], [[0, 'PRESCAN'], [1, 'RUN']])
        self.assertEqual(d['plans'][0]['xy'], [0, 0, 50, 0])
        self.assertIsNone(d['plans'][0]['clear_cm'])  # infinite clearance is not a number on the site
        self.assertEqual(d['plan_starts'], [[0.2, 0]])
        self.assertEqual([e['type'] for e in d['events']], ['goal'])  # replans and commands are not events on the site
        codes, heights = decode_changes(self.base, d['map'])
        np.testing.assert_array_equal(codes, self.step[0].ravel())
        self.assertEqual(heights[2 * 5 + 3], 55)
        self.assertEqual(d['outcome'], 'arrived')

    def test_walks_carry_the_reference_sonic_tracks_and_missing_frames_stay_null(self):
        d = export.walk_data('w', 'g00-00', self.run_dir, *self.base)
        self.assertIsNone(d['ref'][0])  # no reference recorded at the first frame: null, not the robot's own pose
        self.assertEqual(d['ref'][1][:3], [410, 0, 810])  # frame 2 (every second tick): x = 0.41 m, z = 0.81 m in mm
        self.assertEqual(d['ref'][1][3:7], [10000, 0, 0, 0])
        self.assertEqual(d['ref'][1][7], 100)  # joint 1 + 0.1 rad, in mrad
        self.assertEqual(d['ref_basis'], 'planner-diagnostic-not-consumed-by-sonic')
        e = export.execution(d)
        self.assertEqual(len(e['lag_m']), 3)  # walking frames with a reference: 2, 4 and 6 (frame 0 has none, 1 is a pre-scan)
        for lag, dz, rms in zip(e['lag_m'], e['dz_m'], e['rms_rad']):
            self.assertAlmostEqual(lag, 0.2, places=3)  # against the robot's estimate, both in the planner's frame
            self.assertAlmostEqual(dz, 0.02, places=3)
            self.assertAlmostEqual(rms, 0.1, places=3)

    def test_a_contact_peak_between_kept_ticks_is_kept(self):
        session = json.loads((self.run_dir / 'session.json').read_text())
        session['frames'][1]['health']['contact_force_n'] = 150.0  # tick 1 is not kept (every second tick is)
        (self.run_dir / 'session.json').write_text(json.dumps(session))
        d = export.walk_data('w', 'g00-00', self.run_dir, *self.base)
        self.assertEqual(d['contact_n'][:2], [0, 150])  # the frame at tick 2 carries the peak of ticks 1 and 2

    def test_grades_follow_the_site_rule(self):
        g = export.grade_key
        self.assertEqual(g({'outcome': 'arrived', 'max_contact_n': 20, 'final_dist_m': 0.2, 'final_dist_estimate_m': 0.2}), 'clean')
        self.assertEqual(g({'outcome': 'arrived', 'max_contact_n': 101, 'final_dist_m': 0.9, 'final_dist_estimate_m': 0.9}), 'contact')
        self.assertEqual(g({'outcome': 'arrived', 'max_contact_n': None, 'final_dist_m': 0.7, 'final_dist_estimate_m': 0.3}), 'off')
        self.assertEqual(g({'outcome': 'arrived', 'max_contact_n': 0, 'final_dist_m': 4.2, 'final_dist_estimate_m': 4.1}), 'away')
        self.assertEqual(g({'outcome': 'fell', 'max_contact_n': 300}), 'fell')
        # Nothing flagged but a value missing: not clean.
        self.assertEqual(g({'outcome': 'arrived', 'max_contact_n': None, 'final_dist_m': 0.2, 'final_dist_estimate_m': 0.2}), 'ungraded')
        self.assertEqual(g({'outcome': 'arrived', 'max_contact_n': 10, 'final_dist_m': None, 'final_dist_estimate_m': 0.2}), 'ungraded')

    def test_the_walk_list_has_one_row_per_walk(self):
        index = {'start_xy': [0.0, 0.0], 'cells': [{'id': 'g00-00', 'xy': [3.0, 4.0]}],
                 'walks': {'g00-00': {'outcome': 'arrived', 'max_contact_n': 140.4, 'final_dist_m': 0.234, 'final_dist_estimate_m': 0.1, 'duration_s': 12.34}}}
        self.assertEqual(export.walk_list(index), [['g00-00', 'contact', 5.0, 140, 0.23, 12.3, 3.0, 4.0]])
        self.assertEqual(export.LIST_FIELDS, ['id', 'grade', 'dist_m', 'contact_n', 'final_m', 'duration_s', 'x', 'y'])

    def test_split_views_put_plan_body_scenarios_first_and_start_before_the_moment(self):
        d = export.walk_data('w', 'g00-00', self.run_dir, *self.base)
        d['events'] = [{'t': 0.04, 'type': 'arrived', 'msg': 'arrived', 'dist': 0.38}]
        off = dict(d, goal_id='g00-01', final_dist_m=0.8, final_dist_estimate_m=0.35)
        pick = {'contact': {'world': 'w', 'goal': 'g00-00', 'at': 3.0, 'note': 'Peaks at 400 N.'}}
        out = export.closer_scenarios([('w', d), ('w', off)], pick)
        self.assertEqual([x['id'] for x in out], ['contact', 'estimate'])
        self.assertEqual(out[0]['mode'], 'body')
        self.assertEqual(out[0]['at'], 1.5)  # 1.5 s before the moment
        self.assertIn('Peaks at 400 N.', out[0]['caption'])
        self.assertEqual(out[1]['goal'], 'g00-01')
        self.assertIn('0.35 m from the goal by its estimate and 0.80 m by simulator truth', out[1]['caption'])

    def test_example_notes_name_how_an_unclean_walk_ends(self):
        clean = {'max_contact_n': 20.0, 'final_dist_m': 0.3, 'outcome': 'arrived', 'reason': None}
        self.assertEqual(export._ending(clean), '')
        fell = {'max_contact_n': 338.2, 'final_dist_m': 1.84, 'outcome': 'fell', 'reason': 'pelvis 0.29 m'}
        self.assertEqual(export._ending(fell), ' The walk peaks at 338 N of contact, ends 1.84 m from the goal (simulator truth)'
                                               ' and is reported as fell (pelvis 0.29 m).')
        self.assertEqual(export._ending(dict(clean, max_contact_n=None, final_dist_m=None, outcome='estop')), ' The walk is reported as estop.')

    def test_a_walk_that_starts_on_another_map_is_refused(self):
        other = (self.base[0] + 1, self.base[1])
        with self.assertRaisesRegex(ValueError, 'differs from the probe map'):
            export.walk_data('w', 'g00-00', self.run_dir, *other)


class LocalMaterialTests(unittest.TestCase):
    """Material for the next-step page that is not published goes only into local builds (docs/SITE.md)."""
    ROOT = Path(__file__).resolve().parents[1]

    def run_script(self, *args, env=None):
        import os, subprocess
        return subprocess.run([str(self.ROOT / 'tools' / 'site' / args[0]), *args[1:]], capture_output=True, text=True,
                              env={**os.environ, **(env or {})}, timeout=120)

    def test_ci_builds_refuse_local_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, out, local = Path(tmp, 'data'), Path(tmp, 'out'), Path(tmp, 'next-local.json')
            data.mkdir(); (data / 'worlds.json').write_text('{"worlds": []}'); local.write_text('{"sections": []}')
            # Refused before anything is copied, so this holds whatever node_modules holds.
            r = self.run_script('build.sh', str(out), str(data), env={'CI': 'true', 'NEXT_LOCAL': str(local)})
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('local builds only', r.stderr)
            self.assertFalse(out.exists())
            modules = self.ROOT / 'node_modules'
            if not ((modules / 'three' / 'build' / 'three.module.min.js').is_file() and (modules / '@fontsource-variable' / 'inter').is_dir()):
                self.skipTest('the public-build half needs npm ci (three.js and Inter)')
            r = self.run_script('build.sh', str(out), str(data), env={'CI': '', 'NEXT_LOCAL': ''})
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads((out / 'data' / 'next-local.json').read_text()), {})

    def test_a_release_never_packs_local_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, media = Path(tmp, 'data'), Path(tmp, 'media')
            data.mkdir(); media.mkdir(); (data / 'next-local.json').write_text('{}')
            r = self.run_script('package.sh', str(data), str(media), str(Path(tmp, 'out')), 'site-test')
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('local-only', r.stderr)


if __name__ == '__main__':
    unittest.main()
