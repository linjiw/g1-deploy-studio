"""Contract tests plus optional read-only parity against designated rehearsal files."""
import ast
import json
import math
from pathlib import Path
import tempfile
import unittest

import numpy as np

from studio.replay import (
    DEFAULT_DDS_SESSION, DEFAULT_SESSION, FLOW_ROOT, JOINT_NAMES, ReplayError,
    _final_map, _sample_indices, decode_reference, frame_at, load_session, matrix_quat, quat_matrix,
)


class ReferenceContractTests(unittest.TestCase):
    def setUp(self):
        self.q = np.r_[1., 2., .8, math.sqrt(.5), 0., 0., math.sqrt(.5), np.arange(29)*.01]
        self.ref = np.zeros((10, 67))
        self.ref[:, :29] = np.arange(29)*.02
        self.ref[:, 29:58] = np.arange(29)*.03
        self.ref[:, 58:64] = [1, 0, 0, 1, 0, 0]
        self.ref[:, 64:67] = [2, 3, .1]

    def test_heading_frame_diagnostic_position_is_not_global_input(self):
        r = decode_reference(self.ref, self.q)
        np.testing.assert_allclose(r["position"], [-2, 4, .9], atol=1e-12)
        np.testing.assert_allclose(quat_matrix(r["quaternion_wxyz"]), quat_matrix(self.q[3:7]), atol=1e-12)
        self.assertEqual(r["consumed_columns"], [0, 64])
        self.assertEqual(r["diagnostic_columns"], [64, 67])
        self.assertEqual(r["position_basis"], "planner-diagnostic-not-consumed-by-sonic")

    def test_native_joint_order_and_real_lookahead(self):
        r = decode_reference(self.ref, self.q)
        self.assertEqual(r["joints"], list(self.ref[0, :29]))
        self.assertEqual(r["window"][9]["offset_s"], .9)
        self.assertEqual(r["window"][2]["velocity"], list(self.ref[2, 29:58]))
        self.assertIsNone(r["latent_tokens"])

    def test_projection_preserves_raw_nonorthogonal_values(self):
        self.ref[:, 58:64] = [2, .4, 0, 3, 0, 0]
        r = decode_reference(self.ref, self.q)
        np.testing.assert_allclose(quat_matrix(r["quaternion_wxyz"]), quat_matrix(self.q[3:7]), atol=1e-12)
        self.assertEqual(r["raw"], self.ref.tolist())

    def test_rejects_invalid_values_and_quaternion(self):
        self.ref[0, 1] = np.nan
        with self.assertRaises(ReplayError):
            decode_reference(self.ref, self.q)
        with self.assertRaises(ReplayError):
            quat_matrix([0, 0, 0, 0])
        with self.assertRaises(ReplayError):
            decode_reference(np.zeros((10, 64)), self.q)

    def test_wxyz_rotation_roundtrip_at_180_degrees(self):
        for q in ([0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [.5,.5,.5,.5]):
            np.testing.assert_allclose(quat_matrix(matrix_quat(quat_matrix(q))), quat_matrix(q), atol=1e-12)

    def test_causal_timebase_and_staleness(self):
        session = {"frames": [{"time": 0, "sequence": 0}, {"time": .02, "sequence": 1}, {"time": .3, "sequence": 2}]}
        self.assertIsNone(frame_at(session, -.001)["frame"])
        self.assertEqual(frame_at(session, .019)["frame"]["sequence"], 0)
        self.assertEqual(frame_at(session, .02)["frame"]["sequence"], 1)
        self.assertEqual(frame_at(session, .2)["status"], "stale")
        self.assertEqual(frame_at(session, .5)["status"], "stale")
        with self.assertRaises(ReplayError):
            frame_at(session, float("nan"))

    def test_frame_budget_is_bounded_and_keeps_endpoint(self):
        indices = _sample_indices(10000, 500)
        self.assertEqual(len(indices), 500)
        self.assertEqual((indices[0], indices[-1]), (0, 9999))
        with self.assertRaises(ReplayError):
            _sample_indices(10000, 3001)

    def test_final_map_unknown_and_observed_clear_are_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"map.npz"
            np.savez(path, support=[[np.nan, .4], [np.nan, np.nan]], ceiling=[[np.nan, np.nan], [np.inf, 1.3]], lo=[10,20], res=.1)
            p = _final_map(path, 5)
        self.assertEqual(p["unknown_cells"], 1)
        self.assertEqual(p["clear_ceiling_cells"], 1)
        self.assertEqual(p["support_points"], [[10.,20.1,.4]])
        self.assertEqual(p["ceiling_points"], [[10.1,20.1,1.3]])
        self.assertIsNone(p["time"])
        self.assertFalse(p["synchronized"])
        self.assertEqual(p["available_at"], 5)
        json.dumps(p, allow_nan=False)


@unittest.skipUnless((DEFAULT_SESSION/"closed_loop.npz").is_file(), "designated local rehearsal is unavailable")
class RealRehearsalParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session = load_session(DEFAULT_SESSION)

    def test_actual_named_joint_contract_matches_current_source(self):
        tree = ast.parse((FLOW_ROOT/"g1deploy/contract.py").read_text())
        assignment = next(n for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "MJ_JOINTS" for t in n.targets))
        self.assertEqual(JOINT_NAMES, ast.literal_eval(assignment.value))

    def test_sampled_state_and_reference_values_are_identical_to_npz(self):
        with np.load(DEFAULT_SESSION/"closed_loop.npz", allow_pickle=False) as z:
            for i in (0, 37, len(self.session["frames"])-1):
                f = self.session["frames"][i]
                self.assertEqual(f["time"], i*.02)
                self.assertEqual(f["post_action"]["time"], i*.02+.02)
                np.testing.assert_array_equal(f["joints"], z["pre_action_qpos"][i,7:])
                np.testing.assert_array_equal(f["reference"]["raw"], z["references"][i])
                expected = np.sqrt(np.mean((z["pre_action_qpos"][i,7:]-z["references"][i,0,:29])**2))
                self.assertAlmostEqual(f["health"]["tracking_rmse_rad"], expected)
                self.assertIsNone(f["command"])
                self.assertIsNone(f["health"]["sonic_inference_ms"])
        json.dumps(self.session, allow_nan=False)

    def test_reference_orientation_matches_actual_tracker_projection(self):
        # Parse only the pure numerical function; do not import the reference package,
        # create bytecode there or initialize policy/runtime libraries.
        tree = ast.parse((FLOW_ROOT/"g1deploy/sonic.py").read_text())
        func = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "project_rotation_6d")
        namespace = {"np": np}
        exec(compile(ast.Module(body=[func], type_ignores=[]), "verified-source-projection", "exec"), namespace)
        for i in (0, 73, 158):
            frame = self.session["frames"][i]
            raw = np.asarray(frame["reference"]["raw"])
            projected = namespace["project_rotation_6d"](raw[:,58:64]).reshape(10,3,2)
            measured = quat_matrix(frame["quaternion_wxyz"])
            for k in (0, 5, 9):
                a,b = projected[k,:,0], projected[k,:,1]
                expected = measured @ np.column_stack((a,b,np.cross(a,b)))
                actual = quat_matrix(frame["reference"]["window"][k]["quaternion_wxyz"])
                np.testing.assert_allclose(actual, expected, atol=1e-7)

    @unittest.skipUnless((DEFAULT_DDS_SESSION/"sim.npz").is_file(), "designated DDS rehearsal unavailable")
    def test_dex3_model_joint_mapping_and_mixed_rate_timestamps(self):
        session = load_session(DEFAULT_DDS_SESSION)
        addresses = [session["metadata"]["joint_qpos_addresses"][n] for n in JOINT_NAMES]
        self.assertNotEqual(addresses, list(range(7,36)))  # Dex3 fingers precede the right arm.
        with np.load(DEFAULT_DDS_SESSION/"sim.npz", allow_pickle=False) as z:
            for i in (0, 313, len(session["frames"])-1):
                frame = session["frames"][i]
                self.assertEqual(frame["source_time"], z["wall"][2*i])
                self.assertEqual(frame["sim_time"], z["t"][2*i])
                np.testing.assert_array_equal(frame["joints"], z["qpos"][i,addresses])
                self.assertIsNone(frame["reference"])
                self.assertIsNone(frame["health"]["tracking_rmse_rad"])
        self.assertFalse(session["graph"]["runtime_discovered"])
        self.assertFalse(session["metadata"]["command_path_enabled"])
        self.assertFalse(session["perception"]["synchronized"])
        json.dumps(session, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
