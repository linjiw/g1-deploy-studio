#!/usr/bin/env python3
"""Bounded navigation-robustness campaign driver (stdlib only).

Creates saved scenarios for the random-goal arenas made by make_arenas.mjs and
runs them as sequential suites through the user's Studio gateway. It never
starts a worker itself, never bypasses the single-worker lock and only uses the
public API (POST /api/scenarios, /api/suites, /api/suites/cancel).

    python3 tools/campaign/campaign.py --evidence <dir> [--start-epoch S] [--budget-h 2.5]

State is kept in <evidence>/campaign_state.json so a restart skips finished phases.
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

WX = 'flow-wx-rf-23326aa-s0'
BUNDLE = 'flow-bundle-20261008'
SHORT = {WX: 'WX-RF 23326aa', BUNDLE: 'Flow bundle 2026-10-08'}
ARENAS = ('open', 'clutter', 'doorway', 'slalom')
# Pre-registered before any run: the 2 clutter and 2 doorway presets whose
# straight start-goal line intersects a box (the obstructed cases).
P5_PRESETS = [('clutter', 1), ('clutter', 4), ('doorway', 4), ('doorway', 5)]


def phases():
    every = [(a, i) for a in ARENAS for i in range(6)]
    cd = [(a, i) for a in ('clutter', 'doorway') for i in range(6)]
    cl = [('clutter', i) for i in range(6)]
    lat0 = {'ms': 0, 'anchor': 'measured'}
    return [
        ('P1', 'WX-RF K8/ODE6 · all presets', [dict(arena=a, idx=i, policy=WX, k=8, ode=6, seed=0, latency=lat0) for a, i in every]),
        ('P2', 'Bundle K4/ODE6 · all presets', [dict(arena=a, idx=i, policy=BUNDLE, k=4, ode=6, seed=0, latency=lat0) for a, i in every]),
        ('P3', 'WX-RF lat 200 measured · clutter+doorway', [dict(arena=a, idx=i, policy=WX, k=8, ode=6, seed=0, latency={'ms': 200, 'anchor': 'measured'}) for a, i in cd]),
        ('P4', 'WX-RF seeds 1,2 · clutter', [dict(arena=a, idx=i, policy=WX, k=8, ode=6, seed=s, latency=lat0) for s in (1, 2) for a, i in cl]),
        ('P5', 'WX-RF K16/ODE10 · 4 obstructed presets', [dict(arena=a, idx=i, policy=WX, k=16, ode=10, seed=0, latency=lat0) for a, i in P5_PRESETS]),
        ('P6', 'Bundle lat 200 predict · clutter+doorway', [dict(arena=a, idx=i, policy=BUNDLE, k=4, ode=6, seed=0, latency={'ms': 200, 'anchor': 'predict'}) for a, i in cd]),
    ]


class Api:
    def __init__(self, base):
        self.base, self.token = base.rstrip('/'), None

    def _call(self, method, path, body=None, timeout=60):
        headers = {'Accept': 'application/json'}
        data = None
        if method == 'POST':
            if self.token is None:
                self.token = self.get('/api/workbench')['csrf_token']
            headers.update({'Origin': self.base, 'Content-Type': 'application/json', 'X-Studio-Token': self.token})
            data = json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    def get(self, path, timeout=60):
        return self._call('GET', path, timeout=timeout)

    def post(self, path, body):
        try:
            return self._call('POST', path, body)
        except urllib.error.HTTPError as err:
            if err.code == 403:  # token rotated (gateway restart): refresh once
                self.token = None
                return self._call('POST', path, body)
            raise


def log(evidence, message):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    with open(evidence / 'progress.log', 'a') as handle:
        handle.write(line + '\n')


def save(path, data):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, path)


def scenario_body(spec, arena):
    preset = arena['server_presets'][spec['idx']]
    lat = spec['latency']
    suffix = f" · lat {lat['ms']}{'p' if lat['anchor'] == 'predict' else ''}" if lat['ms'] else ''
    label = f"{arena['server_label']} · {preset['label']} · {SHORT[spec['policy']]} · K{spec['k']}/ODE{spec['ode']} · s{spec['seed']}{suffix}"
    if len(label) > 100:
        label = label.replace(f" · seed {arena['seed']}", '')
    return {'label': label[:100], 'map_id': arena['arena_id'], 'backend_id': 'flow-sonic-cpu', 'policy_id': spec['policy'],
            'criterion': 'arrive_hold', 'latency': lat, 'duration_s': 10, 'start_xy': preset['start_xy'],
            'goal_xy': preset['goal_xy'], 'start_yaw_rad': preset['start_yaw_rad'], 'seed': spec['seed'],
            'planner': {'candidates': spec['k'], 'ode_steps': spec['ode']}}


def run_suite(api, evidence, state, key, label, scenario_ids, deadline, poll_s):
    entry = state['suites'].get(key)
    if entry and entry.get('status') in ('completed', 'cancelled', 'interrupted', 'failed'):
        log(evidence, f'{key}: already {entry["status"]} ({entry["id"]}); skipping')
        return entry
    if entry is None:
        if time.time() > deadline:
            log(evidence, f'{key}: campaign budget exhausted before start; skipped')
            state['suites'][key] = {'status': 'skipped_budget'}
            return state['suites'][key]
        suite = api.post('/api/suites', {'label': label, 'scenario_ids': scenario_ids})
        state['suites'][key] = {'id': suite['id'], 'status': suite['status'], 'started': time.time(), 'n': len(scenario_ids)}
        save(evidence / 'campaign_state.json', state)
        log(evidence, f'{key}: started {suite["id"]} with {len(scenario_ids)} runs')
    sid = state['suites'][key]['id']
    failures, last = 0, None
    cancelled_for_budget = False
    while True:
        try:
            suite = api.get(f'/api/suites?id={sid}')
            failures = 0
        except (urllib.error.URLError, OSError, ValueError) as err:
            failures += 1
            log(evidence, f'{key}: poll failed ({failures}): {err}')
            if failures >= 6:
                state['suites'][key]['status'] = 'gateway_unreachable'
                save(evidence / 'campaign_state.json', state)
                raise SystemExit(3)
            time.sleep(poll_s)
            continue
        done = [r for r in suite['runs'] if r['status'] not in ('queued', 'running', 'starting')]
        current = next((r for r in suite['runs'] if r['status'] in ('running', 'starting')), None)
        summary = (len(done), suite['status'], current and current.get('job_id'), done and done[-1].get('outcome'))
        if summary != last:
            last = summary
            outs = {}
            for r in done:
                outs[r.get('outcome') or r['status']] = outs.get(r.get('outcome') or r['status'], 0) + 1
            log(evidence, f"{key}: {suite['status']} {len(done)}/{len(suite['runs'])} done {outs} · current "
                          f"{current and current.get('job_id')} {current and current.get('label')}")
            save(evidence / f'suite-{key}.json', suite)
        if suite['status'] in ('completed', 'cancelled', 'interrupted', 'failed'):
            state['suites'][key].update(status=suite['status'], finished=time.time(), cancelled_for_budget=cancelled_for_budget)
            save(evidence / 'campaign_state.json', state)
            save(evidence / f'suite-{key}.json', suite)
            return state['suites'][key]
        if not cancelled_for_budget and time.time() > deadline + 600:
            log(evidence, f'{key}: budget exceeded by >10 min; cancelling suite {sid}')
            api.post('/api/suites/cancel', {'id': sid})
            cancelled_for_budget = True
        time.sleep(poll_s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:8790')
    ap.add_argument('--evidence', type=Path, required=True)
    ap.add_argument('--start-epoch', type=float, default=None)
    ap.add_argument('--budget-h', type=float, default=2.5)
    ap.add_argument('--poll-s', type=float, default=15)
    ap.add_argument('--only', default=None, help='comma-separated phase keys')
    ap.add_argument('--determinism', default=None, help='scenario id to re-run in its own suite')
    args = ap.parse_args()
    evidence = args.evidence
    arenas = {a['key']: a for a in json.loads((evidence / 'arenas.json').read_text())['arenas']}
    state_path = evidence / 'campaign_state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {'suites': {}, 'scenarios': {}}
    state.setdefault('start_epoch', args.start_epoch or time.time())
    deadline = state['start_epoch'] + args.budget_h * 3600
    save(state_path, state)
    api = Api(args.url)
    version = api.get('/api/version')
    log(evidence, f"gateway {args.url} commit {version.get('commit', '')[:7]} · deadline {time.strftime('%H:%M:%S', time.localtime(deadline))}")
    if args.determinism:
        run_suite(api, evidence, state, 'DET', 'Robustness · determinism re-run', [args.determinism], deadline + 1800, args.poll_s)
        return
    wanted = set(args.only.split(',')) if args.only else None
    for key, label, specs in phases():
        if wanted and key not in wanted:
            continue
        ids = []
        for spec in specs:
            body = scenario_body(spec, arenas[spec['arena']])
            tag = f"{key}:{spec['arena']}:{spec['idx']}:{spec['policy']}:K{spec['k']}O{spec['ode']}:s{spec['seed']}:lat{spec['latency']['ms']}{spec['latency']['anchor'][0]}"
            if tag not in state['scenarios']:
                saved = api.post('/api/scenarios', body)
                if not saved['validation']['valid']:
                    log(evidence, f'{tag}: invalid scenario {saved["validation"]["issues"]}; not run')
                    continue
                state['scenarios'][tag] = {'id': saved['scenario']['id'], 'reused': bool(saved.get('reused')), 'label': body['label'],
                                           'phase': key, **{k: spec[k] for k in ('arena', 'idx', 'policy', 'k', 'ode', 'seed', 'latency')}}
                save(state_path, state)
            ids.append(state['scenarios'][tag]['id'])
        if len(ids) != len(set(ids)):
            log(evidence, f'{key}: duplicate scenario ids in suite (reuse) {len(ids)} vs {len(set(ids))}')
        result = run_suite(api, evidence, state, key, f'Robustness 20261020 · {key} · {label}', ids, deadline, args.poll_s)
        try:
            save(evidence / f'runs-after-{key}.json', api.get('/api/runs', timeout=180))
        except (urllib.error.URLError, OSError, ValueError) as err:
            log(evidence, f'{key}: runs snapshot failed: {err}')
        if result.get('status') == 'skipped_budget':
            continue
    log(evidence, 'campaign phases done')


if __name__ == '__main__':
    sys.exit(main())
