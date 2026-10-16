# Preparation, policy testing and sensor views

Start the existing gateway with `.venv/bin/python -m studio.server` and open `http://127.0.0.1:8790`. Replay remains available. The workspace buttons add **Prepare**, **Policy test** and **Sensors**. No hardware command interface is enabled.

## Map and navigation goal

In Prepare, choose the explicit flat-ground simulation, the recorded beam collision geometry, or the actual final DDS map. The preparation scene is separate from the recording's coordinate frame: it hides the replay robot and labels the displayed map. Use **Pick goal on map** to select an XY goal, or enter coordinates. Configure the start position separately. Units are metres, radians and Z-up world coordinates.

The catalog also includes three existing Flow source-generated obstacle layouts: detour, slalom and corridor with an overhead beam. **Use scene start / goal** explicitly applies the suggested start, goal, heading and test budget; coordinates remain editable. Their generator hash and development seed are available in Map provenance. See `SCENES.md` and the exercised configurations in `NAVIGATION_TESTS.md`.

**Validate & save scenario** checks finite values, map bounds, conservative start/goal footprint clearance, supported backend and bounded test settings. This is geometric preflight, not a route or policy-success guarantee. The source Flow selector treats unseen cells as free; the cockpit keeps those cells visually unknown and explicitly reports that limitation.

Local JSON imports support at most 128 static collision boxes or 20,000 XYZ scan points in a 4 MiB request. No arbitrary filesystem paths, remote URLs or executables are accepted. A box map supplies an explicit simulated ground plane and collision geometry:

```json
{
  "label": "Corridor",
  "kind": "boxes",
  "frame_id": "world",
  "boxes": [
    {"center_xy": [1, 1], "half_xy": [1.5, 0.12], "yaw": 0,
     "z_bottom": 0, "z_top": 1.2},
    {"center_xy": [1, -1], "half_xy": [1.5, 0.12], "yaw": 0,
     "z_bottom": 0, "z_top": 1.2}
  ]
}
```

A scan import uses `{"label":"Scan","kind":"scan","frame_id":"world","points":[[0,0,0],[1,0,0]],"resolution_m":0.1}`. Only supplied points are displayed. Nearby returns do not establish traversability or collision-free space. Scan maps and the historical DDS accumulated map are inspection-only: policy physics testing requires explicit collision geometry. PLY/PCD/ROS map import, automatic reconstruction and calibration/frame registration are not implemented.

Saved scenarios can be loaded and exported as JSON. They include map identity/hash, goal/start, heading, duration, seed and planner settings. Imports and configurations remain under `~/research-data/g1-deploy-studio/workbench`, outside Git.

## Fresh policy test

Policy test runs the actual frozen Flow planner → fused SONIC ONNX → MuJoCo CPU chain in one owned subprocess. It uses the existing reference environment read-only. This is an in-process simulation test, separate from the C++/DDS deployment chain. Neither hardware nor DDS interfaces are opened.

The disposable worker explicitly exits after its recording writes are closed, avoiding an observed native interpreter-shutdown stall. Exceptions remain nonzero process exits, and the gateway still requires a complete receipt and replay before reporting execution completion. Navigation failure (collision/timeout) remains separate from successful process execution. The 180 s wall limit, output limit and exclusive worker lease still apply. This process-lifetime workaround is not a fix or validation of the underlying native runtime's shutdown behavior.

New tests capture bounded model-boundary samples for **Health → Inspect pipeline**. See [sensor and model pipeline inspection](MODEL_PIPELINE.md) for actual Flow conditioning maps, the eight SONIC observation blocks, reference/command conventions and unavailable internals.

The default quick profile uses two candidates, four ODE steps and a two-second simulation horizon. The deployed bundle uses sixteen candidates and ten ODE steps. Both settings can be selected explicitly; duration is limited to 1–10 simulation seconds. Simulated time pauses while CPU planning runs. Wall duration, realtime factor, inference latency and planner latency are measurements, not a real-time scheduling guarantee.

**Save & run CPU test** validates the configuration and launches the worker. Live state can attach to the viewport with Health open. The job panel distinguishes observed worker-process state and telemetry receipt age from simulation-clock freshness. **Open recorded test result** loads the full run into the existing synchronized timeline. A worker marked completed means execution/recording completed; the policy outcome can still be timeout, fall or failure. Goal distance and the source scorer's outcome remain explicit.

When source execution fails after valid samples, **Inspect recorded failure** opens the preserved executed motion, sensors and failure event. The failed status, original reason and incomplete-recording warning remain visible; no samples are invented after the failure. Goal success requires the source distance, speed and hold-time conditions together.

**Cancel this test** signals only the current gateway's owned process group. It is a simulation-job control, not a hardware emergency stop. Closing the browser does not cancel the worker. A kernel lock permits only one worker per data root, including across a gateway restart. Recovered job records are read-only and never authorize signals to a saved PID. A surviving worker retains its lock; its output can be inspected until it finishes.

The gateway limits each owned worker to 180 wall seconds and 256 MiB of output, with at most 128 stored jobs, 100 scenarios and 32 imported maps. CPU threads are bounded; GPU visibility is disabled. Completed recordings and compact job history survive gateway restart. Archive owned data outside the workbench directory when storage limits are reached; the application does not delete old recordings automatically.

## Sensors and synchronized perception

Sensors lists actual available channels and explicit missing channels. Up to three cards can attach to the viewport; point clouds also overlay the world view only when the source frame is compatible. Views preserve classification, units, frame, source/receipt clocks, age, update-rate basis and calibration provenance.

Fresh CPU runs provide actual simulated ray returns, the source-filtered cloud, consumed support/ceiling maps with observed masks, simulator base/joint state, joint velocity, SONIC PD targets, and simulator IMU orientation/angular velocity. Raw scan acquisition time and map fusion time remain separate. Perception is selected causally at or before the timeline cursor, including when seeking backward.

Physical camera images, physical IMU packets/acceleration, physical joint faults and actual DDS lowcmd receipt are not generated by this backend. They remain unavailable. Historical recordings retain their original limits: the C++/DDS final map is unsynchronized, and its raw LiDAR history cannot be reconstructed from that map.

Fresh runs also retain actual physics obstacle-contact forces. Health uses only the preceding completed interval; the first frame is unavailable. The current interval lives under `post_action.contact` with its own timestamps. These are robot-obstacle normal forces, excluding floor contacts, not physical foot force sensors.

The timeline's **Link** control preserves the selected view. URL parameters support `pin=lidar_filtered`, `time=1.2`, `camera=follow`, `speed=0.5`, `loop=1`, `panel=health` and `map=1`. **Loop** repeats replay only. It never starts a policy worker. On narrow screens, pinned sensor cards are placed below the robot so they cannot cover its motion.

## Integration and checks

The gateway serves `/api/workbench`, `/api/map`, `/api/scenarios`, `/api/jobs` and `/api/sensors`. JSON POST operations require the same loopback origin and a per-gateway preparation token. Allowed mutations save local configuration or start/cancel the fixed CPU backend; no arbitrary process launch or network/controller configuration is accepted. The app supports desktop/SSH forwarding with a different local browser port.

```bash
.venv/bin/python -m unittest discover -s tests -v
STUDIO_URL=http://127.0.0.1:8790 node tools/workbench_acceptance.mjs
.venv/bin/python tools/accept_workbench.py --url http://127.0.0.1:8790 \
  --output /absolute/new/evidence-directory
```

The API acceptance creates a real bounded run, observes its partial session, pauses only that newly launched CPU child for 1.3 seconds to demonstrate stale telemetry, resumes it, checks consumer disconnection and duplicate-worker rejection, then cancels a second owned job. It verifies the child's command/request identity before applying signals. The browser acceptance exercises the interactive workflow. Their output is evidence of CPU simulation and UI behavior, not hardware readiness.

Remaining integration work: isolated nonzero-domain C++/DDS rehearsal, native ROS/DDS live collectors and discovery, actual camera streams, validated scanned-world collision reconstruction, policy-bundle selection beyond the pinned frozen backend, and separately authorized physical-G1 observation. The canonical runner's hard-coded domain 0 and the host NVML mismatch remain unresolved; this work does not change those systems.
