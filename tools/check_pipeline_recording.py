#!/usr/bin/env python3
"""Read-only native/source parity for one explicitly selected CPU recording.

No rollout, hardware, middleware, or sealed data discovery. --replay-onnx makes
three extra read-only CPU inferences on recorded inputs, outside any controller.
"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
from pathlib import Path
import sys

import numpy as np


def verify(path, *, replay_onnx=False):
    path = Path(path).resolve()
    run = path.parent
    session = json.loads(path.read_text())
    frames, metadata, pipeline = session['frames'], session['metadata'], session['pipeline']
    assert metadata['command_path_enabled'] is False and metadata['hardware_validated'] is False
    source = Path(metadata['pipeline_contract']['source']).parent.parent
    # Bind the source builders used for this audit to recording-time fingerprints.
    artifacts = {x['path']: x for x in metadata['provenance']['artifacts']}
    for relative in ('g1deploy/contract.py', 'g1deploy/sonic.py', 'g1deploy/scoring.py'):
        filename = str(source/relative)
        assert hashlib.sha256(Path(filename).read_bytes()).hexdigest() == artifacts[filename]['sha256']
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(source))
    from g1deploy import contract as C
    from g1deploy.sonic import SonicTracker, pd_torque
    from g1deploy.scoring import TaskScorer
    checks = []

    def check(name, fn):
        fn()
        checks.append(name)

    with np.load(run/'native/closed_loop.npz', allow_pickle=False) as native:
        check('native_pre_state_exact', lambda: np.testing.assert_array_equal([f['qpos'] for f in frames], native['pre_action_qpos']))
        check('native_post_state_exact', lambda: np.testing.assert_array_equal([f['post_action']['qpos'] for f in frames], native['realized_qpos']))
        check('native_reference_exact', lambda: np.testing.assert_array_equal([f['reference']['raw'] for f in frames], native['references']))
    native_plans = json.loads((run/'native/plans.json').read_text())
    check('flow_sample_count', lambda: np.testing.assert_equal(len(native_plans), len(pipeline['flow_samples'])))
    for captured, native in zip(pipeline['flow_samples'], native_plans):
        assert captured['sequence'] == native['tick']
        assert captured['source_time'] == native['tick']*C.DT
        assert captured['selected']['rule'] == native['rule']
        np.testing.assert_array_equal(captured['selected']['plan_xy'], native['plan_xy'])
        # Actual first forward is retained when model sampling ran; a future
        # source fallback may skip it explicitly, never manufacture a tensor.
        if captured['forward_calls']:
            assert np.asarray(captured['conditioning']['map']).shape == (3, 31, 61)
            names = {x['name']: x for x in captured['input_tensors']}
            assert names['map']['shape'][1:] == [3, 31, 61]
            assert names['history']['shape'][-1] == 65
            assert captured['output_tensor']['shape'][-1] == 65
    checks.append('all_flow_samples_match_native_selected_plans_and_actual_shapes')
    samples = {s['sequence']: s for s in pipeline['sonic_samples']}
    assert sorted(samples) == list(range(0, len(frames), 5))
    tracker = SonicTracker.__new__(SonicTracker)
    tracker.hist = {k: deque(maxlen=10) for k in ('ang_vel', 'joint_pos', 'joint_vel', 'action', 'gravity')}
    tracker.last_action = np.zeros(29)
    scorer = TaskScorer(json.loads((run/'task.json').read_text()))
    scorer_rows = json.loads((run/'scorer_observations.json').read_text())
    assert len(scorer_rows) == len(frames)
    sampled = 0
    with np.load(run/'physics_observations.npz', allow_pickle=False) as physics:
        for i, f in enumerate(frames):
            assert f['sequence'] == i and f['time'] == i*C.DT
            ref = np.asarray(f['reference']['raw'])
            cur = SonicTracker.proprio(f['quaternion_wxyz'], f['imu']['angular_velocity_rad_s'],
                                       f['joints'], f['joint_velocity_rad_s'])
            obs = tracker.observation(cur, ref[:, :29], ref[:, 29:58], ref[:, 58:64]).astype(np.float32)
            # Recover exactly the float32 previous action from the invertible
            # recorded target transform, then compare to captured outputs at
            # sampled ticks. This does NOT execute policy inference.
            target = np.asarray(f['command']['joints'])
            action = C.mj_to_isaac((target-C.DEFAULT_MJ)/C.ACTION_SCALE_MJ).astype(np.float32)
            if i in samples:
                sample = samples[i]
                assert sample['source_time'] == f['time']
                np.testing.assert_array_equal(sample['input']['values'], obs)
                np.testing.assert_array_equal(sample['output']['values'], action)
                np.testing.assert_array_equal(sample['target_joints_rad'], target)
                np.testing.assert_array_equal(sample['reference'], ref)
                np.testing.assert_array_equal(C.DEFAULT_MJ+C.ACTION_SCALE_MJ*C.isaac_to_mj(action.astype(np.float64)), target)
                applied = sample['applied_pd']
                assert applied['start_s'] == f['time'] and applied['end_s'] == (i+1)*C.DT
                assert applied['joint_names'] == list(C.MJ_JOINTS)
                tau = np.asarray(applied['torques_nm'])
                assert tau.shape == (4, 29)
                np.testing.assert_array_equal(tau[0], pd_torque(target, np.asarray(f['joints']), np.asarray(f['joint_velocity_rad_s'])))
                assert np.all(np.abs(tau) <= C.EFFORT_MJ[None])
                sampled += 1
            tracker.last_action = action.astype(np.float64)
            for key, rows in [('flow_index', pipeline['flow_samples']), ('sonic_index', pipeline['sonic_samples'])]:
                index = f['pipeline'][key]
                assert index is not None and 0 <= index < len(rows)
                assert rows[index]['source_time'] <= f['time']+1e-9
                assert index+1 == len(rows) or rows[index+1]['source_time'] > f['time']+1e-9
            post = f['post_action']
            scorer.update(np.asarray(post['qpos'])[:3], post['root_linear_velocity_w'],
                          physics_root_positions=physics['root_positions_m'][i],
                          physics_root_quaternions=physics['root_quaternions_wxyz'][i],
                          physics_contact_force_n=physics['obstacle_contact_n'][i])
            captured = scorer_rows[i]
            for key, value in scorer.rows[-1].items():
                assert value == captured[key], (i, key, value, captured[key])
            assert captured['hold_steps'] == scorer.hold_steps
            assert captured['hold_elapsed_s'] == scorer.hold_steps*C.DT
            assert post['goal_evaluation'] == captured
            assert f['health']['goal_evaluation'] == (scorer_rows[i-1] if i else None)
    checks += ['all_sampled_1570_inputs_exact_actual_source_history',
               'all_sampled_29_outputs_exact_inverse_named_target_transform',
               'all_sampled_references_exact_native', 'all_first_PD_substeps_exact_and_all_applied_torques_bounded',
               'all_pipeline_indices_causal_and_latest', 'all_source_scorer_rows_speed_hold_outcome_exact',
               'all_scorer_health_rows_causal_no_future_post_state']
    for key, value in scorer.report().items():
        assert value == metadata['test_result'][key], (key, value, metadata['test_result'][key])
    checks.append('all_source_scorer_summary_fields_exact')
    onnx = {'performed': False, 'reason': 'Explicit --replay-onnx not supplied; no inference executed'}
    if replay_onnx:
        import onnxruntime as ort
        ort.disable_telemetry_events()
        model = next(Path(p) for p in artifacts if p.endswith('/sonic_release_g1.onnx'))
        assert hashlib.sha256(model.read_bytes()).hexdigest() == artifacts[str(model)]['sha256']
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = opts.inter_op_num_threads = 1
        runtime = ort.InferenceSession(str(model), sess_options=opts, providers=['CPUExecutionProvider'])
        rows = pipeline['sonic_samples']
        selected = sorted(set([0, len(rows)//2, len(rows)-1]))
        errors = []
        for index in selected:
            row = rows[index]
            predicted = runtime.run(None, {row['input']['name']: np.asarray(row['input']['values'], dtype=np.float32)[None]})[0][0]
            recorded = np.asarray(row['output']['values'], dtype=np.float32)
            np.testing.assert_array_equal(predicted, recorded)
            errors.append({'sequence': row['sequence'], 'max_absolute_error': float(np.max(np.abs(predicted-recorded)))})
        onnx = {'performed': True, 'provider': 'CPUExecutionProvider', 'sample_count': len(selected),
                'sample_errors': errors, 'basis': 'Read-only inference on recorded inputs; no rollout or timing benchmark'}
        checks.append('actual_cpu_onnx_first_middle_last_outputs_exact')
    return {'schema_version': 1, 'session': str(path), 'checks': checks, 'check_count': len(checks),
            'frames': len(frames), 'flow_samples': len(pipeline['flow_samples']), 'sonic_samples': sampled,
            'scorer_outcome': scorer.outcome, 'onnx_replay': onnx, 'hardware_enabled': False,
            'maximum_onnx_observation_error': 0.0, 'maximum_first_pd_torque_error': 0.0}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('session', type=Path)
    ap.add_argument('--output', type=Path)
    ap.add_argument('--replay-onnx', action='store_true')
    args = ap.parse_args()
    report = verify(args.session, replay_onnx=args.replay_onnx)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False)+'\n')
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
