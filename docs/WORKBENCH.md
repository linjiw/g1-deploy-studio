# Arena, rehearsal, suites and runs

Workflow: build an arena, rehearse a policy on its presets, then compare the runs. Everything runs in the owned CPU worker. No hardware, DDS or ZMQ interface is opened.

## 1. Arena

Open **Arena**. The stage becomes a top-down editor in world metres (x forward and red, y left and green, Z up).

- **Start from:** a template (empty, corridor 1.2 m, doorway 0.8 m, slalom, overhead beam, U-trap, seeded clutter) or any existing box map, including the source-generated Flow arenas and earlier saved arenas.
- **Tools:**
  - *Select*: drag a box to move it. Blue handles resize along x, y or the corner; the amber handle rotates (snaps to 5° and 5 cm). Drag empty space to pan; scroll to zoom.
  - *Wall* / *Beam*: drag a line. Walls are 0.24 m thick and 1.2 m tall. Beams span 1.05–1.25 m and are drawn hatched; they block the upper body, not the legs.
  - *Pillar*: click to place a 0.3 m pillar.
  - *Start* / *Goal*: click to place. Drag the blue tip to set the start heading.
- **Keyboard:** Del removes, D duplicates, R rotates 15°, arrows nudge, Esc deselects.
- **Selected box:** exact X/Y, length, width, yaw and bottom/top heights.
- **Presets:** up to 16 named start/heading/goal variants. *Mirror Y* adds the reflected case.
- **Random goals (seeded):** count, distance band from the start, optional random start, *behind an obstacle* (the straight line must cross a box), heading (toward goal, random, or the start's). Same seed gives the same presets. The seed and parameters go into the labels and the arena description. Every sample passes the standing-footprint preflight.
  - Each preset is checked live with the same conservative standing-footprint preflight the server uses: 0.25 m around every box below 1.3 m.
  - Preflight is geometry only. Route feasibility is not checked; only a rehearsal can tell.
- **Save arena** stores a new immutable map, `arena-<id>`, with a SHA-256, presets and its base-map provenance. Editing a saved arena and saving again creates a new arena. Earlier runs on a saved arena are overlaid on the canvas.
- **Build sheet** opens `/sheet.html?arena=<id>&preset=<index>` in a new tab for the saved arena and the active preset. It is disabled until the arena is saved. It is a printable page (A4 or Letter, two pages) for building the course in a real room ([REAL_WORLD_DEPLOYMENT.md](REAL_WORLD_DEPLOYMENT.md) §6.1). It contains:
  - a plan and an obstacle table in the start-mark frame (ahead, left, rotation relative to the start heading);
  - the goal and the `./g1 robot --goal AHEAD LEFT` line; `--odom zmq` past 3 m;
  - this preset's rehearsals with Wilson intervals, and a go/no-go checklist from g1-student-deploy's operator procedure.

  The sheet only reads the API. It is a plan for an operator-run test, not a hardware certification.
- **JSON** export and import: `{kind: "boxes", frame_id: "world", units: "m", boxes: [...], presets: [...]}`. At most 128 boxes per arena and 64 arenas.

Scans (`kind: scan`) remain inspection-only. They have no collision geometry, so they cannot drive physics.

## 2. Rehearse

Open **Rehearse**, or click **Rehearse →** after saving an arena.

- **Flow research sync** shows the adopted block from `BEST_MODEL.md`. **Policy profile** lists every pinned profile with its lineage, tracker, identity hash and limitations ([POLICIES.md](POLICIES.md)).
- Choose the **arena** and **preset**. The 3D view previews the boxes, start and goal, labelled *not yet run*.
- **Settings:**
  - duration 1–10 s of simulation and the seed;
  - candidates K and ODE steps, with presets *Quick* 2/4, *Balanced* 4/6, *Wide* 8/6 and *Deployed* (the profile's evaluated budget);
  - **Seeds in suite**, 1–4.
- **Success criterion:** *Arrive & hold* (Studio deployment check) or *Reach* (Flow Isaac arena protocol); thresholds are in POLICIES.md. The source scorer applies it; completion of the worker process is never treated as policy success.
- **Planner latency (L2):** none, 100, 160 (the robot's 8-tick replan budget), 200, 300 or 500 ms; the API accepts 0–1000 ms in whole 20 ms ticks. A plan requested at tick t drives SONIC only from t + latency, and physics keeps running meanwhile.
  - Bundle: uses the source lockstep's own model, with *measured* or *predict* (latency-aware) anchoring.
  - WX: uses a Studio delayed-execution approximation around the Flow callback, labelled **L2≈**. Two anchors are available:
    - *measured*: the planner plans from the state at request time.
    - *predict*, labelled **L2≈ predict**: Studio gives the planner the state predicted at request + latency from the landed plan, using g1-student-deploy's method. Route and tight-mode decisions stay measured. See [POLICIES.md](POLICIES.md#latency-and-torque-checks).
  - The anchor applies only with latency; at 0 ms every plan is anchored on the measured state (a request for *predict* at 0 ms is stored as *measured*).
  - Under latency, the plan shown in the scene and the Intent card is the one *executing* (it landed at request + latency), with its request and start times.
- **Actuator limits:** the G1 hip torque profile, *Current G1 · 139/139/88* (default), *rev_1_0 · 88/139/88* or *Source model · 88/88/88*. See [POLICIES.md](POLICIES.md#latency-and-torque-checks). Health shows the profile, the joints whose command reached the effective limit (source clip or model clamp), and the substeps at or above the training limit and each hardware reference. The anchor prediction error appears for predict runs.
- **Run preset** saves the scenario and starts the worker. The live run attaches to the viewport (Follow camera, Health tab) at about 3 Hz. When it finishes, its full recording opens at the same time cursor.
- **Run suite** runs every preset × seeds, at most 48 runs, one after another through the single owned worker. A running suite reserves the worker: manual runs are refused until it finishes or is cancelled. The suite table fills in outcomes as they arrive. **Cancel** stops the queue and the current run.

**Limits.**
- One worker per data root (kernel lock, also across gateway restarts).
- Wall limit 180 s for the bundle profile and 480 s for WX-RF, plus 256 MiB output per run.
- CPU threads are capped at 2 and GPU visibility is disabled.
- At most 512 stored jobs and 2000 scenarios; identical scenario requests reuse one saved scenario. Old recordings are never deleted automatically; archive them outside the workbench directory.

Cancel signals only this gateway's own process group. It is a simulation control, not an emergency stop. Closing the browser does not cancel a run.

**Gateway restarts.** A worker can outlive its gateway, for example after a gateway-only crash. Stopping the systemd unit stops the worker too.

- When the gateway comes back, the run shows **DETACHED**.
- The new gateway reads the run's files but never signals the process, so the run cannot be cancelled from the page.
- Rehearse keeps following the files and opens the recording when the completion receipt appears.
- A run that ended without a recording (cancelled at start, or killed) stays in the list. Its replay request answers *no replayable recording* rather than a file error.

## 3. Runs

**Runs** lists every owned rehearsal, newest first. Each row shows:
- the outcome chip, scenario, policy, budget, seed, criterion, latency and actuator profile;
- simulated duration, final goal distance, peak contact and planner p95.

Filter by arena (identical names get an id suffix), policy or outcome. Tick up to 64 runs, or *Select all in view*, to overlay their simulator-ground-truth root paths on the arena, colored by outcome or by policy. **Replay** opens any run. **↓ CSV / ↓ JSON** export the rows. In the CSV, `torque_at_limit_joints` lists the joints that reached their effective limit, reads `none` when torque was recorded and no joint did, and is empty for runs recorded before torque tracking. `anchor_xy_error_p50_m` is empty unless the run recorded an anchor prediction (WX predict runs; bundle predict runs record none).

"Outcomes in view" pools every condition in view per policy, so it is a count, not a rate.

**Robustness report.** For the runs in view, grouped by policy · criterion · latency · budget · actuator profile:
- source-scorer goals with **Wilson 95% intervals**, over distinct scenarios (an identical re-run counts once; worker errors are listed, not counted);
- **post-hoc Flow reach**: the arena protocol (0.4 m, ≤ 2 m/s for 0.1 s, contact ≤ 5 N, no fall) re-evaluated on each run's recorded 50 Hz trajectory, so arrive-and-hold runs are also judged by Flow's criterion;
- failure categories (timeout ≤ 0.5 m vs > 0.5 m, collision, fall, error);
- medians over the source-scorer goals: time to goal, path efficiency (progress per metre walked, in [0, 1]);
- median time to post-hoc reach, contact count, and runs whose leg torque (hip, knee, ankle) reached the limit (source clip or model clamp); when arm or waist joints add more runs, the any-joint count follows.

## Live and recorded data

Each run directory, `~/research-data/g1-deploy-studio/workbench/jobs/<job>/run/`, holds:

| File | Contents |
|---|---|
| `request.json`, `task.json`, `boxes.json` | Exact inputs. WX runs also include `callback_config.json` and the standing start record. |
| `latest.json` | Atomically replaced live snapshot. Polled in "light" form: frame and progress always, perception only when newer. |
| `progress.jsonl` | 50 Hz state and health; used for trajectories. |
| `native/` | The source backend's own recording (`closed_loop.npz`, `plans.json`, `score.json`), decoded independently for parity. |
| `session.json` | Replay with frames, reference windows, PD targets, contact intervals, timing, pipeline samples, events and policy profile. |
| `result.json` | Scorer outcome, timing, parity receipt and policy bundle id. |
| `physics_observations.npz`, `pipeline_observations.json` | Physics-substep contacts and model-boundary samples. |

Bundle-profile runs also record causal LiDAR and maps at 5 Hz. WX runs record none, because that block plans from the exact boxes.

## API (loopback only; POST needs the same-origin token)

`GET /api/workbench`, `/api/map?id=`, `/api/scenarios`, `/api/jobs[?id=&light=1&perception_after=]`, `/api/suites[?id=]`, `/api/runs`, `/api/policies`, `/api/robot`, `/api/sensors?session=&time=[&masks=1]`, `/api/session?id=` (gzip + ETag), `/api/version`.

`POST /api/scenarios`, `/api/arenas`, `/api/maps/import`, `/api/jobs`, `/api/jobs/cancel`, `/api/suites`, `/api/suites/cancel`. No other mutation or control endpoint exists.

A scenario request without `policy_id` uses the frozen bundle. That is a stable API default, while the UI preselects the adopted profile; scripts should always pass `policy_id`. Without `actuators`, a new request uses `g1-current`.
