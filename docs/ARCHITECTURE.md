# Architecture and SONIC integration contract

## Preserve the existing control chain

```text
MID-360 / IMU / joints --Unitree DDS--> deployment perception + state
LIO --optional ROS 2--> existing LIO bridge --ZMQ--> state estimator
state + map + goal --> Flow planner --ZMQ pose references--> SONIC C++ runner
SONIC C++ runner --Unitree DDS rt/lowcmd--> simulated or physical G1
                              |
               read-only telemetry adapters
                              v
       normalized timestamped events -> recorder / gateway -> browser cockpit
```

The grandloco runner is an alternative low-level policy backend, not an additional stage after SONIC. Give each session an explicit backend identity (`sonic` or `grandloco`); never run both motor writers against the same robot/domain.

## Initial contract to verify against source

The inspected Flow design documents policy/reference cadence at 50 Hz and low-command output at 500 Hz. It describes ZMQ protocol v1: topic `pose`, 1280-byte padded JSON header, little-endian joint position/velocity arrays in IsaacLab order, wxyz body quaternions and int64 frame indices. The runner uses a 10-frame future reference spaced at 0.1 s and requires reference lookahead/buffering. Confirm these fields and timing in the current stream packer and C++ reader before implementing an adapter; do not reconstruct the packet by guesswork.

SONIC's documented tracker does not directly receive global root position/height; do not label planner world-path estimates as tracker observations. Inspect current observation/contract definitions before plotting errors.

Read telemetry from `g1_debug` via the existing ZMQ output handler when available. ROS output handlers exist but their build/runtime availability must be checked. The LIO ROS adapter is explicitly marked untested in its source. There is no verified standard ROS installation on this host from the initial inspection.

## Normalized telemetry requirements (design, not implemented)

Every envelope: session_id, backend_id, source_id, sequence, source timestamp, receipt timestamp, clock domain, frame_id, schema version, provenance and validity/staleness. Payloads: named joint state/reference, root estimate with uncertainty where available, IMU, robot faults/temperatures if supplied, point clouds, elevation/ceiling maps with observed masks, routes/candidates, supervisor transitions and runtime health.

Use explicit TF-style transforms: map -> odom -> base/pelvis -> torso/head -> lidar/camera. Preserve calibration and joint ordering from the selected robot variant; do not interchange 23/29-DoF, hand/no-hand or rubber/Dex3 models. Observe real connections first; a declared diagram must be labelled configured, not discovered. ROS 2 graph discovery, DDS type/topic introspection and ZMQ heartbeat metrics need separate collectors.

## UI and safety

Replay, simulated and live data have persistent visible mode badges. Truth overlay is allowed only for simulation and separate from the estimated twin. Show state age, plan age, map age, clock sync, inference latency, drops and module faults. Missing NVML must display unavailable, not idle or zero GPU use.

The first live adapter is subscription-only and allowlisted. Gateway defaults to loopback; remote developer access should use an authenticated channel/SSH tunnel rather than public DDS or unprotected WebSockets. Tailscale does not imply automatic ROS/DDS multicast discovery; keep the collector near the robot and export application telemetry. Never expose raw control topics to a browser.

## Suggested technical evaluation

Evaluate Foxglove + bridge/MCAP before custom visualization. If custom UX is needed, use a browser 3D frontend (React/Three.js) and an authenticated telemetry gateway, retaining recorded-data portability. ROS 2 TF2/robot_state_publisher and Unitree ROS type definitions are optional integration references to validate, not installed dependencies or completed features. Pin versions and review licenses before adding them.
