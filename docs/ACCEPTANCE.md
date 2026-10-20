# Executed acceptance — v0.2 (2026-10-20)

All runs below are **owned CPU simulation (fidelity L1, lockstep)** or read-only replays. There were no robot connections, DDS participants, GPU use or changes to the reference repositories. Evidence is under `~/research-data/g1-deploy-studio/evidence/studio-v2-20261020/` (outside Git).

## Service

- **Diagnosis.** Nothing listened on 8790. The last server log ended mid-request at 2026-10-16 11:43 with no shutdown and no OOM record: the gateway had died with the agent shell that started it.
- **Now.** The gateway runs as `systemd --user` unit `g1-deploy-studio`, serving a committed release worktree on 127.0.0.1 and [::1] port 8790 ([SERVICE.md](SERVICE.md)). `/api/version` and the status bar report the served commit.

## Delivery (measured on the same host)

| Request | v0.1 | v0.2 |
|---|---:|---:|
| `/api/session` sonic-lockstep | 5.45 MB | 1.53 MB (gzip); unchanged reload → 304 |
| `/api/session` sonic-dds-tutorial | 5.87 MB | 0.62 MB |
| `/api/sensors` DDS session | 838 KB | 21 KB (masks opt-in with `masks=1`) |
| Mesh requests when switching to another session with the same model | ≈36 (18.5 MB) | 0 (content-addressed, immutable) |
| Frames rendered while paused, 1.2 s | continuous loop | 0 |

## Browser acceptance (read-only, release build)

`tools/browser/ui_acceptance.mjs` passed **15/15** checks against 8790. `tools/browser/forwarded.mjs` passed the same 15 through a Host-preserving loopback tunnel. Neither run had page errors or failed requests. The checks cover:

- browser forward kinematics vs MuJoCo: max error 2.2e-16 m position and 1e-15 rotation, on both the 29-DoF model and the 43-DoF Dex3 model;
- the transport is in view without scrolling, and the scene renders on demand;
- play, speed, single-tick and 1 s stepping;
- layers, cameras and the robot-view inset;
- the named-joint table matches the source frame;
- a held state is labelled stale;
- the DDS final map is labelled unsynchronized and its graph configured;
- the captured ZMQ edge goes fresh → stale → disconnected while pose stays unavailable;
- the rehearsal outcome card;
- a view link round-trips time, panel and camera;
- the system map and Unitree contract render;
- there is no horizontal scroll at 390 px;
- the gateway survives a browser disconnect, with no command path.

Evidence: `ui/`, `ui-forwarded/`.

## Adopted Flow WX-RF in the CPU rehearsal

- **Pinned bundle.** `flow-wx-rf-23326aa-s0`: 177 source files, config sha256 `1ffc4069…441c4861`, teacher `sk1_s0` (`3d3a2d55…`), WM-v2 ×3. It verifies clean with `tools/build_policy_bundle.py --verify-only`.
- **CLI smoke run.** One box, 2.4 m goal, K4/ODE4, 4 s. Exit 0, outcome **timeout** at 0.35 m. The robot took a wide detour and needed more time; this is a policy result, not an adapter failure. WM-v2 execution check passed 25/25 replans, and planner p50/p95 was 511/822 ms. Parity against the independent decoder: 1.2e-7 qpos and 3e-8 reference (float32 storage).
- **End-to-end UI flow.** `tools/browser/rehearsal_flow.mjs` on the release build, evidence in `rehearsal-release/`:
  1. Arena editor → doorway template; start (0, −1) at a 25° heading; lateral goal (3.6, 0.6); saved as `arena-cfecc4d4517d`.
  2. Rehearse → WX-RF, K8/ODE6, 8 s, *arrive & hold* criterion.
  3. Live attach, then the recorded result.
  4. Runs comparison.

| Policy | Job | Outcome | Sim time | Final / closest goal distance | Contact | Max tilt | Planner p50 / p95 | Worker wall |
|---|---|---|---:|---:|---:|---:|---:|---:|
| WX-RF (K8/ODE6) | `job-47d39564736b` | **goal_completion** | 5.92 s | 0.080 / 0.025 m | 0 N | 0.29 rad | 1246 / 1618 ms | 57 s |
| Frozen bundle (K4/ODE6) | `job-7ddad4ea358c` | timeout | 8.00 s | 3.74 / 3.29 m | 0 N | 0.45 rad | 1085 / 4064 ms | 124 s |

**Reproducibility.** An earlier development-gateway run (`job-0a727dc413cd`) used the same arena geometry, preset, seed and budget, saved as a separate arena. Its states and references are **bitwise identical** to `job-47d39564736b` (max difference 0.0). Only the wall-clock timing differs.

**Reading the comparison.** WX passed straight through the 0.8 m door. The bundle turned away from the door and was detouring around the lower end of the wall when the 8 s horizon ended. This is not a like-for-like ranking:
- WX-RF is a *privileged* block that plans from the exact boxes.
- The bundle plans from simulated LiDAR with a sensor route that treats unseen cells as free.
- Both runs are a single seed in CPU lockstep with standing starts. On the Isaac panels, WX was evaluated from walking starts at K16/ODE10.

## Scenario suite: WX-RF on a slalom arena

`tools/browser/suite_flow.mjs` ran on the release build: slalom template, the *Slalom left* preset mirrored, saved; Rehearse → WX-RF, K8/ODE6, 8 s, *arrive & hold* → **Run suite** (3 runs, sequential) → Runs comparison. Evidence is in `suite-wx-slalom/`.

| Preset | Goal | Outcome | Final distance | Contact | Planner p95 |
|---|---|---|---:|---:|---:|
| Slalom end | (4.8, 0.0) | timeout | 0.29 m | 0 N | 1712 ms |
| Slalom left | (4.8, 0.8) | timeout | 0.71 m | 0 N | 1873 ms |
| Slalom left · mirrored | (4.8, −0.8) | **goal_completion** at 7.82 s | 0.28 m | 0 N | 1784 ms |

**Observed behavior.**
- WX-RF does not weave between the three walls. Its privileged task-sized cost route takes it around the whole wall field: two runs went below it and one went over the top and overshot the left goal.
- *Slalom end* finished inside the 0.3 m radius but never satisfied the 0.25 m/s, 0.4 s hold before the 8 s horizon.

These are single-seed CPU checks with a reduced K8/ODE6 budget and a standing start. They are a prompt for the Flow side to look at stopping and arena-scale routing under Studio's arrival criterion, not a success rate.

## Automated tests

`.venv/bin/python -m unittest discover -s tests` passed **210 tests in about 31 s**. These include 89 new tests for:
- arenas and suites, policies and bundle verification;
- gzip/ETag delivery, sensor masks and the new routes;
- the WX worker's request contract before any runtime import, plus the source-verified robot contract (16 tests).

The new tests found 8 product bugs, now fixed with regression tests:
- a cancelled queued suite was lost;
- list or object JSON identifiers crashed requests without a response;
- an empty catalog caused a StopIteration;
- a missing bundle config raised instead of being reported;
- one bad bundle hid every WX profile;
- corrupt arena files silently dropped valid arenas on reload;
- plus suite-thread robustness and the ETag/Vary fixes.

## Still not done or blocked

- **C++/DDS real-time rehearsal.** The SONIC runner hard-codes DDS domain 0, and so does the rest of the chain; NVML has a driver/library mismatch. No upstream change was made.
- **Latency-faithful lockstep (L2).** Not implemented. Every result above pauses physics during planning.
- **WX at the evaluated K16/ODE10 budget.** Not run in a full episode here. It takes about 3–4 s per CPU replan on this host, and the profile exposes it with a 480 s wall limit.
- **No live ROS/DDS discovery, physical sensors or robot observation.**
- **Source discrepancies in [ROBOT_CONTRACT.md](ROBOT_CONTRACT.md) still need owner decisions**, especially the hip effort limit (139 vs 88 N·m) and the one-sided velocity abort.

# Earlier acceptance and handoff — 2026-10-15

This delivery includes a working local replay cockpit, preparation and CPU policy-test workbench, and read-only telemetry capture/diagnostics. M1 is exercised; substantial M2/M3 observability pieces are implemented. **Fresh Flow/SONIC/MuJoCo CPU tests were performed. A new full SONIC/DDS controller rehearsal and physical robot observation were not performed.** The blockers and missing validations below remain open.

## Fresh simulation workbench acceptance

The subsequent obstacle-navigation delivery is documented in `NAVIGATION_TESTS.md`: three source-generated arenas, six actual browser-configured CPU cases (four goal completions, one timeout, one source runtime error), and preservation/inspection of failed runs. Final checks for that delivery: 97 unit/integration tests, 13 existing browser checks, nine saved-view/terminal-state checks, and all six navigation workflow inspections. Independent parity covered 1,327 executed frames and 5,308 physics substeps. Earlier counts below describe the initial workbench delivery.

The browser now supports map selection/import, viewport navigation-goal picking, start/settings preflight, saved scenario load/export, owned CPU policy tests, live robot/performance visualization, run history, synchronized perception and sensor pinning. See `WORKBENCH.md`, `POLICY_BACKEND.md` and `SENSORS.md` for exact interfaces and boundaries.

Final verification: **88 unit/integration tests and 25 browser checks passed** (seven new workflow checks, five workbench regressions, and thirteen existing replay checks through a forwarded loopback connection). The browser reports contain no page exceptions or failed HTTP resources. Older counts below describe earlier deliveries.

Real execution evidence (all outside Git):

- `~/research-data/g1-deploy-studio/evidence/policy-workbench/run-boxes-verified/`: real two-wall corridor, 1.5 m goal, 2.0 s / 100 control steps / 13 replans. Goal distance decreased to about 0.637 m. Source pre-action state, post-action state and references matched the independent NPZ decoder exactly. Sensor/IMU values were sampled against this recording.
- `~/research-data/g1-deploy-studio/evidence/workbench-browser/acceptance.json`: seven browser workflow checks, actual job `job-3144c5a7d462`, live model visible at 0.32 s, real SONIC inference 2.40 ms at that sampled frame, result replay and three pinned raw/filtered/IMU views. Desktop/mobile screenshots accompany the report.
- `~/research-data/g1-deploy-studio/evidence/workbench-browser/regression.json`: five checks covering delayed future sensor responses after rewind, saved scenarios/export, job recovery and scan-import boundaries. An actual recorded LiDAR sample was imported; physics launch correctly remained blocked without collision geometry.
- `~/research-data/g1-deploy-studio/evidence/workbench-forwarded/browser-acceptance.json`: thirteen complete replay/rendering checks through a preserved-Host loopback forwarder against the final port-8790 gateway, including independent MuJoCo body-transform parity.
- `~/research-data/g1-deploy-studio/evidence/workbench-api/acceptance.json`: actual API-launched job `job-028c64864653`, two simulated seconds / 100 frames / ten perception snapshots, 4.42 wall seconds. Goal distance reached 0.099 m; scorer outcome stayed **timeout**, not goal completion. Duplicate worker rejected; consumer disconnect did not stop the worker; cancellation affected only the second owned CPU job.
- `~/research-data/g1-deploy-studio/evidence/workbench-api-fault/acceptance.json`: owned CPU job `job-48fd6424930c` deliberately paused/resumed; telemetry became stale as expected and recovered. Source policy outcome remains timeout. The pause contributes to measured wall/planner timing and is not a performance benchmark.
- `~/research-data/g1-deploy-studio/evidence/workbench-unit-tests.txt`: complete current unit/integration test output, including map bounds/unknown handling, same-origin POST authorization, job exclusion/lifecycle, sensor chronology and malformed wire data.

Commands executed included `.venv/bin/python -m unittest discover -s tests -v`, `STUDIO_URL=http://127.0.0.1:8791 node tools/workbench_acceptance.mjs`, and `.venv/bin/python tools/accept_workbench.py --url http://127.0.0.1:8791 --output <new-evidence-directory>`. Port 8791 was used as an isolated development gateway while the user's original 8790 replay stayed available. The final handoff uses 8790.

Additional final regression commands:

```bash
STUDIO_URL=http://127.0.0.1:8791 STUDIO_JOB=job-3144c5a7d462 node tools/workbench_regression.mjs
STUDIO_EVIDENCE=/home/linjiw/research-data/g1-deploy-studio/evidence/workbench-forwarded npm run test:browser:forwarded
```

This execution uses the frozen Flow/SONIC reference implementation and reference Python environment read-only. No source/environment, GPU driver, robot/network configuration, DDS domain or other running job was changed. The CPU backend has no DDS/ZMQ participant; actual DDS delivery, hardware motor faults, cameras, physical sensor calibration and real-time deadline behavior remain unvalidated. Imported scans can be inspected and assigned goals, but require explicit collision geometry before physics tests. The source planner's unseen-cell-as-free behavior is disclosed in validation and provenance, while visual unknown cells remain empty.

## Start and select evidence

Dependencies are installed in this checkout's `.venv` and `node_modules`. Start from the project root:

```bash
cd /home/linjiw/code/g1-deploy-studio
.venv/bin/python -m studio.server
```

Browser: **http://127.0.0.1:8790**. Keep this process running while using the cockpit. The server was restarted and left running for interactive review after the forwarded-browser fix below. Initial setup on another checkout is documented in README. Port 8765 was already occupied and was not disturbed.

### Forwarded-browser connection fix

The desktop browser used a different local port, `localhost:64842`. Gateway logs showed those navigations reaching the server and receiving HTTP 403: the original Host guard required the backend port. Direct-host browser acceptance did not cover this case. A preserved-Host TCP forwarding regression reproduced the 403 before the fix.

The gateway now accepts only the literal loopback authorities `localhost`, `127.0.0.1`, and `[::1]`, with valid browser-side ports. Any Origin must match that incoming authority exactly. Foreign hosts/origins, duplicate headers and cross-site fetches remain rejected. Startup binds separate IPv4 and IPv6 loopback sockets; no public listener or hardware interface is enabled. Request overload returns HTTP 503 instead of silently closing the connection.

Connection-fix verification: **51 unit/integration tests passed**, then **13 full browser checks passed through a loopback TCP forwarder preserving the browser's different Host port and connecting to the IPv6 backend**. This covers actual replay decoding/rendering, timeline, layers, camera modes, session switching, maps, joint parity, unavailable/stale telemetry and browser disconnect behavior. This automated tunnel test is separate from confirmation that the user's desktop tab displays the page.

```bash
.venv/bin/python -m unittest discover -s tests -v
STUDIO_URL='http://[::1]:8790' npm run test:browser:forwarded
```

Evidence outside Git: `/home/linjiw/research-data/g1-deploy-studio/evidence/connection-unit-tests.txt`, `browser-forwarded/browser-failure.json` (before), and `browser-forwarded-fixed/browser-acceptance.json` plus screenshots (after).

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
