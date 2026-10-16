# Corridor and intermediate-goal review — 2026-10-16

The final same-input CPU regression completed **five of six goals**, up from two. All six final runs recorded **0 N obstacle contact**. The corridor-lateral collision and slalom-intermediate timeout are resolved in these development cases. Corridor intermediate still times out with the original four-candidate setting. A separate eight-candidate run completes it, with higher computation cost and tilt. This is one seed per setting, not a reliability benchmark, real-time deployment or hardware validation.

The source is `/home/linjiw/code/g1-student-deploy`, commit `6a86c860d56d91cda4adff001c4b30dff24ef048`, on `codex/near-goal-route`. User-authorized changes are tracked deployment adapters, configuration, tests and documentation. The frozen Flow/SONIC weights, original scorer, other experiments and controller are unchanged.

## Try the results

The loopback gateway is running at **http://127.0.0.1:8790**. If restarting it:

```bash
cd /home/linjiw/code/g1-deploy-studio
.venv/bin/python -m studio.server --port 8790
```

Open a result below. Each link enables LiDAR, map, Health, Follow camera and looping half-speed playback. Choose **Fit full scene + goal** for the route context. Choose **Health → Inspect pipeline** to follow actual model data; the [model inspection guide](MODEL_PIPELINE.md) explains every stage and input block. In **Policy test**, the saved `Review review-six · …` scenarios retain the original settings; `Review supplemental K8 · corridor-intermediate` retains the explicit budget variation. The desktop's forwarded localhost port may differ from the server's port.

| Goal (world XY, metres) | Before | After, original K4 / ODE6 | Final distance | Replay |
|---|---|---|---:|---|
| Slalom preset (3.876, −0.090) | Timeout at 10 s | Complete at 6.48 s | 0.244 m | [Open](http://127.0.0.1:8790/?session=job-056a25a5c5d9&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1) |
| Slalom lateral (3.876, 0.700) | Complete at 8.16 s | Complete at 7.20 s | 0.088 m | [Open](http://127.0.0.1:8790/?session=job-7297fdfd7bf0&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1) |
| Slalom intermediate (2.500, 0.200) | Timeout at 10 s; 55.29 N | Complete at 6.92 s | 0.298 m | [Open](http://127.0.0.1:8790/?session=job-b034af290496&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1) |
| Corridor preset (4.262, 0.054) | Complete at 5.82 s | Complete at 6.72 s | 0.166 m | [Open](http://127.0.0.1:8790/?session=job-9d35df77c6fc&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1) |
| Corridor lateral (4.262, 0.350) | Collision at 7.46 s; 238.61 N | Complete at 6.64 s | 0.276 m | [Open](http://127.0.0.1:8790/?session=job-a1bf68e95723&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1) |
| Corridor intermediate (3.100, −0.200) | Timeout at 10 s; 74.44 N | **Timeout at 10 s** | 0.331 m | [Open failure](http://127.0.0.1:8790/?session=job-1d5367e1657d&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1) |

All original inputs are retained: map geometry, start `[0,0]`, yaw 0, seed 0, K4/ODE6 and 10 s deadline. Completion still requires distance ≤0.30 m and speed ≤0.25 m/s for 0.40 s continuously. Obstacle collision remains >100 N. An exit-zero worker is not automatically a successful navigation result. The [previous six-run report](FIXED_PLANNER_GOALS.md) retains baseline replay links.

## What changed and why

1. **Fallback candidate selection.** Quantized equal clearances could select a GO candidate while labelling it STOP. Preserve maximum clearance, prefer an actual STOP pool on ties, then least XY motion. Higher-clearance GO and no-safe-candidate cases are labelled honestly; no scripted motor stop or extra inference is inserted.
2. **Local pursuit target.** Projecting 1.5 m along the bearing to a nearby route bend could cross an occupied cell. Select a visible point on the existing route within the original lookahead/distance bound, with a free-prefix fallback. Occupied starts remain explicitly uncertified.
3. **Partially seen obstacles.** Use the existing sensor-route uncertainty growth with a 0.10 m default into adjacent unknown cells, preserving known-free cells and raw sensor maps. Record the effective configuration. Explicit zero remains valid; positive sub-cell growth fails closed instead of becoming unlimited dilation.
4. **Arrival heading.** For a position-only goal, latch the existing route/guard approach heading when the actual observed anchor enters the original goal radius. This prevents route refreshes from requesting an abrupt turn near arrival. Preserve world heading across candidate futures, release outside the existing half-lookahead region, and reset for a new goal/run. Lagging measured yaw is recorded separately. Goal XY, path-heading mode, scoring and SONIC remain unchanged.

These are combined integration corrections. The experiments do not isolate each change's contribution. Failed intermediate revisions are preserved, including an overly early yaw latch that regressed the corridor intermediate case.

## Remaining timeout and explicit budget tradeoff

In the K4 corridor-intermediate run, the robot was inside the radius from 4.66–5.96 s. Its lowest speed there was **0.253848 m/s**, just above the unchanged 0.25 m/s limit. Measured hold stayed zero. At closest approach it was 0.107 m from the goal but moving at 0.293 m/s. It ultimately settled 0.331 m away at 0.031 m/s with no contact.

Selected trajectories predict settling, but execution/replanning does not realize it: at 5.44 s the selected XY prediction implies 0.98 s of in-radius, low-speed hold, while actual motion never meets both conditions. These are finite-difference predictions, not guaranteed behavior. Later all 20 K4/resampled/STOP candidates miss the 0.08 m clearance margin. The recording does not expose all alternative candidate speeds or per-body rejection reasons, so it cannot establish a superior stopping candidate or a specific offending surface.

[The separate K8 replay](http://127.0.0.1:8790/?session=job-a8fb86382e21&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1&play=1) changes only the candidate budget from 4 to 8. It completes at **9.86 s**, final distance **0.245 m**, **0 N** contact. Wall time rises from 36.19 to 47.03 s, planner p50/p95 from 303/1168 to 470/2135 ms. Maximum root tilt rises from 0.319 to 0.668 rad. Completion is only 0.14 s before the deadline. This is an available tested setting for this case, not a universally safer default; the original matrix remains **5/6**.

The next planner experiment should record bounded per-candidate stopping/clearance diagnostics and compare predicted settling against executed motion before changing the selection objective. Do not relax completion criteria to manufacture a pass.

## Timing and cockpit improvements

| Original K4 case | Worker wall before → after | Planner p95 before → after | SONIC p95 after |
|---|---:|---:|---:|
| Slalom preset | 37.69 → 16.39 s | 510 → 312 ms | 1.74 ms |
| Slalom lateral | 31.76 → 22.77 s | 577 → 1186 ms | 1.87 ms |
| Slalom intermediate | 82.75 → 20.01 s | 2476 → 388 ms | 1.86 ms |
| Corridor preset | 32.15 → 17.40 s | 955 → 385 ms | 1.79 ms |
| Corridor lateral | 58.40 → 17.34 s | 1991 → 377 ms | 1.84 ms |
| Corridor intermediate | 98.57 → 36.19 s | 2058 → 1168 ms | 1.86 ms |

These are shared-host observations, not a controlled speedup benchmark. The original baseline had browser contention; the final policy batch ran with Chrome closed. Planner latency includes different fallback/resampling work. CPU lockstep pauses simulated time while calculating, so no real-time deadline compliance follows from these timings.

The cockpit now exposes actual sensor/Flow/reference/SONIC/PD boundaries. Flow is PyTorch eager; SONIC is fused ONNX with 1570 inputs and 29 actions. Model heatmaps distinguish source priors from observed space, show candidate-frame axes/ranges and explain unavailable latent tokens. Health shows distance, speed and continuous hold separately from whole-run outcome. The first actual Flow forward is captured per replan; SONIC/PD are sampled at 10 Hz. Applied PD values are hidden until their interval ends.

LiDAR pins include the robot's world XY heading; scene-fit includes the navigation goal. Paused WebGL draws only when data/view changes, model-stage DOM updates follow captured samples, completed recordings use a four-session LRU cache, and playback controls remain visible on small screens. Worker history is bounded to 128 jobs. The owned CPU subprocess exits explicitly after closing recording writes, avoiding an observed native-interpreter teardown stall; this is a bounded lifecycle workaround, not a proven native-library fix.

## Evidence and reproducible checks

Evidence root, outside Git:

```text
/home/linjiw/research-data/g1-deploy-studio/evidence/planner-review-20261016
```

`review-six/navigation-acceptance.json` retains exact requests, source revisions, all six outcomes and replay URLs. `review-six/comparison.json` verifies unchanged geometry, goals/settings, scoring, joint order, robot and policy hashes against the baseline. `k8-probe/probe.json` retains the separate request/result. `upstream-review-notes.md`, `investigation-summary.json` and `approach-arrival-residual.json` explain source diagnosis and residual timing alignment. All worker-native data is under `~/research-data/g1-deploy-studio/workbench/jobs/<job>/run/`.

Verification:

- **105 Studio unit/integration tests** and **61 focused deployment tests** passed. Full frozen-bundle SHA256 verification has no problems. Source tests avoid unrelated research outcome directories.
- **98 native/model/scorer audit checks (14 per recording)**, covering 2,691 frames, 339 Flow samples and 541 SONIC samples across seven recordings. All sampled 1570-input histories, named 29-action target transforms, first PD substeps, reference/state arrays, scorer rows and causal indices match exactly. **21 actual CPU ONNX replays** reproduce recorded outputs bit-for-bit. See `review-six/pipeline-audit-summary.json`.
- MCAP round-trip preserved frames, metadata, perception and pipeline samples exactly: `pipeline-roundtrip.json` and its external `.mcap`.
- **13 core browser checks** passed, including G1 forward kinematics against MuJoCo for both robot variants, replay seeking, layers, explicit stale-state injection and honest unavailable metrics. **10 Pipeline checks** cover all eight actual SONIC blocks, causal PD display, sensor navigation and unavailable older recordings. **Three transport-layout checks** cover desktop and mobile controls. Large-map fitting passed in replay and preparation at two viewport sizes using a visibly labelled rendering-only fixture; it is not policy evidence.
- Six before/after pairs were compared with LiDAR, map and Health at a common timestamp, end and full-scene view: **12 replays, 36 screenshots**, playback and looping, no browser/HTTP errors. All final-run images were manually reviewed against the preserved baseline. The separate K8 replay was reviewed at mid-run, peak tilt, goal entry and terminal scene-fit. See `ui/final-review/comparison-view.json`, `ui/final-review/visual-review.json` and `ui/k8-review/visual-probe.json`. Browser reports are under `ui/browser-final`, `ui/pipeline-final-review`, `ui/transport` and `ui/large-scene-fit`.
- **Four live model-observer checks** passed on actual worker `job-af029945d5be`: direct active-session load, exact runtime input/output availability, advancing causal samples, and handoff to all 150 recorded frames with 19 Flow and 30 SONIC samples. The separate three-second K8/ODE6 smoke intentionally expires before the navigation goal; it is not an extra matrix success or timing benchmark. Evidence is `ui/live-model-smoke-final/{launch.json,live-pipeline-acceptance.json}` and four manually inspected screenshots. Its earlier run `job-3263f4913f41` is retained under `ui/live-model-smoke`; visual review found and corrected a first-live-map caption before this final repeat.

Selected screenshots: [fixed corridor with LiDAR/map/Health](/home/linjiw/research-data/g1-deploy-studio/evidence/planner-review-20261016/ui/final-review/corridor-lateral-after-common-time.png), [preserved K4 timeout](/home/linjiw/research-data/g1-deploy-studio/evidence/planner-review-20261016/ui/final-review/corridor-intermediate-after-end.png), [K8 at maximum tilt](/home/linjiw/research-data/g1-deploy-studio/evidence/planner-review-20261016/ui/k8-review/max-tilt.png).

The live observer is GET-only. To repeat it, set `STUDIO_ACTIVE_JOB_FILE` and `STUDIO_EVIDENCE`, run `node tools/live_pipeline_view_acceptance.mjs`, wait for its `observer-ready.json`, then explicitly launch a short owned test and put that job ID in the selected text file. It does not create scenarios, launch policies or signal processes itself. The exact demonstrated launch parameters are preserved in `launch.json`.

Repeat a read-only data audit (three CPU model evaluations, no trajectory rollout):

```bash
cd /home/linjiw/code/g1-deploy-studio
/home/linjiw/code/g1-student-deploy/.venv/bin/python tools/check_pipeline_recording.py \
  /home/linjiw/research-data/g1-deploy-studio/workbench/jobs/job-a1bf68e95723/run/session.json \
  --replay-onnx --output /absolute/new-audit.json
.venv/bin/python -m unittest discover -s tests -v
```

Read-only browser checks with the gateway running (write evidence outside Git):

```bash
STUDIO_EVIDENCE=/absolute/new-browser-evidence npm run test:browser
STUDIO_PIPELINE_JOB=job-1d5367e1657d STUDIO_EVIDENCE=/absolute/new-pipeline-evidence \
  node tools/pipeline_view_acceptance.mjs
STUDIO_BEFORE_REPORT=/home/linjiw/research-data/g1-deploy-studio/evidence/fixed-goals-20261015/navigation-acceptance.json \
  STUDIO_AFTER_REPORT=/home/linjiw/research-data/g1-deploy-studio/evidence/planner-review-20261016/review-six/navigation-acceptance.json \
  STUDIO_EVIDENCE=/absolute/new-visual-comparison node tools/navigation_comparison_view.mjs
```

Repeat the original bounded policy batch only when deliberately requesting six new CPU runs; use a new output directory and close browser rendering first:

```bash
.venv/bin/python tools/rerun_navigation.py \
  --baseline /home/linjiw/research-data/g1-deploy-studio/evidence/fixed-goals-20261015/navigation-acceptance.json \
  --case slalom-preset --case slalom-lateral --case slalom-intermediate \
  --case corridor-preset --case corridor-lateral --case corridor-intermediate \
  --output /absolute/new-six-run-evidence
```

The tool never retries failures silently. Earlier iterations are retained under `iteration-1`, `iteration-2`, `iteration-3`, `final-six` (an earlier partial batch, despite its name), `arrival-pilot`, `arrival-six`, `latch-pilot` and `approach-pilot`. The partial batch retains a source timeout whose completed recording was followed by a native process-exit stall, and a subsequent bounded-history-cap rejection. Neither is counted as a clean success.

No hardware command path, DDS participant, GPU use, driver repair, system/network modification or external publishing was enabled. The canonical C++ runner's hard-coded domain 0 still blocks a fresh safely isolated C++/DDS launch; the host NVML mismatch persists. Physical sensor extrinsics, robot clocks, physical tracking and real-time transport remain unvalidated. See [live observation preparation](LIVE_OBSERVATION.md).
