# Architecture and SONIC integration contract

## Implemented local slice

**v0.4 (2026-10-20).** Current state and open issues: [STATUS.md](STATUS.md).

| Area | Implementation |
|---|---|
| Actuator profiles | `studio.actuators` patches the compiled model's hip `jnt_actfrcrange` in memory per G1 hardware revision (`g1-current`, `g1-rev1`, `source`). It records a receipt per run and counts torque at the effective limit, min(source clip, model clamp). |
| Latency anchoring | `studio.latency_anchor` provides the pipelined delayed-execution scheduler (L2/L2≈) and the predictive anchor for the Flow callback. It is parity-tested against g1-student-deploy's `predicted_history`. Frames are attributed to the plan that is executing. |
| L3 real-time chain | `tools/l3_rehearsal.sh` runs the unchanged simulator, C++ SONIC runner and node inside a loopback-only namespace. `studio.server` discovers finished runs read-only and labels them L3 with their isolation receipt. |
| Policy profiles | `studio.policies` registers pinned policy profiles and parses the Flow adoption heading. |
| WX worker | `studio.policy_bundle` and `tools/build_policy_bundle.py` pin the adopted Flow WX-RF block. `studio.flow_policy_worker` runs Flow's own closed-loop callback on MuJoCo + SONIC ONNX through a minimal fake Isaac environment. |
| Workbench | Adds immutable arenas with presets, bounded sequential suites, the runs table and light live polling. |
| Robot contract | `studio.robot_profile` with `config/robots/g1_29dof.json` is a source-verified Unitree G1 contract with per-source values, citations and recorded discrepancies. |
| Gateway | Caches gzip and ETag bodies, serves content-addressed immutable meshes shared by every session, keeps a byte-bounded single-flight session cache, makes sensor masks opt-in, sends in chunks for slow tunnels, and reports the served build at `/api/version`. |
| Browser | `apps/web/js/` is split into modules: `scene`, `timeline`, `inspector`, `arena`, `rehearse`, `runs`, `sensors`, `system`, `util`. |
| Service | Runs as a systemd user service from a release worktree ([SERVICE.md](SERVICE.md)). |

**Earlier slice.**

The simulation workbench adds `studio.workbench` (bounded map/scenario storage and owned-process lifecycle), `studio.policy_worker` (actual frozen Flow + SONIC ONNX + MuJoCo CPU execution), and `studio.sensors` (causal sensor inventory and views). The HTTP process does not import policy runtimes or middleware. Its worker uses the existing reference environment read-only and produces atomic live snapshots plus complete replay sessions outside Git. Simulation-only POST operations require a same-origin token; no hardware control endpoint exists. See `docs/WORKBENCH.md` for runnable workflow and exact boundaries.

`studio.pipeline` observes actual model boundaries in this owned CPU worker: the first Flow forward per replan, SONIC inputs/outputs at 10 Hz, named action-to-target conversion and completed simulated PD intervals. Frames reference bounded sample arrays; live snapshots carry only the latest samples. Effective route configuration, source/model hashes and scorer distance/speed/hold samples are recorded. The browser Pipeline inspector preserves the simulation cursor and treats source model defaults separately from observed map coverage. It does not expose hidden ONNX activations or add inference calls during execution. Read-only recorded-input ONNX parity is an optional audit step. See [model pipeline](MODEL_PIPELINE.md) for conventions, timing and limits.

`studio.replay` decodes explicitly selected rehearsal directories into bounded v1 session data. `studio.model` exports the actual local MJCF body tree and individually allowlisted STL assets. `studio.server` serves the browser on loopback only, with no motor publishing or middleware imports. `apps/web` performs causal replay and articulated rendering. `studio.export` uses the MCAP library for indexed normalized-frame export/import.

`studio.protocols` decodes actual SONIC pose/debug/cloud formats; `studio.recorder` is an independent loopback SUB consumer with bounded drop-oldest disk buffering. It does not live inside the control loop or depend on a browser connection. `studio.capture_replay` adapts captured wire JSONL to the same browser timeline, with observed receiver-edge metrics and explicitly unavailable robot pose. It re-decodes original wire bytes instead of trusting a fabricated motion track.

See `docs/INTERFACES.md` for source-verified corrections to the original assumptions below: optional continuous tokens exist in debug output for encoder-enabled configurations, the demonstrated Flow tracker is fused, and debug base translation is a placeholder. No ROS/DDS runtime discovery or new controller execution is claimed.

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
