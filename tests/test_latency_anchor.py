"""Latency anchoring for the Flow callback worker: prediction math and delayed-execution scheduling.

Pure numpy; no Flow, Torch or simulator. Parity with g1-student-deploy's own
``g1deploy/latency.py`` is checked when that read-only reference is present.
"""
import importlib.util
import math
from pathlib import Path
import unittest

import numpy as np

from studio import latency_anchor as la

SOURCE = Path('/home/linjiw/code/g1-student-deploy/g1deploy/latency.py')


def yaw_q(yaw, pitch=0.0):
    """wxyz quaternion for yaw (about z) then pitch (about the body y axis)."""
    qz = np.array([math.cos(yaw / 2), 0, 0, math.sin(yaw / 2)])
    qy = np.array([math.cos(pitch / 2), 0, math.sin(pitch / 2), 0])
    return la.quat_mul(qz, qy)


def rotation(q):
    w, x, y, z = np.asarray(q, dtype=np.float64) / np.linalg.norm(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def walking_plan(n=50, speed=1.0, pitch=0.0):
    """Frame i (state at anchor + i + 1 ticks): straight +x walk at `speed` m/s, heading 0."""
    q = np.zeros((n, 36))
    for i in range(n):
        q[i, 0] = speed * la.DT * (i + 1)
        q[i, 2] = 0.75 + 0.001 * i
        q[i, 3:7] = yaw_q(0.0, pitch)
        q[i, 7:] = 0.01 * i + np.arange(29) * 1e-3
    return {'qpos': q}


def measured_frame(xy, yaw, z=0.74, joints=0.5):
    q = np.zeros(36)
    q[:2], q[2], q[3:7], q[7:] = xy, z, yaw_q(yaw), joints
    return q.astype(np.float32)


class PredictionMathTests(unittest.TestCase):
    def test_plan_frame_indexing_anchor_and_clamp(self):
        plan, anchor = walking_plan(n=10), np.full(36, 7.0)
        np.testing.assert_array_equal(la.plan_frame(plan, 5, anchor, 5), anchor)  # at the anchor tick
        np.testing.assert_array_equal(la.plan_frame(plan, 5, anchor, 3), anchor)  # before it
        np.testing.assert_array_equal(la.plan_frame(plan, 5, anchor, 6), plan['qpos'][0])  # frame 0 = anchor + 1 tick
        np.testing.assert_array_equal(la.plan_frame(plan, 5, anchor, 12), plan['qpos'][6])
        np.testing.assert_array_equal(la.plan_frame(plan, 5, anchor, 99), plan['qpos'][-1])  # held after the end

    def test_prediction_reposes_the_landed_plan_onto_the_measured_pose(self):
        plan = walking_plan()
        tick, lead, n = 8, 10, 6
        meas = [measured_frame([1.0, 2.0], math.pi / 2)] * 6
        hist = la.predicted_history(meas, (plan, 0, np.zeros(36)), tick, lead, n)
        self.assertEqual(len(hist), n)
        self.assertTrue(all(h.dtype == np.float32 for h in hist))
        plan_now = plan['qpos'][tick - 1]  # the plan's own pose at the request tick
        for k, tau in enumerate(range(tick + lead - n + 1, tick + lead + 1)):  # all six frames are after the request
            src = plan['qpos'][tau - 1]
            d = src[:2] - plan_now[:2]  # +x along the plan ...
            expected_xy = np.array([1.0, 2.0]) + np.array([-d[1], d[0]])  # ... becomes +y after a +90 deg re-pose
            np.testing.assert_allclose(hist[k][:2], expected_xy, atol=1e-6)
            self.assertAlmostEqual(la.yaw_wxyz(hist[k][3:7]), math.pi / 2, places=5)
            self.assertAlmostEqual(float(hist[k][2]), src[2], places=6)  # root height from the plan
            np.testing.assert_allclose(hist[k][7:], src[7:], atol=1e-6)  # joints from the plan, not the measured 0.5
        # The prediction ends L ticks ahead: 10 ticks at 1 m/s from (1, 2) heading +y.
        np.testing.assert_allclose(hist[-1][:2], [1.0, 2.0 + 0.2], atol=1e-6)

    def test_frames_up_to_the_request_tick_stay_measured(self):
        plan = walking_plan()
        meas = [measured_frame([0.1 * k, 0.0], 0.0, joints=k) for k in range(6)]  # ticks 3..8
        hist = la.predicted_history(meas, (plan, 0, np.zeros(36)), 8, 2, 6)
        for k in range(4):  # ticks 5..8 are measured frames, copied exactly
            np.testing.assert_array_equal(hist[k], meas[k + 2])
        self.assertEqual(float(hist[4][7]), np.float32(plan['qpos'][8, 7]))  # tick 9 = plan frame 8

    def test_roll_pitch_kept_and_only_heading_rotated(self):
        plan = walking_plan(pitch=0.2)
        hist = la.predicted_history([measured_frame([0, 0], 1.0)] * 6, (plan, 0, np.zeros(36)), 4, 10, 6)
        r_plan, r_pred = rotation(plan['qpos'][12, 3:7]), rotation(hist[-1][3:7])
        rz = rotation([math.cos(.5), 0, 0, math.sin(.5)])  # dyaw = 1.0 rad
        np.testing.assert_allclose(r_pred, rz @ r_plan, atol=1e-6)

    def test_anchor_error_and_yaw_wrap(self):
        p = measured_frame([1.0, 1.0], math.pi - 0.01, z=0.70, joints=0.1)
        m = measured_frame([1.3, 1.4], -math.pi + 0.01, z=0.75, joints=0.2)
        e = la.anchor_error(p, m)
        self.assertAlmostEqual(e['xy_m'], 0.5, places=5)
        self.assertAlmostEqual(e['yaw_rad'], 0.02, places=4)
        self.assertAlmostEqual(e['root_z_m'], 0.05, places=5)
        self.assertAlmostEqual(e['joint_rmse_rad'], 0.1, places=5)

    def test_summary_quantiles(self):
        self.assertIsNone(la.summarize_errors([None, {}]))
        rows = [{'xy_m': v, 'yaw_rad': 0.0, 'root_z_m': 0.0, 'joint_rmse_rad': 0.0} for v in (0.1, 0.2, 0.3)]
        s = la.summarize_errors(rows + [None])
        self.assertEqual(s['landed_plans'], 3)
        self.assertAlmostEqual(s['xy_m']['p50'], 0.2)
        self.assertAlmostEqual(s['xy_m']['max'], 0.3)

    def test_finite_difference_matches_flow_definition(self):
        hist = [np.full(36, 1.0, np.float32), np.full(36, 1.5, np.float32)]
        dq = la.finite_difference_dq(hist)
        self.assertEqual(dq.shape, (29,))
        np.testing.assert_allclose(dq, 25.0)  # 0.5 rad / 20 ms


@unittest.skipUnless(SOURCE.is_file(), 'g1-student-deploy reference not present')
class ParityWithSourceTests(unittest.TestCase):
    """Studio's prediction is bit-identical to g1-student-deploy's predictive anchoring."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('_g1deploy_latency_reference', SOURCE)  # read-only, private name
        cls.src = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.src)

    def test_random_plans_and_offsets(self):
        rng = np.random.default_rng(7)
        for trial in range(60):
            n_plan = int(rng.integers(5, 60))
            q = rng.normal(size=(n_plan, 36))
            q[:, 3:7] /= np.linalg.norm(q[:, 3:7], axis=1, keepdims=True)
            plan = {'qpos': q}
            anchor_q = rng.normal(size=36)
            anchor_q[3:7] /= np.linalg.norm(anchor_q[3:7])
            meas = [x.astype(np.float32) for x in rng.normal(size=(6, 36))]
            for m in meas:
                m[3:7] /= np.linalg.norm(m[3:7])
            anchor_tick = int(rng.integers(0, 30))
            tick = anchor_tick + int(rng.integers(-2, 70))  # includes pre-anchor and past-the-end offsets
            lead, n = int(rng.integers(1, 16)), int(rng.integers(2, 7))
            active = (plan, anchor_tick, anchor_q, None)
            ours = la.predicted_history(meas, active, tick, lead, n)
            theirs = self.src.predicted_history(meas, active, tick, lead, n)
            with self.subTest(trial=trial):
                self.assertEqual(len(ours), len(theirs))
                for a, b in zip(ours, theirs):
                    np.testing.assert_array_equal(a, b)
                np.testing.assert_array_equal(la.plan_frame(plan, anchor_tick, anchor_q, tick),
                                              self.src.plan_frame(plan, anchor_tick, anchor_q, tick))


def legacy_wrapper(latency_ticks):
    """The delayed-execution wrapper as it was before predictive anchoring (reference for 'measured')."""
    delayed = {'last': None, 'executing': None, 'pending': []}

    def args(plan, anchor_q, anchor_dq, elapsed, tick):
        if plan is not delayed['last']:
            delayed['last'] = plan
            entry = (plan, np.array(anchor_q, copy=True), np.array(anchor_dq, copy=True), tick - int(elapsed))
            if delayed['executing'] is None:
                delayed['executing'] = entry
            else:
                delayed['pending'].append((entry[3] + latency_ticks, entry))
        while delayed['pending'] and delayed['pending'][0][0] <= tick:
            delayed['executing'] = delayed['pending'].pop(0)[1]
        plan, anchor_q, anchor_dq, request_tick = delayed['executing']
        return plan, anchor_q, anchor_dq, tick - request_tick
    return args


class FakeCallback:
    """Callback-shaped driver: replans on a cadence and calls plan_target every tick."""

    def __init__(self, cadence, ticks=120):
        self.cadence, self.ticks = cadence, ticks

    def run(self, on_tick, plan_hook=None, bind=None):
        """plan_hook(history, tick) stands for the FlowPlanner.plan wrapper; bind(plan) for its post-plan step."""
        plan, plan_tick, history = None, -1, []
        for tick in range(self.ticks):
            measured = measured_frame([0.01 * tick, 0.002 * tick], 0.003 * tick, joints=0.001 * tick)
            history = (history + [measured])[-6:]
            if len(history) < 6:
                history = [history[0]] * (6 - len(history)) + history
            due = self.cadence(len(on_tick.plans)) if callable(self.cadence) else self.cadence
            if plan is None or tick - plan_tick >= due:
                inputs = plan_hook(np.asarray(history), tick) if plan_hook else None
                plan = walking_plan(n=50)
                plan['id'] = tick
                plan['inputs'] = inputs
                if bind:
                    bind(plan)
                on_tick.plans.append(plan)
                plan_tick = tick
                anchor_q, anchor_dq = measured.astype(np.float64), la.finite_difference_dq(history)
            on_tick(tick, plan, anchor_q, anchor_dq, tick - plan_tick)


class Recorder:
    def __init__(self, fn):
        self.fn, self.plans, self.rows = fn, [], []

    def __call__(self, tick, plan, anchor_q, anchor_dq, elapsed):
        self.rows.append((tick,) + tuple(self.fn(plan, anchor_q, anchor_dq, elapsed, tick)))


class DelayedPlansTests(unittest.TestCase):
    def test_measured_matches_the_legacy_wrapper_exactly(self):
        for latency_ticks in (1, 5, 8, 10, 15, 25):
            for cadence in (8, lambda i: 24 if i % 3 == 2 else 8):
                with self.subTest(latency_ticks=latency_ticks, cadence=cadence):
                    delayed = la.DelayedPlans(latency_ticks, 'measured')
                    old, new = Recorder(legacy_wrapper(latency_ticks)), Recorder(delayed.target_args)
                    FakeCallback(cadence).run(old)
                    FakeCallback(cadence).run(new, plan_hook=delayed.predict, bind=delayed.bind)
                    self.assertEqual(len(old.rows), len(new.rows))
                    for a, b in zip(old.rows, new.rows):
                        self.assertEqual((a[0], a[1]['id'], a[4]), (b[0], b[1]['id'], b[4]))
                        np.testing.assert_array_equal(a[2], b[2])
                        np.testing.assert_array_equal(a[3], b[3])
                    self.assertTrue(all(p['inputs'] is None for p in new.plans), 'measured never predicts')

    def test_predict_schedule_200ms_on_the_8_tick_cadence(self):
        delayed = la.DelayedPlans(10, 'predict')
        self.assertTrue(delayed.predictive)
        rec = Recorder(delayed.target_args)

        def hook(history, tick):
            req = delayed.predict(history, tick)
            return None if req is None else {k: req[k] for k in ('tick', 'anchor_tick', 'source_anchor_tick')} | {
                'prev_plan': req['prev'][0]['id'], 'prev_offset': req['prev'][1], 'req': req}

        FakeCallback(8, ticks=60).run(rec, plan_hook=hook, bind=delayed.bind)
        plans = {p['id']: p for p in rec.plans}
        self.assertIsNone(plans[0]['inputs'], 'first plan: nothing landed, measured history')
        p8, p16, p24 = plans[8]['inputs'], plans[16]['inputs'], plans[24]['inputs']
        self.assertEqual((p8['anchor_tick'], p8['source_anchor_tick'], p8['prev_plan'], p8['prev_offset']), (18, 0, 0, 18))
        # At tick 16 plan 8 is still in flight (lands at 18): the prediction uses the landed plan 0 only.
        self.assertEqual((p16['anchor_tick'], p16['source_anchor_tick'], p16['prev_plan'], p16['prev_offset']), (26, 0, 0, 26))
        self.assertEqual((p24['anchor_tick'], p24['source_anchor_tick'], p24['prev_plan'], p24['prev_offset']), (34, 18, 8, 16))
        executing = {row[0]: (row[1]['id'], row[4]) for row in rec.rows}
        self.assertEqual(executing[0], (0, 0))
        self.assertEqual(executing[17], (0, 17), 'plan 0 keeps driving SONIC while plan 8 is in flight')
        self.assertEqual(executing[18], (8, 0), 'a predicted plan starts at elapsed 0 when it lands')
        self.assertEqual(executing[25], (8, 7))
        self.assertEqual(executing[26], (16, 0))
        self.assertEqual([t for t, _ in delayed.landings][:3], [18, 26, 34])
        # The executed anchor is the predicted last history frame.
        landed = dict(delayed.landings)[18]
        np.testing.assert_array_equal(landed[1], np.asarray(p8['req']['history'][-1], dtype=np.float64))
        self.assertEqual(landed[3], 18)
        self.assertIs(landed[4], p8['req'])

    def test_predicted_inputs_are_the_documented_prediction(self):
        delayed = la.DelayedPlans(10, 'predict')
        plan0 = walking_plan()
        anchor = measured_frame([0, 0], 0.0).astype(np.float64)
        delayed.target_args(plan0, anchor, np.zeros(29), 0, 0)  # first plan executes immediately
        history = np.asarray([measured_frame([0.1, 0.0], 0.2)] * 6)
        req = delayed.predict(history, 8)
        expected = la.predicted_history(history, (plan0, 0, anchor), 8, 10, 6)
        np.testing.assert_array_equal(req['history'], np.asarray(expected))
        self.assertEqual(req['history'].dtype, np.float32)
        np.testing.assert_array_equal(req['anchor_q'], np.asarray(expected[-1], dtype=np.float64))
        np.testing.assert_array_equal(req['anchor_dq'], la.finite_difference_dq(expected))
        self.assertEqual(req['anchor_tick'], 18)

    def test_unbound_plan_falls_back_to_the_callback_anchor(self):
        delayed = la.DelayedPlans(10, 'predict')
        plan0, plan8 = walking_plan(), walking_plan()
        delayed.target_args(plan0, np.zeros(36), np.zeros(29), 0, 0)
        delayed.predict(np.zeros((6, 36), np.float32), 8)  # prediction made, but never bound to plan8
        delayed.target_args(plan8, np.ones(36), np.ones(29), 0, 8)
        ready, entry = delayed.pending[0]
        self.assertEqual((ready, entry[3]), (18, 8))
        np.testing.assert_array_equal(entry[1], np.ones(36))
        self.assertIsNone(entry[4])

    def test_no_prediction_without_latency_or_with_measured_anchor(self):
        for delayed in (la.DelayedPlans(0, 'predict'), la.DelayedPlans(10, 'measured')):
            delayed.target_args(walking_plan(), np.zeros(36), np.zeros(29), 0, 0)
            self.assertIsNone(delayed.predict(np.zeros((6, 36), np.float32), 8))
        with self.assertRaises(ValueError):
            la.DelayedPlans(10, 'future')


if __name__ == '__main__':
    unittest.main()


class ExecutingPlanStartsTests(unittest.TestCase):
    """Every plan that begins driving SONIC is recorded as (start tick, request tick) (review M4)."""

    def test_first_plan_starts_at_once_and_later_plans_at_request_plus_latency(self):
        import numpy as np
        from studio.latency_anchor import DelayedPlans
        d = DelayedPlans(10, 'measured')
        q, dq = np.zeros(36), np.zeros(35)
        first, second = object(), object()
        d.target_args(first, q, dq, 0, 0)
        for tick in range(1, 8):
            d.target_args(first, q, dq, tick, tick)
        for tick in range(8, 20):  # second plan requested at tick 8; the callback hands it over from then on
            d.target_args(second, q, dq, tick - 8, tick)
        self.assertEqual(d.starts, [(0, 0), (18, 8)])
