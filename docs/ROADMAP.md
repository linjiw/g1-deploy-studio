# Delivery roadmap

## M0 — reference/bootstrap (this commit)
Local Git repository, verified path/HEAD inventory, pipeline/safety rules and tested read-only reference checker. No dashboard, ROS installation or simulator launch.

## M1 — recorded-session vertical slice
Select one actual SONIC rehearsal artifact and document its format/license. Implement an adapter and browser view of measured named joints plus reference ghost, timestamped health and scrub/replay. Include explicit fixture mode for tests. Acceptance: compare sampled decoded values to the original artifact, show a real replay, test missing/stale fields. Do not invent a recording if none is suitable.

## M2 — real simulator telemetry
Integrate g1-student-deploy real-time rehearsal and the existing g1_debug stream; isolate DDS on loopback/non-hardware domain. Display the simulated MID-360/map and actual supervisor/stream states. Acceptance: record and replay an end-to-end run; kill only owned simulator-side telemetry clients to test control-loop independence. No robot packets.

## M3 — communication and perception cockpit
Add ROS 2 graph/TF where available, explicit DDS/ZMQ collectors, rate/age/drop diagnostics and current versus reference pose. Connect grandloco as a separate backend. Acceptance: stop an owned producer, verify graph/stale flags, validate clock/frame alignment. Avoid heavy repeated simulation sweeps.

## M4 — deployment rehearsal console
Surface versioned bundle/model/calibration receipts and bring-up ladder; support latency/dropout simulation and timeline correlation. Recordings/configs outside Git, bounded storage and no recursive snapshots.

## M5 — live read-only observation
Only after explicit approval: local collector on the robot-side network; robot variant, middleware/QoS, clocks, mounts and data exposure verified. Observe without motor/hand publishing. Actual policy/hardware control is a separate safety-reviewed project scope, not implicit in M5.

## Deferred
Remote actuation, unattended policy start, hardware E-stop claims, full simulator fidelity certification, unbounded training and external publication. A UI digital twin does not certify physical equivalence.
