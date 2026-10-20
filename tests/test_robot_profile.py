import ast
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest

from studio import robot_profile as rp
from studio.protocols import ISAAC_TO_MJ as STUDIO_ISAAC_TO_MJ, MJ_JOINTS as STUDIO_MJ_JOINTS

PROFILE = rp.load_profile()


def cited_paths(profile):
    return sorted({node["path"] for _, node in rp._walk(profile)
                   if isinstance(node, dict) and isinstance(node.get("path"), str) and "line" in node}
                  | set(profile["source_files"].values()))


def missing_reference():
    return next((p for p in cited_paths(PROFILE) if not Path(p).is_file()), None)


class ProfileLoadTests(unittest.TestCase):
    def test_loads_and_validates(self):
        self.assertEqual(PROFILE["robot_id"], "unitree_g1_29dof")
        self.assertFalse(PROFILE["verification"]["runtime_verified"])
        self.assertFalse(PROFILE["verification"]["hardware_verified"])
        names = [j["name"] for j in PROFILE["joints"]]
        self.assertEqual(len(names), 29)
        self.assertEqual(len(set(names)), 29)
        for j in PROFILE["joints"]:
            for q in rp.QUANTITIES:
                for v in j[q]["values"]:
                    self.assertTrue(v["source"]["path"].startswith("/"), (j["name"], q))
                    self.assertGreaterEqual(v["source"]["line"], 1)

    def test_every_number_is_finite(self):
        for where, value in rp._walk(PROFILE):
            if isinstance(value, float):
                self.assertTrue(math.isfinite(value), where)

    def test_only_stdlib_imports(self):
        tree = ast.parse(Path(rp.__file__).read_text())
        roots = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        roots |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        allowed = {"__future__", "ast", "json", "math", "operator", "re", "struct", "xml", "functools", "pathlib"}
        self.assertLessEqual(roots, allowed)

    def test_validation_rejects_corruption(self):
        def broken(mutate):
            p = copy.deepcopy(PROFILE)
            mutate(p)
            with self.assertRaises(rp.ProfileError):
                rp.validate(p)

        broken(lambda p: p["joints"][1].__setitem__("name", p["joints"][0]["name"]))
        broken(lambda p: p["orders"]["isaaclab"].reverse())
        broken(lambda p: p["joints"].pop())
        broken(lambda p: p["joints"][0]["kp_nm_per_rad"]["values"][0].__setitem__("value", -1.0))
        broken(lambda p: p["joints"][0]["kd_nm_s_per_rad"]["values"][1].__setitem__("value", float("nan")))
        broken(lambda p: p["joints"][0]["kp_nm_per_rad"].__setitem__("agreement", "exact"))
        broken(lambda p: p["joints"][0]["position_limit_rad"]["values"][0].__setitem__("value", [1.0, -1.0]))
        broken(lambda p: p["joints"][0]["default_angle_rad"]["values"][0]["source"].__setitem__("line", 0))
        broken(lambda p: p["safety_thresholds"][0].pop("effect"))

    def test_load_profile_from_path(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "profile.json"
            path.write_text(json.dumps(PROFILE))
            self.assertEqual(rp.load_profile(path)["orders"], PROFILE["orders"])
            bad = copy.deepcopy(PROFILE)
            bad["schema_version"] = 2
            path.write_text(json.dumps(bad))
            with self.assertRaises(rp.ProfileError):
                rp.load_profile(path)


class OrderTests(unittest.TestCase):
    def test_orders_are_consistent_permutations(self):
        orders = PROFILE["orders"]
        names = {j["name"] for j in PROFILE["joints"]}
        for order in rp.ORDERS:
            self.assertEqual(set(orders[order]), names)
            self.assertEqual(len(orders[order]), 29)
        self.assertEqual(orders["unitree_motor"], orders["mujoco"])
        i2m = orders["mapping_arrays"]["isaac_index_to_mujoco_index"]
        m2i = orders["mapping_arrays"]["mujoco_index_to_isaac_index"]
        self.assertEqual(sorted(i2m), list(range(29)))
        self.assertEqual([orders["mujoco"][k] for k in i2m], orders["isaaclab"])
        self.assertEqual([i2m[m2i[k]] for k in range(29)], list(range(29)))

    def test_matches_existing_studio_decoder_constants(self):
        self.assertEqual(PROFILE["orders"]["mujoco"], list(STUDIO_MJ_JOINTS))
        self.assertEqual(PROFILE["orders"]["mapping_arrays"]["isaac_index_to_mujoco_index"], list(STUDIO_ISAAC_TO_MJ))

    def test_reorder_round_trips(self):
        values = [0.01 * k - 0.1 for k in range(29)]
        for a in rp.ORDERS:
            for b in rp.ORDERS:
                self.assertEqual(rp.reorder(rp.reorder(values, a, b), b, a), values)
        isaac = rp.reorder(values, "mujoco", "isaaclab")
        i2m = PROFILE["orders"]["mapping_arrays"]["isaac_index_to_mujoco_index"]
        self.assertEqual(isaac, [values[k] for k in i2m])
        with self.assertRaises(ValueError):
            rp.reorder(values[:-1], "mujoco", "isaaclab")

    def test_joint_index(self):
        self.assertEqual(rp.joint_index("left_hip_roll_joint", "mujoco"), 1)
        self.assertEqual(rp.joint_index("left_hip_roll_joint", "isaaclab"), 3)
        self.assertEqual(rp.joint_index("waist_pitch_joint", "isaaclab"), 8)
        self.assertEqual(rp.joint_index("right_wrist_yaw_joint", "unitree_motor"), 28)
        for j in PROFILE["joints"]:
            for order in rp.ORDERS:
                self.assertEqual(rp.joint_index(j["name"], order), j[rp.INDEX_KEY[order]])
        with self.assertRaises(KeyError):
            rp.joint_index("left_hand_thumb_0_joint", "mujoco")


class RecordedFactsTests(unittest.TestCase):
    def joint(self, name):
        return next(j for j in PROFILE["joints"] if j["name"] == name)

    def test_kp_discrepancy_7520_22_is_recorded_not_resolved(self):
        kp = self.joint("left_knee_joint")["kp_nm_per_rad"]
        by = {v["origin"]: v["value"] for v in kp["values"]}
        self.assertIsNone(kp["value"])
        self.assertEqual(kp["agreement"], "rounding")
        self.assertEqual(by["flow_python"], 99.13)
        self.assertAlmostEqual(by["runner_cpp"], 99.0984, places=3)
        self.assertAlmostEqual(by["training_isaaclab"], by["runner_cpp"], places=4)

    def test_hip_effort_disagreement_is_material(self):
        for name in ("left_hip_pitch_joint", "right_hip_roll_joint"):
            e = self.joint(name)["effort_limit_nm"]
            by = {v["origin"]: v["value"] for v in e["values"]}
            self.assertEqual(e["agreement"], "material")
            self.assertIsNone(e["value"])
            self.assertEqual(by["training_isaaclab"], 139.0)
            self.assertEqual(by["lucid_sim_torque_clip"], 88.0)
        self.assertEqual(self.joint("left_knee_joint")["effort_limit_nm"]["value"], 139.0)

    def test_safety_thresholds(self):
        t = {x["id"]: x for x in PROFILE["safety_thresholds"]}
        self.assertEqual((t["runner_lowstate_absent"]["value"], t["runner_lowstate_absent"]["unit"]), (500, "ms"))
        self.assertEqual(t["runner_reference_absent_cue"]["value"], 150)
        self.assertIn("ONE-SIDED", t["runner_joint_velocity_abort"]["effect"])
        self.assertIn("--disable-crc-check", t["runner_joint_velocity_abort"]["effect"])
        self.assertEqual(t["node_state_stale_estop"]["value"], 0.5)
        self.assertEqual(t["node_tilt_estop"]["value"], 0.75)
        self.assertEqual(t["node_cloud_timeout_stand"]["value"], 1.0)
        self.assertEqual(t["node_stall_risk"]["value"], 46)
        self.assertEqual(t["runner_stream_playback_hold"]["value"], 46)

    def test_transport_contract(self):
        domains = PROFILE["dds"]["domain_config_locations"]
        runner = next(d for d in domains if d["component"].startswith("sonic_runner (g1"))
        self.assertEqual((runner["value"], runner["configurable"]), (0, False))
        topics = {t["name"]: t for t in PROFILE["dds"]["topics"]}
        self.assertEqual(topics["rt/lowcmd"]["type"], "unitree_hg::msg::dds_::LowCmd_")
        self.assertTrue(topics["rt/lowcmd"]["studio_access"].startswith("never"))
        lowcmd = {f["name"]: f["type"] for f in PROFILE["dds"]["idl"]["LowCmd_"]["fields"]}
        self.assertEqual(lowcmd["motor_cmd"], "MotorCmd_[35]")
        control = next(e for e in PROFILE["zmq"]["endpoints"] if e["bind"] == "tcp://*:5562")
        self.assertTrue(control["studio_access"].startswith("forbidden"))
        pose = next(e for e in PROFILE["zmq"]["endpoints"] if e["topic"] == "pose")
        self.assertIn("IsaacLab", pose["fields"]["joint_pos"])
        conflict = [q for q in PROFILE["frames"]["quaternion_conventions"] if q["status"] == "conflict"]
        self.assertEqual([q["interface"] for q in conflict], ["rt/odostate orientation"])


class SourceVerificationTests(unittest.TestCase):
    def setUp(self):
        missing = missing_reference()
        if missing:
            self.skipTest(f"read-only reference source not present on this host: {missing}")

    def test_profile_matches_reference_sources(self):
        self.assertEqual(rp.verify_against_sources(PROFILE), [])

    def test_verification_detects_drift(self):
        p = copy.deepcopy(PROFILE)
        p["joints"][0]["kp_nm_per_rad"]["values"][0]["value"] = 100.0
        p["safety_thresholds"][0]["value"] = 400
        p["dds"]["topics"][0]["source"][0]["line"] += 1
        problems = rp.verify_against_sources(p)
        self.assertTrue(any("left_hip_pitch_joint.kp_nm_per_rad.runner_cpp" in s for s in problems), problems)
        self.assertTrue(any("runner_lowstate_absent" in s for s in problems), problems)
        self.assertTrue(any("no longer contains" in s for s in problems), problems)

    def test_reference_files_unchanged_by_verification(self):
        before = {p: Path(p).stat().st_mtime_ns for p in cited_paths(PROFILE)}
        rp.verify_against_sources(PROFILE)
        self.assertEqual(before, {p: Path(p).stat().st_mtime_ns for p in cited_paths(PROFILE)})


if __name__ == "__main__":
    unittest.main()
