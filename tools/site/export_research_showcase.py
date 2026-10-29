#!/usr/bin/env python3
"""Export exactly two approved R2 development recordings, without running a policy.

    .venv/bin/python -m tools.site.export_research_showcase --robot /abs/site/data/robot.json --out /abs/research-showcase

Reads only the allowlisted callback files; never searches research directories.
Writes full-precision Studio sessions and a small render.json with nested pose
arrays, original 50 Hz ticks, and the final post-action pose. No model weights,
source code, local paths, invented estimates or LiDAR are exported.
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
from pathlib import Path

import numpy as np

from studio import paths
from studio.policy_bundle import sha256
from studio.replay import DT, JOINT_NAMES, _finite, _json, _npz, _plan, decode_reference, quat_matrix

CASES = (
    ('duck', 'Duck beneath two beams', 'WXDR2-g-s0__drill_duck-60000__s886771895',
     'f05b94fe1e6314f6068850c4134fe082839de783d513d5f4be9fbeba0b1a8893'),
    ('clutter', 'Navigate storage clutter', 'WXDR2-g-s0__storage_clutter-60000__s936898091',
     '1fed1578b57c39a90a5366a6259c6c48e5c0472d64b81e76873ffa8e06c8899f'),
)
SOURCE_FILES = ('closed_loop.npz', 'plans.json', 'task.json', 'run_config.json', 'score.json', 'runtime_source.py')
ADOPTION = '7fb8423d434f689b829800e0957c392637c3b787'
CALLBACK_SHA256 = '7115a338b959869f90a0c7040fa278237699b328fcc037a9d802761c986df0f9'
LIMITATIONS = [
    'Curated successful development examples, not aggregate performance or hardware qualification.',
    'Recorded Isaac simulation with SONIC; simulator ground truth and privileged exact obstacle boxes. No LiDAR or estimated pose.',
    'WXD-TNP-R2 identifies the recorded recipe. The adoption commit is a later research decision, not a verified recording-time source revision.',
    'Recording-time checkpoint hashes and complete source/model identity were not saved; exported recording and callback-snapshot hashes identify the evidence.',
    'The public G1 mesh is a rendering avatar mapped by joint name; it is not asserted to reproduce the Isaac collision geometry.',
    'Reference root position is a planner diagnostic. SONIC consumes reference columns 0:64, not diagnostic columns 64:67.',
    'Goal completion uses reach within 0.4 m at at most 2 m/s for 0.1 s; it does not establish a stationary arrive-and-hold result.',
]


def fingerprint(path, name=None):
    return {'name': name or path.name, 'bytes': path.stat().st_size, 'sha256': sha256(path)}


def robot_order(robot):
    """Use the avatar's actual qpos addresses, not its display-name list order."""
    joints = {}

    def walk(body):
        joint = body.get('joint')
        if joint and joint['type'] != 'free':
            index = joint['qpos_index']
            if index in joints:
                raise ValueError('Duplicate avatar joint qpos address')
            joints[index] = joint['name']
        for child in body.get('children', []):
            walk(child)
    walk(robot['root'])
    if (robot['nq'] != 36 or sorted(joints) != list(range(7, 36)) or
            robot.get('quaternion_convention') != 'wxyz'):
        raise ValueError('Renderer needs a 36-position, 29-joint avatar')
    return [joints[i] for i in range(7, 36)]


def world_bounds(boxes, poses):
    xy = [poses[0, :2], poses[-1, :2]]
    for box in boxes:
        if any(box.get('velocity_xy', [0, 0])):
            raise ValueError('This exporter supports only the selected static scenes')
        c, s = math.cos(box['yaw']), math.sin(box['yaw'])
        rotation = np.array([[c, -s], [s, c]])
        for a, b in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
            xy.append(np.asarray(box['center_xy']) + rotation @ (np.asarray(box['half_xy']) * [a, b]))
    xy = np.asarray(xy)
    return {'min': xy.min(axis=0).tolist(), 'max': xy.max(axis=0).tolist()}


def export_case(flow_root, case, avatar_order, avatar_identity):
    case_id, label, episode, expected_hash = case
    source = flow_root / 'artifacts/closed-loop-wxdr2-xdg' / episode / 'callback'
    if sha256(source / 'closed_loop.npz') != expected_hash:
        raise ValueError(f'{case_id}: the selected recording changed')
    if sha256(source / 'runtime_source.py') != CALLBACK_SHA256:
        raise ValueError(f'{case_id}: the audited callback snapshot changed')
    task, cfg, score, plans = [_json(source / name) for name in ('task.json', 'run_config.json', 'score.json', 'plans.json')]
    if task['split'] != 'arena-xdgc-dev_extrap' or '/tasks/dev_extrap/' not in cfg['task_path']:
        raise ValueError('Only the explicitly selected development split may be exported')
    planner = cfg['planner']
    if (Path(planner['run']).name != 'tnp_s0' or not planner.get('wm_refine') or
            planner.get('wm_refine_channels') != 'upper' or planner.get('wm_refine_tilting_tol_rad') != 0 or
            cfg['gate_side']['level']['retrieval_k'] != 0 or cfg['route_source'] != 'privileged_cost'):
        raise ValueError('Selected recording is not the audited R2 retrieval-free recipe')
    z = _npz(source / 'closed_loop.npz')
    n = len(z['pre_action_qpos'])
    if not 1 <= n <= 3000 or score['control_steps'] != n or abs(score['elapsed_s'] - n * DT) > 1e-9:
        raise ValueError('Recorded score does not confirm the 50 Hz control clock')
    names = z['joint_names'].tolist()
    # Audited callback snapshots assert native_names == planner.JOINT_NAMES,
    # record `references.append(tgt)` in this native order, and separately pack
    # tgt for SONIC's interleaved Isaac order. NPZ references are the pre-pack
    # [positions, velocities, orientation, diagnostic translation] array.
    if tuple(names) != JOINT_NAMES:
        raise ValueError('Recorded reference-column order differs from the audited native joint contract')
    if len(names) != 29 or len(set(names)) != 29 or set(names) != set(avatar_order):
        raise ValueError('Recorded and avatar joint names differ')
    pre = _finite(z['pre_action_qpos'], 'pre-action pose', (n, 36))
    post = _finite(z['realized_qpos'], 'post-action pose', (n, 36))
    refs = _finite(z['references'], 'reference windows', (n, 10, 67))
    forces = _finite(z['force_max_n'], 'physics interval contact', (n,))
    if z['estimated_qpos'].size:
        raise ValueError('Expected the audited no-estimated-pose recording')
    if not np.array_equal(post[:-1], pre[1:]):
        raise ValueError('Post/pre action continuity changed; do not smooth a reset')
    trajectory = np.vstack([pre, post[-1]])
    for q in trajectory:
        quat_matrix(q[3:7])
    goal = np.asarray(task['goal_world_xy'])
    final_distance = float(np.linalg.norm(post[-1, :2] - goal))
    if abs(final_distance - score['final_goal_distance_xy_m']) > 1e-5:
        raise ValueError('Final trajectory and score goal distance disagree')
    if score['outcome'] != 'goal_completion' or not score['completed'] or score['runtime_error'] is not None:
        raise ValueError('Selected successful development recording no longer matches the audit')
    if max(forces) != score['maximum_obstacle_contact_n']:
        raise ValueError('Contact samples and recorded score disagree')
    ticks = [row['tick'] for row in plans]
    if ticks != sorted(set(ticks)) or not all(0 <= tick < n for tick in ticks):
        raise ValueError('Nonmonotonic or out-of-range plan ticks')
    plan_times = [tick * DT for tick in ticks]
    boxes = task['scene_boxes_world']
    world = {'boxes': boxes, 'bounds': world_bounds(boxes, trajectory), 'start_xy': pre[0, :2].tolist(),
             'start_yaw_rad': float(math.atan2(quat_matrix(pre[0, 3:7])[1, 0], quat_matrix(pre[0, 3:7])[0, 0])),
             'classification': 'simulator-ground-truth', 'identity_basis': 'scene boxes embedded in the recorded task',
             'scene_definition_sha256': task['scene_definition_sha256']}
    contract = Path(task['model_contract_path'])
    contract_data = _json(contract)
    if contract_data['root_quaternion_order'] != 'wxyz' or contract_data['up_axis'] != 'z' or contract_data['length_units'] != 'm':
        raise ValueError('Source model contract frame or units differ from the replay convention')
    if tuple(j['name'] for j in contract_data['joints'] if j['type'] != 'free') != tuple(names):
        raise ValueError('Recorded joints differ from the model contract native reference-column order')
    provenance = {
        'episode': episode, 'task_id': task['task_id'], 'split': task['split'],
        'recorded_artifacts': [fingerprint(source / f) for f in SOURCE_FILES],
        'recording_source_commit': None, 'recording_checkpoint_hashes': None,
        'recipe_adoption_reference': {'commit': ADOPTION, 'document': 'research/ROUND_DREAM_PLAN.md',
                                      'basis': 'Recipe adoption; not the source revision of this recording'},
        'model_contract_at_export': {**fingerprint(contract, 'recorded-task-model-contract'),
                                     'model_name': contract_data['model_name'], 'model_sha256': contract_data['model_sha256'],
                                     'basis': 'Current file referenced by the recorded task; not a recording-time hash'},
        'rendering_avatar': avatar_identity,
        'joint_mapping': [{'name': name, 'source_qpos_index': 7 + names.index(name), 'avatar_qpos_index': 7 + i}
                          for i, name in enumerate(avatar_order)],
        'joint_mapping_basis': 'Same name mapping applied to simulator pose and reference posture; source raw arrays remain unchanged in the local session export',
        'reference_column_order': 'Recorded tgt in native named order, before pack_sonic_joint_reference remaps to SONIC Isaac order',
    }
    recipe = {'name': 'WXD-TNP-R2', 'arm': 'WXDR2-g-s0', 'teacher': 'tnp_s0', 'seed': cfg['seed'],
              'map': 'privileged exact boxes', 'route_source': cfg['route_source'], 'retrieval_k': 0,
              'replan_ticks': cfg['replan_ticks'], 'execution_model': Path(planner['exec_model']).name,
              'planner': {k: planner[k] for k in ('device', 'candidates', 'ode_steps', 'chunks', 'guide_w', 'duck_below_m',
                          'duck_guide_w', 'duck_rank_w', 'duck_offset_m', 'duck_span_max_m', 'duck_release_tilt_rad',
                          'wm_refine', 'wm_refine_channels', 'wm_refine_tilting_tol_rad')}}
    result = {k: score[k] for k in ('outcome', 'completed', 'control_steps', 'elapsed_s', 'minimum_root_height_m',
              'maximum_root_tilt_rad', 'maximum_obstacle_contact_n', 'final_goal_distance_xy_m', 'replans')}
    result['thresholds'] = {k: task[k] for k in ('goal_radius_m', 'goal_speed_m_s', 'goal_hold_s', 'fall_height_m',
                                               'fall_tilt_rad', 'obstacle_contact_threshold_n')}
    frames, reference_qpos = [], []
    order = [names.index(name) for name in avatar_order]
    for i in range(n):
        q, t = pre[i], i * DT
        reference = decode_reference(refs[i], q)
        j = bisect.bisect_right(plan_times, t) - 1
        frame = {'time': t, 'source_time': t, 'sequence': i, 'source_clock_domain': 'simulation', 'sim_time': t,
                 'classification': 'simulator-ground-truth', 'validity': 'valid', 'frame_id': 'world',
                 'qpos': q.tolist(), 'position': q[:3].tolist(), 'quaternion_wxyz': q[3:7].tolist(), 'joints': q[7:].tolist(),
                 'reference': reference, 'estimate': None, 'command': None, 'receipt_time': None,
                 'plan': _plan(plans[j], plan_times[j], t) if j >= 0 else None,
                 'post_action': {'time': (i + 1) * DT, 'qpos': post[i].tolist(), 'classification': 'simulator-ground-truth',
                                 'interval_contact_force_n': float(forces[i])},
                 'health': {'goal_dist_m': float(np.linalg.norm(q[:2] - goal)), 'contact_force_n': None,
                            'tilt_rad': float(math.acos(np.clip(quat_matrix(q[3:7])[2, 2], -1, 1)))}}
        frames.append(frame)
        reference_qpos.append(reference['position'] + reference['quaternion_wxyz'] + [reference['joints'][k] for k in order])
    metadata = {'id': case_id, 'title': label, 'mode': 'replay', 'recording_kind': 'isaac-sonic-development',
                'clock_domain': 'simulation', 'source_time_origin': 0, 'frame_id': 'world', 'quaternion_convention': 'wxyz',
                'units': {'position': 'm', 'joint': 'rad', 'time': 's', 'force': 'N'}, 'duration_s': (n - 1) * DT,
                'executed_sim_duration_s': n * DT, 'source_samples': n,
                'time_basis': 'Original control tick index × 0.02 s, confirmed by recorded elapsed_s / control_steps',
                'hardware_validated': False, 'command_path_enabled': False, 'fixture': False,
                'policy_identity': 'WXD-TNP-R2 · research teacher · tnp_s0 · retrieval-free',
                'policy_hash_at_recording': None, 'recipe': recipe, 'test_result': result,
                'provenance': provenance, 'limitations': LIMITATIONS}
    session = {'schema_version': 1, 'metadata': metadata, 'joint_names': names, 'frames': frames, 'environment': world,
               'perception': {'available': False, 'reason': 'Privileged-map teacher; no LiDAR or estimated pose recorded'},
               'plans': plans, 'events': [{'time': t, 'type': 'replan', 'message': p['rule'], 'source': 'plans.json'}
                                        for p, t in zip(plans, plan_times)], 'trajectory': pre[:, :3].tolist()}
    # Include the final measured post-action state for rendering the complete goal arrival.
    rendered_poses = np.concatenate([trajectory[:, :7], trajectory[:, 7:][:, order]], axis=1)
    clip = {'id': case_id, 'label': label, 'times': [i * DT for i in range(n + 1)], 'qpos': rendered_poses.tolist(),
            'reference_qpos': reference_qpos + [None], 'joint_names': avatar_order, 'world': world, 'goal_xy': goal.tolist(),
            'reference_basis': 'Commanded reference posture; diagnostic root position not consumed by SONIC',
            'pose_basis': 'Isaac simulator ground truth; full original ticks plus final post-action state',
            'recipe': recipe, 'result': result, 'provenance': provenance, 'limitations': LIMITATIONS}
    validation = {'id': case_id, 'source_frames': n, 'render_frames': n + 1, 'joint_mapping': 'verified by name and avatar qpos_index',
                  'post_pre_max_error': float(np.max(np.abs(post[:-1] - pre[1:]))),
                  'final_goal_distance_error_m': abs(final_distance - score['final_goal_distance_xy_m']),
                  'all_values_finite': True, 'estimated_pose_available': False, 'lidar_available': False}
    return session, clip, validation


def write_json(path, data):
    text = json.dumps(data, allow_nan=False, separators=(',', ':'))
    if '/home/' in text or '/Users/' in text or 'input_snapshot' in text:
        raise ValueError('Machine-local path leaked into sanitized export')
    path.write_text(text)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--flow-root', type=Path, default=paths.get('flow_root'))
    ap.add_argument('--robot', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    args = ap.parse_args()
    robot = _json(args.robot)
    names = robot_order(robot)
    avatar = {**fingerprint(args.robot, 'public-robot.json'), 'source': robot['source'],
              'basis': 'Rendering avatar only; not a claim about Isaac collision-model identity'}
    exports = [export_case(args.flow_root, case, names, avatar) for case in CASES]
    # Exclusive output directory prevents replacing a previous export or existing research files.
    args.out.mkdir(parents=True, exist_ok=False)
    for session, clip, validation in exports:
        folder = args.out / clip['id']
        folder.mkdir()
        write_json(folder / 'session.json', session)
        write_json(folder / 'scene.json', clip['world'])
        write_json(folder / 'provenance.json', clip['provenance'])
    write_json(args.out / 'render.json', {'schema_version': 1, 'units': {'position': 'm', 'joint': 'rad', 'time': 's'},
                                         'quaternion_convention': 'wxyz', 'clips': [c for _, c, _ in exports]})
    write_json(args.out / 'validation.json', {'cases': [v for _, _, v in exports], 'no_simulation_started': True})
    write_json(args.out / 'index.json', {'schema_version': 1, 'label': 'Recent research · WXD-TNP-R2',
               'clips': [{'id': c['id'], 'label': c['label'], 'result': c['result']} for _, c, _ in exports],
               'files': [fingerprint(p, str(p.relative_to(args.out))) for p in sorted(args.out.rglob('*.json'))]})
    print(json.dumps({'output': str(args.out), 'cases': [v for _, _, v in exports]}, indent=2))


if __name__ == '__main__':
    main()
