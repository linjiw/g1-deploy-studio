"""Compare explicit before/after navigation recordings without running policies."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text())


def metrics(session, result):
    score = result['report']
    return {'outcome': score['outcome'], 'completed': score['completed'],
            'simulation_s': score['elapsed_s'], 'worker_wall_s': result['wall_time_s'],
            'frames': len(session['frames']), 'final_distance_m': score['final_goal_distance_xy_m'],
            'minimum_distance_m': score['minimum_goal_distance_xy_m'],
            'peak_contact_n': score['maximum_obstacle_contact_n'],
            'planner_ms': {k: 1000*v for k, v in score['plan_latency_s'].items()},
            'sonic_ms': score.get('sonic_inference_ms'), 'selection_rules': score['selection_rules'],
            'pipeline_capture_wall_ms': score.get('pipeline_capture_wall_ms'),
            'recording_complete': result['recording_complete'],
            'source_repositories': session['metadata']['provenance']['repositories']}


def compare(before, after):
    old_root, new_root = Path(before['output_path']), Path(after['output_path'])
    old_request, new_request = read(old_root/'request.json'), read(new_root/'request.json')
    for key in ('duration_s', 'start_xy', 'goal_xy', 'start_yaw_rad', 'seed', 'planner'):
        assert old_request[key] == new_request[key], f'{key} changed'
    assert old_request['map']['boxes'] == new_request['map']['boxes'], 'Collision geometry changed'
    assert old_request['map']['frame_id'] == new_request['map']['frame_id'] == 'world'
    sessions = [read(root/'run/session.json') for root in (old_root, new_root)]
    native_configs = [read(root/'run/native/run_config.json') for root in (old_root, new_root)]
    tasks = [read(root/'run/task.json') for root in (old_root, new_root)]
    for key in ('deadline_s', 'goal_world_xy', 'goal_radius_m', 'goal_speed_m_s', 'goal_hold_s',
                'fall_height_m', 'fall_tilt_rad', 'obstacle_contact_threshold_n'):
        assert tasks[0][key] == tasks[1][key], f'Scoring criterion changed: {key}'
    artifacts = [s['metadata']['provenance']['artifacts'] for s in sessions]
    for suffix in ('sonic_release_g1.onnx', 'student-s2-kcsc_s0/model.pt', 'g1deploy/scoring.py'):
        hashes = [next(a['sha256'] for a in files if a['path'].endswith(suffix)) for files in artifacts]
        assert hashes[0] == hashes[1], f'Weights/scoring changed: {suffix}'
    results = [read(root/'run/result.json') for root in (old_root, new_root)]
    for s, r in zip(sessions, results):
        assert s['metadata']['command_path_enabled'] is False and s['metadata']['hardware_validated'] is False
        assert r['hardware_enabled'] is False and r['dds_participants'] == 0
    assert sessions[0]['joint_names'] == sessions[1]['joint_names'], 'Joint order changed'
    assert sessions[0]['metadata']['recorded_model_hash'] == sessions[1]['metadata']['recorded_model_hash'], 'Robot model changed'
    if 'route' in sessions[1]['metadata']['planner_configuration']:
        assert sessions[1]['metadata']['planner_configuration']['route'] == native_configs[1]['route']
    return {'name': after['name'], 'goal_xy': new_request['goal_xy'], 'inputs_and_scoring_unchanged': True,
            'weights_unchanged': True, 'hardware_disabled': True,
            'route_configuration': {'before': native_configs[0]['route'], 'after': native_configs[1]['route'],
                                    'basis': 'Effective source run_config; explicit planner change, raw perception unchanged'},
            'before': {'job_id': before['job_id'], 'job_status': before['status'], 'exit_code': before.get('exit_code'),
                       **metrics(sessions[0], results[0])},
            'after': {'job_id': after['job_id'], 'job_status': after['status'], 'exit_code': after.get('exit_code'),
                      **metrics(sessions[1], results[1])}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--current', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline, current = read(args.baseline), read(args.current)
    old = {row['name']: row for row in baseline['results']}
    rows = [compare(old[row['name']], row) for row in current['results']]
    document = {'schema_version': 1, 'baseline': str(args.baseline.resolve()), 'current': str(args.current.resolve()),
                'scope': 'Same-input development runs; shared-host timing, no statistical success-rate or real-time claim',
                'results': rows}
    with args.output.open('x') as stream:
        json.dump(document, stream, indent=2, allow_nan=False)
        stream.write('\n')
    for row in rows:
        a, b = row['before'], row['after']
        print(f"{row['name']}: {a['outcome']} -> {b['outcome']}; "
              f"distance {a['final_distance_m']:.3f} -> {b['final_distance_m']:.3f}m; "
              f"contact {a['peak_contact_n']:.2f} -> {b['peak_contact_n']:.2f}N; "
              f"wall {a['worker_wall_s']:.2f} -> {b['worker_wall_s']:.2f}s")


if __name__ == '__main__':
    main()
