"""Bounded observers for the existing CPU rehearsal's model boundaries.

Only called inside the isolated policy worker. No inference, state update, model
mutation, middleware, or controller lives here. Values are copied from actual
calls; internal activations and latent codes are deliberately not inferred.
"""
from __future__ import annotations

import time
import numpy as np

SONIC_SAMPLE_EVERY = 5  # 10 Hz on the existing 50 Hz control clock
MAX_CONTROL_STEPS = 500
MAX_FLOW_SAMPLES = 500
PREVIEW_ELEMENTS = 16


def jsonable(value, note=None):
    """Strict-JSON copy: non-finite floats become None (e.g. infinite clearance on an empty map)."""
    if isinstance(value, float):
        if not np.isfinite(value):
            if note is not None:
                note.append('inf' if value > 0 else '-inf' if value < 0 else 'nan')
            return None
        return value
    if isinstance(value, (np.floating, np.integer)):
        return jsonable(value.item(), note)
    if isinstance(value, dict):
        return {k: jsonable(v, note) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v, note) for v in value]
    if isinstance(value, np.ndarray):
        return jsonable(value.tolist(), note)
    return value


def array(value):
    if hasattr(value, 'detach'):
        value = value.detach().cpu().numpy()
    return np.asarray(value)


def tensor(value, name, *, values=False):
    """Finite-safe exact shape and bounded numeric preview, without editing input."""
    a = array(value)
    flat = a.reshape(-1)
    finite = np.isfinite(flat)
    known = flat[finite].astype(np.float64)
    result = {'name': name, 'shape': list(a.shape), 'dtype': str(a.dtype),
              'stats': {'min': float(known.min()) if known.size else None,
                        'max': float(known.max()) if known.size else None,
                        'mean': float(known.mean()) if known.size else None,
                        'rms': float(np.sqrt(np.mean(known**2))) if known.size else None,
                        'finite_count': int(finite.sum()), 'elements': int(flat.size)},
              'preview': [float(v) if np.isfinite(v) else None for v in flat[:PREVIEW_ELEMENTS]],
              'preview_basis': 'First elements in C order; not hidden activations'}
    if values:
        result['values'] = [float(v) if np.isfinite(v) else None for v in flat]
    return result


def contract(source, joints, *, input_signature=None, output_signature=None):
    blocks = [('reference_joint_position', 0, 290, [10, 29], 'rad', 'Absolute joint targets; Isaac order'),
              ('reference_joint_velocity', 290, 290, [10, 29], 'rad/s', 'Isaac order'),
              ('reference_pelvis_orientation_6d', 580, 60, [10, 6], 'unitless', 'Projected orthonormal first two columns; pelvis-relative'),
              ('angular_velocity_history', 640, 30, [10, 3], 'rad/s', 'Body frame; oldest first'),
              ('joint_position_delta_history', 670, 290, [10, 29], 'rad', 'Relative to SONIC default; Isaac order; oldest first'),
              ('joint_velocity_history', 960, 290, [10, 29], 'rad/s', 'Isaac order; oldest first'),
              ('previous_action_history', 1250, 290, [10, 29], 'unitless', 'Isaac order; oldest first'),
              ('projected_gravity_history', 1540, 30, [10, 3], 'unitless', 'Unit gravity direction in body frame; oldest first')]
    return {'schema_version': 1, 'classification': 'observed-model-boundaries',
            'backend': 'in-process CPU simulation', 'hardware_enabled': False,
            'flow_engine': 'pytorch-eager', 'sonic_engine': 'onnxruntime',
            'source': str(source), 'clock_domain': 'simulation',
            'joint_names_mujoco': list(joints.MJ_JOINTS), 'joint_names_isaac': list(joints.ISAAC_JOINTS),
            'isaac_to_mujoco_index': joints.ISAAC_TO_MJ.tolist(),
            'default_joints_rad': joints.DEFAULT_MJ.tolist(),
            'action_scale_rad': joints.ACTION_SCALE_MJ.tolist(),
            'target_transform': 'q_target_mj = default_mj + action_scale_mj * isaac_to_mj(action)',
            'observation_blocks': [{'name': n, 'offset': o, 'length': l, 'shape': s, 'unit': u, 'note': note}
                                   for n, o, l, s, u, note in blocks],
            'reference_dt_s': .1, 'history_dt_s': float(joints.DT),
            'sonic_sample_period_s': SONIC_SAMPLE_EVERY*float(joints.DT),
            'flow_sample_basis': 'First actual model forward in each replan; all forward calls counted',
            'flow_conditioning_basis': 'First candidate in first model call; later chunks/candidates are not repeated here',
            'map_channels': [{'name': 'support', 'unit': 'm', 'note': 'Source clips support; unknown defaults to 0'},
                             {'name': 'lateral', 'unit': 'm', 'note': 'Source sensor adapter supplies zeros'},
                             {'name': 'overhead', 'unit': 'm', 'note': 'Unknown/open ceiling uses source CLEAR_HEIGHT prior'}],
            'map_grid': {'resolution_m': .05, 'shape': [3, 31, 61],
                         'x_range_m': [-1.5, 1.5], 'y_range_m': [-.75, .75],
                         'frame': 'candidate anchor heading', 'axes': 'rows y, columns x',
                         'basis': 'Source elevation.cell_grid defaults; definition, not sensor coverage'},
            'map_note': 'Actual model conditioning, not an observed occupancy mask. Unknown defaults must not be interpreted as observed free space.',
            'hidden_tokens_available': False,
            'hidden_tokens_note': 'Fused SONIC exposes observation and action only. No internal latent token/activation or semantic code is recorded.',
            'onnx_inputs': input_signature, 'onnx_outputs': output_signature,
            'pd_basis': 'Actual return values of source pd_torque applied to MuJoCo, sampled on the same selected control ticks',
            'sampling_limits': {'max_control_steps': MAX_CONTROL_STEPS, 'max_flow_samples': MAX_FLOW_SAMPLES,
                                'sonic_every_control_steps': SONIC_SAMPLE_EVERY, 'tensor_preview_elements': PREVIEW_ELEMENTS}}


class PipelineRecorder:
    def __init__(self):
        self.flow_samples = []
        self.sonic_samples = []
        self._plan = None
        self._hooks = {}
        self.telemetry_wall_s = 0.0

    def begin_plan(self, planner, sequence, dt):
        if len(self.flow_samples) >= MAX_FLOW_SAMPLES:
            raise ValueError('Flow telemetry budget exceeded')
        self._plan = {'source_time': float(sequence*dt), 'sequence': int(sequence),
                      'clock_domain': 'simulation', 'engine': 'pytorch-eager',
                      'forward_calls': 0, 'input_tensors': [], 'conditioning': None, 'output_tensor': None}
        if id(planner.model) not in self._hooks:
            self._hooks[id(planner.model)] = planner.model.register_forward_hook(self._forward)

    def _forward(self, model, inputs, output):
        row = self._plan
        if row is None:
            return
        row['forward_calls'] += 1
        if row['forward_calls'] != 1:
            return
        tic = time.perf_counter()
        names = ('noisy_state', 'flow_time', 'prior', 'committed')
        row['input_tensors'] = [tensor(v, n) for n, v in zip(names, inputs[:4])]
        cond = inputs[4]
        for n in ('history', 'anchor', 'goal', 'map', 'prior_mask'):
            if n in cond:
                row['input_tensors'].append(tensor(cond[n], n))
        row['conditioning'] = {n: array(cond[n])[0].copy().tolist() for n in ('history', 'anchor', 'goal', 'map') if n in cond}
        row['conditioning_batch_index'] = 0
        row['output_tensor'] = tensor(output, 'flow_velocity')
        row['receipt_time'] = time.monotonic()
        row['receipt_clock_domain'] = 'host-monotonic'
        self.telemetry_wall_s += time.perf_counter()-tic

    def end_plan(self, result, latency_ms):
        if self._plan is None:
            raise ValueError('Missing plan observation')
        tic = time.perf_counter()
        row, self._plan = self._plan, None
        row['latency_ms'] = float(latency_ms)
        q = array(result['qpos'])
        selected = {'rule': result['rule'], 'choice': result.get('choice'),
                           'clearance_m': result.get('clearance_m'), 'remaining_m': result.get('remaining_m'),
                           'chosen_clearance_m': result.get('chosen_clearance_m'),
                           'goal_world_xy': result.get('goal_world_xy'), 'qpos_shape': list(q.shape),
                           'plan_xy': q[:, :2].tolist(), 'candidate_pool': result.get('candidate_pool'),
                           'no_safe_candidate': result.get('no_safe_candidate'),
                           'selection_revision': result.get('selection_revision'),
                           'goal_diagnostics': result.get('goal_diagnostics'),
                           'fallback_tie_changed': result.get('fallback_tie_changed')}
        dropped = []
        row['selected'] = jsonable(selected, dropped)
        if dropped:
            row['selected']['non_finite_note'] = (f'{len(dropped)} non-finite value(s) stored as null '
                                                  '(e.g. infinite clearance: no obstacle in range)')
        self.flow_samples.append(row)
        self.telemetry_wall_s += time.perf_counter()-tic

    def sonic(self, sequence, dt, obs, result, inference_ms, input_name, output_name):
        if sequence >= MAX_CONTROL_STEPS:
            raise ValueError('Control telemetry budget exceeded')
        if sequence % SONIC_SAMPLE_EVERY:
            return None
        tic = time.perf_counter()
        observation = np.asarray(obs, dtype=np.float32)[None]
        action = np.asarray(result)[None]
        if observation.shape != (1, 1570) or action.shape != (1, 29):
            raise ValueError('SONIC telemetry does not match observed fused model shape')
        row = {'source_time': float(sequence*dt), 'sequence': int(sequence), 'clock_domain': 'simulation',
               'engine': 'onnxruntime', 'inference_ms': float(inference_ms),
               'input': tensor(observation, input_name, values=True),
               'output': tensor(action, output_name, values=True),
               'receipt_time': time.monotonic(), 'receipt_clock_domain': 'host-monotonic',
               'reference_shape': [10, 67], 'target_joints_rad': None, 'applied_pd': None}
        self.sonic_samples.append(row)
        self.telemetry_wall_s += time.perf_counter()-tic
        return row

    def indices(self):
        return {'schema_version': 1, 'flow_index': len(self.flow_samples)-1 if self.flow_samples else None,
                'sonic_index': len(self.sonic_samples)-1 if self.sonic_samples else None}

    def data(self, *, latest=False):
        return {'schema_version': 1,
                'flow_samples': self.flow_samples[-1:] if latest else self.flow_samples,
                'sonic_samples': self.sonic_samples[-1:] if latest else self.sonic_samples}

    def close(self):
        for hook in self._hooks.values():
            hook.remove()
        self._hooks.clear()
        self._plan = None
