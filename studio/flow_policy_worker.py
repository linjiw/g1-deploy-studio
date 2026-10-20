"""Owned CPU rehearsal of a pinned Flow research block (WX-RF) on MuJoCo + SONIC ONNX.

Runs Flow's own closed-loop callback (``FlowClosedLoopCallback.run``) from a
hash-verified source snapshot with a minimal fake Isaac environment whose
``step`` executes the callback's (10, 67) SONIC reference in g1-student-deploy's
MuJoCo ``Physics``. Every route, tight-mode, gate-side and execution-check rule
is unmodified Flow code. No Isaac/Omniverse module, DDS/ZMQ participant, GPU
or hardware path is used. Reference repositories and checkpoints are read-only.

The block is *privileged*: its map, selection, guidance, execution check and
route consume the exact configured boxes (simulator ground truth), not LiDAR.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time

from studio.policy_worker import (CRITERIA, MAX_DURATION_S, TorqueTracker, _atomic, _hash, contact_interval,
                                  executed_native_recording, task_thresholds, validate_request)
from studio.policy_bundle import bundle_path, load_manifest, verify

DEPLOY = Path('/home/linjiw/code/g1-student-deploy')
LFH_PARENT = Path('/home/linjiw/flow/.bridge-deps')  # humanoid_lfh symlink to the pinned bridge worktree
BACKEND_ID = 'flow-wx-sonic-mujoco-cpu'
DT = 0.02


class Stub:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def prepare_callback_config(cfg, arm, seed, output, task_path, task_id, overrides):
    """Mirror Flow closed_loop/runner.py prepare() for one episode (pinned snapshot semantics).

    Arm-level keys override config-level keys exactly as the runner does; Studio only
    adds its CPU/budget overrides on top of the merged planner block.
    """
    planner = dict(cfg.get('planner_defaults', {}), **arm['planner'])
    planner['seed'] = seed
    if xfit := planner.pop('exec_model_xfit', None):
        import zlib
        planner['exec_model'] = xfit[zlib.crc32(str(task_id).encode()) % 2]
        planner['exec_model_xfit_note'] = 'Studio fold parity: crc32(task id); Flow uses task_fold()'
    planner.update(overrides)
    get = lambda key, default=None: arm.get(key, cfg.get(key, default))
    cb = {'output': str(output), 'task_path': str(task_path), 'seed': seed, 'planner': planner,
          'replan_ticks': get('replan_ticks', 8), 'goal_lookahead_m': get('goal_lookahead_m', 0.8),
          'route': get('route', {}), 'route_source': get('route_source', 'privileged'),
          'goal_heading': get('goal_heading', 'path'), 'steer_lookahead_m': get('steer_lookahead_m', 0.8),
          'turn_min_frac': get('turn_min_frac'), 'save_training_windows': cfg.get('save_training_windows', False),
          'sensor_prescan_s': get('sensor_prescan_s', 0.0),
          'initial_root_velocity_policy': cfg.get('initial_root_velocity_policy', 'recorded_world'),
          'initial_joint_velocity_policy': cfg.get('initial_joint_velocity_policy', 'source'),
          'perturb': get('perturb'), 'branch': get('branch'), 'tight': get('tight')}
    if get('deterministic'):
        cb['deterministic'] = True
    for key in ('route_extent', 'goal_on_route', 'gate_side', 'sensor_boxes'):
        if get(key) is not None:
            cb[key] = get(key)
    return cb


def _quantiles(values):
    import numpy as np
    return {'p50': float(np.median(values)), 'p95': float(np.quantile(values, .95))} if values else None


PREDICT_NEEDS_LATENCY = 'Predictive anchoring needs a planner latency of at least one 20 ms tick'


def latency_model(latency):
    """Recorded description of the latency model (metadata and report)."""
    ms = latency['ms']
    if latency['anchor'] != 'predict' or not ms:
        return {'ms': ms, 'anchor': 'measured',
                'implementation': 'Studio delayed execution around the Flow callback plan_target',
                'basis': ('Each plan is executed from request tick + latency; the previous plan keeps '
                          'driving SONIC meanwhile (pipelined). The callback still anchors its next '
                          'replan on the latest computed plan, so this approximates, not reproduces, '
                          'an asynchronous planner.') if ms else 'No latency: synchronous lockstep.'}
    return {'ms': ms, 'anchor': 'predict',
            'implementation': ('Studio delayed execution around the Flow callback plan_target, with predicted '
                               'planner inputs at the FlowPlanner.plan boundary (studio/latency_anchor.py; '
                               'method of g1-student-deploy g1deploy/latency.py). Flow code is unchanged.'),
            'basis': ('Each plan is executed from request tick + latency while the landed plan keeps driving SONIC '
                      '(pipelined on the callback cadence). The planner is given the state predicted at request tick + '
                      'latency: the landed plan continued past the request tick, re-posed (planar xy + yaw) onto the '
                      'measured pose at the request tick. The new plan is anchored and timestamped at request tick + '
                      'latency, so it starts at elapsed 0 when it lands. This approximates, not reproduces, an '
                      'asynchronous planner.'),
            'predicted': ['planner history frames after the request tick: root xy and yaw re-posed; root height, '
                          'roll/pitch and the 29 joint angles taken from the landed plan',
                          'everything the planner derives from that history: anchor pose, local goal and map frame, '
                          'encoded velocities, arm start posture, WM-v2 execution-check start state',
                          'the new plan\'s anchor state, finite-difference joint velocity and anchor tick (request + latency)',
                          'the previous-plan offset passed as prev (inert for WX-RF: no retrieval, warm start, '
                          'continuation or execution guide)'],
            'measured': ['history frames at or before the request tick (none for WX-RF\'s 6-frame history once the '
                         'latency is 6 ticks or more; the measured pose then enters through the re-posing only)',
                         'route progress, route refresh and tight / gate-side mode selection (Flow callback code on '
                         'the measured pose at the request tick)',
                         'the SONIC reference at every executed tick, which is relative to the measured pelvis',
                         'physics, contacts, scoring and every recorded state'],
            'not_predicted': ('Tracking error, contacts and disturbances during the latency window. The prediction '
                              'assumes SONIC follows the landed plan from the measured pose.'),
            'prediction_source': ('The landed (executing) plan only. Requests still in flight are never used; on '
                                  'hardware they would not have arrived (g1-student-deploy inflight > 1 semantics).'),
            'clock': ('Simulation control ticks of 20 ms. Request tick r is the plans.json tick; the anchor and landing '
                      'tick is r + latency; plan frame i is the state at tick r + latency + i + 1. Planner wall time '
                      'is host-measured and does not delay simulated time.')}


def execute(request, output):
    req = validate_request(request)
    if req['policy']['loader'] != 'flow-callback':
        raise ValueError('This worker runs only pinned Flow callback bundles')
    if req['latency']['anchor'] == 'predict' and not req['latency']['ms']:
        raise ValueError(PREDICT_NEEDS_LATENCY)
    root = bundle_path(req['policy']['bundle_id'])
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    _atomic(output / 'request.json', req)
    started = time.monotonic()
    _atomic(output / 'latest.json', {'schema_version': 1, 'status': 'initializing', 'frame': None,
                                     'progress': {'simulation_time_s': 0, 'wall_time_s': 0, 'requested_duration_s': req['duration_s']}})
    try:
        problems = verify(root)
        if problems:
            raise ValueError('Policy bundle failed verification: ' + '; '.join(problems)[:1500])
        manifest = load_manifest(root)
        os.environ['CUDA_VISIBLE_DEVICES'] = ''
        for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
            os.environ[name] = '2'
        sys.dont_write_bytecode = True
        if (LFH_PARENT / 'humanoid_lfh').resolve() != Path(manifest['humanoid_lfh']['path']):
            raise ValueError('humanoid_lfh bridge no longer points at the pinned worktree')
        # The snapshot first: no other motion2scene_flow copy may be imported.
        sys.path[:0] = [str(root / 'src'), str(LFH_PARENT), str(DEPLOY)]
        import numpy as np
        import onnxruntime as ort
        ort.disable_telemetry_events()
        import torch
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        import humanoid_lfh.native_closed_loop as ncl
        from humanoid_lfh.native_g1 import SCHEMA_VERSION
        from humanoid_lfh.sonic_reference import pack_sonic_joint_reference, sonic_reference_time_offsets
        import motion2scene_flow
        from motion2scene_flow.closed_loop import callback as cbm, planner as plm, sensor_map
        from g1deploy import contract as C
        from sim.episode import Physics, stand_start_state
        import sim.episode as episode_module
        from studio.replay import decode_reference, load_session, _plan, _git_provenance
        from studio.pipeline import PipelineRecorder, contract as pipeline_contract, SONIC_SAMPLE_EVERY, jsonable
        from studio.latency_anchor import DelayedPlans, anchor_error, summarize_errors
        if not Path(motion2scene_flow.__file__).resolve().is_relative_to((root / 'src').resolve()):
            raise RuntimeError(f'motion2scene_flow resolved outside the pinned snapshot: {motion2scene_flow.__file__}')
        for forbidden in ('g1deploy.bundle', 'g1deploy.perception.cloud_memory', 'sim.fastplan', 'isaaclab', 'omni'):
            if forbidden in sys.modules:
                raise RuntimeError(f'{forbidden} must not be imported by the Flow callback worker')
        plm.FLOW_ROOT = root
        sensor_map.NEWTON = manifest['deploy']['newton']
        if tuple(C.MJ_JOINTS) != tuple(plm.JOINT_NAMES):
            raise RuntimeError('MuJoCo joint order differs from the Flow planner joint order')

        boxes = req['map']['boxes']
        _atomic(output / 'boxes.json', boxes)
        contract_path = DEPLOY / 'bundle/config/sonic_model_contract.json'
        s = stand_start_state(req['start_xy'], req['start_yaw_rad'])
        record_meta = {'schema_version': SCHEMA_VERSION, 'source_id': 'studio-stand', 'source_path': str(output / 'stand.npz'),
                       'source_sha256': '0' * 64, 'state_source': 'sim.episode.stand_start_state (g1-student-deploy)',
                       'timebase': {'source': 'synthetic'}, 'joint_velocity_source': 'zero', 'quaternion_order': 'wxyz',
                       'units': {'length': 'm', 'angle': 'rad', 'time': 's'}, 'up_axis': 'z', 'model_binding': str(contract_path)}
        np.savez(output / 'stand.npz', timestamps_s=np.array([0.0, DT]), root_position_m=np.stack([s['pos']] * 2),
                 root_quaternion_wxyz=np.stack([s['quat']] * 2), joint_positions_rad=np.stack([s['q']] * 2),
                 joint_velocities_rad_s=np.stack([s['dq']] * 2), root_linear_velocity_w=np.zeros((2, 3)),
                 root_angular_velocity_w=np.zeros((2, 3)), joint_names=np.asarray(C.MJ_JOINTS),
                 model_contract_json=np.asarray(contract_path.read_text()), metadata_json=np.asarray(json.dumps(record_meta)))
        task = {'task_id': req['id'], 'scenario_id': req['id'], 'family': 'studio-user-configured',
                'model_contract_path': str(contract_path), 'initial_state_record': str(output / 'stand.npz'),
                'initial_frame': 0, 'ground_z_m': 0.0, 'goal_world_xy': req['goal_xy'], 'deadline_s': req['duration_s'],
                **task_thresholds(req['criterion']), 'scene_boxes_world': boxes,
                'obstacle_prim_paths': [f'/World/box{i}' for i in range(len(boxes))]}
        _atomic(output / 'task.json', task)
        config = json.loads((root / 'config.json').read_text())
        arm = next(a for a in config['arms'] if a['name'] == manifest['flow']['arm'])
        callback_cfg = prepare_callback_config(
            config, arm, req['seed'], output / 'native', output / 'task.json', req['id'],
            dict(manifest.get('planner_overrides', {}), candidates=req['planner']['candidates'], ode_steps=req['planner']['ode_steps']))
        planner_cfg = callback_cfg['planner']
        _atomic(output / 'callback_config.json', callback_cfg)

        pipeline = PipelineRecorder()
        sim = Physics(boxes, DEPLOY / 'bundle/sonic/sonic_release_g1.onnx')
        torque = TorqueTracker(np, sim.model, C.MJ_JOINTS)
        original_pd_torque = episode_module.pd_torque

        def observed_pd_torque(*args, **kwargs):
            result = original_pd_torque(*args, **kwargs)
            torque.observe(result)
            return result
        episode_module.pd_torque = observed_pd_torque
        frames, plans, contact_intervals, events = [], [], [], []
        physics_positions, physics_quaternions = [], []
        current = {'tgt': None, 'plan': None, 'inference_ms': None, 'sonic_sample': None, 'last_write': -math.inf}
        progress_log = (output / 'progress.jsonl').open('w', buffering=1)
        model_identity = _hash(DEPLOY / 'sim/assets/g1_29dof.xml')
        checkout = _git_provenance(DEPLOY)
        checkout['recording_revision'] = checkout['head_at_read']
        profile = {'id': req['policy']['id'], 'label': manifest['label'], 'research_block': manifest['research_block'],
                   'variant': manifest['variant'], 'revision': manifest['flow']['commit'],
                   'adopted_commit': manifest['flow']['adopted_commit'], 'pin_basis': manifest['flow']['pin_basis'],
                   'config_path': manifest['flow']['config_path'], 'config_sha256': manifest['flow']['config_sha256'],
                   'arm': manifest['flow']['arm'], 'bundle_id': manifest['id'],
                   'identity_sha256': req['policy'].get('identity_sha256'), 'loader': 'flow-callback',
                   'deployed_budget': manifest['deployed_budget']}
        limitations = list(manifest['caveats']) + [
            'Fresh in-process CPU MuJoCo + SONIC ONNX execution of the Flow callback; not a C++/DDS or real-time deployment validation.',
            f"Planner budget K{req['planner']['candidates']}/ODE{req['planner']['ode_steps']}"
            + ('' if req['planner'] == manifest['deployed_budget'] else f" differs from the evaluated {manifest['deployed_budget']['candidates']}/{manifest['deployed_budget']['ode_steps']}") + '.',
            f"Success criterion: {CRITERIA[req['criterion']]['label']}.",
            'No simulated LiDAR is generated for this privileged block; perception views are unavailable by design.']
        predict = req['latency']['anchor'] == 'predict' and bool(req['latency']['ms'])
        if predict:
            limitations.append(
                f"Predictive anchoring (L2≈ predict, {req['latency']['ms']} ms) is a Studio deployment adapter, not Flow code. "
                'The planner receives the history predicted from the landed plan (g1-student-deploy method), while route '
                'progress and tight / gate-side decisions stay on the measured pose at the request tick. Flow evaluated '
                'WX synchronously, so this strategy is untested on the research side.')
        metadata = {'id': req['id'], 'title': f"Fresh {manifest['research_block']}-RF Flow + SONIC CPU rehearsal", 'mode': 'simulation',
                    'recording_kind': 'sonic-mujoco-lockstep', 'backend_id': 'sonic', 'source_backend': BACKEND_ID,
                    'model_path': str(DEPLOY / 'sim/assets/g1_29dof.xml'), 'model_variant': 'G1 29 DoF · rubber hands',
                    'duration_s': req['duration_s'], 'source_time_origin': 0, 'source_path': str(output),
                    'clock_domain': 'simulation', 'frame_id': 'world', 'quaternion_convention': 'wxyz',
                    'goal_xy': list(req['goal_xy']), 'start_xy': list(req['start_xy']), 'start_yaw_rad': req['start_yaw_rad'],
                    'navigation_criteria': dict(task_thresholds(req['criterion']), criterion=req['criterion'], label=CRITERIA[req['criterion']]['label']),
                    'units': {'position': 'm', 'joint': 'rad', 'time': 's'},
                    'hardware_validated': False, 'command_path_enabled': False, 'fixture': False,
                    'policy_identity': f"Flow {manifest['variant']} · teacher {Path(arm['planner']['run']).name} · WM-v2 exec check @ {manifest['flow']['commit'][:7]} + SONIC ONNX · CPU",
                    'policy_profile': profile, 'privileged_map': True,
                    'policy_hash_at_recording': next(f['sha256'] for f in manifest['deploy']['files'] if f['path'].endswith('.onnx')),
                    'recorded_model_hash': model_identity['sha256'],
                    'planner_configuration': dict(planner_cfg, implementation='flow-callback (privileged boxes)',
                                                  route_source=callback_cfg['route_source'], route=callback_cfg['route'],
                                                  tight=callback_cfg['tight'], gate_side=callback_cfg.get('gate_side'),
                                                  replan_ticks=callback_cfg['replan_ticks'],
                                                  goal_lookahead_m=callback_cfg['goal_lookahead_m'], start='stand'),
                    'control_contract': {'joint_names': list(C.MJ_JOINTS), 'kp_nm_per_rad': C.KP_MJ.tolist(),
                                         'kd_nm_per_rad_s': C.KD_MJ.tolist(), 'effort_limit_nm': C.EFFORT_MJ.tolist(),
                                         'control_dt_s': C.DT, 'physics_dt_s': C.SIM_DT,
                                         'command_kind': 'PD position target; source applies clipped PD torques internally'},
                    'calibration_identity': 'Not applicable: privileged block consumes no simulated sensor',
                    'fidelity': 'L2-approx' if req['latency']['ms'] else 'L1',
                    'latency_model': latency_model(req['latency']),
                    'pipeline_contract': pipeline_contract(DEPLOY / 'g1deploy/sonic.py', C),
                    'provenance': {'artifacts': [_hash(root / 'manifest.json'), _hash(root / 'config.json'), _hash(Path(__file__)),
                                                 _hash(Path(__file__).with_name('latency_anchor.py'))]
                                   + [{k: a[k] for k in ('path', 'sha256', 'bytes')} for a in manifest['artifacts'] + manifest['humanoid_lfh']['files'] + manifest['deploy']['files']],
                                   'model_at_recording': model_identity, 'repositories': [checkout,
                                       {'path': manifest['flow']['repo'], 'head_at_read': manifest['flow']['commit'], 'dirty_at_read': False,
                                        'recording_revision': manifest['flow']['commit'], 'note': 'Pinned git-archive snapshot; Flow working tree not used'}],
                                   'adapter': 'studio.flow_policy_worker.v1', 'policy_bundle': manifest['id']},
                    'limitations': limitations}

        def publish(frame=None, status='running', force=False):
            now = time.monotonic()
            if not force and now - current['last_write'] < .1:
                return
            current['last_write'] = now
            sim_t = frame['time'] if frame else 0
            live = dict(frame, pipeline={'schema_version': 1, 'flow_index': 0 if pipeline.flow_samples else None,
                                         'sonic_index': 0 if pipeline.sonic_samples else None}) if frame else None
            _atomic(output / 'latest.json', {
                'schema_version': 1, 'status': status, 'frame': live, 'metadata': metadata,
                'pipeline': pipeline.data(latest=True), 'joint_names': list(C.MJ_JOINTS),
                'perception': {'available': False, 'reason': 'Privileged WX block: planner consumes exact boxes; no simulated LiDAR in this run.'},
                'environment': {'boxes': boxes, 'classification': 'simulator-ground-truth', 'source': str(output / 'boxes.json')},
                'progress': {'simulation_time_s': sim_t, 'wall_time_s': now - started, 'real_time_factor': sim_t / max(1e-9, now - started),
                             'frames': len(frames), 'requested_duration_s': req['duration_s']}})

        # SONIC timing + bounded tensor samples on the same tracker the callback drives.
        original_policy = sim.tracker.policy
        output_name = sim.tracker.session.get_outputs()[0].name
        sig = lambda xs: [{'name': x.name, 'shape': x.shape, 'type': x.type} for x in xs]
        metadata['pipeline_contract'].update(
            flow_engine='pytorch-eager (Flow callback snapshot)',
            map_note='Privileged WX block: conditioning maps are computed from the exact configured boxes '
                     '(simulator ground truth), not from sensed LiDAR. Unknown-cell defaults do not apply here.')
        metadata['pipeline_contract']['onnx_inputs'] = sig(sim.tracker.session.get_inputs())
        metadata['pipeline_contract']['onnx_outputs'] = sig(sim.tracker.session.get_outputs())

        def timed_policy(obs):
            tic = time.perf_counter()
            result = original_policy(obs)
            current['inference_ms'] = (time.perf_counter() - tic) * 1000
            current['sonic_sample'] = pipeline.sonic(len(frames), DT, obs, result, current['inference_ms'],
                                                     sim.tracker.input_name, output_name)
            return result
        sim.tracker.policy = timed_policy

        # ---- Minimal fake Isaac env: writes reset MuJoCo; step executes the reference.
        z = lambda *shape: torch.zeros(*shape, dtype=torch.float32)
        data = Stub(root_pos_w=z(1, 3), root_quat_w=z(1, 4), root_lin_vel_w=z(1, 3), root_ang_vel_w=z(1, 3),
                    joint_pos=z(1, 29), joint_vel=z(1, 29), root_vel_w=z(1, 6))
        pending = {}

        def sync():
            m = sim.measure()
            q = m['qpos']
            data.root_pos_w[0] = torch.tensor(q[:3]); data.root_quat_w[0] = torch.tensor(q[3:7])
            data.root_lin_vel_w[0] = torch.tensor(m['root_linear_velocity_w']); data.root_ang_vel_w[0] = torch.tensor(m['root_angular_velocity_w'])
            data.root_vel_w[0, :3], data.root_vel_w[0, 3:] = data.root_lin_vel_w[0], data.root_ang_vel_w[0]
            data.joint_pos[0] = torch.tensor(q[7:]); data.joint_vel[0] = torch.tensor(m['dq'])

        def forward():
            r = pending['root']
            sim.reset(dict(pos=r[:3], quat=r[3:7], lin=r[7:10], ang=r[10:13], q=pending['q'], dq=pending['dq']))
            sync()

        robot = Stub(joint_names=list(plm.JOINT_NAMES), body_names=['pelvis'], data=data,
                     write_root_state_to_sim=lambda root_state: pending.__setitem__('root', root_state.detach().cpu().double().numpy()[0]),
                     write_joint_state_to_sim=lambda p, v: pending.update(q=p.detach().cpu().double().numpy()[0], dq=v.detach().cpu().double().numpy()[0]),
                     write_root_velocity_to_sim=lambda v: None)
        capture = dict(mode='legacy', obstacle_paths=list(task['obstacle_prim_paths']), positions=[], quaternions=[],
                       contact_forces=[], reset_events=[], body_names=['robot'], active=False, device_samples=[])
        dones = torch.zeros(1, dtype=torch.bool)
        zero = np.zeros((10, 29), dtype=np.float32)
        packed = int(np.asarray(pack_sonic_joint_reference(zero, zero, tuple(plm.JOINT_NAMES), time_offsets_s=sonic_reference_time_offsets())).size)
        token_dim = packed + 60 + 3
        scene = Stub(robot=robot, env_origins=torch.zeros(1, 3), update=lambda dt: None)
        scene.__class__.__getitem__ = lambda self, key: self.robot
        raw = Stub(_native_closed_loop_capture=capture, scene=scene, step_dt=DT, physics_dt=0.005, sim=Stub(forward=forward),
                   observation_manager=Stub(reset=lambda: None, compute=lambda update_history=True: None, _group_obs_term_names={'policy': []}),
                   command_manager=Stub(get_term=lambda name: Stub(_update_command=lambda: None)),
                   termination_manager=Stub(compute=lambda: dones, _terminated_buf=dones.clone(), _truncated_buf=dones.clone(),
                                            _term_dones=dones.clone(), dones=dones),
                   reset_terminated=dones.clone(), reset_time_outs=dones.clone(), device='cpu')
        module = Stub(tokenizer_obs_names=['command_multi_future_nonflat', 'motion_anchor_ori_b_mf_nonflat', 'encoder_index'],
                      tokenizer_obs_dims={'command_multi_future_nonflat': [packed], 'motion_anchor_ori_b_mf_nonflat': [60], 'encoder_index': [3]})
        actor = Stub(eval_mode=lambda: None, init_rollout=lambda: None, actor_module=module, action_mean=torch.zeros(1, 29),
                     rollout=lambda obs_dict: {'obs_dict': obs_dict})

        def env_step(actor_state):
            tgt = current['tgt']
            if tgt is None:
                raise RuntimeError('Callback stepped without a planned SONIC reference')
            measured = sim.measure()
            q = measured['qpos']
            t = len(frames) * DT
            current['sonic_sample'] = None
            tic = time.perf_counter()
            pos, quat, force, target = sim.step(tgt[:, :29], tgt[:, 29:58], tgt[:, 58:64])
            step_ms = (time.perf_counter() - tic) * 1000
            torque.end_tick()
            for p_, q_, f_ in zip(pos, quat, force):
                capture['positions'].append(np.asarray(p_, dtype=np.float64))
                capture['quaternions'].append(np.asarray(q_, dtype=np.float64))
                capture['contact_forces'].append(np.array([[[float(f_), 0.0, 0.0]]]))  # max obstacle normal force, N
            interval = contact_interval(force, t, t + DT)
            previous = contact_intervals[-1] if contact_intervals else None
            contact_intervals.append(interval)
            physics_positions.append(np.asarray(pos).copy()); physics_quaternions.append(np.asarray(quat).copy())
            sync()
            post = sim.measure()
            reference = decode_reference(tgt, q)
            plan = _plan(current['plan'], current['plan']['tick'] * DT, t) if current['plan'] else None
            if current['sonic_sample'] is not None:
                current['sonic_sample'].update(target_joints_rad=np.asarray(target).tolist(), reference=np.asarray(tgt).tolist())
            frame = {'time': t, 'sequence': len(frames), 'source_time': t, 'source_clock_domain': 'simulation',
                     'receipt_time': time.monotonic(), 'receipt_clock_domain': 'host-monotonic', 'sim_time': t,
                     'position': q[:3].tolist(), 'quaternion_wxyz': q[3:7].tolist(), 'joints': q[7:].tolist(), 'qpos': q.tolist(),
                     'classification': 'simulator-ground-truth', 'validity': 'valid', 'frame_id': 'world',
                     'reference': reference, 'plan': plan, 'pipeline': pipeline.indices(),
                     'command': {'joints': np.asarray(target).tolist(), 'classification': 'commanded', 'kind': 'SONIC PD position targets',
                                 'joint_order': 'named MuJoCo', 'hardware_command': False, 'time': t, 'units': 'rad'},
                     'imu': {'quaternion_wxyz': q[3:7].tolist(), 'angular_velocity_rad_s': measured['root_angular_velocity_b'].tolist(),
                             'frame_id': 'pelvis', 'classification': 'simulator-ground-truth', 'linear_acceleration_m_s2': None},
                     'joint_velocity_rad_s': measured['dq'].tolist(),
                     'post_action': {'time': interval['end_s'], 'qpos': post['qpos'].tolist(),
                                     'root_linear_velocity_w': post['root_linear_velocity_w'].tolist(), 'contact': interval,
                                     'classification': 'simulator-ground-truth'},
                     'perception_index': None,
                     'health': {'state_age_ms': 0, 'reference_age_ms': 0, 'planner_latency_ms': plan['latency_ms'] if plan else None,
                                'tracking_rmse_rad': float(np.sqrt(np.mean((q[7:] - tgt[0, :29]) ** 2))),
                                'command_tracking_rmse_rad': float(np.sqrt(np.mean((q[7:] - np.asarray(target)) ** 2))),
                                'sonic_inference_ms': current['inference_ms'], 'control_step_wall_ms': step_ms,
                                'contact_force_n': previous['max_force_n'] if previous else None, 'contact_interval': previous,
                                'lowcmd_age_ms': None, 'gpu_utilization': None}}
            frames.append(frame)
            progress_log.write(json.dumps({'time': t, 'sequence': frame['sequence'], 'qpos': frame['qpos'], 'health': frame['health']}, allow_nan=False) + '\n')
            publish(frame)
            return {'tokenizer': torch.zeros(1, token_dim)}, None, torch.zeros(1, dtype=torch.bool), None

        env = Stub(num_envs=1, action_transform_module=None, env=raw, set_is_evaluating=lambda flag: None, reset_all=lambda: None,
                   process_raw_obs=lambda r, f: {'tokenizer': torch.zeros(1, token_dim)}, end_render_results=lambda: None, step=env_step)
        model = Stub(policy=actor, eval=lambda: None)
        # No released Isaac tracker module exists here; the fused ONNX contract is checked by Physics itself.
        ncl.validate_tracker_feature_contract = lambda module, names: 0
        original_target, original_make = cbm.plan_target, cbm.make_planner

        latency_ticks = int(round(req['latency']['ms'] / 1000 / DT))
        # Pipelined delayed execution (L2≈). With the predict anchor the planner is also given the
        # state predicted at request + latency from the landed plan (studio/latency_anchor.py).
        delayed = DelayedPlans(latency_ticks, req['latency']['anchor'] if predict else 'measured',
                               fd=cbm.finite_difference_dq)
        checked_landings = [0]

        def target_hook(plan, anchor_q, anchor_dq, elapsed, *rest, **kwargs):
            if latency_ticks:
                tick = len(frames)
                plan, anchor_q, anchor_dq, elapsed = delayed.target_args(plan, anchor_q, anchor_dq, elapsed, tick)
                if predict:
                    # A predicted plan lands at its anchor tick: compare the predicted anchor (estimated)
                    # with the measured pre-action state the callback holds at this tick (simulator truth).
                    for landed_tick, entry in delayed.landings[checked_landings[0]:]:
                        prediction = entry[4]
                        if prediction is not None and prediction.get('row') is not None:
                            prediction['row']['prediction_error'] = dict(
                                anchor_error(entry[1], rest[0]), tick=landed_tick,
                                classification='estimated anchor vs simulator-ground-truth pre-action state')
                    checked_landings[0] = len(delayed.landings)
            tgt, clamped = original_target(plan, anchor_q, anchor_dq, elapsed, *rest, **kwargs)
            projected = np.array(tgt, dtype=np.float64, copy=True)
            projected[:, 58:64] = ncl.project_rotation_6d(projected[:, 58:64])
            current['tgt'] = projected
            return tgt, clamped

        def make_hook(planner_dict):
            pcfg, planner = original_make(planner_dict)
            original_plan = planner.plan

            def observed_plan(*args, **kwargs):
                tick = len(frames)
                prediction = delayed.predict(args[0], tick) if predict else None
                if prediction is not None:
                    # Same call, with the history predicted at tick + latency and the landed plan as prev.
                    args = (prediction['history'],) + tuple(args[1:])
                    if kwargs.get('prev') is not None:
                        kwargs['prev'] = prediction['prev']
                capture_ok = hasattr(planner, 'model')
                if capture_ok and not getattr(pipeline, '_guarded', False):
                    unguarded = pipeline._forward

                    def guarded_forward(model, inputs, output):
                        try:
                            unguarded(model, inputs, output)
                        except Exception as error:  # never let telemetry alter or abort planning
                            events.append({'time': len(frames) * DT, 'type': 'telemetry',
                                           'message': f'Flow tensor capture skipped: {type(error).__name__}', 'source': 'studio'})
                    pipeline._forward = guarded_forward
                    pipeline._guarded = True
                if capture_ok:
                    try:
                        pipeline.begin_plan(planner, tick, DT)
                    except Exception as error:  # telemetry must never alter planning
                        capture_ok = False
                        events.append({'time': tick * DT, 'type': 'telemetry', 'message': f'Flow tensor capture disabled: {type(error).__name__}', 'source': 'studio'})
                tic = time.perf_counter()
                result = original_plan(*args, **kwargs)
                latency = time.perf_counter() - tic
                qpos = np.asarray(result['qpos'])
                row = {'tick': tick, 'latency_s': latency, 'rule': result.get('rule'),
                       'chosen_clearance_m': jsonable(float(result['chosen_clearance_m'])) if result.get('chosen_clearance_m') is not None else None,
                       'plan_xy': qpos[:, :2].tolist(), 'plan_root_z': qpos[:, 2].tolist(), 'waypoint_xy': None,
                       'route_remaining_m': None, 'exec_check': jsonable(result.get('exec_check'))}
                if prediction is not None:
                    delayed.bind(result)
                    row['anchor'] = {'mode': 'predict', 'request_tick': tick, 'anchor_tick': prediction['anchor_tick'],
                                     'predicted_from_plan_anchor_tick': prediction['source_anchor_tick'],
                                     'predicted_anchor_qpos': prediction['anchor_q'].tolist(),
                                     'classification': 'estimated (predicted from the landed plan)'}
                    prediction['row'] = row
                elif predict:
                    row['anchor'] = {'mode': 'measured', 'request_tick': tick, 'anchor_tick': tick,
                                     'reason': 'first plan: nothing has landed yet, so it is planned from the measured history and starts at once'}
                current['plan'] = row
                plans.append(row)
                if capture_ok:
                    try:
                        pipeline.end_plan(result, latency * 1000)
                    except Exception:
                        pipeline._plan = None
                events.append({'time': tick * DT, 'type': 'replan', 'message': str(result.get('rule')), 'source': 'FlowPlanner.plan',
                               'latency_ms': latency * 1000})
                return result
            planner.plan = observed_plan
            return pcfg, planner

        cbm.plan_target, cbm.make_planner = target_hook, make_hook
        publish(force=True)
        episode_error = None
        try:
            cbm.FlowClosedLoopCallback(output / 'callback_config.json').run(env, model)
        except Exception as exc:
            episode_error = exc
        finally:
            progress_log.close()
            pipeline.close()
        for forbidden in ('g1deploy.bundle', 'g1deploy.perception.cloud_memory', 'sim.fastplan', 'isaaclab', 'omni'):
            if forbidden in sys.modules:  # Flow imports lazily inside run(); re-check afterwards
                raise RuntimeError(f'{forbidden} was imported during the Flow callback run')
        native = output / 'native'
        episode_message = f'{type(episode_error).__name__}: {episode_error}' if episode_error else None
        if episode_error is not None:
            # Keep the real Flow error even if no replay can be decoded below.
            _atomic(output / 'episode_error.json', {'error': episode_message, 'executed_steps': len(frames)})
        if not (native / 'closed_loop.npz').is_file():
            raise RuntimeError(f'Flow callback produced no recording ({episode_message or "no error raised"})')
        score = json.loads((native / 'score.json').read_text()) if (native / 'score.json').is_file() else {}
        native_plans = json.loads((native / 'plans.json').read_text()) if (native / 'plans.json').is_file() else []
        np.savez_compressed(output / 'physics_observations.npz',
                            interval_start_s=[x['start_s'] for x in contact_intervals], interval_end_s=[x['end_s'] for x in contact_intervals],
                            obstacle_contact_n=[x['samples_n'] for x in contact_intervals],
                            root_positions_m=physics_positions, root_quaternions_wxyz=physics_quaternions,
                            peak_commanded_torque_nm=torque.rows, joint_names=list(C.MJ_JOINTS))
        _atomic(output / 'pipeline_observations.json', pipeline.data())
        # Flow appends the pre-action state before planning; an exception mid-tick leaves one
        # unmatched pre-state. Decode only actually executed rows (original NPZ preserved).
        try:
            native_path, extraction = executed_native_recording(output, len(frames)) if episode_error else (native, None)
            session = load_session(native_path, environment_path=output / 'boxes.json')
        except Exception as decode_error:
            raise RuntimeError(f'{episode_message or "Episode finished"}; replay decode failed: {type(decode_error).__name__}: {decode_error}') from decode_error
        # Independent decoder parity. The callback stores float32; compare at that precision.
        n = min(len(session['frames']), len(frames))
        if n == 0 or len(session['frames']) != len(frames):
            raise ValueError(f"Native recording frames {len(session['frames'])} disagree with observed physics steps {len(frames)}")
        qpos_error = float(np.max(np.abs(np.asarray([f['qpos'] for f in frames[:n]]) - np.asarray([f['qpos'] for f in session['frames'][:n]]))))
        reference_error = float(np.max(np.abs(np.asarray([f['reference']['raw'] for f in frames[:n]], dtype=np.float64)
                                              - np.asarray([f['reference']['raw'] for f in session['frames'][:n]], dtype=np.float64))))
        if qpos_error > 1e-4 or reference_error > 1e-4:
            raise ValueError(f'Observed state/reference disagree with native decoder (qpos {qpos_error:.2e}, reference {reference_error:.2e})')
        by_tick = {row.get('tick'): row for row in native_plans}
        anchors = {row['tick']: row['anchor'] for row in plans if row.get('anchor')}
        active = None
        for i, (frame, decoded) in enumerate(zip(frames[:n], session['frames'][:n])):
            if i in by_tick:
                active = by_tick[i]
            frame['plan'] = decoded['plan']
            if frame['plan'] is not None and active is not None:
                frame['plan'].update(jsonable({'exec_check': active.get('exec_check'), 'tight': active.get('tight'),
                                               'corridor_m': active.get('corridor_m'), 'gate_side_gap_m': active.get('gate_side_gap_m'),
                                               'candidate_clearance_m': active.get('clearance_m'), 'choice': active.get('choice')}))
                if predict and active.get('tick') in anchors:
                    anchor = anchors[active['tick']]
                    frame['plan'].update(anchor_mode=anchor['mode'], anchor_tick=anchor['anchor_tick'])
            frame['health']['planner_latency_ms'] = decoded['health']['planner_latency_ms']
        frames = frames[:n]
        prediction_report = None
        if predict:
            anchor_rows = [dict(row['anchor'], prediction_error=row.get('prediction_error')) for row in plans if row.get('anchor')]
            _atomic(output / 'latency_anchor.json', {'schema_version': 1, 'latency_ms': req['latency']['ms'],
                                                     'latency_ticks': latency_ticks, 'plans': jsonable(anchor_rows),
                                                     'clock_domain': 'simulation', 'tick_s': DT})
            prediction_report = dict(summarize_errors([row.get('prediction_error') for row in plans]) or {'landed_plans': 0},
                                     predicted_plans=sum(1 for row in anchor_rows if row['mode'] == 'predict'),
                                     basis=('Predicted planner anchor at request + latency (estimated) vs the measured '
                                            'pre-action state at the landing tick (simulator ground truth).'))
        latencies = [row['latency_s'] for row in plans]
        exec_rows = [row.get('exec_check') or {} for row in native_plans]
        report = {'outcome': score.get('outcome') or ('runtime_error' if episode_error else 'unknown'),
                  'completed': score.get('outcome') == 'goal_completion', 'control_steps': len(frames),
                  'elapsed_s': score.get('elapsed_s', len(frames) * DT),
                  'minimum_root_height_m': score.get('minimum_root_height_m'), 'maximum_root_tilt_rad': score.get('maximum_root_tilt_rad'),
                  'maximum_obstacle_contact_n': score.get('maximum_obstacle_contact_n'),
                  'final_goal_distance_xy_m': score.get('final_goal_distance_xy_m'), 'minimum_goal_distance_xy_m': score.get('minimum_goal_distance_xy_m'),
                  'first_goal_radius_entry_s': score.get('first_goal_radius_entry_s'),
                  'runtime_error': episode_message or score.get('runtime_error'),
                  'task_id': req['id'], 'family': 'studio-user-configured', 'seed': req['seed'], 'replans': len(native_plans),
                  'route_found': score.get('route_found'), 'plan_latency_s': _quantiles(latencies),
                  'selection_rules': score.get('selection_rules') or {r.get('rule'): sum(1 for x in native_plans if x.get('rule') == r.get('rule')) for r in native_plans},
                  'execution_check': {'checked_replans': sum(1 for e in exec_rows if e), 'ok': sum(1 for e in exec_rows if e.get('ok')),
                                      'max_tries': max((e.get('tries', 0) for e in exec_rows), default=None),
                                      'basis': 'WM-v2 (Isaac-trained) predicted execution, Flow exec_verify'},
                  'tight_replans': sum(1 for x in native_plans if x.get('tight')),
                  'sonic_inference_ms': _quantiles([f['health']['sonic_inference_ms'] for f in frames if f['health']['sonic_inference_ms'] is not None]),
                  'criterion': req['criterion'], 'scoring': score.get('scoring'),
                  'torque': torque.summary(C.EFFORT_MJ), 'latency_model': metadata['latency_model'],
                  'parity': {'max_qpos_abs_error': qpos_error, 'max_reference_abs_error': reference_error,
                             'kind': 'native-record round-trip / tick alignment',
                             'basis': ('Studio-observed states and references vs the callback NPZ decoded independently '
                                       '(float32 storage). Detects tick misalignment and decoder errors; it is not a '
                                       'fidelity comparison against an Isaac episode.')},
                  'worker_wall_to_summary_s': time.monotonic() - started, 'latency_s': req['latency']['ms'] / 1000,
                  'anchor_mode': ('predict (Studio delayed execution + predicted planner history)' if predict else
                                  'measured (Studio delayed execution)' if req['latency']['ms'] else 'synchronous lockstep')}
        if prediction_report is not None:
            report['anchor_prediction'] = prediction_report
        report['worker_real_time_factor'] = report['elapsed_s'] / max(1e-9, report['worker_wall_to_summary_s'])
        metadata.update(mode='replay', duration_s=frames[-1]['time'], executed_sim_duration_s=report['elapsed_s'],
                        source_samples=len(frames), recording_complete=episode_error is None, test_result=report)
        if episode_error:
            metadata.update(incomplete=True, termination_reason=report['runtime_error'], native_extraction=extraction)
            metadata['limitations'].append('Flow callback raised mid-episode. Only actually executed rows are shown; no motion is synthesised after the error.')
        metadata['provenance']['artifacts'] += [_hash(output / p) for p in ('task.json', 'boxes.json', 'callback_config.json', 'native/closed_loop.npz', 'native/plans.json', 'physics_observations.npz')
                                                + (('latency_anchor.json',) if predict else ())]
        session['frames'] = frames
        session['metadata'] = metadata
        session['pipeline'] = pipeline.data()
        session['perception'] = {'available': False, 'reason': 'Privileged WX block: the planner consumed the exact configured boxes. No simulated LiDAR was generated in this run.'}
        session['events'] = sorted(session.get('events', []) + [e for e in events if e['type'] != 'replan'], key=lambda e: e['time']) + [
            {'time': frames[-1]['time'], 'type': 'runtime_error' if episode_error else 'test_result',
             'message': report['runtime_error'] if episode_error else report['outcome'], 'source': 'Flow callback TaskScorer'}]
        session['graph']['dds_domain_note'] = 'No DDS participant exists in this in-process CPU rehearsal.'
        session['environment']['identity_basis'] = 'Exact collision boxes used by this fresh simulation; hash recorded'
        _atomic(output / 'session.json', session)
        status = 'failed' if episode_error else 'completed'
        _atomic(output / 'result.json', {'schema_version': 1, 'status': status, 'report': report, 'recording_complete': episode_error is None,
                                        'error': episode_message,
                                        'wall_time_s': time.monotonic() - started, 'session_path': str(output / 'session.json'),
                                        'hardware_enabled': False, 'dds_participants': 0, 'policy_bundle': manifest['id'],
                                        'record_round_trip': report['parity']['kind'],
                                        'native_extraction': extraction})
        publish(frames[-1], status=status, force=True)
        if episode_error:
            raise episode_error
        return report
    except BaseException as exc:
        if (output / 'result.json').is_file():
            raise
        error = {'schema_version': 1, 'status': 'failed', 'error': f'{type(exc).__name__}: {exc}',
                 'wall_time_s': time.monotonic() - started, 'hardware_enabled': False, 'recording_complete': False}
        _atomic(output / 'result.json', error)
        previous = json.loads((output / 'latest.json').read_text()) if (output / 'latest.json').is_file() else {}
        previous.update(status='failed', error=error['error'], recording_complete=False)
        _atomic(output / 'latest.json', previous)
        raise


def main(argv=None):
    import faulthandler
    faulthandler.enable()
    faulthandler.dump_traceback_later(120, repeat=True)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--request', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args(argv)
    if args.request.stat().st_size > 1024 * 1024:
        ap.error('request exceeds 1 MiB')
    request = json.loads(args.request.read_text())
    if request.get('duration_s', 0) > MAX_DURATION_S:
        ap.error('duration exceeds the bounded rehearsal limit')
    execute(request, args.output)


def run_cli():
    """Disposable process: exit without native interpreter teardown (see policy_worker.run_cli)."""
    import traceback
    code = 0
    try:
        main()
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except BaseException:
        traceback.print_exc()
        code = 1
    try:
        sys.stdout.flush(); sys.stderr.flush()
    except Exception:
        code = 1
    os._exit(code)


if __name__ == '__main__':
    run_cli()
