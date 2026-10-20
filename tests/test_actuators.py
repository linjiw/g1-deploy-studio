"""Actuator-limit profiles: in-memory hip patch, receipts and reference ceilings (no MuJoCo needed)."""
import types
import unittest

import numpy as np

from studio import actuators

JOINTS = ['left_hip_pitch_joint', 'left_hip_roll_joint', 'left_hip_yaw_joint', 'left_knee_joint',
          'right_hip_pitch_joint', 'right_hip_roll_joint', 'right_hip_yaw_joint', 'waist_yaw_joint']
SOURCE_HI = [88.0, 88.0, 88.0, 139.0, 88.0, 88.0, 88.0, 88.0]


def fake_model():
    model = types.SimpleNamespace(jnt_actfrcrange=np.array([[-v, v] for v in SOURCE_HI]),
                                  jnt_actfrclimited=np.ones(len(JOINTS), dtype=bool))
    model.joint = lambda name: types.SimpleNamespace(id=JOINTS.index(name))
    return model


class ActuatorProfileTests(unittest.TestCase):
    def test_current_profile_patches_hip_pitch_and_roll_only(self):
        model = fake_model()
        receipt = actuators.apply(model, JOINTS, 'g1-current')
        hi = model.jnt_actfrcrange[:, 1].tolist()
        self.assertEqual(hi, [139.0, 139.0, 88.0, 139.0, 139.0, 139.0, 88.0, 88.0])
        np.testing.assert_array_equal(model.jnt_actfrcrange[:, 0], -model.jnt_actfrcrange[:, 1])
        self.assertEqual(receipt['hips']['left_hip_pitch_joint'], {'before_nm': 88.0, 'after_nm': 139.0})
        self.assertNotIn('left_knee_joint', receipt['hips'])
        self.assertIn('mode_machine 10', receipt['hardware'])

    def test_rev1_profile_is_88_139_88(self):
        model = fake_model()
        actuators.apply(model, JOINTS, 'g1-rev1')
        self.assertEqual(model.jnt_actfrcrange[:3, 1].tolist(), [88.0, 139.0, 88.0])

    def test_source_profile_changes_nothing(self):
        model = fake_model()
        before = model.jnt_actfrcrange.copy()
        receipt = actuators.apply(model, JOINTS, 'source')
        np.testing.assert_array_equal(model.jnt_actfrcrange, before)
        self.assertTrue(all(v['before_nm'] == v['after_nm'] for v in receipt['hips'].values()))

    def test_default_validation_and_identity(self):
        self.assertEqual(actuators.validate(None), 'g1-current')
        with self.assertRaises(ValueError):
            actuators.validate('g1-made-up')
        with self.assertRaises(ValueError):
            actuators.validate(139)
        digests = {p: actuators.patch_digest(p) for p in actuators.PROFILES}
        self.assertEqual(len(set(digests.values())), 3, 'every profile has its own identity')
        self.assertEqual(actuators.patch_digest('g1-rev1'), digests['g1-rev1'], 'stable')

    def test_reference_limits_follow_each_hardware_profile(self):
        training = [139.0, 139.0, 88.0, 139.0, 139.0, 139.0, 88.0, 88.0]
        refs = actuators.reference_limits(JOINTS, training)
        self.assertEqual(refs['training'], training)
        self.assertEqual(refs['g1-rev1'][:4], [88.0, 139.0, 88.0, 139.0])
        self.assertEqual(refs['g1-current'][:4], [139.0, 139.0, 88.0, 139.0])
        self.assertEqual(refs['g1-rev1'][-1], 88.0, 'non-hip joints keep the training effort')


if __name__ == '__main__':
    unittest.main()
