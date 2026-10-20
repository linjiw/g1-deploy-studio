"""Robustness-campaign support: latency model, scenario reuse, post-hoc metrics, torque tracking."""
import math
import tempfile
import unittest
from unittest.mock import patch

import mujoco
import numpy as np

from studio import workbench as wb
from studio.policy_worker import TorqueTracker, validate_latency


class Catalog:
    def __init__(self):
        self.registered = {}

    def register(self, key, path, label, provider=None, extra=None):
        self.registered[key] = path

    def session(self, key):
        raise KeyError(key)


def rows_toward(goal, ticks, speed=0.5, dt=.02, contact=None, z=0.75, tilt_q=None):
    out, x = [], 0.0
    for i in range(ticks):
        x = min(goal[0], x + speed * dt)
        q = [x, 0.0, z, 1, 0, 0, 0] if tilt_q is None else [x, 0.0, z, *tilt_q]
        out.append({'time': i * dt, 'qpos': q, 'health': {'contact_force_n': (contact or {}).get(i, 0.0)}})
    return out


class TrajectoryMetricsTests(unittest.TestCase):
    def test_reach_post_hoc_requires_hold_inside_radius(self):
        rows = rows_toward([2.0, 0.0], 400)
        m = wb.trajectory_metrics(rows, [0, 0], [2.0, 0.0])
        self.assertTrue(m['reach_post_hoc']['reached'])
        # Row i is at x = 0.01 (i + 1): enters 0.4 m at row 159 (t = 3.18 s); a 0.1 s hold is 5 rows.
        self.assertAlmostEqual(m['first_entry_s']['0.4'], 3.18, places=6)
        self.assertAlmostEqual(m['reach_post_hoc']['time_s'], 3.26, places=6)
        self.assertAlmostEqual(m['path_efficiency'], 1.0, places=6)
        self.assertIn('Not the source scorer', m['reach_post_hoc']['basis'])

    def test_contact_above_flow_threshold_blocks_reach(self):
        rows = rows_toward([2.0, 0.0], 400, contact={50: 6.0})
        m = wb.trajectory_metrics(rows, [0, 0], [2.0, 0.0])
        self.assertFalse(m['reach_post_hoc']['reached'])
        self.assertEqual(m['reach_post_hoc']['blocked_by'], 'obstacle_contact')
        self.assertAlmostEqual(m['first_contact_s'], 1.0)

    def test_fall_blocks_reach_and_short_rows_are_tolerated(self):
        tilted = [math.cos(.5), math.sin(.5), 0, 0]  # 1.0 rad roll > 0.8 rad
        m = wb.trajectory_metrics(rows_toward([2.0, 0.0], 400, tilt_q=tilted), [0, 0], [2.0, 0.0])
        self.assertEqual(m['reach_post_hoc']['blocked_by'], 'fall')
        short = [{'time': i * .02, 'qpos': [i * .01, 0.0]} for i in range(300)]
        m = wb.trajectory_metrics(short, [0, 0], [2.0, 0.0])
        self.assertIsNone(m['max_tilt_rad'])
        self.assertIsNone(m['min_height_m'])
        self.assertTrue(m['reach_post_hoc']['reached'])

    def test_no_rows_or_goal_gives_none(self):
        self.assertIsNone(wb.trajectory_metrics([], [0, 0], [1, 0]))
        self.assertIsNone(wb.trajectory_metrics(rows_toward([1, 0], 10), [0, 0], None))


class PathEfficiencyBoundTests(unittest.TestCase):
    def test_stopping_short_of_the_goal_never_exceeds_one(self):
        # Straight walk from x=0 that stops 0.15 m before a goal 2 m away (review L2: ratio was 2.0/1.85 > 1).
        n = 94
        rows = [{'time': i * .02, 'qpos': [1.85 * i / (n - 1), 0.0, .75, 1, 0, 0, 0], 'health': {'contact_force_n': 0.0}} for i in range(n)]
        m = wb.trajectory_metrics(rows, [0, 0], [2.0, 0.0])
        self.assertAlmostEqual(m['path_efficiency'], 1.0, places=6)
        detour = rows + [{'time': n * .02, 'qpos': [1.85, 0.5, .75, 1, 0, 0, 0], 'health': {'contact_force_n': 0.0}}]
        self.assertLess(wb.trajectory_metrics(detour, [0, 0], [2.0, 0.0])['path_efficiency'], 1.0)


class LatencyAndReuseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        bundle = {'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle', 'limits': {'candidates': [1, 16], 'ode_steps': [1, 10]},
                  'planner': {'deployed_budget': {'candidates': 16, 'ode_steps': 10}}, 'limitations': []}
        flow = dict(bundle, id='flow-wx-rf-abcdef0-s0', loader='flow-callback')
        profiles = {p['id']: p for p in (bundle, flow)}
        stub = lambda key: profiles[key] if key in profiles else (_ for _ in ()).throw(ValueError('Unknown policy profile'))
        for target in ('studio.policies.get_profile',):
            patcher = patch(target, side_effect=stub)
            patcher.start()
            self.addCleanup(patcher.stop)
        with patch.object(wb, 'development_maps', return_value=[]):
            self.w = wb.Workbench(Catalog(), self.tmp.name)

    def request(self, **kw):
        base = {'label': 'Latency test', 'backend_id': 'flow-sonic-cpu', 'map_id': 'flat-ground', 'goal_xy': [2, 0],
                'start_xy': [0, 0], 'duration_s': 4, 'seed': 0, 'planner': {'candidates': 4, 'ode_steps': 6}}
        base.update(kw)
        return base

    def test_latency_defaults_rounds_to_ticks_and_validates(self):
        self.assertEqual(self.w.prepare(self.request())['latency'], {'ms': 0, 'anchor': 'measured'})
        self.assertEqual(self.w.prepare(self.request(latency={'ms': 210}))['latency'], {'ms': 220, 'anchor': 'measured'})
        self.assertEqual(self.w.prepare(self.request(latency={'ms': 200, 'anchor': 'predict'}))['latency']['anchor'], 'predict')
        for bad in ({'ms': -1}, {'ms': 1001}, {'ms': 100, 'anchor': 'future'}, {'ms': 100, 'anchor': ['predict']}, [], 'x'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.w.prepare(self.request(latency=bad))

    def test_flow_callback_predictive_anchor_rules(self):
        wx = 'flow-wx-rf-abcdef0-s0'
        # Studio's latency-aware adapter for the Flow callback (studio/latency_anchor.py).
        self.assertEqual(self.w.prepare(self.request(policy_id=wx, latency={'ms': 200, 'anchor': 'predict'}))['latency'],
                         {'ms': 200, 'anchor': 'predict'})
        self.assertEqual(self.w.prepare(self.request(policy_id=wx, latency={'ms': 15, 'anchor': 'predict'}))['latency'],
                         {'ms': 20, 'anchor': 'predict'})
        self.assertEqual(self.w.prepare(self.request(policy_id=wx, latency={'ms': 200}))['latency'], {'ms': 200, 'anchor': 'measured'})
        for ms in (0, 5, 9.99):  # rounds to 0 ticks: a predictive anchor without latency is refused for WX
            with self.subTest(ms=ms), self.assertRaisesRegex(ValueError, 'at least one 20 ms tick'):
                self.w.prepare(self.request(policy_id=wx, latency={'ms': ms, 'anchor': 'predict'}))
        # The bundle keeps its source behaviour (predict at 0 ms is accepted and ignored by run_episode).
        # The bundle source ignores the anchor without latency: normalised so identical physics share one group.
        self.assertEqual(self.w.prepare(self.request(latency={'ms': 0, 'anchor': 'predict'}))['latency'], {'ms': 0, 'anchor': 'measured'})
        measured = self.w.save_scenario(self.request(policy_id=wx, latency={'ms': 200, 'anchor': 'measured'}))
        predicted = self.w.save_scenario(self.request(policy_id=wx, latency={'ms': 200, 'anchor': 'predict'}))
        self.assertNotEqual(measured['scenario']['id'], predicted['scenario']['id'], 'anchors are distinct scenarios')

    def test_identical_scenarios_are_reused(self):
        first = self.w.save_scenario(self.request())
        again = self.w.save_scenario(self.request())
        self.assertEqual(first['scenario']['id'], again['scenario']['id'])
        self.assertTrue(again.get('reused'))
        other = self.w.save_scenario(self.request(seed=1))
        self.assertNotEqual(other['scenario']['id'], first['scenario']['id'])
        self.assertEqual(len(self.w.scenarios), 2)

    def test_worker_latency_contract(self):
        self.assertEqual(validate_latency(None), {'ms': 0, 'anchor': 'measured'})
        self.assertEqual(validate_latency({'ms': 170}), {'ms': 180, 'anchor': 'measured'})
        for bad in ({'ms': 2000}, {'anchor': ['measured']}, 5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_latency(bad)


class TorqueTrackerTests(unittest.TestCase):
    XML = """<mujoco><worldbody><body><joint name="a" type="hinge" actuatorfrcrange="-88 88"/><geom size=".1"/>
             <body><joint name="b" type="hinge"/><geom size=".1"/></body></body></worldbody>
             <actuator><motor joint="a"/><motor joint="b"/></actuator></mujoco>"""

    def test_peak_and_saturation_against_model_limit(self):
        model = mujoco.MjModel.from_xml_string(self.XML)
        tracker = TorqueTracker(np, model, ['a', 'b'])
        for torque in ([50, 500], [-120, 10], [90, -5]):
            tracker.observe(torque)
        tracker.end_tick()
        tracker.observe([10, 10])
        tracker.end_tick()
        summary = tracker.summary([139, 139])
        self.assertEqual(summary['peak_commanded_nm'], {'a': 120.0, 'b': 500.0})
        self.assertEqual(summary['model_limit_nm'], {'a': 88.0, 'b': None})  # unlimited joints are never "saturated"
        self.assertEqual(summary['saturated_substeps'], {'a': 2})
        self.assertEqual(summary['total_substeps'], 4)
        self.assertEqual(len(tracker.rows), 2)
        self.assertEqual(tracker.rows[1].tolist(), [10.0, 10.0])


if __name__ == '__main__':
    unittest.main()
