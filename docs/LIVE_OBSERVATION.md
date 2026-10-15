# Physical G1 observation: preparation and limits

**Physical G1 observation has not been run or authorized.** Studio currently performs file replay and optional loopback ZMQ telemetry subscriptions. It has no DDS participant, motor publisher, hand publisher, policy startup action, or robot stop action. A browser button cannot provide a physical emergency stop. Simulation/replay evidence is not hardware verification.

## Current blocker for a fresh canonical SONIC rehearsal

The inspected C++ runner initializes `ChannelFactory::Instance()->Init(0, networkInterface)` in `g1_deploy_onnx_ref.cpp` (line 2185 at inspection). The existing Flow `sim/realtime/rehearse.py` invokes it with interface `lo` and no DDS-domain argument. Loopback interface selection does not satisfy this project's explicit requirement for a nonzero simulator-specific DDS domain. No runner was launched and no reference source was edited to bypass that boundary.

A separately approved change to the controller source/build must expose and validate a simulator DDS domain, then verify that the simulator, planner/state collector and runner all use the same explicit nonzero domain on loopback. Fail closed when any participant cannot prove its domain/interface. Do not set a generic environment variable and assume this hardcoded C++ initialization obeys it. Do not use an alternate policy backend as evidence that SONIC inference ran. Grandloco's inspected sources default to domain 1/`lo`, but that is a separate backend with its own validation work.

Other requirements before a fresh SONIC run: identify exact policy/bundle/observation configuration, controller binary versus source parity, CPU/GPU engine availability, owned ports/processes, and a bounded output directory outside reference worktrees. The known NVML condition must be checked; unavailable GPU telemetry does not indicate spare GPU capacity. Repairing drivers, rebooting, modifying robot networks, or stopping existing jobs are outside incidental setup.

## Dependencies to verify before an authorized hardware observation

1. Record the physical robot serial/model variant (29-DoF and hand variant), firmware, motor name/index mapping, policy identity, gain configuration and calibration hashes. The demo's body model is not a hardware identity receipt.
2. Select the SDK copy matching the running robot/controller, from the intended SONIC repository's SDK/thirdparty dependencies. Do not combine arbitrary SDKs through a global `PYTHONPATH`. Validate IDL types for `rt/lowstate`, `rt/secondary_imu`, optional lidar/hand state and any read-only command monitor.
3. Read the current SONIC `docs/ETHERNET_AND_SDK.md` and hardware bring-up procedures with the operator; identify the intended interface/domain and the existing command writer. This project has not run those procedures. Do not launch hardware scripts as a discovery shortcut.
4. Verify independently operated physical emergency stop, gantry/support as appropriate, operator responsibilities and exclusion area. Keep observation separate from permission to enable motor control. Never start two command writers on one robot bus.
5. Verify root pose provenance. SONIC debug translation is a fixed visualization offset. Real world pose requires validated LIO/odometry, sensor extrinsics and transforms. Record map→odom→pelvis→head/lidar conventions and timestamps; the ROS bridge's forwarding stamp is not a sensor hardware timestamp.
6. Establish clock domains and time synchronization across the robot/controller/gateway. Receive-age diagnostics can operate without synchronization; end-to-end latency cannot. Confirm sensor clock behavior, reset/wrap behavior and dropout thresholds using observed samples.
7. Confirm DDS networking and QoS separately from ROS 2 graph inspection, and ZMQ connections separately from DDS. Document configured topology before collecting runtime evidence.

## Intended observation steps, after explicit authorization

- Leave motor ownership with the existing runner and operator. Attach a telemetry subscriber to existing read-only streams; do not start a controller to obtain data.
- The current Studio collector intentionally accepts literal loopback endpoints only. Put it beside a safely scoped telemetry source or approved tunnel. The C++ debug handler itself currently binds `tcp://*:<port>`; Studio connecting to loopback does not make that wildcard publisher private. Review binding/authentication/exposure before enabling that producer. Do not publish it openly or change global firewalls incidentally.
- A future robot-side DDS collector must use an explicit allowlist of **readers only**. Start with lowstate, secondary IMU and independently validated lidar/odometry; exclude command writers by construction. Observing an existing `rt/lowcmd` writer can be a separately reviewed reader-only capability, never a publisher.
- Capture a short, operator-supervised stationary observation first. Compare individual named joints and quaternion values with native SDK/runner diagnostics. Verify nonzero/missing telemetry, sequence behavior, clocks and disconnect transitions. Preserve original packets and model/calibration receipts.
- Check that closing the browser, disconnecting the visualization consumer and a slow disk do not affect controller execution. The current bounded-queue test establishes collector behavior only; hardware timing independence requires hardware observation.
- Only then authorize movement observation under the operator's separate deployment procedure. Deployment command support is a later, separately reviewed scope.

No robot-side installation command is supplied because SDK/firmware/interface choices and physical operator authorization are still unverified. The concrete runnable local recorder is documented in [INTERFACES.md](INTERFACES.md). Its endpoint guard cannot be overridden to reach hardware.

## Missing hardware validations

No physical actuation or observation; no DDS QoS/traffic observation; no controller-loop timing measurement; no physical model/calibration parity; no raw lidar/self-filter/unknown-mask hardware check; no real fault/temperature verification; no clock-sync receipt; no observed command delivery or gains; no physical emergency-stop test. These remain explicit missing validations, not checklist items marked complete by simulation.
