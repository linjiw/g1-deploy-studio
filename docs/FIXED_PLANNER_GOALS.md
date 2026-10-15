# Fixed planner: slalom and corridor goal checks

Six preselected development cases were executed once each on 2026-10-15 using the corrected deployment commit `f3329db5acd77e47d4758e01928d0df4996ef318`. **Two reached their goals, three timed out and one ended in obstacle collision.** All six worker processes exited normally with complete recordings; no route exception occurred. Process completion is separate from navigation success.

These are CPU Flow + SONIC ONNX + MuJoCo runs through the existing in-process backend. They do not exercise the C++/DDS deployment chain or physical hardware. No upstream source was changed for this comparison.

## Inputs and outcomes

The exact inputs were fixed in [`config/navigation-goal-checks.json`](../config/navigation-goal-checks.json) before execution. Every case starts at world `(0, 0)`, yaw 0, planner seed 0, four candidates, six ODE steps and a 10-second simulation deadline. Only the goal differs within each scene. Endpoint standing clearance passed; that check does not certify a collision-free route.

Both maps use the unchanged Flow source generator `bundle/flow/src/motion2scene_flow/closed_loop/panel.py`: slalom development layout seed `20261016`, corridor/overhead-beam seed `20261017`. These are fresh source-generated development geometry, not sealed evaluation outcomes. Slalom permits routes around wall ends; a goal completion does not imply passage through every alternating gate.

| Case | Goal X/Y, m | Source outcome | Simulated duration, s | Final distance, m | Peak obstacle contact, N |
| --- | --- | --- | ---: | ---: | ---: |
| Slalom preset | 3.8761 / −0.0902 | timeout | 10.00 | 0.385 | 0 |
| Slalom lateral | 3.8761 / 0.7000 | goal_completion | 8.16 | 0.197 | 0 |
| Slalom intermediate | 2.5000 / 0.2000 | timeout | 10.00 | 1.637 | 55.29 |
| Corridor preset | 4.2621 / 0.0539 | goal_completion | 5.82 | 0.262 | 0 |
| Corridor lateral | 4.2621 / 0.3500 | obstacle_collision | 7.46 | 0.472 | 238.61 |
| Corridor intermediate | 3.1000 / −0.2000 | timeout | 10.00 | 0.712 | 74.44 |

The source goal criteria remain distance ≤0.30 m and XY speed ≤0.25 m/s continuously for 0.40 s. The corridor lateral run first entered the distance radius at 4.76 s, but did not meet the complete source success criterion; it later hit the source collision threshold of 100 N. Raw scorer speed/hold rows are not persisted, so the failing part of the arrival criterion cannot be independently reconstructed. Source outcomes are retained unchanged. Contacts below 100 N are still contacts and are shown above; the two intermediate timeouts are not contact-free successes.

## Measured timing

| Case | Worker wall, s | Planner p50 / p95, ms | SONIC p50 / p95, ms | Replans | Stop-selection count |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slalom preset | 37.69 | 454.1 / 510.1 | 2.55 / 4.22 | 63 | 0 |
| Slalom lateral | 31.76 | 430.8 / 576.9 | 2.41 / 5.39 | 51 | 2 |
| Slalom intermediate | 82.75 | 620.7 / 2475.5 | 4.48 / 9.02 | 63 | 18 |
| Corridor preset | 32.15 | 579.5 / 954.8 | 3.73 / 8.32 | 37 | 0 |
| Corridor lateral | 58.40 | 564.1 / 1990.5 | 2.68 / 4.54 | 47 | 19 |
| Corridor intermediate | 98.57 | 1771.0 / 2057.6 | 2.72 / 5.05 | 63 | 40 |

Worker wall time includes startup and recording. Planner percentiles are independently recomputed from native plan records; SONIC percentiles from captured inference measurements. Stop-selection count is the actual `stop_max_clearance` rule count, not a confidence score or inferred cause of failure.

The host was shared with browser rendering and some read-only regression checks. These observations are not isolated latency benchmarks, statistical success rates, or proof that goal choice caused the timing differences. CPU lockstep uses zero injected planner-delivery delay: it waits for computation rather than validating real-time deadlines. Ideal simulation state, the source planner's unknown-as-free treatment and possible direct-route fallback also limit deployment conclusions.

## Open each replay

Keep the gateway running on `127.0.0.1:8790`. The Codex desktop maps this to the browser's local forwarded port (currently `64842`). Open server URLs through the desktop; do not start a server on the forwarded port. Every link enables the map overlay, one filtered-LiDAR card, Health, follow camera, half-speed playback and loop. Loop replays saved frames without launching a policy.

| Case | Recorded session | Replay |
| --- | --- | --- |
| Slalom preset | `job-87ad8a902ae1` | [Open](http://127.0.0.1:8790/?session=job-87ad8a902ae1&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&time=0&play=1) |
| Slalom lateral | `job-801af2bbb4a7` | [Open](http://127.0.0.1:8790/?session=job-801af2bbb4a7&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&time=0&play=1) |
| Slalom intermediate | `job-c58319ee7d53` | [Open](http://127.0.0.1:8790/?session=job-c58319ee7d53&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&time=0&play=1) |
| Corridor preset | `job-f997655abbe7` | [Open](http://127.0.0.1:8790/?session=job-f997655abbe7&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&time=0&play=1) |
| Corridor lateral | `job-dcb1589943bc` | [Open](http://127.0.0.1:8790/?session=job-dcb1589943bc&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&time=0&play=1) |
| Corridor intermediate | `job-ac91405f1102` | [Open](http://127.0.0.1:8790/?session=job-ac91405f1102&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&time=0&play=1) |

The new **FINAL RECORDED OUTCOME · ENTIRE RUN** card separates the final source result from cursor diagnostics. In the corridor collision, peak contact occurs during the final 7.440–7.460 s physics interval. The last rendered pre-action pose is at 7.440 s and its causal preceding contact interval is 0 N. The summary correctly exposes 238.61 N without inventing a later pose or rewriting the cursor metric. Source final-result events are stamped at the last retained pre-action frame; use the summary's evaluator elapsed time for termination.

All six middle/end follow views were visually inspected, plus both intermediate runs at peak causal contact. Robot articulation, reference ghosts, obstacle geometry, causal map captions, LiDAR timestamps, timeline and Health summaries render together. A distant goal label can extend behind the pinned sensor card in Follow; use **Top** and zoom out to compare the complete route, start and goal. Supplemental top-layout screenshots retain the same time and sensor/Health selection. The inspector scrolls to additional diagnostics below the timing fields.

## Workflow fixes and verification

The real runs exposed two display races: a terminal live preview could be mistaken for a full replay, and a paused one-frame seek could leave the sensor timestamp behind. Full replay now loads explicitly before the workspace transitions; delayed live packets cannot mutate it. Terminal previews remain labelled simulation samples, and paused seeks refresh sensor timestamps even for a single 20 ms step. Existing failed recordings retain their actual error and incomplete banner.

The browser harness also needed explicit waits for save completion, full decoded frame count and pinned-sensor cursor synchronization. It resumed only the unexecuted cases after each browser interruption. Original reports and failure screenshots remain in the evidence directory. No policy configuration was repeated to improve its outcome. The final read-only replay review is the authoritative complete-replay check; early live-preview frame counts in the preserved launch report are not recording lengths.

Evidence root: `/home/linjiw/research-data/g1-deploy-studio/evidence/fixed-goals-20261015/`. Native recordings remain under `/home/linjiw/research-data/g1-deploy-studio/workbench/jobs/JOB_ID/run/`.

Passed: 97 Studio unit/integration tests; 11 upstream route regressions; 318 independent audit checks over 2,572 native frames, 10,288 contact substeps and 259 perception snapshots; all six complete-replay checks (14 follow-camera snapshots); 13 general browser regressions, nine saved-view checks, six transition checks and three outcome-summary checks. The full replay review reported no JavaScript or failed HTTP responses. Every run retained `hardware_enabled=false`, `dds_participants=0` and simulated-command provenance.

- `inputs.json`: exact inputs, map fingerprints, source revision and endpoint checks.
- `navigation-acceptance.json`: all six launched jobs, original outcomes, measured timing and source paths; interrupted reports are preserved separately.
- `audit.json` and `audit_owned_runs.py`: independent source/request/state/reference/contact/frame/time/selection/timing parity and disabled hardware/DDS checks.
- `replay-review/replay-review.json`: every full replay at middle/end and positive causal contact where available, sensor timestamps, half-speed playback, loop and screenshot paths.
- `replay-review/visual-review.json`, `top-layout-review.json` and `*-top-layout.png`: manual review of 26 follow/contact/top screenshots. Fitted Top views use the same middle cursor and one ordinary zoom-out; minor goal-label overlaps and header truncation remain documented.
- `outcome-view/outcome-view.json`: actual goal/timeout/collision summaries, including terminal post-action contact versus cursor contact.
- `replay-transition/replay-transition.json`: six read-only race/failure/sensor checks. The deliberately delayed browser response and one-frame preview envelope are labelled fixtures; recorded state/error values are real.
- `navigation-view-regression/`: nine existing saved-view regression checks.
- `browser-regression/`: general recorded-data browser regression, including model kinematics.
- `studio-tests.txt`, `route-tests.txt`, `reference-check.json`: unit/integration tests, 11 upstream route regressions, and all seven reference paths.

Run the existing cockpit, or keep its current process running:

```bash
cd /home/linjiw/code/g1-deploy-studio
.venv/bin/python -m studio.server --port 8790
```

Read-only repeat of the six recorded replay checks (starts no policy workers):

```bash
STUDIO_URL=http://127.0.0.1:8790 \
STUDIO_REPORT=/home/linjiw/research-data/g1-deploy-studio/evidence/fixed-goals-20261015/navigation-acceptance.json \
STUDIO_EVIDENCE=/absolute/path/to/new-replay-review \
node tools/navigation_replay_review.mjs
```

To deliberately execute six new CPU checks with the same inputs, use a new evidence directory:

```bash
STUDIO_URL=http://127.0.0.1:8790 \
STUDIO_CASES=config/navigation-goal-checks.json \
STUDIO_EVIDENCE=/absolute/path/to/new-six-run-evidence \
node tools/navigation_acceptance.mjs
```

Next engineering target: inspect reference selection, stopping behavior and sensed clearance in the intermediate goals and corridor lateral failure, then propose a bounded planner correction with these preserved runs as regressions. This comparison does not authorize additional upstream changes or establish hardware readiness.
