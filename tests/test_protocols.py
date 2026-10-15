"""Decoder unit checks and parity with the actual read-only Flow serializer."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

import msgpack
import numpy as np

from studio.protocols import (HEADER_SIZE, ISAAC_JOINTS, MJ_JOINTS, ProtocolError,
                              decode_debug, decode_packet, decode_pose)

SOURCE = Path("/home/linjiw/code/g1-student-deploy/g1deploy")


def source_serializer():
    """Load only the two inspected pure protocol files, never deployment nodes."""
    package = "_studio_source_parity"
    if package + ".zmq_stream" in sys.modules:
        return sys.modules[package + ".zmq_stream"]
    pkg = types.ModuleType(package)
    pkg.__path__ = [str(SOURCE)]
    sys.modules[package] = pkg
    for name in ("contract", "zmq_stream"):
        spec = importlib.util.spec_from_file_location(package + "." + name, SOURCE / (name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        path = SOURCE / (name + ".py")
        exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    return module


@unittest.skipUnless((SOURCE / "zmq_stream.py").is_file(), "local Flow reference unavailable")
class ActualSourceParityTests(unittest.TestCase):
    def setUp(self):
        self.source = source_serializer()
        self.q = (np.arange(87).reshape(3, 29) / 100).astype(np.float32)
        self.dq = self.q * 2
        self.quat = np.array([[1, 0, 0, 0]] * 3, dtype=np.float32)
        self.packet = self.source.pose_message([10, 11, 12], self.q, self.dq, self.quat, timestamp=123.25)

    def test_exact_source_serializer_joint_names_framing_and_clocks(self):
        decoded = decode_pose(self.packet)
        header, original = self.source.unpack(self.packet)
        self.assertEqual(decoded["header"], header)
        self.assertEqual(tuple(MJ_JOINTS), self.source.C.MJ_JOINTS)
        self.assertEqual(tuple(ISAAC_JOINTS), self.source.C.ISAAC_JOINTS)
        for field, arr in original.items():
            np.testing.assert_array_equal(decoded["fields"][field], arr)
        for row in range(3):
            named = dict(zip(decoded["joint_names"], decoded["fields"]["joint_pos"][row]))
            for joint, expected in zip(MJ_JOINTS, self.q[row]):
                self.assertEqual(named[joint], expected)
        self.assertEqual(decoded["source_timestamp"], 123.25)
        self.assertIsNone(decoded["sequence"])
        self.assertIsNone(decoded["root_translation"])
        event = decode_packet(self.packet, b"pose", receipt_monotonic=200, receipt_unix=1000)
        self.assertEqual(event["receipt_clock"], "collector_host_monotonic")
        self.assertEqual(event["source_clock"], "source_host_monotonic")
        self.assertEqual(event["provenance"]["clock_alignment"], "unverified")

    def test_truncated_trailing_and_wrong_topic_rejected(self):
        for packet in (self.packet[:-1], self.packet + b"extra", b"fake" + self.packet[4:], b"pose{}"):
            with self.subTest(size=len(packet)), self.assertRaises(ProtocolError):
                decode_pose(packet)

    def test_bad_header_version_endian_and_shapes_rejected(self):
        header = json.loads(self.packet[4:4+HEADER_SIZE].rstrip(b"\0"))
        mutations = [{"v": 2}, {"endian": "be"}, {"count": 6}, {"count": -1},
                     {"fields": [{"name": "bad", "dtype": "f32", "shape": [10**9]}]}]
        for mutation in mutations:
            changed = dict(header, **mutation)
            packet = b"pose" + json.dumps(changed).encode().ljust(HEADER_SIZE, b"\0") + self.packet[4+HEADER_SIZE:]
            with self.subTest(mutation=mutation), self.assertRaises(ProtocolError):
                decode_pose(packet)

    def test_nonfinite_and_nonmonotonic_reference_rejected(self):
        q = self.q.copy()
        q[0, 0] = float("nan")
        for frames, positions in (([1, 2, 3], q), ([3, 2, 1], self.q)):
            packet = self.source.pose_message(frames, positions, self.dq, self.quat)
            with self.assertRaises(ProtocolError):
                decode_pose(packet)

    def test_actual_cloud_packer_decimates_without_inventing_unknown_space(self):
        points = np.arange(18003, dtype=np.float32).reshape(6001, 3)
        packet = self.source.pack([("points", points), ("origin", np.array([1., 2., 3.])),
                                   ("stamp", np.array([120.]))], topic=b"cloud")
        event = decode_packet(packet, b"cloud")
        payload = event["payload"]
        np.testing.assert_array_equal(payload["fields"]["points"], points[::2])
        self.assertEqual(payload["visualization_decimation"]["input_points"], 6001)
        self.assertEqual(payload["kind"], "source_kind_unverified")
        self.assertNotIn("occupancy", payload)

    def test_actual_odometry_packer_preserves_values_but_not_unverified_world_frame(self):
        packet = self.source.pack([("pos", np.array([1., 2., 3.])),
                                   ("quat_wxyz", np.array([1., 0., 0., 0.])),
                                   ("stamp", np.array([120.]))], topic=b"odom")
        event = decode_packet(packet, b"odom")
        self.assertEqual(event["payload"]["fields"]["pos"], [1., 2., 3.])
        self.assertEqual(event["frame_id"], "source_world_unverified")


class DebugTests(unittest.TestCase):
    def packet(self, **extra):
        # Explicit protocol fixture, not a claim that the C++ runner executed.
        fields = {"index": 3, "ros_timestamp": 0.0, "body_q": [0.1] * 29,
                  "body_dq": [0.2] * 29, "last_action": [0.3] * 29,
                  "base_quat": [1, 0, 0, 0], "base_trans_measured": [0, -1, 0.793],
                  "token_state": [], **extra}
        return b"g1_debug" + msgpack.packb(fields)

    def test_placeholder_translation_and_missing_timestamp_are_not_measurements(self):
        result = decode_debug(self.packet())
        self.assertIsNone(result["measured"]["root_translation"])
        self.assertIsNone(result["source_timestamp"])
        self.assertIsNone(result["intent"]["values"])
        self.assertEqual(result["fields"]["base_trans_measured"], [0, -1, 0.793])
        self.assertEqual(result["commanded"]["kind"], "scaled_policy_action_not_observed_dds_lowcmd")

    def test_float_tokens_preserved_without_labels(self):
        result = decode_debug(self.packet(token_state=[0.1, -0.5, 0.9]))
        self.assertEqual(result["intent"]["shape"], [3])
        self.assertEqual(result["intent"]["values"], [0.1, -0.5, 0.9])
        self.assertIsNone(result["intent"]["semantic_labels"])

    def test_invalid_debug_values_do_not_turn_into_defaults(self):
        for extra in ({"body_q": [1]*23}, {"index": -1}, {"base_quat": [0]*4},
                      {"body_dq": [float("inf")]*29}):
            with self.subTest(extra=extra), self.assertRaises(ProtocolError):
                decode_debug(self.packet(**extra))

    def test_robot_configuration_has_unknown_time(self):
        event = decode_packet(b"robot_config" + msgpack.packb({"policy": "test"}), b"robot_config")
        self.assertIsNone(event["source_timestamp"])
        self.assertEqual(event["payload"]["kind"], "configuration")
