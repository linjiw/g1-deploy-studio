#!/usr/bin/env python3
"""Analyse the robustness campaign from the gateway's own run history.

Reads GET /api/runs (or a saved snapshot), joins campaign suites/scenarios from
<evidence>/campaign_state.json, re-reads each job's recorded 50 Hz
progress.jsonl (read-only) for behaviour flags, and writes:

  runs-final.json        raw /api/runs snapshot used
  runs-campaign.json     per-run records (campaign runs only, with trajectories)
  runs-campaign.csv      per-run summary table
  summary.json           aggregates, paired comparisons, torque, determinism
  tables.md              markdown tables used in docs/ROBUSTNESS.md

    .venv/bin/python tools/campaign/analyze.py --evidence <dir> [--runs <snapshot.json>]

All outcome values are the source scorer's (arrive & hold); post-hoc reach is
the gateway's derived Flow-protocol re-evaluation. Simulator ground truth only.
"""
import argparse
import csv
import json
import math
import statistics
import urllib.request
from pathlib import Path

JOBS = Path.home() / 'research-data/g1-deploy-studio/workbench/jobs'
ARENAS = ('open', 'clutter', 'doorway', 'slalom')
WX, BUNDLE = 'flow-wx-rf-23326aa-s0', 'flow-bundle-20261008'
PNAME = {WX: 'WX-RF', BUNDLE: 'Bundle'}
CATS = ('goal', 'timeout_near', 'timeout_far', 'collision', 'fall', 'error')
# Confirmed Studio bug in release 3f3dfa5 (fix pending release): WX-RF on a box-free map fails at
# its first replan because the planner reports infinite clearance and Studio's strict JSON writer
# rejects it. These are tool errors, not policy behaviour, and are excluded from policy statistics.
TOOL_ERROR_SIGNATURE = 'Out of range float values are not JSON compliant'


def wilson(k, n, z=1.96):
    if not n:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def med(xs):
    v = [x for x in xs if isinstance(x, (int, float)) and math.isfinite(x)]
    return statistics.median(v) if v else None


def category(r):
    o = r.get('outcome')
    if o == 'goal_completion':
        return 'goal'
    if o == 'timeout':
        f = (r.get('metrics') or {}).get('final_goal_distance_m')
        return 'timeout_near' if f is not None and f <= .5 else 'timeout_far'
    if o == 'obstacle_collision':
        return 'collision'
    if o == 'fall':
        return 'fall'
    if o == 'runtime_error' or r.get('status') == 'failed':
        return 'error'
    return o or r.get('status') or 'unknown'


def box_distance(b, pt):
    c, (hx, hy), y = b['center_xy'], b['half_xy'], b.get('yaw', 0.0)
    dx, dy = pt[0] - c[0], pt[1] - c[1]
    lx, ly = math.cos(y) * dx + math.sin(y) * dy, -math.sin(y) * dx + math.cos(y) * dy
    return math.hypot(max(abs(lx) - hx, 0), max(abs(ly) - hy, 0))


def line_clearance(boxes, s, g, n=400):
    if not boxes:
        return None
    return min(box_distance(b, (s[0] + (g[0] - s[0]) * i / n, s[1] + (g[1] - s[1]) * i / n)) for b in boxes for i in range(n + 1))


def progress(job):
    rows = []
    try:
        with open(JOBS / job / 'run/progress.jsonl') as handle:
            for line in handle:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


def behaviour(rows, goal, boxes, dt=.02):
    """Flags from the 50 Hz simulator-truth root trajectory."""
    if not rows or not goal:
        return {}
    xy = [(r['qpos'][0], r['qpos'][1]) for r in rows]
    t = [r['time'] for r in rows]
    d = [math.dist(p, goal) for p in xy]
    sp = [0.0] + [math.dist(a, b) / max(1e-9, tb - ta) for a, b, ta, tb in zip(xy, xy[1:], t, t[1:])]
    inside = [x <= .3 for x in d]
    entries = sum(1 for a, b in zip(inside, inside[1:]) if b and not a) + (1 if inside[0] else 0)
    exits = sum(1 for a, b in zip(inside, inside[1:]) if a and not b)
    in_fast = sum(1 for i, v in enumerate(inside) if v and sp[i] > .25)
    in_total = sum(inside)
    # speed smoothed over 0.2 s windows to avoid finite-difference noise
    w = 10
    smooth = [math.dist(xy[i], xy[max(0, i - w)]) / max(1e-9, t[i] - t[max(0, i - w)]) if i else 0.0 for i in range(len(xy))]
    clear = [min(box_distance(b, p) for b in boxes) for p in xy] if boxes else None
    contact = [((r.get('health') or {}).get('contact_force_n')) for r in rows]
    known = [c for c in contact if c is not None]
    start_d = d[0]
    return {'samples': len(rows), 'goal_entries_0p3': entries, 'goal_exits_0p3': exits,
            'time_inside_0p3_s': in_total * dt, 'time_inside_fast_s': in_fast * dt,
            'max_speed_m_s': max(smooth), 'final_speed_m_s': smooth[-1],
            'max_goal_distance_m': max(d), 'moved_away_m': max(d) - start_d,
            'closest_t_s': t[d.index(min(d))], 'final_m': d[-1], 'closest_m': min(d),
            'min_obstacle_clearance_m': min(clear) if clear else None,
            'contact_samples_known': len(known), 'contact_samples_unknown': len(contact) - len(known),
            'contact_samples_positive': sum(1 for c in known if c > 0)}


def flags(rec):
    b, out = rec.get('behaviour') or {}, []
    if not b:
        return out
    if rec['outcome'] != 'goal_completion' and (b.get('goal_entries_0p3') or 0) > 0:
        out.append('entered_0.3m_not_held')
    if (b.get('goal_exits_0p3') or 0) >= 1:
        out.append('left_0.3m_after_entry')
    if (b.get('goal_exits_0p3') or 0) >= 2:
        out.append('oscillation_near_goal')
    if b.get('closest_m') is not None and b['closest_m'] < .3 and b['final_m'] - b['closest_m'] > .25:
        out.append('ended_>0.25m_beyond_closest')
    if (b.get('time_inside_fast_s') or 0) >= .5:
        out.append('fast_inside_0.3m_>=0.5s')
    if rec.get('path_efficiency') is not None and rec['path_efficiency'] < .7:
        out.append('wide_detour')
    if (b.get('moved_away_m') or 0) > .5:
        out.append('moved_away_from_goal')
    if b.get('min_obstacle_clearance_m') is not None and b['min_obstacle_clearance_m'] < .3:
        out.append('passed_within_0.3m_of_box')
    if rec['outcome'] == 'timeout' and (b.get('final_speed_m_s') or 0) > .25 and b['final_m'] <= .5:
        out.append('still_moving_at_goal_at_timeout')
    return out


def load_runs(args, evidence):
    if args.runs:
        return json.loads(Path(args.runs).read_text())
    with urllib.request.urlopen(args.url.rstrip('/') + '/api/runs', timeout=300) as resp:
        data = json.loads(resp.read().decode())
    (evidence / 'runs-final.json').write_text(json.dumps(data))
    return data


def build(evidence, data):
    arenas = {a['key']: a for a in json.loads((evidence / 'arenas.json').read_text())['arenas']}
    extra = evidence / 'arenas-extra.json'
    if extra.exists():
        arenas.update({a['key']: a for a in json.loads(extra.read_text())['arenas']})
    state = json.loads((evidence / 'campaign_state.json').read_text())
    suite_phase = {v['id']: k for k, v in state['suites'].items() if v.get('id')}
    by_id = {}
    for tag, meta in state['scenarios'].items():
        by_id.setdefault(meta['id'], []).append(meta)
    records = []
    for r in data['runs']:
        phase = suite_phase.get(r.get('suite_id'))
        if not phase or r['scenario_id'] not in by_id or r['status'] not in ('completed', 'failed', 'cancelled'):
            continue
        metas = by_id[r['scenario_id']]
        meta = next((m for m in metas if m['phase'] == phase), metas[0])
        arena = arenas[meta['arena']]
        m, dv = r.get('metrics') or {}, r.get('derived') or {}
        rows = progress(r['id'])
        torque = r.get('torque') or {}
        lim = torque.get('model_limit_nm') or {}
        peak = torque.get('peak_commanded_nm') or {}
        over = {j: v for j, v in peak.items() if lim.get(j) and v > lim[j] + 1e-6}
        rec = {'job_id': r['id'], 'phase': phase, 'arena': meta['arena'], 'arena_id': r['map_id'], 'preset': meta['idx'],
               'policy': PNAME.get(r['policy_id'], r['policy_id']), 'policy_id': r['policy_id'],
               'k': (r.get('planner') or {}).get('candidates'), 'ode': (r.get('planner') or {}).get('ode_steps'),
               'seed': r.get('seed'), 'latency_ms': (r.get('latency') or {}).get('ms'), 'anchor': (r.get('latency') or {}).get('anchor'),
               'criterion': r.get('criterion'), 'status': r['status'], 'outcome': r.get('outcome'), 'category': category(r),
               'error': r.get('error'), 'start_xy': r.get('start_xy'), 'start_yaw_rad': r.get('start_yaw_rad'), 'goal_xy': r.get('goal_xy'),
               'goal_distance_m': math.dist(r['start_xy'], r['goal_xy']) if r.get('start_xy') and r.get('goal_xy') else None,
               'line_clearance_m': line_clearance(arena['boxes'], r['start_xy'], r['goal_xy']) if r.get('goal_xy') else None,
               'elapsed_s': m.get('elapsed_s'), 'final_m': m.get('final_goal_distance_m'), 'closest_m': m.get('minimum_goal_distance_m'),
               'first_entry_0p3_s': (dv.get('first_entry_s') or {}).get('0.3'), 'first_entry_0p4_s': (dv.get('first_entry_s') or {}).get('0.4'),
               'reach_post_hoc': (dv.get('reach_post_hoc') or {}).get('reached'), 'reach_time_s': (dv.get('reach_post_hoc') or {}).get('time_s'),
               'reach_blocked_by': (dv.get('reach_post_hoc') or {}).get('blocked_by'),
               'path_length_m': dv.get('path_length_m'), 'straight_line_m': dv.get('straight_line_m'), 'path_efficiency': dv.get('path_efficiency'),
               'max_contact_n': m.get('max_contact_n'), 'max_tilt_rad': m.get('max_tilt_rad'), 'min_root_height_m': m.get('min_root_height_m'),
               'planner_p50_ms': m.get('planner_p50_ms'), 'planner_p95_ms': m.get('planner_p95_ms'), 'replans': m.get('replans'),
               'wall_time_s': m.get('wall_time_s'), 'selection_rules': m.get('selection_rules'),
               'torque_recorded': bool(torque), 'torque_saturated_substeps': torque.get('saturated_substeps') or {},
               'torque_total_substeps': torque.get('total_substeps'), 'torque_over_model_limit_nm': over,
               'torque_peak_nm': peak, 'torque_model_limit_nm': lim,
               'behaviour': behaviour(rows, r.get('goal_xy'), arena['boxes']), 'trajectory': r.get('trajectory')}
        rec['obstructed'] = rec['line_clearance_m'] is not None and rec['line_clearance_m'] <= 0.0
        if rec['category'] == 'error' and rec['policy_id'] == WX and not arena['boxes'] and TOOL_ERROR_SIGNATURE in (rec['error'] or ''):
            rec['category'] = 'tool_error'
            rec['tool_error_note'] = 'Studio tool error (fixed in pending release): infinite clearance on a box-free map rejected by strict JSON; excluded from policy statistics'
        rec['hold_delay_s'] = (rec['elapsed_s'] - rec['first_entry_0p3_s']) if rec['outcome'] == 'goal_completion' and rec['first_entry_0p3_s'] is not None else None
        rec['flags'] = flags(rec)
        rec['suite_id'] = r.get('suite_id')
        records.append(rec)
    return records, state


def aggregate(recs):
    tool = [r for r in recs if r['category'] == 'tool_error']
    recs = [r for r in recs if r['category'] != 'tool_error']
    n = len(recs)
    goals = [r for r in recs if r['outcome'] == 'goal_completion']
    reach = [r for r in recs if r['reach_post_hoc']]
    valid = [r for r in recs if r['category'] != 'error']
    cats = {c: sum(1 for r in recs if r['category'] == c) for c in CATS}
    return {'n': n, 'n_valid': len(valid), 'tool_errors_excluded': len(tool), 'tool_error_jobs': [r['job_id'] for r in tool], 'goals': len(goals), 'goal_ci': wilson(len(goals), n),
            'goal_ci_valid': wilson(len(goals), len(valid)),
            'reach': len(reach), 'reach_ci': wilson(len(reach), n), 'categories': cats,
            'median_time_to_goal_s': med([r['elapsed_s'] for r in goals]),
            'median_time_to_reach_s': med([r['reach_time_s'] for r in reach]),
            'median_path_efficiency_reached': med([r['path_efficiency'] for r in reach]),
            'median_path_efficiency_all': med([r['path_efficiency'] for r in valid]),
            'median_final_m': med([r['final_m'] for r in valid]),
            'median_hold_delay_s': med([r['hold_delay_s'] for r in goals]),
            'max_hold_delay_s': max((r['hold_delay_s'] for r in goals if r['hold_delay_s'] is not None), default=None),
            'peak_contact_n': max((r['max_contact_n'] for r in valid if r['max_contact_n'] is not None), default=None),
            'runs_with_contact': sum(1 for r in valid if (r['max_contact_n'] or 0) > 0),
            'max_tilt_rad': max((r['max_tilt_rad'] for r in valid if r['max_tilt_rad'] is not None), default=None),
            'median_max_tilt_rad': med([r['max_tilt_rad'] for r in valid]),
            'planner_p50_ms_median': med([r['planner_p50_ms'] for r in valid]),
            'planner_p95_ms_median': med([r['planner_p95_ms'] for r in valid]),
            'planner_p95_ms_max': max((r['planner_p95_ms'] for r in valid if r['planner_p95_ms'] is not None), default=None),
            'torque_runs_over_limit': sum(1 for r in valid if r['torque_over_model_limit_nm']),
            'torque_runs_recorded': sum(1 for r in valid if r['torque_recorded']),
            'median_wall_s': med([r['wall_time_s'] for r in valid])}


def pct(k, n):
    return f'{100 * k / n:.0f}%' if n else '—'


def ci(c):
    return '' if c[0] is None else f' [{100 * c[0]:.0f}–{100 * c[1]:.0f}]'


def f(v, nd=2, unit=''):
    return '—' if v is None else f'{v:.{nd}f}{unit}'


def paired(a, b, key=lambda r: (r['arena'], r['preset'])):
    """a vs b on identical (arena, preset): wins for a, losses, ties."""
    ib = {key(r): r for r in b}
    out = {'pairs': 0, 'outcome': {'win': 0, 'loss': 0, 'tie_both_goal': 0, 'tie_both_fail': 0},
           'reach': {'win': 0, 'loss': 0, 'tie': 0}, 'final_distance': {'win': 0, 'loss': 0, 'tie': 0}, 'rows': []}
    for ra in a:
        rb = ib.get(key(ra))
        if not rb or {'error', 'tool_error'} & {ra['category'], rb['category']}:
            if rb:
                out['rows'].append({'key': key(ra), 'a': ra['job_id'], 'b': rb['job_id'], 'a_cat': ra['category'], 'b_cat': rb['category'], 'excluded': 'error/tool_error'})
            continue
        out['pairs'] += 1
        ga, gb = ra['outcome'] == 'goal_completion', rb['outcome'] == 'goal_completion'
        out['outcome']['win' if ga and not gb else 'loss' if gb and not ga else 'tie_both_goal' if ga else 'tie_both_fail'] += 1
        pa, pb = bool(ra['reach_post_hoc']), bool(rb['reach_post_hoc'])
        out['reach']['win' if pa and not pb else 'loss' if pb and not pa else 'tie'] += 1
        fa, fb = ra['final_m'], rb['final_m']
        if fa is not None and fb is not None:
            out['final_distance']['win' if fa < fb - .05 else 'loss' if fb < fa - .05 else 'tie'] += 1
        out['rows'].append({'key': key(ra), 'a': ra['job_id'], 'b': rb['job_id'], 'a_cat': ra['category'], 'b_cat': rb['category'],
                            'a_final': fa, 'b_final': fb, 'a_time': ra['elapsed_s'], 'b_time': rb['elapsed_s']})
    return out


def determinism(state, recs):
    det = [r for r in recs if r['phase'] == 'DET']
    if not det:
        return None
    d = det[0]
    base = next((r for r in recs if r['phase'] == 'P1' and r['arena'] == d['arena'] and r['preset'] == d['preset']), None)
    out = {'rerun': d['job_id'], 'original': base and base['job_id'], 'outcome': [base and base['outcome'], d['outcome']],
           'final_m': [base and base['final_m'], d['final_m']], 'elapsed_s': [base and base['elapsed_s'], d['elapsed_s']]}
    if base:
        pa, pb = progress(base['job_id']), progress(d['job_id'])
        out['progress_rows'] = [len(pa), len(pb)]
        if len(pa) == len(pb):
            out['progress_qpos_max_abs_diff'] = max((abs(x - y) for ra, rb in zip(pa, pb) for x, y in zip(ra['qpos'], rb['qpos'])), default=None)
        try:
            import numpy as np
            na = np.load(JOBS / base['job_id'] / 'run/native/closed_loop.npz')
            nb = np.load(JOBS / d['job_id'] / 'run/native/closed_loop.npz')
            diffs = {}
            for k in sorted(set(na.files) & set(nb.files)):
                x, y = na[k], nb[k]
                if x.shape != y.shape:
                    diffs[k] = f'shape {x.shape} vs {y.shape}'
                elif x.dtype.kind in 'fiu':
                    diffs[k] = float(np.max(np.abs(x.astype(float) - y.astype(float)))) if x.size else 0.0
            out['native_npz_max_abs_diff'] = diffs
        except Exception as error:  # numpy only exists in the Studio venv
            out['native_npz_error'] = f'{type(error).__name__}: {error}'
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:8790')
    ap.add_argument('--evidence', type=Path, required=True)
    ap.add_argument('--runs', default=None)
    args = ap.parse_args()
    ev = args.evidence
    data = load_runs(args, ev)
    recs, state = build(ev, data)
    (ev / 'runs-campaign.json').write_text(json.dumps(recs, indent=1))
    cols = ['job_id', 'phase', 'arena', 'preset', 'policy', 'k', 'ode', 'seed', 'latency_ms', 'anchor', 'status', 'outcome', 'category',
            'goal_distance_m', 'line_clearance_m', 'obstructed', 'elapsed_s', 'final_m', 'closest_m', 'first_entry_0p3_s', 'hold_delay_s', 'reach_post_hoc',
            'reach_time_s', 'path_efficiency', 'max_contact_n', 'max_tilt_rad', 'planner_p50_ms', 'planner_p95_ms', 'replans', 'wall_time_s',
            'torque_over_model_limit_nm', 'flags', 'error']
    with open(ev / 'runs-campaign.csv', 'w', newline='') as handle:
        w = csv.writer(handle)
        w.writerow(cols)
        for r in recs:
            w.writerow([json.dumps(r[c]) if isinstance(r[c], (dict, list)) else r[c] for c in cols])

    ph = lambda p, **kw: [r for r in recs if r['phase'] == p and all(r[k] == v for k, v in kw.items())]
    summary = {'n_records': len(recs), 'phases': {}, 'by_arena': {}, 'paired': {}, 'torque': {}, 'behaviours': {}}
    for p in sorted({r['phase'] for r in recs}):
        summary['phases'][p] = aggregate(ph(p))
        summary['by_arena'][p] = {a: aggregate(ph(p, arena=a)) for a in ARENAS if ph(p, arena=a)}
    # obstructed vs unobstructed split for the two main phases
    summary['obstruction'] = {p: {'obstructed': aggregate([r for r in ph(p) if r['obstructed']]),
                                  'unobstructed': aggregate([r for r in ph(p) if not r['obstructed']])} for p in ('P1', 'P2') if ph(p)}
    summary['paired']['P1_WX_vs_P2_bundle'] = paired(ph('P1'), ph('P2'))
    summary['paired']['P3_lat200_vs_P1'] = paired(ph('P3'), ph('P1'))
    summary['paired']['P5_K16_vs_P1_K8'] = paired(ph('P5'), ph('P1'))
    summary['paired']['P6_bundle_lat200p_vs_P2'] = paired(ph('P6'), ph('P2'))
    # seed variance on clutter presets: s0 (P1) + s1, s2 (P4)
    seeds = {}
    for r in ph('P1', arena='clutter') + ph('P4'):
        seeds.setdefault(r['preset'], {})[r['seed']] = r
    summary['seed_variance'] = []
    for idx in sorted(seeds):
        row = seeds[idx]
        outs = {s: row[s]['category'] for s in sorted(row)}
        finals = [row[s]['final_m'] for s in row if row[s]['final_m'] is not None]
        summary['seed_variance'].append({'preset': idx, 'categories': outs, 'jobs': {s: row[s]['job_id'] for s in sorted(row)},
                                         'flip': len({c == 'goal' for c in outs.values()}) > 1,
                                         'final_m': {s: row[s]['final_m'] for s in sorted(row)},
                                         'final_spread_m': (max(finals) - min(finals)) if finals else None,
                                         'time_s': {s: row[s]['elapsed_s'] for s in sorted(row)}})
    # torque
    # per phase (the DET re-run duplicates a P1 run and is excluded from policy totals)
    summary['torque_by_phase'] = {}
    for p in sorted({r['phase'] for r in recs}):
        rs = [r for r in ph(p) if r['torque_recorded']]
        joints = {}
        for r in rs:
            for j, v in r['torque_over_model_limit_nm'].items():
                e = joints.setdefault(j, {'runs': 0, 'peak_nm': 0.0, 'saturated_substeps': 0})
                e['runs'] += 1
                e['peak_nm'] = max(e['peak_nm'], v)
                e['saturated_substeps'] += r['torque_saturated_substeps'].get(j, 0)
        summary['torque_by_phase'][p] = {'runs': len(rs), 'runs_over_model_limit': sum(1 for r in rs if r['torque_over_model_limit_nm']),
                                         'jobs_over_limit': [r['job_id'] for r in rs if r['torque_over_model_limit_nm']],
                                         'joints': joints, 'total_substeps': sum(r['torque_total_substeps'] or 0 for r in rs),
                                         'saturated_joint_substeps': sum(sum(r['torque_saturated_substeps'].values()) for r in rs)}
    for pol in (WX, BUNDLE):
        rs = [r for r in recs if r['policy_id'] == pol and r['torque_recorded'] and r['phase'] != 'DET']
        joints = {}
        for r in rs:
            for j, v in r['torque_over_model_limit_nm'].items():
                e = joints.setdefault(j, {'runs': 0, 'peak_nm': 0, 'peak_job': None, 'saturated_substeps_total': 0, 'model_limit_nm': r['torque_model_limit_nm'].get(j)})
                e['runs'] += 1
                e['saturated_substeps_total'] += r['torque_saturated_substeps'].get(j, 0)
                if v > e['peak_nm']:
                    e['peak_nm'], e['peak_job'] = v, r['job_id']
        frac = [sum(r['torque_saturated_substeps'].values()) / r['torque_total_substeps'] for r in rs if r['torque_total_substeps']]  # joint-substeps per substep
        summary['torque'][PNAME[pol]] = {'runs_recorded': len(rs), 'runs_over_model_limit': sum(1 for r in rs if r['torque_over_model_limit_nm']),
                                         'joints': joints, 'max_saturated_joint_substeps_per_substep': max(frac, default=None),
                                         'median_saturated_joint_substeps_per_substep': med(frac),
                                         'over_limit_by_outcome': {c: sum(1 for r in rs if r['torque_over_model_limit_nm'] and r['category'] == c) for c in CATS},
                                         'runs_by_outcome': {c: sum(1 for r in rs if r['category'] == c) for c in CATS}}
    for r in recs:
        for fl in r['flags']:
            summary['behaviours'].setdefault(fl, []).append(r['job_id'])
    summary['determinism'] = determinism(state, recs)
    summary['failures_error'] = [{'job_id': r['job_id'], 'phase': r['phase'], 'arena': r['arena'], 'preset': r['preset'], 'category': r['category'], 'error': r['error']} for r in recs if r['category'] in ('error', 'tool_error')]
    summary['tool_errors'] = {'note': 'WX-RF on the box-free open-floor arena: Studio bug in release 3f3dfa5 (fix pending release); excluded from policy statistics',
                              'jobs': [r['job_id'] for r in recs if r['category'] == 'tool_error'],
                              'suites': sorted({r['suite_id'] for r in recs if r['category'] == 'tool_error'} - {None})}
    (ev / 'summary.json').write_text(json.dumps(summary, indent=1))
    tables(ev, recs, summary)
    print(json.dumps({p: {k: v for k, v in a.items() if k in ('n', 'goals', 'reach', 'categories')} for p, a in summary['phases'].items()}, indent=1))


def tables(ev, recs, s):
    L = []
    title = {'P1': 'WX-RF K8/ODE6 lat 0 s0', 'P2': 'Bundle K4/ODE6 lat 0 s0', 'P3': 'WX-RF K8/ODE6 lat 200 measured', 'P4': 'WX-RF K8/ODE6 seeds 1–2',
             'P5': 'WX-RF K16/ODE10', 'P6': 'Bundle K4/ODE6 lat 200 predict', 'P7': 'WX-RF K8/ODE6 open floor + sentinel pillar', 'DET': 'determinism re-run'}
    L.append('| Phase · arena | n | Arrive & hold | Post-hoc reach | goal / t≤0.5 / t>0.5 / coll / fall / err | t goal (med) | t reach (med) | path eff (reached, med) | final m (med) | peak contact N | max tilt rad | planner p50 / p95 ms (med) |')
    L.append('|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|')
    for p in sorted(s['by_arena'], key=lambda k: ('P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'DET').index(k) if k in ('P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'DET') else 99):
        for a, g in list(s['by_arena'][p].items()) + [('all', s['phases'][p])]:
            c = g['categories']
            if g['tool_errors_excluded'] and not g['n']:
                L.append(f"| {p} {title.get(p, '')} · {a} | 0 | n/a: {g['tool_errors_excluded']} tool errors excluded | n/a | — | — | — | — | — | — | — | — |")
                continue
            a = f"{a} (+{g['tool_errors_excluded']} tool err excl.)" if g['tool_errors_excluded'] else a
            L.append(f"| {p} {title.get(p, '')} · {a} | {g['n']} | {g['goals']}/{g['n']} {pct(g['goals'], g['n'])}{ci(g['goal_ci'])} | "
                     f"{g['reach']}/{g['n']} {pct(g['reach'], g['n'])}{ci(g['reach_ci'])} | {c['goal']} / {c['timeout_near']} / {c['timeout_far']} / {c['collision']} / {c['fall']} / {c['error']} | "
                     f"{f(g['median_time_to_goal_s'])} | {f(g['median_time_to_reach_s'])} | {f(g['median_path_efficiency_reached'])} | {f(g['median_final_m'])} | "
                     f"{f(g['peak_contact_n'], 0)} | {f(g['max_tilt_rad'])} | {f(g['planner_p50_ms_median'], 0)} / {f(g['planner_p95_ms_median'], 0)} |")
    L.append('')
    L.append('| Run | Phase | Arena #preset | goal d / line clear m | Outcome | t s | final / closest m | reach t s | path eff | contact N | tilt | p95 ms | torque > model limit | flags |')
    L.append('|---|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---|---|')
    for r in sorted(recs, key=lambda r: (r['phase'], ARENAS.index(r['arena']) if r['arena'] in ARENAS else 9, r['preset'], r['seed'] or 0)):
        tq = ', '.join(f"{j.replace('_joint', '')} {v:.0f}" for j, v in sorted(r['torque_over_model_limit_nm'].items(), key=lambda kv: -kv[1])) or ('—' if r['torque_recorded'] else 'n/a')
        L.append(f"| `{r['job_id']}` | {r['phase']} s{r['seed']} | {r['arena']} #{r['preset']} | {f(r['goal_distance_m'])} / {f(r['line_clearance_m'])} | {r['category']} | {f(r['elapsed_s'])} | "
                 f"{f(r['final_m'])} / {f(r['closest_m'])} | {f(r['reach_time_s'])} | {f(r['path_efficiency']) if r['reach_post_hoc'] else '—'} | {f(r['max_contact_n'], 0)} | {f(r['max_tilt_rad'])} | {f(r['planner_p95_ms'], 0)} | {tq} | {', '.join(r['flags'])} |")
    (ev / 'tables.md').write_text('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
