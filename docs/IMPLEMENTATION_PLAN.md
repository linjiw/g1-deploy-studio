# Working implementation plan

Scope: local, read-only replay cockpit first; integrations consume telemetry. No hardware access or external publication.

## Fixed-planner goal comparison (delivered and exercised)

1. Freeze six explicit development cases in `config/navigation-goal-checks.json`: preset, lateral-offset and intermediate goals on each of the slalom and corridor scenes. Keep start/yaw/seed/K4-ODE6/10 s deadline fixed. Endpoint standing clearance is checked separately from navigation outcome.
2. Execute the browser preparation/test/replay workflow sequentially using corrected deployment commit `f3329db5`. Preserve every source outcome and process exit without selecting only successful trials.
3. Compare completion, goal distance, contacts, simulation duration, worker wall time and planner/SONIC latency. Independently verify source/request/normalized-recording parity.
4. Visually inspect every LiDAR/map/Health replay at mid-run and terminal frames, exercise playback and retain screenshot links and runnable saved scenarios.

Delivered: six cases executed once each, yielding two goal completions, three timeouts and one obstacle collision; all workers exited 0 without route exceptions. Independent audit passed 318 checks across 2,572 native frames, 10,288 contact substeps and 259 perception snapshots. Fixed terminal live-preview/replay handoff and paused sensor seeking; added explicit whole-run outcome/contact summary. Source outcomes and interrupted browser evidence remain preserved. Exact comparisons, verification and replay links are in `docs/FIXED_PLANNER_GOALS.md`.

## Authorized near-goal route correction (delivered and exercised)

1. Preserve the deployment checkout and frozen bundle; reproduce the recorded same-cell route failure from actual coordinates.
2. Add a tracked deployment correction through `bundle.load_flow()`, retaining both physical endpoints and existing class references. Test same-cell/exact-goal routes, normal-route parity, refresh/progress, loader integration and unchanged arrival scoring.
3. Rerun saved scenario `scenario-c04c8b95e417` unchanged, audit native/replay parity, and open the result with LiDAR, map and Health.

Delivered: deployment commit `f3329db5` on `codex/near-goal-route`; full frozen-bundle verification passed. Final job `job-191de58a285a` exited 0 with source goal completion at 6.46 s. The original failed prefix is unchanged; the new recording has 323 executed frames. Source/adapter/scorer/worker hashes are retained. The first corrected run had an intermittent process-exit stall after saving its completed source result; the bounded guard retained a failed job, and two subsequent identical runs exited normally. Process-local ONNX Runtime vendor telemetry is disabled and stack diagnostics are enabled for future stalls, without claiming a proven root cause. See `docs/NAVIGATION_TESTS.md` for exact evidence and remaining limitations.

## Obstacle navigation and visual workflow validation (delivered and exercised)

1. Reuse the local frozen Flow scene generator read-only for three fresh development layouts (detour, slalom, corridor/beam), with source hashes and editable goal presets. Do not read sealed panels or outcomes.
2. Inspect actual browser screenshots of preparation, live tests, sensor overlays and inspectors. Correct obscured controls/robot views and expose start/heading/final goal distinctly from planner waypoints.
3. Run six bounded CPU navigation cases through the browser, varying goals, heading and planner budget. Record source outcomes, contact/pose parity, timing and screenshots; do not equate execution completion with navigation success.
4. Preserve sensor/map/Health view settings in replay links, verify responsive layout and regressions, leave a representative obstacle run open, and commit locally.

Delivered: three source-backed obstacle maps, six browser-driven navigation configurations, causal contact telemetry, preserved source-failure replay, distinct goal/start markers, reusable view links and mobile layout fixes. Initial outcomes: four goal completions, one timeout and one source runtime error. Exact parity passed for 1,327 frames and 5,308 physics substeps. All 97 unit/integration tests, 13 existing browser checks and nine saved-view checks passed. The later authorized route correction and unchanged-scenario rerun are documented above and in `docs/NAVIGATION_TESTS.md`.

## Simulation workbench extension (delivered and exercised)

1. Add a local map/scenario catalog with bounded JSON imports, explicit world coordinates, start/goal validation, and reproducible Flow/SONIC test settings. Scans remain observed data; they do not imply collision geometry or known free space.
2. Run the actual reference CPU Flow planner + SONIC ONNX + MuJoCo backend in one owned subprocess with bounded duration, resources and output. Report this as in-process simulation, not C++/DDS deployment parity. Preserve all reference repositories and environments.
3. Stream actual sampled state, policy targets, timing and consumed simulated perception from the owned run. Save the final session for the existing replay cockpit. Browser lifetime never controls worker lifetime.
4. Add a sensor inventory and pinnable sensor views for recorded/live simulated data, with causal timestamps and explicit unavailable physical camera/IMU/hardware streams. Integrate preparation map/goal picking, test status and result loading into the browser.
5. Exercise a real short CPU run, API boundaries, goal/map checks, fresh/stale handling and browser controls; document evidence and remaining full DDS/hardware gaps, then commit locally.

Delivered: the connected preparation, CPU policy-testing and sensor workspace. All 88 unit/integration tests and 25 browser checks passed. Fresh runs verified actual source state/reference parity, live measured timing, causal perception, saved scenario/result recovery, duplicate-worker exclusion, browser disconnect and owned-worker stale/cancel behavior. The frozen CPU backend is distinct from full C++/DDS rehearsal; scanned-world reconstruction, additional policy bundles and physical sensor collectors remain open. Exact evidence is in `docs/ACCEPTANCE.md`.

## Original replay slice

1. Inspect actual source and explicitly identified rehearsal artifacts. Verify reference framing, joint names, clock alignment, model identity, and observable SONIC fields.
2. Implement bounded, versioned replay adapters for a real recorded MuJoCo/SONIC lockstep run and a separate recorded C++/DDS rehearsal. Preserve their different evidence claims. Render the matching local G1 model without committing vendor assets.
3. Build a synchronized browser cockpit with reference ghost/window, joints, planner latency, perception availability, timeline and provenance. Expose configured topology separately from recorded/runtime observations.
4. Implement a loopback-only, subscription-only ZMQ recorder and decoders with malformed-packet, clock, gap, stale and disconnect tests. Add portable MCAP export if feasible.
5. Exercise the actual adapters, launch the app, inspect it with a browser, save screenshots outside Git, and document exact acceptance commands and limitations. Commit coherent changes locally.

Initial observations (2026-10-15): all seven reference path/HEAD checks passed; NVML reports driver/library mismatch. The canonical C++ runner initializes DDS domain 0 in source, so it cannot be launched under this task's simulator-domain requirement without a separately authorized upstream change. Existing recordings provide the safe executable vertical slice.

Progress and acceptance results are maintained in `docs/ACCEPTANCE.md` as work completes.

Delivered: both real recorded-motion adapters and actual model rendering; synchronized browser intent/joint/map/health views; portable MCAP; strict subscription-only recorder and captured ZMQ diagnostics replay. Executed 46 unit/integration tests, 13 browser checks, two recorded-data wire rehearsals and independent measured/reference/future kinematic parity. Remaining full DDS rehearsal/hardware blockers are documented in the acceptance report.
