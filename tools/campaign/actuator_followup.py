#!/usr/bin/env python3
"""Actuator-profile follow-up on the campaign's P3 scenarios (clutter + doorway, 12 presets).

Queues, one after another on the release gateway, WX-RF K8/ODE6 with:
  F3  latency 200 ms · predict anchor · g1-current limits (139/139/88, the trained-for hardware)
  F4  latency 0      · g1-current limits (lockstep baseline with corrected limits)
  F5  latency 200 ms · predict anchor · g1-rev1 limits (88/139/88, pessimistic older hardware)
Scenarios are derived from the saved P3 scenarios; only latency, anchor and actuators change.

    .venv/bin/python tools/campaign/actuator_followup.py [--url http://127.0.0.1:8790]
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
    wx = {'policy_id': 'flow-wx-rf-23326aa-s0', 'planner': {'candidates': 8, 'ode_steps': 6}}
    variants = {'F3': {**wx, 'latency': {'ms': 200, 'anchor': 'predict'}, 'actuators': 'g1-current', 'tag': 'WX-RF · lat 200p · g1-current'},
                'F4': {**wx, 'latency': {'ms': 0, 'anchor': 'measured'}, 'actuators': 'g1-current', 'tag': 'WX-RF · lat 0 · g1-current'},
                'F5': {**wx, 'latency': {'ms': 200, 'anchor': 'predict'}, 'actuators': 'g1-rev1', 'tag': 'WX-RF · lat 200p · g1-rev1'}}
    out = {'p3': p3, 'suites': {}}
    for name, v in variants.items():
        ids = []
        for sid in p3:
            src = call(base, f'/api/scenarios?id={sid}')
            req = {k: src[k] for k in ('map_id', 'backend_id', 'duration_s', 'start_xy', 'goal_xy', 'start_yaw_rad', 'seed', 'criterion')}
            req.update(policy_id=v['policy_id'], planner=v['planner'], latency=v['latency'], actuators=v['actuators'],
                       preset_label=src.get('preset_label') or src['label'].split(' · ')[3] if len(src['label'].split(' · ')) > 3 else None,
                       label=f"{src['label'].split(' · WX-RF')[0]} · {v['tag']}"[:100])
            if not req['preset_label']:
                req.pop('preset_label')
            saved = call(base, '/api/scenarios', req, token)
            ids.append(saved['scenario']['id'])
        while any(s['status'] in ('queued', 'running', 'cancelling') for s in call(base, '/api/suites')['suites']):
            time.sleep(15)
        suite = call(base, '/api/suites', {'label': f'Actuator follow-up {name} · {v["tag"]}', 'scenario_ids': ids}, token)
        out['suites'][name] = {'id': suite['id'], 'scenarios': ids, **{k: v[k] for k in ('policy_id', 'latency', 'actuators')}}
        print(name, suite['id'], flush=True)
        while call(base, f"/api/suites?id={suite['id']}")['status'] in ('queued', 'running', 'cancelling'):
            time.sleep(15)
        print(name, 'done', flush=True)
    json.dump(out, open(f'{EVID}/actuator_followup.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
