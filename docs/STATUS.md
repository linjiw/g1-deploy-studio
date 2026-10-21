# G1 Deploy Studio · status (2026-10-21)

Studio is a loopback-only cockpit for deploying, visualizing and rehearsing navigation policies for the Unitree G1:
**Flow planner → versioned ZMQ pose reference → SONIC tracker → Unitree DDS**. It observes and rehearses and owns no motor-command path. Its only robot-side commands are a checked goal (while the robot stands) and a stand request to node.py; Go stays with the operator.

- **Service:** http://127.0.0.1:8790/ (systemd user unit `g1-deploy-studio`, see [SERVICE.md](SERVICE.md)). The served commit is shown in the status bar and at `/api/version`.
- **Remote:** `ssh -N -L 8790:127.0.0.1:8790 <user>@<host>`, then open http://localhost:8790/.
- **Video introduction:** `~/research-data/g1-deploy-studio/evidence/video-20261020/` (7:19, narrated, subtitles; rebuild with [tools/video](../tools/video/README.md)).

## Capabilities

| Capability | Fidelity | Status | Evidence |
|---|---|---|---|
| Replay of recorded sessions: SONIC lockstep, C++/DDS tutorial, ZMQ capture, owned runs | L0 | Verified | [ACCEPTANCE](ACCEPTANCE.md), [REVALIDATION](REVALIDATION.md) |
| Owned CPU rehearsal: Flow WX-RF (adopted block, pinned `23326aa`) and the frozen bundle, real SONIC ONNX on MuJoCo | L1 | Verified | [POLICIES](POLICIES.md), [ROBUSTNESS](ROBUSTNESS.md) |
| Planner latency with *measured* or *predict* anchoring | L2 / L2≈ | Verified | ROBUSTNESS Addenda B–C |
| G1 actuator-limit profiles per hardware revision (`g1-current` default, `g1-rev1`, `source`) | — | Verified (unit tests + real workers) | [ROBOT_CONTRACT](ROBOT_CONTRACT.md), ROBUSTNESS Addenda D–E |
| Arena editor, seeded random goals, suites, Runs report with Wilson intervals | — | Verified | [WORKBENCH](WORKBENCH.md), REVALIDATION |
| Sensors (causal), System map, source-verified Unitree contract | — | Verified | REVALIDATION |
| Durable service, release guard, loopback + Host/Origin + CSRF, SSH tunnel | — | Verified | [SERVICE](SERVICE.md) |
| Real-time chain (simulator + C++ SONIC runner + node) in an isolated namespace | L3 | **Ready, not yet run** | [REALTIME_REHEARSAL](REALTIME_REHEARSAL.md) |
| Read-only physical G1 | M5 | Not started (needs a safety review) | REALTIME_REHEARSAL § M5 |
| **Navigate** with the simulated robot: node.py's state machine, goals clicked on the robot's own map with checks, Go / Stand / takeover, walks, recording | L1 / L2 | Verified (walking equals the source rehearsal frame for frame; browser 11/11) | [NAVIGATE](NAVIGATE.md) |
| Navigate with the real robot: robot link on the deploy PC (loopback streams; goal and stand to node.py, never Go) | M5 | Verified against a protocol fixture only (browser 7/7); not run against node.py or a robot | [NAVIGATE](NAVIGATE.md) |
| Scan to twin (an arena fitted to the robot's map) and the printable course build sheet | — | Verified in simulation and print | [NAVIGATE](NAVIGATE.md), [WORKBENCH](WORKBENCH.md) |
| Site maps across sessions (mapping walk, relocalization) | — | Designed, not built | [REAL_WORLD_DEPLOYMENT](REAL_WORLD_DEPLOYMENT.md) §5.3 |

## Current results

These are CPU MuJoCo lockstep runs from standing starts, at small n. They are not hardware evidence.

| Question | Result |
|---|---|
| Does WX-RF reach and hold random goals? | Yes in lockstep: 24/24 at seed 0 across 4 arenas, 35/36 with seeds; it beats the bundle behind obstacles (6/6 vs 2/6) |
| Does it stop well? | It is the weak point. It overshoots and loops back, and holds often complete 1–4 s after arrival |
| Is it robust to planner latency? | Not with stale anchoring: 1/12 at 200 ms. With predictive anchoring on the current-G1 limits: **12/12 at the robot's 160 ms budget**, but 21/36 at 200 ms over three seeds (4–10/12 per seed). The cliff is between 160 and 200 ms |
| Does the hardware revision matter? | Yes. WX routinely commands more than 88 N·m at the hip pitch, so a rev_1_0 robot (mode_machine 4–6, 13, 14) would clamp it. Under latency most runs drive a leg joint to its torque limit (9/12 at 160 ms, 34/36 at 200 ms), most often the 50 N·m ankle clip |

## Open issues

| # | Issue | Owner | Next action |
|---|---|---|---|
| 1 | First L3 run | Operator | `tools/l3_rehearsal.sh <studio task.json> <run-id>`. This session's permission policy blocks launching the chain, so it is run explicitly ([REALTIME_REHEARSAL](REALTIME_REHEARSAL.md)) |
| 2 | WX latency margin: 12/12 at 160 ms, 21/36 at 200 ms (predict, current-G1 limits) | Flow research + deployment | Measure the deployed planner's real latency (L3 / robot). Predict the *executed* state, for example with WM-v2. Locate the cliff with 180 ms runs (ROBUSTNESS Addendum E) |
| 3 | WX does not settle at the goal (arrive and hold) | Flow research | Stopping behaviour; WX was trained on *reach* |
| 4 | Unknown hardware revision of our G1 | Operator | Read `LowState.mode_machine` passively (first M5 step), then rehearse with the matching profile |
| 5 | Ankle and waist roll/pitch limits: 35 N·m (newest URDFs) vs 50 (MJCF, training). The 50 N·m ankle clip is already reached in most latency runs | Research | Unresolved by the sources; profiles patch only the hips |
| 6 | One-sided runner velocity abort, disabled in simulation | Runner owner | ROBOT_CONTRACT discrepancy list |
| 7 | Upstream `--dds-domain` for the runner (defence in depth beyond the namespace) | Runner owner | Optional; namespace isolation already prevents leaks |
| 8 | WX-RF is privileged (plans from the exact boxes) | Flow research | Pin a LiDAR-conditioned block when Flow adopts one |
| 9 | NVML fails for new processes (driver 595.91 vs libraries 595.99) | Host admin | Not a Studio change; GPU use is read from another logger or recorded as unknown |
| 10 | Software-WebGL playback is render-limited | Environment | Flagged in the UI (RENDER-LIMITED), and real time is kept; GPU browsers are unaffected |
| 11 | node.py defers its stand next to obstacles 0.8–1.35 m tall: `CloudMemory` files their top edge as a low ceiling. When the plan runs out the robot holds its last pose (simulation: leaned on a pillar at 107 N, drifted 1 m in 70 s) | Deploy repo owner | Decide the fallback (stand after the plan ends, or ignore ceilings attached to a solid obstacle). Studio blocks goals there and explains the deferral ([NAVIGATE](NAVIGATE.md) §5) |
| 12 | Robot link against the real node.py (L3 first, then the robot) | Operator | Run L3 (issue 1) and connect Navigate to it with `config/robot_link.json`; then the M5 safety review |
| 13 | Proposals U1–U3 for g1-student-deploy: absolute odom goals, a telemetry stream with the planner's live map, loopback-only binds | Deploy repo owner | Proposed in [REAL_WORLD_DEPLOYMENT](REAL_WORLD_DEPLOYMENT.md) §7; Studio works without them |

## Decisions

| Date | Decision |
|---|---|
| 2026-10-19 | Durable systemd user service serving a committed release worktree; release refuses while runs or suites are active |
| 2026-10-20 | Hip limits follow `mode_machine` (research). Studio rehearses with in-memory actuator profiles, default `g1-current` (139/139/88); runs saved before profiles keep `source` |
| 2026-10-20 | Predictive anchoring for the Flow callback is a Studio-side deployment adapter (`studio/latency_anchor.py`); Flow code is unchanged |
| 2026-10-20 | L3 isolation: owner-approved network namespace (domain 0 cannot leave a loopback-only namespace) instead of an upstream domain change first |
| 2026-10-20 | The 7 `.pyc` files a probe agent wrote into the g1-student-deploy venv were removed |
| 2026-10-20 | Independent review session (3 high, 8 medium, 14 low, 12 nits; `evidence/review-20261020/REVIEW.md`). Then an independent verification (`evidence/verify-20261020/VERIFY.md`): 22 fixed and 3 partial; it also found one regression from a fix (following a detached run after a reload). The partial items, the regression and the remaining nits were fixed afterwards. One label stays by design: the HUD's "Speed (fd)" on recordings without a velocity field is a finite difference |
| 2026-10-20 | Torque is counted at the effective limit (source clip or model clamp); scenario identity includes the actuator profile; saved scenarios keep `source`; under latency the shown plan is the executing one, live and recorded, for both the WX and the bundle worker |
| 2026-10-20 | A second verification (`evidence/verify2-20261020/VERIFY2.md`): 19 items fixed and 1 by design; it found that the bundle worker still showed the in-flight plan (N8). A third verification (`evidence/verify3-20261020/VERIFY3.md`) confirmed the N8 fix and found N9 (a race in the single-load fix) and N10 (the leg-torque count included arm joints; Addendum D/E counts corrected). Both are fixed. The whole review session is in [REVIEW-20261020](REVIEW-20261020.md) |

| 2026-10-21 | Real-world navigation (owner delegated the decisions): Studio may send `status`, `goal` and `stand` to node.py's control socket; never `go`, `quit` or any motor/DDS write. Goals are staged only while the robot stands and read back within 5 cm. The simulated robot follows node.py's rules; simulated time pauses while it waits. Only the frozen bundle plans from the robot's own LiDAR, so Navigate uses it |

## Verify

```bash
.venv/bin/python -m unittest discover -s tests                          # unit + contract tests
STUDIO_INTEGRATION=1 .venv/bin/python -m unittest tests.test_flow_worker_integration
STUDIO_URL=http://127.0.0.1:8790 npm run test:browser                    # 15 browser acceptance checks
STUDIO_URL=http://127.0.0.1:8790 npm run test:browser:forwarded
tools/studio_service.sh status
```
