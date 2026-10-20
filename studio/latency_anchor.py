"""Planner latency for the Flow callback worker: delayed execution and predictive anchoring.

A Studio deployment adapter around Flow's unmodified ``FlowClosedLoopCallback``; it
is not a change to Flow. Two latency anchors are modelled (L2≈):

``measured`` (the original Studio wrapper)
    A plan requested at control tick r is planned from the measured history ending
    at r and executes from r + L at elapsed ``tick - r``: its first L frames are
    already in the past when it lands.

``predict`` (latency-aware anchoring, the g1-student-deploy strategy)
    The planner is given the history predicted at r + L instead. Measured frames
    up to r are continued by the frames r+1 .. r+L of the plan that has *landed*
    (is executing), re-posed by the planar rigid transform (xy translation + yaw)
    that maps that plan's pose at r onto the measured pose at r. SONIC executes
    plans relative to the measured pelvis. The new plan is anchored and timestamped
    at r + L: its predicted last frame and backward-difference joint velocity. It
    starts at elapsed 0 when it lands. Plans still in flight are never used for
    a prediction, because on hardware they have not arrived yet.

The prediction math is the same as g1-student-deploy ``g1deploy/latency.py``
(``plan_frame`` / ``predicted_history``); a unit test checks parity. Pure numpy:
no Flow, Torch or simulator import.

Clock: every tick is a 20 ms simulation control tick (clock domain ``simulation``).
Plan frame i of a plan anchored at tick a is the state at tick a + i + 1.
"""
from __future__ import annotations

import math

import numpy as np

DT = 0.02


def yaw_wxyz(q):
    """Heading (rad) of a wxyz quaternion."""
    w, x, y, z = (float(v) for v in q)
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def yaw_quat(dyaw):
    return np.array([math.cos(dyaw / 2), 0.0, 0.0, math.sin(dyaw / 2)])


def quat_mul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2])


def plan_frame(plan, anchor_tick, anchor_q, tick):
    """World qpos (36) of ``plan`` at control tick ``tick``.

    Frame i is at anchor + (i + 1) ticks. At or before the anchor tick, this is the
    anchor state. Beyond the plan's end it is clamped to the last frame, as the
    released SONIC feed does for finite references.
    """
    i = tick - anchor_tick - 1
    if i < 0:
        return np.asarray(anchor_q, dtype=np.float64)
    q = plan['qpos']
    return np.asarray(q[min(i, len(q) - 1)], dtype=np.float64)


def predicted_history(measured_hist, active, tick, lead_ticks, n_frames):
    """``n_frames`` world qpos frames (float32) ending at ``tick + lead_ticks``.

    measured_hist: measured world qpos frames, last = ``tick``.
    active: (plan, anchor_tick, anchor_q, ...) of the landed plan.
    Frames at or before ``tick`` are measured. Later frames are the active plan's,
    re-posed in the plane onto the measured pose at ``tick``. Root height,
    roll/pitch and joint angles are the plan's.
    """
    plan, anchor_tick, anchor_q = active[0], active[1], active[2]
    meas_now = np.asarray(measured_hist[-1], dtype=np.float64)
    plan_now = plan_frame(plan, anchor_tick, anchor_q, tick)
    dyaw = yaw_wxyz(meas_now[3:7]) - yaw_wxyz(plan_now[3:7])
    c, s = math.cos(dyaw), math.sin(dyaw)
    rot = np.array([[c, -s], [s, c]])
    out = []
    for tau in range(tick + lead_ticks - n_frames + 1, tick + lead_ticks + 1):
        if tau <= tick:
            out.append(np.asarray(measured_hist[-1 - (tick - tau)], dtype=np.float64))
            continue
        q = plan_frame(plan, anchor_tick, anchor_q, tau).copy()
        q[:2] = meas_now[:2] + rot @ (q[:2] - plan_now[:2])
        q[3:7] = quat_mul(yaw_quat(dyaw), q[3:7])
        out.append(q)
    return [q.astype(np.float32) for q in out]


def finite_difference_dq(qpos_hist):
    """Backward-difference joint velocity of the last frame (rad/s); same as Flow feed.finite_difference_dq."""
    q = np.asarray(qpos_hist)
    return (q[-1, 7:] - q[-2, 7:]) / DT


def anchor_error(predicted_q, measured_q):
    """Predicted anchor (estimated) vs the measured state at the same tick (simulator ground truth)."""
    p, m = np.asarray(predicted_q, dtype=np.float64), np.asarray(measured_q, dtype=np.float64)
    dyaw = yaw_wxyz(m[3:7]) - yaw_wxyz(p[3:7])
    return {'xy_m': float(np.hypot(*(m[:2] - p[:2]))),
            'yaw_rad': abs(math.atan2(math.sin(dyaw), math.cos(dyaw))),
            'root_z_m': abs(float(m[2] - p[2])),
            'joint_rmse_rad': float(np.sqrt(np.mean((m[7:] - p[7:]) ** 2)))}


def summarize_errors(rows):
    """p50 / p95 / max per error field over the plans whose landing was observed."""
    rows = [r for r in rows if r]
    if not rows:
        return None
    out = {'landed_plans': len(rows)}
    for key in ('xy_m', 'yaw_rad', 'root_z_m', 'joint_rmse_rad'):
        v = np.asarray([r[key] for r in rows], dtype=np.float64)
        out[key] = {'p50': float(np.median(v)), 'p95': float(np.quantile(v, .95)), 'max': float(v.max())}
    return out


class DelayedPlans:
    """Pipelined delayed execution of the callback's plans with a measured or predictive anchor.

    The callback requests plans on its own cadence (``replan_ticks``, usually 8).
    With a latency of L ticks, a request at r lands at r + L while the landed plan
    keeps driving SONIC. When L exceeds the cadence, more than one request is in
    flight. The first plan executes at once (it is computed before the stream starts,
    as in g1-student-deploy and lockstep).

    Entries are (plan, anchor_q, anchor_dq, anchor_tick, prediction). The anchor
    tick is the request tick (measured) or the request tick + L (predict), and the
    plan executes at elapsed = tick - anchor_tick.
    """

    def __init__(self, latency_ticks, anchor='measured', fd=finite_difference_dq):
        if anchor not in ('measured', 'predict'):
            raise ValueError("anchor must be 'measured' or 'predict'")
        self.latency_ticks, self.anchor, self.fd = int(latency_ticks), anchor, fd
        self.last = None  # latest plan object handed to plan_target (identity marks a new plan)
        self.executing = None
        self.pending = []  # [(ready_tick, entry)], oldest first
        self.request = None  # predicted planner inputs waiting for their plan object
        self.landings = []  # (tick, entry) for every plan that landed from the queue

    @property
    def predictive(self):
        return self.anchor == 'predict' and self.latency_ticks > 0

    def land(self, tick):
        while self.pending and self.pending[0][0] <= tick:
            self.executing = self.pending.pop(0)[1]
            self.landings.append((tick, self.executing))

    def predict(self, history, tick):
        """Planner inputs predicted at tick + L, or None when the plan is anchored on the measured history.

        None for the measured anchor, without latency, and for the first plan (nothing has landed yet).
        """
        self.request = None
        if not self.predictive or self.executing is None:
            return None
        self.land(tick)
        plan, anchor_q, _, anchor_tick = self.executing[:4]
        hist = predicted_history(history, (plan, anchor_tick, anchor_q), tick, self.latency_ticks, len(history))
        at = tick + self.latency_ticks
        self.request = {'tick': tick, 'anchor_tick': at, 'history': np.asarray(hist),
                        'anchor_q': np.asarray(hist[-1], dtype=np.float64).copy(), 'anchor_dq': self.fd(hist),
                        'prev': (plan, at - anchor_tick), 'source_anchor_tick': anchor_tick, 'plan': None}
        return self.request

    def bind(self, plan):
        """Attach the plan computed from the current prediction (called right after FlowPlanner.plan)."""
        if self.request is not None:
            self.request['plan'] = plan

    def target_args(self, plan, anchor_q, anchor_dq, elapsed, tick):
        """(plan, anchor_q, anchor_dq, elapsed) that drive SONIC at ``tick``; registers a newly computed plan."""
        if plan is not self.last:  # a newly computed plan (strong ref held, so identity is unique)
            self.last = plan
            request_tick = tick - int(elapsed)
            req = self.request
            if req is not None and req['plan'] is plan:
                entry = (plan, req['anchor_q'], req['anchor_dq'], req['anchor_tick'], req)
            else:
                entry = (plan, np.array(anchor_q, copy=True), np.array(anchor_dq, copy=True), request_tick, None)
            self.request = None
            if self.executing is None:
                self.executing = entry  # the first plan starts immediately, as in lockstep
            else:
                self.pending.append((request_tick + self.latency_ticks, entry))
        self.land(tick)
        plan, anchor_q, anchor_dq, anchor_tick = self.executing[:4]
        return plan, anchor_q, anchor_dq, tick - anchor_tick
