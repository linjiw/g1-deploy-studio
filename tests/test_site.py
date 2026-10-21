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
            frames.append({'time': 0.02 * k, 'qpos': qpos, 'estimate': {'position': [0.1 * k + 0.01, 0.0, 0.79]},
                           'navigation': {'phase': 'PRESCAN' if k < 2 else 'RUN'},
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

    def test_a_walk_that_starts_on_another_map_is_refused(self):
        other = (self.base[0] + 1, self.base[1])
        with self.assertRaisesRegex(ValueError, 'differs from the probe map'):
            export.walk_data('w', 'g00-00', self.run_dir, *other)


if __name__ == '__main__':
    unittest.main()
