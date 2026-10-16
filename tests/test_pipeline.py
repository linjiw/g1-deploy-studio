"""Observer regression fixtures; fresh policy evidence is produced by acceptance runs."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

import numpy as np

from studio.pipeline import PipelineRecorder, tensor, MAX_CONTROL_STEPS


class FakeModel:
    def register_forward_hook(self, hook):
        self.hook = hook
        return self

    def remove(self):
        self.hook = None


class Planner:
    def __init__(self):
        self.model = FakeModel()


class PipelineTest(unittest.TestCase):
    def test_preview_is_bounded_and_nonfinite_is_explicit(self):
        source = np.arange(20., dtype=np.float32)
        source[-1] = np.nan
        result = tensor(source, 'input', values=True)
        self.assertEqual(result['shape'], [20])
        self.assertEqual(len(result['preview']), 16)
        self.assertEqual(result['stats']['finite_count'], 19)
        self.assertIsNone(result['values'][-1])
        self.assertTrue(np.isnan(source[-1]))
        json.dumps(result, allow_nan=False)

    def test_first_forward_observed_once_and_counted_without_mutation(self):
        planner, recorder = Planner(), PipelineRecorder()
        recorder.begin_plan(planner, 8, .02)
        cond = {'history': np.zeros((4, 4, 65), np.float32), 'anchor': np.ones((4, 65), np.float32),
                'goal': np.arange(16, dtype=np.float32).reshape(4, 4),
                'map': np.arange(4*3*31*61, dtype=np.float32).reshape(4, 3, 31, 61),
                'prior_mask': np.zeros((4, 24), bool)}
        args = (np.zeros((4, 24, 65), np.float32), np.ones((4, 24, 1)),
                np.zeros((4, 24, 65)), np.zeros((4, 24), bool), cond)
        out = np.arange(4*24*65, dtype=np.float32).reshape(4, 24, 65)
        self.assertIsNone(planner.model.hook(planner.model, args, out))
        # Later calls counted but never overwrite the first actual model input.
        cond['goal'][0, 0] = 999
        planner.model.hook(planner.model, args, out)
        result = {'qpos': np.zeros((48, 36)), 'rule': 'fixture', 'choice': 1,
                  'clearance_m': [0., .08], 'remaining_m': [.2, .3]}
        recorder.end_plan(result, 100)
        row = recorder.flow_samples[0]
        self.assertEqual(row['conditioning']['goal'][0], 0)
        self.assertEqual(row['source_time'], .16)
        self.assertEqual(row['forward_calls'], 2)
        np.testing.assert_array_equal(row['conditioning']['map'], cond['map'][0])
        self.assertEqual(row['output_tensor']['shape'], [4, 24, 65])
        self.assertEqual(cond['goal'][0, 0], 999)
        self.assertEqual(out[0, 0, 1], 1)
        recorder.close()
        self.assertIsNone(planner.model.hook)

    def test_sonic_input_cast_matches_runtime_and_is_decimated(self):
        recorder = PipelineRecorder()
        obs = np.linspace(-1, 1, 1570, dtype=np.float64)
        action = np.linspace(-2, 2, 29, dtype=np.float32)
        before = obs.copy()
        for sequence in range(11):
            result = recorder.sonic(sequence, .02, obs, action, 2.5, 'obs', 'action')
            self.assertEqual(result is not None, sequence % 5 == 0)
        self.assertEqual(len(recorder.sonic_samples), 3)
        self.assertEqual(recorder.indices(), {'schema_version': 1, 'flow_index': None, 'sonic_index': 2})
        row = recorder.sonic_samples[-1]
        np.testing.assert_array_equal(row['input']['values'], obs.astype(np.float32))
        np.testing.assert_array_equal(row['output']['values'], action)
        np.testing.assert_array_equal(obs, before)
        self.assertEqual(row['input']['shape'], [1, 1570])
        self.assertEqual(row['source_time'], .2)
        self.assertEqual(len(recorder.data(latest=True)['sonic_samples']), 1)
        with self.assertRaisesRegex(ValueError, 'budget'):
            recorder.sonic(MAX_CONTROL_STEPS, .02, obs, action, 1, 'obs', 'action')
        json.dumps(recorder.data(), allow_nan=False)

    def test_actual_source_observation_blocks_and_target_transform(self):
        # Import only NumPy source contract/observation builders; no runtime or
        # physics initialization, model inference, research outcome reads or DDS.
        root = Path('/home/linjiw/code/g1-student-deploy')
        if not (root/'g1deploy/sonic.py').is_file():
            self.skipTest('Reference source unavailable')
        script = r'''
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, '/home/linjiw/code/g1-student-deploy')
from collections import deque
import numpy as np
from g1deploy import contract as C
from g1deploy.sonic import SonicTracker, project_rotation_6d
from studio.pipeline import PipelineRecorder, contract
tracker = SonicTracker.__new__(SonicTracker)
tracker.hist = {k: deque(maxlen=10) for k in ('ang_vel','joint_pos','joint_vel','action','gravity')}
tracker.last_action = np.zeros(29)
q = np.arange(290, dtype=float).reshape(10,29)*.001
v = np.ones((10,29))*.02
ori = np.tile([1.,0.,0.,1.,0.,0.], (10,1))
cur = SonicTracker.proprio([1.,0.,0.,0.], [.1,.2,.3], C.DEFAULT_MJ, np.zeros(29))
obs = tracker.observation(cur,q,v,ori)
layout = contract('source',C)
assert sum(x['length'] for x in layout['observation_blocks']) == len(obs) == 1570
np.testing.assert_array_equal(obs[:290], C.mj_to_isaac(q).reshape(-1))
np.testing.assert_array_equal(obs[290:580], C.mj_to_isaac(v).reshape(-1))
np.testing.assert_array_equal(obs[580:640], project_rotation_6d(ori).reshape(-1))
np.testing.assert_array_equal(obs[640:670], np.tile([.1,.2,.3],10))
np.testing.assert_array_equal(obs[1540:], np.tile([0.,0.,-1.],10))
# Source act uses exact supplied output once; no ONNX inference created here.
action = np.arange(29,dtype=np.float32)*.01
calls = []
def observed_policy(values):
    calls.append(values)
    return action
tracker.policy = observed_policy
actual = tracker.act(cur,q,v,ori)
expected = np.array(layout['default_joints_rad']) + np.array(layout['action_scale_rad'])*action[np.argsort(layout['isaac_to_mujoco_index'])]
np.testing.assert_array_equal(actual,expected)
assert len(calls)==1
assert not {'onnxruntime','mujoco','unitree_sdk2py'} & set(sys.modules)
print('Actual source 1570 block/order and 29 action-to-target parity verified without inference')
'''
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()
