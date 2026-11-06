# What Studio does today, and what it is verified on (2026-11-06)

One table for operators and contributors. Each row says what the capability is and, separately, what it was verified
on: fake services (fixture tests), the real deploy chain in simulation, or hardware. Older pages ([STATUS](STATUS.md),
2026-10-21; [LIVE_OBSERVATION](LIVE_OBSERVATION.md); the dated reviews) are history: when they disagree with this page,
this page is current.

**Control language.** Studio relays the operator's explicit presses. The deploy kit's console owns every gate. The SONIC
runner owns the motor commands. Studio has no DDS participant and no motor-command path. Its software E-STOP goes
through the console. The only stop that does not depend on the console is the physical E-stop.

| Capability | What it does | Fixture tests (fake services) | Real chain in simulation | Hardware |
|---|---|---|---|---|
| **Deploy** workspace: Connect → Scan → Goal → Rehearse → Deploy → Review ([DEPLOY](DEPLOY.md)) | Relays the operator's presses (Start session, Arm, Start SONIC, Clear map, Send goal, GO, End) to the kit's deploy service and console. E-STOP, Stand and Take over go straight to each live console. One operator lease per gateway. | `tests/test_deploy_link.py`, `tests/test_deploy_faults.py` (combined faults), `tests/test_deploy_real_contract.py` (replies recorded from the real kit), `tools/browser/deploy_edges.mjs`, `tools/browser/deploy_review_20261106.mjs` | Practice end to end on 2026-10-28 (Studio `76785ba`, kit `b098f35`): `full_run: true`, 15/15 evidence, simulated E-STOP confirmed. The rehearsal verdict was *fails with drift*: an integration result, not a robust rehearsal. | **Not run under Studio.** The robot walked under the kit's console on 2026-10-24 and 2026-10-27, not through Studio. |
| Deploy, unresolved presses | A press whose reply was lost stays *unresolved*, and motion presses stay locked, until the console's record or the session's event log says done or refused. "No record" is not proof that it never arrived. After 15 s without a record, the operator may unlock the page once they have checked the robot and the console. | `tests/test_deploy_link.py` (UncertainActTests), kit `tests/test_deploy_service_v3.py`, browser R02 | — | — |
| Deploy, emergency path | E-STOP and Stand reach every live console within their budget, even with an expired lease, a hung audit disk, saturated requests and the deploy service down (review 2026-11-06 R01). The bar shows each console's heartbeat. If a heartbeat is *unknown*, it raises its own alarm ("CONSOLE STATUS UNKNOWN"). | `tests/test_deploy_faults.py`, browser R03 | Simulated E-STOP confirmed in the 2026-10-28 run | Physical stopping behaviour: **not established** |
| Review and Replay of kit sessions | Session detail, attempt tags, the evidence manifest, recording health, and the exact Replay id. A console recording that is still being written is decoded again as it grows (at most every 5 s), and again once it is finalized. | `tests/test_deploy_faults.py` (GrowingRecordingTests), `tests/test_console_replay.py` | Reopened in a fresh browser on 2026-10-28 | Replays of the 2026-10-27 robot sessions (read-only files) |
| Replay limits (console sessions) | The raw LiDAR is not decoded. The map shown is the node's final memory. Planner times are estimated as `node_up + tick × 20 ms`. Motor commands are recorded but not shown. Each recording's metadata says so. | `tests/test_console_replay.py` | — | — |
| **Navigate** with the simulated robot ([NAVIGATE](NAVIGATE.md)) | Runs node.py's state machine on goals clicked on the robot's own map, with Go, Stand and takeover. | Browser 11/11 | Owned CPU simulation only | — |
| Navigate's robot link | Sends node.py a checked goal while the robot stands, and a stand request. **Never Go**: on that path the operator presses `g` on the node console. While the kit runs a robot session, the link only observes. | Browser 7/7 against a protocol fixture | Not run against node.py | **Not run** |
| Observe & record (robot link journal and raw capture) | Work in progress, uncommitted on Studio `main`. Its finalized replay says *replayable* and *complete* separately, and keeps the health of the journal and the raw capture. | `tests/test_robot_recording.py`, `tests/test_robot_link.py` | — | **Not run** |
| Rehearsals, arenas, suites, Runs ([WORKBENCH](WORKBENCH.md)) | Owned CPU rehearsals of the pinned policy in MuJoCo. | Unit and browser tests | L1/L2 CPU rehearsal | — |
| Public site ([SITE](SITE.md)) | Recorded simulation walks, labelled as such. | Site checks | — | Nothing on the site ran on a robot |

**Not established anywhere yet:** physical stopping distance or behaviour, actual walking performance under Studio,
touch and assistive-technology use on a real phone, long-session resource growth, cross-browser behaviour.

**How to rerun the checks.** Backend:
`.venv/bin/python -m unittest tests.test_deploy_link tests.test_deploy_real_contract tests.test_console_replay tests.test_deploy_faults`.
Browser: `node tools/browser/deploy_review_20261106.mjs` (self-contained). For `tools/browser/deploy_edges.mjs`,
run a dev gateway pointed at the fake hub first (its header says how). None of these talks to a robot or to the real
deploy service.
