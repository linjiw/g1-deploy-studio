"""Rerun explicitly recorded CPU navigation inputs, retaining every outcome.

Separate policy execution from browser rendering. This is not a controlled
performance benchmark. The gateway owns worker limits and hardware isolation.
Each output directory is exclusive; a failed invocation never silently retries.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError


INPUT_FIELDS = ('map_id', 'start_xy', 'goal_xy', 'start_yaw_rad', 'duration_s', 'seed', 'planner')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8790')
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--case', action='append', dest='names', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    target = urlparse(args.url)
    if target.scheme != 'http' or target.hostname not in ('localhost', '127.0.0.1', '::1') or target.username or target.password:
        raise ValueError('Only literal loopback HTTP gateways are supported')
    if not 1 <= len(args.names) <= 6 or len(set(args.names)) != len(args.names):
        raise ValueError('Select one to six distinct recorded cases')
    baseline = json.loads(args.baseline.read_text())
    previous = {row['name']: row for row in baseline['results']}
    selected = [previous[name] for name in args.names]
    cases = [row['requested'] for row in selected]
    args.output.mkdir(parents=True, exist_ok=False)
    token = None

    def request(path, data=None):
        headers = {'Origin': args.url}
        if data is not None:
            headers.update({'Content-Type': 'application/json', 'X-Studio-Token': token})
        raw = None if data is None else json.dumps(data, allow_nan=False).encode()
        try:
            with urlopen(Request(args.url + path, raw, headers), timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            raise RuntimeError(f'Gateway {path}: HTTP {error.code}: {error.read(4096).decode(errors="replace")}') from error

    def get(path, **query):
        return request(path + '?' + urlencode(query))

    workbench = request('/api/workbench')
    token = workbench['csrf_token']
    safety = request('/api/safety')
    assert safety['hardware_enabled'] is False and safety['dds_participants'] == 0 and safety['publishers'] == []
    report = {'base': args.url, 'baseline_report': str(args.baseline.resolve()), 'cases': cases,
              'results': [], 'checks': [], 'errors': [], 'failed': [],
              'scope': 'Explicit same-input CPU development reruns; no hardware, DDS or automatic retry'}

    def save():
        path = args.output / 'navigation-acceptance.json'
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
        tmp.replace(path)

    save()
    for old, case in zip(selected, cases):
        original = json.loads((Path(old['output_path']) / 'request.json').read_text())
        map_data = get('/api/map', id=case['map_id'])
        assert map_data['boxes'] == original['map']['boxes'], 'Collision geometry changed since baseline'
        assert map_data['frame_id'] == original['map']['frame_id'] == 'world'
        prepared = request('/api/scenarios', {**{k: case[k] for k in INPUT_FIELDS}, 'backend_id': 'flow-sonic-cpu',
                                             'label': f"Review {args.output.name} · {case['name']}"[:100]})
        assert prepared['validation']['valid'], prepared['validation']
        scenario = prepared['scenario']
        for key in INPUT_FIELDS:
            assert scenario[key] == case[key], key
        job = request('/api/jobs', {'scenario_id': scenario['id']})
        row = {'name': case['name'], 'requested': case, 'job_id': job['id'],
               'baseline_job_id': old['job_id'], 'baseline_summary': old['summary'],
               'map_provenance': map_data.get('provenance'), 'status': job['status']}
        report['results'].append(row)
        save()
        print(f"Started {case['name']}: {job['id']}", flush=True)
        deadline = time.monotonic() + 210
        last_progress = -1.0
        while True:
            job = get('/api/jobs', id=job['id'])
            latest = job.get('latest') or {}
            progress = latest.get('progress') or {}
            sim_time = progress.get('simulation_time_s', 0)
            if sim_time >= last_progress + 1:
                print(f"  sim={sim_time:.2f}s wall={progress.get('wall_time_s', 0):.1f}s status={job['status']}", flush=True)
                last_progress = sim_time
            if job['status'] in ('completed', 'failed', 'cancelled'):
                break
            if time.monotonic() > deadline:
                row.update(status=job['status'], error='Harness observation deadline; no retry or external process signal')
                save()
                raise TimeoutError(f"Owned worker did not terminate: {job['id']}")
            time.sleep(.5)
        row.update(status=job['status'], output_path=job['output_path'], summary=job.get('summary'),
                   exit_code=job.get('exit_code'), error=job.get('error'))
        save()
        actual = json.loads((Path(job['output_path']) / 'request.json').read_text())
        for key in INPUT_FIELDS[1:]:
            assert actual[key] == original[key], key
        assert actual['map']['boxes'] == original['map']['boxes']
        assert job['runtime']['hardware_enabled'] is False and job['runtime']['dds_participants'] == 0
        if job.get('result_session_id'):
            session = get('/api/session', id=job['result_session_id'])
            assert session['metadata']['command_path_enabled'] is False
            row.update(frame_count=len(session['frames']), perception_count=len(session.get('perception', {}).get('frames', [])),
                       source_repositories=session['metadata']['provenance']['repositories'],
                       replay_url=f"{args.url}/?session={job['result_session_id']}&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1")
        report['checks'].append({'name': f"{case['name']}: original map/goal/settings retained; hardware disabled", 'passed': True})
        save()
        print(json.dumps({'name': case['name'], 'job': job['id'], 'status': job['status'], 'summary': job.get('summary')}, allow_nan=False), flush=True)
    return 0 if all(row['status'] == 'completed' for row in report['results']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
