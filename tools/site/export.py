#!/usr/bin/env python3
"""Convert recorded walks (tools/site/record_goals.py) into the static site's compact data.

    .venv/bin/python -m tools.site.export --recordings <dir> --out <site-data dir> [--world detour ...]

Per world: ``<out>/<world>/index.json`` (geometry, start, the map the robot has before Go, every grid cell's
goal check and every recorded walk) and ``<out>/<world>/g/<goal-id>.json`` (one walk). Quantized integers keep
the files small: positions in mm (cm for map-scale points), angles in mrad, quaternions x 1e4. Frames are kept
at 25 Hz (every second 20 ms control tick). Values are what the recording holds; nothing is smoothed or invented.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.site.worlds import WORLDS, describe  # noqa: E402

STRIDE = 2            # 50 Hz control ticks -> 25 Hz frames
LIDAR_POINTS = 400    # per 1 Hz snapshot
SCHEMA = 1


def _ints(values, scale):
    return [int(round(float(v) * scale)) for v in values]


def _b64(array):
    return base64.b64encode(np.ascontiguousarray(array, dtype=np.uint8).tobytes()).decode()


def _decimate(points, limit):
    points = list(points or [])
    if len(points) <= limit:
        return points
    step = len(points) / limit
    return [points[int(k * step)] for k in range(limit)]


def _public_path(path):
    """Repository-relative names for the public data: no local home or data-root paths."""
    path = str(path or '')
    for root in ('/home/linjiw/code/', str(ROOT.parent) + '/'):
        if path.startswith(root):
            return path[len(root):]
    return Path(path).name


def _cell_changes(changed, codes, heights):
    """Changed cells as gaps between flat indices and one value each: the code (0 or 1), or code * 1000 + height in
    cm for low obstacles, obstacles and overhead cells (2-4), whose height the site draws."""
    idx = changed.astype(int)
    gaps = np.diff(idx, prepend=0).tolist() if len(idx) else []
    c, h = codes[idx].astype(int), heights[idx].astype(int)
    return {'g': gaps, 'v': np.where(c >= 2, c * 1000 + h, c).tolist()}


def _checks(cell):
    """The six checks as one status letter each (p pass, w warn, b block), plus the labels that are not 'pass'."""
    return {'s': ''.join(c['status'][0] for c in cell['checks']),
            'l': [c['label'] for c in cell['checks'] if c['status'] != 'pass']}


def walk_data(world_id, goal_id, run, base_codes, base_heights):
    session = json.loads((run / 'session.json').read_text())
    frames = session['frames']
    meta = session['metadata']
    legs = (meta.get('navigation') or {}).get('legs') or []
    leg = legs[-1] if legs else {}
    picked = frames[::STRIDE]
    if picked[-1] is not frames[-1]:
        picked.append(frames[-1])
    q, est, tilt, force, dist, times = [], [], [], [], [], []
    phases = []
    for k, f in enumerate(picked):
        qpos = f['qpos']
        q += _ints(qpos[:3], 1000) + _ints(qpos[3:7], 1e4) + _ints(qpos[7:36], 1000)
        est += _ints((f.get('estimate') or {}).get('position', qpos[:3])[:2], 1000)
        h = f.get('health') or {}
        tilt.append(None if h.get('tilt_rad') is None else int(round(h['tilt_rad'] * 1000)))
        force.append(None if h.get('contact_force_n') is None else int(round(h['contact_force_n'])))
        dist.append(None if h.get('goal_dist_m') is None else int(round(h['goal_dist_m'] * 100)))
        times.append(round(float(f['time']), 3))
        phase = (f.get('navigation') or {}).get('phase')
        if not phases or phases[-1][1] != phase:
            phases.append([k, phase])
    plans = []
    for row in session.get('plans') or []:
        plans.append({'t': round(row['tick'] * 0.02, 3), 'rule': row.get('rule'),
                      'xy': _ints(np.asarray(row['plan_xy'], dtype=float).ravel(), 100),
                      'z': _ints(row.get('plan_root_z') or [], 100),
                      'wp': [round(float(v), 3) for v in row.get('waypoint_xy') or []],
                      'clear_cm': None if row.get('chosen_clearance_m') is None or not math.isfinite(row['chosen_clearance_m'])
                      else int(round(row['chosen_clearance_m'] * 100))})
    starts = (meta.get('latency_model') or {}).get('executing_plan_starts')
    lidar = []
    for p in (session.get('perception') or {}).get('frames') or []:
        pts = _decimate(p.get('filtered_lidar'), LIDAR_POINTS)
        lidar.append({'t': round(float(p['time']), 3), 'o': _ints(p.get('sensor_origin') or [0, 0, 0], 100),
                      'p': [v for pt in pts for v in _ints(pt, 100)],
                      'fraction': round(float(p.get('observed_fraction') or 0), 4)})
    # The map over time as changes from the map the robot had before Go (identical in every session of a world).
    grids = np.load(run / 'grids.npz')
    codes, heights, gt = grids['codes'], grids['height_cm'], grids['time']
    prev_c, prev_h = base_codes, base_heights
    map_steps = []
    if not np.array_equal(codes[0], base_codes):
        raise ValueError(f'{world_id}/{goal_id}: the first map differs from the probe map (seed or worker changed?)')
    for k in range(len(gt)):
        changed = np.flatnonzero((codes[k] != prev_c).ravel() | ((heights[k] != prev_h).ravel() & (codes[k].ravel() >= 2)))
        if len(changed) or k == 0:
            map_steps.append({'t': round(float(gt[k]), 3), **_cell_changes(changed, codes[k].ravel(), heights[k].ravel())})
        prev_c, prev_h = codes[k], heights[k]
    events = [{'t': round(float(e['time']), 3), 'type': e['type'], 'msg': e['message'],
               **({'dist': round(float(e['dist']), 3)} if e.get('dist') is not None else {})}
              for e in session.get('events') or [] if e['type'] not in ('replan', 'command')]
    report = meta.get('test_result') or {}
    return {'v': SCHEMA, 'world': world_id, 'goal_id': goal_id, 'goal': leg.get('goal_xy'),
            'outcome': leg.get('outcome'), 'reason': leg.get('reason'), 'duration_s': leg.get('duration_s'),
            'final_dist_m': leg.get('final_dist_true_m'), 'final_dist_estimate_m': leg.get('final_dist_m'),
            'path_m': leg.get('path_m'), 'max_contact_n': leg.get('max_contact_n'), 'plans_n': leg.get('plans'),
            'fps': 50 / STRIDE, 'n': len(picked), 'time': times,
            'q': q, 'est': est, 'tilt_mrad': tilt, 'contact_n': force, 'goal_cm': dist, 'phases': phases,
            'plans': plans, 'plan_starts': [[round(t * 0.02, 3), i] for t, i in starts] if starts else None,
            'lidar': lidar, 'map': map_steps, 'events': events,
            'rtf': report.get('worker_real_time_factor')}


def world_index(world_id, base, runs_out):
    goals = json.loads((base / 'goals.json').read_text())
    probe = np.load(base / 'probe' / 'run' / 'grids.npz')
    codes, heights = probe['codes'][-1], probe['height_cm'][-1]
    request = json.loads((base / 'probe' / 'request.json').read_text())
    probe_session = json.loads((base / 'probe' / 'run' / 'session.json').read_text())
    meta = probe_session['metadata']
    first = probe_session['frames'][0]
    lidar = (probe_session.get('perception') or {}).get('frames') or [{}]
    return {'v': SCHEMA, **describe(world_id), 'profile': goals['profile'], 'profile_label': goals['profile_label'],
            'spacing_m': goals['spacing_m'],
            'start_qpos': _ints(first['qpos'][:3], 1000) + _ints(first['qpos'][3:7], 1e4) + _ints(first['qpos'][7:36], 1000),
            'map': {'n': int(codes.shape[0]), 'res_m': float(probe['res']), 'lo': [float(v) for v in probe['lo']],
                    'order': 'row-major [i, j], i along x; cell centre = lo + (i, j) * res',
                    'codes': _b64(codes), 'height_cm': _b64(heights),
                    'legend': {'0': 'never observed', '1': 'floor', '2': 'low obstacle (steps over)', '3': 'obstacle', '4': 'overhead'}},
            'start_lidar': {'o': _ints(lidar[-1].get('sensor_origin') or [0, 0, 0], 100),
                            'p': [v for pt in _decimate(lidar[-1].get('filtered_lidar'), LIDAR_POINTS) for v in _ints(pt, 100)]},
            'check_ids': [c['id'] for c in goals['cells'][0]['checks']] if goals['cells'] else [],
            'cells': [{'id': c['id'], 'xy': c['xy'], 'ok': c['ok'], **_checks(c), 'path_m': None if c['path_m'] is None else round(c['path_m'], 2),
                       'path': [v for pt in (c.get('path_xy') or []) for v in pt]} for c in goals['cells']],
            'walks': runs_out,
            'settings': {k: request[k] for k in ('planner', 'latency', 'odometry', 'actuators', 'map_mode', 'goal_radius_m',
                                                 'prescan_s', 'initial_prescan_s', 'leg_timeout_s', 'seed')},
            'provenance': {'policy': meta.get('policy_profile'),
                           'artifacts': [dict(a, path=_public_path(a.get('path'))) for a in meta.get('provenance', {}).get('artifacts') or []
                                         if 'research-data' not in str(a.get('path'))],
                           'repositories': [{'name': _public_path(r.get('path')), 'head': r.get('head_at_read'), 'dirty': r.get('dirty_at_read')}
                                            for r in meta.get('provenance', {}).get('repositories') or []],
                           'limitations': meta.get('limitations'), 'node_rules': meta.get('node_rules')}}


def export_world(world_id, recordings, out):
    base = recordings / world_id
    probe = np.load(base / 'probe' / 'run' / 'grids.npz')
    base_codes, base_heights = probe['codes'][-1], probe['height_cm'][-1]
    (out / world_id / 'g').mkdir(parents=True, exist_ok=True)
    walks = {}
    for folder in sorted((base / 'runs').glob('g*')):
        outcome = json.loads((folder / 'outcome.json').read_text()) if (folder / 'outcome.json').is_file() else None
        if not outcome or not outcome.get('finished') or not (folder / 'run' / 'session.json').is_file():
            continue
        data = walk_data(world_id, folder.name, folder / 'run', base_codes, base_heights)
        text = json.dumps(data, separators=(',', ':'))
        (out / world_id / 'g' / f'{folder.name}.json').write_text(text)
        types = {e['type'] for e in data['events']}
        walks[folder.name] = {'outcome': data['outcome'], 'duration_s': data['duration_s'], 'final_dist_m': data['final_dist_m'],
                              'final_dist_estimate_m': data['final_dist_estimate_m'], 'max_contact_n': data['max_contact_n'],
                              'deferred': 'stand_deferred' in types, 'forced': 'stand_forced' in types,
                              'path_m': data['path_m'], 'reason': data['reason'], 'bytes': len(text),
                              'sha256': hashlib.sha256(text.encode()).hexdigest()[:16]}
    index = world_index(world_id, base, walks)
    # A walk file the index does not list (an older recording of a redefined room) must not reach the site.
    for f in (out / world_id / 'g').glob('*.json'):
        if f.stem not in walks:
            f.unlink()
    (out / world_id / 'index.json').write_text(json.dumps(index, separators=(',', ':')))
    return index


def _grid_at(index_map, walk, t):
    """The robot's map (codes, heights) at time t of a walk: the start map plus every change up to t."""
    n = index_map['n']
    codes = np.frombuffer(base64.b64decode(index_map['codes']), np.uint8).copy()
    heights = np.frombuffer(base64.b64decode(index_map['height_cm']), np.uint8).copy()
    for step in walk['map']:
        if step['t'] > t + 1e-9:
            break
        idx = 0
        for gap, v in zip(step['g'], step['v']):
            idx += gap
            codes[idx], heights[idx] = (v // 1000, v % 1000) if v >= 1000 else (v, 0)
    return codes.reshape(n, n), heights.reshape(n, n)


def _box_distance(xy, box):
    """Distance from a point to a box footprint (0 inside)."""
    c, h = np.asarray(box['center_xy'], float), np.asarray(box['half_xy'], float)
    yaw = box.get('yaw', 0.0)
    d = np.asarray(xy, float) - c
    local = np.array([np.cos(yaw) * d[0] + np.sin(yaw) * d[1], -np.sin(yaw) * d[0] + np.cos(yaw) * d[1]])
    return float(np.linalg.norm(np.maximum(np.abs(local) - h, 0)))


def deferral_cause(index, walk):
    """Why a walk's stand was deferred, classified from the recorded map and the room's boxes (conservatively).

    node.py defers when its memory holds a ceiling below 1.35 m within 0.8 m. The site's map codes show such a
    ceiling only over floor (code 4), so the cause is read from the room: a real beam below 1.35 m nearby is a true
    low ceiling; a 0.8-1.35 m box nearby is the table-edge effect (STATUS #11); low overhead cells with no box within
    0.5 m are phantom ceilings (STATUS #15, the robot's own arms); anything else stays unclassified."""
    ev = next((e for e in walk['events'] if e['type'] == 'stand_deferred'), None)
    if ev is None:
        return None
    k = max(0, min(walk['n'] - 1, int(np.searchsorted(walk['time'], ev['t'], side='right')) - 1))
    robot = np.array(walk['est'][k * 2:k * 2 + 2], float) / 1000
    m = index['map']
    codes, heights = _grid_at(m, walk, ev['t'])
    lo, res, n = np.asarray(m['lo'], float), m['res_m'], m['n']
    ij = np.round((robot - lo) / res).astype(int)
    w = int(np.ceil(0.8 / res))
    cells = [lo + np.array([i, j]) * res
             for i in range(max(ij[0] - w, 0), min(ij[0] + w + 1, n)) for j in range(max(ij[1] - w, 0), min(ij[1] + w + 1, n))
             if codes[i, j] == 4 and heights[i, j] < 135]
    boxes = index['boxes']
    beams = [b for b in boxes if 0.3 < b['z_bottom'] < 1.35]
    tables = [b for b in boxes if 0.8 <= b['z_top'] <= 1.35 and b['z_bottom'] <= 0.3]
    if any(_box_distance(robot, b) <= 0.8 for b in beams):
        cause = 'real-overhead'
    elif any(_box_distance(robot, b) <= 0.9 for b in tables):
        cause = 'table-edge'
    elif cells and all(min(_box_distance(c, b) for b in boxes) > 0.5 for c in cells):
        cause = 'phantom'
    else:
        cause = 'unclassified'
    stood = next((e['t'] for e in walk['events'] if e['type'] in ('stand', 'stand_forced') and e['t'] > ev['t']), walk['time'][-1])
    return {'t': ev['t'], 'cells': len(cells), 'cause': cause, 'held_s': round(float(stood - ev['t']), 2)}


def featured(out, worlds):
    """One recorded example per finding on the site (site/js/findings.js), chosen by cause from the walks' data."""
    indexes = {w: json.loads((out / w / 'index.json').read_text()) for w in worlds}
    walks = []
    for w in worlds:
        listed = set(indexes[w]['walks'])
        files = {f.stem for f in (out / w / 'g').glob('g*.json')}
        if files != listed:
            raise ValueError(f'{w}: walk files and the room index disagree ({sorted(files ^ listed)[:5]})')
        for gid in sorted(listed):
            walks.append((w, json.loads((out / w / 'g' / f'{gid}.json').read_text())))
    pick, facts = {}, {'walks': len(walks)}
    causes = {'table-edge': [], 'phantom': [], 'real-overhead': [], 'unclassified': []}
    for w, d in walks:
        c = deferral_cause(indexes[w], d)
        if c:
            causes[c['cause']].append((w, d, c))
    facts['deferred'] = {k: len(v) for k, v in causes.items()}
    for key, cause, label in (('edge-ceiling', 'table-edge', 'Watch a deferral at a table edge'),
                              ('phantom', 'phantom', 'Watch a deferral with nothing overhead')):
        if causes[cause]:
            w, d, c = max(causes[cause], key=lambda x: x[2]['held_s'])
            if c['held_s'] >= 0.5:
                pick[key] = {'world': w, 'goal': d['goal_id'], 'label': label,
                             'note': f"{len(causes[cause])} of {len(walks)} recorded walks deferred a stand this way (classified from "
                                     f"the recorded map and the room's boxes). In this one the stand waits {c['held_s']:.1f} s, from {c['t']:.1f} s."}
    # The door: walks to the far side that cross the wall line through the 0.8 m door.
    if 'doorway' in indexes:
        far, through, clean, elsewhere = 0, 0, 0, 0
        half_door = min((abs(b['center_xy'][1]) - b['half_xy'][1] for b in indexes['doorway']['boxes']), default=0.4)
        best = None
        for w, d in walks:
            if w != 'doorway' or not d['goal'] or d['goal'][0] <= 2.3:
                continue
            far += 1
            xs = [d['q'][k * 36] / 1000 for k in range(d['n'])]
            ys = [d['q'][k * 36 + 1] / 1000 for k in range(d['n'])]
            crossing = next((ys[k] for k in range(1, d['n']) if xs[k - 1] < 2.0 <= xs[k]), None)
            door = crossing is not None and abs(crossing) < half_door
            through += door
            elsewhere += crossing is not None and not door
            ok = d['outcome'] == 'arrived' and (d['max_contact_n'] or 0) <= 100
            clean += door and ok
            if door and (best is None or (ok and not best[1])):
                best = (d, ok)
        facts['doorway'] = {'far_goals': far, 'through_door': through, 'through_clean': clean, 'crossed_elsewhere': elsewhere,
                            'door_halfwidth_m': half_door}
        if best:
            d, ok = best
            pick['doorway'] = {'world': 'doorway', 'goal': d['goal_id'], 'label': 'Watch it go through',
                               'note': f"{through} of {far} recorded walks to the far side went through the door; {clean} of them arrived without contact over 100 N."}
    # The beam: pelvis height under the beam's footprint against the same walk elsewhere.
    beams = [b for b in indexes.get('corridor', {}).get('boxes', []) if b['z_bottom'] > 0.3]
    if beams:
        b = beams[0]
        dips = []
        for w, d in walks:
            if w != 'corridor':
                continue
            under, other = [], []
            for k in range(d['n']):
                x, y, z = (d['q'][k * 36 + a] / 1000 for a in range(3))
                (under if _box_distance([x, y], b) == 0 else other).append(z)
            if under and other:
                dips.append((float(np.median(other) - min(under)), d, min(under), float(np.median(other))))
        clean = [x for x in dips if x[1]['outcome'] == 'arrived' and (x[1]['max_contact_n'] or 0) <= 100]
        facts['beam'] = {'walks_under': len(dips), 'clean': len(clean), 'beam_bottom_m': b['z_bottom'],
                         'pelvis_under_m': [round(x[2], 3) for x in dips], 'pelvis_elsewhere_m': [round(x[3], 3) for x in dips]}
        if dips:
            dip, d, zu, zo = max(clean or dips, key=lambda x: x[0])
            pick['beam'] = {'world': 'corridor', 'goal': d['goal_id'], 'label': 'Watch it pass under',
                            'note': f"This walk: lowest pelvis {zu:.2f} m under the beam against a median of {zo:.2f} m on the rest of the walk"
                                    + ('' if (d['max_contact_n'] or 0) <= 100 else f"; it also pushed against a wall with {d['max_contact_n']:.0f} N") + '.'}
    # Contact: the room where walks touch walls most, and one of its walks with a clear strike.
    touched = [(w, d) for w, d in walks if (d['max_contact_n'] or 0) > 100]
    by_room = {}
    for w, d in walks:
        r = by_room.setdefault(w, [0, 0]); r[0] += 1; r[1] += (d['max_contact_n'] or 0) > 100
    facts['contact'] = {w: {'walks': a, 'over_100n': b} for w, (a, b) in by_room.items()}
    def peak_xy(d):
        k = max(range(d['n']), key=lambda k: d['contact_n'][k] or 0)
        return d['q'][k * 36] / 1000, d['q'][k * 36 + 1] / 1000
    def end_distance(xy, box):
        c, h, yaw = np.asarray(box['center_xy'], float), box['half_xy'], box.get('yaw', 0.0)
        axis = np.array([np.cos(yaw), np.sin(yaw)]) if h[0] >= h[1] else np.array([-np.sin(yaw), np.cos(yaw)])
        half = max(h)
        return min(float(np.linalg.norm(np.asarray(xy) - (c + s * half * axis))) for s in (-1, 1))
    for w in by_room:
        mine = [d for x, d in touched if x == w]
        if mine and indexes[w]['boxes']:
            ends = [min(end_distance(peak_xy(d), b) for b in indexes[w]['boxes']) for d in mine]
            facts['contact'][w]['at_wall_end'] = int(sum(e <= 0.6 for e in ends))
    if touched:
        room = max(by_room, key=lambda w: by_room[w][1] / by_room[w][0])
        mine = sorted((d for w, d in touched if w == room), key=lambda d: d['max_contact_n'])
        if mine:
            d = mine[len(mine) // 2]
            pick['contact'] = {'world': room, 'goal': d['goal_id'], 'label': 'Watch a walk that touches',
                               'note': f"This walk peaks at {d['max_contact_n']:.0f} N and is still reported as {d['outcome']} by the node."}
    (out / 'featured.json').write_text(json.dumps({'examples': pick, 'facts': facts}, indent=1))
    return pick, facts


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--recordings', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--world', action='append', choices=sorted(WORLDS))
    args = ap.parse_args(argv)
    worlds = args.world or [w for w in WORLDS if (args.recordings / w / 'goals.json').is_file()]
    catalog = []
    for w in worlds:
        index = export_world(w, args.recordings, args.out)
        outcomes = {}
        for walk in index['walks'].values():
            outcomes[walk['outcome']] = outcomes.get(walk['outcome'], 0) + 1
        catalog.append({'id': w, 'title': index['title'], 'blurb': index['blurb'], 'walks': len(index['walks']), 'outcomes': outcomes,
                        'contact': sum((x['max_contact_n'] or 0) > 100 for x in index['walks'].values()),
                        'off_by_truth': sum(x['outcome'] == 'arrived' and (x['final_dist_m'] or 0) > 0.6 for x in index['walks'].values())})
        print(w, len(index['walks']), outcomes)
    (args.out / 'worlds.json').write_text(json.dumps({'v': SCHEMA, 'worlds': catalog}, indent=1))
    print('featured', featured(args.out, [c['id'] for c in catalog]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
