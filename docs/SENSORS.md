# Sensor and perception inspection

The sensor inventory reports what the selected recording actually contains. An unavailable card has a reason, no payload and null age/rate; it is never a healthy zero. Robot pose from a MuJoCo recording is labelled simulator ground truth. It does not prove that DDS state or an IMU packet was received.

| View | Historical C++/DDS replay | New isolated CPU rehearsal |
| --- | --- | --- |
| Robot base pose and named joints | Actual simulator physics samples | Actual simulator physics positions, velocities and separately labelled SONIC PD targets |
| Obstacle contact force | Recorded simulator obstacle force | Only when recorded by the worker |
| Support and ceiling map | Final accumulated snapshot; acquisition time unavailable | Causal snapshots of the map consumed by the planner |
| Simulated raw ray returns | Unavailable | Actual `MjRayMemory` input points, registered in world |
| Robot-filtered returns | Unavailable | Actual range-gated and capsule-filtered evidence input |
| Raw MID-360 DDS packets | Unavailable | Unavailable; ray returns do not implement the physical sensor packet model |
| Pelvis IMU view | Packets were not recorded | Simulator orientation and body angular velocity; acceleration unavailable |
| Odometry packets, MID-360 IMU | Packets were not recorded | Unavailable unless explicitly captured |
| RGB/depth cameras | Unavailable | Unavailable |

The small historical lockstep recording contains base pose and joints, with no recorded perception. The fresh CPU backend is an explicitly simplified, in-process policy test; these views do not claim a new DDS/C++ deployment run. Neither backend enables hardware access.

The sensor drawer can pin available data into the display. A cloud with an unverified world frame can be inspected in its own coordinate system but must not silently overlay the robot. Final maps retain their **unsynchronized** label even while playback is moving. They cannot be used to infer what the robot saw at an earlier cursor.

## Normalized sensor contract

`studio.sensors.get_sensor_snapshot(session, time_s)` provides the versioned inventory used by `GET /api/sensors?session=ID&time=SECONDS`:

```text
schema_version: 1
session_id, cursor_s, mode, clock_domain, hardware_enabled: false
available_sensor_ids: [...]
sensors: [{
  id, label, kind, render_hint, available,
  status: fresh | stale | unavailable | unsynchronized,
  classification, validity, frame_id,
  source_time, source_clock, receipt_time, receipt_clock,
  sample_time_s, age_ms, sequence, rate_hz, rate_basis,
  synchronized, units, extrinsics, provenance,
  can_pin, overlay_compatible, payload, reason
}]
```

Stable IDs are `base_pose`, `joints`, `contact`, `map_support`, `map_ceiling`, `lidar_raw`, `lidar_registered`, `lidar_filtered`, `odometry`, `imu`, `lidar_imu`, `rgb_camera`, and `depth_camera`. `lidar_raw` represents returns before the selected source's range/body filtering, with source basis attached. The CPU source labels this view **Simulated ray returns**; it is not a physical MID-360 raw packet recording.

Point and map payloads contain `points` in metres. Pose payloads use `position` and `quaternion_wxyz`. Joint payloads preserve `joint_names`, radian `position`, recorded `velocity` in rad/s, and separate `commanded_position` with command time, kind and classification. PD gains and effort limits are explicitly mapped by joint name from the source control contract. Unrecorded velocity, applied effort and faults remain null; a position target does not prove DDS command delivery or actual torque. Contact force uses newtons and names its simulated obstacle scope; it is not a foot force/torque sensor.

The fresh worker's explicit `frames.imu` is exposed as **Pelvis IMU · simulator truth**. Its quaternion rotates the pelvis frame into `world`; angular velocity is expressed in `pelvis`, in rad/s. These are the actual MuJoCo state quantities read by the source tracker. `linear_acceleration_m_s2` remains null, and `physical_sensor_packet` is false. The adapter does not reconstruct an IMU for historical recordings that lack this field.

Perception time series are selected with `sample.time <= cursor`. Sensor age uses `sensor_capture_time`; accumulated map age uses `map_time`. The source's simulated sensor latency is preserved. Future snapshots are never consulted to fill an earlier map. Source/receipt clocks are distinct, and age in the session timeline is not end-to-end network latency. The recorded snapshot rate is not advertised as DDS message rate.

Maps retain observed masks or sparse observed indices, resolution, origin, unknown-cell count and observed-clear ceiling count. Absent cells remain unknown. Sparse observed indices flatten the source's `grid[x][y]` arrays in C order. Finite points are bounded to 5,000 per sensor view; upstream decimation and original counts remain visible when supplied. Clear ceiling evidence is retained in masks/indices even though infinite heights are not renderable points.

The configured simulator mount transforms are available under `extrinsics.transforms`. They are labelled simulator configuration, with no physical calibration identity. A historical recording with no calibration retains `extrinsics.available: false`.

## Optional recorded telemetry

For fresh CPU navigation runs, obstacle contact is sampled directly from `Physics.step` and retained in `physics_observations.npz`. A sensor/Health value is the maximum of the preceding completed control interval, with interval provenance and simulation timestamps. The first sample remains unavailable. `post_action.contact` separately preserves the four current-interval force samples. Tests reject any future interval endpoint at the requested cursor. These forces exclude floor contacts and are not physical foot sensors.

`load_sensor_capture(path)` reads an explicitly selected, bounded `studio.recorder` JSONL and re-decodes its original wire bytes. It supports `cloud`, `odom` and `g1_debug` sensor views; `pose` and `robot_config` remain available to their existing intent/configuration adapters. It refuses missing/corrupt wire bytes and non-monotonic or incompatible receipt clocks. It never trusts cached normalized numeric payloads as substitutes for wire evidence.

Pass its `envelopes` to `get_sensor_snapshot(..., capture_envelopes=...)` only on the capture's own relative collector timeline. Alignment to a separate robot recording is **unavailable**, not guessed. Cloud packets do not prove self-filtering or the world frame; the registered-cloud card says so. SONIC debug data supplies joint state and orientation, but its fixed `base_trans_measured` placement remains excluded from localization. Debug orientation does not fabricate raw IMU acceleration/gyro.

This adapter itself opens no transport, launches no publisher, imports no controller and adds no DDS participant. The browser sensor endpoint remains replay/read-only. Runtime ROS/DDS sensor discovery and new physical camera/IMU recording still need a separately authorized collector integration.

## Source checks and verification

The implementation was checked against these current, read-only source files:

- `g1-student-deploy/sim/realtime/robot_sim.py`: `qpos` at every fourth physics step; `wall`, root and obstacle contact at every second step; original raw scans are not saved to `sim.npz`.
- `g1-student-deploy/sim/scene.py` and `sim/episode.py`: the worker records source `measurement` joint velocities and pelvis/body angular velocity, and the actual policy step's PD targets. Quaternion/frame conventions remain explicit.
- `g1-student-deploy/g1deploy/node.py`: DDS lowstate/odostate inputs, raw DDS LiDAR receiver, filtered mapping pipeline, final `node_memory.npz` dump without capture timestamp.
- `g1-student-deploy/g1deploy/perception/unitree_lidar.py`: sensor frame, physical packet layout, deskew, mount and self-filtering semantics. Source documents this interface; Studio has not hardware-validated it.
- `g1-student-deploy/g1deploy/adapters/ros2_lio_bridge.py`: registered `cloud` and `odom` ZMQ contracts; source explicitly marks ROS integration untested.
- `g1-student-deploy/g1deploy/zmq_stream.py`: actual pure serializer used for decoder parity.

Run:

```bash
.venv/bin/python -m unittest discover -s tests -p test_sensors.py -v
```

Tests compare sampled Dex3 named joints, source timestamps, simulator contacts and actual map heights/masks against the selected `A_quickstart` NPZ files. They also compare actual fresh-worker IMU orientation/body angular velocity, joint velocities and PD targets against recorded frames, with unavailable acceleration/torques preserved. Other checks cover causal perception and separate capture/map ages, stale/missing behavior, name-mapped gains, source-serializer byte decoding, rejection of corrupted captures, and exclusion of SONIC placeholder translation. These are replay and decoder checks, not physical sensor validation.
