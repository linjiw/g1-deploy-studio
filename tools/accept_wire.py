#!/usr/bin/env python3
"""Repack recorded reference values through an owned loopback PUB/SUB.

This is a recorded-data transport rehearsal, NOT a controller simulation or
recorded original wire traffic. No DDS participant or deployment process runs.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import queue
import sys
import threading
import time
import types

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mujoco
import numpy as np
import zmq

from studio import paths
from studio.protocols import MJ_JOINTS, decode_pose
from studio.recorder import capture_zmq


def load_source(root):
    """Import only reviewed pure protocol/array files; no controller constructed."""
    package = "_studio_wire_reference"
    pkg = types.ModuleType(package)
    pkg.__path__ = [str(root / "g1deploy")]
    sys.modules[package] = pkg
    modules = {}
    for name in ("contract", "zmq_stream", "sonic"):
        path = root / "g1deploy" / (name + ".py")
        spec = importlib.util.spec_from_file_location(package + "." + name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        # Execute reviewed pure source without SourceFileLoader's bytecode cache
        # writes into the external read-only reference worktree.
        exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
        modules[name] = module
    return modules


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--source-root", type=Path, default=paths.get("deploy_root"))
    parser.add_argument("--recording", type=Path,
                        default=paths.get("deploy_root") / "runs/smoke/__start_stand_/closed_loop.npz")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    source = load_source(args.source_root)
    with np.load(args.recording, allow_pickle=False) as recording:
        references = recording["references"].copy()
        pre = recording["pre_action_qpos"].copy()
    count = min(40, len(references))
    if references.shape[1:] != (10, 67) or pre.shape[1:] != (36,) or count < 2:
        raise ValueError("expected the verified smoke recording format")
    packets, expected = [], {}
    for index in range(count):
        ref = references[index]
        orient6d = source["sonic"].project_rotation_6d(ref[:, 58:64]).reshape(10, 3, 2)
        relative = np.concatenate([orient6d, np.cross(orient6d[:, :, 0], orient6d[:, :, 1])[:, :, None]], axis=2)
        measured_rotation = source["zmq_stream"]._quat_matrix(pre[index, 3:7])
        rotations = measured_rotation[None] @ relative
        quat = np.empty((10, 4), dtype=np.float64)
        for row, rotation in enumerate(rotations):
            mujoco.mju_mat2Quat(quat[row], np.ascontiguousarray(rotation.ravel()))
            np.testing.assert_allclose(source["zmq_stream"]._quat_matrix(quat[row]), rotation, atol=1e-6)
        ticks = index + np.arange(10) * 5
        # Source timestamp belongs to this new transport exercise, never to the old recording.
        packets.append((ticks, ref[:, :29], ref[:, 29:58], quat))
        expected[index] = ref[:, :29]
    address = queue.Queue()
    failures = queue.Queue()
    sent = []
    def publish():
        context = zmq.Context()
        publisher = context.socket(zmq.PUB)
        publisher.setsockopt(zmq.LINGER, 0)
        publisher.setsockopt(zmq.SNDHWM, 4)
        port = publisher.bind_to_random_port("tcp://127.0.0.1")
        address.put(f"tcp://127.0.0.1:{port}")
        try:
            time.sleep(0.45)  # allow the owned subscriber's subscription handshake
            for ticks, q, dq, quat in packets:
                message = source["zmq_stream"].pose_message(ticks, q, dq, quat, timestamp=time.monotonic())
                publisher.send(message, flags=zmq.NOBLOCK)
                sent.append(int(ticks[0]))
                time.sleep(0.02)
            time.sleep(0.9)  # leave TCP connected but silent to exercise stale receive state
        except Exception as exc:
            failures.put(repr(exc))
        finally:
            publisher.close(0)
            context.term()
    thread = threading.Thread(target=publish, daemon=True)
    thread.start()
    endpoint = address.get(timeout=5)
    capture_path = args.output_dir / "wire_capture.jsonl"
    result = capture_zmq([endpoint], ["pose"], capture_path, duration=2.8, queue_size=16, stale_after_s=0.3)
    result["sha256"] = hashlib.sha256(capture_path.read_bytes()).hexdigest()
    thread.join(timeout=5)
    if thread.is_alive() or not failures.empty():
        raise RuntimeError("owned transport publisher failed")
    events = [json.loads(line) for line in capture_path.read_text().splitlines()]
    messages = [event for event in events if event.get("topic") == "pose" and "payload" in event]
    if len(messages) < count - 2:
        raise AssertionError(f"only {len(messages)} of {count} reference packets received")
    max_error = 0.0
    for event in messages:
        decoded = decode_pose(base64.b64decode(event["wire_base64"]))
        index = decoded["fields"]["frame_index"][0]
        positions = np.asarray(decoded["fields"]["joint_pos"])
        ordered = np.stack([positions[:, decoded["joint_names"].index(joint)] for joint in MJ_JOINTS], axis=1)
        error = float(np.max(np.abs(ordered - expected[index])))
        max_error = max(error, max_error)
        np.testing.assert_array_equal(ordered, expected[index])
        assert event["sequence"] is None  # chunk indices are not packet sequence identifiers
        assert event["provenance"]["clock_alignment"] == "unverified"
        assert event["payload"]["root_translation"] is None
    statuses = sorted({stream["status"] for event in events if event.get("record") == "health"
                       for stream in event["streams"].values()})
    transports = [event["state"] for event in events if event.get("record") == "transport"]
    assert "stale" in statuses, statuses
    assert "disconnected" in transports, transports
    assert result["recorder"]["queue_drops"] == 0, result
    report = {
        "kind": "recorded_data_transport_rehearsal", "controller_executed": False,
        "original_wire_recording": False, "hardware_command_path": False, "dds_participant": False,
        "recording": str(args.recording.resolve()),
        "recording_sha256": hashlib.sha256(args.recording.read_bytes()).hexdigest(),
        "source_files": {name: {"path": str(args.source_root / "g1deploy" / (name + ".py")),
                                "sha256": hashlib.sha256((args.source_root / "g1deploy" / (name + ".py")).read_bytes()).hexdigest()}
                         for name in source},
        "source_contract": "references[t,k]: q[0:29],dq[29:58],relative pelvis6D[58:64]; world diagnostic delta[64:67] excluded",
        "orientation": "source project_rotation_6d + pre_action root rotation, wxyz",
        "frames_sent": len(sent), "frames_decoded": len(messages), "max_joint_error_rad": max_error,
        "captured_statuses": statuses, "transport_events": transports, "capture": result,
        "limits": ["Newly serialized packet framing, not original wire capture",
                   "Ten sparse lookahead rows exercise parsing, not runner buffer-merging behavior",
                   "No SONIC inference, DDS commands, robot state producer or LiDAR producer launched"],
    }
    report_path = args.output_dir / "wire_acceptance.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
