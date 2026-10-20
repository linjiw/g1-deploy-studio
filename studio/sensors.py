"""Read-only sensor views of normalized replay and captured telemetry.

This module opens no sockets, starts no simulator, and never derives missing
sensor measurements from animation. Simulator poses remain simulator truth;
an accumulated map is never assigned the replay cursor's timestamp.
"""
from __future__ import annotations

import base64
import binascii
import bisect
import math
from pathlib import Path

from .capture_replay import _read_events
from .protocols import ProtocolError, decode_packet
from .replay import ReplayError, frame_at

MAX_SENSOR_POINTS = 5000
MAX_SENSOR_ENVELOPES = 10000

_SPECS = (
    ("base_pose", "Robot base pose", "pose", "robot"),
    ("joints", "Named joint positions", "joint_state", "joints"),
    ("contact", "Obstacle contact force", "force", "scalar"),
    ("map_support", "Observed support map", "map", "points"),
    ("map_ceiling", "Observed ceiling map", "map", "points"),
    ("lidar_raw", "MID-360 raw scan", "point_cloud", "points"),
    ("lidar_registered", "Registered cloud stream", "point_cloud", "points"),
    ("lidar_filtered", "Robot-filtered LiDAR", "point_cloud", "points"),
    ("odometry", "Localization / odometry", "pose", "pose"),
    ("imu", "Pelvis IMU", "imu", "orientation"),
    ("lidar_imu", "MID-360 IMU", "imu", "orientation"),
    ("rgb_camera", "RGB camera", "image", "image"),
    ("depth_camera", "Depth camera", "image", "image"),
)

_MISSING = {
    "base_pose": "No world-space robot pose was recorded.",
    "joints": "No measured joint state was recorded.",
    "contact": "No obstacle contact-force sample was recorded.",
    "map_support": "No support-map snapshot was recorded.",
    "map_ceiling": "No ceiling-map snapshot was recorded.",
    "lidar_raw": "Raw MID-360 packets were not recorded; a final map cannot reconstruct them.",
    "lidar_registered": "No registered cloud packets were recorded.",
    "lidar_filtered": "No cloud after robot self-filtering was recorded.",
    "odometry": "No odometry packets were recorded; simulator truth is shown separately.",
    "imu": "Pelvis IMU packets, gyroscope and acceleration were not recorded.",
    "lidar_imu": "MID-360 IMU packets were not recorded.",
    "rgb_camera": "No RGB camera frames or calibration were recorded.",
    "depth_camera": "No depth camera frames or calibration were recorded.",
}


def _empty(sensor_id, label, kind, render_hint):
    return {
        "id": sensor_id, "label": label, "kind": kind, "render_hint": render_hint,
        "available": False, "status": "unavailable", "classification": "unavailable",
        "frame_id": None, "source_time": None, "source_clock": None,
        "receipt_time": None, "receipt_clock": None, "sample_time_s": None,
        "age_ms": None, "rate_hz": None, "rate_basis": None, "sequence": None,
        "synchronized": False, "validity": "unavailable", "units": {},
        "extrinsics": {"available": False, "calibration_identity": None,
                       "reason": "No recorded sensor extrinsic calibration."},
        "provenance": {}, "payload": None, "reason": _MISSING[sensor_id],
        "can_pin": False, "overlay_compatible": False,
    }


def _provenance(session, suffix):
    metadata = session.get("metadata", {})
    artifacts = metadata.get("provenance", {}).get("artifacts", [])
    artifact = next((a for a in artifacts if suffix and a.get("path", "").endswith(suffix)), None)
    return {"adapter": "studio.sensors.v1", "session_source": metadata.get("source_path"),
            "artifact": artifact, "source_field": suffix,
            "model_variant": metadata.get("model_variant"),
            "calibration_identity": metadata.get("calibration_identity")}


def _finite(value):
    return type(value) in (float, int) and math.isfinite(value)


def _vector(value, size):
    return isinstance(value, (list, tuple)) and len(value) == size and all(_finite(v) for v in value)


def _named_values(values, source_names, target_names):
    """Reorder numeric controller metadata by joint name, never by width alone."""
    if (not isinstance(source_names, list) or len(set(source_names)) != len(source_names)
            or not _vector(values, len(source_names)) or not set(target_names) <= set(source_names)):
        return None
    named = dict(zip(source_names, values))
    return [named[name] for name in target_names]


def _rate(frames, cursor):
    # Causal bounded receive/sample window. This is recording rate, not DDS rate.
    selected = [f["time"] for f in frames if f["time"] <= cursor][-128:]
    if len(selected) < 2 or selected[-1] <= selected[0]:
        return None
    return (len(selected) - 1) / (selected[-1] - selected[0])


def _points(values):
    if not isinstance(values, list) or any(not _vector(p, 3) for p in values):
        raise ReplayError("Sensor cloud must contain finite xyz triples")
    stride = max(1, math.ceil(len(values) / MAX_SENSOR_POINTS))
    return values[::stride], {"input_points": len(values), "output_points": len(values[::stride]),
                            "stride": stride, "method": "uniform_stride"}


def _recorded_state(session, time_s, sensors):
    frames = session.get("frames", [])
    selected = frame_at({"frames": frames}, time_s) if frames else {"frame": None}
    frame = selected["frame"]
    if frame is None:
        return
    metadata = session.get("metadata", {})
    source_file = "sim.npz" if metadata.get("recording_kind") == "sonic-cpp-dds-rehearsal" else "closed_loop.npz"
    common = {
        "available": True, "status": selected["status"], "validity": frame.get("validity", "unknown"),
        "classification": frame.get("classification", "unknown"), "frame_id": frame.get("frame_id"),
        "source_time": frame.get("source_time"), "source_clock": frame.get("source_clock_domain"),
        "receipt_time": frame.get("receipt_time"), "receipt_clock": frame.get("receipt_clock_domain"),
        "sample_time_s": frame["time"], "age_ms": selected["age_ms"],
        "rate_hz": _rate(frames, time_s), "rate_basis": "recorded state samples; not middleware message rate",
        "sequence": frame.get("sequence"), "synchronized": True, "reason": None,
        "provenance": _provenance(session, source_file), "can_pin": True,
    }
    if _vector(frame.get("position"), 3) and _vector(frame.get("quaternion_wxyz"), 4):
        sensors["base_pose"].update(common, units={"position": "m", "quaternion": "wxyz"},
                                   overlay_compatible=frame.get("frame_id") == metadata.get("frame_id"),
                                   payload={"position": frame["position"], "quaternion_wxyz": frame["quaternion_wxyz"],
                                            "sim_time": frame.get("sim_time")})
    names, joints = session.get("joint_names", []), frame.get("joints")
    if names and _vector(joints, len(names)):
        velocity = frame.get("joint_velocity_rad_s")
        command = frame.get("command") or {}
        command_time = command.get("time")
        command_values = _named_values(command.get("joints"), command.get("joint_names", names), names)
        if not _finite(command_time) or command_time > time_s + 1e-9:
            command_values = None
        control = metadata.get("control_contract", {})
        control_names = control.get("joint_names")
        sensors["joints"].update(common, units={"position": "rad", "velocity": "rad/s"},
                                overlay_compatible=True,
                                payload={"joint_names": names, "position": joints,
                                         "velocity": velocity if _vector(velocity, len(names)) else None,
                                         "effort": None, "faults": None,
                                         "commanded_position": command_values,
                                         "command_classification": command.get("classification") if command_values is not None else None,
                                         "command_kind": command.get("kind") if command_values is not None else None,
                                         "command_time_s": command_time if command_values is not None else None,
                                         "kp_nm_per_rad": _named_values(control.get("kp_nm_per_rad"), control_names, names),
                                         "kd_nm_per_rad_s": _named_values(control.get("kd_nm_per_rad_s"), control_names, names),
                                         "effort_limit_nm": _named_values(control.get("effort_limit_nm"), control_names, names),
                                         "command_note": "Recorded PD position targets; delivered DDS motor commands and applied torques are not inferred." if command_values is not None else None})
    imu = frame.get("imu") or {}
    orientation = imu.get("quaternion_wxyz")
    angular = imu.get("angular_velocity_rad_s")
    acceleration = imu.get("linear_acceleration_m_s2")
    if _vector(orientation, 4) or _vector(angular, 3) or _vector(acceleration, 3):
        classification = imu.get("classification", frame.get("classification", "unknown"))
        local_frame = imu.get("frame_id")
        is_truth = classification == "simulator-ground-truth"
        sensors["imu"].update(common,
            label="Pelvis IMU · simulator truth" if is_truth else "Pelvis IMU",
            classification=classification, frame_id=local_frame,
            units={"quaternion": "wxyz", "angular_velocity": "rad/s", "linear_acceleration": "m/s²"},
            overlay_compatible=False,
            provenance={**common["provenance"], "source_field": "frames.imu",
                        "measurement_basis": "sim.scene.measurement: MuJoCo qpos[3:7] and body qvel[3:6]" if is_truth else "recorded IMU fields"},
            reason="Simulator orientation and body angular velocity; no physical IMU packet or acceleration sample is claimed." if is_truth else None,
            payload={"quaternion_wxyz": orientation if _vector(orientation, 4) else None,
                     "angular_velocity_rad_s": angular if _vector(angular, 3) else None,
                     "linear_acceleration_m_s2": acceleration if _vector(acceleration, 3) else None,
                     "orientation_parent_frame": frame.get("frame_id"), "orientation_child_frame": local_frame,
                     "angular_velocity_frame": local_frame, "linear_acceleration_frame": local_frame,
                     "physical_sensor_packet": False if is_truth else None})
    contact = frame.get("health", {}).get("contact_force_n")
    interval = frame.get("health", {}).get("contact_interval")
    if interval is not None:
        # An interval ending after this pre-action pose is a future observation.
        # Do not expose it merely because it shares a serialized frame with the pose.
        if (not isinstance(interval, dict) or not _finite(interval.get("start_s"))
                or not _finite(interval.get("end_s")) or interval["start_s"] >= interval["end_s"]
                or interval["end_s"] > min(time_s, frame["time"]) + 1e-9):
            contact = None
    if _finite(contact):
        sensors["contact"].update(common, units={"force": "N"},
                                 payload={"force_n": contact,
                                          "interval": interval,
                                          "scope": "simulated obstacle contact; not a foot force/torque sensor"})
        if interval is not None:
            sensors["contact"].update(
                source_time=interval["end_s"], source_clock=interval.get("clock_domain"),
                sample_time_s=interval["end_s"], age_ms=max(0., time_s-interval["end_s"])*1000,
                reason="Maximum over the completed physics interval; the current action's future interval is excluded.",
                provenance={**_provenance(session, "physics_observations.npz"),
                            "source_field": "frames.health.contact_interval",
                            "measurement_basis": interval.get("basis")})


def _recorded_map(session, sensors):
    perception = session.get("perception") or {}
    if not perception.get("available") or perception.get("kind") in ("time-series", "synchronized-map-snapshot"):
        return
    # The only map supported by the recording adapter is a final snapshot with
    # no acquisition clock. Never make it fresh just because playback is moving.
    for layer in ("support", "ceiling"):
        values = perception.get(layer + "_points")
        if values is None:
            continue
        points, decimation = _points(values)
        sensor = sensors["map_" + layer]
        sensor.update({
            "available": True, "status": "unsynchronized", "validity": "snapshot_only",
            "classification": perception.get("classification", "estimated"),
            "frame_id": perception.get("frame_id"), "units": {"position": "m", "resolution": "m"},
            "source_time": perception.get("time"), "source_clock": None,
            "synchronized": False, "can_pin": True,
            "overlay_compatible": perception.get("frame_id") == session.get("metadata", {}).get("frame_id"),
            "reason": "Final accumulated map; capture timestamp and map history were not recorded.",
            "provenance": _provenance(session, "node_memory.npz"),
            "payload": {"points": points, "layer": layer, "grid_shape": perception.get("grid_shape"),
                        "origin": perception.get("origin"), "resolution_m": perception.get("resolution_m"),
                        "observed_mask": perception.get(layer + "_observed_mask"),
                        "observed_cells": perception.get("observed_cells", {}).get(layer),
                        "unknown_cells": perception.get("unknown_cells"),
                        "clear_ceiling_cells": perception.get("clear_ceiling_cells") if layer == "ceiling" else None,
                        "mask_convention": perception.get("mask_convention"),
                        "decimation": decimation, "upstream_decimated": perception.get("decimated"),
                        "raw_lidar": False, "snapshot_only": True},
        })


def _timed_perception(session, time_s, sensors, stale_after_s):
    perception = session.get("perception") or {}
    if perception.get("kind") not in ("time-series", "synchronized-map-snapshot") or not perception.get("available"):
        return
    frames = perception.get("frames", []) if perception.get("kind") == "time-series" else [perception]
    times = [f.get("time") for f in frames]
    if any(not _finite(t) for t in times) or any(a > b for a, b in zip(times, times[1:])):
        raise ReplayError("Perception samples must have finite monotonically ordered session times")
    index = bisect.bisect_right(times, time_s) - 1
    if index < 0:
        return
    sample = frames[index]
    metadata = session.get("metadata", {})
    for sensor_id, field in (("lidar_raw", "raw_lidar"), ("lidar_filtered", "filtered_lidar"),
                             ("map_support", "support_points"), ("map_ceiling", "ceiling_points")):
        values = sample.get(field)
        if values is None:
            continue
        is_map = sensor_id.startswith("map_")
        sample_time = sample.get("map_time" if is_map else "sensor_capture_time", sample["time"])
        if not _finite(sample_time):
            raise ReplayError("Perception acquisition time must be finite")
        if sample_time > time_s + 1e-9:
            # A map publication can include a differently clocked sensor sample;
            # it cannot be shown before its own acquisition in this timeline.
            continue
        points, decimation = _points(values)
        frame_id = sample.get(field + "_frame_id", sample.get("frame_id"))
        source_clock = sample.get("source_clock", sample.get("source_clock_domain", sample.get("clock_domain", metadata.get("clock_domain"))))
        # Source pre-scan's floating arithmetic can leave nominal zero at
        # 2.8e-16 s. Preserve the stamp, tolerate sub-nanosecond roundoff only.
        age_ms = max(0., time_s - sample_time) * 1000
        sensor = sensors[sensor_id]
        source_field = "perception.frames." + field
        extrinsics = sample.get("extrinsics", sensor["extrinsics"])
        if isinstance(extrinsics, list):
            extrinsics = {"available": bool(extrinsics), "classification": "configured-simulator-mount",
                          "transforms": extrinsics, "calibration_identity": None,
                          "reason": "Exact simulator configuration; no physical sensor calibration is claimed."}
        sensor.update({
            "available": True, "status": "stale" if age_ms > stale_after_s * 1000 else "fresh",
            "validity": sample.get("validity", "valid"),
            "classification": sample.get(field + "_classification", sample.get("classification", "unknown")),
            "frame_id": frame_id, "source_time": sample_time,
            "source_clock": source_clock, "receipt_time": sample.get("receipt_time"),
            "receipt_clock": sample.get("receipt_clock"), "sample_time_s": sample_time,
            "age_ms": age_ms, "rate_hz": _rate(frames, time_s),
            "rate_basis": "recorded perception snapshots; not DDS rate",
            "sequence": sample.get("sequence", index), "synchronized": True,
            "units": {"position": "m", "resolution": "m"},
            "can_pin": True, "overlay_compatible": frame_id == metadata.get("frame_id"),
            "extrinsics": extrinsics,
            "provenance": {**_provenance(session, ""), "source_field": source_field,
                           "sensor_basis": sample.get(field + "_basis", sample.get("sensor_basis", perception.get("sensor_basis"))),
                           "source": sample.get("source", perception.get("source"))},
            "reason": sample.get("note"),
            "payload": {"points": points, "origin": sample.get("sensor_origin"), "decimation": decimation,
                        "upstream_decimated": sample.get("decimated"),
                        "input_points_count": sample.get("raw_points_count" if sensor_id == "lidar_raw" else "filtered_points_count") if not is_map else None,
                        "self_removed": sample.get("self_removed"),
                        "self_filtering": sample.get("self_filtering", sample.get("self_filter", "unverified")),
                        "sensor_basis": sample.get(field + "_basis", sample.get("sensor_basis", perception.get("sensor_basis"))),
                        "snapshot_only": False, "raw_lidar": not is_map and sensor_id == "lidar_raw"},
        })
        if sensor_id == "lidar_raw" and sample.get("raw_lidar_basis"):
            sensor["label"] = "Simulated ray returns"
        if is_map:
            layer = sensor_id.removeprefix("map_")
            sensor["payload"].update({"layer": layer, "grid_shape": sample.get("grid_shape"),
                "resolution_m": sample.get("resolution_m"), "origin": sample.get("map_origin", sample.get("origin")),
                "observed_mask": sample.get(layer + "_observed_mask"),
                "observed_indices": sample.get(layer + "_observed_indices"),
                "observed_cells": sample.get("observed_cells", {}).get(layer),
                "unknown_cells": sample.get("unknown_cells"),
                "clear_ceiling_cells": sample.get("clear_ceiling_cells") if layer == "ceiling" else None,
                "mask_convention": sample.get("mask_convention", "Unknown cells remain absent; no free-space inference.")})


def _captured_sensors(envelopes, time_s, sensors, stale_after_s):
    if len(envelopes) > MAX_SENSOR_ENVELOPES:
        raise ReplayError("Sensor capture exceeds 10000 messages; select a bounded clip")
    groups = {}
    for item in envelopes:
        sample_time = item.get("time")
        if not _finite(sample_time):
            raise ReplayError("Sensor envelope needs a finite session-relative time")
        if sample_time > time_s:
            continue
        envelope = item.get("envelope", item)
        topic = envelope.get("topic")
        if topic in ("cloud", "odom", "g1_debug"):
            groups.setdefault(topic, []).append((sample_time, envelope))
    for topic, samples in groups.items():
        samples.sort(key=lambda row: row[0])
        sample_time, envelope = samples[-1]
        payload = envelope.get("payload", {})
        fields = payload.get("fields", {})
        age_ms = (time_s - sample_time) * 1000
        window = samples[-128:]
        rate = (len(window)-1)/(window[-1][0]-window[0][0]) if len(window)>1 and window[-1][0]>window[0][0] else None
        common = {
            "available": True, "status": "stale" if age_ms > stale_after_s * 1000 else "fresh",
            "validity": envelope.get("validity", "decoded"), "classification": "source-kind-unverified",
            "frame_id": envelope.get("frame_id"), "source_time": envelope.get("source_timestamp"),
            "source_clock": envelope.get("source_clock"), "receipt_time": envelope.get("receipt_timestamp"),
            "receipt_clock": envelope.get("receipt_clock"), "sample_time_s": sample_time,
            "age_ms": age_ms, "rate_hz": rate, "rate_basis": "collector receipts; not source acquisition rate",
            "sequence": envelope.get("sequence"), "synchronized": True,
            "provenance": envelope.get("provenance", {}), "can_pin": True, "overlay_compatible": False,
            "reason": "Receipt-time replay; source clock and world-frame alignment are unverified.",
        }
        if topic == "cloud":
            points, decimation = _points(fields.get("points", []))
            sensors["lidar_registered"].update(common, units={"position": "m"},
                payload={"points": points, "origin": fields.get("origin"), "decimation": decimation,
                         "upstream_decimation": payload.get("visualization_decimation"),
                         "self_filtering": "unverified", "raw_lidar": False})
        elif topic == "odom":
            if not _vector(fields.get("pos"), 3) or not _vector(fields.get("quat_wxyz"), 4):
                raise ReplayError("Captured odometry has invalid position or quaternion")
            sensors["odometry"].update(common, units={"position": "m", "quaternion": "wxyz", "velocity": "m/s"},
                payload={"position": fields["pos"], "quaternion_wxyz": fields["quat_wxyz"],
                         "linear_velocity": fields.get("lin_w"), "angular_velocity": fields.get("ang_w"),
                         "velocity_validity": "source may emit placeholder angular velocity; unverified"})
        else:
            measured = payload.get("measured", {})
            names = payload.get("joint_names", [])
            joints = measured.get("joint_position")
            if names and _vector(joints, len(names)):
                sensors["joints"].update(common, classification="measured", units={"position": "rad", "velocity": "rad/s"},
                    payload={"joint_names": names, "position": joints,
                             "velocity": measured.get("joint_velocity"), "effort": None, "faults": None})
            # Debug root orientation is useful but does not make an IMU packet
            # or the runner's fixed display translation a world localization.
            q = measured.get("root_orientation")
            if _vector(q, 4):
                sensors["base_pose"].update(common, classification="measured", render_hint="orientation",
                    units={"quaternion": "wxyz"},
                    payload={"position": None, "quaternion_wxyz": q},
                    reason="Runner orientation only; root translation is unavailable. This is not raw IMU telemetry.")


MASK_FIELDS = ("observed_mask", "observed_indices")


def get_sensor_snapshot(session, time_s, *, capture_envelopes=None, stale_after_s=0.5,
                        include_payloads=True, include_masks=True):
    """Return a causal, timestamped inventory for the selected replay cursor.

    Optional captured messages are ``{time: session_relative_seconds,
    envelope: decode_packet(...)}`` records, normally produced by
    :func:`load_sensor_capture`. They must share the selected session's receipt
    timeline. The API does not guess alignment with another recording.
    """
    if not _finite(time_s) or not _finite(stale_after_s) or stale_after_s <= 0:
        raise ReplayError("Sensor cursor and stale timeout must be finite; timeout must be positive")
    sensors = {spec[0]: _empty(*spec) for spec in _SPECS}
    if (session.get("metadata") or {}).get("privileged_map"):
        # The policy planned from exact boxes: no simulated sensing existed, by design.
        why = ("Unavailable by design: this privileged policy planned from the exact configured boxes "
               "(simulator ground truth); no simulated LiDAR or map was generated.")
        for key in ("lidar_raw", "lidar_registered", "lidar_filtered", "map_support", "map_ceiling"):
            if key in sensors:
                sensors[key]["reason"] = why
    _recorded_state(session, float(time_s), sensors)
    _recorded_map(session, sensors)
    _timed_perception(session, float(time_s), sensors, stale_after_s)
    if capture_envelopes is not None:
        _captured_sensors(capture_envelopes, float(time_s), sensors, stale_after_s)
    rows = list(sensors.values())
    if not include_payloads:
        rows = [{**row, "payload": None} for row in rows]
    elif not include_masks:
        # Full cell masks are large (up to ~0.7 MB per call) and only needed for
        # explicit audits. Mark the omission rather than silently dropping it.
        for row in rows:
            payload = row.get("payload")
            if isinstance(payload, dict) and any(payload.get(k) is not None for k in MASK_FIELDS):
                row["payload"] = {k: v for k, v in payload.items() if k not in MASK_FIELDS}
                row["payload"]["observed_mask_omitted"] = "Request masks=1 for the full observed-cell mask"
    metadata = session.get("metadata", {})
    return {"schema_version": 1, "session_id": metadata.get("id"), "cursor_s": float(time_s),
            "mode": metadata.get("mode", "replay"), "clock_domain": metadata.get("clock_domain"),
            "sensors": rows, "available_sensor_ids": [r["id"] for r in rows if r["available"]],
            "hardware_enabled": False,
            "note": "Unavailable sensors are explicit. Simulator truth is not a physical measurement; final maps are unsynchronized."}


def get_sensor_catalog(session):
    """Payload-free inventory at the first recorded state for a sensor picker."""
    first = session.get("frames", [{}])[0] if session.get("frames") else {}
    return get_sensor_snapshot(session, first.get("time", 0.0), include_payloads=False)


def load_sensor_capture(path):
    """Decode original wire bytes from one bounded recorder JSONL file.

    Returned times use the capture's collector monotonic clock origin. This
    does not align it to a separately loaded simulator recording. Messages
    without original wire bytes are rejected, not trusted as sensor evidence.
    """
    path = Path(path).expanduser().resolve()
    events, digest = _read_events(path)
    start = events[0]
    origin = start.get("receipt_timestamp")
    if not _finite(origin):
        raise ReplayError("Capture start needs its collector monotonic clock")
    if start.get("schema_version") != 1 or start.get("receipt_clock") != "collector_host_monotonic":
        raise ReplayError("Unsupported capture schema or collector clock")
    messages = []
    last_receipt = origin
    for event in events[1:]:
        if event.get("record") is not None:
            continue
        normalized = event
        topic = normalized.get("topic")
        if topic not in ("cloud", "odom", "g1_debug", "robot_config", "pose"):
            raise ReplayError("Unknown recorded telemetry topic")
        wire = event.get("wire_base64")
        receipt = normalized.get("receipt_timestamp")
        if not isinstance(wire, str) or not _finite(receipt) or receipt < last_receipt:
            raise ReplayError("Sensor capture requires original wire bytes and valid receipt time")
        if normalized.get("receipt_clock") != "collector_host_monotonic":
            raise ReplayError("Sensor capture uses an incompatible receipt clock")
        unix_stamp = normalized.get("receipt_unix")
        if unix_stamp is not None and not _finite(unix_stamp):
            raise ReplayError("Invalid sensor capture receipt Unix timestamp")
        last_receipt = receipt
        try:
            decoded = decode_packet(base64.b64decode(wire, validate=True), topic.encode(),
                                    receipt_monotonic=receipt,
                                    receipt_unix=unix_stamp if unix_stamp is not None else 0.,
                                    source_id=normalized.get("source_id", "recorded-capture"),
                                    session_id=normalized.get("session_id", path.stem))
        except (ProtocolError, binascii.Error, ValueError) as exc:
            raise ReplayError(f"Invalid original sensor wire data: {exc}") from exc
        decoded["receipt_unix"] = unix_stamp
        decoded["provenance"] = {**decoded["provenance"], "capture_path": str(path), "capture_sha256": digest,
                                 "wire_redecoded": True}
        messages.append({"time": receipt - origin, "envelope": decoded})
    return {"schema_version": 1, "source_path": str(path), "sha256": digest,
            "clock_domain": "collector_host_monotonic", "source_time_origin": origin,
            "envelopes": messages, "alignment_to_other_sessions": "unavailable"}
