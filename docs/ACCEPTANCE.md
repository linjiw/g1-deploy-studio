# Executed acceptance and handoff — 2026-10-15

This delivery is a working local replay cockpit plus read-only telemetry capture/diagnostics. M1 is exercised; substantial M2/M3 observability pieces are implemented. **A new full SONIC/DDS controller rehearsal and physical robot observation were not performed.** The blockers and missing validations below remain open.

## Start and select evidence

Dependencies are installed in this checkout's `.venv` and `node_modules`. Start from the project root:

```bash
cd /home/linjiw/code/g1-deploy-studio
.venv/bin/python -m studio.server
```

Browser: **http://127.0.0.1:8790**. The QA server is temporary; this command starts your own session. Initial setup on another checkout is documented in README. Port 8765 was already occupied and was not disturbed.

The default recording is **SONIC · recorded lockstep rehearsal**. Select **SONIC · recorded C++ / DDS tutorial** for the separate-process historical recording and final map; select **ZMQ · observed transport diagnostics** for the newly captured reference receiver timeline. Direct links use `?session=sonic-lockstep`, `?session=sonic-dds-tutorial`, and `?session=wire-local`.

| Source | What the cockpit actually displays | Important boundary |
| --- | --- | --- |
| `g1-student-deploy/runs/smoke/__start_stand_` | 159 poses / 3.16 s, real SONIC reference windows, predicted root path, named joints, planner computation latency | Recorded in-process MuJoCo/SONIC; no DDS in the original run. Model is 29-DoF rubber-hand G1. |
| `g1-student-deploy/runs/video/A_quickstart` | 1,922 poses / 40.394009 s, Dex3 fingers, lifecycle events, planner timing, final map | Historical separate C++/DDS rehearsal. References, commands and timestamped LiDAR history were not recorded. |
| Studio `wire-20261015/wire_capture.jsonl` | 55 receipt-time frames, 40 actual ZMQ packets, observed receive rate and connect/stale/disconnect transitions | Recorded references were reserialized through the actual deployment packer. No new controller inference or original deployment packet capture is claimed. World pose/model identity are absent. |

## Tests and real execution

Executed commands:

```bash
python3 tools/check_references.py
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m studio.replay /home/linjiw/code/g1-student-deploy/runs/smoke/__start_stand_ \
  --environment /home/linjiw/code/g1-student-deploy/runs/rt/replay-beams2-101/boxes.json
.venv/bin/python -m studio.replay /home/linjiw/code/g1-student-deploy/runs/video/A_quickstart
.venv/bin/python tools/accept_wire.py \
  --output-dir /home/linjiw/research-data/g1-deploy-studio/evidence/wire-verified
# While the local server runs:
npm run test:browser
git diff --check
```

The reference checker passed all seven repositories without HEAD drift. **46 unit/integration tests passed.** These cover actual-source serializer parity; byte framing and malformed/oversized input rejection; actual NPZ samples; Isaac/native joint mapping; Dex3 qpos addresses; orientation projection; clock alignment/causal seek; map unknown/clear masks; bounded queue/drop/storage behavior; HTTP origin/path/control boundaries; wire-byte capture replay and MCAP roundtrip/indexing.

**13 browser acceptance checks passed** in installed Chrome with SwiftShader CPU rendering; no page exceptions, console errors or failed HTTP resources. Checked real mesh rendering, named-joint table/source values, play/pause/seek/speed, orbit/follow/top cameras, layer toggles, both robot models, state-hold diagnostic, missing-reference behavior, map overlay, configured versus observed graph, captured connection transitions, provenance, 390 px layout and browser disconnect.

For browser state/model parity, all 30 rubber-hand body transforms and 44 Dex3 body transforms matched MuJoCo kinematics. Maximum position error was `2.22e-16 m`; rotation-matrix element error was below `1.0e-15`. An independent review also compared measured/reference/+0.4 s/+0.9 s poses at three source timestamps: maximum position error below `1.4e-15 m`. These are numerical model/frame checks, not physical calibration evidence.

The source adapter compares original state/reference values exactly at sampled NPZ indices. Lockstep pre-action samples use `tick × 0.02 s`; post-action state is explicitly `+0.02 s`. The C++ recording's qpos timestamps use `wall[::2]`, verified against matching recorded root samples. `wall` is host monotonic, not UTC. Source and receipt clocks remain distinct.

Two actual local wire rehearsals passed: 40/40 packets decoded with **0 rad named-joint error**, no malformed packets and no recorder queue drops. The catalog capture observed about 49.34 Hz; the repeat with a hash-bound acceptance receipt observed about 49.73 Hz. These are last-window receipt-rate estimates, not controller frequency or traffic rates after disconnect. Silencing the owned producer generated stale status; closing its socket generated an actual transport-disconnected observation. No deployment ports were used: each publisher bound a newly allocated loopback port and was closed by its own acceptance process.

The UI's separate **hold state** control is explicitly labelled a replay diagnostic injection. It freezes one real sample while reference/playback advances, marks state stale after 100 ms, and suppresses tracking error while stale. It does not stop any producer/controller. Rewinding before the held sample or changing sessions clears the injection.

An indexed normalized MCAP export was written outside Git and read back without changing any frame values. Tests also round-trip wire diagnostics, preserving null pose and observed graph. MCAP index timestamps are labelled session-relative nanoseconds, not fabricated wall-clock acquisition dates. Browser model assets remain local dependencies.

## Evidence locations

All recordings, images and execution logs remain outside Git under `/home/linjiw/research-data/g1-deploy-studio/evidence/`:

- `reference-check.json`, `unit-tests.txt`, `host-gpu-check.json`
- `lockstep-decoder.json`, `dds-decoder.json`
- `sonic-lockstep.mcap` — normalized replay, not vendor models
- `wire-20261015/wire_acceptance.json`, `wire-20261015/wire_capture.jsonl` — catalog transport session
- `wire-verified/wire_acceptance.json`, `wire-verified/wire_capture.jsonl` — repeated run with capture SHA-256 and verified receipt attribution
- `browser/browser-acceptance.json`, `browser-run.txt`
- `browser/lockstep-intent.png`, `browser/named-joints.png`, `browser/dds-final-map.png`
- `browser/replay-stale-state.png`, `browser/observed-zmq-disconnect.png`, `browser/mobile.png`
- `review/ghost-parity.json`, `review/replay-parity.json`

The first added wire browser assertion exposed millisecond slider quantization at an exact sub-millisecond packet boundary. The test now seeks one millisecond past the event; the causal sample selector correctly retains the earlier event before its receipt. Final browser acceptance passed after that correction. Historical failure artifacts, if present in the evidence directory, are superseded by `browser/browser-acceptance.json`.

## Integrated references and remaining work

`g1-student-deploy`: actual lockstep/realtime recording adapters, source reference packer, named joint contract, tracker orientation projection and perception snapshot interpretation. `lucid-g1-deploy`: actual G1 MJCF/STL assets, C++ interface inspection, debug/robot_config decoder, Unitree/DDS boundary analysis. Grandloco sources were inspected as an alternative backend; no Grandloco runtime adapter was exercised. Additional references were checked read-only, not imported as arbitrary running research environments.

Fresh canonical SONIC rehearsal is blocked by `ChannelFactory::Instance()->Init(0, networkInterface)` in the referenced C++ runner. The existing launcher passes `lo` but cannot select the required nonzero simulator domain. No silent domain-0 fallback, upstream source edit or alternate-controller substitution was made. A reviewed upstream change and matching simulator/planner domain validation are needed before a new complete DDS rehearsal.

`nvidia-smi` was rechecked and returned exit 18: driver/library mismatch, NVML library 595.99. GPU availability stays unknown. No driver repair, reboot, global network change, policy/training run or interference with other jobs occurred.

Current limits:

- Live robot mode is not enabled. No hardware observation, actuation, fault/temperature, safety-stop, model/calibration or controller timing validation.
- No runtime ROS/TF or DDS participant/QoS discovery. Configured deployment edges are labelled as configured. Only the captured ZMQ subscriber edge has observed runtime metrics.
- No synchronized raw/filtered LiDAR history, elevation/occupancy animation or extrinsics validation. The final map preserves unknown masks and is visibly unsynchronized.
- No new C++ debug packet capture; its decoder is source-verified and fixture-tested. Fused Flow inputs expose reference windows, not standalone latent tokens. Optional debug tokens from other encoder configurations have no invented semantic labels.
- No low-command target/delivery/gain capture. Reference error does not establish motor-command tracking.
- Wire browser import currently accepts one loopback endpoint with `pose` only. It requires retained wire bytes and consistent capture clocks; other topic decoders/recorders exist but are not selectable browser capture sessions. Large recordings must be split; this is a bounded replay gateway, not an unlimited archival service.
- Policy, calibration and model hashes at the original recording time were not saved. Current artifact/model fingerprints and source checkout identities are labelled at-read evidence.

Next hardware step: separately authorize a stationary, reader-only robot-side observation after verifying SDK/types, physical model/calibration, clocks, operator responsibilities and independent physical stop/support procedures. Follow `docs/LIVE_OBSERVATION.md`. That authorization must not implicitly start a controller or grant deployment command authority.
