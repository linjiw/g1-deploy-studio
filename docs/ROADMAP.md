# Delivery roadmap

## Status (2026-10-20, v0.2)

**Done in v0.2.**

| Area | Status |
|---|---|
| Service | Durable loopback service. |
| Rehearsal | A general policy-profile layer. The adopted Flow WX-RF block runs in the CPU rehearsal alongside the frozen bundle, with pinned identity in every run. |
| Navigation | Custom navigation arenas with start/goal presets, success criteria, bounded suites, and a runs table with trajectory comparison. |
| UI | Workspaces, a lane timeline, evidence chips, a robot-view inset and a system map. |
| Robot contract | A source-verified Unitree G1 contract with 15 recorded source discrepancies. |
| Delivery | Gzip, ETag, content-addressed meshes, bounded caches. |

**Next steps toward read-only physical G1 integration.** Each step needs the owner approval noted.

1. **Resolve the high-severity contract discrepancies** (`docs/ROBOT_CONTRACT.md`):
   - hip effort limit: 139 N·m in training vs 88 N·m in the MuJoCo models and simulator clip;
   - the runner velocity abort is one-sided and disabled in simulation;
   - DDS domain 0 everywhere.

   This needs the runner and simulator owners.
2. **Isolated real-time rehearsal (L3).**
   - Upstream (owner approval): add a non-zero `--dds-domain` to the SONIC runner, `robot_sim` and `node.py`, failing closed on domain 0.
   - Studio: add a `realtime-rehearsal` profile that launches only that loopback/non-zero-domain chain.
   - Studio: add a subscription-only collector for `g1_debug`/`robot_config` (ZMQ :5557) and `rt/lowstate`/`rt/lowcmd` readers on that domain. Edges in the System map then turn *observed*.
3. **Latency-faithful lockstep (L2).** Apply each plan after a modelled or measured planner latency (`fixed:<ms>` or the measured distribution), so CPU rehearsals expose stale-plan effects. This needs a Studio-side wrapper of the lockstep and callback loops; no reference repository changes.
4. **WX in perception.** WX-RF is privileged (exact boxes). A deployable WX needs the Flow side's LiDAR-conditioned block (round ST, not adopted). When Flow adopts one, pin it as a new profile. The arena, suite and runs workflow is unchanged.
5. **Read-only robot observation (M5)** after a safety review:
   - a robot-side collector with allowlisted readers;
   - Studio's live mode fed from it, with observe-only banners and stream ages shown against the source thresholds already in the contract;
   - physical E-stop owned by the operator.


## Current implementation status (2026-10-15)

- Simulation workbench implemented: actual CPU Flow/SONIC/MuJoCo tests, editable map/goal/scenario settings, bounded owned jobs, live state attachment, synchronized ray-LiDAR/filter/map recording, pinnable sensor views and replay of fresh results. This is explicitly in-process CPU execution; it does not remove the full C++/DDS or hardware validation gaps below. Scan imports support inspection and goal preflight, not automatic collision reconstruction.

- M1 implemented: actual recorded lockstep SONIC replay, matching articulated model, reference ghost/window, synchronized timeline, named-joint errors, planner latency, source hashes, and MCAP roundtrip. A second recording exercises the historical separated C++/DDS process chain with explicit missing-reference limitations.
- Parts of M2/M3 implemented: bounded loopback-only ZMQ capture and actual-source binary decoders; real recorded values transmitted/recorded and opened in the browser with observed fresh → stale → disconnected transitions; final map snapshot, configured topology and unavailable-metric handling.
- New full C++/DDS rehearsal blocked: source hard-codes domain 0, and NVML reports driver/library mismatch. No upstream edits or new full controller run performed. Runtime ROS/DDS discovery, synchronized raw LiDAR history and new full deployment captures remain open.
- Live read-only bring-up is documented, not enabled or hardware validated.

See `docs/ACCEPTANCE.md` for executable evidence. The original sequence below remains a roadmap, not a claim that all milestones passed.

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
