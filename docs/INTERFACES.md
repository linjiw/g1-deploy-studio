# Verified telemetry interfaces

Inspected 2026-10-15 against the local files below. Reference checker passed; current source and recorded values take precedence over old comments. No referenced worktree was modified. This document describes **implemented decoders**, **recorded-data verification**, and **unimplemented live collectors** separately.

## Implemented receive contracts

`studio/protocols.py` contains pure decoders. `studio/recorder.py` creates only ZMQ SUB sockets connected to explicit literal loopback TCP addresses. It creates no DDS participant. `localhost`, non-loopback IPs, wildcard binds, IPC, credentials and arbitrary topics are rejected. Decoder envelopes carry schema version, source identity, source/receipt timestamps and clock domains, frame, sequence when present, units, joint names and provenance. Unknown calibration/model variant and unverified clock alignment stay explicit.

| Stream | Actual source wire | Data interpretation | Validation exercised |
| --- | --- | --- | --- |
| `pose` | One message: `pose` + exactly 1280 bytes null-padded JSON + little-endian arrays | Requested motion; joints in IsaacLab order, pelvis quaternion wxyz; no root position | Actual Flow packer parity, real recorded references repacked, exact named-joint comparisons |
| `g1_debug` | One message: `g1_debug` + msgpack map; no protocol version on wire | Measured joints, reference targets, scaled last policy action, optional encoder vector | Source inspection plus explicitly synthetic protocol fixtures; no fresh C++ packet captured |
| `robot_config` | One message: `robot_config` + msgpack map | Runner configuration, no source timestamp | Source inspection and fixture decoding |
| `cloud` | Flow packed v1 header + `points[N,3]`, `origin[3]`, `stamp[1]` | Source world/frame/type and clock domain require confirmation | Actual source packer parity; deterministic stride decimation to at most 5000 points |
| `odom` | Flow packed v1 header + `pos[3]`, `quat_wxyz[4]`, other optional fields, `stamp[1]` | Source world/frame/type and clock domain require confirmation | Actual source packer parity; no live LIO runtime exercised |

Malformed framing, unsupported versions/endian/dtypes, duplicate field names, nonfinite numeric arrays, invalid joint counts, bad quaternions, oversized packets, invalid dimensions and trailing bytes fail decoding. No packet is promoted to a healthy default. The decoder accepts the verified **Flow** v1 subset; the C++ generic packed reader supports more field variants which are not claimed here.

The source joint naming/order was compared directly to `g1deploy/contract.py`, not inferred from indices. MuJoCo/Unitree order is left leg, right leg, waist, left arm, right arm (29 names). IsaacLab order traverses the articulated tree breadth first. Both name lists are retained. Position units are rad, velocity rad/s, translations m, quaternions wxyz. No values are silently interpreted as degrees or xyzw.

## What SONIC intent is observable

The current Flow rehearsal uses `lucid-g1-deploy/config/observation_config_lucid_g1_1570.yaml`. Its fused model receives 1570 floating-point observations and emits 29 policy actions. The observations contain:

- Reference: 10 × 29 joint positions, 10 × 29 velocities, 10 × 6 pelvis orientations: 640 floats.
- Proprioceptive histories: 10 frames of angular velocity, joint position, joint velocity, previous action and gravity: 930 floats.

This configuration has **no standalone encoder/token_state observation**. A latent vector cannot be recovered from the demonstrated recording. The useful observable input is the actual reference/lookahead. Its ten future rows correspond to current playback frame plus `0,5,...,45` at a configured 50 Hz policy cadence, a 0–0.9 s lookahead. This is a configured horizon, not proof of an observed playback cursor or guaranteed future execution.

Other runner configurations can use `GatherTokenState()`: either TensorRT encoder floating-point output or an externally supplied vector. `g1_debug.token_state` exports that vector when post-state data exists; otherwise it is empty. Its dimension comes from configuration (64 is a source fallback, not a universal contract). The decoder preserves actual values and shape. The source does not establish discrete semantic codes or human-readable token labels. No confidence scores are fabricated.

The selected smoke `closed_loop.npz` stores `references[T,10,67]`: joints `[0:29]` and velocities `[29:58]` in MuJoCo order; relative pelvis 6D rotation `[58:64]`; diagnostic heading-frame root delta `[64:67]`. The last three values are **not consumed by SONIC**. Relative orientation is projected with the actual `g1deploy/sonic.py:project_rotation_6d` Gram–Schmidt procedure, then related to the corresponding `pre_action_qpos` root orientation. Raw 6D values need not be perfectly orthonormal.

## Source traps that change the UI meaning

1. `output_interface.hpp` sets `base_trans_measured = {0,-1,0.793}`. This is a fixed display offset, **not measured localization**. The debug decoder preserves it only in raw fields and returns `measured.root_translation = null`.
2. `body_q`/`body_q_measured` already have default angles restored and are in MuJoCo order. `last_action` is already scaled and offset. Applying these transforms again is wrong.
3. `last_action` reports a scaled policy target, not an independently observed DDS `rt/lowcmd`. Delivery, gains, CRC and actual hardware application cannot be established from that field.
4. `body_q_target` and target root arrays can be zero/default values if the current motion is invalid. The writer exports no corresponding validity flag. Decoder reference validity is therefore unknown.
5. `ros_timestamp` is `0.0` without ROS. The decoder treats this as missing, not epoch zero and not zero latency. Even a nonzero ROS stamp is not automatically proven to be wall time or synchronized to the collector.
6. `pose.frame_index` identifies requested motion frames. Chunks overlap and may trigger catch-up/reset, so these indices are not packet sequence numbers. Drop count and active playback position remain unavailable from this stream alone.
7. The ROS LIO bridge sends `time.monotonic()` at forwarding/filter time, not the original sensor header timestamp. It also emits an all-zero `ang_w` placeholder. Raw fields are retained, with no claim of measured zero angular velocity or true sensor-to-control latency.
8. `g1_debug` source comments describe older field counts; the current writer also packs `motor_temperature`. The decoder preserves extra fields rather than trusting the introductory table.
9. `cloud.stamp` is **simulation time** in `sim/realtime/robot_sim.py`, while the ROS LIO bridge uses **host-monotonic forwarding time** for `cloud.stamp` and `odom.stamp`. The packed schema carries no clock-domain tag. The decoder preserves the numeric stamp but returns `source_clock: "unknown"` for both topics, even when an optional `wall` field exists. Timestamp magnitude does not identify the source clock. Collector receipt time remains explicitly `collector_host_monotonic`; no source-to-receipt latency is inferred. A future source-specific adapter must supply verified producer attribution and clock alignment before overriding this unknown domain. `pose.timestamp_monotonic` has an explicit field meaning and retains its separate source-host-monotonic contract; it is still not aligned to the collector by assumption.

## Recording and communication diagnostics

A recorder-owned disk thread drains a bounded drop-oldest queue; ZMQ receive HWM, maximum message bytes and output file bytes are bounded. File creation is exclusive. The collector uses 50 ms polls and does not touch controller startup/stop. Browser closure is unrelated to capture lifetime. Queue drops, decode errors, byte limit and writer errors are reported. This protects the collector from unbounded backlog; it does not certify a producer's real-time behavior.

For each observed endpoint/topic, diagnostics include receive age, sampled receive rate, packet sequence gaps/duplicates/restarts **only when an actual sequence exists**, and ZMQ socket monitor connect/disconnect events. A connected but silent stream becomes stale; silence alone is not asserted to be producer death. Initial state is unavailable. End-to-end/source latency stays null without clock alignment. Rate is the last received window, not a fabricated current rate during silence.

Recorded envelopes include original `wire_base64` by default so source-byte decoding can be repeated. The JSONL includes `capture_start`, timestamped telemetry, periodic health, transport events and `capture_end`. `studio.capture_replay.load_capture()` imports a bounded, single-endpoint, pose-only capture into the browser's synchronized timeline. It re-decodes the saved wire bytes and verifies their values, joint names and source timestamp against the normalized envelope. Each frame causally retains the latest reference and receiver health; socket connect/disconnect and recorded stale transitions are timeline events. The demonstrated capture contains no robot state, world root translation or model identity, so all measured pose/model fields remain null and world-space robot/ghost rendering is unavailable. The reference inspector still shows the actual named joint windows and wxyz values. No guessed root placement is supplied.

The capture's observed graph describes only the receiver's endpoint/topic connection; it does not discover the publisher process, policy, ROS graph or DDS traffic. Its edge rate, receive age and status follow the cursor through `frame.observed_graph`. The initial session graph is not a final-state summary. A communication graph populated from deployment source remains configured/source-inspected, never runtime-discovered. The isolated wire acceptance proves one observed loopback PUB/SUB edge only. An adjacent acceptance receipt may attribute the owned reference publisher only if it includes both the exact capture path and matching SHA-256; old receipts without a capture hash leave publisher identity unknown.

Capture imports are limited to 64 MiB, 10,000 input events and 3,000 displayed frames. Diagnostic events are retained when ordinary telemetry frames are thinned; an excessive diagnostic count is rejected. Missing clock-origin records, backwards collector time, mismatched original bytes, fabricated pose sequence gaps, and source/receipt clock mismatches fail closed. Recordings without a final capture-end record are explicitly marked incomplete. Per-frame `event_index` is file ordering, not a packet sequence identifier.

```bash
# Only against an explicitly approved local telemetry producer; does not launch one.
.venv/bin/python -m studio.recorder \
  --endpoint tcp://127.0.0.1:5557 --topic g1_debug --topic robot_config \
  --duration 10 --output /absolute/path/new-capture.jsonl

# Creates an owned random-port loopback producer using existing recorded values.
.venv/bin/python tools/accept_wire.py --output-dir /absolute/path/new-wire-evidence
```

Executed evidence: `/home/linjiw/research-data/g1-deploy-studio/evidence/wire-20261015/wire_acceptance.json` and `wire_capture.jsonl`. Forty packets were sent/received at approximately 49.34 Hz; named-joint error against original recorded values was exactly 0 rad. Silence and an actual owned publisher disconnect produced stale/disconnected observations. This was **newly serialized recorded data**, not original wire traffic, a fresh SONIC policy run, or DDS actuation. The sparse ten-row chunks validate framing, not C++ merger behavior. Unit tests separately exercised queue overflow with a blocked disk worker, storage bounds and protocol sequence gaps.

## DDS and ROS: inspected, not opened

| Component | Source-inspected topics/types | Present implementation status |
| --- | --- | --- |
| SONIC runner | reads `rt/lowstate`, `rt/secondary_imu`, hand state; writes `rt/lowcmd` and optional hand commands | Controller remains in reference repo; no launch or DDS adapter in Studio |
| SONIC simulator bridge | writes lowstate/secondary IMU/hand state and optional `rt/odostate`; reads lowcmd/hand commands | Read-only source inspection |
| Grandloco runner | `unitree_hg::msg::dds_::LowState_` in; `LowCmd_` out; secondary IMU and custom `gl/height_map` input | Alternative backend, not a stage after SONIC; no runtime imported |
| Grandloco mapping | raw `rt/utlidar/cloud_livox_mid360` PointCloud2; lidar IMU; lowstate; custom map | Runtime absent from demonstrated session |
| Grandloco custom height map | 17×11, 0.1 m, pelvis-z minus ground-z, source flag, seq, monotonic state/pub stamps, observed fraction | Per-cell observed mask is not in this DDS struct; a fraction must not be converted to a full mask |
| ROS LIO bridge | `/aft_mapped_to_init` or `/Odometry`, optional `/cloud_registered`, lowstate → ZMQ `odom`/`cloud` | Source explicitly says untested; no ROS graph/TF discovery claimed |

DDS topic writer/reader counts, QoS, host identity and traffic rates cannot be discovered by reading these files or through the ROS graph alone. There is no generic discovery claim. Future collectors must be subscription-only, pin the correct SDK/types and record domain/interface/clock/frame provenance.

## Inspected source paths

All paths are external, read-only integration sources:

- `/home/linjiw/code/g1-student-deploy/g1deploy/zmq_stream.py`, `contract.py`, `sonic.py`, `adapters/ros2_lio_bridge.py`, `sim/realtime/rehearse.py`.
- `/home/linjiw/code/g1-student-deploy/bundle/flow/src/motion2scene_flow/closed_loop/feed.py`.
- `/home/linjiw/lucid-sonic/lucid-g1-deploy/runner/src/g1/g1_deploy_onnx_ref/include/output_interface/zmq_output_handler.hpp`, `output_interface.hpp`, `input_interface/zmq_packed_message_subscriber.hpp`, `input_interface/streamed_motion_merger.hpp`, and `src/g1_deploy_onnx_ref.cpp`.
- `/home/linjiw/lucid-sonic/lucid-g1-deploy/config/observation_config_lucid_g1_1570.yaml`, `sim/gear_sonic_sim/unitree_sdk2py_bridge.py`.
- `/home/linjiw/newton-terrain/deploy_g1/{g1_common.py,msgs.py,runner.py,policy_io.py,sim_g1.py,mapping_node.py}`.

The wire receipt contains SHA-256 identities for the exact recording and three pure source modules used during acceptance. Reference Git heads are in `config/references.json`; they are not guarantees of clean worktrees.
