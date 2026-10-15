# Working implementation plan

Scope: local, read-only replay cockpit first; integrations consume telemetry. No hardware access or external publication.

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
