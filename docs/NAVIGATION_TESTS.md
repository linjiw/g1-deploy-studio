# Obstacle navigation workflow: executed development checks

## Try the demonstrated run

The gateway is `http://127.0.0.1:8790` (the desktop forwards it to a local browser port). Open:

```text
http://127.0.0.1:8790/?session=job-191de58a285a&panel=health&map=1&pin=lidar_filtered&time=1.2&camera=follow&speed=0.5&loop=1&play=1
```

This plays the corrected wall-detour recording at half speed, with the causal map, filtered ray-LiDAR and Health together. For the earlier corridor/overhead-beam recording, select `job-1a40c9689e2b`. Loop only repeats recorded playback; it never launches another policy run. **Link** preserves the cursor, pins, map visibility, inspector, camera, speed and workspace in a reusable URL. **Loop** can be turned off at any time.

To test another goal:

1. Open **Prepare**, select a Flow arena, and click **Use scene start / goal** to load its explicit development preset. The three source-generated obstacle layouts and provenance are described in `SCENES.md`.
2. Click **Pick goal on map**, then click the top-down map; or edit world X/Y. Edit the start separately. Blue START/heading and amber NAV GOAL markers are distinct from the planner waypoint. Validate and save; preflight checks standing clearance, not route success.
3. Open **Policy test**, choose duration, heading, planner seed, candidate count and ODE steps. **Save & run CPU test** records those exact values and starts the existing frozen Flow/SONIC/MuJoCo backend. The default quick settings are not the deployed 16/10 budget.
4. Open **Sensors** to attach raw/filtered LiDAR, support/ceiling maps, IMU or contacts. Return to Replay for the largest viewport; attached views remain visible. Choose **Health** for source-clock freshness, actual inference/planner timing and completed-interval contacts.
5. Inspect the source outcome in Policy test. Open its recorded result or recorded failure; saved configurations and runs remain selectable after restart. The scan importer remains inspection-only without explicit collision geometry.

Preparation carries a clear notice that selected-recording diagnostics do not validate the draft map. Sensor cards sit below the robot on narrow screens. Save/run actions remain visible in the scrolling workbench. Simulation actions never open hardware interfaces.

## Results

Six development configurations were run through browser map selection, custom XY goals, settings, launch, actual live state, outcome inspection and sensor/map/Health replay. There were seven execution attempts: the long detour was repeated once after adding preservation of failed recordings. Four configurations met the source goal criteria, one timed out, and one hit a source route exception. These are individual integration checks, not a statistical navigation success rate.

| Configuration | Candidates/ODE | Source outcome | Sim time, s | Worker wall, s | Final goal distance, m | Planner p50/p95, ms | SONIC p50/p95, ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `detour-short-quick` | 2/4 | goal_completion | 2.36 | 9.73 | 0.163 | 264.4 / 341.2 | 4.04 / 6.59 |
| `detour-short-expanded` | 8/6 | goal_completion | 2.24 | 13.57 | 0.244 | 679.3 / 741.7 | 2.77 / 4.12 |
| `detour-beyond-wall` | 4/6 | runtime_error | 5.92 | 20.94 | 0.041 | 388.8 / 437.8 | 2.21 / 3.13 |
| `slalom-custom-heading` | 4/6 | goal_completion | 6.20 | 22.90 | 0.194 | 413.3 / 468.9 | 2.20 / 3.47 |
| `corridor-through-beam` | 4/6 | goal_completion | 5.82 | 22.92 | 0.262 | 437.1 / 553.5 | 2.30 / 3.44 |
| `corridor-custom-turn` | 2/4 | timeout | 4.00 | 10.95 | 0.661 | 201.1 / 464.4 | 2.07 / 3.00 |

The short detour pair uses identical start/goal/seed and differs in planner budget. Both completed; measured median planner time increased with the larger budget. Wall times include startup and recording and were observed while the browser was rendering on the same host; these are not isolated performance benchmarks. No real-time deadline guarantee is inferred. All six runs recorded zero robot-obstacle normal contact force; floor contacts are excluded by the source metric. No fall was scored; these runs do not validate positive-force collision or fall handling. Goal completion requires distance ≤0.30 m and XY speed ≤0.25 m/s continuously for 0.40 s.

The slalom starts at yaw 0.35 rad. The final corridor case changes the goal to `(0.8, 0.1)` and initial yaw to 1.2 rad, with a four-second horizon and quick 2/4 settings. It timed out at 0.661 m from the goal. Short-goal success does not establish arbitrary-goal robustness.

## Source route failure and preserved evidence

The long detour reached 0.041 m from the goal after 5.92 s, then the unchanged source `Route.project()` raised `ValueError: attempt to get argmin of an empty sequence`. The source route can contain one point when start and goal map to the same grid cell; projection expects at least one segment. This historical result remains **runtime_error**, not goal completion. The reference repository was not patched during that initial investigation; the separately authorized correction is described below.

The original failed attempt is `job-27eb805f08ca`; the repeated, fully inspectable failure is `job-b5a5fca91f03`. Its 296 executed frames, all recorded causal sensor/map snapshots and physical substeps are retained. Source lockstep wrote 297 pre-action states but only 296 actions/post-states/references. Studio preserves that native NPZ and creates an explicitly documented `native_executed` slice excluding only the unmatched final pre-state. Exact state/reference parity still applies to every executed frame. No motion is invented after failure. The process exits nonzero, job status remains failed, and the replay shows an incomplete-recording banner with the original error.

## Verification and evidence

97 unit/integration tests passed after the failure-recording change. Browser automation exercised every inspector (Intent, Joints, Health, Map, Graph, Source), orbit/top/follow cameras, layers, playback/seek/speed, source-scene presets, custom goals, sensor pinning, and mobile layout. Screenshots were opened and visually inspected, including all three obstacle scenes, their live/replay motion, and the failed replay. The existing 13 browser regression checks also passed. All nine read-only view-link checks passed, including exact saved settings, marker parity and actual failed-run status. Final main-gateway replay, playback, failure recovery and forwarded-Host access were checked again after restart.

All large artifacts remain outside Git under `/home/linjiw/research-data/g1-deploy-studio/evidence/`:

- `navigation-workflow/navigation-comparison.json`: consolidated six configurations, job IDs and source outcomes.
- `navigation-workflow/initial-matrix-at-source-failure.json`: first two successful cases and original discovered failure.
- `navigation-remaining/navigation-acceptance.json`: four remaining configurations, including preserved failure; no page/network errors.
- `navigation-workflow/contact-parity.json`: independent state/reference/contact comparisons against actual owned native artifacts.
- `navigation-workflow/source-route-failure.json`: source hash and minimal same-cell route reproduction. Its all-free occupancy setup is an explicit diagnostic fixture, not reconstructed sensor evidence.
- `navigation-scenes/geometry-validation.json`: seven exact source MuJoCo collider matches across three maps.
- `navigation-workflow/final-main-gateway.json` and `navigation-workflow/final-cockpit.png`: final running server, forwarded-Host access and demonstrated view.
- `navigation-workflow/unit-tests.txt`, `navigation-legacy-regression/browser-acceptance.json`, `navigation-visual-audit/view-acceptance.json`.
- `navigation-workflow/`, `navigation-remaining/`, `navigation-visual-audit/`: preparation, live, outcome, inspector, sensor, camera and mobile screenshots.

Exact recordings and policy inputs are under `~/research-data/g1-deploy-studio/workbench/jobs/JOB_ID/`. Source paths and hashes are retained; no meshes, weights or recordings were committed. All seven reference paths passed checks; the separate `/home/linjiw/flow` HEAD had moved, while the frozen deployment checkout used by these runs remained unchanged.

Commands:

```bash
.venv/bin/python -m unittest discover -s tests -v
# Runs up to six real bounded CPU development cases; records actual failures too:
STUDIO_URL=http://127.0.0.1:8790 node tools/navigation_acceptance.mjs
# Read-only saved-view checks; no policy worker launch:
STUDIO_URL=http://127.0.0.1:8790 STUDIO_JOB=job-1a40c9689e2b \
  STUDIO_FAILED_JOB=job-b5a5fca91f03 node tools/navigation_view_acceptance.mjs
```

During implementation, the browser matrix used the isolated development gateway on 8791. After the source failure was discovered, the remaining four cases used `STUDIO_CASES=.../navigation-workflow/remaining-cases.json` and `STUDIO_EVIDENCE=.../navigation-remaining`; the first report was preserved before continuing. The final application runs on 8790.

Remaining: ROS/DDS live discovery, full isolated C++/DDS execution, physical sensor feeds and hardware observation remain unvalidated. The CPU tests use ideal simulation state and no injected planner delivery delay; the source planner treats unknown map cells as free and may fall back to a direct route. These results establish a useful navigation test cockpit, not hardware deployment readiness.

## Authorized fix and identical detour rerun (2026-10-15)

The user authorized a narrow edit to `g1-student-deploy`. Both working trees were clean before implementation. Deployment commit `f3329db5acd77e47d4758e01928d0df4996ef318`, branch `codex/near-goal-route`, adds `g1deploy/route_compat.py` and installs it through `bundle.load_flow()`. It preserves `[start, goal]` only for a successful one-point route, including a zero-length segment for identical endpoints. Applying it to the original class also covers inherited `SensorRoute` and existing `callback.Route` references. The ignored, hash-pinned frozen bundle and historical manifest remain byte-identical; full bundle verification passed. No scoring thresholds, model weights, ordinary route geometry, occupancy policy or hardware interfaces changed.

The final saved-scenario rerun is **`job-191de58a285a`**, using exactly `scenario-c04c8b95e417`: the same map hash `7a423eacf9dd57a106ef3d61828941c6307cf3ddb12ac74bc49ebd0569f4d5b9`, start `(0, 0)`, goal `(3.8247117178139156, -0.5738279709187756)`, yaw 0, seed 0, K4/ODE6 and ten-second deadline.

| Result | Observed value |
| --- | ---: |
| Job status / worker exit | completed / 0 |
| Source outcome | goal_completion |
| Executed simulation duration | 6.46 s, 323 steps |
| Final / minimum goal distance | 0.085743 / 0.018202 m |
| Maximum obstacle contact | 0 N (floor excluded) |
| Planner p50 / p95 | 393.5 / 439.5 ms |
| SONIC inference p50 / p95 | 3.15 / 7.18 ms |
| Worker time through recording | 23.92 s |

This is a CPU integration check, with ideal simulation state and zero injected planner delivery delay; timing is not a real-time guarantee. The unchanged source scorer declares arrival after its distance/speed/hold criteria. Raw scorer speed/hold rows are not persisted, so exact independent reconstruction of those rows is unavailable. Regression tests separately verify that near-goal proximity cannot bypass speed and continuous-hold requirements.

All 296 formerly executed frames retain exact native pre-state, post-state, reference and contact values. The unmatched pre-state at the old exception also matches the continued run. The complete new recording is checked against native arrays and source identity, including the loader, route correction, frozen route, scorer and Studio worker hashes.

Final verification passed 21 focused deployment tests, 97 Studio tests, 31 independent native-data audit checks and 14 browser checks. Screenshots were visually inspected at 1.2 s and 6.1 s (past the old exception), with the robot, obstacle, navigation goal, causal LiDAR/map and Health visible together. Playback, seeking and looping advance only the recorded data. The running gateway remains loopback-only on port 8790; the desktop forwards its browser URL.

Execution history remains visible: `job-cd24dac996f5` reached the same source goal and saved its recording, but its process stalled during exit and the existing 180-second guard marked the job failed. Diagnostic rerun `job-9bd02a81a46b` exited normally with identical motion. The final run also exited normally after disabling ONNX Runtime vendor telemetry inside the worker process. Native runtime telemetry is a possible cause of the first stall, not a proven diagnosis. A 60-second stack-dump diagnostic now precedes the unchanged 180-second guard; no exit code is overridden or failure relabelled as success.

Evidence under `/home/linjiw/research-data/g1-deploy-studio/evidence/route-fix/`:

- `deployment-tests.txt`: 21 focused CPU tests covering route, SONIC parity and perception.
- `bundle-verification.json`: full frozen artifact verification and unchanged route hash.
- `studio-tests.txt`: 97 Studio unit/integration tests.
- `final-request.json`, `final-result.json`: identical inputs, actual source outcome and clean process exit.
- `native-audit.json`, `final-native-audit.json`: independent native/normalized parity, frame/time/joint and artifact identity checks.
- `shutdown-attempt.json`, `diagnostic-job.json`: preserved lifecycle investigation.
- `final-browser/`: saved-view/browser checks and screenshots; `final-browser-tests.txt` holds the command output.

Commands (simulation/replay only):

```bash
# In /home/linjiw/code/g1-student-deploy:
CUDA_VISIBLE_DEVICES='' OMP_NUM_THREADS=2 .venv/bin/python -m pytest \
  tests/test_route.py tests/test_sonic.py tests/test_perception.py -q
.venv/bin/python -c 'from g1deploy import bundle; assert not bundle.verify(quick=False)'
# In /home/linjiw/code/g1-deploy-studio:
.venv/bin/python -m unittest discover -s tests -v
STUDIO_URL=http://127.0.0.1:8790 STUDIO_JOB=job-191de58a285a \
  STUDIO_FAILED_JOB=job-b5a5fca91f03 \
  STUDIO_EVIDENCE=/home/linjiw/research-data/g1-deploy-studio/evidence/route-fix/final-browser \
  node tools/navigation_view_acceptance.mjs
```

To repeat execution, load the saved detour configuration in **Policy test** and run it; the replay link itself never starts a worker. No DDS participant or hardware command path was enabled. Other reference repositories and ongoing jobs were left unchanged.
