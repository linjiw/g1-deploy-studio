"""Sensor semantics, causal perception, and designated source-data parity."""
import ast
import base64
import json
from pathlib import Path
import tempfile
import unittest

import msgpack
import numpy as np

from studio.protocols import decode_packet
from studio.replay import DEFAULT_DDS_SESSION, DEFAULT_SESSION, FLOW_ROOT, ReplayError, load_session
from studio.sensors import get_sensor_catalog, get_sensor_snapshot, load_sensor_capture

FRESH_SESSION = Path("/home/linjiw/research-data/g1-deploy-studio/evidence/policy-workbench/run-boxes-verified/session.json")


def by_id(snapshot):
    return {sensor["id"]: sensor for sensor in snapshot["sensors"]}


class SensorSemanticsTests(unittest.TestCase):
    def setUp(self):
        # Deliberate small fixture; real execution parity is tested below.
        self.session = {"metadata": {"id": "fixture", "mode": "replay", "frame_id": "world",
                                     "clock_domain": "simulation", "fixture": True},
                        "joint_names": ["test_joint"], "frames": [
                            {"time": 0., "source_time": 0., "source_clock_domain": "simulation",
                             "sequence": 0, "position": [0., 0., .8], "quaternion_wxyz": [1., 0., 0., 0.],
                             "joints": [.2], "classification": "simulator-ground-truth", "frame_id": "world",
                             "health": {"contact_force_n": 2.1}},
                            {"time": .2, "source_time": .2, "source_clock_domain": "simulation",
                             "sequence": 1, "position": [.1, 0., .8], "quaternion_wxyz": [1., 0., 0., 0.],
                             "joints": [.3], "classification": "simulator-ground-truth", "frame_id": "world",
                             "health": {"contact_force_n": 4.1}}],
                        "perception": {"available": False}}

    def test_causal_state_does_not_imply_imu_or_odometry(self):
        before = by_id(get_sensor_snapshot(self.session, -.01))
        self.assertFalse(before["base_pose"]["available"])
        first = by_id(get_sensor_snapshot(self.session, .199))
        self.assertEqual(first["joints"]["payload"]["position"], [.2])
        self.assertEqual(first["base_pose"]["status"], "stale")
        self.assertEqual(first["base_pose"]["classification"], "simulator-ground-truth")
        self.assertIsNone(first["joints"]["payload"]["velocity"])
        for name in ("imu", "lidar_imu", "odometry", "rgb_camera", "depth_camera", "lidar_raw"):
            self.assertFalse(first[name]["available"])
            self.assertIsNone(first[name]["age_ms"])
            self.assertIsNone(first[name]["payload"])
        end = by_id(get_sensor_snapshot(self.session, .2))
        self.assertEqual(end["contact"]["payload"]["force_n"], 4.1)
        self.assertEqual(end["base_pose"]["rate_hz"], 5)

    def test_final_map_never_uses_cursor_as_timestamp(self):
        self.session["perception"] = {
            "available": True, "kind": "final-map-snapshot", "frame_id": "world", "time": None,
            "support_points": [[1., 2., .3]], "ceiling_points": [], "grid_shape": [1, 2],
            "support_observed_mask": [[True, False]], "ceiling_observed_mask": [[False, False]],
            "observed_cells": {"support": 1, "ceiling": 0}, "unknown_cells": 1,
            "resolution_m": .1, "origin": [1., 2.]}
        for cursor in (0., 1., 100.):
            sensor = by_id(get_sensor_snapshot(self.session, cursor))["map_support"]
            self.assertEqual(sensor["status"], "unsynchronized")
            self.assertIsNone(sensor["age_ms"])
            self.assertIsNone(sensor["source_time"])
            self.assertFalse(sensor["synchronized"])
            self.assertEqual(sensor["payload"]["observed_mask"], [[True, False]])

    def test_contact_interval_cannot_leak_future_physics_into_pre_action_state(self):
        from studio.policy_worker import contact_interval
        first, second = self.session['frames']
        first['health'] = {'contact_force_n': None, 'contact_interval': None}
        first['post_action'] = {'time': .2, 'contact': contact_interval([1., 4.], 0., .2)}
        second['health'] = {'contact_force_n': 4.,
                            'contact_interval': contact_interval([1., 4.], 0., .2)}
        self.assertFalse(by_id(get_sensor_snapshot(self.session, .199))['contact']['available'])
        contact = by_id(get_sensor_snapshot(self.session, .2))['contact']
        self.assertEqual(contact['payload']['force_n'], 4.)
        self.assertEqual(contact['payload']['interval']['samples_n'], [1., 4.])
        self.assertEqual(contact['source_time'], .2)
        self.assertEqual(contact['age_ms'], 0.)
        self.assertEqual(contact['provenance']['source_field'], 'frames.health.contact_interval')
        second['health']['contact_interval'] = contact_interval([999.], .2, .22)
        self.assertFalse(by_id(get_sensor_snapshot(self.session, .21))['contact']['available'])

    def test_sensor_and_map_capture_times_are_separate_and_causal(self):
        self.session["perception"] = {"available": True, "kind": "time-series", "frames": [
            {"time": .2, "sensor_capture_time": .1, "map_time": .2, "frame_id": "world",
             "classification": "estimated", "raw_lidar": [[1., 0., 0.]],
             "filtered_lidar": [], "support_points": [[1., 0., 0.]], "ceiling_points": [],
             "self_removed": 1, "self_filter": True,
             "raw_lidar_basis": "simulated ray returns registered in world"},
            {"time": .4, "sensor_capture_time": .3, "map_time": .4, "frame_id": "world",
             "raw_lidar": [[2., 0., 0.]], "support_points": [[2., 0., 0.]]}]}
        early = by_id(get_sensor_snapshot(self.session, .19))
        self.assertFalse(early["map_support"]["available"])
        sample = by_id(get_sensor_snapshot(self.session, .25))
        self.assertEqual(sample["lidar_raw"]["payload"]["points"], [[1., 0., 0.]])
        self.assertEqual(sample["map_support"]["payload"]["points"], [[1., 0., 0.]])
        self.assertEqual(sample["lidar_filtered"]["payload"]["points"], [])
        self.assertTrue(sample["lidar_filtered"]["available"])
        self.assertAlmostEqual(sample["lidar_raw"]["age_ms"], 150)
        self.assertAlmostEqual(sample["map_support"]["age_ms"], 50)
        self.assertEqual(sample["lidar_raw"]["label"], "Simulated ray returns")
        self.assertTrue(sample["lidar_raw"]["overlay_compatible"])
        self.assertEqual(by_id(get_sensor_snapshot(self.session, 2.))["map_support"]["status"], "stale")

    def test_privileged_run_reports_every_mid360_and_map_sensor_unavailable_by_design(self):
        privileged = dict(self.session, metadata=dict(self.session["metadata"], privileged_map=True))
        sensors = by_id(get_sensor_snapshot(privileged, .2))
        for key in ("lidar_raw", "lidar_registered", "lidar_filtered", "lidar_imu", "map_support", "map_ceiling"):
            self.assertFalse(sensors[key]["available"], key)
            self.assertTrue(sensors[key]["reason"].startswith("Unavailable by design"), key)
        # The pelvis IMU is a different sensor: still just not recorded, never "by design".
        self.assertNotIn("by design", sensors["imu"]["reason"])

    def test_debug_does_not_invent_position_or_imu(self):
        wire = b"g1_debug" + msgpack.packb({"index": 1, "body_q": [.2] * 29,
                                           "base_quat": [1., 0., 0., 0.],
                                           "base_trans_measured": [0., -1., .793]})
        envelope = decode_packet(wire, b"g1_debug", receipt_monotonic=10., receipt_unix=100.)
        empty = {"metadata": {"mode": "replay"}, "frames": []}
        sensors = by_id(get_sensor_snapshot(empty, 0., capture_envelopes=[{"time": 0., "envelope": envelope}]))
        self.assertIsNone(sensors["base_pose"]["payload"]["position"])
        self.assertFalse(sensors["base_pose"]["overlay_compatible"])
        self.assertFalse(sensors["imu"]["available"])
        self.assertEqual(sensors["joints"]["classification"], "measured")
        self.assertEqual(sensors["joints"]["receipt_time"], 10.)
        self.assertIsNone(sensors["joints"]["source_time"])

    def test_live_single_snapshot_preserves_mount_and_roundoff_stamp(self):
        self.session["perception"] = {
            "available": True, "kind": "synchronized-map-snapshot", "time": 0.,
            "sensor_capture_time": 2.7755575615628914e-16, "map_time": 0., "frame_id": "world",
            "raw_lidar": [[1., 0., 0.]], "filtered_lidar": [], "support_points": [[1., 0., 0.]],
            "sensor_origin": [.1, .2, .3], "origin": [-6., -6.], "grid_shape": [2, 2],
            "support_observed_indices": [0], "observed_cells": {"support": 1},
            "extrinsics": [{"parent_frame": "pelvis", "position_m": [.1, .2, .3]}]}
        rows = by_id(get_sensor_snapshot(self.session, 0.))
        self.assertEqual(rows["lidar_raw"]["source_time"], 2.7755575615628914e-16)
        self.assertEqual(rows["lidar_raw"]["age_ms"], 0.)
        self.assertEqual(rows["lidar_raw"]["payload"]["origin"], [.1, .2, .3])
        self.assertEqual(rows["map_support"]["payload"]["origin"], [-6., -6.])
        self.assertEqual(rows["map_support"]["payload"]["observed_indices"], [0])
        self.assertTrue(rows["lidar_raw"]["extrinsics"]["available"])
        self.assertEqual(rows["lidar_raw"]["extrinsics"]["classification"], "configured-simulator-mount")

    def test_explicit_simulator_imu_joint_velocity_and_command_stay_causal(self):
        frame = self.session["frames"][1]
        frame["joint_velocity_rad_s"] = [.7]
        frame["command"] = {"joints": [.9], "classification": "commanded", "time": .2,
                            "kind": "SONIC PD position targets", "hardware_command": False}
        frame["imu"] = {"quaternion_wxyz": [.5, .5, .5, .5],
                        "angular_velocity_rad_s": [.2, -.3, .4], "frame_id": "pelvis",
                        "classification": "simulator-ground-truth", "linear_acceleration_m_s2": None}
        self.session["metadata"]["control_contract"] = {
            "joint_names": ["unselected_joint", "test_joint"], "kp_nm_per_rad": [999., 42.],
            "kd_nm_per_rad_s": [999., 2.], "effort_limit_nm": [999., 55.]}
        before = by_id(get_sensor_snapshot(self.session, .199))
        self.assertFalse(before["imu"]["available"])
        self.assertIsNone(before["joints"]["payload"]["commanded_position"])
        rows = by_id(get_sensor_snapshot(self.session, .25))
        imu, joints = rows["imu"], rows["joints"]
        self.assertTrue(imu["available"])
        self.assertEqual(imu["classification"], "simulator-ground-truth")
        self.assertEqual(imu["source_time"], .2)
        self.assertAlmostEqual(imu["age_ms"], 50)
        self.assertEqual(imu["payload"]["quaternion_wxyz"], [.5, .5, .5, .5])
        self.assertEqual(imu["payload"]["angular_velocity_rad_s"], [.2, -.3, .4])
        self.assertEqual(imu["payload"]["orientation_parent_frame"], "world")
        self.assertEqual(imu["payload"]["orientation_child_frame"], "pelvis")
        self.assertEqual(imu["payload"]["angular_velocity_frame"], "pelvis")
        self.assertIsNone(imu["payload"]["linear_acceleration_m_s2"])
        self.assertFalse(imu["payload"]["physical_sensor_packet"])
        self.assertEqual(joints["payload"]["velocity"], [.7])
        self.assertEqual(joints["payload"]["commanded_position"], [.9])
        self.assertEqual(joints["payload"]["kp_nm_per_rad"], [42.])
        self.assertEqual(joints["payload"]["kd_nm_per_rad_s"], [2.])
        self.assertEqual(joints["payload"]["effort_limit_nm"], [55.])
        self.assertIsNone(joints["payload"]["effort"])
        self.assertEqual(by_id(get_sensor_snapshot(self.session, .4))["imu"]["status"], "stale")
        json.dumps(rows, allow_nan=False)

    def test_catalog_omits_payloads_and_malformed_clock_rejected(self):
        self.assertTrue(all(row["payload"] is None for row in get_sensor_catalog(self.session)["sensors"]))
        for cursor in (float("nan"), float("inf"), True):
            with self.assertRaises(ReplayError):
                get_sensor_snapshot(self.session, cursor)
        self.session["perception"] = {"available": True, "kind": "time-series", "frames": [{"time": 2.}, {"time": 1.}]}
        with self.assertRaises(ReplayError):
            get_sensor_snapshot(self.session, 3.)


@unittest.skipUnless((DEFAULT_DDS_SESSION / "node_memory.npz").is_file(), "designated DDS rehearsal unavailable")
class RecordedSensorParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session = load_session(DEFAULT_DDS_SESSION)

    def test_real_dex3_state_contact_map_and_clock_values(self):
        addresses = list(self.session["metadata"]["joint_qpos_addresses"].values())
        with np.load(DEFAULT_DDS_SESSION / "sim.npz", allow_pickle=False) as raw:
            for index in (0, 313, 1921):
                frame = self.session["frames"][index]
                snapshot = get_sensor_snapshot(self.session, frame["time"])
                rows = by_id(snapshot)
                np.testing.assert_array_equal(rows["joints"]["payload"]["position"], raw["qpos"][index, addresses])
                np.testing.assert_array_equal(rows["base_pose"]["payload"]["position"], raw["root_pos"][2 * index])
                self.assertEqual(rows["contact"]["payload"]["force_n"], raw["contact_n"][2 * index])
                self.assertEqual(rows["base_pose"]["source_time"], raw["wall"][2 * index])
                self.assertIsNone(rows["imu"]["payload"])
                self.assertIsNone(rows["lidar_raw"]["payload"])
                self.assertEqual(rows["map_support"]["status"], "unsynchronized")
                json.dumps(snapshot, allow_nan=False)
        with np.load(DEFAULT_DDS_SESSION / "node_memory.npz", allow_pickle=False) as raw:
            rows = by_id(get_sensor_snapshot(self.session, 10.))
            self.assertEqual(rows["map_support"]["payload"]["observed_mask"], (~np.isnan(raw["support"])).tolist())
            for x, y, height in rows["map_support"]["payload"]["points"]:
                ix, iy = np.rint((np.array([x, y])-raw["lo"])/raw["res"]).astype(int)
                self.assertEqual(height, raw["support"][ix, iy])
            self.assertEqual(rows["map_ceiling"]["payload"]["clear_ceiling_cells"], int(np.isposinf(raw["ceiling"]).sum()))

    @unittest.skipUnless((DEFAULT_SESSION / "closed_loop.npz").is_file(), "designated lockstep unavailable")
    def test_lockstep_has_only_recorded_pose_and_joint_sensors(self):
        session = load_session(DEFAULT_SESSION)
        snapshot = get_sensor_snapshot(session, 1.)
        self.assertEqual(snapshot["available_sensor_ids"], ["base_pose", "joints"])


@unittest.skipUnless(FRESH_SESSION.is_file(), "fresh instrumented CPU rehearsal unavailable")
class FreshWorkerSensorParityTests(unittest.TestCase):
    def test_recorded_imu_velocity_targets_gains_and_time_exactly_preserved(self):
        session = json.loads(FRESH_SESSION.read_text())
        if not session["frames"][0].get("imu"):
            self.skipTest("designated fresh artifact predates explicit IMU instrumentation")
        for index in (0, len(session["frames"]) // 2, len(session["frames"]) - 1):
            frame = session["frames"][index]
            rows = by_id(get_sensor_snapshot(session, frame["time"] + .001))
            imu, joints = rows["imu"], rows["joints"]
            self.assertEqual(imu["classification"], "simulator-ground-truth")
            self.assertEqual(imu["source_time"], frame["source_time"])
            self.assertEqual(imu["receipt_time"], frame["receipt_time"])
            self.assertAlmostEqual(imu["age_ms"], 1.)
            self.assertEqual(imu["payload"]["quaternion_wxyz"], frame["imu"]["quaternion_wxyz"])
            self.assertEqual(imu["payload"]["angular_velocity_rad_s"], frame["imu"]["angular_velocity_rad_s"])
            self.assertIsNone(imu["payload"]["linear_acceleration_m_s2"])
            self.assertFalse(imu["payload"]["physical_sensor_packet"])
            self.assertEqual(joints["payload"]["velocity"], frame["joint_velocity_rad_s"])
            self.assertEqual(joints["payload"]["commanded_position"], frame["command"]["joints"])
            for key in ("kp_nm_per_rad", "kd_nm_per_rad_s", "effort_limit_nm"):
                self.assertEqual(joints["payload"][key], session["metadata"].get("control_contract", {}).get(key))
            self.assertIsNone(joints["payload"]["effort"])


@unittest.skipUnless((FLOW_ROOT / "g1deploy/zmq_stream.py").is_file(), "Flow serializer unavailable")
class WireSensorParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Execute only the inspected pure pack function, not the deployment module.
        tree = ast.parse((FLOW_ROOT / "g1deploy/zmq_stream.py").read_text())
        func = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "pack")
        namespace = {"np": np, "json": json, "TOPIC": b"pose", "HEADER_SIZE": 1280}
        exec(compile(ast.Module(body=[func], type_ignores=[]), "actual-flow-packer", "exec"), namespace)
        cls.pack = staticmethod(namespace["pack"])

    def capture(self, directory, wire, topic):
        path = Path(directory) / "capture.jsonl"
        envelope = decode_packet(wire, topic, receipt_monotonic=12., receipt_unix=1000.)
        envelope["wire_base64"] = base64.b64encode(wire).decode()
        start = {"record": "capture_start", "schema_version": 1,
                 "receipt_clock": "collector_host_monotonic", "receipt_timestamp": 10.}
        path.write_text(json.dumps(start) + "\n" + json.dumps(envelope) + "\n")
        return path

    def test_actual_packer_bytes_redecoded_not_trusting_saved_payload(self):
        # Real observed map heights are used as representative cloud payload;
        # this checks transport decoding, not a claim of raw LiDAR history.
        with np.load(DEFAULT_DDS_SESSION / "node_memory.npz", allow_pickle=False) as raw:
            ix, iy = np.nonzero(np.isfinite(raw["support"]))
            points = np.column_stack((raw["lo"][0]+ix*raw["res"], raw["lo"][1]+iy*raw["res"], raw["support"][ix, iy])).astype(np.float32)
        wire = self.pack([("points", points), ("origin", np.array([0., 0., 1.])),
                          ("stamp", np.array([11.]))], topic=b"cloud")
        with tempfile.TemporaryDirectory() as tmp:
            path = self.capture(tmp, wire, b"cloud")
            lines = [json.loads(line) for line in path.read_text().splitlines()]
            lines[1]["payload"]["fields"]["points"] = [[999, 999, 999]]
            path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
            capture = load_sensor_capture(path)
        empty = {"metadata": {"mode": "replay"}, "frames": []}
        before = by_id(get_sensor_snapshot(empty, 1.9, capture_envelopes=capture["envelopes"]))
        self.assertFalse(before["lidar_registered"]["available"])
        rows = by_id(get_sensor_snapshot(empty, 2., capture_envelopes=capture["envelopes"]))
        sensor = rows["lidar_registered"]
        stride = max(1, int(np.ceil(len(points)/5000)))
        np.testing.assert_array_equal(sensor["payload"]["points"], points[::stride])
        self.assertFalse(sensor["overlay_compatible"])
        self.assertTrue(sensor["provenance"]["wire_redecoded"])
        self.assertEqual(sensor["sample_time_s"], 2.)
        self.assertEqual(sensor["source_time"], 11.)
        self.assertEqual(sensor["receipt_time"], 12.)
        self.assertFalse(rows["lidar_raw"]["available"])

    def test_missing_or_corrupted_wire_is_rejected(self):
        wire = self.pack([("pos", np.array([1., 2., 3.])), ("quat_wxyz", np.array([1., 0., 0., 0.]))], topic=b"odom")
        for replacement in (None, "invalid base64"):
            with tempfile.TemporaryDirectory() as tmp:
                path = self.capture(tmp, wire, b"odom")
                lines = [json.loads(line) for line in path.read_text().splitlines()]
                lines[1]["wire_base64"] = replacement
                path.write_text("\n".join(json.dumps(line) for line in lines))
                with self.assertRaises(ReplayError):
                    load_sensor_capture(path)


if __name__ == "__main__":
    unittest.main()
