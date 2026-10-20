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


class TorqueExceedanceTests(unittest.TestCase):
    def test_tracker_counts_substeps_above_training_and_each_hardware_profile(self):
        from studio.policy_worker import TorqueTracker
        model = fake_model()
        actuators.apply(model, JOINTS, 'g1-current')
        training = [139.0, 139.0, 88.0, 139.0, 139.0, 139.0, 88.0, 88.0]
        tracker = TorqueTracker(np, model, JOINTS, training)
        tracker.observe([120, 0, 0, 0, 0, 0, 0, 0])   # above rev1 hip pitch (88), below current (139)
        tracker.observe([-139, 0, 0, 0, 0, 0, 0, 0])  # exactly at the source training clip = effective limit (H1)
        tracker.end_tick()
        summary = tracker.summary(training)
        self.assertEqual(summary['saturated_substeps'], {'left_hip_pitch_joint': 1}, 'a command sitting on the clip is saturation')
        self.assertEqual(summary['exceedance_substeps']['g1-rev1'], {'left_hip_pitch_joint': 2})
        self.assertEqual(summary['exceedance_substeps']['source'], {'left_hip_pitch_joint': 2})
        self.assertEqual(summary['exceedance_substeps']['g1-current'], {'left_hip_pitch_joint': 1})
        self.assertEqual(summary['exceedance_substeps']['training'], {'left_hip_pitch_joint': 1})
        self.assertEqual(summary['effective_limit_nm']['left_hip_pitch_joint'], 139.0)
        self.assertEqual(summary['model_limit_nm']['left_hip_pitch_joint'], 139.0)
        self.assertEqual(summary['reference_limits_nm']['g1-rev1']['left_hip_pitch_joint'], 88.0)

    def test_effective_limit_is_the_smaller_of_clip_and_model(self):
        from studio.policy_worker import TorqueTracker
        model = fake_model()  # source model: hips clamp at 88 in MuJoCo, training clip 139
        tracker = TorqueTracker(np, model, JOINTS, [139.0, 139.0, 88.0, 139.0, 139.0, 139.0, 88.0, 88.0])
        tracker.observe([100, 0, 0, 0, 0, 0, 0, 0]); tracker.end_tick()
        summary = tracker.summary([139.0] * 8)
        self.assertEqual(summary['effective_limit_nm']['left_hip_pitch_joint'], 88.0)
        self.assertEqual(summary['saturated_substeps'], {'left_hip_pitch_joint': 1})


class TorqueAtLimitDerivationTests(unittest.TestCase):
    def test_recorded_peaks_at_the_clip_count_even_without_saturated_substeps(self):
        from studio.workbench import torque_at_limit
        legacy = {'peak_commanded_nm': {'left_hip_pitch_joint': 139.0, 'left_knee_joint': 120.0, 'left_ankle_pitch_joint': 50.0},
                  'model_limit_nm': {'left_hip_pitch_joint': 139.0, 'left_knee_joint': 139.0, 'left_ankle_pitch_joint': 50.0},
                  'training_effort_nm': {'left_hip_pitch_joint': 139.0, 'left_knee_joint': 139.0, 'left_ankle_pitch_joint': 50.0},
                  'saturated_substeps': {}}
        self.assertEqual(torque_at_limit(legacy), ['left_ankle_pitch_joint', 'left_hip_pitch_joint'])
        self.assertIsNone(torque_at_limit(None))
        self.assertEqual(torque_at_limit({'peak_commanded_nm': {'x': 1.0}}), [])


if __name__ == '__main__':
    unittest.main()
