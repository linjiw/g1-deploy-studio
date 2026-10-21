"""Goal checks on the robot's own map (studio.goal_check). Pure numpy; recorded dumps are read-only."""
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import zipfile

import numpy as np

from studio import goal_check
from studio.goal_check import CHECK_IDS, check_goal, grid_from_arrays, load_grid, plan_route, route_occupancy

DEPLOY = Path('/home/linjiw/code/g1-student-deploy')
RUNS = DEPLOY / 'runs'
ROUTE_SOURCE = DEPLOY / 'bundle/flow/src/motion2scene_flow/closed_loop/route.py'
DEPLOY_PYTHON = DEPLOY / '.venv/bin/python'
ROOT = Path(__file__).resolve().parents[1]
CONTRACT_KEYS = {'ok', 'goal_xy', 'robot_xy', 'checks', 'straight_m', 'path_m', 'path_xy', 'unknown_fraction', 'grid'}


def blank(n=241, res=0.05, lo=(-6.0, -6.0), seen=True):
    support = np.zeros((n, n)) if seen else np.full((n, n), np.nan)
    return support, np.full((n, n), np.nan), np.array(lo, dtype=float), res


def cells(lo, res, n, x0, x1, y0, y1):
    """Index mask of cells whose centre lies in [x0, x1] x [y0, y1] (centre = lo + (i, j) * res)."""
    xs, ys = lo[0] + np.arange(n) * res, lo[1] + np.arange(n) * res
    return np.ix_((xs >= x0 - 1e-9) & (xs <= x1 + 1e-9), (ys >= y0 - 1e-9) & (ys <= y1 + 1e-9))


def grid_of(support, ceiling, lo, res, **kw):
    return grid_from_arrays(support, ceiling, lo, res, **kw)


def statuses(result):
    return {c['id']: c['status'] for c in result['checks']}


def node_goal(run):
    for line in (run / 'node.log').read_text(errors='replace').splitlines():
        if '"node_up"' in line:
            return json.loads(line[line.find('{'):])['goal']
    raise AssertionError('node_up not logged')


def load_route_source():
    """Flow route.py compiled from text: no import side effects, no bytecode cache in the reference tree."""
    module = types.ModuleType('flow_route_reference')
    exec(compile(ROUTE_SOURCE.read_text(), str(ROUTE_SOURCE), 'exec'), module.__dict__)
    return module


def write_npz(path, **arrays):
    with open(path, 'wb') as handle:
        np.savez_compressed(handle, **arrays)


def dump_arrays(n=241):
    support, ceiling, lo, res = blank(n)
    return dict(support=support, ceiling=ceiling, lo=lo, res=np.float64(res), boxes=json.dumps([]),
                stats=json.dumps({'points': 1}))


class IndexConventionTests(unittest.TestCase):
    def test_single_occupied_cell_lands_at_lo_plus_ij_times_res(self):
        support, ceiling, lo, res = blank(lo=(-6.0, -5.0))
        support[150, 90] = 1.0  # centre: x = -6 + 150 * 0.05 = 1.5, y = -5 + 90 * 0.05 = -0.5
        grid = grid_of(support, ceiling, lo, res)
        at = check_goal(grid, [-3, -3], [1.5, -0.5])
        self.assertEqual(statuses(at)['free'], 'block')
        self.assertIn('0.00 m from an obstacle', at['checks'][2]['detail'])
        self.assertEqual(statuses(check_goal(grid, [-3, -3], [1.5, -0.3]))['free'], 'block')   # 0.2 m away
        self.assertEqual(statuses(check_goal(grid, [-3, -3], [1.5, 0.0]))['free'], 'pass')     # 0.5 m away
        # The transposed reading (i along y) would put the obstacle at x = -6 + 90 * .05 = -1.5, y = 2.5.
        self.assertEqual(statuses(check_goal(grid, [-3, -3], [-1.5, 2.5]))['free'], 'pass')
        self.assertTrue(route_occupancy(grid)[150, 90])

    def test_round_trip_through_node_dump_file(self):
        support, ceiling, lo, res = blank(lo=(-6.0, -5.0))
        support[150, 90] = 1.0
        ceiling[40, 200] = 1.1
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'memory.npz'
            write_npz(path, support=support, ceiling=ceiling, lo=lo, res=np.float64(res),
                      boxes=json.dumps([{'center_xy': [1.5, -0.5], 'half_xy': [0.025, 0.025], 'yaw': 0.0,
                                         'z_bottom': 0.0, 'z_top': 1.0}]),
                      stats=json.dumps({'points': 3}))
            grid = load_grid(path)
        self.assertEqual(grid['n'], 241)
        self.assertEqual(grid['res'], 0.05)
        self.assertEqual(grid['basis'], 'planner memory')
        self.assertEqual(len(grid['sha256']), 64)
        self.assertEqual(grid['stats'], {'points': 3})
        self.assertEqual(grid['boxes'][0]['center_xy'], [1.5, -0.5])
        self.assertFalse(grid['support'].flags.writeable)
        # ceiling[40, 200] is at x = -6 + 2 = -4, y = -5 + 10 = 5 -> overhead block there only
        self.assertEqual(statuses(check_goal(grid, [0, 0], [-4.0, 4.5]))['overhead'], 'block')
        self.assertEqual(statuses(check_goal(grid, [0, 0], [4.5, -4.0]))['overhead'], 'pass')

    @unittest.skipUnless((RUNS / 'rt/mem-dds/node_memory.npz').is_file(), 'recorded DDS rehearsal unavailable')
    def test_recorded_flow_boxes_enclose_their_cells_only_in_ij_order(self):
        """Flow memory_boxes (in the dump) bound each seen ceiling component; check with both index readings."""
        grid = load_grid(RUNS / 'rt/mem-dds/node_memory.npz')
        lo, res = grid['lo'], grid['res']
        ii, jj = np.nonzero(np.isfinite(grid['ceiling']) & (grid['ceiling'] < 1e2))
        self.assertGreater(len(ii), 100)
        overhead = [b for b in grid['boxes'] if b['z_bottom'] >= 0.8]
        self.assertEqual(len(overhead), 2)

        def enclosed(xy):
            inside = np.zeros(len(xy), dtype=bool)
            for b in overhead:
                inside |= (np.abs(xy - b['center_xy']) <= np.array(b['half_xy']) + 1e-9).all(1)
            return inside.mean()

        # memory_boxes skips single-cell components (min_cells=2), so a few isolated cells stay outside.
        self.assertGreater(enclosed(np.c_[lo[0] + ii * res, lo[1] + jj * res]), 0.99)
        self.assertLess(enclosed(np.c_[lo[0] + jj * res, lo[1] + ii * res]), 0.2)


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.support, self.ceiling, self.lo, self.res = blank()

    def grid(self):
        return grid_of(self.support, self.ceiling, self.lo, self.res)

    def test_open_ground_passes_every_check_with_the_contract_shape(self):
        result = check_goal(self.grid(), [0, 0], [2, 1])
        self.assertEqual(set(result), CONTRACT_KEYS)
        self.assertEqual(tuple(c['id'] for c in result['checks']), CHECK_IDS)
        for check in result['checks']:
            self.assertEqual(set(check), {'id', 'status', 'label', 'detail'})
            self.assertEqual(check['status'], 'pass', check)
        self.assertTrue(result['ok'])
        self.assertAlmostEqual(result['straight_m'], math.hypot(2, 1))
        self.assertAlmostEqual(result['path_m'], math.hypot(2, 1))
        self.assertEqual(result['path_xy'], [[0.0, 0.0], [2.0, 1.0]])
        self.assertEqual(result['unknown_fraction'], 0.0)
        self.assertEqual(result['grid'], {'basis': 'planner memory', 'res_m': 0.05, 'observed_fraction': 1.0})
        json.dumps(result, allow_nan=False)

    def test_inside_blocks_outside_the_grid_and_inside_the_edge_margin(self):
        outside = check_goal(self.grid(), [0, 0], [7.0, 0])
        self.assertEqual(statuses(outside)['inside'], 'block')
        self.assertFalse(outside['ok'])
        self.assertEqual(statuses(outside)['reachable'], 'block')
        self.assertIn('cannot represent', outside['checks'][0]['detail'])
        json.dumps(outside, allow_nan=False)
        edge = check_goal(self.grid(), [0, 0], [5.7, 0])
        self.assertEqual(statuses(edge)['inside'], 'block')
        self.assertIn('0.30 m from the edge', edge['checks'][0]['detail'])
        self.assertEqual(statuses(check_goal(self.grid(), [0, 0], [5.4, 0]))['inside'], 'pass')
        self.assertEqual(statuses(check_goal(self.grid(), [0, 0], [5.7, 0], edge_margin_m=0.2))['inside'], 'pass')

    def test_seen_warns_on_an_unseen_goal_and_mostly_unseen_arrival_area(self):
        self.support[cells(self.lo, self.res, 241, 2.0, 4.0, -1.0, 1.0)] = np.nan
        unseen = check_goal(self.grid(), [0, 0], [3.0, 0])
        self.assertEqual(statuses(unseen)['seen'], 'warn')
        self.assertIn('has not seen this spot yet', unseen['checks'][1]['detail'])
        self.assertTrue(unseen['ok'])  # unseen is a warning, not a block
        # Goal cell seen (x = 1.95) but most of its arrival disc lies in the unseen block.
        edge = check_goal(self.grid(), [0, 0], [2.05, 0])
        self.assertEqual(statuses(edge)['seen'], 'warn')
        self.assertIn('the goal cell is unseen', edge['checks'][1]['detail'])
        partly = check_goal(self.grid(), [0, 0], [1.95, 0])
        self.assertEqual(statuses(partly)['seen'], 'pass')
        self.assertEqual(statuses(check_goal(self.grid(), [0, 0], [1.0, 0]))['seen'], 'pass')

    def test_free_blocks_tall_obstacles_and_warns_on_low_ones_and_the_route_margin(self):
        self.support[cells(self.lo, self.res, 241, 2.0, 2.2, -1.0, 1.0)] = 1.2   # wall, near face x = 2.0
        self.support[cells(self.lo, self.res, 241, -2.0, -1.9, 2.0, 2.1)] = 0.12  # low crate
        grid = self.grid()
        close = check_goal(grid, [0, 0], [1.85, 0])
        self.assertEqual(statuses(close)['free'], 'block')
        self.assertIn('0.15 m from an obstacle taller than the robot can step over', close['checks'][2]['detail'])
        self.assertFalse(close['ok'])
        margin = check_goal(grid, [0, 0], [1.68, 0])   # 0.32 m: beyond the robot radius, inside the 0.35 m margin
        self.assertEqual(statuses(margin)['free'], 'warn')
        self.assertIn("inside the route's 0.35 m margin", margin['checks'][2]['detail'])
        self.assertTrue(margin['ok'])
        low = check_goal(grid, [0, 0], [-2.0, 1.85])
        self.assertEqual(statuses(low)['free'], 'warn')
        self.assertIn('0.12 m high obstacle', low['checks'][2]['detail'])
        self.assertEqual(statuses(check_goal(grid, [0, 0], [1.5, 0]))['free'], 'pass')

    def test_overhead_mirrors_the_node_ceiling_rule(self):
        self.ceiling[cells(self.lo, self.res, 241, 2.0, 2.15, -1.0, 1.0)] = 1.2   # beam at 1.2 m
        self.ceiling[cells(self.lo, self.res, 241, -3.0, -2.85, -1.0, 1.0)] = 1.5  # beam above head height
        self.ceiling[cells(self.lo, self.res, 241, -1.0, -0.5, -3.0, -2.5)] = np.inf  # observed clear
        grid = self.grid()
        under = check_goal(grid, [0, 0], [2.0, 0])
        self.assertEqual(statuses(under)['overhead'], 'block')
        self.assertIn('standing up there drives the head into it', under['checks'][3]['detail'])
        self.assertEqual(statuses(check_goal(grid, [0, 0], [1.25, 0]))['overhead'], 'block')  # 0.75 m: in window
        self.assertEqual(statuses(check_goal(grid, [0, 0], [1.1, 0]))['overhead'], 'warn')    # 0.9 m: arrival ring
        self.assertEqual(statuses(check_goal(grid, [0, 0], [0.7, 0]))['overhead'], 'pass')    # 1.3 m: outside both
        self.assertEqual(statuses(check_goal(grid, [0, 0], [-3.0, 0]))['overhead'], 'pass')   # 1.5 m >= 1.35 m
        self.assertEqual(statuses(check_goal(grid, [0, 0], [-0.75, -2.75]))['overhead'], 'pass')
        # node.py uses a square window: a corner cell 0.75 m along both axes (1.06 m away) still counts.
        support, ceiling, lo, res = blank()
        ceiling[cells(lo, res, 241, 0.75, 0.75, 0.75, 0.75)] = 1.0
        self.assertEqual(statuses(check_goal(grid_of(support, ceiling, lo, res), [-2, -2], [0, 0]))['overhead'],
                         'block')
        # A route under the beam to a clear goal warns: the policy must duck, and a stand there would be deferred.
        through = check_goal(grid, [0, 0], [3.6, 0])
        self.assertEqual(statuses(through)['reachable'], 'warn')
        self.assertTrue(through['ok'])
        self.assertIn('must duck', through['checks'][4]['detail'])

    def test_reachable_goes_around_a_wall_and_blocks_behind_a_closed_one(self):
        self.support[cells(self.lo, self.res, 241, 1.5, 1.7, -2.0, 2.0)] = 1.5
        grid = self.grid()
        result = check_goal(grid, [0, 0], [3.0, 0])
        self.assertEqual(statuses(result)['reachable'], 'pass')
        self.assertTrue(result['ok'])
        self.assertGreater(result['path_m'], result['straight_m'] + 1.0)
        path = np.array(result['path_xy'])
        self.assertEqual(path[0].tolist(), [0.0, 0.0])
        self.assertEqual(path[-1].tolist(), [3.0, 0.0])
        # Line-of-sight pruning (Flow free_line samples every half cell) may clip corners of inflated cells, but
        # the route never comes closer to the wall than the robot radius.
        samples = goal_check._sample_path(path, 0.05)
        wi, wj = np.nonzero(self.support > 0.25)
        wall = np.c_[self.lo[0] + wi * 0.05, self.lo[1] + wj * 0.05]
        clearance = np.min(np.linalg.norm(samples[:, None] - wall[None], axis=2))
        self.assertGreater(clearance, 0.3)
        self.assertTrue(all(abs(y) > 2.0 for x, y in path[1:-1]))  # turns around a wall end
        # Close the wall across the whole map: no route.
        self.support[cells(self.lo, self.res, 241, 1.5, 1.7, -6.0, 6.0)] = 1.5
        closed = check_goal(self.grid(), [0, 0], [3.0, 0])
        self.assertEqual(statuses(closed)['reachable'], 'block')
        self.assertIn('No route', closed['checks'][4]['label'])
        self.assertIsNone(closed['path_xy'])
        self.assertIsNone(closed['path_m'])
        self.assertFalse(closed['ok'])
        json.dumps(closed, allow_nan=False)

    def test_low_and_overhead_obstacles_stay_off_the_route_grid(self):
        self.support[cells(self.lo, self.res, 241, 1.5, 1.7, -6.0, 6.0)] = 0.2      # steppable across the map
        self.ceiling[cells(self.lo, self.res, 241, 2.5, 2.7, -6.0, 6.0)] = 1.0      # overhead across the map
        result = check_goal(self.grid(), [0, 0], [4.0, 0])
        self.assertEqual(statuses(result)['reachable'], 'warn')   # under the 1.0 m overhead band: duck, no stand there
        self.assertTrue(result['ok'])
        self.assertAlmostEqual(result['path_m'], 4.0)

    def test_unknown_fraction_is_the_share_of_route_length_in_unseen_cells(self):
        self.support[cells(self.lo, self.res, 241, 1.0, 2.975, -6.0, 6.0)] = np.nan   # 2 m unseen band
        result = check_goal(self.grid(), [0, 0], [4.0, 0])
        self.assertAlmostEqual(result['unknown_fraction'], 0.5, delta=0.02)
        self.assertEqual(statuses(result)['reachable'], 'warn')
        self.assertIn('crosses space the robot has not seen', result['checks'][4]['detail'])
        self.assertTrue(result['ok'])
        short = check_goal(self.grid(), [0, 0], [1.2, 0])
        self.assertLess(short['unknown_fraction'], 0.3)
        self.assertEqual(statuses(short)['reachable'], 'pass')

    def test_unseen_cells_beside_a_seen_wall_grow_into_the_route_grid(self):
        """grow_unknown_m (node default 0.1 m) closes a 0.1 m unseen gap in a seen wall; 0 keeps it open."""
        self.support[cells(self.lo, self.res, 241, 1.5, 1.7, -6.0, 6.0)] = 1.5
        self.support[cells(self.lo, self.res, 241, 1.5, 1.7, -0.05, 0.05)] = np.nan
        self.support[cells(self.lo, self.res, 241, 1.75, 1.75, -0.05, 0.05)] = np.nan
        self.support[cells(self.lo, self.res, 241, 1.45, 1.45, -0.05, 0.05)] = np.nan
        grid = self.grid()
        self.assertEqual(statuses(check_goal(grid, [0, 0], [3, 0], inflate_m=0.0))['reachable'], 'block')
        self.assertEqual(statuses(check_goal(grid, [0, 0], [3, 0], inflate_m=0.0, grow_unknown_m=0.0))['reachable'],
                         'pass')

    def test_start_inside_the_margin_escapes_to_the_nearest_free_cell(self):
        self.support[cells(self.lo, self.res, 241, 0.2, 0.4, -2.0, 2.0)] = 1.5
        result = check_goal(self.grid(), [0, 0], [-2.0, 0])
        self.assertEqual(statuses(result)['reachable'], 'warn')
        self.assertIn('nearest free cell', result['checks'][4]['detail'])
        self.assertEqual(result['path_xy'][0], [0.0, 0.0])
        plan = plan_route(self.grid(), [0, 0], [-2.0, 0])
        self.assertTrue(plan['found'])
        # Wall face at x = 0.2 (cell 124), disc of 7 cells: the nearest free cell in the robot's row is x = -0.2.
        self.assertAlmostEqual(plan['start_shift_m'], 0.2, delta=1e-9)
        self.assertIn('0.20 m away', result['checks'][4]['detail'])

    def test_distance_warns_beyond_the_limit_and_inside_the_arrival_radius(self):
        far = check_goal(self.grid(), [0, 0], [3.0, 0], max_distance_m=2.5)
        self.assertEqual(statuses(far)['distance'], 'warn')
        self.assertIn('limit for this test is 2.50 m', far['checks'][5]['detail'])
        self.assertTrue(far['ok'])
        self.assertEqual(statuses(check_goal(self.grid(), [0, 0], [2.0, 0], max_distance_m=2.5))['distance'], 'pass')
        near = check_goal(self.grid(), [0, 0], [0.3, 0])
        self.assertEqual(statuses(near)['distance'], 'warn')
        self.assertIn('arrival radius', near['checks'][5]['detail'])

    def test_unknown_robot_position_blocks_reachability_and_never_reports_zero_distance(self):
        result = check_goal(self.grid(), None, [2.0, 0])
        self.assertEqual(statuses(result)['reachable'], 'block')
        self.assertEqual(statuses(result)['distance'], 'warn')
        self.assertIsNone(result['straight_m'])
        self.assertIsNone(result['robot_xy'])
        self.assertFalse(result['ok'])
        outside = check_goal(self.grid(), [8.0, 0], [2.0, 0])
        self.assertEqual(statuses(outside)['reachable'], 'block')

    def test_malformed_inputs_raise(self):
        grid = self.grid()
        for goal in (None, [1], [1, 2, 3], [float('nan'), 0], [True, 0], 'ab', [1e9, 0]):
            with self.assertRaises(ValueError):
                check_goal(grid, [0, 0], goal)
        with self.assertRaises(ValueError):
            check_goal(grid, [0, 0], [1, 0], inflate_m=-1)
        with self.assertRaises(ValueError):
            check_goal(grid, [0, 0], [1, 0], max_distance_m=float('inf'))
        with self.assertRaises(ValueError):
            check_goal({'support': 1}, [0, 0], [1, 0])

    def test_basis_comes_from_the_grid_unless_given(self):
        grid = grid_of(self.support, self.ceiling, self.lo, self.res, basis='Studio reconstruction')
        self.assertEqual(check_goal(grid, [0, 0], [1, 0])['grid']['basis'], 'Studio reconstruction')
        self.assertEqual(check_goal(grid, [0, 0], [1, 0], basis='other')['grid']['basis'], 'other')

    def test_path_is_decimated_to_200_points(self):
        path = np.c_[np.arange(1000.0), np.zeros(1000)]
        out = goal_check._decimate(path)
        self.assertLessEqual(len(out), 200)
        self.assertEqual(out[0].tolist(), [0.0, 0.0])
        self.assertEqual(out[-1].tolist(), [999.0, 0.0])


class SpeedTests(unittest.TestCase):
    def assert_fast(self, support, robot, goal, limit_s=0.3):
        support_, ceiling, lo, res = blank()
        grid = grid_of(support, ceiling, lo, res)
        check_goal(grid, robot, goal)  # warm
        start = time.perf_counter()
        result = check_goal(grid, robot, goal)
        elapsed = time.perf_counter() - start
        self.assertLess(elapsed, limit_s, f'{elapsed * 1000:.0f} ms')
        return result

    def test_worst_cases_on_a_241_grid_finish_under_300_ms(self):
        support, _, lo, res = blank()
        # Enclosed goal: A* floods every reachable cell before giving up.
        enclosed = support.copy()
        enclosed[cells(lo, res, 241, 2.0, 4.0, 2.0, 2.1)] = 1.0
        enclosed[cells(lo, res, 241, 2.0, 4.0, 3.9, 4.0)] = 1.0
        enclosed[cells(lo, res, 241, 2.0, 2.1, 2.0, 4.0)] = 1.0
        enclosed[cells(lo, res, 241, 3.9, 4.0, 2.0, 4.0)] = 1.0
        result = self.assert_fast(enclosed, [-5, -5], [3, 3])
        self.assertEqual(statuses(result)['reachable'], 'block')
        # U-shaped trap facing the robot: the goal sits behind its closed end.
        trap = support.copy()
        trap[cells(lo, res, 241, 1.0, 1.1, -5.0, 5.0)] = 1.0
        trap[cells(lo, res, 241, -5.0, 1.0, 5.0, 5.1)] = 1.0
        trap[cells(lo, res, 241, -5.0, 1.0, -5.1, -5.0)] = 1.0
        result = self.assert_fast(trap, [0, 0], [3, 0])
        self.assertEqual(statuses(result)['reachable'], 'pass')
        self.assertGreater(result['path_m'], 12)
        # Wall across the map: half the grid is explored.
        split = support.copy()
        split[cells(lo, res, 241, 1.0, 1.1, -6.0, 6.0)] = 1.0
        self.assertEqual(statuses(self.assert_fast(split, [-3, 0], [3, 0]))['reachable'], 'block')

    def test_large_grids_search_on_pooled_blocks(self):
        support, ceiling, lo, res = blank(n=1201, res=0.02, lo=(-12.0, -12.0))
        support[cells(lo, res, 1201, 1.0, 1.2, -5.0, 5.0)] = 1.0
        grid = grid_of(support, ceiling, lo, res)
        start = time.perf_counter()
        result = check_goal(grid, [0, 0], [3, 0])
        self.assertLess(time.perf_counter() - start, 3.0)
        self.assertEqual(statuses(result)['reachable'], 'pass')
        self.assertIn('Searched at 0.06 m blocks', result['checks'][4]['detail'])
        self.assertGreater(result['path_m'], 10)


class LoadGridTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'memory.npz'

    def tearDown(self):
        self.tmp.cleanup()

    def rejects(self, message=None, **changes):
        arrays = dump_arrays()
        arrays.update(changes)
        arrays = {k: v for k, v in arrays.items() if v is not None}
        write_npz(self.path, **arrays)
        with self.assertRaises(ValueError) as caught:
            load_grid(self.path)
        if message:
            self.assertIn(message, str(caught.exception))

    def test_valid_dump_loads(self):
        write_npz(self.path, **dump_arrays())
        grid = load_grid(self.path)
        self.assertEqual(set(grid), {'support', 'ceiling', 'lo', 'res', 'n', 'boxes', 'stats', 'basis', 'source',
                                     'sha256'})
        self.assertEqual(grid['boxes'], [])
        self.assertEqual(grid['source'], str(self.path))

    def test_malformed_dumps_are_rejected(self):
        self.rejects('square', support=np.zeros((241, 240)), ceiling=np.zeros((241, 240)))
        self.rejects('same shape', ceiling=np.zeros((240, 240)))
        self.rejects('square 2-D', support=np.zeros((5, 5, 5)))
        self.rejects('floating', support=np.zeros((241, 241), dtype=np.int64))
        self.rejects('bounded size', support=np.zeros((1203, 1203)), ceiling=np.zeros((1203, 1203)))
        with self.assertRaises(ValueError) as caught:
            grid_from_arrays(np.zeros((1202, 1202)), np.zeros((1202, 1202)), [0, 0], 0.05)
        self.assertIn('side', str(caught.exception))
        with self.assertRaises(ValueError):
            grid_from_arrays(np.zeros((2, 2)), np.zeros((2, 2)), [0, 0], 0.05)
        self.rejects('res', res=np.float64(0.001))
        self.rejects('res', res=np.float64(1.0))
        self.rejects('res', res=np.float64(np.nan))
        self.rejects('lo', lo=np.array([np.nan, 0.0]))
        self.rejects('lo', lo=np.array([0.0, 0.0, 0.0]))
        self.rejects('lacks support', support=None)
        self.rejects('lacks res', res=None)
        self.rejects('finite or NaN', support=np.full((241, 241), np.inf))
        self.rejects('ceiling', ceiling=np.full((241, 241), -np.inf))
        self.rejects('JSON', boxes='not json')
        self.rejects('non-JSON number', stats='{"x": NaN}')
        self.rejects('JSON string', boxes=np.zeros(3))
        self.rejects('box', boxes=json.dumps([{'center_xy': [0, 0]}]))
        self.rejects('stats', stats=json.dumps([1, 2]))

    def test_pickled_object_arrays_are_refused(self):
        arrays = dump_arrays()
        arrays['boxes'] = np.array([{'evil': 1}], dtype=object)
        np.savez(self.path, **arrays)
        with self.assertRaises(ValueError):
            load_grid(self.path)

    def test_non_npz_and_oversized_files_are_refused(self):
        self.path.write_bytes(b'not a zip archive')
        with self.assertRaises(ValueError):
            load_grid(self.path)
        np.save(self.path.with_suffix('.npy'), np.zeros(3))
        with self.assertRaises(ValueError):
            load_grid(self.path.with_suffix('.npy'))
        write_npz(self.path, **dump_arrays())
        with patch.object(goal_check, 'MAX_FILE_BYTES', 100):
            with self.assertRaises(ValueError):
                load_grid(self.path)
        with self.assertRaises(FileNotFoundError):
            load_grid(Path(self.tmp.name) / 'missing.npz')

    def test_members_that_expand_beyond_their_bound_are_refused_before_reading(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in dump_arrays().items():
                if name == 'lo':
                    continue
                data = io.BytesIO()
                np.save(data, value)
                archive.writestr(name + '.npy', data.getvalue())
            archive.writestr('lo.npy', b'\0' * (goal_check.MAX_MEMBER_BYTES['lo'] + 1))
        self.path.write_bytes(buffer.getvalue())
        with self.assertRaises(ValueError) as caught:
            load_grid(self.path)
        self.assertIn('bounded size', str(caught.exception))


@unittest.skipUnless(ROUTE_SOURCE.is_file(), 'frozen Flow route source unavailable')
class FlowRouteParityTests(unittest.TestCase):
    """Studio's A* and line-of-sight pruning reproduce Flow ``Route._plan`` on the same routing grid."""

    @classmethod
    def setUpClass(cls):
        cls.route = load_route_source()

    def reference(self, grid, start, goal):
        r = self.route.Route.__new__(self.route.Route)
        r.start, r.goal = np.asarray(start, float), np.asarray(goal, float)
        r.res, r.lo = grid['res'], np.array(grid['lo'])
        r.occupied = route_occupancy(grid)
        r.shape = r.occupied.shape
        path = r._plan()
        return path, r._found

    def assert_same(self, grid, start, goal):
        path, found = self.reference(grid, start, goal)
        mine = plan_route(grid, start, goal)
        self.assertEqual(mine['found'], found)
        if found:
            np.testing.assert_allclose(mine['path_xy'], path)

    def test_synthetic_walls(self):
        support, ceiling, lo, res = blank()
        support[cells(lo, res, 241, 1.5, 1.7, -2.0, 2.0)] = 1.5
        support[cells(lo, res, 241, -1.0, 3.0, 2.5, 2.7)] = 1.5
        support[cells(lo, res, 241, 3.0, 3.2, -4.0, 0.5)] = 1.5
        grid = grid_of(support, ceiling, lo, res)
        rng = np.random.default_rng(3)
        for _ in range(20):
            self.assert_same(grid, rng.uniform(-4, 0, 2), rng.uniform(-5, 5, 2))
        self.assert_same(grid, [1.4, 0.0], [4.5, 0.0])   # start inside the margin

    @unittest.skipUnless(RUNS.is_dir(), 'recorded runs unavailable')
    def test_recorded_memories(self):
        dumps = sorted(RUNS.glob('*/*/node_memory.npz'))
        self.assertTrue(dumps)
        rng = np.random.default_rng(7)
        for path in dumps:
            grid = load_grid(path)
            centre = grid['lo'] + (grid['n'] - 1) * grid['res'] / 2
            for _ in range(3):
                with self.subTest(dump=str(path.relative_to(RUNS))):
                    self.assert_same(grid, centre + rng.uniform(-1, 1, 2), centre + rng.uniform(-4.5, 4.5, 2))


PARITY_SCRIPT = r'''
import sys, types
sys.dont_write_bytecode = True
import numpy as np
sys.path.insert(0, sys.argv[1])
from studio.goal_check import load_grid, plan_route, route_occupancy
source = sys.argv[2]
route = types.ModuleType("flow_route_reference")
exec(compile(open(source).read(), source, "exec"), route.__dict__)
rng = np.random.default_rng(11)
bad = 0
count = 0
for path in sys.argv[3:]:
    grid = load_grid(path)
    memory = types.SimpleNamespace(support=np.array(grid["support"]), res=grid["res"], lo=np.array(grid["lo"]), n=grid["n"])
    centre = grid["lo"] + (grid["n"] - 1) * grid["res"] / 2
    for grow in (0.0, 0.1):
        start, goal = centre + rng.uniform(-1, 1, 2), centre + rng.uniform(-4.5, 4.5, 2)
        ref = route.SensorRoute(start, goal, memory, grow_unknown_m=grow)
        mine = plan_route(grid, start, goal, grow_unknown_m=grow)
        count += 1
        same = np.array_equal(route_occupancy(grid, grow_unknown_m=grow), ref.occupied) and ref.found == mine["found"]
        same = same and (not ref.found or (ref.path.shape == mine["path_xy"].shape and np.allclose(ref.path, mine["path_xy"])))
        bad += not same
print(count, bad)
'''


@unittest.skipUnless(os.environ.get('STUDIO_INTEGRATION') == '1' and DEPLOY_PYTHON.exists() and ROUTE_SOURCE.is_file(),
                     'set STUDIO_INTEGRATION=1 (needs the deploy interpreter with scipy)')
class SensorRouteScipyParityTests(unittest.TestCase):
    def test_route_grid_and_path_match_sensor_route_with_scipy(self):
        dumps = [str(p) for p in sorted(RUNS.glob('*/*/node_memory.npz'))]
        out = subprocess.run([str(DEPLOY_PYTHON), '-I', '-B', '-c', PARITY_SCRIPT, str(ROOT), str(ROUTE_SOURCE), *dumps],
                             capture_output=True, text=True, timeout=300, check=True,
                             env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1', CUDA_VISIBLE_DEVICES=''))
        count, bad = map(int, out.stdout.split())
        self.assertEqual(count, 2 * len(dumps))
        self.assertEqual(bad, 0)


@unittest.skipUnless((RUNS / 'rt/mem-dds/node_memory.npz').is_file(), 'recorded rehearsals unavailable')
class RecordedMemoryTests(unittest.TestCase):
    def test_recorded_goal_on_the_beam_course_passes(self):
        run = RUNS / 'rt/mem-dds'
        grid = load_grid(run / 'node_memory.npz')
        start = grid['lo'] + (grid['n'] - 1) * grid['res'] / 2   # the memory is centred on the boot pose
        result = check_goal(grid, start, node_goal(run))
        self.assertTrue(result['ok'], result['checks'])
        self.assertIn('must duck', result['checks'][4]['detail'])   # two beams at 1.11 / 1.22 m on the way
        json.dumps(result, allow_nan=False)
        # Standing goal under the first beam (x ~ 1.34 m) is blocked, as node.py defers its stand there.
        under = check_goal(grid, start, [1.34, 0.04])
        self.assertEqual(statuses(under)['overhead'], 'block')

    @unittest.skipUnless((RUNS / 'g5-dds/detour-100/node_memory.npz').is_file(), 'detour rehearsal unavailable')
    def test_recorded_detour_routes_around_the_wall(self):
        run = RUNS / 'g5-dds/detour-100'
        grid = load_grid(run / 'node_memory.npz')
        start = grid['lo'] + (grid['n'] - 1) * grid['res'] / 2
        goal = node_goal(run)
        result = check_goal(grid, start, goal)
        # The route may pass the wall's low 'ceiling' cells (its top edge filed as overhead): then it warns.
        self.assertIn(statuses(result)['reachable'], ('pass', 'warn'))
        self.assertIsNotNone(result['path_m'])
        self.assertGreater(result['path_m'], result['straight_m'] + 0.2)
        wall = check_goal(grid, start, [2.27, 0.1])   # the true wall centre
        self.assertEqual(statuses(wall)['free'], 'block')


if __name__ == '__main__':
    unittest.main()
