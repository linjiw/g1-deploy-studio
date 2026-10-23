"""Bounded CPU Flow/SONIC/MuJoCo execution, separate from the HTTP gateway.

This is the existing in-process lockstep backend, not the C++/DDS deployment
chain. No middleware participant or network command writer is created here.
The reference interpreter and source tree are consumed read-only.
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

from studio import actuators as _actuators

REFERENCE_ROOT = Path('/home/linjiw/code/g1-student-deploy')
REFERENCE_PYTHON = REFERENCE_ROOT / '.venv/bin/python'
BACKEND_ID = 'flow-sonic-mujoco-cpu'
MAX_DURATION_S = 10.0
# The deploy bundle's planner (studio/policies.py BUNDLE_LABEL): never call it Flow's current student.
BUNDLE_LABEL = "student-s2-kcsc (2026-10-08 bundle), not Flow's current LiDAR student"
MAX_BOXES = 128
MAX_SENSOR_POINTS = 1500
# Success criteria. "arrive_hold" is Studio's deployment-style arrival (stop and
# hold); "arena_reach" mirrors the Flow Isaac arena scoring the research uses.
CRITERIA = {
    'arrive_hold': {'label': 'Arrive and hold · Studio deployment check', 'goal_radius_m': .3, 'goal_speed_m_s': .25,
                    'goal_hold_s': .4, 'fall_height_m': .35, 'fall_tilt_rad': 1.0, 'obstacle_contact_threshold_n': 100.0},
    'arena_reach': {'label': 'Reach · Flow Isaac arena protocol', 'goal_radius_m': .4, 'goal_speed_m_s': 2.0,
                    'goal_hold_s': .1, 'fall_height_m': .38, 'fall_tilt_rad': .8, 'obstacle_contact_threshold_n': 5.0},
}
LOADERS = ('deploy-bundle', 'flow-callback')


class TorqueTracker:
    """Peak commanded PD torque per joint and substeps at the effective torque limit.

    Commanded torque is the source ``pd_torque`` return, which the source already clips to the training
    effort (g1deploy.contract); MuJoCo then clamps it to each joint's ``actuatorfrcrange``. The effective
    limit is therefore min(training effort, model range): a substep *at* it is saturated, whichever of the
    two clamped. Reference ceilings (training and each hardware profile) count substeps at or above them.
    """

    def __init__(self, np, model, joint_names, training_effort=None):
        self.np, self.names = np, list(joint_names)
        ids = [model.joint(n).id for n in self.names]
        self.limited = np.asarray(model.jnt_actfrclimited[ids], dtype=bool)
        self.range = np.asarray(model.jnt_actfrcrange[ids], dtype=float)
        model_hi = np.where(self.limited, self.range[:, 1], np.inf)
        self.effective = np.minimum(model_hi, np.asarray(training_effort, dtype=float)) if training_effort is not None else model_hi
        self.tick_peak = np.zeros(len(ids))
        self.saturated = np.zeros(len(ids), dtype=int)
        # Reference ceilings independent of the model clamp: training effort and each G1 hardware profile.
        from studio import actuators
        self.references = ({k: np.asarray(v, dtype=float) for k, v in actuators.reference_limits(self.names, training_effort).items()}
                           if training_effort is not None else {})
        self.exceed = {k: np.zeros(len(ids), dtype=int) for k in self.references}
        self.substeps = 0
        self.rows = []

    def observe(self, torque):
        t = self.np.asarray(torque, dtype=float)
        self.tick_peak = self.np.maximum(self.tick_peak, self.np.abs(t))
        self.saturated += self.np.abs(t) >= self.effective - 1e-6
        for k, ceiling in self.references.items():
            self.exceed[k] += self.np.abs(t) >= ceiling - 1e-6
        self.substeps += 1

    def end_tick(self):
        self.rows.append(self.tick_peak.copy())
        self.tick_peak[:] = 0

    def summary(self, training_effort):
        np = self.np
        peak = np.max(self.rows, axis=0) if self.rows else np.zeros(len(self.names))
        return {'peak_commanded_nm': dict(zip(self.names, peak.round(2).tolist())),
                'model_limit_nm': {n: (float(r[1]) if lim else None) for n, r, lim in zip(self.names, self.range, self.limited)},
                'training_effort_nm': dict(zip(self.names, np.asarray(training_effort, dtype=float).tolist())),
                'effective_limit_nm': {n: (float(v) if np.isfinite(v) else None) for n, v in zip(self.names, self.effective)},
                'saturated_substeps': {n: int(c) for n, c in zip(self.names, self.saturated) if c},
                'saturation_basis': 'at the effective limit min(source training-effort clip, model actuatorfrcrange)',
                'exceedance_substeps': {k: {n: int(c) for n, c in zip(self.names, v) if c} for k, v in self.exceed.items()},
                'reference_limits_nm': {k: dict(zip(self.names, v.tolist())) for k, v in self.references.items()},
                'total_substeps': int(self.substeps),
                'basis': 'Commanded = source pd_torque output per physics substep, already clipped to the training effort; MuJoCo then clamps to actuatorfrcrange (model limit). Reference counts are at-or-above. Simulator-commanded, not measured motor torque.'}


def _attribution(request_tick, start_tick, dt=0.02):
    return f'executing plan: requested at {request_tick*dt:.2f} s, driving SONIC since {start_tick*dt:.2f} s'


def validate_latency(value):
    value = value or {'ms': 0, 'anchor': 'measured'}
    if not isinstance(value, dict):
        raise ValueError('latency must be {ms, anchor}')
    ms = _number(value.get('ms', 0), 'latency.ms', 0, 1000)
    anchor = value.get('anchor', 'measured')
    if not isinstance(anchor, str) or anchor not in ('measured', 'predict'):
        raise ValueError("latency.anchor must be 'measured' or 'predict'")
    return {'ms': int(math.floor(ms / 20 + .5)) * 20, 'anchor': anchor}  # half-up to whole 20 ms ticks


def task_thresholds(criterion):
    return {k: v for k, v in CRITERIA[criterion].items() if k != 'label'}


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


def clean_map(m):
    """An explicit boxes collision map, world-aligned and bounded. A point cloud cannot silently become collision truth."""
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
    return {'id': str(m.get('id', 'map'))[:100], 'label': str(m.get('label', 'Collision map'))[:200],
            'kind': 'boxes', 'frame_id': 'world', 'boxes': clean_boxes,
            'source': str(m.get('source', 'operator-configured'))[:1000]}


def validate_planner(planner):
    if not isinstance(planner, dict):
        raise ValueError('planner must be an object')
    settings = {}
    for name, default, maximum in [('candidates', 2, 16), ('ode_steps', 4, 10)]:
        n = planner.get(name, default)
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= maximum:
            raise ValueError(f'planner.{name} must be an integer in 1..{maximum}')
        settings[name] = n
    return settings


def validate_request(request):
    """Allowlisted physics inputs. A point cloud cannot silently become collision truth."""
    if not isinstance(request, dict) or type(request.get('schema_version')) is not int or request.get('schema_version') != 1:
        raise ValueError('request schema_version must be 1')
    clean_map_document = clean_map(request.get('map'))
    planner = request.get('planner', {})
    settings = validate_planner(planner)
    seed = request.get('seed', 0)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**31 - 1:
        raise ValueError('seed must be an integer in 0..2147483647')
    criterion = request.get('criterion', 'arrive_hold')
    if not isinstance(criterion, str) or criterion not in CRITERIA:
        raise ValueError(f'criterion must be one of {sorted(CRITERIA)}')
    policy = request.get('policy') or {'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle'}
    if not isinstance(policy, dict) or policy.get('loader') not in LOADERS:
        raise ValueError(f'policy.loader must be one of {LOADERS}')
    policy_id = policy.get('id')
    if not isinstance(policy_id, str) or not 1 <= len(policy_id) <= 64 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in policy_id):
        raise ValueError('policy.id must be a lowercase identifier')
    clean_policy = {'id': policy_id, 'loader': policy['loader'],
                    'identity_sha256': str(policy.get('identity_sha256') or '')[:64] or None}
    if policy['loader'] == 'flow-callback':
        from studio.policy_bundle import bundle_path
        bundle_path(policy.get('bundle_id'))  # validates the identifier; never a free path
        clean_policy['bundle_id'] = policy['bundle_id']
    job_id = request.get('id', 'policy-test')
    if not isinstance(job_id, str) or not 1 <= len(job_id) <= 80 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in job_id):
        raise ValueError('id must contain only letters, digits, dash and underscore')
    clean = {'schema_version': 1, 'id': job_id, 'goal_xy': _xy(request.get('goal_xy'), 'goal_xy'),
             'start_xy': _xy(request.get('start_xy', [0, 0]), 'start_xy'),
             'start_yaw_rad': _number(request.get('start_yaw_rad', 0), 'start_yaw_rad', -math.pi, math.pi),
             'duration_s': _number(request.get('duration_s', 2), 'duration_s', .02, MAX_DURATION_S),
             'seed': seed, 'planner': settings, 'criterion': criterion, 'policy': clean_policy,
             'latency': validate_latency(request.get('latency')),
             # Requests saved before actuator profiles existed ran on the unpatched source model.
             'actuators': _actuators.validate(request.get('actuators', 'source')),
             'map': clean_map_document}
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
    if req['policy']['loader'] != 'deploy-bundle':
        raise ValueError('This worker runs only the frozen deploy bundle; use studio.flow_policy_worker')
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
        import onnxruntime as ort
        # This local rehearsal has no need for the runtime's vendor telemetry.
        # Set the process-local switch before constructing any inference session.
        ort.disable_telemetry_events()
        import torch
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        from g1deploy import bundle, contract
        from sim import lockstep, episode
        from sim.episode import stand_start_state
        from g1deploy.perception import cloud_memory
        from studio.replay import decode_reference, load_session, _graph, _plan, _git_provenance
        from studio.pipeline import PipelineRecorder, contract as pipeline_contract, SONIC_SAMPLE_EVERY
        pipeline = PipelineRecorder()

        s = stand_start_state(req['start_xy'], req['start_yaw_rad'])
        np.savez(output / 'initial_state.npz', joint_names=contract.MJ_JOINTS,
                 root_position_m=np.asarray([s['pos']]), root_quaternion_wxyz=np.asarray([s['quat']]),
                 joint_positions_rad=np.asarray([s['q']]), joint_velocities_rad_s=np.asarray([s['dq']]))
        task = {'task_id': req['id'], 'family': 'studio-user-configured',
                'initial_state_record': str(output / 'initial_state.npz'), 'initial_frame': 0,
                'initial_root_xy': req['start_xy'], 'scene_boxes_world': req['map']['boxes'],
                'goal_world_xy': req['goal_xy'], 'deadline_s': req['duration_s'], **task_thresholds(req['criterion'])}
        _atomic(output / 'task.json', task)
        _atomic(output / 'boxes.json', req['map']['boxes'])
        source_files = [_hash(REFERENCE_ROOT / f) for f in ('sim/lockstep.py', 'sim/episode.py', 'g1deploy/contract.py',
                         'g1deploy/sonic.py', 'g1deploy/perception/cloud_memory.py',
                         'g1deploy/bundle.py', 'g1deploy/route_compat.py', 'g1deploy/scoring.py',
                         'bundle/flow/src/motion2scene_flow/closed_loop/route.py',
                         'bundle/flow/src/motion2scene_flow/closed_loop/planner.py',
                         'bundle/flow/src/motion2scene_flow/closed_loop/feed.py',
                         'bundle/flow/src/motion2scene_flow/closed_loop/sensor_map.py',
                         'bundle/flow/src/motion2scene_flow/wholebody/elevation.py',
                         'bundle/flow/src/motion2scene_flow/wholebody/passage_model.py',
                         'bundle/flow/src/motion2scene_flow/wholebody/passage_flow.py',
                         'bundle/sonic/sonic_release_g1.onnx', 'bundle/flow/artifacts/student-s2-kcsc_s0/model.pt')]
        for optional_source in ('g1deploy/planner_compat.py', 'g1deploy/goal_guard.py'):
            if (REFERENCE_ROOT / optional_source).is_file():
                source_files.append(_hash(REFERENCE_ROOT / optional_source))
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
                    'navigation_criteria': dict({key: task[key] for key in
                                            ('goal_radius_m', 'goal_speed_m_s', 'goal_hold_s',
                                             'fall_height_m', 'fall_tilt_rad', 'obstacle_contact_threshold_n')},
                                            criterion=req['criterion'], label=CRITERIA[req['criterion']]['label']),
                    'policy_profile': {'id': req['policy']['id'], 'label': BUNDLE_LABEL,
                                       'research_block': None, 'identity_sha256': req['policy'].get('identity_sha256'),
                                       'revision': 'bundle 2026-10-08', 'loader': 'deploy-bundle'},
                    'units': {'position': 'm', 'joint': 'rad', 'time': 's'},
                    'hardware_validated': False, 'command_path_enabled': False, 'fixture': False,
                    'worker_exit_strategy': 'Explicit process exit after closed recording writes; native interpreter teardown skipped',
                    'policy_identity': 'Frozen Flow student + SONIC ONNX fused 1570 → 29 · CPU',
                    'policy_hash_at_recording': next(f['sha256'] for f in source_files if f['path'].endswith('/sonic_release_g1.onnx')),
                    'recorded_model_hash': model_identity['sha256'],
                    'planner_configuration': dict(req['planner'], device='cpu', implementation='eager',
                                                   route_source='sensor', lidar='mjray', start='stand',
                                                   latency_s=req['latency']['ms'] / 1000, anchor_mode=req['latency']['anchor'],
                                                   inflight=1),
                    'fidelity': 'L2' if req['latency']['ms'] else 'L1',
                    'latency_model': {'ms': req['latency']['ms'], 'anchor': req['latency']['anchor'],
                                      'implementation': 'g1-student-deploy sim.lockstep run_episode(latency_s, anchor_mode, inflight=1)',
                                      'basis': 'A plan requested at tick t becomes usable at t + latency while physics keeps running.',
                                      'plan_attribution': ('Frames show the executing plan: the plan object the source passes to '
                                                           'feed.target at that tick (observed, not re-derived)') if req['latency']['ms'] else None},
                    'control_contract': {'joint_names': list(contract.MJ_JOINTS),
                                         'kp_nm_per_rad': contract.KP_MJ.tolist(),
                                         'kd_nm_per_rad_s': contract.KD_MJ.tolist(),
                                         'effort_limit_nm': contract.EFFORT_MJ.tolist(),
                                         'control_dt_s': contract.DT, 'physics_dt_s': contract.SIM_DT,
                                         'command_kind': 'PD position target; source applies clipped PD torques internally',
                                         'torque_samples_recorded': True, 'torque_sample_period_s': SONIC_SAMPLE_EVERY*contract.DT},
                    'calibration_identity': 'bundled MID-360 inverted mount; simulation only',
                    'pipeline_contract': pipeline_contract(REFERENCE_ROOT / 'g1deploy/sonic.py', contract),
                    'provenance': {'artifacts': source_files + [_hash(Path(__file__)), _hash(Path(__file__).with_name('pipeline.py'))], 'model_at_recording': model_identity,
                                   'repositories': [checkout], 'adapter': 'studio.policy_worker.v1'},
                    'limitations': ['Fresh in-process CPU Flow + SONIC + MuJoCo; not a C++/DDS or real-time deployment validation.',
                                    'CPU quick-test sampling budget differs from deployed 16 candidates / 10 ODE steps unless selected.',
                                    'Map collision geometry is operator supplied. MuJoCo ray casts include robot self-filtering.',
                                    'Pose and IMU angular velocity are simulator truth; no physical sensor, camera, or hardware connection.',
                                    'Latent SONIC tokens are not exposed by the fused ONNX model.',
                                    'Unknown map cells remain unknown in Studio; the source planner selector treats unseen cells as free.']}
        frames, perceptions, events, plans, contact_intervals = [], [], [], [], []
        physics_positions, physics_quaternions = [], []
        # Under latency a replan drives SONIC only from request + L ticks (the first plan at once).
        latency_ticks = int(round(req['latency']['ms'] / 1000 / contract.DT))  # source lockstep rounding
        plan_objects, executing_starts = {}, []  # id(plan) -> (plan, row) with a strong ref; (start, request) ticks
        current = {'inference_ms': None, 'perception': None, 'raw': np.empty((0, 3)),
                   'filtered': np.empty((0, 3)), 'origin': None, 'capture_time': None,
                   'snapshot_time': -math.inf, 'last_write': -math.inf, 'sim': None, 'plan': None,
                   'sonic_sample': None, 'pd_torques': [], 'goal_evaluation': None, 'executing': None}
        progress_log = (output / 'progress.jsonl').open('w', buffering=1)

        def publish(frame=None, status='running', force=False):
            now = time.monotonic()
            if not force and now-current['last_write'] < .1:
                return
            current['last_write'] = now
            sim_t = frame['time'] if frame else 0
            live_frame = dict(frame, pipeline={'schema_version': 1,
                'flow_index': 0 if pipeline.flow_samples else None,
                'sonic_index': 0 if pipeline.sonic_samples else None}) if frame else None
            payload = {'schema_version': 1, 'status': status, 'frame': live_frame, 'metadata': metadata,
                       'pipeline': pipeline.data(latest=True),
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
        original_pd_torque = episode.pd_torque

        def observed_pd_torque(*args, **kwargs):
            result = original_pd_torque(*args, **kwargs)
            if current.get('torque') is not None:
                current['torque'].observe(result)
            if current['sonic_sample'] is not None:
                current['pd_torques'].append(np.asarray(result).copy().tolist())
            return result
        episode.pd_torque = observed_pd_torque
        OriginalScorer = lockstep.TaskScorer
        scorer_observations = []

        class ObservedScorer(OriginalScorer):
            def update(self, *args, **kwargs):
                result = super().update(*args, **kwargs)
                row = dict(self.rows[-1], source='g1deploy.scoring.TaskScorer.update',
                           source_time=float(self.steps*self.dt), clock_domain='simulation',
                           classification='simulator-ground-truth', hold_steps=int(self.hold_steps),
                           hold_elapsed_s=float(self.hold_steps*self.dt),
                           goal_radius_m=float(self.task['goal_radius_m']),
                           goal_speed_m_s=float(self.task['goal_speed_m_s']),
                           goal_hold_s=float(self.task['goal_hold_s']),
                           planner_latency_basis='Source scorer default 0; planner latency is recorded separately in frame.health')
                # Source calls the scorer AFTER Physics.step. Preserve this timestamp;
                # the next pre-action frame can expose it as a causal health sample.
                scorer_observations.append(row)
                current['goal_evaluation'] = row
                frames[-1]['post_action']['goal_evaluation'] = row
                return result
        lockstep.TaskScorer = ObservedScorer

        class ObservedPhysics(OriginalPhysics):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                current['sim'] = self
                # Patch the compiled model's hip limits before anything reads them (studio.actuators).
                current['actuators'] = _actuators.apply(self.model, contract.MJ_JOINTS, req['actuators'])
                current['torque'] = TorqueTracker(np, self.model, contract.MJ_JOINTS, contract.EFFORT_MJ)
                original_policy = self.tracker.policy
                signature = lambda entries: [{'name': x.name, 'shape': x.shape, 'type': x.type} for x in entries]
                metadata['pipeline_contract']['onnx_inputs'] = signature(self.tracker.session.get_inputs())
                metadata['pipeline_contract']['onnx_outputs'] = signature(self.tracker.session.get_outputs())
                output_name = self.tracker.session.get_outputs()[0].name

                def timed_policy(obs):
                    tic = time.perf_counter()
                    result = original_policy(obs)
                    current['inference_ms'] = (time.perf_counter()-tic)*1000
                    current['sonic_sample'] = pipeline.sonic(len(frames), contract.DT, obs, result,
                        current['inference_ms'], self.tracker.input_name, output_name)
                    return result
                self.tracker.policy = timed_policy

            def step(self, ref_q_mj, ref_dq_mj, ref_ori6, push=None):
                measured = self.measure()
                q = measured['qpos']
                t = float(len(frames)*.02)
                current['sonic_sample'] = None
                current['pd_torques'] = []
                tic = time.perf_counter()
                result = super().step(ref_q_mj, ref_dq_mj, ref_ori6, push)
                current['torque'].end_tick()
                interval = contact_interval(result[2], t, float((len(frames)+1)*contract.DT))
                previous_contact = contact_intervals[-1] if contact_intervals else None
                contact_intervals.append(interval)
                physics_positions.append(np.asarray(result[0]).copy())
                physics_quaternions.append(np.asarray(result[1]).copy())
                post_measured = self.measure()
                # Source run_episode calls feed.target; its observer below stores all 67 columns.
                reference = decode_reference(current['reference'], q)
                if latency_ticks and current['executing']:
                    row, start_tick = current['executing']
                    plan = dict(_plan(row, start_tick*contract.DT, t), requested_at_s=row['tick']*contract.DT,
                                executing_since_s=start_tick*contract.DT, attribution=_attribution(row['tick'], start_tick))
                else:
                    plan = _plan(current['plan'], current['plan']['tick']*.02, t) if current['plan'] else None
                target = result[3]
                if current['sonic_sample'] is not None:
                    current['sonic_sample'].update(target_joints_rad=target.tolist(),
                        reference=np.asarray(current['reference']).tolist(),
                        applied_pd={'start_s': t, 'end_s': interval['end_s'],
                            'joint_names': list(contract.MJ_JOINTS), 'torques_nm': current['pd_torques'],
                            'classification': 'simulator-commanded', 'clock_domain': 'simulation',
                            'basis': 'Actual clipped source pd_torque return applied before each physics substep'})
                frame = {'time': t, 'sequence': len(frames), 'source_time': t,
                         'source_clock_domain': 'simulation', 'receipt_time': time.monotonic(),
                         'receipt_clock_domain': 'host-monotonic', 'sim_time': t,
                         'position': q[:3].tolist(), 'quaternion_wxyz': q[3:7].tolist(),
                         'joints': q[7:].tolist(), 'qpos': q.tolist(), 'classification': 'simulator-ground-truth',
                         'validity': 'valid', 'frame_id': 'world', 'reference': reference, 'plan': plan,
                         'pipeline': pipeline.indices(),
                         'command': {'joints': target.tolist(), 'classification': 'commanded',
                                     'kind': 'SONIC PD position targets', 'joint_order': 'named MuJoCo',
                                     'hardware_command': False, 'time': t, 'units': 'rad'},
                         'imu': {'quaternion_wxyz': q[3:7].tolist(),
                                 'angular_velocity_rad_s': measured['root_angular_velocity_b'].tolist(),
                                 'frame_id': 'pelvis', 'classification': 'simulator-ground-truth',
                                 'linear_acceleration_m_s2': None},
                         'joint_velocity_rad_s': measured['dq'].tolist(),
                         'post_action': {'time': interval['end_s'], 'qpos': post_measured['qpos'].tolist(),
                                         'root_linear_velocity_w': post_measured['root_linear_velocity_w'].tolist(),
                                         'contact': interval,
                                         'classification': 'simulator-ground-truth'},
                         'perception_index': len(perceptions)-1 if perceptions else None,
                         'health': {'state_age_ms': 0, 'reference_age_ms': 0,
                                    'planner_latency_ms': current['plan']['latency_s']*1000 if current['plan'] else None,
                                    'tracking_rmse_rad': float(np.sqrt(np.mean((q[7:]-ref_q_mj[0])**2))),
                                    'command_tracking_rmse_rad': float(np.sqrt(np.mean((q[7:]-target)**2))),
                                    'sonic_inference_ms': current['inference_ms'],
                                    'control_step_wall_ms': (time.perf_counter()-tic)*1000,
                                    'contact_force_n': previous_contact['max_force_n'] if previous_contact else None,
                                    'contact_interval': previous_contact,
                                    'goal_evaluation': current['goal_evaluation'],
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
            # run_episode passes the active plan object: record the tick each plan starts driving SONIC.
            entry = plan_objects.get(id(args[0])) if args else None
            if entry is not None and entry[0] is args[0] and (
                    current['executing'] is None or current['executing'][0] is not entry[1]):
                current['executing'] = (entry[1], len(frames))
                executing_starts.append((len(frames), entry[1]['tick']))
            return result
        flow.feed.target = observed_target
        original_plan = flow.planner.FlowPlanner.plan

        def observed_plan(self, *args, **kwargs):
            if 'route' not in metadata['planner_configuration']:
                # Read the effective config emitted by this actual source run,
                # rather than applying today's defaults to an older recording.
                run_config = json.loads((output / 'native/run_config.json').read_text())
                metadata['planner_configuration']['route'] = run_config['route']
                metadata['planner_configuration']['route_configuration_source'] = 'native/run_config.json'
            pipeline.begin_plan(self, len(frames), contract.DT)
            tic = time.perf_counter()
            result = original_plan(self, *args, **kwargs)
            row = {'tick': len(frames), 'latency_s': time.perf_counter()-tic, 'rule': result['rule'],
                   'chosen_clearance_m': float(result['chosen_clearance_m']),
                   'plan_xy': result['qpos'][:, :2].tolist(), 'plan_root_z': result['qpos'][:, 2].tolist(),
                   'waypoint_xy': None, 'route_remaining_m': None}
            current['plan'] = row
            plans.append(row)
            plan_objects[id(result)] = (result, row)
            pipeline.end_plan(result, row['latency_s']*1000)
            events.append({'time': len(frames)*.02, 'type': 'replan', 'message': result['rule'],
                           'source': 'FlowPlanner.plan', 'latency_ms': row['latency_s']*1000})
            return result
        flow.planner.FlowPlanner.plan = observed_plan
        publish(force=True)
        episode_error = None
        try:
            report = lockstep.run_episode(output / 'task.json', req['seed'], output / 'native',
                        device='cpu', planner_impl='eager', start='stand', route_source='sensor',
                        lidar='mjray', deadline_s=req['duration_s'], planner_overrides=req['planner'],
                        latency_s=req['latency']['ms'] / 1000, anchor_mode=req['latency']['anchor'], inflight=1)
        except Exception as exc:
            episode_error = exc
            if not frames or not (output / 'native/score.json').is_file():
                raise
            report = json.loads((output / 'native/score.json').read_text())
            report.update(outcome='runtime_error', completed=False,
                          runtime_error=f'{type(exc).__name__}: {exc}')
        finally:
            progress_log.close()
            pipeline.close()
        # Physics.step returns these same substeps directly to the source TaskScorer.
        # The native NPZ has no force channel, so preserve it as a separate owned artifact
        # and independently check its maximum against the unmodified scorer report.
        if max((x['max_force_n'] for x in contact_intervals), default=0.0) != report['maximum_obstacle_contact_n']:
            raise ValueError('Captured physics contact forces disagree with source TaskScorer')
        np.savez_compressed(output / 'physics_observations.npz',
                            interval_start_s=[x['start_s'] for x in contact_intervals],
                            interval_end_s=[x['end_s'] for x in contact_intervals],
                            obstacle_contact_n=[x['samples_n'] for x in contact_intervals],
                            root_positions_m=physics_positions, root_quaternions_wxyz=physics_quaternions,
                            peak_commanded_torque_nm=current['torque'].rows if current.get('torque') else [],
                            joint_names=list(contract.MJ_JOINTS))
        _atomic(output / 'scorer_observations.json', scorer_observations)
        _atomic(output / 'pipeline_observations.json', pipeline.data())
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
        report['pipeline_capture_wall_ms'] = pipeline.telemetry_wall_s*1000
        if current.get('torque') is not None:
            report['torque'] = current['torque'].summary(contract.EFFORT_MJ)
        if current.get('actuators') is not None:
            report['actuators'] = current['actuators']
            metadata['actuators'] = current['actuators']
        report['latency_model'] = metadata['latency_model']
        report['pipeline_capture_timing_basis'] = 'Measured tensor copy/stat capture overhead; wrappers included in worker timing, not SONIC inference timing'
        metadata['test_result'] = report
        metadata['goal_xy'] = req['goal_xy']
        metadata['provenance']['artifacts'] += [_hash(output / p) for p in
                                               ('task.json', 'boxes.json', 'native/run_config.json', 'native/closed_loop.npz', 'physics_observations.npz', 'scorer_observations.json', 'pipeline_observations.json')]
        if native_path != output / 'native':
            metadata['provenance']['artifacts'] += [_hash(native_path / 'closed_loop.npz'),
                                                   _hash(native_path / 'extraction.json')]
        # Preserve native route waypoints and original planner latency by causal join.
        for frame, native in zip(frames, session['frames']):
            frame['plan'] = native['plan']
            frame['health']['planner_latency_ms'] = native['health']['planner_latency_ms']
        if latency_ticks and executing_starts:
            # The native decoder attributes a frame to the latest request; under latency attribute it to
            # the plan executing at that tick (review N8, as the WX worker does).
            start_ticks = [s for s, _ in executing_starts]
            for i, frame in enumerate(frames):
                k = bisect.bisect_right(start_ticks, i) - 1
                start_tick, request_tick = executing_starts[k] if k >= 0 else (None, None)
                source = session['frames'][request_tick]['plan'] if request_tick is not None else None
                frame['plan'] = None if source is None else dict(
                    source, time=start_tick*contract.DT, age_s=(i-start_tick)*contract.DT,
                    requested_at_s=request_tick*contract.DT, executing_since_s=start_tick*contract.DT,
                    attribution=_attribution(request_tick, start_tick))
        metadata['latency_model']['executing_plan_starts'] = executing_starts if latency_ticks else None
        session['pipeline'] = pipeline.data()
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
    import faulthandler
    faulthandler.enable()
    # Preserve stack evidence if native cleanup stalls after writing a result.
    # The parent still owns the existing 180 s process limit and exit-code check.
    faulthandler.dump_traceback_later(60, repeat=True)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--request', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args(argv)
    if args.request.stat().st_size > 1024*1024:
        ap.error('request exceeds 1 MiB')
    execute(json.loads(args.request.read_text()), args.output)


def run_cli():
    """Finish the disposable CPU process without native interpreter teardown.

    A recorded run has stalled after all result writes during native shutdown.
    This worker owns no hardware, middleware participants or child processes.
    execute closes its files and commits receipts before returning; the OS then
    reclaims runtime threads/memory. This does not convert exceptions to success:
    failures retain a nonzero exit and the parent still validates the receipt.
    Imported execution/tests retain ordinary Python lifetime semantics.
    """
    import traceback
    code = 0
    try:
        main()
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
        if exc.code is not None and not isinstance(exc.code, int):
            print(exc.code, file=sys.stderr)
    except BaseException:
        traceback.print_exc()
        code = 1
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        code = 1
    os._exit(code)


if __name__ == '__main__':
    run_cli()
