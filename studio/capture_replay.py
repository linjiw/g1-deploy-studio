"""Causal browser replay of a bounded Studio pose-wire diagnostic capture.

The capture proves subscriber receipts and socket events. It contains no robot
state or world root translation: those fields remain unavailable at every frame.
"""
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import math
from pathlib import Path

from .protocols import MJ_JOINTS, ProtocolError, decode_pose
from .recorder import StreamHealth, validate_endpoint
from .replay import MAX_FRAMES, ReplayError

MAX_CAPTURE_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 16 * 1024 * 1024
MAX_EVENTS = 10000


def _number(value, name, *, nullable=False, nonnegative=False):
    if value is None and nullable:
        return None
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ReplayError(f"Capture {name} must be a finite number")
    if nonnegative and value < 0:
        raise ReplayError(f"Capture {name} cannot be negative")
    return float(value)


def _reject_constant(value):
    raise ReplayError(f"Nonfinite JSON constant in capture: {value}")


def _read_events(path):
    if path.stat().st_size > MAX_CAPTURE_BYTES:
        raise ReplayError("Capture exceeds 64 MiB; select a bounded clip")
    events = []
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            line = stream.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_LINE_BYTES:
                raise ReplayError("Capture event exceeds 16 MiB")
            digest.update(line)
            if not line.strip():
                continue
            if len(events) >= MAX_EVENTS:
                raise ReplayError("Capture exceeds 10000 events; select a bounded clip")
            try:
                event = json.loads(line, parse_constant=_reject_constant)
            except (ValueError, UnicodeDecodeError, RecursionError) as exc:
                raise ReplayError("Invalid capture JSONL event") from exc
            if not isinstance(event, dict):
                raise ReplayError("Capture events must be JSON objects")
            events.append(event)
    if not events or events[0].get("record") != "capture_start":
        raise ReplayError("Capture must begin with its clock/provenance capture_start record")
    return events, digest.hexdigest()


def _reference(decoded):
    fields = decoded["fields"]
    indices = [decoded["joint_names"].index(name) for name in MJ_JOINTS]
    ticks = fields["frame_index"]
    window = []
    for row, tick in enumerate(ticks):
        window.append({"offset_s": (tick - ticks[0]) * 0.02, "frame_index": tick,
                       "joints": [fields["joint_pos"][row][i] for i in indices],
                       "velocity": [fields["joint_vel"][row][i] for i in indices],
                       "quaternion_wxyz": fields["body_quat"][row], "position": None})
    return {
        "joints": window[0]["joints"], "velocity": window[0]["velocity"],
        "quaternion_wxyz": window[0]["quaternion_wxyz"], "position": None,
        "window": window, "root_position_available": False,
        "position_basis": "not present in pose wire", "classification": "reference",
        "frame_id": "unverified-reference-heading", "shape": [len(window), 29],
        "raw": fields["joint_pos"], "raw_fields": fields,
        "joint_names": list(MJ_JOINTS), "wire_joint_names": decoded["joint_names"],
        "orientation_basis": "actual wire wxyz; runner heading alignment not observed",
        "offset_basis": "wire frame_index difference × configured 20 ms; not observed playback cursor",
        "latent_tokens": None, "latent_status": "not present in pose wire",
        "playback_cursor": None, "packet_sequence": None,
        "consumed_columns": None, "diagnostic_columns": None,
    }


def _graph(endpoint, health, *, attribution=None):
    publisher_label = "Unknown publisher process" if attribution is None else attribution
    return {
        "basis": "observed-zmq-receive", "runtime_discovered": False,
        "runtime_observed": True,
        "nodes": [{"id": "publisher", "label": publisher_label, "kind": "publisher",
                   "host": "loopback endpoint", "process_identity": None},
                  {"id": "studio", "label": "Studio recorder", "kind": "observer",
                   "host": "collector host", "process_identity": "studio.recorder"}],
        "edges": [{"source": "publisher", "target": "studio", "transport": "ZMQ",
                   "topic": "pose", "endpoint": endpoint, "schema": "flow.pose.v1",
                   "status": health["stream_status"], "observed_rate_hz": health["observed_rate_hz"],
                   "age_ms": health["reference_age_ms"], "drops": health["sequence_gaps"],
                   "qos": None, "publisher_identity": None, "subscriber_identity": "studio.recorder",
                   "connection_state": health["transport"],
                   "basis": "observed subscriber receipts and ZMQ socket monitor; no process/ROS/DDS discovery"}],
        "ros2": {"available": False, "reason": "No ROS graph collector ran"},
        "dds_domain": None, "dds_domain_note": "No DDS participant or DDS traffic in this capture",
    }


def _verified_attribution(path, capture_hash):
    """Only use adjacent explicit receipt if it binds this exact byte capture.

    Old receipts without a capture SHA remain unverified; matching a path alone
    cannot establish publisher identity because the file could have changed.
    """
    receipt = path.with_name("wire_acceptance.json")
    if not receipt.is_file() or receipt.stat().st_size > 1024 * 1024:
        return None, None
    try:
        report = json.loads(receipt.read_text(), parse_constant=_reject_constant)
        if not isinstance(report, dict):
            return None, None
        capture = report.get("capture", {})
        if not isinstance(capture, dict):
            return None, None
        if (Path(capture.get("output", "")).resolve() != path
                or capture.get("sha256") != capture_hash
                or report.get("kind") != "recorded_data_transport_rehearsal"
                or report.get("controller_executed") is not False
                or report.get("hardware_command_path") is not False):
            return None, None
    except (ValueError, TypeError):
        return None, None
    return "Owned recorded-reference publisher (verified receipt)", {
        "path": str(receipt), "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest(),
        "classification": "recorded_data_transport_rehearsal",
        "recording": report.get("recording"), "recording_sha256": report.get("recording_sha256")}


def load_capture(path, *, max_frames=MAX_FRAMES):
    """Load one explicit pose-only JSONL, with causal sample-hold diagnostics.

    No imports of deployment source, socket creation, model load or inferred
    robot pose. For larger input, preserve every diagnostic transition and
    thin only ordinary telemetry frames; reject if transitions exceed budget.
    """
    if type(max_frames) is not int or not 2 <= max_frames <= MAX_FRAMES:
        raise ReplayError(f"max_frames must be 2..{MAX_FRAMES}")
    path = Path(path).expanduser().resolve()
    events, capture_hash = _read_events(path)
    start = events[0]
    if start.get("schema_version") != 1 or start.get("receipt_clock") != "collector_host_monotonic":
        raise ReplayError("Unsupported capture schema or collector clock domain")
    if start.get("hardware_command_path") is not False or start.get("dds_participant") is not False:
        raise ReplayError("Expected a Studio read-only telemetry capture without DDS")
    endpoints, topics = start.get("endpoints"), start.get("topics")
    if not isinstance(endpoints, list) or len(endpoints) != 1 or topics != ["pose"]:
        raise ReplayError("Browser wire replay currently supports exactly one endpoint and the pose topic")
    try:
        endpoint = validate_endpoint(endpoints[0])
    except (ValueError, TypeError) as exc:
        raise ReplayError("Capture endpoint must be an explicit loopback endpoint") from exc
    origin = _number(start.get("receipt_timestamp"), "start timestamp", nonnegative=True)
    session_id = start.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise ReplayError("Missing capture session identity")
    attribution, receipt_identity = _verified_attribution(path, capture_hash)
    latest_reference = latest_receipt = latest_source_time = None
    latest_source_clock = "unknown"
    stream = StreamHealth()
    status = "unavailable"
    transport = "unknown"
    rate = None
    queue_drops = None
    frames, markers, essentials = [], [], set()
    last_time = origin
    capture_complete = False
    stream_key = endpoint + "#pose"
    telemetry_count = 0
    for event_index, event in enumerate(events):
        receipt_time = _number(event.get("receipt_timestamp"), "receipt timestamp", nonnegative=True)
        if receipt_time < last_time:
            raise ReplayError("Capture collector receipt clock moved backwards")
        last_time = receipt_time
        current_time = receipt_time - origin
        record = event.get("record")
        essential = record is not None
        if capture_complete:
            raise ReplayError("Capture contains events after capture_end")
        if record == "capture_start":
            if event_index != 0:
                raise ReplayError("Duplicate capture_start")
        elif record == "transport":
            if event.get("endpoint") != endpoint or event.get("state") not in ("connected", "disconnected"):
                raise ReplayError("Invalid capture transport event")
            transport = event["state"]
            if latest_reference is not None and transport == "disconnected":
                status = "disconnected"
            markers.append({"time": current_time, "type": "transport-" + transport,
                            "message": "ZMQ receiver " + transport, "source": "ZMQ socket monitor",
                            "endpoint": endpoint})
        elif record in ("health", "capture_end"):
            snapshots = event.get("streams")
            if not isinstance(snapshots, dict) or stream_key not in snapshots:
                raise ReplayError("Capture health lacks the declared pose stream")
            snapshot = snapshots[stream_key]
            if not isinstance(snapshot, dict):
                raise ReplayError("Capture health snapshot must be an object")
            if snapshot.get("status") not in ("unavailable", "fresh", "stale", "silent", "disconnected"):
                raise ReplayError("Invalid capture stream health status")
            previous_status = status
            status = snapshot["status"]
            transport = snapshot.get("transport", transport)
            if transport not in ("unknown", "connected", "disconnected"):
                raise ReplayError("Invalid captured connection state")
            rate = _number(snapshot.get("observed_rate_hz"), "observed rate", nullable=True, nonnegative=True)
            # pose has no packet sequence. A capture claiming measured sequence
            # gaps for this wire schema is inconsistent with the actual source.
            if snapshot.get("sequence_gaps") is not None:
                raise ReplayError("Pose frame indices cannot be used as packet sequence gaps")
            claimed_age = _number(snapshot.get("receipt_age_s"), "receive age", nullable=True, nonnegative=True)
            if latest_receipt is None:
                if claimed_age is not None or status != "unavailable":
                    raise ReplayError("Health claims a received pose before any captured packet")
            elif claimed_age is not None and abs(claimed_age - (receipt_time-latest_receipt)) > 1e-6:
                raise ReplayError("Capture health receipt age disagrees with packet receipt time")
            if record == "health":
                recorder = event.get("recorder", {})
                if not isinstance(recorder, dict):
                    raise ReplayError("Capture recorder statistics must be an object")
                queue_drops = _number(recorder.get("queue_drops"), "queue drops", nullable=True, nonnegative=True)
            if previous_status != status:
                markers.append({"time": current_time, "type": "stream-" + status,
                                "message": "Reference receiver " + status,
                                "source": "recorded recorder health", "endpoint": endpoint})
            if record == "capture_end":
                capture_complete = True
        elif record == "decode_error":
            if event.get("endpoint") != endpoint or event.get("topic") != "pose":
                raise ReplayError("Decode error references an undeclared stream")
            markers.append({"time": current_time, "type": "decode-error", "message": str(event.get("error", "decode error")),
                            "source": "recorder decoder"})
        elif record is None:
            if (event.get("schema_version") != 1 or event.get("session_id") != session_id
                    or event.get("topic") != "pose" or event.get("source_id") != endpoint
                    or event.get("receipt_clock") != "collector_host_monotonic"):
                raise ReplayError("Telemetry envelope disagrees with capture source/timebase")
            encoded = event.get("wire_base64")
            if not isinstance(encoded, str):
                raise ReplayError("Wire browser replay requires original wire_base64 for decoder verification")
            try:
                wire = base64.b64decode(encoded, validate=True)
                decoded = decode_pose(wire)
            except (ValueError, TypeError, binascii.Error, ProtocolError) as exc:
                raise ReplayError("Invalid captured pose wire bytes") from exc
            payload = event.get("payload")
            if (not isinstance(payload, dict) or payload.get("fields") != decoded["fields"]
                    or payload.get("joint_names") != decoded["joint_names"]
                    or event.get("sequence") is not None
                    or event.get("source_timestamp") != decoded["source_timestamp"]
                    or event.get("source_clock") != decoded["source_clock"]):
                raise ReplayError("Captured normalized pose disagrees with original decoded wire")
            latest_reference = _reference(decoded)
            latest_receipt = receipt_time
            latest_source_time = decoded["source_timestamp"]
            latest_source_clock = decoded["source_clock"]
            stream.observe(None, receipt_time)
            rate = stream.snapshot(receipt_time)["observed_rate_hz"]
            status = "fresh"
            telemetry_count += 1
        else:
            raise ReplayError(f"Unsupported capture event: {record}")
        age_ms = None if latest_receipt is None else (receipt_time - latest_receipt) * 1000
        health = {"state_age_ms": None, "reference_age_ms": age_ms,
                  "planner_latency_ms": None, "tracking_rmse_rad": None,
                  "lowcmd_age_ms": None, "sonic_inference_ms": None, "gpu_utilization": None,
                  "observed_rate_hz": rate, "stream_status": status, "transport": transport,
                  "sequence_gaps": None, "queue_drops": queue_drops,
                  "source_latency_ms": None, "rate_basis": "last_received_window",
                  "reference_receipt_time": latest_receipt,
                  "reference_receipt_time_relative": None if latest_receipt is None else latest_receipt-origin,
                  "status_basis": "recorded health snapshots and observed socket transitions"}
        frame = {"time": current_time, "event_index": event_index, "sequence": None,
                 "source_time": latest_source_time, "source_clock_domain": latest_source_clock,
                 "receipt_time": receipt_time, "receipt_clock_domain": "collector_host_monotonic",
                 "reference_receipt_time": latest_receipt, "sim_time": None,
                 "state": None, "position": None, "quaternion_wxyz": None, "joints": None, "qpos": None,
                 "classification": "unavailable", "validity": "unavailable", "frame_id": None,
                 "reference": latest_reference, "plan": None, "command": None, "health": health,
                 "observed_graph": _graph(endpoint, health, attribution=attribution)}
        frames.append(frame)
        if essential:
            essentials.add(event_index)
    if not telemetry_count:
        # An empty capture remains useful for honest unavailable/disconnect
        # diagnostics; never synthesize reference values to populate the UI.
        markers.append({"time": 0.0, "type": "unavailable", "message": "No pose packets captured", "source": "capture"})
    essentials.update((0, len(frames)-1))
    total_frames = len(frames)
    if total_frames > max_frames:
        if len(essentials) > max_frames:
            raise ReplayError("Diagnostic transitions exceed frame budget; select a shorter capture")
        candidates = [i for i in range(total_frames) if i not in essentials]
        budget = max_frames - len(essentials)
        if budget:
            selected = {candidates[min(len(candidates)-1, int(k*len(candidates)/budget))] for k in range(budget)}
        else:
            selected = set()
        frames = [frames[i] for i in sorted(essentials | selected)]
    metadata = {
        "id": path.parent.name + "-wire", "title": "Recorded reference transport · receiver diagnostics",
        "mode": "replay", "kind": "recorded-wire-transport", "recording_kind": "recorded-wire-transport",
        "backend_id": "sonic-reference-protocol", "source_path": str(path),
        "model_path": None, "model_variant": "Not captured", "frame_id": None,
        "duration_s": last_time-origin, "clock_domain": "collector_host_monotonic",
        "source_time_origin": origin, "quaternion_convention": "wxyz",
        "units": {"position": "m", "joint": "rad", "joint_velocity": "rad/s", "time": "s"},
        "hardware_validated": False, "command_path_enabled": False, "fixture": False,
        "policy_identity": "Not observed; SONIC-compatible reference protocol only",
        "policy_hash_at_recording": None, "calibration_identity": None,
        "source_samples": telemetry_count, "capture_events": len(events), "capture_complete": capture_complete,
        "sequence_semantics": "event_index is file event order; pose has no packet sequence or observed runner cursor",
        "state_observed": False, "reference_root_position_available": False,
        "provenance": {"adapter": "studio.capture_replay.v1",
                       "artifacts": [{"path": str(path), "bytes": path.stat().st_size, "sha256": capture_hash}],
                       "wire_bytes_redecoded": True, "clock_alignment": "unverified",
                       "model_at_read": None, "recorded_model_hash": None, "repositories": [],
                       "publisher_identity_receipt": receipt_identity},
        "limitations": [
            "Subscriber-side evidence alone cannot establish controller, simulation, DDS or hardware execution; replay starts none of them.",
            "No measured robot state or world root translation exists in pose packets. Robot and world ghost are unavailable.",
            "Reference joint windows and wxyz values come from re-decoded wire bytes; they are intended motion, not guaranteed execution.",
            "Publisher process/model/policy identity is not discoverable from a ZMQ endpoint or pose packet.",
            "Pose frame indices refer to requested motion frames, not packet sequences or active runner playback position.",
            "Receive age/rate use the collector clock. Source monotonic clock alignment and end-to-end latency are unverified.",
            "Fresh/stale status transitions are preserved from recorded health snapshots; silence alone does not prove producer death.",
            "No perception/map, ROS graph, DDS traffic, motor commands, latent vectors or model identity was captured.",
        ],
    }
    if total_frames > max_frames:
        metadata["limitations"].append("Ordinary telemetry display frames were thinned; all recorded diagnostic events were retained.")
    return {"schema_version": 1, "metadata": metadata, "joint_names": list(MJ_JOINTS), "frames": frames,
            "events": sorted(markers, key=lambda event:event["time"]),
            "environment": {"boxes": [], "classification": "unavailable", "source": None},
            "perception": {"available": False, "reason": "No perception packets or map in pose-only capture"},
            "graph": copy.deepcopy(frames[0]["observed_graph"]), "trajectory": []}
