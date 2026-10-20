# G1 Deploy Studio

A local cockpit for rehearsing Unitree G1 navigation policies before deployment. You can:
- build a navigation arena (walls, overhead beams, start/goal presets);
- run a pinned policy profile in an isolated CPU simulation (Flow planner → SONIC ONNX tracker → MuJoCo);
- watch it live, replay it causally with synchronized sensors, model boundaries and timing, and compare runs.

Recorded SONIC/MuJoCo and C++/DDS rehearsals and ZMQ captures replay through the same timeline.

**Hardware stays disabled.** Studio has no robot connection, DDS participant or motor-command path. It never publishes `rt/lowcmd`, hand commands or ZMQ `pose`, and never connects to the planner node control port. A simulation result is not hardware readiness.

## Open it

The gateway runs as a durable user service on loopback:

```bash
cd /home/linjiw/code/g1-deploy-studio
tools/studio_service.sh status        # served commit + unit state
```

Open **http://127.0.0.1:8790/**. From another computer, use an SSH tunnel: `ssh -N -L 8790:127.0.0.1:8790 <user>@<host>`, then open `http://localhost:8790/`. See [service and access](docs/SERVICE.md).

First-time setup on a new machine:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && npm ci
.venv/bin/python tools/build_policy_bundle.py   # pins the adopted Flow WX-RF block (read-only to Flow)
tools/studio_service.sh install                 # release worktree + systemd --user unit
```

## Workspaces

| Rail | What it is for |
|---|---|
| **Replay** | The 3D twin, fitted to the scene for navigation runs. Pinned transport with tick stepping, plus a timeline whose lanes show events, goal distance, planner compute against the 160 ms deploy replan budget, SONIC inference against the 20 ms tick, tracking RMSE, and obstacle contact against the collision threshold. Cameras: Orbit (auto-recenters during playback), Follow, Top, Fit, and a **Robot view** inset from the LiDAR mount. A HUD shows goal distance, speed, tilt, contact, plan rule and execution check. The inspector has Intent, Joints, Health, Map, Pipeline, Graph and Source tabs. |
| **Arena** | Top-down editor. Draw walls and overhead beams, place pillars, and drag, resize or rotate boxes. Drag the start, its heading tip, and the goal. Templates: corridor, doorway, slalom, overhead beam, U-trap, seeded clutter. Up to 16 named start/goal presets, with the server's standing-footprint preflight shown live. Earlier runs on the arena are overlaid. Saved arenas are immutable and hashed; JSON import/export is supported. |
| **Rehearse** | Pick a **policy profile**, an arena and a preset, then the success criterion (*arrive & hold* or *reach*), duration, seed and K/ODE budget. Run one preset, or a **suite** (every preset × up to 4 seeds) through the single owned worker. The live run attaches to the viewport; when it finishes, its recording opens. |
| **Runs** | Every rehearsal with outcome, policy, budget, goal distance, contact and planner p95, filterable, with per-policy goal counts. Selected trajectories are overlaid on their arena, colored by outcome or by policy. |
| **Sensors** | What the robot perceives at the cursor: raw and self-filtered ray LiDAR, support and ceiling maps, IMU, joints, contacts. Missing channels stay listed with the reason. Pin up to three views; point clouds overlay the 3D scene. |
| **System** | The deployment chain (sensors → perception → route → Flow → reference → SONIC → PD → robot), drawn per source with DDS, ZMQ and in-process edges styled as observed, configured or not exercised. It also shows the source-verified **Unitree G1 contract**: the joint table in motor, MuJoCo and IsaacLab order with gains and limits per source, DDS topics, safety thresholds, and 15 source discrepancies to resolve before hardware. |

Every value carries an evidence chip: MEASURED, SIM-TRUTH, ESTIMATED, COMMANDED, CONFIGURED, OBSERVED, RECORDED or UNAVAILABLE. Unavailable values are never shown as healthy zeros. Press **?** for keyboard shortcuts. A view link restores the run, time, panel, camera, pins, speed and loop.

## Policies

| Profile | Planner | Notes |
|---|---|---|
| `flow-wx-rf-23326aa-s0` | **Flow WX, retrieval-free**: the block `flow/research/BEST_MODEL.md` names as adopted (2026-10-16). Pinned at Flow `23326aa`, config `closed_loop_wxr0_c3.json` (sha `1ffc4069…`), teacher `sk1_s0`, WM-v2 execution check | Flow's own closed-loop callback on MuJoCo. Privileged: plans from the exact boxes, not LiDAR. Default budget K8/ODE6 (evaluated 16/10) |
| `flow-bundle-20261008` | Frozen g1-student-deploy bundle (student s2-kcsc) | LiDAR-driven sensor route through `sim.lockstep` |

Details, caveats and how to add a policy: [docs/POLICIES.md](docs/POLICIES.md). Rehearse shows the Flow research sync status and pins the identity hash into every scenario and run.

## Verify

```bash
.venv/bin/python -m unittest discover -s tests -v       # unit + integration (no policy runtime needed)
python3 tools/check_references.py                        # read-only reference drift check
.venv/bin/python tools/build_policy_bundle.py --verify-only
STUDIO_URL=http://127.0.0.1:8790 npm run test:browser            # read-only UI acceptance (FK parity, honesty checks, mobile)
STUDIO_URL=http://127.0.0.1:8790 npm run test:browser:forwarded  # same through a Host-preserving tunnel
STUDIO_URL=http://127.0.0.1:8791 npm run test:rehearsal          # launches real bounded CPU runs via the UI
```

Browser tests need Chromium (`CHROME_PATH`, default `/opt/google/chrome/chrome`). Evidence and screenshots are written under `~/research-data/g1-deploy-studio/evidence/`, outside Git. See [acceptance](docs/ACCEPTANCE.md).

## Recordings, capture and export

`config/sessions.json` registers the demonstrated recordings. For other local recordings, create `config/local.json` (ignored) with the same structure and pass `--config config/local.json`. An entry is a recording directory, a Studio `.mcap`, or a single-endpoint `pose` recorder `.jsonl`, plus an optional `environment_path` boxes file. Fresh rehearsals are stored under `~/research-data/g1-deploy-studio/workbench/jobs` and survive restarts.

```bash
# Subscription-only loopback ZMQ capture (never launches a producer or opens DDS):
.venv/bin/python -m studio.recorder --endpoint tcp://127.0.0.1:5557 --topic g1_debug --output /abs/capture.jsonl --duration 10
# Indexed MCAP export of a replay (exclusive creation):
.venv/bin/python -m studio.export /home/linjiw/code/g1-student-deploy/runs/smoke/__start_stand_ /abs/out.mcap \
  --environment /home/linjiw/code/g1-student-deploy/runs/rt/replay-beams2-101/boxes.json
```

## Guides

[Service and access](docs/SERVICE.md) · [Policies and the WX adapter](docs/POLICIES.md) · [Arena, rehearsal and runs](docs/WORKBENCH.md) · [Unitree G1 contract](docs/ROBOT_CONTRACT.md) · [Model pipeline](docs/MODEL_PIPELINE.md) · [Sensors](docs/SENSORS.md) · [Interfaces](docs/INTERFACES.md) · [Architecture](docs/ARCHITECTURE.md) · [Acceptance evidence](docs/ACCEPTANCE.md) · [Roadmap](docs/ROADMAP.md) · [Agent rules](AGENTS.md)

## Boundaries

Studio integrates the existing deployment stacks read-only and vendors no weights, meshes, recordings or third-party source. Models and meshes are served from their original local paths. ROS 2, Unitree DDS and ZMQ are distinct transports; a ROS graph never shows the ZMQ edges. The C++/DDS real-time rehearsal stays blocked: the SONIC runner hard-codes DDS domain 0, and the host's NVML driver/library mismatch blocks GPU monitoring. Live robot observation requires separate authorization, a safety review and physical E-stop procedures.
