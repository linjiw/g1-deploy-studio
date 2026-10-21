# The public site

**https://linjiw.github.io/g1-deploy-studio/** is a static page that lets a visitor use Studio's Navigate workflow on recorded, simulated walks of the deploy stack, see how the deployment fits together, and step through a robot day with the robot link's pre-Go checklist. It runs no policy and talks to no server: GitHub Pages serves files and the visitor's browser plays them.

## Why recorded walks, and not a live policy

Owner decision, 2026-10-21 (STATUS decisions):

| Option | Why not (or why) |
|---|---|
| **Recorded walks of the real stack** (chosen) | The stack runs once, here, at low priority. No weights leave this machine, nothing runs here afterwards, and the page works on a phone. Goals snap to a grid and every walk starts from the start mark |
| The policy live in the browser (MuJoCo WASM + ONNX) | Publishes the SONIC release weights (NVIDIA Open Model License; lucid-g1-deploy deliberately does not redistribute them) and an export of the unpublished student planner; needs a JavaScript port of the planner, perception and node logic with a parity risk; about 100 MB of downloads and slow on laptops |
| Live sessions served from this machine | About one CPU core per visitor, a public tunnel to a research machine, and only up while it is |

## What a visitor gets

| Section | What it is | Source of truth |
|---|---|---|
| Send the robot somewhere | Five rooms. Click the floor: the six goal checks Studio runs on the map the robot has at the start mark (`studio/goal_check.py`, precomputed for every grid cell); a passing spot snaps to the nearest recorded goal. **Send goal**, then **Go** (or `g`): the recorded walk plays with the robot (simulator truth), its own estimate, its LiDAR returns, the planner's map growing cell by cell, the plan it is tracking and its path. Each walk is graded from its data: *arrived*, *arrived with contact* (over 100 N), *arrived by its estimate, off by truth* (more than 0.6 m), or the node's outcome | `tools/site/record_goals.py` → `studio/nav_worker.py` |
| How the pieces fit | The robot-day topology, clickable: who reads and writes which stream, and what Studio may send | `docs/REAL_WORLD_DEPLOYMENT.md` §3 |
| A day with the real robot | Build, start, connect, pick and send, the operator's `g`, review. The checklist uses the robot link's rules and wording; five switches inject the faults it guards against | `studio/robot_link.py` `_ready` |
| What rehearsing found | The perception findings (STATUS #11, #15), policy behaviour measured in these recordings (contact by room, door passages, pelvis height under the beam), and the review fixes. The measured cards are written from the data, and their example walks are chosen by cause (`tools/site/export.py` `featured`) | `docs/STATUS.md`, `docs/REVIEW-20261021-NAVIGATE.md` |
| Tour | The 9:44 narrated video with chapters and captions | `tools/video` |

## How the walks are recorded

Each goal is one fresh simulated-robot session, the worker behind Navigate: boot standing at the start mark, a 1 s pre-scan, one goal (checked again by the worker), Go, walk, settle to a stand, End. Settings are the robot's deploy configuration: planner budget K 16 / ODE 10, 160 ms planner latency with predictive anchoring, LIO-level odometry drift, one memory per session, the current G1 actuator limits, seed 0. Goals are the cells of a 0.4 m lattice through the start mark that pass Studio's goal check (unseen goals pass with a warning, as in Studio) and lie at least 0.8 m away. They are recorded in coverage order: every room's 0.8 m sub-lattice first, then its centres (a checkerboard), then the rest, so a partial batch still covers every room.

Rooms: the three Flow development arenas (wall detour, alternating walls, corridor with an overhead beam) and two Studio arenas (`tools/site/worlds/`). The doorway room is Studio's offset-doorway demo rebuilt as a 2 m wall across the whole room, running past the edge of the planner's 12 × 12 m memory, with one 1 m door. Two earlier versions were walked around: the arena's 1.8 m walls (the independent review found every far-side walk went round them) and walls to |y| = 5 m with a 0.8 m door (the verification found the same; with the route's 0.35 m margin a 0.8 m door leaves no route through). With the 1 m door, 95 of 96 far-side goal-check routes use the door. The earlier recordings are kept outside the site.

```bash
tools/site/record_all.sh ~/research-data/g1-deploy-studio/site-recordings 6 2   # resumable; nice 19, 2 threads per worker; max level
.venv/bin/python -m tools.site.export --recordings ~/research-data/g1-deploy-studio/site-recordings --out <site-data>
.venv/bin/python -m tools.site.export_robot --out <site-data> && node tools/site/meshes.mjs <site-data>
tools/site/build.sh _site <site-data> <media> && python3 -m http.server -d _site 8811
SITE_URL=http://127.0.0.1:8811/ node tools/site/check.mjs          # browser acceptance, desktop and phone
```

The worker records the planner's memory as display codes at every 1 s snapshot when the request sets `record_grids` (off by default; Studio never sets it). The exporter keeps every second 20 ms tick (25 Hz), quantizes positions to millimetres and angles to milliradians, keeps up to 400 LiDAR returns per snapshot and stores the map as changes from the start map, which it checks is identical in every session of a room.

## Data format

`data/worlds.json` lists the rooms. Per room, `data/<room>/index.json` holds the boxes (simulation truth, drawn as a ghost), the start mark and pose, the map at the start (`codes` and `height_cm`, base64 bytes, row-major `[i, j]` with i along x), every grid cell with its six check statuses (`s`: p/w/b per check in `check_ids` order, `l`: labels that are not pass, `path`: the route the check found) and a summary of every recorded walk. `data/<room>/g/<cell>.json` is one walk: `time`, `q` (per frame x y z mm, quaternion w x y z × 10⁴, 29 joint angles in mrad, in the model's qpos order), `est` (the LIO-level estimate, mm), `phases`, `plans` (pelvis path in cm and height), `plan_starts` (when each plan began driving the robot), `lidar`, `map` (`g`: gaps between flat cell indices, `v`: code, or code × 1000 + height in cm for codes 2–4), `events`, outcome and distances. `data/featured.json` names the example walk for each finding.

## Hosting and performance

- **Where:** GitHub Pages from `.github/workflows/pages.yml`. The page source is in `site/`; the data and the video are not in Git (AGENTS.md: no recordings in Git). They are release assets of the tag in `tools/site/release.json`, downloaded by the workflow and checked against their SHA-256. `tools/site/package.sh` makes them.
- **What a visit costs:** three.js (about 170 kB compressed), the robot (0.75 MB: 36 Unitree meshes simplified from 371k to 85k triangles and quantized), a room (about 60–90 kB compressed) and about 40 kB per walk played. The video loads only when played.
- **Rendering:** one WebGL context; frames are drawn only when something changed (a walk playing, the camera moving) and the loop stops when idle or scrolled away. Pixel ratio capped at 1.75, one 1024² shadow map, the map's obstacle cells drawn as one instanced mesh. The 2D robot-day view is a canvas.
- **This machine:** serves nothing for the site. Recording is a one-time batch at the lowest CPU priority.

## Updating

Record or re-export, `tools/site/package.sh <site-data> <media> <dir> site-vN`, create the release with the two archives, update `tools/site/release.json`, push to `main`. A change to `site/` alone redeploys with the same data.
