#!/usr/bin/env python3
"""Record the navigation stack walking from a world's start mark to every reachable goal on a grid (for the site).

Every goal is one fresh simulated-robot session run by ``studio/nav_worker.py``, the same worker behind Studio's
Navigate workspace: the robot boots standing at the start and pre-scans, gets one goal (checked by the worker on
its own map), Go, walks, settles to a stand, End. Nothing here touches a robot, DDS or the network; every
worker runs at the lowest CPU priority with two threads.

    .venv/bin/python -m tools.site.record_goals --world detour --out <dir> [--spacing 0.4] [--workers 6]

Writes into ``<out>/<world>/``: ``probe/`` (the boot session whose memory decides which goals are offered),
``goals.json`` (every grid cell's check), ``runs/<goal-id>/`` (full worker output) and ``status.json``.
Re-running skips goals that already have a finished recording.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from studio import paths  # noqa: E402
from tools.site.worlds import WORLDS, world_map  # noqa: E402

# The robot's deploy configuration (docs/NAVIGATE.md): the bundle's planner budget, the deploy PC's 160 ms planner
# latency with predictive anchoring, LIO-level odometry drift, one memory per session, the current G1 actuators.
PROFILES = {
    'deploy': {'planner': {'candidates': 16, 'ode_steps': 10}, 'latency': {'ms': 160, 'anchor': 'predict'},
               'odometry': 'lio', 'actuators': 'g1-current', 'map_mode': 'keep',
               'label': 'Deployed budget (K 16, ODE 10), 160 ms planner latency with predictive anchoring, LIO-level odometry drift'},
    'quick': {'planner': {'candidates': 2, 'ode_steps': 4}, 'latency': {'ms': 0, 'anchor': 'measured'},
              'odometry': 'truth', 'actuators': 'g1-current', 'map_mode': 'keep',
              'label': 'Quick budget (K 2, ODE 4), no latency, simulator-truth odometry'},
}
# The worker runs on the deploy repository's interpreter (torch, onnxruntime, mujoco), as the gateway launches it.
WORKER_PYTHON = paths.deploy_python()
MIN_GOAL_M = 0.8          # closer goals are inside twice the arrival radius: nothing to watch
BOOT_TIMEOUT_S = 600
WALK_TIMEOUT_S = 3600     # wall clock for one session; the worker's own limits are 60 s per walk, 180 s motion
_STOP = threading.Event()


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def write_json(path, data):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(path)


def request_for(world_id, profile, job_id, seed=0):
    spec, prof = WORLDS[world_id], PROFILES[profile]
    m, _ = world_map(world_id)
    return {'schema_version': 1, 'id': job_id, 'map': m, 'start_xy': spec['start_xy'], 'start_yaw_rad': spec['start_yaw_rad'],
            'seed': seed, 'planner': prof['planner'], 'latency': prof['latency'], 'actuators': prof['actuators'],
            'odometry': prof['odometry'], 'map_mode': prof['map_mode'], 'record_grids': True,
            'goal_radius_m': 0.4, 'prescan_s': 0.5, 'initial_prescan_s': 1.0, 'leg_timeout_s': 60, 'max_motion_s': 180,
            'idle_timeout_s': 600}


class Session:
    """One nav_worker process, driven through its inbox exactly as the gateway drives it."""

    def __init__(self, folder, request):
        self.folder = Path(folder)
        self.run = self.folder / 'run'
        self.seq = 0
        self.folder.mkdir(parents=True, exist_ok=False)
        write_json(self.folder / 'request.json', request)
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2',
                   MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2', NUMEXPR_NUM_THREADS='2', PYTHONPATH=str(ROOT))
        self.log = (self.folder / 'worker.log').open('wb')
        self.process = subprocess.Popen(
            ['nice', '-n', '19', str(WORKER_PYTHON), '-u', str(ROOT / 'studio/nav_worker.py'),
             '--request', str(self.folder / 'request.json'), '--output', str(self.run)],
            cwd=ROOT, env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)

    def latest(self):
        return read_json(self.run / 'latest.json') or {}

    def send(self, cmd, **fields):
        self.seq += 1
        write_json(self.run / 'inbox' / f'{self.seq:06d}.json', {'seq': self.seq, 'cmd': cmd, **fields})
        return self.seq

    def wait(self, predicate, timeout_s, poll_s=0.25):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline and not _STOP.is_set():
            latest = self.latest()
            if latest.get('status') in ('failed', 'completed') or self.process.poll() is not None:
                return latest
            if predicate(latest):
                return latest
            time.sleep(poll_s)
        return None

    def reply(self, seq, timeout_s=60):
        latest = self.wait(lambda l: any(c.get('seq') == seq for c in (l.get('navigation') or {}).get('commands') or []), timeout_s)
        for c in ((latest or {}).get('navigation') or {}).get('commands') or []:
            if c.get('seq') == seq:
                return c
        return None

    def finish(self, timeout_s=300, grace_s=30):
        try:
            self.process.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=grace_s)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.log.close()
        return read_json(self.run / 'result.json')

    def end(self):
        if self.process.poll() is None:
            if _STOP.is_set():  # stopping the batch: no graceful End, or a booting worker outlives a killed parent
                self.finish(timeout_s=0, grace_s=3)
                return None
            self.send('end')
        return self.finish()


def standing(latest):
    nav = latest.get('navigation') or {}
    return nav.get('phase') == 'WAIT' and (nav.get('can') or {}).get('goal')


def probe(world_id, profile, folder):
    """Boot once and keep the memory the robot has before any goal (identical in every session: same seed)."""
    if (folder / 'run' / 'result.json').is_file() and (folder / 'run' / 'memory.npz').is_file():
        return folder / 'run' / 'memory.npz'
    if folder.exists():
        raise SystemExit(f'{folder} exists without a finished probe; remove it first')
    s = Session(folder, request_for(world_id, profile, f'site-probe-{world_id}'))
    if s.wait(standing, BOOT_TIMEOUT_S) is None or not standing(s.latest()):
        s.end()
        raise SystemExit(f'probe for {world_id} never reached WAIT; see {folder}/worker.log')
    time.sleep(1.0)  # the worker writes memory.npz at most every 0.5 s
    result = s.end()
    if not result or result.get('status') != 'completed':
        raise SystemExit(f'probe for {world_id} failed: {result}')
    return folder / 'run' / 'memory.npz'


def candidate_goals(world_id, memory_path, spacing):
    """Grid cells inside the world and the memory, with Studio's own goal check from the start pose."""
    import numpy as np
    from studio import goal_check
    spec = WORLDS[world_id]
    _, bounds = world_map(world_id)
    grid = goal_check.load_grid(memory_path)
    lo, res, n = np.asarray(grid['lo']), float(grid['res']), grid['support'].shape[0]
    hi = lo + (n - 1) * res
    bmin = np.maximum(np.asarray(bounds['min'], dtype=float), lo) + 0.2
    bmax = np.minimum(np.asarray(bounds['max'], dtype=float), hi) - 0.2
    start = np.asarray(spec['start_xy'], dtype=float)
    # The lattice passes through the start mark, so goals line up with it.
    xs = start[0] + spacing * np.arange(math.ceil((bmin[0] - start[0]) / spacing), math.floor((bmax[0] - start[0]) / spacing) + 1)
    ys = start[1] + spacing * np.arange(math.ceil((bmin[1] - start[1]) / spacing), math.floor((bmax[1] - start[1]) / spacing) + 1)
    cells = []
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            xy = [round(float(x), 3), round(float(y), 3)]
            result = goal_check.check_goal(grid, start, xy, arrival_radius_m=0.4, basis='planner memory')
            far = math.dist(xy, start) >= MIN_GOAL_M
            cells.append({'id': f'g{i:02d}-{j:02d}', 'xy': xy, 'ok': bool(result['ok'] and far),
                          'checks': [{k: c[k] for k in ('id', 'status', 'label')} for c in result['checks']],
                          'path_m': result['path_m'], 'straight_m': result['straight_m'],
                          'path_xy': None if result['path_xy'] is None else [[round(x, 2), round(y, 2)] for x, y in result['path_xy']]})
    return cells


def level(cell):
    """0: the 2-spacing lattice; 1: its centres (with 0, a checkerboard); 2: the rest."""
    i, j = (int(v) for v in cell['id'][1:].split('-'))
    return 0 if i % 2 == 0 and j % 2 == 0 else 1 if (i + j) % 2 == 0 else 2


def order(cells, start):
    """Coarse lattice first, then the in-between cells, so a partial batch still covers the whole room."""
    return sorted(cells, key=lambda c: (level(c), math.dist(c['xy'], start)))


def walk(world_id, profile, folder, goal):
    """One session: boot, goal, Go, wait for the walk's outcome and the settle, End."""
    done = read_json(folder / 'outcome.json')
    if done and done.get('finished'):
        return done
    if _STOP.is_set():  # the batch is stopping: queued goals start no worker
        return {'goal_id': goal['id'], 'goal_xy': goal['xy'], 'finished': False, 'error': 'batch stopped'}
    if folder.exists():
        import shutil
        shutil.rmtree(folder)  # an interrupted attempt: start it again from nothing
    started = time.monotonic()
    s = Session(folder, request_for(world_id, profile, f"site-{world_id}-{goal['id']}"))
    out = {'goal_id': goal['id'], 'goal_xy': goal['xy'], 'finished': False}
    try:
        if s.wait(standing, BOOT_TIMEOUT_S) is None or not standing(s.latest()):
            out['error'] = 'never reached WAIT'
            return out
        reply = s.reply(s.send('goal', xy=goal['xy']))
        if not reply or reply.get('status') != 'applied':
            out.update(finished=True, outcome='refused', reason=(reply or {}).get('reason') or 'no reply')
            return out
        reply = s.reply(s.send('go'))
        if not reply or reply.get('status') != 'applied':
            out['error'] = f'go not applied: {reply}'
            return out

        def walked(latest):
            nav = latest.get('navigation') or {}
            legs = nav.get('legs') or []
            return bool(legs and legs[-1].get('outcome') and nav.get('paused'))
        latest = s.wait(walked, WALK_TIMEOUT_S, poll_s=0.5)
        if latest is None:
            out['error'] = 'walk did not finish within the wall-clock bound'
    finally:
        result = s.end()
        if _STOP.is_set():
            return {**out, 'finished': False, 'error': 'batch stopped'}  # nothing written: a resumed batch walks it again
        legs = ((result or {}).get('report') or {}).get('legs') or []
        if legs and not out.get('outcome'):
            leg = legs[-1]
            out.update(finished=result.get('status') == 'completed' and not out.get('error'), outcome=leg.get('outcome'),
                       reason=leg.get('reason'), duration_s=leg.get('duration_s'), final_dist_true_m=leg.get('final_dist_true_m'),
                       path_m=leg.get('path_m'), real_time_factor=(result.get('report') or {}).get('worker_real_time_factor'))
        out['wall_s'] = round(time.monotonic() - started, 1)
        write_json(folder / 'outcome.json', out)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--world', required=True, choices=sorted(WORLDS))
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--profile', default='deploy', choices=sorted(PROFILES))
    ap.add_argument('--spacing', type=float, default=0.4)
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--limit', type=int, default=None, help='record at most this many goals (in coverage order)')
    ap.add_argument('--max-level', type=int, default=2, choices=(0, 1, 2),
                    help='0: 2-spacing lattice, 1: plus its centres (a checkerboard), 2: every cell')
    args = ap.parse_args(argv)
    base = args.out / args.world
    base.mkdir(parents=True, exist_ok=True)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: _STOP.set())
    memory = probe(args.world, args.profile, base / 'probe')
    cells = candidate_goals(args.world, memory, args.spacing)
    write_json(base / 'goals.json', {'world': args.world, 'profile': args.profile, 'profile_label': PROFILES[args.profile]['label'],
                                     'spacing_m': args.spacing, 'cells': cells})
    todo = order([c for c in cells if c['ok'] and level(c) <= args.max_level], WORLDS[args.world]['start_xy'])[:args.limit]
    print(f'{args.world}: {len(todo)} goals of {len(cells)} cells', flush=True)
    results, lock = {}, threading.Lock()

    def status():
        with lock:
            write_json(base / 'status.json', {'world': args.world, 'total': len(todo), 'done': len(results),
                                              'outcomes': {k: sum(r.get('outcome') == k for r in results.values())
                                                           for k in {r.get('outcome') for r in results.values()}},
                                              'errors': [r for r in results.values() if r.get('error')][:20]})
    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(walk, args.world, args.profile, base / 'runs' / c['id'], c): c for c in todo}
        for future in cf.as_completed(futures):
            c = futures[future]
            try:
                r = future.result()
            except Exception as exc:  # one broken session never stops the batch
                r = {'goal_id': c['id'], 'error': f'{type(exc).__name__}: {exc}', 'finished': False}
            with lock:
                results[c['id']] = r
            status()
            print(f"{args.world} {len(results)}/{len(todo)} {c['id']} {r.get('outcome')} {r.get('error') or ''} {r.get('wall_s')}s", flush=True)
    if _STOP.is_set():
        print(f'{args.world}: stopped; run it again to resume', flush=True)
        return 143  # non-zero, so record_all.sh (set -e) stops too instead of starting the next room
    return 0


if __name__ == '__main__':
    sys.exit(main())
