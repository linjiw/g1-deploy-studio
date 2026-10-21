"""Simulated robot for the Navigate workspace: an owned CPU process, separate from the HTTP gateway.

It behaves like g1-student-deploy's ``g1deploy/node.py`` on the robot, with MuJoCo + SONIC ONNX in place of
the robot and its MID-360. The robot stands and waits for a goal, pre-scans, walks with the frozen Flow
student, arrives and settles to a stand, and keeps one perception memory for the whole session.
Phases follow node.py: WAIT -> PRESCAN -> RUN -> ARRIVED | STOPPED, plus BOOT and ENDED.

Planning in RUN is the source lockstep loop (``sim/lockstep.py`` run_episode): the same history, memory,
route, goal function, planner call, latency model and feed target. Deliberate differences:
- the planner receives no task boxes, as in node.py; it only knows its own memory (with the bundle's
  sensor configuration the source planner does not read them anyway: map and clearance come from memory);
- one physics state and one memory for the whole session, never reset between goals;
- simulated time pauses while the robot stands waiting for the operator; nothing moves meanwhile;
- arrival is node.py's rule: the planner's pose estimate within the goal radius -> settle to stand.

Operator commands arrive as files in ``<output>/inbox`` written by the gateway (docs/NAVIGATE.md).
No DDS participant, socket, robot connection or hardware command path exists in this process.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time

from studio import actuators as _actuators
from studio.policy_worker import (REFERENCE_ROOT, TorqueTracker, _atomic, _hash, _number, _points, _xy,
                                  clean_map, contact_interval, validate_latency, validate_planner)

DT = 0.02
ODOMETRY = {
    'truth': {'label': 'Simulator truth', 'noise': None},
    # g1-student-deploy jobs/g4r.sh LIO and jobs/g4b.sh ODOM configurations (flow StateEstimate).
    'lio': {'label': 'LIO-level drift (G4 configuration)',
            'noise': {'xy_rw_m': 0.01, 'yaw_rw_rad': 0.005, 'xy_white_m': 0.002, 'yaw_white_rad': 0.001}},
    'drift': {'label': 'Poor odometry (G4 drift configuration)',
              'noise': {'xy_rw_m': 0.04, 'yaw_rw_rad': 0.02, 'xy_white_m': 0.01, 'yaw_white_rad': 0.005}},
}
TILT_ESTOP_RAD = 0.75          # node.py --tilt-estop
MIN_PELVIS_Z_M = 0.35          # node.py --min-pelvis-z (plan sanity) and the fall floor here
SETTLE_S, HOLD_S = 1.0, 3.0    # node.py stand(): settle to the default pose, then hold
MAX_COMMANDS = 2000
SNAPSHOT_PERIOD_S = 0.5
LAYER_POINTS = 1500


def validate_request(request):
    if not isinstance(request, dict) or request.get('schema_version') != 1:
        raise ValueError('request schema_version must be 1')
    job_id = request.get('id')
    if not isinstance(job_id, str) or not 1 <= len(job_id) <= 80 or any(
            c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in job_id):
        raise ValueError('id must contain only letters, digits, dash and underscore')
    seed = request.get('seed', 0)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**31 - 1:
        raise ValueError('seed must be an integer in 0..2147483647')
    odometry = request.get('odometry', 'truth')
    if odometry not in ODOMETRY:
        raise ValueError(f'odometry must be one of {sorted(ODOMETRY)}')
    initial_goal = request.get('initial_goal')
    return {'schema_version': 1, 'id': job_id, 'map': clean_map(request.get('map')),
            'start_xy': _xy(request.get('start_xy', [0, 0]), 'start_xy'),
            'start_yaw_rad': _number(request.get('start_yaw_rad', 0), 'start_yaw_rad', -math.pi, math.pi),
            'seed': seed, 'planner': validate_planner(request.get('planner', {})),
            'latency': validate_latency(request.get('latency')),
            'actuators': _actuators.validate(request.get('actuators', 'g1-current')),
            'odometry': odometry,
            'goal_radius_m': _number(request.get('goal_radius_m', 0.4), 'goal_radius_m', 0.2, 1.0),
            'prescan_s': _number(request.get('prescan_s', 0.5), 'prescan_s', 0, 3),
            'initial_prescan_s': _number(request.get('initial_prescan_s', 1.0), 'initial_prescan_s', 0, 3),
            'leg_timeout_s': _number(request.get('leg_timeout_s', 60), 'leg_timeout_s', 2, 300),
            'max_motion_s': _number(request.get('max_motion_s', 300), 'max_motion_s', 2, 900),
            'idle_timeout_s': _number(request.get('idle_timeout_s', 1200), 'idle_timeout_s', 5, 7200),
            'initial_goal': None if initial_goal is None else _xy(initial_goal, 'initial_goal'),
            'policy': {'id': 'flow-bundle-20261008', 'loader': 'deploy-bundle',
                       'identity_sha256': str((request.get('policy') or {}).get('identity_sha256') or '')[:64] or None}}


def _r(np, values, digits=4):
    return np.round(np.asarray(values, dtype=float), digits).tolist()


def read_inbox(inbox, after):
    """Commands with seq > after, in order. Malformed files are returned as rejections, never applied."""
    out = []
    try:
        names = sorted(n for n in os.listdir(inbox) if n.endswith('.json'))
    except FileNotFoundError:
        return out
    for name in names:
        try:
            seq = int(name[:-5])
        except ValueError:
            continue
        if seq <= after:
            continue
        try:
            cmd = json.loads((inbox / name).read_text())
            if not isinstance(cmd, dict) or cmd.get('seq') != seq or not isinstance(cmd.get('cmd'), str):
                raise ValueError('malformed command')
        except (OSError, ValueError) as exc:
            cmd = {'seq': seq, 'cmd': 'invalid', 'error': str(exc)[:200]}
        out.append(cmd)
    return out


def execute(request, output):
    """Run one owned session until the operator ends it or a limit is reached."""
    req = validate_request(request)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    inbox = output / 'inbox'
    inbox.mkdir()
    _atomic(output / 'request.json', req)
    os.environ['CUDA_VISIBLE_DEVICES'] = ''
    for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'):
        os.environ[name] = '2'
    os.environ['G1_STUDENT_BUNDLE'] = str(REFERENCE_ROOT / 'bundle')
    os.environ.pop('G1_BODY_MODEL', None)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(REFERENCE_ROOT))
    started = time.monotonic()
    _atomic(output / 'latest.json', {'schema_version': 1, 'status': 'initializing', 'kind': 'navigation',
                                     'robot': 'simulated', 'frame': None,
                                     'navigation': {'phase': 'BOOT', 'can': {'goal': False, 'go': False, 'stand': False, 'end': True}},
                                     'progress': {'simulation_time_s': 0, 'wall_time_s': 0}})
    try:
        return _run(req, output, inbox, started)
    except BaseException as exc:
        error = {'schema_version': 1, 'status': 'failed', 'error': f'{type(exc).__name__}: {exc}',
                 'wall_time_s': time.monotonic() - started, 'hardware_enabled': False, 'recording_complete': False}
        if not (output / 'result.json').is_file():
            _atomic(output / 'result.json', error)
        previous = json.loads((output / 'latest.json').read_text()) if (output / 'latest.json').is_file() else {}
        previous.update(status='failed', error=error['error'], recording_complete=False)
        _atomic(output / 'latest.json', previous)
        raise


def _run(req, output, inbox, started):
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    import torch
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    from g1deploy import bundle, contract
    from g1deploy.latency import predicted_history
    from g1deploy.perception import cloud_memory
    from sim import episode
    from sim.episode import Physics, stand_start_state
    from sim.lockstep import cached_planner, make_goal_fn
    from studio.replay import decode_reference, _graph, _plan, _git_provenance

    flow = bundle.load_flow()
    cfg = bundle.student_config()
    sm = flow.sensor_map
    seed = req['seed']
    pdict = dict(cfg['planner'], device='cpu', seed=seed, **req['planner'])
    pcfg = flow.planner.PlannerConfig(**pdict)
    ep = dict(cfg['episode'])
    ep['arrival_radius_m'] = req['goal_radius_m']
    replan, lookahead = int(ep['replan_ticks']), float(ep['goal_lookahead_m'])
    variant = cfg['route_variants']['sensor']
    route_cfg = variant.get('route', {})
    source_prescan = float(variant.get('sensor_prescan_s', 0.0))
    limits = np.asarray([j['range_rad'] for j in json.loads((bundle.ROOT / 'config/sonic_model_contract.json').read_text())['joints']
                         if j['type'] != 'free'])
    lat_ticks = int(round(req['latency']['ms'] / 1000 / DT))
    anchor_mode = req['latency']['anchor']
    np.random.seed(seed)
    torch.manual_seed(seed)
    planner = cached_planner(flow, pcfg, 'eager', 'fp32')

    # ---------------------------------------------------------------- observed physics and memory
    current = {'raw': np.empty((0, 3)), 'filtered': np.empty((0, 3)), 'origin': None, 'capture_time': None,
               'inference_ms': None, 'pd': None}
    torque = {}
    original_pd_torque = episode.pd_torque

    def observed_pd_torque(*args, **kwargs):
        result = original_pd_torque(*args, **kwargs)
        if torque.get('tracker') is not None:
            torque['tracker'].observe(result)
        return result
    episode.pd_torque = observed_pd_torque

    BaseMemory = cloud_memory.CloudMemory

    class ObservedMemory(BaseMemory):
        def add_cloud(self, t_ready, points_world, origin_world, qpos36=None):
            current['raw'] = np.asarray(points_world).copy()
            current['origin'] = np.asarray(origin_world).reshape(-1, 3)[0].copy()
            current['capture_time'] = float(t_ready - self.latency)
            return super().add_cloud(t_ready, points_world, origin_world, qpos36)

        def evidence(self, points, origin):
            current['filtered'] = np.asarray(points).copy()
            return super().evidence(points, origin)
    cloud_memory.CloudMemory = ObservedMemory

    sim = Physics([dict(b) for b in req['map']['boxes']], bundle.sonic_onnx())
    receipt = _actuators.apply(sim.model, contract.MJ_JOINTS, req['actuators'])
    torque['tracker'] = TorqueTracker(np, sim.model, contract.MJ_JOINTS, contract.EFFORT_MJ)
    original_policy = sim.tracker.policy

    def timed_policy(obs):
        tic = time.perf_counter()
        result = original_policy(obs)
        current['inference_ms'] = (time.perf_counter() - tic) * 1000
        return result
    sim.tracker.policy = timed_policy
    sim.reset(stand_start_state(req['start_xy'], req['start_yaw_rad']))
    noise = ODOMETRY[req['odometry']]['noise']
    estimate = flow.callback.StateEstimate(noise, np.random.default_rng([seed, 7]))
    m0 = sim.measure()
    start_q = m0['qpos']
    history = flow.callback.backfill_history(start_q, m0['dq'], m0['root_linear_velocity_w'],
                                             m0['root_angular_velocity_w'], planner.history)
    memory = cloud_memory.MjRayMemory(sim, start_q[:2], rng=np.random.default_rng(seed), **dict(pcfg.sensor))
    parity = req['initial_goal'] is not None
    prescan = source_prescan if parity else req['initial_prescan_s']
    if prescan > 0:  # frozen pre-scan before t = 0, exactly as the source (sensor runs, physics does not)
        memory.next_capture = -prescan
        for t_ in np.arange(-prescan, 1e-9, 0.02):
            memory.step(float(t_), start_q[:3], start_q[3:7])
    clearance_fn = sm.HeightFieldSelector(memory, planner.certifier.tree, planner.certifier.bodies, planner.shapes)

    def map_fn(xy, yaw):
        m, _ = memory.ego_map(xy, yaw, pcfg.datum_offset_m, pcfg.support_clip_m or 0.8)
        return m

    def ceiling_near(xy, radius_m=0.8, below_m=1.35):  # node.py StudentNode.ceiling_near
        c = memory.ceiling
        ij = np.round((np.asarray(xy) - memory.lo) / memory.res).astype(int)
        k = int(np.ceil(radius_m / memory.res))
        a0, a1 = max(ij[0] - k, 0), min(ij[0] + k + 1, memory.n)
        b0, b1 = max(ij[1] - k, 0), min(ij[1] + k + 1, memory.n)
        win = c[a0:a1, b0:b1]
        return bool(np.any(np.isfinite(win) & (win < below_m)))

    def stand_plan(q, tick):  # node.py StudentNode.stand: joints -> SONIC default pose, pelvis yaw kept, then hold
        q = np.asarray(q, dtype=np.float64)
        n_settle, n = int(SETTLE_S / DT), int((SETTLE_S + HOLD_S) / DT)
        a = np.clip(np.arange(1, n + 1) / n_settle, 0.0, 1.0)[:, None]
        a = a * a * (3 - 2 * a)
        frames = np.repeat(q[None], n, 0)
        frames[:, 7:] = (1 - a) * q[7:] + a * contract.DEFAULT_MJ
        w, x, y, z = q[3:7]
        yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
        rot = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
        plan = {'qpos': frames, 'rotation': np.repeat(rot[None], n, 0), 'stand': True,
                'joint_velocity': np.vstack([np.zeros((1, 29)), np.diff(frames[:, 7:], axis=0) / DT])}
        return (plan, tick, q, np.zeros(29))

    # ---------------------------------------------------------------- session state
    checkout = _git_provenance(REFERENCE_ROOT)
    source_files = [_hash(REFERENCE_ROOT / f) for f in (
        'sim/lockstep.py', 'sim/episode.py', 'g1deploy/node.py', 'g1deploy/contract.py', 'g1deploy/latency.py',
        'g1deploy/goal_guard.py', 'g1deploy/perception/cloud_memory.py', 'bundle/sonic/sonic_release_g1.onnx',
        'bundle/flow/artifacts/student-s2-kcsc_s0/model.pt')]
    metadata = {'id': req['id'], 'title': 'Navigate · simulated robot', 'mode': 'simulation',
                'recording_kind': 'navigation-session', 'kind': 'navigation', 'robot': 'simulated', 'backend_id': 'sonic',
                'model_path': str(REFERENCE_ROOT / 'sim/assets/g1_29dof.xml'), 'model_variant': 'G1 29 DoF · rubber hands',
                'clock_domain': 'simulation', 'source_time_origin': 0, 'source_path': str(output),
                'frame_id': 'world', 'quaternion_convention': 'wxyz', 'units': {'position': 'm', 'joint': 'rad', 'time': 's'},
                'start_xy': req['start_xy'], 'start_yaw_rad': req['start_yaw_rad'], 'goal_xy': None,
                'map_id': req['map']['id'], 'map_label': req['map']['label'],
                'policy_profile': {'id': req['policy']['id'], 'label': 'Flow student s2-kcsc · frozen deploy bundle',
                                   'identity_sha256': req['policy'].get('identity_sha256'), 'loader': 'deploy-bundle',
                                   'revision': 'bundle 2026-10-08'},
                'planner_configuration': dict(req['planner'], device='cpu', implementation='eager', route_source='sensor',
                                              lidar='mjray', start='stand', latency_s=req['latency']['ms'] / 1000,
                                              anchor_mode=anchor_mode, inflight=1, task_boxes_to_planner=False),
                'fidelity': 'L2' if lat_ticks else 'L1',
                'latency_model': {'ms': req['latency']['ms'], 'anchor': anchor_mode,
                                  'basis': 'source lockstep: a replan requested at tick t drives SONIC from t + latency; '
                                           'the first plan of each walk is computed while standing'},
                'odometry': {'id': req['odometry'], **ODOMETRY[req['odometry']]},
                'node_rules': {'goal_radius_m': req['goal_radius_m'], 'prescan_s': req['prescan_s'],
                               'tilt_estop_rad': TILT_ESTOP_RAD, 'stand': f'{SETTLE_S:g} s settle + {HOLD_S:g} s hold',
                               'stand_deferral': 'near a remembered ceiling below 1.35 m within 0.8 m (node.py)',
                               'source': 'g1deploy/node.py'},
                'actuators': receipt, 'hardware_validated': False, 'command_path_enabled': False, 'fixture': False,
                'pause_rule': 'Simulated time stops while the robot stands waiting for the operator.',
                'provenance': {'artifacts': source_files + [_hash(Path(__file__))], 'repositories': [checkout],
                               'adapter': 'studio.nav_worker.v1'},
                'limitations': [
                    'Simulated robot: in-process CPU MuJoCo + SONIC ONNX + frozen Flow student; not the C++/DDS chain or hardware.',
                    'The node state machine is reproduced from g1deploy/node.py; the real node plans asynchronously in real time.',
                    'Pose shown is simulator truth; the planner uses the selected odometry estimate.',
                    'The map is the planner memory built from simulated MID-360 ray casts (robot included, self-filtered).',
                    'Simulated time pauses while the robot waits for the operator; the real robot keeps scanning meanwhile.']}
    S = {'phase': 'BOOT', 'tick': 0, 'paused': True, 'goal': None, 'staged': None, 'leg': None, 'legs': [],
         'commands': [], 'events': [], 'last_seq': 0, 'active': stand_plan(start_q, 0), 'pending': [],
         'last_request': -10**9, 'route': None, 'goal_fn': None, 'pending_stand': None, 'stand_tick': None,
         'fallen': False, 'ending': False, 'end_reason': None, 'last_command_wall': time.monotonic(),
         'map_seq': 0, 'map_written': -math.inf, 'map_dirty': True, 'last_write': -math.inf, 'check': None,
         'executing': None, 'motion_ticks': 0, 'snapshot_time': -math.inf, 'perception': None,
         'q': start_q.copy()}  # the planner's latest pose estimate (float64, as node.py's state)
    frames, perceptions, plans = [], [], []
    executing_starts = []  # (start tick, plan row index) per plan that drove SONIC

    def event(kind, message, **fields):
        S['events'].append({'time': S['tick'] * DT, 'type': kind, 'message': message, 'source': 'nav_worker', **fields})

    def leg_dict(leg):
        return {k: leg.get(k) for k in ('index', 'goal_xy', 'staged_at_s', 'go_at_s', 'start_xy', 'end_s', 'outcome',
                                        'duration_s', 'path_m', 'final_dist_m', 'max_contact_n', 'plans', 'reason')}

    def can():
        standing = S['paused'] and S['phase'] in ('WAIT', 'ARRIVED', 'STOPPED') and not S['fallen'] and not S['ending']
        return {'goal': standing, 'go': standing and S['staged'] is not None,
                'stand': S['phase'] in ('PRESCAN', 'RUN') and S['pending_stand'] is None and not S['ending'],
                # The operator's remote D-up: SONIC stands now, whatever the node defers (approximated by the stand chunk).
                'takeover': (S['phase'] in ('PRESCAN', 'RUN') or S['pending_stand'] is not None) and not S['paused'] and not S['fallen'],
                'end': not S['ending']}

    def snapshot(force=False):
        t = S['tick'] * DT
        if not force and t - S['snapshot_time'] < SNAPSHOT_PERIOD_S - 1e-9:
            return
        S['snapshot_time'] = t
        layers, counts = {}, {}
        for name in ('support', 'ceiling'):
            arr = getattr(memory, name)
            ix, iy = np.nonzero(np.isfinite(arr))
            counts[name] = len(ix)
            layers[name] = _r(np, _points(np, np.column_stack((memory.lo[0] + ix * memory.res, memory.lo[1] + iy * memory.res,
                                                                arr[ix, iy])), LAYER_POINTS), 3)
        observed = int((~(np.isnan(memory.support) & np.isnan(memory.ceiling))).sum())
        p = {'available': True, 'kind': 'synchronized-map-snapshot', 'classification': 'estimated', 'time': t,
             'map_time': t, 'source_time': t, 'sensor_capture_time': current['capture_time'], 'clock_domain': 'simulation',
             'frame_id': 'world', 'synchronized': True,
             'label': 'Planner memory from simulated MID-360 ray casts · synchronized',
             'source': 'g1deploy.perception.cloud_memory.MjRayMemory',
             'raw_lidar': _r(np, _points(np, current['raw']), 3), 'filtered_lidar': _r(np, _points(np, current['filtered']), 3),
             'raw_lidar_basis': 'Simulated ray returns registered in world',
             'filtered_lidar_basis': 'Source range gate and named-joint capsule body self-filter',
             'raw_points_count': len(current['raw']), 'filtered_points_count': len(current['filtered']),
             'sensor_origin': None if current['origin'] is None else _r(np, current['origin']),
             'sensor_latency_s': memory.latency, 'rate_hz': 1 / memory.period,
             'support_points': layers['support'], 'ceiling_points': layers['ceiling'],
             'observed_cells': counts, 'observed_fraction': observed / memory.support.size,
             'origin': memory.lo.tolist(), 'resolution_m': memory.res, 'grid_shape': [memory.n, memory.n],
             'unknown_cells': int(memory.support.size - observed), 'self_filter': True, 'filter_stats': dict(memory.stats),
             'mask_convention': 'grid[x][y]; absent cells unknown; finite cells only rendered', 'point_budget': LAYER_POINTS,
             'decimated': True, 'map_file': 'memory.npz'}
        S['perception'] = p
        perceptions.append(p)
        S['map_dirty'] = True

    def write_map(force=False):
        now = time.monotonic()
        if not S['map_dirty'] or (not force and now - S['map_written'] < 0.5):
            return
        boxes = sm.memory_boxes(memory, grow_overhead_m=pcfg.guide_grow_overhead_m)
        tmp = output / 'memory.tmp.npz'
        np.savez_compressed(tmp, support=memory.support, ceiling=memory.ceiling, lo=np.asarray(memory.lo, dtype=float),
                            res=np.float64(memory.res), boxes=json.dumps(boxes, default=float),
                            stats=json.dumps(dict(memory.stats, basis='planner memory', time_s=S['tick'] * DT)))
        tmp.replace(output / 'memory.npz')
        S['map_seq'] += 1
        S['map_written'] = now
        S['map_dirty'] = False

    def navigation_block():
        q = frames[-1]['estimate'] if frames else {'position': start_q[:3].tolist()}
        goal = S['staged'] or S['goal']
        dist = None if goal is None else float(math.dist(q['position'][:2], goal['xy']))
        perception = S['perception'] or {}
        return {'phase': S['phase'], 'paused': S['paused'], 'standing': S['paused'] or S['phase'] in ('ARRIVED', 'STOPPED', 'WAIT'),
                'goal': goal, 'goal_dist_m': dist, 'fallen': S['fallen'],
                'legs': [leg_dict(leg) for leg in S['legs']] + ([leg_dict(S['leg'])] if S['leg'] else []),
                'commands': S['commands'][-20:], 'can': can(), 'go_note': None,
                'streams': [{'id': 'simulation', 'label': 'Simulated robot (lockstep)', 'age_s': 0.0 if not S['paused'] else None,
                             'rate_hz': None, 'threshold_s': None, 'status': 'paused' if S['paused'] else 'fresh'}],
                'map': {'basis': 'planner memory', 'seq': S['map_seq'], 'observed_fraction': perception.get('observed_fraction'),
                        'updated_s': perception.get('time'), 'file': 'memory.npz'},
                'check': S['check'], 'pending_stand': S['pending_stand'], 'end_reason': S['end_reason'],
                'holding_plan_end': bool(S['pending_stand'] is not None and not S['active'][0].get('stand')
                                         and S['tick'] - S['active'][1] >= len(S['active'][0]['qpos'])),
                'motion_s': S['motion_ticks'] * DT, 'max_motion_s': req['max_motion_s']}

    def publish(status='running', force=False):
        now = time.monotonic()
        if not force and now - S['last_write'] < 0.1:
            return
        S['last_write'] = now
        write_map()
        sim_t = S['tick'] * DT
        frame = frames[-1] if frames else initial_frame
        payload = {'schema_version': 1, 'status': status, 'kind': 'navigation', 'robot': 'simulated',
                   'heartbeat': {'monotonic': now, 'clock_domain': 'host-monotonic',
                                 'basis': 'session process alive; frames stop while the robot waits'},
                   'frame': frame, 'metadata': metadata, 'perception': S['perception'],
                   'navigation': navigation_block(), 'joint_names': list(contract.MJ_JOINTS), 'graph': _graph(True),
                   'environment': {'boxes': req['map']['boxes'], 'classification': 'simulator-ground-truth',
                                   'label': 'True world (simulation only; the robot does not see this)'},
                   'events': S['events'][-30:],
                   'progress': {'simulation_time_s': sim_t, 'wall_time_s': now - started,
                                'real_time_factor': (S['motion_ticks'] * DT) / max(1e-6, S.get('motion_wall', 0.0)) if S.get('motion_wall') else None,
                                'frames': len(frames), 'paused': S['paused']}}
        _atomic(output / 'latest.json', payload)

    def reply(cmd, status, reason=None):
        S['commands'].append({'seq': cmd.get('seq'), 'cmd': cmd.get('cmd'), 'status': status, 'reason': reason,
                              'time_s': S['tick'] * DT, **({'xy': cmd.get('xy')} if cmd.get('xy') is not None else {})})
        event('command', f"{cmd.get('cmd')} {status}" + (f': {reason}' if reason else ''), seq=cmd.get('seq'), status=status)

    def stand(reason, force=False):  # node.py stand(), including the ceiling deferral (force: the remote's D-up)
        q = np.asarray(S['q'], dtype=np.float64)
        if not force and ceiling_near(q[:2]):
            if S['pending_stand'] is None:
                event('stand_deferred', f'stand deferred under a low ceiling ({reason})', reason=reason)
            S['pending_stand'] = reason
            S['pending'] = []
            return False
        S['pending_stand'] = None
        S['pending'] = []
        S['active'] = stand_plan(q, S['tick'])
        S['stand_tick'] = S['tick']
        event('stand', f'stand ({reason})', reason=reason)
        return True

    def start_leg():
        goal = S['staged']
        S['goal'], S['staged'] = goal, None
        q = np.asarray(S['q'], dtype=np.float64)
        S['leg'] = {'index': len(S['legs']) + 1, 'goal_xy': goal['xy'], 'staged_at_s': goal['staged_at_s'],
                    'go_at_s': S['tick'] * DT, 'start_xy': _r(np, q[:2]), 'outcome': None, 'path_m': 0.0, 'max_contact_n': 0.0,
                    'plans': 0, 'start_tick': S['tick'], 'arrived_tick': None}
        metadata['goal_xy'] = goal['xy']
        event('goal', f"walk {len(S['legs']) + 1} to ({goal['xy'][0]:.2f}, {goal['xy'][1]:.2f})", goal_xy=goal['xy'])

    def begin_run():
        q = np.asarray(S['q'], dtype=np.float64)
        goal_xy = np.asarray(S['goal']['xy'], dtype=float)
        S['route'] = flow.route.SensorRoute(q[:2], goal_xy, memory, **route_cfg)
        S['goal_fn'] = make_goal_fn(S['route'], lookahead, ep['goal_heading'], float(ep['steer_lookahead_m']), ep.get('turn_min_frac'),
                                    flow.callback.goal_vector, flow.callback.route_goal_heading,
                                    arrival_radius_m=ep['arrival_radius_m'], arrival_scope=f"{output}#walk{S['leg']['index']}")
        S['phase'] = 'RUN'
        S['leg']['first_plan_pending'] = True
        event('run', f"walk {S['leg']['index']}: planning from the memory", route_found=bool(S['route'].found))

    def end_leg(outcome, reason=None):
        leg = S['leg']
        if leg is None:
            return
        q = frames[-1]['estimate']['position'] if frames else start_q[:3].tolist()
        leg.update(outcome=outcome, reason=reason, end_s=S['tick'] * DT, duration_s=(S['tick'] - leg['start_tick']) * DT,
                   final_dist_m=float(math.dist(q[:2], leg['goal_xy'])), path_m=round(leg['path_m'], 3))
        S['legs'].append(leg)
        S['leg'] = None
        event('walk_end', f"walk {leg['index']}: {outcome}" + (f' ({reason})' if reason else ''), outcome=outcome)

    def apply(cmd):
        name = cmd.get('cmd')
        S['last_command_wall'] = time.monotonic()
        if name == 'invalid':
            return reply(cmd, 'rejected', cmd.get('error'))
        if name == 'goal':
            if not can()['goal']:
                return reply(cmd, 'rejected', 'A goal can be staged only while the robot stands and waits')
            try:
                xy = _xy(cmd.get('xy'), 'goal xy')
            except ValueError as exc:
                return reply(cmd, 'rejected', str(exc))
            from studio import goal_check
            robot = np.asarray(S['q'][:2], dtype=float)
            live = goal_check.grid_from_arrays(memory.support, memory.ceiling, memory.lo, memory.res, basis='planner memory')
            result = goal_check.check_goal(live, robot, xy, arrival_radius_m=req['goal_radius_m'], basis='planner memory')
            S['check'] = result
            if not result['ok']:
                blocking = '; '.join(c['label'] for c in result['checks'] if c['status'] == 'block')
                return reply(cmd, 'rejected', blocking or 'goal check failed')
            S['staged'] = {'xy': xy, 'frame_id': 'world', 'seq': cmd['seq'], 'staged_at_s': S['tick'] * DT}
            return reply(cmd, 'applied')
        if name == 'clear':
            if S['staged'] is None:
                return reply(cmd, 'rejected', 'No staged goal')
            S['staged'] = None
            return reply(cmd, 'applied')
        if name == 'go':
            if not can()['go']:
                return reply(cmd, 'rejected', 'Stage a goal first; Go works only while the robot stands')
            start_leg()
            S['phase'], S['paused'] = 'PRESCAN', False
            S['prescan_until'] = S['tick'] + int(round(req['prescan_s'] / DT))
            event('prescan', f"pre-scan {req['prescan_s']:g} s")
            return reply(cmd, 'applied')
        if name == 'stand':
            if not can()['stand']:
                return reply(cmd, 'rejected', 'The robot is not walking')
            S['phase'] = 'STOPPED'
            if S['leg']:
                S['leg']['stop_reason'] = 'operator'
            stand('operator')
            return reply(cmd, 'applied')
        if name == 'takeover':
            if not can()['takeover']:
                return reply(cmd, 'rejected', 'The robot is standing already')
            S['phase'] = 'STOPPED'
            if S['leg']:
                S['leg']['stop_reason'] = 'operator takeover (remote D-up)'
            event('takeover', 'operator takeover: SONIC stands now (remote D-up; not near anything overhead on a real robot)')
            stand('takeover', force=True)
            return reply(cmd, 'applied')
        if name == 'end':
            S['ending'], S['end_reason'] = True, 'operator ended the session'
            if S['phase'] in ('PRESCAN', 'RUN'):
                S['phase'] = 'STOPPED'
                stand('session end')
            return reply(cmd, 'applied')
        return reply(cmd, 'rejected', f'Unknown command {name!r}')

    def request_plan(q, tick):
        leg = S['leg']
        first = leg.pop('first_plan_pending', False)
        route, goal_fn = S['route'], S['goal_fn']
        route.refresh(q[:2], tick * DT)
        wp, heading, remaining = route.waypoint(q[:2], lookahead)
        guide = sm.memory_boxes(memory, grow_overhead_m=pcfg.guide_grow_overhead_m) \
            if pcfg.guide_w > 0 and pcfg.guide_source == 'sensor' else None
        active = S['active']
        predictive = anchor_mode == 'predict' and lat_ticks > 0 and not first
        plan_hist = predicted_history(history, active, tick, lat_ticks, planner.history + 2) if predictive else history
        anchor_at = tick + lat_ticks if predictive else tick
        prev = None if first or active[0].get('stand') else (active[0], anchor_at - active[1])
        tp = time.perf_counter()
        goal_fn.arrival_anchor = q.copy()
        plan = planner.plan(np.asarray(plan_hist), [], goal_fn, map_fn, clearance_fn, prev=prev, guide_boxes=guide)
        latency = time.perf_counter() - tp
        anchor = (plan, anchor_at, np.asarray(plan_hist[-1], dtype=np.float64).copy(), flow.feed.finite_difference_dq(plan_hist))
        S['last_request'] = tick
        row = {'tick': tick, 'walk': leg['index'], 'waypoint_xy': np.asarray(wp).tolist(), 'route_remaining_m': float(remaining),
               'rule': plan['rule'], 'chosen_clearance_m': float(plan['chosen_clearance_m']), 'latency_s': latency,
               'plan_xy': _r(np, plan['qpos'][:, :2], 3), 'plan_root_z': _r(np, plan['qpos'][:, 2], 3)}
        plans.append(row)
        leg['plans'] += 1
        event('replan', plan['rule'], latency_ms=latency * 1000)
        if lat_ticks == 0 or first:
            S['active'] = anchor
            S['executing'] = (len(plans) - 1, tick)
            executing_starts.append((tick, len(plans) - 1))
        else:
            S['pending'].append((tick + lat_ticks, len(plans) - 1) + anchor)

    def finish_settle():
        """After a stand: once settled, pause and close the walk."""
        if S['stand_tick'] is None or S['pending_stand'] is not None:
            return
        if (S['tick'] - S['stand_tick']) * DT < SETTLE_S + 0.5:
            return
        speed = math.hypot(*frames[-1]['post_action']['root_linear_velocity_w'][:2]) if frames else 0.0
        if speed > 0.1 and (S['tick'] - S['stand_tick']) * DT < SETTLE_S + HOLD_S:
            return
        if S['leg']:
            outcome = 'arrived' if S['leg'].get('arrived_tick') is not None else 'stopped'
            end_leg(outcome, S['leg'].get('stop_reason'))
        S['paused'] = True
        S['stand_tick'] = None
        S['route'] = S['goal_fn'] = None
        snapshot(force=True)
        event('waiting', 'standing; waiting for the operator')

    # The standing pose before the first simulated tick: shown live, never recorded as a control frame.
    initial_frame = {'time': 0.0, 'sequence': -1, 'source_time': 0.0, 'source_clock_domain': 'simulation',
                     'receipt_time': time.monotonic(), 'receipt_clock_domain': 'host-monotonic', 'sim_time': 0.0,
                     'position': _r(np, start_q[:3]), 'quaternion_wxyz': _r(np, start_q[3:7], 5), 'joints': _r(np, start_q[7:]),
                     'qpos': _r(np, start_q, 5), 'classification': 'simulator-ground-truth', 'validity': 'valid', 'frame_id': 'world',
                     'estimate': {'position': _r(np, start_q[:3]), 'quaternion_wxyz': _r(np, start_q[3:7], 5), 'classification': 'estimated',
                                  'basis': ODOMETRY[req['odometry']]['label']},
                     'reference': None, 'plan': None, 'command': None,
                     'post_action': {'time': 0.0, 'qpos': _r(np, start_q, 5), 'root_linear_velocity_w': [0.0, 0.0, 0.0],
                                     'classification': 'simulator-ground-truth'},
                     'navigation': {'phase': 'WAIT', 'walk': None, 'goal_xy': None}, 'perception_index': 0,
                     'health': {'state_age_ms': 0, 'reference_age_ms': None, 'planner_latency_ms': None, 'contact_force_n': None,
                                'tilt_rad': 0.0, 'goal_dist_m': None, 'lowcmd_age_ms': None, 'gpu_utilization': None},
                     'note': 'Standing start before the first simulated tick'}

    # ---------------------------------------------------------------- start
    S['phase'] = 'WAIT'
    snapshot(force=True)
    if parity:
        # Rehearsal parity: goal and Go at t = 0 with the source pre-scan, as run_episode does.
        S['staged'] = {'xy': req['initial_goal'], 'frame_id': 'world', 'seq': 0, 'staged_at_s': 0.0}
        start_leg()
        S['paused'] = False
        begin_run()
    event('waiting' if not parity else 'run', 'standing; waiting for a goal' if not parity else 'initial goal (rehearsal parity)')
    publish(force=True)
    write_map(force=True)
    motion_wall_started = None
    S['motion_wall'] = 0.0

    while True:
        for cmd in read_inbox(inbox, S['last_seq']):
            S['last_seq'] = cmd['seq']
            if len(S['commands']) < MAX_COMMANDS:
                apply(cmd)
            publish(force=True)
        if S['ending'] and S['paused']:
            break
        if S['paused']:
            if motion_wall_started is not None:
                S['motion_wall'] += time.monotonic() - motion_wall_started
                motion_wall_started = None
            if time.monotonic() - S['last_command_wall'] > req['idle_timeout_s']:
                S['ending'], S['end_reason'] = True, f"idle for {req['idle_timeout_s']:.0f} s"
                break
            publish()
            time.sleep(0.05)
            continue
        if motion_wall_started is None:
            motion_wall_started = time.monotonic()
        tick = S['tick']
        meas = sim.measure()
        true_q = meas['qpos']
        q = estimate(true_q, DT)
        S['q'] = q
        history.append(q.astype(np.float32))
        del history[:-(planner.history + 2)]
        if estimate.cfg:
            memory.pose_error = tuple(estimate.err)
        memory.step(tick * DT, true_q[:3], true_q[3:7])
        while S['pending'] and tick >= S['pending'][0][0]:
            ready = S['pending'].pop(0)
            S['active'] = ready[2:]
            S['executing'] = (ready[1], tick)
            executing_starts.append((tick, ready[1]))
        w, x, y, z = true_q[3:7]
        tilt = math.acos(max(-1.0, min(1.0, 1 - 2 * (x * x + y * y))))
        leg = S['leg']
        if S['phase'] in ('PRESCAN', 'RUN') and (tilt > TILT_ESTOP_RAD or true_q[2] < MIN_PELVIS_Z_M):
            reason = f'tilt {tilt:.2f} rad > {TILT_ESTOP_RAD}' if tilt > TILT_ESTOP_RAD else f'pelvis {true_q[2]:.2f} m'
            event('estop', f'E-stop: {reason} (node supervisor; on the robot the runner switches to damping)', tilt=tilt)
            S['phase'], S['fallen'] = 'STOPPED', True
            end_leg('estop', reason)
            S['paused'] = True
            S['ending'], S['end_reason'] = True, 'E-stop: the robot fell or tilted past the supervisor limit'
            snapshot(force=True)
            continue
        if S['phase'] == 'PRESCAN' and tick >= S['prescan_until']:
            begin_run()
        if S['phase'] == 'RUN':
            dist = float(np.linalg.norm(q[:2] - np.asarray(S['goal']['xy'])))
            if dist <= req['goal_radius_m'] and not leg.get('first_plan_pending'):
                S['phase'] = 'ARRIVED'
                leg['arrived_tick'] = tick
                event('arrived', f'arrived ({dist:.2f} m from the goal)', dist=dist)
                stand('arrived')
            elif (tick - leg['start_tick']) * DT > req['leg_timeout_s']:
                S['phase'] = 'STOPPED'
                leg['stop_reason'] = f"walk timeout {req['leg_timeout_s']:.0f} s"
                stand('timeout')
            elif S['motion_ticks'] * DT >= req['max_motion_s']:
                S['phase'] = 'STOPPED'
                leg['stop_reason'] = 'session motion limit'
                S['ending'], S['end_reason'] = True, f"session motion limit {req['max_motion_s']:.0f} s"
                stand('session limit')
            elif S['pending_stand'] is None and not S['pending'] and (leg.get('first_plan_pending') or tick - S['last_request'] >= replan):
                request_plan(q, tick)
        if S['pending_stand'] is not None:
            stand(S['pending_stand'])
        plan, anchor_tick, anchor_q, anchor_dq = S['active']
        tgt, _ = flow.feed.target(plan, anchor_q, anchor_dq, tick - anchor_tick, q, limits)
        t = tick * DT
        tic = time.perf_counter()
        pos, quat, force, target = sim.step(tgt[:, :29], tgt[:, 29:58], tgt[:, 58:64])
        torque['tracker'].end_tick()
        interval = contact_interval(force, t, t + DT)
        post = sim.measure()
        reference = decode_reference(tgt, true_q)
        reference.pop('raw', None)
        for row in reference['window']:
            row.pop('velocity', None)
            for key in ('joints', 'position', 'quaternion_wxyz'):
                row[key] = _r(np, row[key])
        if plan.get('stand'):
            plan_view = {'time': anchor_tick * DT, 'age_s': (tick - anchor_tick) * DT, 'rule': 'stand', 'future': [],
                         'future_basis': 'settle-to-stand chunk (node.py stand)', 'latency_ms': None}
        elif S['executing'] is not None:
            index, start_tick = S['executing']
            row = plans[index]
            plan_view = dict(_plan(row, start_tick * DT, t), requested_at_s=row['tick'] * DT, executing_since_s=start_tick * DT,
                             walk=row['walk'])
        else:
            plan_view = None
        if leg is not None:
            if frames:
                leg['path_m'] += float(math.dist(frames[-1]['position'][:2], true_q[:2]))
            leg['max_contact_n'] = max(leg['max_contact_n'], interval['max_force_n'])
        if interval['max_force_n'] > 100 and (not frames or frames[-1]['health']['contact_force_n'] is None
                                               or frames[-1]['health']['contact_force_n'] <= 100):
            event('contact', f"obstacle contact {interval['max_force_n']:.0f} N", force_n=interval['max_force_n'])
        goal = S['goal'] or S['staged']
        frame = {'time': t, 'sequence': len(frames), 'source_time': t, 'source_clock_domain': 'simulation',
                 'receipt_time': time.monotonic(), 'receipt_clock_domain': 'host-monotonic', 'sim_time': t,
                 'position': _r(np, true_q[:3]), 'quaternion_wxyz': _r(np, true_q[3:7], 5), 'joints': _r(np, true_q[7:]),
                 'qpos': _r(np, true_q, 5), 'classification': 'simulator-ground-truth', 'validity': 'valid', 'frame_id': 'world',
                 'estimate': {'position': _r(np, q[:3]), 'quaternion_wxyz': _r(np, q[3:7], 5), 'classification': 'estimated',
                              'basis': ODOMETRY[req['odometry']]['label']},
                 'reference': reference, 'plan': plan_view,
                 'command': {'joints': _r(np, target), 'classification': 'commanded', 'kind': 'SONIC PD position targets',
                             'joint_order': 'named MuJoCo', 'hardware_command': False, 'time': t, 'units': 'rad'},
                 'imu': {'quaternion_wxyz': _r(np, true_q[3:7], 5), 'angular_velocity_rad_s': _r(np, meas['root_angular_velocity_b']),
                         'frame_id': 'pelvis', 'classification': 'simulator-ground-truth', 'linear_acceleration_m_s2': None},
                 'joint_velocity_rad_s': _r(np, meas['dq'], 3),
                 'post_action': {'time': t + DT, 'qpos': _r(np, post['qpos'], 5),
                                 'root_linear_velocity_w': _r(np, post['root_linear_velocity_w']),
                                 'contact': {k: interval[k] for k in ('start_s', 'end_s', 'max_force_n')},
                                 'classification': 'simulator-ground-truth'},
                 'navigation': {'phase': S['phase'], 'walk': leg['index'] if leg else None,
                                'goal_xy': goal['xy'] if goal else None},
                 'perception_index': len(perceptions) - 1 if perceptions else None,
                 'health': {'state_age_ms': 0, 'reference_age_ms': 0,
                            'planner_latency_ms': plan_view['latency_ms'] if plan_view else None,
                            'tracking_rmse_rad': float(np.sqrt(np.mean((true_q[7:] - tgt[0, :29]) ** 2))),
                            'command_tracking_rmse_rad': float(np.sqrt(np.mean((true_q[7:] - target) ** 2))),
                            'sonic_inference_ms': current['inference_ms'], 'control_step_wall_ms': (time.perf_counter() - tic) * 1000,
                            'contact_force_n': interval['max_force_n'], 'tilt_rad': tilt,
                            'goal_dist_m': None if goal is None else float(math.dist(q[:2], goal['xy'])),
                            'lowcmd_age_ms': None, 'gpu_utilization': None}}
        frames.append(frame)
        S['tick'] += 1
        S['motion_ticks'] += 1
        snapshot()
        if S['phase'] in ('ARRIVED', 'STOPPED'):
            finish_settle()
        publish()

    # ---------------------------------------------------------------- end of session
    if not frames:  # ended before any walk: the recording holds the standing pose, never an empty timeline
        frames.append(dict(initial_frame, sequence=0))
    if S['leg']:
        end_leg('session_end', S['end_reason'])
    write_map(force=True)
    final_map = output / 'memory-final.npz'
    if (output / 'memory.npz').is_file():
        final_map.write_bytes((output / 'memory.npz').read_bytes())
    S['phase'] = 'ENDED'
    event('ended', f"session ended: {S['end_reason']}")
    legs = [leg_dict(leg) for leg in S['legs']]
    report = {'outcome': 'session', 'walks': len(legs), 'arrived': sum(l['outcome'] == 'arrived' for l in legs),
              'legs': legs, 'motion_s': S['motion_ticks'] * DT, 'end_reason': S['end_reason'],
              'plan_latency_s': ({'p50': float(np.median([p['latency_s'] for p in plans])),
                                  'p95': float(np.quantile([p['latency_s'] for p in plans], 0.95))} if plans else None),
              'worker_real_time_factor': (S['motion_ticks'] * DT) / S['motion_wall'] if S['motion_wall'] else None,
              'torque': torque['tracker'].summary(contract.EFFORT_MJ), 'actuators': receipt,
              'elapsed_s': S['tick'] * DT}
    metadata.update(duration_s=max(DT, frames[-1]['time']), executed_sim_duration_s=S['tick'] * DT,
                    source_samples=len(frames), mode='replay', recording_complete=True, test_result=report,
                    navigation={'legs': legs, 'end_reason': S['end_reason'], 'goal_radius_m': req['goal_radius_m']})
    metadata['latency_model']['executing_plan_starts'] = executing_starts if lat_ticks else None
    metadata['provenance']['artifacts'].append(_hash(final_map)) if final_map.is_file() else None
    session = {'schema_version': 1, 'metadata': metadata, 'joint_names': list(contract.MJ_JOINTS), 'frames': frames,
               'events': S['events'], 'plans': plans,
               'environment': {'boxes': req['map']['boxes'], 'classification': 'simulator-ground-truth',
                               'identity_basis': 'Exact collision boxes of this simulation; the robot did not receive them',
                               'source': req['map']['id']},
               'perception': dict(S['perception'] or {'available': False}, kind='time-series', frames=perceptions, synchronized=True),
               'graph': _graph(True), 'trajectory': [f['position'] for f in frames]}
    session['graph']['dds_domain_note'] = 'No DDS participant exists in this in-process CPU simulation.'
    _atomic(output / 'session.json', session)
    _atomic(output / 'result.json', {'schema_version': 1, 'status': 'completed', 'report': report, 'recording_complete': True,
                                     'error': None, 'wall_time_s': time.monotonic() - started,
                                     'session_path': str(output / 'session.json'), 'hardware_enabled': False, 'dds_participants': 0})
    publish('completed', force=True)
    return report


def main(argv=None):
    import faulthandler
    faulthandler.enable()
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--request', required=True)
    ap.add_argument('--output', required=True)
    args = ap.parse_args(argv)
    execute(json.loads(Path(args.request).read_text()), args.output)
    return 0


def run_cli():
    import traceback
    try:
        code = main()
    except BaseException:
        traceback.print_exc()
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)  # native runtimes can hang in interpreter teardown; every recording write is closed


if __name__ == '__main__':
    run_cli()
