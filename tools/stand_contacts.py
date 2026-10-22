#!/usr/bin/env python3
"""Stand-time contacts: node.py's stand chunk (arms to the default pose) vs holding waist and arms (docs/DEPLOY_FIDELITY.md).

Runs paired simulated walks with ``studio/nav_worker.py`` (the Navigate simulated robot): the same world, goal and
seed once per stand mode. Each walk is one fresh session driven through the worker's inbox as the gateway drives it:
boot standing, stage the goal (checked by the worker on its own map), Go, walk, arrive or stop, settle to a stand,
End. Until the first stand the two modes run the same physics, so every difference is the stand chunk's.

    .venv/bin/python -m tools.stand_contacts --out <dir> --dry-run           # the plan only
    .venv/bin/python -m tools.stand_contacts --out <dir> --walks 8 --workers 2

Every worker runs at nice 19 on 2 CPU threads, with no GPU. A worker starts only while MemAvailable is at least
--min-mem-gb. Writes ``<out>/<world>/<mode>/w<NN>/`` (full worker output), ``results.jsonl`` and ``summary.json`` and
prints a table. Nothing here touches a robot, DDS or the network.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from studio.nav_worker import STAND_MODES, summarize_contacts  # noqa: E402
from studio.policy_worker import REFERENCE_PYTHON, REFERENCE_ROOT  # noqa: E402

# The robot's deploy configuration (as tools/site/record_goals.py 'deploy') and the quick CPU budget.
PROFILES = {
    'deploy': {'planner': {'candidates': 16, 'ode_steps': 10}, 'latency': {'ms': 160, 'anchor': 'predict'},
               'odometry': 'lio', 'actuators': 'g1-current', 'map_mode': 'keep'},
    'quick': {'planner': {'candidates': 2, 'ode_steps': 4}, 'latency': {'ms': 0, 'anchor': 'measured'},
              'odometry': 'truth', 'actuators': 'g1-current', 'map_mode': 'keep'},
}
WALL_HEIGHT_M = 1.8  # above node.py's 1.35 m ceiling-deferral height: the stand is never deferred by a wall top


def narrow_world(width_m):
    """A straight passage ``width_m`` wide between two 1.8 m walls, x 1.2 .. 3.6 m, entered from the start at the origin."""
    half = width_m / 2
    wall = lambda y: {'center_xy': [2.4, y], 'half_xy': [1.2, 0.1], 'yaw': 0.0, 'z_bottom': 0.0, 'z_top': WALL_HEIGHT_M}
    return {'id': f'narrow-{int(round(width_m * 100))}', 'label': f'Narrow passage {width_m:.2f} m', 'kind': 'boxes',
            'frame_id': 'world', 'boxes': [wall(half + 0.1), wall(-half - 0.1)],
            'source': f'tools/stand_contacts.py narrow_world({width_m})'}


def detour_world():
    from studio.workbench import development_maps
    data = next(m for m in development_maps(REFERENCE_ROOT) if m['id'] == 'flow-detour')
    return {'id': 'flow-detour', 'label': data.get('label', 'Flow detour'), 'kind': 'boxes', 'frame_id': 'world',
            'boxes': [{k: b[k] for k in ('center_xy', 'half_xy', 'yaw', 'z_bottom', 'z_top') if k in b} for b in data['boxes']],
            'source': str(data.get('provenance') or 'flow-detour')[:900]}


def worlds(narrow_width_m):
    # Goals where the arrival stand happens next to a wall. Detour wall (flow-detour): front face x ~1.72, back face
    # x ~1.94, ends near (1.76, 0.44) and (1.90, -0.93); the goals sit 0.36-0.40 m from a face or an end (the goal check
    # blocks goals within 0.30 m of a tall obstacle). Narrow passage: on the centreline and 0.18 m off it. The deploy
    # route keeps 0.35 m from walls and grows them 0.1 m into unseen space, so it cannot enter a passage much narrower
    # than about 1.0 m (0.75 and 0.9 m: "No route").
    return {
        'detour': {'map': detour_world, 'start_xy': [0.0, 0.0], 'start_yaw_rad': 0.0,
                   'goals': [[1.33, -0.2], [2.33, -0.25], [1.72, 0.8], [1.95, -1.3]]},
        'narrow': {'map': lambda: narrow_world(narrow_width_m), 'start_xy': [0.0, 0.0], 'start_yaw_rad': 0.0,
                   'goals': [[2.0, 0.0], [2.6, 0.18], [3.1, -0.18], [2.3, 0.0]]},
    }


def mem_available_gb():
    for line in Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) / 1024 / 1024
    return 0.0


_LAUNCH = threading.Lock()
_STOP = threading.Event()


def wait_for_memory(min_gb, timeout_s=3600):
    deadline = time.monotonic() + timeout_s
    while not _STOP.is_set():
        free = mem_available_gb()
        if free >= min_gb:
            return free
        if time.monotonic() > deadline:
            raise RuntimeError(f'MemAvailable stayed below {min_gb} GB for {timeout_s} s')
        print(f'  waiting: MemAvailable {free:.1f} GB < {min_gb} GB', flush=True)
        time.sleep(15)
    raise RuntimeError('stopped')


class Session:
    """One nav_worker process driven through its inbox (as the gateway and tools/site/record_goals.py do)."""

    def __init__(self, folder, request, min_mem_gb):
        self.folder, self.seq = Path(folder), 0
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / 'request.json').write_text(json.dumps(request, indent=1))
        self.output = self.folder / 'run'
        env = dict(os.environ, PYTHONPATH=str(ROOT), CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2',
                   OPENBLAS_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
        self.log = (self.folder / 'worker.log').open('wb')
        with _LAUNCH:  # one launch at a time, each behind the memory gate
            wait_for_memory(min_mem_gb)
            self.process = subprocess.Popen(['nice', '-n', '19', str(REFERENCE_PYTHON), '-B', str(ROOT / 'studio/nav_worker.py'),
                                             '--request', str(self.folder / 'request.json'), '--output', str(self.output)],
                                            stdout=self.log, stderr=subprocess.STDOUT, env=env, cwd=ROOT, start_new_session=True)
            time.sleep(5)

    def latest(self):
        try:
            return json.loads((self.output / 'latest.json').read_text())
        except (OSError, ValueError):
            return {}

    def wait(self, predicate, timeout_s, what):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline and not _STOP.is_set():
            latest = self.latest()
            if latest and predicate(latest):
                return latest
            if self.process.poll() is not None:
                latest = self.latest()
                if latest and predicate(latest):
                    return latest
                raise RuntimeError(f'worker exited ({self.process.returncode}) before {what}; see {self.log.name}')
            time.sleep(0.5)
        raise RuntimeError(f'timed out waiting for {what}')

    def send(self, cmd, **fields):
        self.seq += 1
        body = dict(fields, seq=self.seq, cmd=cmd)
        tmp = self.output / 'inbox' / f'{self.seq:06d}.json.tmp'
        tmp.write_text(json.dumps(body))
        tmp.replace(self.output / 'inbox' / f'{self.seq:06d}.json')
        seq = self.seq
        latest = self.wait(lambda l: any(c['seq'] == seq for c in (l.get('navigation') or {}).get('commands', [])),
                           120, f'the reply to {cmd}')
        return next(c for c in latest['navigation']['commands'] if c['seq'] == seq)

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(60)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.log.close()


def standing(latest):
    n = latest.get('navigation') or {}
    return n.get('paused') and n.get('phase') in ('WAIT', 'ARRIVED', 'STOPPED')


def run_walk(spec, out, min_mem_gb, walk_wall_s):
    """One session, one walk. Returns the result row (never raises for a worker failure)."""
    folder = out / spec['world'] / spec['stand_mode'] / f"w{spec['index']:02d}"
    done = folder / 'row.json'
    if done.is_file():
        return json.loads(done.read_text())
    row = dict(spec, status=None, error=None)
    s = None
    try:
        s = Session(folder, spec['request'], min_mem_gb)
        s.wait(standing, 900, 'the boot stand')
        reply = s.send('goal', xy=spec['goal_xy'])
        if reply['status'] != 'applied':
            row.update(status='goal_rejected', error=reply.get('reason'))
        else:
            s.send('go')
            s.wait(lambda l: l.get('status') in ('completed', 'failed') or standing(l) and (
                (l['navigation'].get('legs') or [{}])[-1].get('outcome') or l['navigation'].get('fallen')),
                walk_wall_s, 'the walk to end')
            row['status'] = 'walked'
        if s.latest().get('status') not in ('completed', 'failed'):  # a fall ends the session by itself
            s.send('end')
        s.wait(lambda l: l.get('status') in ('completed', 'failed'), 300, 'completion')
        s.process.wait(120)
    except Exception as exc:  # recorded per walk; the batch goes on
        row.update(status='error', error=f'{type(exc).__name__}: {exc}'[:500])
    finally:
        if s is not None:
            s.close()
    session_path = folder / 'run' / 'session.json'
    if session_path.is_file():
        row.update(read_session(session_path))
    row.pop('request', None)
    done.write_text(json.dumps(row, indent=1))
    return row


def read_session(path):
    session = json.loads(path.read_text())
    meta = session['metadata']
    legs = meta.get('navigation', {}).get('legs') or []
    leg = legs[0] if legs else {}
    stands = [e for e in session['events'] if e['type'] == 'stand']
    first_stand_s = stands[0]['time'] if stands else None
    # Fingerprint of the physics before the first stand: equal across modes when the walks are paired.
    before = [f['qpos'] for f in session['frames'] if first_stand_s is None or f['time'] < first_stand_s - 1e-9]
    contacts = list(leg.get('contacts') or [])
    report = meta.get('test_result') or {}
    return {'outcome': leg.get('outcome'), 'reason': leg.get('reason'), 'final_dist_true_m': leg.get('final_dist_true_m'),
            'duration_s': leg.get('duration_s'), 'max_contact_n': leg.get('max_contact_n'),
            'first_stand_s': first_stand_s, 'stand_reason': stands[0].get('reason') if stands else None,
            'pre_stand_frames': len(before),
            'pre_stand_sha256': hashlib.sha256(json.dumps(before).encode()).hexdigest(),
            'contacts': contacts, 'contacts_unlisted': leg.get('contacts_unlisted', 0),
            'fell': leg.get('outcome') in ('fell', 'estop') or any(e['type'] in ('fall', 'estop') for e in session['events']),
            'stand_mode_recorded': (meta.get('node_rules') or {}).get('stand_mode'),
            'plan_latency_s': report.get('plan_latency_s'), 'latency_model': meta.get('latency_model', {}).get('mode', 'fixed')}


def summarize(rows, threshold_n=0.0):
    """Per (world, stand mode): goals, walks with contact, and contact episodes by stand / walking and body group."""
    table = {}
    for row in rows:
        key = (row['world'], row['stand_mode'])
        t = table.setdefault(key, {'world': row['world'], 'stand_mode': row['stand_mode'], 'walks': 0, 'errors': 0,
                                   'goal_rejected': 0, 'arrived': 0, 'falls': 0, 'walks_with_contact': 0,
                                   'walks_with_stand_contact': 0, 'episodes': []})
        if row['status'] in ('error', None) or row.get('outcome') is None:
            t['errors' if row['status'] != 'goal_rejected' else 'goal_rejected'] += 1
            continue
        t['walks'] += 1
        t['arrived'] += row['outcome'] == 'arrived'
        t['falls'] += bool(row.get('fell'))
        eps = [e for e in row['contacts'] if e['peak_n'] > threshold_n]
        t['walks_with_contact'] += bool(eps)
        t['walks_with_stand_contact'] += any(e.get('stand') for e in eps)
        t['episodes'] += eps
    out = []
    for t in table.values():
        s = summarize_contacts(t.pop('episodes'), threshold_n)
        out.append(dict(t, stand_episodes=s['stand']['episodes'], stand_by_group=s['stand']['by_group'],
                        stand_peak_n=s['stand']['peak_n'], walking_episodes=s['walking']['episodes'],
                        walking_by_group=s['walking']['by_group'], threshold_n=threshold_n))
    return sorted(out, key=lambda r: (r['world'], STAND_MODES.index(r['stand_mode'])))


def pairing(rows):
    """Walk pairs (same world, goal, seed) whose physics before the first stand is bitwise equal across modes."""
    by = {}
    for row in rows:
        if row.get('pre_stand_sha256'):
            by.setdefault((row['world'], tuple(row['goal_xy']), row['seed']), {})[row['stand_mode']] = row
    pairs = [v for v in by.values() if len(v) == len(STAND_MODES)]
    same = sum(len({r['pre_stand_sha256'] for r in v.values()}) == 1 for v in pairs)
    return {'pairs': len(pairs), 'identical_before_first_stand': same}


def table_text(summary):
    head = ('| world | stand mode | walks | arrived | falls | walks with contact | walks with stand-time contact | '
            'stand-time episodes (arm / leg / torso / head) | walking episodes (arm / leg / torso / head) |')
    lines = [head, '|' + '---|' * 9]
    for r in summary:
        sg, wg = r['stand_by_group'], r['walking_by_group']
        lines.append(f"| {r['world']} | {r['stand_mode']} | {r['walks']} | {r['arrived']} | {r['falls']} | {r['walks_with_contact']} | "
                     f"{r['walks_with_stand_contact']} | {r['stand_episodes']} ({sg['arm']} / {sg['leg']} / {sg['torso']} / {sg['head']}) | "
                     f"{r['walking_episodes']} ({wg['arm']} / {wg['leg']} / {wg['torso']} / {wg['head']}) |")
    return '\n'.join(lines)


def plan(args):
    specs, ws = [], worlds(args.narrow_width)
    prof = PROFILES[args.profile]
    for world in args.worlds:
        w = ws[world]
        m = w['map']()
        for i in range(args.walks):
            goal = w['goals'][i % len(w['goals'])]
            seed = args.seed0 + i // len(w['goals'])
            for mode in args.modes:
                req = {'schema_version': 1, 'id': f'stand-{world}-{mode}-{i:02d}'.replace('_', '-'), 'map': m,
                       'start_xy': w['start_xy'], 'start_yaw_rad': w['start_yaw_rad'], 'seed': seed,
                       'planner': prof['planner'], 'latency': prof['latency'], 'actuators': prof['actuators'],
                       'odometry': prof['odometry'], 'map_mode': prof['map_mode'], 'stand_mode': mode,
                       'goal_radius_m': 0.4, 'prescan_s': 0.5, 'initial_prescan_s': 1.0, 'leg_timeout_s': args.leg_timeout,
                       'max_motion_s': args.leg_timeout + 20, 'idle_timeout_s': 600}
                specs.append({'world': world, 'stand_mode': mode, 'index': i, 'goal_xy': goal, 'seed': seed,
                              'profile': args.profile, 'request': req})
    return specs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--worlds', nargs='+', default=['detour', 'narrow'], choices=['detour', 'narrow'])
    ap.add_argument('--modes', nargs='+', default=list(STAND_MODES), choices=list(STAND_MODES))
    ap.add_argument('--walks', type=int, default=8, help='walks per world and stand mode')
    ap.add_argument('--seed0', type=int, default=0)
    ap.add_argument('--profile', default='deploy', choices=sorted(PROFILES))
    ap.add_argument('--narrow-width', type=float, default=1.1, help='narrow passage width between the walls (m)')
    ap.add_argument('--leg-timeout', type=float, default=40.0)
    ap.add_argument('--workers', type=int, default=2, help='simulation workers at a time (at most 2 on the shared host)')
    ap.add_argument('--min-mem-gb', type=float, default=11.0)
    ap.add_argument('--walk-wall-s', type=float, default=1800.0)
    ap.add_argument('--threshold-n', type=float, default=0.0, help='count contact episodes whose peak exceeds this')
    ap.add_argument('--summarize-only', action='store_true', help='re-read the finished walks under --out')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args(argv)
    if not 1 <= args.workers <= 2:
        raise SystemExit('--workers must be 1 or 2 on the shared host')
    specs = plan(args)
    if args.dry_run:
        for s in specs:
            print(f"{s['world']:7s} {s['stand_mode']:10s} w{s['index']:02d} goal {s['goal_xy']} seed {s['seed']} ({s['profile']})")
        print(f'{len(specs)} sessions; {args.workers} at a time; MemAvailable now {mem_available_gb():.1f} GB')
        return 0
    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    if args.summarize_only:
        rows = [json.loads(p.read_text()) for p in sorted(args.out.glob('*/*/w*/row.json'))]
    else:
        with (args.out / 'results.jsonl').open('a') as log, cf.ThreadPoolExecutor(args.workers) as pool:
            futures = {pool.submit(run_walk, s, args.out, args.min_mem_gb, args.walk_wall_s): s for s in specs}
            try:
                for fut in cf.as_completed(futures):
                    row = fut.result()
                    rows.append(row)
                    log.write(json.dumps(row) + '\n')
                    log.flush()
                    print(f"{row['world']:7s} {row['stand_mode']:10s} w{row['index']:02d}: {row['status']} {row.get('outcome')} "
                          f"stand-contacts {sum(bool(e.get('stand')) for e in row.get('contacts', []))} "
                          f"walk-contacts {sum(not e.get('stand') for e in row.get('contacts', []))}", flush=True)
            except KeyboardInterrupt:
                _STOP.set()
                raise
    summary = summarize(rows, args.threshold_n)
    result = {'schema_version': 1, 'created_unix_s': time.time(), 'profile': args.profile, 'narrow_width_m': args.narrow_width,
              'threshold_n': args.threshold_n, 'summary': summary, 'pairing': pairing(rows),
              'at_100n': summarize(rows, 100.0)}
    (args.out / 'summary.json').write_text(json.dumps(result, indent=1))
    print(table_text(summary))
    print(f"\nat > 100 N:\n{table_text(result['at_100n'])}")
    print(f"\npairing: {result['pairing']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
