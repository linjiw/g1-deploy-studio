#!/usr/bin/env python3
"""Latency follow-up on the campaign's P3 scenarios (clutter + doorway, 12 presets).

Queues, one after another on the release gateway:
  F1  bundle K4/ODE6 · latency 200 ms · measured anchor (source lockstep model, control for anchoring)
  F2  WX-RF  K8/ODE6 · latency 100 ms (Studio L2-approx; dose response vs 0 and 200 ms)
Scenarios are derived from the saved P3 scenarios; only policy/budget/latency change.

    .venv/bin/python tools/campaign/latency_followup.py [--url http://127.0.0.1:8790]
"""
import argparse
import json
import time
import urllib.request

EVID = '/home/linjiw/research-data/g1-deploy-studio/evidence/robustness-20261020'


def call(base, path, body=None, token=None):
    headers = {'Content-Type': 'application/json', 'Origin': base, 'X-Studio-Token': token or ''}
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers,
                                 method='GET' if body is None else 'POST')
    return json.load(urllib.request.urlopen(req, timeout=60))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default='http://127.0.0.1:8790')
    args = ap.parse_args()
    base = args.url
    token = call(base, '/api/workbench')['csrf_token']
    state = json.load(open(f'{EVID}/campaign_state.json'))
    p3 = [v['id'] for k, v in state['scenarios'].items() if k.startswith('P3:')]
    variants = {'F1': {'policy_id': 'flow-bundle-20261008', 'planner': {'candidates': 4, 'ode_steps': 6},
                       'latency': {'ms': 200, 'anchor': 'measured'}, 'tag': 'bundle K4/ODE6 · lat 200 measured'},
                'F2': {'policy_id': 'flow-wx-rf-23326aa-s0', 'planner': {'candidates': 8, 'ode_steps': 6},
                       'latency': {'ms': 100, 'anchor': 'measured'}, 'tag': 'WX-RF K8/ODE6 · lat 100'}}
    out = {'p3': p3, 'suites': {}}
    for name, v in variants.items():
        ids = []
        for sid in p3:
            src = call(base, f'/api/scenarios?id={sid}')
            req = {k: src[k] for k in ('map_id', 'backend_id', 'duration_s', 'start_xy', 'goal_xy', 'start_yaw_rad', 'seed', 'criterion')}
            req.update(policy_id=v['policy_id'], planner=v['planner'], latency=v['latency'],
                       preset_label=src.get('preset_label') or src['label'].split(' · ')[3] if len(src['label'].split(' · ')) > 3 else None,
                       label=f"{src['label'].split(' · WX-RF')[0]} · {v['tag']}"[:100])
            if not req['preset_label']:
                req.pop('preset_label')
            saved = call(base, '/api/scenarios', req, token)
            ids.append(saved['scenario']['id'])
        while any(s['status'] in ('queued', 'running', 'cancelling') for s in call(base, '/api/suites')['suites']):
            time.sleep(15)
        suite = call(base, '/api/suites', {'label': f'Robustness follow-up {name} · {v["tag"]}', 'scenario_ids': ids}, token)
        out['suites'][name] = {'id': suite['id'], 'scenarios': ids, **{k: v[k] for k in ('policy_id', 'latency')}}
        print(name, suite['id'], flush=True)
        while call(base, f"/api/suites?id={suite['id']}")['status'] in ('queued', 'running', 'cancelling'):
            time.sleep(15)
        print(name, 'done', flush=True)
    json.dump(out, open(f'{EVID}/latency_followup.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
