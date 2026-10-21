"""Read-only decoders for inspected SONIC/Flow wire contracts.

No socket creation, controller import, or command publisher lives here. See
``docs/INTERFACES.md`` for source identities and observability limits.
"""
from __future__ import annotations

import json
import math
import time

HEADER_SIZE = 1280
MAX_PACKET_BYTES = 8 * 1024 * 1024
MAX_ELEMENTS = 1_000_000
MJ_JOINTS = tuple(
    [f"{side}_{name}_joint" for side in ("left", "right")
     for name in ("hip_pitch", "hip_roll", "hip_yaw", "knee", "ankle_pitch", "ankle_roll")]
    + [f"waist_{name}_joint" for name in ("yaw", "roll", "pitch")]
    + [f"{side}_{name}_joint" for side in ("left", "right")
       for name in ("shoulder_pitch", "shoulder_roll", "shoulder_yaw", "elbow", "wrist_roll", "wrist_pitch", "wrist_yaw")]
)
ISAAC_TO_MJ = (0, 6, 12, 1, 7, 13, 2, 8, 14, 3, 9, 15, 22, 4, 10, 16, 23, 5, 11, 17, 24, 18, 25, 19, 26, 20, 27, 21, 28)
ISAAC_JOINTS = tuple(MJ_JOINTS[i] for i in ISAAC_TO_MJ)
_DTYPES = {"f32": "<f4", "f64": "<f8", "i32": "<i4", "i64": "<i8", "u8": "u1", "bool": "?"}
ALLOWED_TOPICS = (b"g1_debug", b"robot_config", b"pose", b"cloud", b"odom")


class ProtocolError(ValueError):
    """Malformed or unsupported input; never substitute a healthy default."""


def _finite_tree(value):
    if isinstance(value, dict):
        return all(isinstance(k, str) and _finite_tree(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return all(_finite_tree(v) for v in value)
    return isinstance(value, (str, bool, int, type(None))) or isinstance(value, float) and math.isfinite(value)


def decode_packed(message: bytes, topic: bytes):
    """Decode Flow's v1 single-part framing; return header and NumPy arrays.

    Reject unsupported versions/endian/dtypes, duplicate names, nonfinite data,
    mismatched lengths and excessive shapes before allocating JSON payloads.
    """
    import numpy as np

    if not isinstance(message, bytes) or len(message) > MAX_PACKET_BYTES:
        raise ProtocolError("invalid or oversized packet")
    if not message.startswith(topic) or len(message) < len(topic) + HEADER_SIZE:
        raise ProtocolError("topic mismatch or truncated 1280-byte header")
    raw_header = message[len(topic):len(topic) + HEADER_SIZE]
    try:
        header = json.loads(raw_header.rstrip(b"\0"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProtocolError("invalid padded JSON header") from exc
    if (not isinstance(header, dict) or type(header.get("v")) is not int
            or header.get("v") != 1 or header.get("endian") != "le"):
        raise ProtocolError("only verified Flow protocol v1 little-endian is supported")
    if type(header.get("count")) is not int or not 0 <= header["count"] <= MAX_ELEMENTS:
        raise ProtocolError("invalid count")
    specs = header.get("fields")
    if not isinstance(specs, list) or not specs or len(specs) > 64:
        raise ProtocolError("invalid fields")
    offset, fields, total = len(topic) + HEADER_SIZE, {}, 0
    for spec in specs:
        if not isinstance(spec, dict):
            raise ProtocolError("invalid field descriptor")
        name, dtype, shape = spec.get("name"), spec.get("dtype"), spec.get("shape")
        if not isinstance(name, str) or not name or len(name) > 128 or name in fields:
            raise ProtocolError("invalid or duplicate field name")
        if not isinstance(dtype, str) or dtype not in _DTYPES or not isinstance(shape, list) or not 1 <= len(shape) <= 4:
            raise ProtocolError("unsupported dtype or shape")
        if any(type(d) is not int or d < 0 or d > MAX_ELEMENTS for d in shape):
            raise ProtocolError("invalid array dimension")
        n = math.prod(shape)
        total += n
        if total > MAX_ELEMENTS:
            raise ProtocolError("too many array elements")
        dt = np.dtype(_DTYPES[dtype])
        size = n * dt.itemsize
        if offset + size > len(message):
            raise ProtocolError("truncated field payload")
        arr = np.frombuffer(message, dtype=dt, count=n, offset=offset).reshape(shape)
        if not np.isfinite(arr).all():
            raise ProtocolError("nonfinite field data")
        fields[name] = arr
        offset += size
    if offset != len(message):
        raise ProtocolError("trailing payload bytes")
    return header, fields


def decode_pose(message: bytes):
    """Return exact named reference frames without inventing root translation."""
    header, fields = decode_packed(message, b"pose")
    count = header["count"]
    if count < 1:
        raise ProtocolError("empty reference chunk")
    for name, shape in (("joint_pos", (count, 29)), ("joint_vel", (count, 29)),
                        ("body_quat", (count, 4)), ("frame_index", (count,))):
        if name not in fields or fields[name].shape != shape:
            raise ProtocolError(f"missing or malformed {name}")
        if name != "frame_index" and fields[name].dtype.kind != "f":
            raise ProtocolError(f"{name} must contain floating-point values")
    frames = fields["frame_index"]
    if frames.dtype.kind not in "iu" or (frames[1:] <= frames[:-1]).any():
        raise ProtocolError("frame indices must be increasing integers")
    quats = fields["body_quat"]
    if ((quats * quats).sum(axis=1) < 1e-12).any():
        raise ProtocolError("zero reference quaternion")
    stamp = fields.get("timestamp_monotonic")
    if stamp is not None and stamp.shape != (1,):
        raise ProtocolError("timestamp_monotonic must have shape [1]")
    return {
        "schema": "flow.pose.v1", "sequence": None,
        "source_timestamp": None if stamp is None else float(stamp[0]),
        "source_clock": "source_host_monotonic" if stamp is not None else "unknown",
        "frame_id": "runner_heading_relative", "kind": "reference",
        "joint_names": list(ISAAC_JOINTS), "units": {"joint_pos": "rad", "joint_vel": "rad/s"},
        "quaternion_convention": "wxyz", "header": header,
        "fields": {name: arr.tolist() for name, arr in fields.items()},
        "root_translation": None,
        "observability": {"playback_cursor": None, "token_state": None,
                          "configured_lookahead_frames": 10, "configured_lookahead_stride_frames": 5,
                          "configured_policy_period_s": 0.02,
                          "note": "Reference chunk frames are not a packet sequence or the runner playback cursor."},
    }


def _vector(fields, name, length=None):
    value = fields.get(name)
    if value is None:
        return None
    if not isinstance(value, list) or (length is not None and len(value) != length):
        raise ProtocolError(f"invalid {name} vector length")
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in value):
        raise ProtocolError(f"invalid {name} numeric vector")
    return value


def decode_debug(message: bytes, topic: bytes = b"g1_debug"):
    """Decode C++ output, preserving the distinction between state and targets.

    The runner's ``base_trans_measured`` is a fixed visualization placement,
    so it is retained only in raw fields and never promoted to localization.
    """
    import msgpack

    if topic not in (b"g1_debug", b"robot_config"):
        raise ProtocolError("unsupported SONIC debug topic")
    if not message.startswith(topic) or len(message) > MAX_PACKET_BYTES:
        raise ProtocolError("topic mismatch or oversized packet")
    try:
        fields = msgpack.unpackb(message[len(topic):], raw=False, strict_map_key=True,
                                 max_array_len=MAX_ELEMENTS, max_map_len=256,
                                 max_str_len=65536, max_bin_len=MAX_PACKET_BYTES)
    except (ValueError, TypeError, msgpack.UnpackException) as exc:
        raise ProtocolError("invalid msgpack map") from exc
    if not isinstance(fields, dict) or not _finite_tree(fields):
        raise ProtocolError("debug data must be a finite string-keyed map")
    if topic == b"robot_config":
        return {"schema": "sonic.robot_config.unversioned", "sequence": None,
                "source_timestamp": None, "source_clock": "unknown", "frame_id": None,
                "kind": "configuration", "fields": fields}
    seq = fields.get("index")
    if type(seq) is not int or seq < 0:
        raise ProtocolError("missing or invalid state logger index")
    for name in ("body_q", "body_dq", "body_q_measured", "body_q_target", "last_action"):
        _vector(fields, name, 29)
    for name in ("base_quat", "body_torso_quat", "base_quat_measured", "base_quat_target", "init_base_quat"):
        q = _vector(fields, name, 4)
        if q is not None and sum(x*x for x in q) < 1e-12:
            raise ProtocolError(f"zero {name}")
    tokens = _vector(fields, "token_state")
    stamp = fields.get("ros_timestamp")
    if stamp is not None and (type(stamp) not in (int, float) or stamp < 0):
        raise ProtocolError("invalid ROS timestamp")
    measured = fields.get("body_q_measured", fields.get("body_q"))
    return {
        "schema": "sonic.g1_debug.unversioned", "sequence": seq,
        "source_timestamp": stamp if stamp and stamp > 0 else None,
        "source_clock": "ros_clock_unverified" if stamp and stamp > 0 else "unknown",
        "frame_id": "runner_heading_relative", "kind": "measured_and_commanded",
        "joint_names": list(MJ_JOINTS), "quaternion_convention": "wxyz",
        "units": {"joint_position": "rad", "joint_velocity": "rad/s"}, "fields": fields,
        "measured": {"joint_position": measured, "joint_velocity": fields.get("body_dq"),
                     "root_orientation": fields.get("base_quat_measured", fields.get("base_quat")),
                     "root_translation": None},
        "reference": {"joint_position": fields.get("body_q_target"),
                      "root_orientation": fields.get("base_quat_target"),
                      "validity": "unknown_motion_validity_not_exported"},
        "commanded": {"joint_position": fields.get("last_action"),
                      "kind": "scaled_policy_action_not_observed_dds_lowcmd"},
        "intent": {"representation": "continuous_encoder_or_external_vector" if tokens else "unavailable",
                   "values": tokens if tokens else None, "shape": [len(tokens)] if tokens else None,
                   "semantic_labels": None, "playback_cursor": None},
        "limitations": ["base_trans_measured is a fixed display offset, not localization",
                        "target arrays may be defaults when no valid motion is active",
                        "policy action telemetry does not prove delivery of a DDS motor command",
                        "wire schema has no explicit version and no source timestamp when ROS timestamp is zero"],
    }


def decode_packed_topic(message: bytes, topic: bytes):
    """Validated NumPy arrays of a packed `cloud` or `odom` message, without decimation.

    This is the wire the LIO bridge (`g1deploy/adapters/ros2_lio_bridge.py`) and the
    simulator send: `odom` = pos [3], quat_wxyz [4] (+ lin_w, ang_w, stamp [1]);
    `cloud` = points [N,3], origin [3], stamp [1]. The frame and the stamp's clock
    are not on the wire; callers label them from their configuration.
    """
    if topic not in (b"cloud", b"odom"):
        raise ProtocolError("packed topic must be cloud or odom")
    header, fields = decode_packed(message, topic)
    stamp = fields.get("stamp")
    if stamp is not None and stamp.shape != (1,):
        raise ProtocolError("stamp must have shape [1]")
    if topic == b"cloud":
        points = fields.get("points")
        if points is None or points.ndim != 2 or points.shape[1] != 3:
            raise ProtocolError("cloud points must have shape [N,3]")
        if "origin" in fields and fields["origin"].shape != (3,):
            raise ProtocolError("cloud origin must have shape [3]")
    else:
        for name, shape in (("pos", (3,)), ("quat_wxyz", (4,))):
            if name not in fields or fields[name].shape != shape:
                raise ProtocolError(f"odom {name} must have shape {shape}")
        if float((fields["quat_wxyz"] ** 2).sum()) < 1e-12:
            raise ProtocolError("zero odometry quaternion")
    return header, fields


def decode_packet(message: bytes, topic: bytes, *, receipt_monotonic=None, receipt_unix=None,
                  source_id="unspecified", session_id="capture"):
    """Attach receipt clocks and source provenance without assuming clock sync."""
    if topic not in ALLOWED_TOPICS:
        raise ProtocolError("topic is not allowlisted")
    if topic == b"pose":
        payload = decode_pose(message)
    elif topic in (b"g1_debug", b"robot_config"):
        payload = decode_debug(message, topic)
    else:
        header, fields = decode_packed_topic(message, topic)
        stamp = fields.get("stamp")
        decimation = None
        if topic == b"cloud":
            points = fields["points"]
            original_count = len(points)
            stride = max(1, math.ceil(original_count / 5000))
            fields["points"] = points[::stride]
            decimation = {"input_points": original_count, "output_points": len(fields["points"]),
                          "method": "uniform_stride", "stride": stride}
        payload = {"schema": f"flow.{topic.decode()}.v1", "sequence": None,
                   "source_timestamp": None if stamp is None else float(stamp[0]),
                   # The simulator packs simulation seconds in `stamp`; the
                   # LIO bridge packs host-monotonic forwarding time. Neither
                   # cloud nor odom includes a clock-domain tag on the wire.
                   "source_clock": "unknown",
                   "source_clock_note": "stamp has no clock-domain tag; producer configuration and alignment are required",
                   "frame_id": "source_world_unverified", "kind": "source_kind_unverified",
                   "visualization_decimation": decimation,
                   "header": header, "fields": {name: arr.tolist() for name, arr in fields.items()}}
    return {
        "schema_version": 1, "session_id": session_id, "backend_id": "sonic",
        "source_id": source_id, "topic": topic.decode(), "sequence": payload["sequence"],
        "source_timestamp": payload["source_timestamp"], "source_clock": payload["source_clock"],
        "receipt_timestamp": time.monotonic() if receipt_monotonic is None else receipt_monotonic,
        "receipt_clock": "collector_host_monotonic",
        "receipt_unix": time.time() if receipt_unix is None else receipt_unix,
        "frame_id": payload["frame_id"], "validity": "decoded",
        "provenance": {"transport": "zmq_subscription", "topic": topic.decode(),
                       "wire_bytes": len(message), "clock_alignment": "unverified",
                       "robot_model": "g1_29dof" if topic in (b"pose", b"g1_debug") else None,
                       "calibration_identity": None},
        "payload": payload,
    }
