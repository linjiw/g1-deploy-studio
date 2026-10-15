"""Exercise the authorized local CPU job API, including disconnect and cancellation."""
import argparse
import json
import os
from pathlib import Path
import signal
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8790')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    target = urlparse(args.url)
    if target.scheme != 'http' or target.hostname not in ('localhost','127.0.0.1','::1'):
        raise ValueError('Only local loopback acceptance is supported')
    args.output.mkdir(parents=True, exist_ok=False)
    token = None
    def request(path, data=None):
        headers = {'Origin': args.url}
        if data is not None:
            headers.update({'Content-Type':'application/json', 'X-Studio-Token':token})
        raw = None if data is None else json.dumps(data).encode()
        with urlopen(Request(args.url+path, raw, headers), timeout=30) as response:
            return json.load(response)
    workbench = request('/api/workbench')
    token = workbench['csrf_token']
    prepared = request('/api/scenarios', dict(workbench['defaults'], label='API acceptance · owned CPU test'))
    assert prepared['validation']['valid']
    job = request('/api/jobs', {'scenario_id':prepared['scenario']['id']})
    job_id = job['id']
    samples, partial, duplicate_rejected, stale_observed = [], None, False, False
    try:
        request('/api/jobs', {'scenario_id':prepared['scenario']['id']})
    except HTTPError as error:
        duplicate_rejected = error.code == 422
    assert duplicate_rejected, 'Second simultaneous worker must be rejected'
    deadline = time.monotonic()+90
    while time.monotonic() < deadline:
        job = request('/api/jobs?id='+job_id)
        latest = job.get('latest') or {}
        frame = latest.get('frame')
        if frame and not partial:
            session = request('/api/session?id='+job_id)
            model = request('/api/model?id='+job_id)
            partial = {'time': session['frames'][-1]['time'], 'qpos_width':len(session['frames'][-1]['qpos']),
                       'model_available':bool(model), 'state':job['status']}
            # Explicit fault demonstration on this test's newly launched CPU
            # child only. Confirm its executable and owned request before signals.
            pid = job['runtime']['worker_pid']
            command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            expected = str(Path(job['output_path'])/'request.json').encode()
            assert expected in command and any(part.endswith(b'/studio/policy_worker.py') for part in command)
            os.kill(pid, signal.SIGSTOP)
            try:
                time.sleep(1.3)
                held = request('/api/jobs?id='+job_id)
                stale_observed = held['telemetry']['status']=='stale'
                assert stale_observed, held['telemetry']
            finally:
                os.kill(pid, signal.SIGCONT)
            # Every HTTP request closes; deliberately stop consuming while the
            # worker runs to check that browser/consumer lifetime is irrelevant.
            time.sleep(.6)
        samples.append({'status':job['status'], 'time':frame.get('time') if frame else None,
                        'telemetry_status':job.get('telemetry',{}).get('status')})
        if job['status'] in ('completed','failed','cancelled'):
            break
        time.sleep(.2)
    assert job['status']=='completed', job
    assert partial and partial['qpos_width']==36
    session = request('/api/session?id='+job_id)
    assert len(session['frames'])>=50
    assert session['metadata']['fixture'] is False
    assert session['metadata']['hardware_validated'] is False
    assert session['perception']['kind']=='time-series'
    sensors = request('/api/sensors?session='+job_id+'&time='+str(session['frames'][-1]['time']))
    sensor_map = {sensor['id']:sensor for sensor in sensors['sensors']}
    assert sensor_map['lidar_raw']['available']
    assert sensor_map['lidar_filtered']['available']
    assert not sensor_map['rgb_camera']['available']
    cancel_scenario = request('/api/scenarios', dict(workbench['defaults'], duration_s=10,
                               planner={'candidates':16,'ode_steps':10},label='Cancellation acceptance'))['scenario']
    cancelled = request('/api/jobs', {'scenario_id':cancel_scenario['id']})
    request('/api/jobs/cancel', {'id':cancelled['id']})
    for _ in range(60):
        cancelled = request('/api/jobs?id='+cancelled['id'])
        if cancelled['status']=='cancelled':
            break
        time.sleep(.1)
    assert cancelled['status']=='cancelled', cancelled
    safety = request('/api/safety')
    assert safety['hardware_enabled'] is False and safety['dds_participants']==0 and safety['publishers']==[]
    evidence = {'completed_job_id':job_id, 'cancelled_job_id':cancelled['id'],
                'partial':partial,'observations':samples,'frames':len(session['frames']),
                'perception_snapshots':len(session['perception']['frames']),
                'summary':job.get('summary'), 'duplicate_worker_rejected':duplicate_rejected,
                'owned_cpu_pause_displayed_stale':stale_observed,
                'consumer_disconnect_did_not_stop_worker':True, 'owned_cancel_status':cancelled['status'],
                'hardware_disabled':True}
    (args.output/'acceptance.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))


if __name__=='__main__':
    main()
