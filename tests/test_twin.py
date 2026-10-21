"""Scan to twin (studio.twin): arenas fitted to the robot's own map. Pure numpy; recorded dumps are read-only."""
import json
import math
from pathlib import Path
import time
import unittest

import numpy as np

from studio.goal_check import grid_from_arrays, load_grid
from studio.twin import twin_from_grid, twin_quality
from studio.workbench import point_status, validate_map, validate_presets

RUNS = Path('/home/linjiw/code/g1-student-deploy/runs')
RES = 0.05
LO = np.array([-6.0, -6.0])
N = 241


def blank():
    return np.zeros((N, N)), np.full((N, N), np.nan)


def region(x0, x1, y0, y1):
    xs, ys = LO[0] + np.arange(N) * RES, LO[1] + np.arange(N) * RES
    return np.ix_((xs >= x0 - 1e-9) & (xs <= x1 + 1e-9), (ys >= y0 - 1e-9) & (ys <= y1 + 1e-9))


def grid(support, ceiling, **kw):
    return grid_from_arrays(support, ceiling, LO, RES, **kw)


def footprint_cells(boxes):
    """Cell indices covered by axis-aligned twin boxes (centre-inside test on the map's own cell centres)."""
    xs, ys = LO[0] + np.arange(N) * RES, LO[1] + np.arange(N) * RES
    out = np.zeros((N, N), dtype=bool)
    for b in boxes:
        self_x = np.abs(xs - b['center_xy'][0]) <= b['half_xy'][0] + 1e-9
        self_y = np.abs(ys - b['center_xy'][1]) <= b['half_xy'][1] + 1e-9
        out |= self_x[:, None] & self_y[None, :]
    return out


def node_goal(run):
    for line in (run / 'node.log').read_text(errors='replace').splitlines():
        if '"node_up"' in line:
            return json.loads(line[line.find('{'):])['goal']
    raise AssertionError('node_up not logged')


def recorded(run):
    g = load_grid(run / 'node_memory.npz')
    start = (g['lo'] + (g['n'] - 1) * g['res'] / 2).tolist()   # the memory is centred on the boot pose
    return g, start, node_goal(run), json.loads((run / 'boxes.json').read_text())


class RectangleTests(unittest.TestCase):
    def assert_arena(self, doc):
        data = validate_map(doc)
        validate_presets(doc['presets'], data)
        json.dumps(doc, allow_nan=False)
        return data

    def test_l_shaped_wall_becomes_two_exact_rectangles_not_one_bounding_box(self):
        support, ceiling = blank()
        support[region(2.0, 2.2, -1.0, 1.0)] = 1.4   # long leg along y
        support[region(2.25, 3.5, 0.8, 1.0)] = 1.4   # short leg along x
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[4.0, -1.5])
        self.assertEqual(len(doc['boxes']), 2)
        self.assertTrue(np.array_equal(footprint_cells(doc['boxes']), support > 0.05))
        self.assertEqual(sorted(b['z_top'] for b in doc['boxes']), [1.4, 1.4])
        self.assertTrue(all(b['z_bottom'] == 0 and b['yaw'] == 0 for b in doc['boxes']))
        data = self.assert_arena(doc)
        # The L's inner corner is free: a bounding box per component would have covered it.
        self.assertEqual(point_status(data, [3.0, 0.0])['status'], 'configured_free')
        self.assertEqual(point_status(data, [2.1, 0.0])['status'], 'blocked')
        self.assertEqual(len(doc['presets']), 1)
        self.assertEqual(doc['presets'][0]['goal_xy'], [4.0, -1.5])
        self.assertEqual(doc['counts'], {'ground': 2, 'overhead': 0, 'fitted': 2})
        self.assertEqual(doc['warnings'], [])
        for key in ('source', 'method', 'res_m', 'observed_fraction', 'parameters'):
            self.assertIn(key, doc['provenance'])
        self.assertEqual(doc['provenance']['source'], 'in-memory grid')

    def test_beam_becomes_an_overhead_slab_from_its_lowest_underside(self):
        support, ceiling = blank()
        ceiling[region(1.3, 1.4, -0.75, 0.75)] = 1.15
        ceiling[region(1.3, 1.4, 0.0, 0.0)] = 1.13
        ceiling[region(-2.0, -1.0, -2.0, -1.0)] = np.inf   # observed clear: no slab
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[3, 0])
        self.assertEqual(doc['counts']['overhead'], 1)
        slab = doc['boxes'][0]
        self.assertAlmostEqual(slab['z_bottom'], 1.13)
        self.assertAlmostEqual(slab['z_top'], 1.23)
        np.testing.assert_allclose(slab['center_xy'], [1.35, 0.0], atol=1e-9)
        np.testing.assert_allclose(slab['half_xy'], [0.075, 0.775], atol=1e-9)
        data = self.assert_arena(doc)
        self.assertEqual(point_status(data, [1.35, 0.0])['status'], 'blocked')   # below 1.3 m: blocks standing
        self.assertEqual(len(doc['presets']), 1)

    def test_heights_split_rectangles_but_tall_walls_share_one_group(self):
        support, ceiling = blank()
        support[region(1.0, 1.2, -1.0, -0.05)] = 0.3
        support[region(1.0, 1.2, 0.0, 1.0)] = 0.6
        support[region(3.0, 3.2, -1.0, -0.05)] = 1.1
        support[region(3.0, 3.2, 0.0, 1.0)] = 1.7
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0)
        tops = sorted(round(b['z_top'], 3) for b in doc['boxes'])
        self.assertEqual(tops, [0.3, 0.6, 1.7])   # 1.1 and 1.7 m walls are both "tall": one box, highest top
        strict = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, tall_m=None)
        self.assertEqual(sorted(round(b['z_top'], 3) for b in strict['boxes']), [0.3, 0.6, 1.1, 1.7])
        tolerant = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, height_tol_m=0.4)
        self.assertEqual(sorted(round(b['z_top'], 3) for b in tolerant['boxes']), [0.6, 1.7])
        for d in (doc, strict, tolerant):
            self.assert_arena(d)

    def test_blocked_goal_gives_no_preset_and_says_why(self):
        support, ceiling = blank()
        support[region(2.0, 2.2, -1.0, 1.0)] = 1.4
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[2.1, 0.0])
        self.assertEqual(doc['presets'], [])
        self.assertTrue(any('No preset: the goal' in w for w in doc['warnings']), doc['warnings'])
        self.assert_arena(doc)
        too_close = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[0.1, 0.0])
        self.assertEqual(too_close['presets'], [])
        self.assertTrue(any('0.2 m apart' in w for w in too_close['warnings']))
        no_goal = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=4.0)
        self.assertEqual(no_goal['presets'], [])
        self.assertEqual(no_goal['warnings'], [])

    def test_isolated_fragments_are_ignored_with_a_warning(self):
        support, ceiling = blank()
        support[region(-3.0, -3.0, 3.0, 3.0)] = 0.4      # one 5 cm cell: 0.0025 m²
        support[region(2.0, 2.2, -1.0, 1.0)] = 1.4
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0)
        self.assertEqual(len(doc['boxes']), 1)
        self.assertTrue(any('isolated fragments' in w for w in doc['warnings']))
        kept = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, min_area_m2=0.0)
        self.assertEqual(len(kept['boxes']), 2)

    def test_low_returns_where_the_robot_stood_are_ignored_but_tall_ones_kept(self):
        support, ceiling = blank()
        support[region(-0.1, 0.1, -0.15, -0.05)] = 0.12   # feet / legs
        support[region(2.0, 2.2, -1.0, 1.0)] = 1.4
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[4, 0])
        self.assertEqual(len(doc['boxes']), 1)
        self.assertEqual(len(doc['presets']), 1)
        self.assertTrue(any('the robot stood there' in w for w in doc['warnings']))
        kept = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[4, 0],
                              clear_start_m=0.0)
        self.assertEqual(len(kept['boxes']), 2)
        self.assertEqual(kept['presets'], [])
        self.assertTrue(any('No preset: the start' in w for w in kept['warnings']))
        support[region(-0.1, 0.1, -0.15, -0.05)] = 0.9    # taller than step-over: never cleared
        tall = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[4, 0])
        self.assertEqual(len(tall['boxes']), 2)
        self.assertEqual(tall['presets'], [])

    def test_box_budget_merges_or_drops_the_smallest_pieces_with_warnings(self):
        support, ceiling = blank()
        for k in range(40):   # 40 separate posts, 0.1 m apart in x
            x = -4.0 + 0.2 * k
            support[region(x, x + 0.05, 3.0, 3.1)] = 1.0
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, max_boxes=10)
        self.assertEqual(len(doc['boxes']), 10)
        self.assertEqual(doc['counts']['fitted'], 40)
        self.assertTrue(any('merged' in w for w in doc['warnings']))
        covered = footprint_cells(doc['boxes'])
        self.assertTrue(covered[support > 0.05].all(), 'merging must stay conservative')
        validate_map(doc)
        far = blank()[0]
        for k in range(5):
            far[region(-4.0 + 2.0 * k, -3.95 + 2.0 * k, 3.0, 3.05)] = 1.0
        dropped = twin_from_grid(grid(far, blank()[1]), start_xy=[0, 0], start_yaw_rad=0.0, max_boxes=3)
        self.assertEqual(len(dropped['boxes']), 3)
        self.assertTrue(any('dropped' in w for w in dropped['warnings']))
        with self.assertRaises(ValueError):
            twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, max_boxes=129)

    def test_source_method_uses_the_dump_boxes(self):
        support, ceiling = blank()
        boxes = [{'center_xy': [2.1, 0.0], 'half_xy': [0.1, 1.0], 'yaw': 0.0, 'z_bottom': 0.0, 'z_top': 1.4}]
        doc = twin_from_grid(grid(support, ceiling, boxes=boxes), start_xy=[0, 0], start_yaw_rad=0.0,
                             goal_xy=[4, 0], method='source')
        self.assertEqual(doc['boxes'], boxes)
        self.assertEqual(len(doc['presets']), 1)
        self.assertEqual(doc['provenance']['method'], 'source')
        missing = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, method='source')
        self.assertEqual(missing['boxes'], [])
        self.assertTrue(any('no boxes field' in w for w in missing['warnings']))
        with self.assertRaises(ValueError):
            twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, method='hull')

    def test_unseen_space_stays_empty(self):
        support, ceiling = blank()
        support[:] = np.nan
        support[region(-1, 1, -1, 1)] = 0.0
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[3, 3])
        self.assertEqual(doc['boxes'], [])
        self.assertAlmostEqual(doc['provenance']['observed_fraction'], 41 * 41 / N ** 2)
        self.assertEqual(len(doc['presets']), 1)

    def test_fit_is_fast_on_a_walled_241_grid(self):
        support, ceiling = blank()
        support[region(-5.0, 5.0, -5.0, -4.9)] = 1.9
        support[region(-5.0, 5.0, 4.9, 5.0)] = 1.9
        support[region(-5.0, -4.9, -5.0, 5.0)] = 1.9
        support[region(4.9, 5.0, -5.0, 5.0)] = 1.9
        rng = np.random.default_rng(0)
        noisy = support > 0
        support[noisy] += rng.uniform(-0.6, 0.0, noisy.sum())   # wall tops seen at different heights
        start = time.perf_counter()
        doc = twin_from_grid(grid(support, ceiling), start_xy=[0, 0], start_yaw_rad=0.0, goal_xy=[2, 2])
        self.assertLess(time.perf_counter() - start, 2.0)
        self.assertEqual(len(doc['boxes']), 4)   # the closed wall ring is four boxes, not one 10 x 10 m box
        self.assertEqual(len(doc['presets']), 1)


class QualityTests(unittest.TestCase):
    def setUp(self):
        support, ceiling = blank()
        support[region(1.9, 2.1, -1.0, 1.0)] = 1.4
        ceiling[region(3.0, 3.1, -0.5, 0.5)] = 1.2
        self.grid = grid(support, ceiling)
        self.truth = [{'center_xy': [2.0, 0.0], 'half_xy': [0.125, 1.025], 'yaw': 0.0, 'z_bottom': 0.0, 'z_top': 1.5},
                      {'center_xy': [3.05, 0.0], 'half_xy': [0.075, 0.525], 'yaw': 0.0, 'z_bottom': 1.2,
                       'z_top': 1.35}]

    def test_perfect_fit_scores_one(self):
        doc = twin_from_grid(self.grid, start_xy=[0, 0], start_yaw_rad=0.0, truth_boxes=self.truth)
        q = doc['quality']
        self.assertEqual(q['occupancy_iou'], 1.0)
        self.assertEqual((q['true_boxes_found'], q['true_boxes_total']), (2, 2))
        self.assertEqual(q['missed_area_m2'], 0.0)
        self.assertEqual(q['extra_area_m2'], 0.0)
        self.assertAlmostEqual(q['height_error_m'], 0.05)   # ground top 1.4 vs 1.5, overhead underside exact
        self.assertEqual([row['layer'] for row in q['per_box']], ['ground', 'overhead'])
        json.dumps(q, allow_nan=False)

    def test_shifted_and_missing_boxes_lower_the_score(self):
        shifted = [dict(self.truth[0], center_xy=[2.1, 0.0])]
        q = twin_quality(shifted, self.truth, self.grid)
        self.assertLess(q['occupancy_iou'], 1.0)
        self.assertGreater(q['missed_area_m2'], 0)
        self.assertGreater(q['extra_area_m2'], 0)
        self.assertEqual(q['true_boxes_found'], 1)          # the beam is missing
        self.assertFalse(q['per_box'][1]['found'])
        self.assertIsNone(q['per_box'][1]['twin_height_m'])
        empty = twin_quality([], [], self.grid)
        self.assertIsNone(empty['occupancy_iou'])
        self.assertIsNone(empty['height_error_m'])

    def test_rotated_truth_footprints_and_unseen_truth(self):
        rotated = [{'center_xy': [2.0, 0.0], 'half_xy': [1.0, 0.1], 'yaw': math.pi / 2, 'z_bottom': 0.0,
                    'z_top': 1.4}]
        twin = twin_from_grid(self.grid, start_xy=[0, 0], start_yaw_rad=0.0)['boxes']
        q = twin_quality([b for b in twin if b['z_bottom'] == 0], rotated, self.grid)
        self.assertGreater(q['occupancy_iou'], 0.9)
        support, ceiling = blank()
        support[:] = np.nan
        unseen = twin_quality([], self.truth, grid(support, ceiling))
        self.assertEqual(unseen['true_boxes_found'], 0)
        self.assertEqual(unseen['per_box'][0]['observed_area_m2'], 0.0)
        with self.assertRaises(ValueError):
            twin_quality([], [{'center_xy': [0, 0]}], self.grid)


@unittest.skipUnless((RUNS / 'rt/mem-dds/node_memory.npz').is_file(), 'recorded DDS rehearsal unavailable')
class RecordedTwinTests(unittest.TestCase):
    """Twins of real node.py memories from the real-time simulation chain, scored against the true arena."""

    def test_beam_course_twin_against_the_true_boxes(self):
        g, start, goal, truth = recorded(RUNS / 'rt/mem-dds')
        doc = twin_from_grid(g, start_xy=start, start_yaw_rad=0.0, goal_xy=goal, truth_boxes=truth)
        data = validate_map(doc)
        self.assertEqual(len(validate_presets(doc['presets'], data)), 1)
        q = doc['quality']
        self.assertEqual((q['true_boxes_found'], q['true_boxes_total']), (2, 2))
        self.assertGreater(q['occupancy_iou'], 0.45)
        self.assertLess(q['height_error_m'], 0.05)
        self.assertEqual(q['missed_area_m2'], 0.0)
        self.assertEqual(doc['counts']['ground'], 0)
        self.assertGreater(doc['counts']['overhead'], 2)
        self.assertEqual(doc['provenance']['sha256'], g['sha256'])
        source = twin_from_grid(g, start_xy=start, start_yaw_rad=0.0, goal_xy=goal, truth_boxes=truth,
                                method='source')
        # Flow's grown overhead boxes cover far more seen floor than the fitted slabs.
        self.assertGreater(source['quality']['extra_area_m2'], 5 * q['extra_area_m2'])
        json.dumps(doc, allow_nan=False)

    def test_every_recorded_arena_yields_a_loadable_twin(self):
        runs = sorted(p.parent for p in RUNS.glob('*/*/boxes.json') if (p.parent / 'node_memory.npz').is_file())
        self.assertGreater(len(runs), 5)
        for run in runs:
            with self.subTest(run=str(run.relative_to(RUNS))):
                g, start, goal, truth = recorded(run)
                for method in ('rectangles', 'source'):
                    doc = twin_from_grid(g, start_xy=start, start_yaw_rad=0.0, goal_xy=goal, truth_boxes=truth,
                                         method=method)
                    data = validate_map(doc)
                    validate_presets(doc['presets'], data)
                    self.assertLessEqual(len(doc['boxes']), 128)
                    json.dumps(doc, allow_nan=False)
                    q = doc['quality']
                    # After the operator takeover the second beam was seen only along its near edge: the
                    # fitted slab covers 47 % of its observed footprint (found needs 50 %).
                    missing = int(run.name == 'remote-beams2-takeover' and method == 'rectangles')
                    self.assertEqual(q['true_boxes_found'] + missing, q['true_boxes_total'], q['per_box'])

    @unittest.skipUnless((RUNS / 'g5-dds/detour-100/node_memory.npz').is_file(), 'detour rehearsal unavailable')
    def test_walled_course_is_split_into_pieces_with_room_to_walk(self):
        g, start, goal, truth = recorded(RUNS / 'g5-dds/detour-100')
        doc = twin_from_grid(g, start_xy=start, start_yaw_rad=0.0, goal_xy=goal, truth_boxes=truth)
        self.assertEqual(len(doc['presets']), 1)
        self.assertEqual(doc['quality']['true_boxes_found'], 1)
        self.assertLess(doc['quality']['height_error_m'], 0.05)
        self.assertLess(len(doc['boxes']), 40)
        data = validate_map(doc)
        self.assertEqual(point_status(data, [2.27, 0.1])['status'], 'blocked')   # the true wall centre


if __name__ == '__main__':
    unittest.main()
