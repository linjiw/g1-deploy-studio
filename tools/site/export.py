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
        tilt.append(int(round((h.get('tilt_rad') or 0) * 1000)))
        force.append(int(round(h.get('contact_force_n') or 0)))
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
    events = [{'t': round(float(e['time']), 3), 'type': e['type'], 'msg': e['message']}
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
            'provenance': {'policy': meta.get('policy_profile'), 'artifacts': meta.get('provenance', {}).get('artifacts'),
                           'repositories': meta.get('provenance', {}).get('repositories'),
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
        walks[folder.name] = {'outcome': data['outcome'], 'duration_s': data['duration_s'], 'final_dist_m': data['final_dist_m'],
                              'path_m': data['path_m'], 'reason': data['reason'], 'bytes': len(text),
                              'sha256': hashlib.sha256(text.encode()).hexdigest()[:16]}
    index = world_index(world_id, base, walks)
    (out / world_id / 'index.json').write_text(json.dumps(index, separators=(',', ':')))
    return index


def featured(out, worlds):
    """One recorded example per finding on the site (site/js/findings.js), chosen from the walks' own events."""
    walks = []
    for w in worlds:
        for f in sorted((out / w / 'g').glob('g*.json')):
            d = json.loads(f.read_text())
            types = {e['type'] for e in d['events']}
            min_z = min((min(p['z']) for p in d['plans'] if p['z']), default=None)
            walks.append({'world': w, 'goal': d['goal_id'], 'outcome': d['outcome'], 'types': types, 'xy': d['goal'],
                          'min_plan_z_cm': min_z, 'duration_s': d['duration_s'] or 0})
    pick = {}
    deferred = [x for x in walks if 'stand_deferred' in x['types']]
    if deferred:
        x = min(deferred, key=lambda x: (x['world'] not in ('clutter', 'doorway'), x['duration_s']))
        pick['edge-ceiling'] = {'world': x['world'], 'goal': x['goal'], 'label': 'Watch a deferred stand',
                                'note': f"{len(deferred)} of {len(walks)} recorded walks deferred their stand at least once."}
    door = [x for x in walks if x['world'] == 'doorway' and x['xy'] and x['xy'][0] > 2.3]
    bad = [x for x in door if x['outcome'] != 'arrived']
    if door:
        x = min(bad, key=lambda x: x['duration_s']) if bad else max(door, key=lambda x: x['xy'][0])
        pick['doorway'] = {'world': 'doorway', 'goal': x['goal'], 'label': 'Watch one that did not make it' if bad else 'Watch it go through',
                           'note': f"{sum(x['outcome'] == 'arrived' for x in door)} of {len(door)} goals beyond the door arrived."}
    beam = [x for x in walks if x['world'] == 'corridor' and x['outcome'] == 'arrived' and x['xy'] and x['xy'][0] > 2.6
            and abs(x['xy'][1]) < 0.5 and x['min_plan_z_cm'] is not None]
    if beam:
        x = min(beam, key=lambda x: x['min_plan_z_cm'])
        pick['beam'] = {'world': 'corridor', 'goal': x['goal'], 'label': 'Watch it duck',
                        'note': f"Lowest planned pelvis height on this walk: {x['min_plan_z_cm'] / 100:.2f} m (standing: about 0.79 m)."}
    (out / 'featured.json').write_text(json.dumps(pick, indent=1))
    return pick


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
        catalog.append({'id': w, 'title': index['title'], 'blurb': index['blurb'], 'walks': len(index['walks']), 'outcomes': outcomes})
        print(w, len(index['walks']), outcomes)
    (args.out / 'worlds.json').write_text(json.dumps({'v': SCHEMA, 'worlds': catalog}, indent=1))
    print('featured', featured(args.out, [c['id'] for c in catalog]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
