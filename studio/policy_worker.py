"""Bounded CPU Flow/SONIC/MuJoCo execution, separate from the HTTP gateway.

This is the existing in-process lockstep backend, not the C++/DDS deployment
chain. No middleware participant or network command writer is created here.
The reference interpreter and source tree are consumed read-only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

REFERENCE_ROOT = Path('/home/linjiw/code/g1-student-deploy')
REFERENCE_PYTHON = REFERENCE_ROOT / '.venv/bin/python'
BACKEND_ID = 'flow-sonic-mujoco-cpu'
MAX_DURATION_S = 10.0
MAX_BOXES = 128
MAX_SENSOR_POINTS = 1500


def capabilities():
    """File presence only: never import Torch, ONNX, a simulator, or middleware."""
    required = [REFERENCE_PYTHON, REFERENCE_ROOT / 'sim/lockstep.py',
                REFERENCE_ROOT / 'bundle/sonic/sonic_release_g1.onnx',
                REFERENCE_ROOT / 'bundle/flow/artifacts/student-s2-kcsc_s0/model.pt']
    missing = [str(p) for p in required if not p.is_file()]
    return {'id': BACKEND_ID, 'label': 'Flow + SONIC · CPU MuJoCo rehearsal',
            'available': not missing, 'missing': missing, 'dependency_check': 'file-presence; runtime checked on launch',
            'python': str(REFERENCE_PYTHON), 'source_root': str(REFERENCE_ROOT),
            'max_duration_s': MAX_DURATION_S, 'device': 'cpu', 'dds': False, 'zmq': False,
            'hardware_enabled': False, 'real_time_guaranteed': False,
            'supported_map_kinds': ['boxes'], 'default_planner': {'candidates': 2, 'ode_steps': 4},
            'limitation': 'In-process policy and physics test; does not validate the separate C++/DDS deployment chain.'}


def _number(value, name, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lo <= value <= hi:
        raise ValueError(f'{name} must be finite in [{lo}, {hi}]')
    return float(value)


def _xy(value, name):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError(f'{name} must be [x, y] in metres')
    return [_number(x, name, -50, 50) for x in value]


def validate_request(request):
    """Allowlisted physics inputs. A point cloud cannot silently become collision truth."""
    if not isinstance(request, dict) or type(request.get('schema_version')) is not int or request.get('schema_version') != 1:
        raise ValueError('request schema_version must be 1')
    m = request.get('map')
    if not isinstance(m, dict) or m.get('kind') != 'boxes':
        raise ValueError('Physics tests require an explicit boxes collision map; scans support inspection only')
    if m.get('frame_id', 'world') != 'world':
        raise ValueError('Map must be aligned to the world frame before policy testing')
    boxes = m.get('boxes')
    if not isinstance(boxes, list) or len(boxes) > MAX_BOXES:
        raise ValueError(f'map.boxes must have at most {MAX_BOXES} entries')
    clean_boxes = []
    for b in boxes:
        if not isinstance(b, dict):
            raise ValueError('Each collision box must be an object')
        half = _xy(b.get('half_xy'), 'half_xy')
        if min(half) <= 0 or max(half) > 20:
            raise ValueError('Box half extents must be positive and <=20 m')
        bottom, top = _number(b.get('z_bottom'), 'z_bottom', 0, 10), _number(b.get('z_top'), 'z_top', 0, 10)
        if top <= bottom:
            raise ValueError('Box z_top must exceed z_bottom')
        clean_boxes.append({'center_xy': _xy(b.get('center_xy'), 'center_xy'), 'half_xy': half,
                            'yaw': _number(b.get('yaw', 0), 'yaw', -math.pi, math.pi),
                            'z_bottom': bottom, 'z_top': top})
    planner = request.get('planner', {})
    if not isinstance(planner, dict):
        raise ValueError('planner must be an object')
    settings = {}
    for name, default, maximum in [('candidates', 2, 16), ('ode_steps', 4, 10)]:
        n = planner.get(name, default)
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= maximum:
            raise ValueError(f'planner.{name} must be an integer in 1..{maximum}')
        settings[name] = n
    seed = request.get('seed', 0)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**31 - 1:
        raise ValueError('seed must be an integer in 0..2147483647')
    job_id = request.get('id', 'policy-test')
    if not isinstance(job_id, str) or not 1 <= len(job_id) <= 80 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in job_id):
        raise ValueError('id must contain only letters, digits, dash and underscore')
    clean = {'schema_version': 1, 'id': job_id, 'goal_xy': _xy(request.get('goal_xy'), 'goal_xy'),
             'start_xy': _xy(request.get('start_xy', [0, 0]), 'start_xy'),
             'start_yaw_rad': _number(request.get('start_yaw_rad', 0), 'start_yaw_rad', -math.pi, math.pi),
             'duration_s': _number(request.get('duration_s', 2), 'duration_s', .02, MAX_DURATION_S),
             'seed': seed, 'planner': settings,
             'map': {'id': str(m.get('id', 'map'))[:100], 'label': str(m.get('label', 'Collision map'))[:200],
                     'kind': 'boxes', 'frame_id': 'world', 'boxes': clean_boxes,
                     'source': str(m.get('source', 'operator-configured'))[:1000]}}
    return clean


def _atomic(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, allow_nan=False, separators=(',', ':')))
    tmp.replace(path)


def _hash(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return {'path': str(path), 'sha256': h.hexdigest(), 'bytes': path.stat().st_size}


def _points(np, points, budget=MAX_SENSOR_POINTS):
    pts = np.asarray(points).reshape(-1, 3)
    return pts[::max(1, math.ceil(len(pts) / budget))].tolist()


def contact_interval(forces, start_s, end_s):
    """Preserve actual physics substeps with their interval, never a future state stamp."""
    samples = [float(v) for v in forces]
    if not samples or any(not math.isfinite(v) or v < 0 for v in samples):
        raise ValueError('Obstacle normal-force samples must be finite, nonnegative and nonempty')
    if not math.isfinite(start_s) or not math.isfinite(end_s) or end_s <= start_s:
        raise ValueError('Contact interval must have a finite positive duration')
    return {'start_s': start_s, 'end_s': end_s, 'max_force_n': max(samples),
            'samples_n': samples, 'sample_period_s': (end_s-start_s)/len(samples),
            'classification': 'simulator-ground-truth', 'clock_domain': 'simulation',
            'basis': 'Physics.step: maximum robot-obstacle normal force at each physics substep; excludes floor contacts'}


def executed_native_recording(output, frame_count):
    """Preserve a failed native recording and select only independently executed rows.

    Source lockstep appends pre-action state before planning. A planning exception
    can therefore leave one extra pre-state with no action, reference or result.
    The original artifact stays intact and an explicitly documented bounded slice
    is decoded by the normal independent replay adapter.
    """
    import numpy as np
    native = output / 'native'
    with np.load(native / 'closed_loop.npz', allow_pickle=False) as raw:
        values = {key: raw[key] for key in raw.files}
    counts = {key: len(values[key]) for key in ('pre_action_qpos', 'realized_qpos', 'references')}
    if (frame_count <= 0 or counts['realized_qpos'] != frame_count or counts['references'] != frame_count
            or counts['pre_action_qpos'] not in (frame_count, frame_count+1)):
        raise ValueError(f'Failed native recording does not match executed frame count: {counts}, observed {frame_count}')
    if counts['pre_action_qpos'] == frame_count:
        return native, {'source_path': str(native / 'closed_loop.npz'), 'executed_rows': frame_count,
                        'excluded_unexecuted_pre_states': 0}
    selected = output / 'native_executed'
    selected.mkdir()
    values['pre_action_qpos'] = values['pre_action_qpos'][:frame_count]
    if len(values.get('estimated_qpos', [])) > frame_count:
        values['estimated_qpos'] = values['estimated_qpos'][:frame_count]
    np.savez_compressed(selected / 'closed_loop.npz', **values)
    for name in ('plans.json', 'run_config.json'):
        if (native / name).is_file():
            _atomic(selected / name, json.loads((native / name).read_text()))
    extraction = {'source_path': str(native / 'closed_loop.npz'), 'executed_rows': frame_count,
                  'excluded_unexecuted_pre_states': counts['pre_action_qpos']-frame_count,
                  'basis': 'Only the final pre-state without an executed action/reference is excluded; original NPZ preserved'}
    _atomic(selected / 'extraction.json', extraction)
    return selected, extraction


def execute(request, output):
    """Run one owned task. The caller must impose an independent wall-time limit."""
    req = validate_request(request)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    _atomic(output / 'request.json', req)
    # Set before importing any native runtime. Never inherit a GPU or alternative bundle.
    os.environ['CUDA_VISIBLE_DEVICES'] = ''
    os.environ['OMP_NUM_THREADS'] = '2'
    os.environ['MKL_NUM_THREADS'] = '2'
    os.environ['OPENBLAS_NUM_THREADS'] = '2'
    os.environ['G1_STUDENT_BUNDLE'] = str(REFERENCE_ROOT / 'bundle')
    os.environ.pop('G1_BODY_MODEL', None)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(REFERENCE_ROOT))
    started = time.monotonic()
    failed_receipt_written = False
    _atomic(output / 'latest.json', {'schema_version': 1, 'status': 'initializing', 'frame': None,
                                     'progress': {'simulation_time_s': 0, 'wall_time_s': 0}})
    try:
        import numpy as np
        import torch
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        from g1deploy import bundle, contract
        from sim import lockstep
        from sim.episode import stand_start_state
        from g1deploy.perception import cloud_memory
        from studio.replay import decode_reference, load_session, _graph, _plan, _git_provenance

        s = stand_start_state(req['start_xy'], req['start_yaw_rad'])
        np.savez(output / 'initial_state.npz', joint_names=contract.MJ_JOINTS,
                 root_position_m=np.asarray([s['pos']]), root_quaternion_wxyz=np.asarray([s['quat']]),
                 joint_positions_rad=np.asarray([s['q']]), joint_velocities_rad_s=np.asarray([s['dq']]))
        task = {'task_id': req['id'], 'family': 'studio-user-configured',
                'initial_state_record': str(output / 'initial_state.npz'), 'initial_frame': 0,
                'initial_root_xy': req['start_xy'], 'scene_boxes_world': req['map']['boxes'],
                'goal_world_xy': req['goal_xy'], 'deadline_s': req['duration_s'],
                'goal_radius_m': .3, 'goal_speed_m_s': .25, 'goal_hold_s': .4,
                'fall_height_m': .35, 'fall_tilt_rad': 1.0, 'obstacle_contact_threshold_n': 100.0}
        _atomic(output / 'task.json', task)
        _atomic(output / 'boxes.json', req['map']['boxes'])
        source_files = [_hash(REFERENCE_ROOT / f) for f in ('sim/lockstep.py', 'sim/episode.py', 'g1deploy/contract.py',
                         'g1deploy/sonic.py', 'g1deploy/perception/cloud_memory.py',
                         'bundle/sonic/sonic_release_g1.onnx', 'bundle/flow/artifacts/student-s2-kcsc_s0/model.pt')]
        model_identity = _hash(REFERENCE_ROOT / 'sim/assets/g1_29dof.xml')
        checkout = _git_provenance(REFERENCE_ROOT)
        checkout['recording_revision'] = checkout['head_at_read']
        checkout['note'] = 'Checkout observed at this fresh run; source file hashes and dirty flag retained.'
        metadata = {'id': req['id'], 'title': 'Fresh Flow + SONIC CPU rehearsal', 'mode': 'simulation',
                    'recording_kind': 'sonic-mujoco-lockstep', 'backend_id': 'sonic',
                    'model_path': str(REFERENCE_ROOT / 'sim/assets/g1_29dof.xml'),
                    'model_variant': 'G1 29 DoF · rubber hands', 'duration_s': req['duration_s'],
                    'source_time_origin': 0, 'source_path': str(output), 'clock_domain': 'simulation',
                    'frame_id': 'world', 'quaternion_convention': 'wxyz',
                    'goal_xy': list(req['goal_xy']), 'start_xy': list(req['start_xy']),
                    'start_yaw_rad': req['start_yaw_rad'],
                    'navigation_criteria': {key: task[key] for key in
                                            ('goal_radius_m', 'goal_speed_m_s', 'goal_hold_s',
                                             'fall_height_m', 'fall_tilt_rad', 'obstacle_contact_threshold_n')},
                    'units': {'position': 'm', 'joint': 'rad', 'time': 's'},
                    'hardware_validated': False, 'command_path_enabled': False, 'fixture': False,
                    'policy_identity': 'Frozen Flow student + SONIC ONNX fused 1570 → 29 · CPU',
                    'policy_hash_at_recording': source_files[-2]['sha256'],
                    'recorded_model_hash': model_identity['sha256'],
                    'planner_configuration': dict(req['planner'], device='cpu', implementation='eager',
                                                   route_source='sensor', lidar='mjray', start='stand'),
                    'control_contract': {'joint_names': list(contract.MJ_JOINTS),
                                         'kp_nm_per_rad': contract.KP_MJ.tolist(),
                                         'kd_nm_per_rad_s': contract.KD_MJ.tolist(),
                                         'effort_limit_nm': contract.EFFORT_MJ.tolist(),
                                         'control_dt_s': contract.DT, 'physics_dt_s': contract.SIM_DT,
                                         'command_kind': 'PD position target; source applies clipped PD torques internally',
                                         'torque_samples_recorded': False},
                    'calibration_identity': 'bundled MID-360 inverted mount; simulation only',
                    'provenance': {'artifacts': source_files, 'model_at_recording': model_identity,
                                   'repositories': [checkout], 'adapter': 'studio.policy_worker.v1'},
                    'limitations': ['Fresh in-process CPU Flow + SONIC + MuJoCo; not a C++/DDS or real-time deployment validation.',
                                    'CPU quick-test sampling budget differs from deployed 16 candidates / 10 ODE steps unless selected.',
                                    'Map collision geometry is operator supplied. MuJoCo ray casts include robot self-filtering.',
                                    'Pose and IMU angular velocity are simulator truth; no physical sensor, camera, or hardware connection.',
                                    'Latent SONIC tokens are not exposed by the fused ONNX model.',
                                    'Unknown map cells remain unknown in Studio; the source planner selector treats unseen cells as free.']}
        frames, perceptions, events, plans, contact_intervals = [], [], [], [], []
        current = {'inference_ms': None, 'perception': None, 'raw': np.empty((0, 3)),
                   'filtered': np.empty((0, 3)), 'origin': None, 'capture_time': None,
                   'snapshot_time': -math.inf, 'last_write': -math.inf, 'sim': None, 'plan': None}
        progress_log = (output / 'progress.jsonl').open('w', buffering=1)

        def publish(frame=None, status='running', force=False):
            now = time.monotonic()
            if not force and now-current['last_write'] < .1:
                return
            current['last_write'] = now
            sim_t = frame['time'] if frame else 0
            payload = {'schema_version': 1, 'status': status, 'frame': frame, 'metadata': metadata,
                       'perception': current['perception'], 'joint_names': list(contract.MJ_JOINTS),
                       'graph': _graph(True), 'environment': {'boxes': req['map']['boxes'],
                           'classification': 'simulator-ground-truth', 'source': str(output / 'boxes.json')},
                       'progress': {'simulation_time_s': sim_t, 'wall_time_s': now-started,
                                    'real_time_factor': sim_t/(now-started), 'frames': len(frames),
                                    'requested_duration_s': req['duration_s']}}
            _atomic(output / 'latest.json', payload)

        BaseMemory = cloud_memory.CloudMemory

        class ObservedMemory(BaseMemory):
            def add_cloud(self, t_ready, points_world, origin_world, qpos36=None):
                current['raw'] = np.asarray(points_world).copy()
                current['origin'] = np.asarray(origin_world).reshape(-1, 3)[0].copy()
                current['capture_time'] = float(t_ready-self.latency)
                return super().add_cloud(t_ready, points_world, origin_world, qpos36)

            def evidence(self, points, origin):
                current['filtered'] = np.asarray(points).copy()
                return super().evidence(points, origin)

            def step(self, t, pelvis_pos=None, pelvis_quat_wxyz=None):
                super().step(t, pelvis_pos, pelvis_quat_wxyz)
                # Source pre-scan arange can represent nominal zero as 2.8e-16.
                # Preserve its 20 ms simulation lattice for causal lookup at t=0.
                if abs(t) < 1e-9:
                    t = 0.0
                if t < 0 or t-current['snapshot_time'] < .199999:
                    return
                current['snapshot_time'] = t
                layers, counts = {}, {}
                for name in ('support', 'ceiling'):
                    arr = getattr(self, name)
                    ix, iy = np.nonzero(np.isfinite(arr))
                    counts[name] = len(ix)
                    layers[name] = _points(np, np.column_stack((self.lo[0]+ix*self.res,
                                           self.lo[1]+iy*self.res, arr[ix, iy])), 1000)
                mounts = [{'name': 'mid360_inverted', 'parent_frame': 'pelvis',
                           'position_m': np.asarray(m.pos_pelvis).tolist(),
                           'rotation_matrix': np.asarray(m.rot_pelvis).tolist()} for m in self.mounts]
                p = {'available': True, 'kind': 'synchronized-map-snapshot', 'classification': 'estimated',
                     'time': float(t), 'map_time': float(t), 'source_time': float(t),
                     'sensor_capture_time': current['capture_time'], 'clock_domain': 'simulation',
                     'source_clock_domain': 'simulation',
                     'frame_id': 'world', 'synchronized': True,
                     'label': 'MuJoCo ray LiDAR → consumed CloudMemory · synchronized',
                     'source': 'g1deploy.perception.cloud_memory.MjRayMemory',
                     'raw_lidar': _points(np, current['raw']), 'filtered_lidar': _points(np, current['filtered']),
                     'raw_lidar_basis': 'Simulated ray returns registered in world',
                     'filtered_lidar_basis': 'Source range gate and named-joint capsule body self-filter',
                     'raw_points_count': len(current['raw']), 'filtered_points_count': len(current['filtered']),
                     'sensor_origin': None if current['origin'] is None else current['origin'].tolist(),
                     'extrinsics': mounts, 'sensor_latency_s': self.latency, 'rate_hz': 1/self.period,
                     'support_points': layers['support'], 'ceiling_points': layers['ceiling'],
                     'observed_points': layers['support']+layers['ceiling'], 'observed_cells': counts,
                     'origin': self.lo.tolist(), 'resolution_m': self.res, 'grid_shape': [self.n, self.n],
                     'unknown_cells': int((np.isnan(self.support) & np.isnan(self.ceiling)).sum()),
                     'support_observed_indices': np.flatnonzero(~np.isnan(self.support)).tolist(),
                     'ceiling_observed_indices': np.flatnonzero(~np.isnan(self.ceiling)).tolist(),
                     'clear_ceiling_cells': int(np.isposinf(self.ceiling).sum()),
                     'self_filter': True, 'self_removed': self.stats['self_removed'], 'filter_stats': dict(self.stats),
                     'mask_convention': 'grid[x][y]; absent cells unknown; finite cells only rendered',
                     'point_budget': MAX_SENSOR_POINTS, 'decimated': True,
                     'note': 'Raw and filtered returns are from sensor_capture_time; map has explicit 100 ms sensor latency.'}
                current['perception'] = p
                perceptions.append(p)

        cloud_memory.CloudMemory = ObservedMemory
        OriginalPhysics = lockstep.Physics

        class ObservedPhysics(OriginalPhysics):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                current['sim'] = self
                original_policy = self.tracker.policy

                def timed_policy(obs):
                    tic = time.perf_counter()
                    result = original_policy(obs)
                    current['inference_ms'] = (time.perf_counter()-tic)*1000
                    return result
                self.tracker.policy = timed_policy

            def step(self, ref_q_mj, ref_dq_mj, ref_ori6, push=None):
                measured = self.measure()
                q = measured['qpos']
                t = float(len(frames)*.02)
                tic = time.perf_counter()
                result = super().step(ref_q_mj, ref_dq_mj, ref_ori6, push)
                interval = contact_interval(result[2], t, float((len(frames)+1)*contract.DT))
                previous_contact = contact_intervals[-1] if contact_intervals else None
                contact_intervals.append(interval)
                # Source run_episode calls feed.target; its observer below stores all 67 columns.
                reference = decode_reference(current['reference'], q)
                plan = _plan(current['plan'], current['plan']['tick']*.02, t) if current['plan'] else None
                target = result[3]
                frame = {'time': t, 'sequence': len(frames), 'source_time': t,
                         'source_clock_domain': 'simulation', 'receipt_time': time.monotonic(),
                         'receipt_clock_domain': 'host-monotonic', 'sim_time': t,
                         'position': q[:3].tolist(), 'quaternion_wxyz': q[3:7].tolist(),
                         'joints': q[7:].tolist(), 'qpos': q.tolist(), 'classification': 'simulator-ground-truth',
                         'validity': 'valid', 'frame_id': 'world', 'reference': reference, 'plan': plan,
                         'command': {'joints': target.tolist(), 'classification': 'commanded',
                                     'kind': 'SONIC PD position targets', 'joint_order': 'named MuJoCo',
                                     'hardware_command': False, 'time': t, 'units': 'rad'},
                         'imu': {'quaternion_wxyz': q[3:7].tolist(),
                                 'angular_velocity_rad_s': measured['root_angular_velocity_b'].tolist(),
                                 'frame_id': 'pelvis', 'classification': 'simulator-ground-truth',
                                 'linear_acceleration_m_s2': None},
                         'joint_velocity_rad_s': measured['dq'].tolist(),
                         'post_action': {'time': interval['end_s'], 'qpos': self.measure()['qpos'].tolist(),
                                         'contact': interval,
                                         'classification': 'simulator-ground-truth'},
                         'perception_index': len(perceptions)-1 if perceptions else None,
                         'health': {'state_age_ms': 0, 'reference_age_ms': 0,
                                    'planner_latency_ms': plan['latency_ms'] if plan else None,
                                    'tracking_rmse_rad': float(np.sqrt(np.mean((q[7:]-ref_q_mj[0])**2))),
                                    'command_tracking_rmse_rad': float(np.sqrt(np.mean((q[7:]-target)**2))),
                                    'sonic_inference_ms': current['inference_ms'],
                                    'control_step_wall_ms': (time.perf_counter()-tic)*1000,
                                    'contact_force_n': previous_contact['max_force_n'] if previous_contact else None,
                                    'contact_interval': previous_contact,
                                    'lowcmd_age_ms': None, 'gpu_utilization': None}}
                frames.append(frame)
                # Compact 50 Hz stream: latest carries heavier reference/perception separately.
                progress_log.write(json.dumps({'time': t, 'sequence': frame['sequence'], 'qpos': frame['qpos'],
                                               'health': frame['health']}, allow_nan=False)+'\n')
                publish(frame)
                return result

        lockstep.Physics = ObservedPhysics
        flow = bundle.load_flow()
        original_target = flow.feed.target

        def observed_target(*args, **kwargs):
            result = original_target(*args, **kwargs)
            current['reference'] = np.asarray(result[0]).copy()
            return result
        flow.feed.target = observed_target
        original_plan = flow.planner.FlowPlanner.plan

        def observed_plan(self, *args, **kwargs):
            tic = time.perf_counter()
            result = original_plan(self, *args, **kwargs)
            row = {'tick': len(frames), 'latency_s': time.perf_counter()-tic, 'rule': result['rule'],
                   'chosen_clearance_m': float(result['chosen_clearance_m']),
                   'plan_xy': result['qpos'][:, :2].tolist(), 'plan_root_z': result['qpos'][:, 2].tolist(),
                   'waypoint_xy': None, 'route_remaining_m': None}
            current['plan'] = row
            plans.append(row)
            events.append({'time': len(frames)*.02, 'type': 'replan', 'message': result['rule'],
                           'source': 'FlowPlanner.plan', 'latency_ms': row['latency_s']*1000})
            return result
        flow.planner.FlowPlanner.plan = observed_plan
        publish(force=True)
        episode_error = None
        try:
            report = lockstep.run_episode(output / 'task.json', req['seed'], output / 'native',
                        device='cpu', planner_impl='eager', start='stand', route_source='sensor',
                        lidar='mjray', deadline_s=req['duration_s'], planner_overrides=req['planner'])
        except Exception as exc:
            episode_error = exc
            if not frames or not (output / 'native/score.json').is_file():
                raise
            report = json.loads((output / 'native/score.json').read_text())
            report.update(outcome='runtime_error', completed=False,
                          runtime_error=f'{type(exc).__name__}: {exc}')
        finally:
            progress_log.close()
        # Physics.step returns these same substeps directly to the source TaskScorer.
        # The native NPZ has no force channel, so preserve it as a separate owned artifact
        # and independently check its maximum against the unmodified scorer report.
        if max((x['max_force_n'] for x in contact_intervals), default=0.0) != report['maximum_obstacle_contact_n']:
            raise ValueError('Captured physics contact forces disagree with source TaskScorer')
        np.savez_compressed(output / 'physics_observations.npz',
                            interval_start_s=[x['start_s'] for x in contact_intervals],
                            interval_end_s=[x['end_s'] for x in contact_intervals],
                            obstacle_contact_n=[x['samples_n'] for x in contact_intervals])
        native_path, extraction = (executed_native_recording(output, len(frames)) if episode_error else
                                   (output / 'native', None))
        session = load_session(native_path, environment_path=output / 'boxes.json')
        # The independent native adapter validates name order, finite references and model width.
        if len(session['frames']) != len(frames) or not np.allclose(
                [f['qpos'] for f in frames], [f['qpos'] for f in session['frames']], atol=0, rtol=0):
            raise ValueError('Observed states disagree with independent native recording decoder')
        if not np.array_equal([f['reference']['raw'] for f in frames],
                              [f['reference']['raw'] for f in session['frames']]):
            raise ValueError('Observed SONIC references disagree with native recording decoder')
        if not np.array_equal([f['post_action']['qpos'] for f in frames],
                              [f['post_action']['qpos'] for f in session['frames']]):
            raise ValueError('Observed post-action states disagree with native recording decoder')
        metadata['duration_s'] = frames[-1]['time'] if frames else 0
        metadata['executed_sim_duration_s'] = report['elapsed_s']
        metadata['source_samples'] = len(frames)
        metadata['mode'] = 'replay'
        metadata['recording_complete'] = episode_error is None
        if episode_error:
            metadata.update(incomplete=True, termination_reason=f'{type(episode_error).__name__}: {episode_error}',
                            native_extraction=extraction)
            metadata['limitations'].append('Source execution failed. This partial recording contains only actually executed samples; no future motion is synthesized.')
        inference_ms = [f['health']['sonic_inference_ms'] for f in frames
                        if f['health']['sonic_inference_ms'] is not None]
        report['sonic_inference_ms'] = {'p50': float(np.median(inference_ms)),
                                       'p95': float(np.quantile(inference_ms, .95))} if inference_ms else None
        report['worker_wall_to_summary_s'] = time.monotonic()-started
        report['worker_real_time_factor'] = report['elapsed_s']/report['worker_wall_to_summary_s']
        report['worker_timing_basis'] = 'Measured startup, policy execution and native decoding; excludes final session serialization'
        metadata['test_result'] = report
        metadata['goal_xy'] = req['goal_xy']
        metadata['provenance']['artifacts'] += [_hash(output / p) for p in
                                               ('task.json', 'boxes.json', 'native/closed_loop.npz', 'physics_observations.npz')]
        if native_path != output / 'native':
            metadata['provenance']['artifacts'] += [_hash(native_path / 'closed_loop.npz'),
                                                   _hash(native_path / 'extraction.json')]
        # Preserve native route waypoints and original planner latency by causal join.
        for frame, native in zip(frames, session['frames']):
            frame['plan'] = native['plan']
            frame['health']['planner_latency_ms'] = native['health']['planner_latency_ms']
        session['frames'] = frames
        session['metadata'] = metadata
        session['perception'] = dict(current['perception'] or {'available': False},
                                      kind='time-series', frames=perceptions, synchronized=True)
        session['graph']['edges'][0]['topic'] = 'MuJoCo ray LiDAR (robot included, self-filtered)'
        session['graph']['dds_domain_note'] = 'No DDS participant exists in this in-process CPU rehearsal.'
        session['environment']['identity_basis'] = 'Exact collision boxes used by this fresh simulation; hash recorded'
        session['events'] += [{'time': frames[-1]['time'] if frames else 0,
                              'type': 'runtime_error' if episode_error else 'test_result',
                              'message': report.get('runtime_error') if episode_error else report['outcome'],
                              'source': 'source lockstep' if episode_error else 'TaskScorer'}]
        _atomic(output / 'session.json', session)
        status = 'failed' if episode_error else 'completed'
        _atomic(output / 'result.json', {'schema_version': 1, 'status': status, 'report': report,
                                        'recording_complete': episode_error is None,
                                        'error': f'{type(episode_error).__name__}: {episode_error}' if episode_error else None,
                                        'wall_time_s': time.monotonic()-started, 'session_path': str(output/'session.json'),
                                        'hardware_enabled': False, 'dds_participants': 0,
                                        'state_parity': 'exact state, post-action state and references; independent native NPZ decoder'})
        publish(frames[-1] if frames else None, status=status, force=True)
        if episode_error:
            failed_receipt_written = True
            raise episode_error
        return report
    except BaseException as exc:
        if failed_receipt_written:
            raise
        error = {'schema_version': 1, 'status': 'failed', 'error': f'{type(exc).__name__}: {exc}',
                 'wall_time_s': time.monotonic()-started, 'hardware_enabled': False, 'recording_complete': False}
        _atomic(output / 'result.json', error)
        # Preserve any last actual telemetry sample even for a startup/finalization
        # error. Failure is never replaced with fabricated empty healthy state.
        previous = json.loads((output / 'latest.json').read_text()) if (output / 'latest.json').is_file() else {}
        previous.update(status='failed', error=error['error'], recording_complete=False)
        _atomic(output / 'latest.json', previous)
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--request', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args(argv)
    if args.request.stat().st_size > 1024*1024:
        ap.error('request exceeds 1 MiB')
    execute(json.loads(args.request.read_text()), args.output)


if __name__ == '__main__':
    main()
