# Navigate review session (2026-10-21)

What was built for real-world navigation, how it was reviewed, what the reviews found and what was done about each finding. Everything ran in CPU simulation or against `tools/fake_node.py` (a loopback protocol fixture); nothing ran on a robot or against the real `node.py`.

## What was built

| Piece | What it does | Code |
|---|---|---|
| Navigate workspace | One panel for both robots: world and start, the robot's own map, click a goal, checks, Send / Go / Stand, walks, End, twin | `apps/web/js/navigate.js` |
| Simulated robot | node.py's state machine on CPU MuJoCo + SONIC ONNX + the frozen bundle; one map across goals; pauses while waiting | `studio/nav_worker.py` |
| Robot link | On the deploy PC: subscribes to the node, runner and LIO bridge on loopback; sends node.py a checked goal and stand, never Go | `studio/robot_link.py` |
| Goal checks | Inside the memory, seen, free, overhead (node.py's deferral), reachable (Flow `SensorRoute` exactly), distance | `studio/goal_check.py` |
| Scan to twin | Boxes fitted to the robot's map, saved as an arena | `studio/twin.py` |
| Build sheet | A printable course plan from a start mark, with the console command and the go / no-go list | `apps/web/sheet.html` |
| Protocol fixture | A stand-in node with fault injection (readback error, frame offset, deferred stand) | `tools/fake_node.py` |

Design: [REAL_WORLD_DEPLOYMENT.md](REAL_WORLD_DEPLOYMENT.md). Use and contract: [NAVIGATE.md](NAVIGATE.md).

## Rounds

| Round | Who | Found | Evidence |
|---|---|---|---|
| Build | Lead + 3 agents (goal checks and twin, build sheet, robot link) | — | commits `5f9607f..adaee89` |
| Review | Independent reviewer | 6 high, 8 medium, 13 low, 6 nits, 7 wishes | `evidence/review-navigate-20261021/REVIEW.md` |
| Validation | Independent validator (random goals, settings, robustness, robot link, twins) | 16 defects, doc mismatches | `evidence/validate-navigate-20261021/VALIDATION.md` |
| Fixes | Lead + 1 agent (robot link) | — | commits `8c81be7..a6e237d` |
| Verification | Independent verifier, every finding re-run | 1 regression (End after a gateway restart), 3 medium, low items | `evidence/verify-navigate-20261021/VERIFY.md` |
| Fixes | Lead | — | commits `285e15b`, `a86a3bc` |

## The findings that mattered most

| Finding | What happened | Fix |
|---|---|---|
| Goal checks failed open (H2) | With no map, an unchecked goal reached the node | Gateway and link both refuse unless the check passed |
| A "refused" readback (H3) | node.py had already applied the goal; Go walked to it | The node's goal is shown as verified / unverified / not from Studio, with a red warning and a pre-Go checklist |
| Frames (H4) | The console's default leg odometry differs from LIO; readbacks failed | Goals refused unless the node's position matches LIO within 0.1 m; docs require `--odom zmq` |
| Memory size (H1) | Goals 9–11 m away passed on a 24 m display map | The display map is the 12 × 12 m memory; a 3 m test distance limit blocks |
| End never ended (H5 / D1) | A stand deferred under a "ceiling" kept the simulated session running and growing until it was killed | End always ends; limits hold in every phase; a deferred stand is forced after 20 s in simulation; SIGTERM keeps the recording |
| Robot vanished (H6) | Without the runner's joints the view said no pose was captured | A LIO pose marker and its trail |
| Long recordings (D2) | Over 64 MiB could not be replayed | Slimmer frames, 1 Hz map snapshots, 180 s motion cap, higher read limits |
| After a restart (M7 / D6 / D7 / NEW-1) | A surviving session or link could not be ended; End was written over an old command | A lock held by the link, detached sessions with a live view, inbox sequence continued from disk |
| Phantom ceilings (D4) | The robot's own arms leave low "ceiling" cells that pile up in the never-forgetting memory; stalls, deferred stands and falls followed | Deploy repo (STATUS #15); Studio explains deferrals and offers a fresh-map mode |
| Table-height edges | The top edge of a 0.8–1.35 m obstacle is filed as a ceiling; node.py then defers its stand | Deploy repo (STATUS #11); Studio blocks goals within the node's window and warns near the arrival |

The two perception findings are in g1-student-deploy's code (`CloudMemory`, node.py), which Studio does not modify. They matter on a real robot: one memory per node process, the same self-filter and the same overhead rule.

## Intentionally not addressed

- Two browser tabs staging goals overwrite each other (D14): low; the last staged goal is always the one shown.
- Node events in Studio (wish 4) wait for the proposed telemetry stream U2.
- Navigation sessions in the Runs table (wish 6).
- A viewport that keeps the last recording while a robot link waits for its first pose (M2): it now says so.

## Final regression (release `a86a3bc`, served on 8790)

| Check | Result |
|---|---|
| Unit tests | 347 OK, 9 opt-in skipped |
| Opt-in integration (real workers) | 12/12; walking equals the source rehearsal (279 frames, largest pose difference 5e-6) |
| Navigate: simulated robot / robot link / review hazards | 11/11 · 7/7 · 6/6 |
| Build sheet, replay, rehearse re-validation | 10/10 · 42 + 1 blocked (no WX run in a fresh root) · 19/19 |
| Browser acceptance on 8790, direct and forwarded | 15/15 · 15/15 |
| Gateway restart with a live session, then one End | detached view served; completed in 0.6 s; recording replays |

Evidence: `evidence/navigate-final-20261021/` (release candidate, restart scenario, 8790 acceptance).

## Reproduce

```bash
.venv/bin/python -B -m unittest discover -s tests
STUDIO_INTEGRATION=1 .venv/bin/python -B -m unittest tests.test_nav_worker tests.test_flow_worker_integration
PORT=8797 DATA_ROOT=<fresh> EVIDENCE=<dir> STUDIO_ROBOT_LINK=<fixture config> tools/browser/validation/gateway.sh start
STUDIO_URL=http://127.0.0.1:8797 STUDIO_EVIDENCE=<dir> node tools/browser/validation/navigate.mjs
FIXTURE_PORTS=15561,15556,15557,15562 ... node tools/browser/validation/navigate_robot.mjs
ROBOT_LINK_CONFIG=<the STUDIO_ROBOT_LINK file> ... node tools/browser/validation/navigate_robot_review.mjs
```
