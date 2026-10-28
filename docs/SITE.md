# The public site

**https://linjiw.github.io/g1-deploy-studio/** introduces Studio and lets a visitor use its Navigate workflow on recorded, simulated walks of the deploy stack. It shows how the deployment fits together and steps through a robot day with the robot link's pre-Go checklist. It runs no policy and talks to no server: GitHub Pages serves files and the visitor's browser plays them.

| Page | What it is |
|---|---|
| `/` | The project page: a demo slot that loads on **Start** (and frees its memory on **Stop**), the highlights with the tour video, *every walk, one dot*, a split view (*Take a closer look*), the system diagram, the robot day, the findings with the outcome table, an FAQ with metric definitions, and a pointer to the next step |
| `/demo/` | The Navigate demo, full-bleed. The main page's slot is the same app, embedded |
| `/next/` | The execution gap: the plan body against the executed body, measured by Studio in its own recordings |

## Why recorded walks, and not a live policy

Owner decision, 2026-10-21, confirmed 2026-10-22 ("Recorded only, live in local Studio"):

| Option | Why not (or why) |
|---|---|
| **Recorded, simulated walks of the deploy stack** (chosen) | The stack runs once, here, at low priority. No weights leave this machine, nothing runs here afterwards, and the page works on a phone. Goals snap to a grid and every walk starts from the start mark |
| The policy live in the browser (MuJoCo WASM + ONNX) | Publishes the SONIC release weights (NVIDIA Open Model License; lucid-g1-deploy deliberately does not redistribute them) and an export of the unpublished student planner; about 100 MB of downloads. A live mode belongs in local Studio, where the weights stay on this machine |
| Live sessions served from this machine | About one CPU core per visitor, a public tunnel to a research machine, and only up while it is |

## The demo

The 3D view fills a white, quiet stage (a pale floor and grid that fade into the backdrop, the robot's map in light tints, colours chosen to read on white, as in SuperMimic's project page and Studio itself, which shares this palette); the chrome floats over it as white glass and lets clicks through except on its controls.

- **Top left:** the layer toggles, which are also the legend: Robot, Plan body, Its map, LiDAR, Plan, Real room (ghost, solid, off) and Outcomes. `?` opens the full legend and the keys.
- **At the robot:** a hint, *Click the floor. It has to find its own way.*, which goes away after the first goal. Above the dock, until the first walk plays, the operator's three steps light up in turn: pick a goal, send it, Go.
- **At the goal:** Studio's six goal checks (`studio/goal_check.py`, precomputed for every grid cell). The chip shows the verdict, and expands to all six checks. A passing spot snaps to the nearest recorded goal. **Send goal** stages it ("sent, read back, verified"); **Go** (or `g`) plays the recorded walk. On narrow stages the chip is a sheet above the dock.
- **Bottom:** the dock, with new goal, play, Go, the timeline with phase bands and events, speed, the room menu and the camera (orbit, top, follow).
- **The room menu:** each room as a folder with its walks and a bar of their grades, plus **Went wrong**: every walk not graded clean, across rooms, worst first. Filters: clean, flagged, failed, and one grade when the outcome table opened the menu. Choosing a walk, or **Pick one for me** (a random walk from the current list), puts its goal and its checks up with Send focused: the operator still sends it and presses Go. A link or a dot in the chart plays a walk directly.
- **Headlines:** a large line at each phase change and at the events that matter (pre-scan, walking, arrived with the distance, stand deferred, stand forced, E-stop, fall, the final grade), also read to screen readers.
- **The walk:** the robot (simulator truth), its own estimate (the blue ring), its LiDAR returns, the planner's map growing cell by cell, the plan it is tracking, the path walked, and the **plan body**: the reference pose SONIC is chasing, as a pink ghost. A readout shows the estimated distance to the goal, the tilt, contact, how far the plan body is, and the planner's rule.
- **Keys:** with the 3D view focused and no walk, the arrow keys move a goal cursor (0.4 m steps, up is away from the camera) and Enter picks it. Then `g` Go, Space pause, `r` new goal, Esc closes what is open or clears a goal, ← → 1 s (Shift: one frame), `n` the room menu, `1`–`5` rooms, `b` `m` `l` `p` `w` `o` `v` layers, `c` camera, `f` follow, `?` legend. Inside the page the keys belong to the demo only after a click or Tab into it.
- **The result:** the grade, the numbers, and Replay, New goal, **Plan vs body** (this walk in the main page's split view, `#closer/<room>/<goal>`), **Copy link** and Went wrong.
- **Stop** (in the page's slot): tears the demo down (its WebGL context, listeners and observers) and brings the poster back.
- **Links:** `demo/#<room>/<goal>[/play[@<seconds>]]` opens a walk, and plays it from a moment. On the main page the same path follows `#try/`. The findings link to their example walks this way, two seconds before the moment they are about.

Each walk is graded from its data: *arrived*, *arrived with contact* (over 100 N), *arrived by its estimate, off by truth* (more than 0.6 m by truth), *arrived, then moved away* (more than 0.6 m by truth and by its estimate at the end, as after a deferred stand that drifts), or the node's outcome. The rule is in `site/js/util.js` `gradeKey` and `tools/site/export.py` `grade_key`. `tools/site/check.mjs` checks the page against the raw walk.

## Every walk, one dot

`site/js/atlas.js` draws every recorded walk from `worlds.json`'s `list` rows. The x axis is how far the goal was from the start mark. The y axis is the visitor's choice of measure: the final distance from the goal by simulator truth (log scale, with the 0.4 m radius and the 0.6 m flag), the peak contact (log scale, with the 100 N flag and a "no contact" band) or the walk time.

- Room chips filter the chart.
- Moving across it, or focusing it and using the arrow keys, reads a walk out under the chart.
- A click, or Enter, plays that walk in the demo.
- The outcome table's counts open the demo's room menu on exactly those walks (a room and a grade; for all rooms, the Went wrong folder).

## Take a closer look: the split view

`site/js/closer.js` plays one recorded walk on the two halves of one canvas, in step, with a frame counter, frame stepping and scrubbing over a 9 s clip that loops.

- **Plan body vs executed body.** The left half shows the plan body, the right half the simulated G1. Each half's camera follows its own pelvis from the same direction, so posture compares without the lag. **Overlay** puts both in one view, so the lag shows.
- **Truth vs estimate.** The robot where it is, and where it thinks it is. They are centimetres apart, so this one starts overlaid.

The scenarios are picked from the data by the exporter (`featured.json` `closer`): a wall end with contact, the low beam, the 1 m door, a deferred stand that walks away, and the walk that arrived by its estimate but is off by truth. Each has a caption written from that walk's numbers. The walls are drawn as glass so they never hide a body. A walk opened from the demo's result appears as *Your walk* and plays whole. **Stop** frees the split view.

## The next-step page

`/next/` takes its numbers from Studio's own recordings (`featured.json` `facts.execution`, `contact`, `beam`, `doorway`, `deferral_drift`):

- the median distance from the plan body's pelvis to where the robot thinks its pelvis is, over walking frames;
- the RMS gap over the 29 joints;
- the room where walls are touched most;
- a table per room;
- *One plan. Two trackers.*, where only SONIC's column is measured.

**What stays local.** Research material that is not published, such as Flow's own records and plans, goes on this page only in a local build. Owner decision, 2026-10-22: "Keep them local", until the owner decides otherwise.

- `NEXT_LOCAL=<json> tools/site/build.sh …` copies that file to `data/next-local.json`, and the page renders its sections in a dashed "local build only" block.
- `build.sh` refuses `NEXT_LOCAL` when `CI` is set. The public build writes an empty `{}`.
- `check.mjs` fails if the public build's `data/next-local.json` is not empty or the page shows that block. Give it `NEXT_LOCAL_MARKERS` (comma-separated, from the local file) to also search the public page's text for them.
- The file lives outside the repository, in `~/research-data/g1-deploy-studio/next-local.json`. A local build must never be published.

**The plan body on a public page.** Each walk now carries the reference pose SONIC tracks, at 25 Hz. That shows more of the frozen student planner's output than the pelvis paths did before. The 10-21 decision kept the planner export private, not its recorded outputs, so the site publishes this; the owner should know that it does.

## How the walks are recorded

Each goal is one fresh simulated-robot session, the worker behind Navigate: boot standing at the start mark, a 1 s pre-scan, one goal (checked again by the worker), Go, walk, settle to a stand, End. Settings are the robot's deploy configuration: planner budget K 16 / ODE 10, 160 ms planner latency with predictive anchoring, LIO-level odometry drift, one memory per session, the current G1 actuator limits, seed 0. Goals are the cells of a 0.4 m lattice through the start mark that pass Studio's goal check (unseen goals pass with a warning, as in Studio) and lie at least 0.8 m away. They are recorded in coverage order: every room's 0.8 m sub-lattice first, then its centres (a checkerboard), then the rest, so a partial batch still covers every room.

Rooms: the three Flow development arenas (wall detour, alternating walls, corridor with an overhead beam) and two Studio arenas (`tools/site/worlds/`). The doorway room is Studio's offset-doorway demo rebuilt as a 2 m wall across the whole room, running past the edge of the planner's 12 × 12 m memory, with one 1 m door. Two earlier versions were walked around: the arena's 1.8 m walls (the independent review found every far-side walk went round them) and walls to |y| = 5 m with a 0.8 m door (the verification found the same; with the route's 0.35 m margin a 0.8 m door leaves no route through). With the 1 m door, 95 of 96 far-side goal-check routes use the door. The earlier recordings are kept outside the site.

```bash
tools/site/record_all.sh ~/research-data/g1-deploy-studio/site-recordings 6 2   # resumable; nice 19, 2 threads per worker; max level
.venv/bin/python -m tools.site.export --recordings ~/research-data/g1-deploy-studio/site-recordings --out <site-data>
.venv/bin/python -m tools.site.export_robot --out <site-data> && node tools/site/meshes.mjs <site-data>
tools/site/build.sh _site <site-data> <media> && python3 -m http.server -b 127.0.0.1 -d _site 8811
SITE_URL=http://127.0.0.1:8811/ node tools/site/shots.mjs site/assets <media> docs/img   # posters, link preview, findings stills
SITE_URL=http://127.0.0.1:8811/ SITE_EVIDENCE=<dir> node tools/site/check.mjs           # browser acceptance, desktop and phone
```

To stop a batch, send the recorder SIGTERM or press Ctrl-C. Queued goals then start no worker, running workers are terminated and the room loop exits. Nothing half-walked is marked done, so the same command resumes it.

The worker records the planner's memory as display codes at every 1 s snapshot when the request sets `record_grids`; this is off by default, and Studio never sets it. The exporter:

- keeps every second 20 ms tick (25 Hz);
- quantizes positions to millimetres and angles to milliradians;
- keeps up to 400 LiDAR returns per snapshot;
- stores the map as changes from the start map, which it checks is identical in every session of a room.

## Data format

`data/worlds.json` lists the rooms. Each room entry has:

- its outcome and grade counts;
- `list`: every walk as one row of `list_fields` (id, grade, metres from the start, max contact, final distance by truth, duration, and the goal's x and y), with the room's start pose, for the room menu and the chart.

Per room, `data/<room>/index.json` holds:

- the boxes (simulation truth, drawn as a ghost);
- the start mark and pose;
- the map at the start (`codes` and `height_cm`, base64 bytes, row-major `[i, j]` with i along x);
- every grid cell with its six check statuses (`s`: p/w/b per check in `check_ids` order; `l`: the labels that are not pass; `path`: the route the check found);
- a summary of every recorded walk.

`data/<room>/g/<cell>.json` is one walk (schema 2):

- `time`;
- `q`: per frame x y z in mm, quaternion w x y z × 10⁴, and the 29 joint angles in mrad, in the model's qpos order;
- `ref`: the reference SONIC tracks at that frame (row 0 of its window), in the same layout, or `null` where none was recorded. Its root is the planner's, in the planner's frame, and SONIC never receives it; `ref_basis` says so;
- `contact_n`: the peak obstacle contact over the 20 ms ticks the frame stands for, so the 25 Hz frames never hide a peak;
- `est`: the LIO-level estimate, in mm;
- `phases`;
- `plans`: the pelvis path in cm, and its height;
- `plan_starts`: when each plan began driving the robot;
- `lidar`;
- `map`: `g`, gaps between flat cell indices, and `v`, the code, or code × 1000 + height in cm for codes 2–4;
- `events`, the outcome and the distances.

`data/featured.json` holds:

- `examples`: each finding's example walk and the moment it is about (`at`);
- `facts`: the measured numbers;
- `closer`: the split-view scenarios.

`media/stills/<finding>.jpg` are rendered from the demo by `shots.mjs`.

## Hosting and performance

- **Where:** GitHub Pages, from `.github/workflows/pages.yml`. The page source is in `site/`. The data, the stills and the video are not in Git (AGENTS.md: no recordings in Git). They are release assets of the tag in `tools/site/release.json`; the workflow downloads them and checks their SHA-256. `tools/site/package.sh` makes them.
- **What a visit costs:**
  - Until something starts: text, two posters, the tour's poster and captions, `worlds.json` and `featured.json`, and once the page is idle the robot day's room. About 0.3 MB compressed.
  - **Start:** three.js (about 170 kB compressed), the robot (0.75 MB: 36 Unitree meshes simplified from 371k to 85k triangles and quantized) and a room. A progress card shows the download.
  - About 60 kB per walk played. Findings stills load as they near the viewport. The video loads only when played.
- **Rendering:**
  - Frames are drawn only when something changed: a walk playing, or the camera moving. The loop stops when idle or scrolled away.
  - Pixel ratio is capped at 1.75 and at about 3.5 million drawn pixels, which matters on a full-screen stage. There is one 1024² shadow map, and the map's obstacle cells are one instanced mesh.
  - The split view renders both halves from one canvas with scissor rectangles, not two WebGL contexts.
  - The robot day's 2D view is a canvas.
- **This machine:** serves nothing for the site. Recording is a one-time batch at the lowest CPU priority.

## Updating

1. Record or re-export, and render the stills into the media folder.
2. Run `tools/site/package.sh <site-data> <media> <dir> site-vN`.
3. Create the release with the two archives.
4. Update `tools/site/release.json` and push to `main`.

A change to `site/` alone redeploys with the same data.

| Release | Date | Walks | Coverage | Archives |
|---|---|---|---|---|
| `site-v1` | 2026-10-21 | 415: wall detour 107, alternating walls 106, corridor 66, doorway 72, cluttered room 64 | Levels 0 and 1 in the first two rooms, level 0 in the others | data 17 MB (61 MB unpacked, with the mesh licence and NOTICE), media 25 MB |
| `site-v2` | 2026-10-22 | 473: wall detour 107, alternating walls 106, corridor 124, doorway 72, cluttered room 64 | Levels 0 and 1 in the first three rooms, level 0 in the others. Schema 2: every walk carries the plan body; rooms list their walks; split-view scenarios; findings stills | data 24 MB (76 MB unpacked), media 25 MB (with the stills) |
| `site-v3` | 2026-10-22 | the same 473 | as `site-v2` | Contact per frame is the peak over the ticks it stands for. Walk rows carry the goal's x, y and rooms their start pose, for the room menu's directions and the chart | data 24 MB, media 25 MB (unchanged) |
| `site-v4` | 2026-10-22 | the same 473 | as `site-v2` | The data of `site-v3`, byte for byte. The findings stills are rendered again on the white stage | data 24 MB (unchanged), media 25 MB |

The batch can keep recording the remaining levels at the lowest priority for a later release. Nothing on the published site changes until `tools/site/release.json` names a new tag.
