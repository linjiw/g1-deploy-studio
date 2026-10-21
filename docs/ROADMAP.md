# Delivery roadmap

## Status (2026-10-20, v0.4)

Current state, results and open issues are in [STATUS.md](STATUS.md). This page is the delivery plan.

**Done by v0.4.**

| Area | Status |
|---|---|
| Service | Durable loopback service. |
| Rehearsal | A general policy-profile layer. The adopted Flow WX-RF block runs in the CPU rehearsal alongside the frozen bundle, with pinned identity in every run. |
| Navigation | Custom navigation arenas with start/goal presets, success criteria, bounded suites, and a runs table with trajectory comparison. |
| UI | Workspaces, a lane timeline, evidence chips, a robot-view inset and a system map. |
| Robot contract | A source-verified Unitree G1 contract with 15 recorded source discrepancies: the hip limit is resolved and domain 0 mitigated, the rest stay open. |
| Fidelity | Planner latency with measured or predictive anchoring (L2/L2≈), G1 actuator profiles, and a ready L3 launcher with automatic import. |
| Delivery | Gzip, ETag, content-addressed meshes, bounded caches. |

**Next steps toward read-only physical G1 integration.** Status on 2026-10-20 after the research round:

1. **Contract discrepancies** (`docs/ROBOT_CONTRACT.md`):
   - *Hip effort limit*: resolved by research. The limit depends on `LowState.mode_machine`. Studio rehearses with actuator profiles (`g1-current` 139/139/88 by default, `g1-rev1` 88/139/88, `source` 88/88/88) and counts substeps over every reference.
   - Still open: the one-sided runner velocity abort, which is disabled in simulation, and ankle/waist roll-pitch at 35 vs 50 N·m.
2. **Isolated real-time rehearsal (L3)**: decided and ready. The unchanged chain runs inside a loopback-only user+net+PID namespace (domain 0 cannot leave it).
   - `tools/l3_rehearsal.sh` is reviewed and its dry run passes. The first real launch waits for an operator: this session's permission policy blocked it as a deployment action.
   - Next: run it on Studio-authored tasks, import `rehearse/` and `capture.jsonl` into replay, and compare with L1/L2 at the deployed budget (K16/ODE10).
   - An upstream `--dds-domain` remains a defence-in-depth follow-up.
3. **Latency (L2)**: done. A delayed-execution wrapper with *measured* or *predict* anchoring for both profiles.
   - WX at 200 ms goes from 1/12 with the measured anchor to 11/12 with predict on the deprecated 88 N·m model. On the current-G1 limits it holds 12/12 at the robot's 160 ms budget but only 21/36 at 200 ms over three seeds (ROBUSTNESS Addenda C–E).
   - Remaining: the prediction is optimistic, because SONIC lags the plan. Predicting the executed state, for example with the WM-v2 execution model, is a Flow research decision.
4. **WX in perception.** WX-RF is privileged: it plans from the exact boxes. A deployable WX needs the Flow side's LiDAR-conditioned block (round ST, not adopted). When Flow adopts one, pin it as a new profile; the arena, suite and runs workflow does not change.
5. **Read-only robot observation (M5)** after a safety review:
   - a robot-side collector with allowlisted readers;
   - Studio's live mode fed from it, with observe-only banners and stream ages shown against the source thresholds already in the contract;
   - the physical E-stop owned by the operator;
   - the first passive reading must include `mode_machine`, which selects the actuator profile.
6. **Real-world navigation workflow**: designed in [REAL_WORLD_DEPLOYMENT.md](REAL_WORLD_DEPLOYMENT.md). Phases: 0, build sheet and post-run import; twin, scan to arena; 1, live view; 2, goals on the live map (needs a decision on the control socket); 3, site maps.


## Current implementation status (2026-10-15)

- Simulation workbench implemented: actual CPU Flow/SONIC/MuJoCo tests, editable map/goal/scenario settings, bounded owned jobs, live state attachment, synchronized ray-LiDAR/filter/map recording, pinnable sensor views and replay of fresh results. This is explicitly in-process CPU execution; it does not remove the full C++/DDS or hardware validation gaps below. Scan imports support inspection and goal preflight, not automatic collision reconstruction.

- M1 implemented: actual recorded lockstep SONIC replay, matching articulated model, reference ghost/window, synchronized timeline, named-joint errors, planner latency, source hashes, and MCAP roundtrip. A second recording exercises the historical separated C++/DDS process chain with explicit missing-reference limitations.
- Parts of M2/M3 implemented: bounded loopback-only ZMQ capture and actual-source binary decoders; real recorded values transmitted/recorded and opened in the browser with observed fresh → stale → disconnected transitions; final map snapshot, configured topology and unavailable-metric handling.
- Full C++/DDS rehearsal: superseded on 2026-10-20 by the namespace-isolated launcher (item 2 above). No upstream edits were made, and no new full controller run has been made yet. Runtime ROS/DDS discovery, synchronized raw LiDAR history and new full deployment captures remain open.
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
