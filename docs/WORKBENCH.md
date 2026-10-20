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
  - Each preset is checked live with the same conservative standing-footprint preflight the server uses: 0.25 m around every box below 1.3 m.
  - Preflight is geometry only. Route feasibility is not checked; only a rehearsal can tell.
- **Save arena** stores a new immutable map, `arena-<id>`, with a SHA-256, presets and its base-map provenance. Editing a saved arena and saving again creates a new arena. Earlier runs on a saved arena are overlaid on the canvas.
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
- **Run preset** saves the scenario and starts the worker. The live run attaches to the viewport (Follow camera, Health tab) at about 3 Hz. When it finishes, its full recording opens at the same time cursor.
- **Run suite** runs every preset × seeds, at most 12 runs, one after another through the single owned worker. The suite table fills in outcomes as they arrive. **Cancel** stops the queue and the current run.

**Limits.**
- One worker per data root (kernel lock, also across gateway restarts).
- Wall limit 180 s for the bundle profile and 480 s for WX-RF, plus 256 MiB output per run.
- CPU threads are capped at 2 and GPU visibility is disabled.
- At most 128 stored jobs and 100 scenarios. Old recordings are never deleted automatically; archive them outside the workbench directory.

Cancel signals only this gateway's own process group. It is a simulation control, not an emergency stop. Closing the browser does not cancel a run.

## 3. Runs

**Runs** lists every owned rehearsal, newest first. Each row shows:
- the outcome chip, scenario, policy and budget;
- simulated duration, final goal distance, peak contact and planner p95.

Filter by arena, policy or outcome. "Outcomes in view" counts goals per policy. These are individual checks, mostly one seed each, not a success-rate estimate. Tick up to 12 runs to overlay their simulator-ground-truth root paths on the arena, colored by outcome or by policy. **Replay** opens any run.

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
