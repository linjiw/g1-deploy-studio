# Real-world navigation with Studio (design)

**Design, 2026-10-21. Nothing on this page has run on a robot.** Built since (same day, simulation and fixture only): Phase 0's build sheet, scan to twin, the simulated robot with goals on its map (Phase 2 in simulation), and the robot link (Phases 1–2, against a protocol fixture). How to use them: [NAVIGATE.md](NAVIGATE.md). Site maps (§5.3) are not built. Every physical run follows the operator procedure in g1-student-deploy (`docs/OPERATOR_GUIDE.md`, `docs/HARDWARE.md`): gantry or spotter, the wireless remote in hand, physical E-stop. Facts about the robot-side stack were read from g1-student-deploy `6a86c86` and are cited by file.

The question this page answers: once a course is built in a real room, how do we use Studio to see what the robot perceives, put a goal on that map, send it to the robot, and watch the policy walk there?

## 1. Where we are

The robot-side stack already exists in g1-student-deploy. When this design was written Studio rehearsed it in simulation and did not connect to it; the robot link (built since, [NAVIGATE.md](NAVIGATE.md)) now does, on the deploy PC.

| Need | Robot side today (g1-student-deploy) | Studio today |
|---|---|---|
| Perception | `g1deploy/node.py` reads the head MID-360 from `rt/utlidar/cloud_livox_mid360`. It deskews, removes the robot's own body and fuses the points into the planner's memory: support and ceiling heights on a 5 cm grid | The simulated ray LiDAR and the planner's memory in CPU rehearsals (Sensors drawer) |
| Robot position | Point-LIO on the robot's LiDAR topics, forwarded by `adapters/ros2_lio_bridge.py` as ZMQ `odom` (bridge untested); leg odometry for walks up to 3 m | Simulator truth only |
| Goal | `--goal-frame start --goal AHEAD LEFT` at launch; console key `n`; control socket `{"cmd":"goal","ahead":x,"left":y}`, relative to the current pose | Start and goal clicked in the arena editor, simulation only |
| Start and stop | Console keys `g` (go), `h` (stand), `t` (SONIC takeover), `o` (damping); remote F1, D-up, Select; the node's own supervisor | None, by design |
| Watching a run | The console's text screen, then logs and a memory dump after the run | 3D replay and live view of simulated runs |

So the pipeline and its frames were designed (ARCHITECTURE: `map → odom → base → head → lidar`; the M5 read-only observation plan). The operator workflow, where you see the robot's map, click a goal on it and watch the robot walk, was not. At the time Studio's rule was that it never connected to the node's control port; on 2026-10-21 the owner decided that it may send a checked goal and a stand, never Go (§11).

Four facts shape the design:

1. **The planner only knows its odometry frame.** The `odom` frame starts where LIO starts. The floor is at z = 0 and yaw 0 is the robot's heading at the start (`ros2_lio_bridge.py`). Every goal must end up as an x, y position in this frame.
2. **The planner's map is local.** The memory is a 12 × 12 m grid (±6 m around the robot's position when the node starts) with 5 cm cells and a 4 m sensor range (Flow `sensor_map.py`, bundle `student.json`). It is created once per node process and keeps everything it saw, so people who walk through stay as obstacles. Goals must lie inside it. A larger area needs a site map (§5.3).
3. **Unitree's own odometry and SLAM do not run in the low-level mode SONIC needs** (G1_PERCEPTION.md §1). That is why the stack runs Point-LIO on the robot's LiDAR topics. The D435i head camera is not used by the planner.
4. **Only the frozen bundle (the LiDAR student) plans from the robot's own perception.** WX-RF plans from exact obstacle boxes, so it cannot run on a real robot until Flow adopts a LiDAR-conditioned block (STATUS open issue 8). Section 5.4 shows how to test it on scanned boxes in simulation meanwhile.

## 2. The operator workflow

| Step | What happens | Status |
|---|---|---|
| 1. Prepare | Calibrate the LiDAR mount and check the streams (`./g1 calibrate`, `./g1 check`) | Exists, robot side |
| 2. Scan | The robot stands and the node pre-scans. Optionally, a slow mapping walk builds a site map | Pre-scan exists; mapping walk is new (§5.3) |
| 3. See | Studio shows the robot, its LiDAR and the planner's map, live | New, Phase 1 |
| 4. Pick | Click a goal on that map; Studio checks it before anything is sent | New, Phase 2 |
| 5. Stage | Studio sends the goal to the node while the robot stands, then reads it back | New, Phase 2, needs approval |
| 6. Go | The operator presses `g` on the node console (the remote's F1 only hands the runner to the node's stream; the node waits for `g`) | Exists |
| 7. Watch | Plan, path, distance to goal and stream health, live. Overrides stay physical (remote D-up, Select) | New, Phase 1 |
| 8. Review | The run opens in replay next to its simulated rehearsal of the same course | New, Phase 0 |

## 3. Where Studio attaches

```text
G1 PC1 (closed)    rt/lowstate 500 Hz · rt/utlidar/cloud_livox_mid360 10 Hz · rt/utlidar/imu 200 Hz   (DDS domain 0, wired)
      │
Deploy PC ─────────────────────────────────────────────────────────────────────────────────────────────
   Point-LIO ─► ros2_lio_bridge ─► ZMQ :5561   odom 50 Hz, registered cloud (--forward-cloud)
   node.py   ─► ZMQ :5556  pose   (plan reference to the runner)        ZMQ :5562 control (REQ/REP)
             ─► JSON events on stdout, --log, --dump-memory at exit
   SONIC runner ─► rt/lowcmd (the only motor writer)                     ─► ZMQ :5557 g1_debug
   Studio service 127.0.0.1:8790 + collector: SUB only, 127.0.0.1:5556 / 5557 / 5561 (+ node telemetry, U2)
      │ SSH tunnel (ssh -N -L 8790:127.0.0.1:8790)
Operator laptop: the browser
```

Every ZMQ producer runs on the deploy PC. Studio's existing recorder only subscribes, only to literal loopback endpoints, and adds no DDS participant, so it can run there unchanged. One review item: the node and the runner bind `tcp://*`, so their streams are reachable from the robot network unless they are bound to loopback (U3).

| Stream | Port | What Studio gets | Label |
|---|---|---|---|
| `odom` | :5561 | Robot pose in `odom`, 50 Hz | LIO estimate |
| `cloud` | :5561 (`--forward-cloud`) | LIO-registered points in `odom`, per scan | LIO cloud (not the planner's self-filtered input) |
| `pose` | :5556 | The reference SONIC tracks: the next 10 frames at 0.1 s | Commanded |
| `g1_debug` | :5557 | Measured joints, motor temperatures, last policy action | Measured |
| Node status, live memory, route, goal | not published | Phase, goal, distance, tilt, latency, the map the planner uses | Needs U2 |
| `--log`, `--dump-memory` | files, after the run | Plans, timing, the planner's final memory and boxes | Planner memory at exit |

## 4. What the live view shows

The live view is the current 3D scene and timeline, fed by the collector instead of a simulator. Each layer keeps its own label, and stale or missing data shows as stale or missing, never as zero.

- **Robot:** the LIO pose (estimate) with the measured joints from `g1_debug`. A trail shows where it has walked. There is no ground truth on a real robot, so no truth overlay.
- **What it sees:** the latest LiDAR scan, fading with age, and the planner's memory: support heights as terrain, ceilings as overhead slabs, unknown cells shaded. Until U2 exists, the live map is Studio's own reconstruction (§5.2), labelled as such.
- **What it intends:** the goal, the arrival radius and the route corridor (U2), plus the reference from the `pose` stream, which is the next second SONIC is told to follow.
- **Health:** stream ages against the source thresholds already in the robot contract (lowstate 500 Hz, LiDAR 10 Hz, odometry 50 Hz), plan age, planner latency against the 160 ms budget, tilt against the 0.75 rad E-stop, the node phase and its events (`estop`, stand, stale LiDAR).

## 5. Maps built from the robot's perception

There are three different maps. Studio must never mix them up, because only the first one is what the policy acts on.

### 5.1 The planner's memory (what the policy uses)

This is the node's `CloudMemory`: self-filtered LiDAR fused into support and ceiling heights, 12 × 12 m, 5 cm. It is the most important layer to show, because a goal is only as good as what the robot has seen around it. Today it is only available at the end of a run (`--dump-memory`: support, ceiling, grid origin, resolution, and the obstacle boxes Flow's `memory_boxes` derives from it). Live display needs U2.

### 5.2 Studio's display map (live, any time)

Studio can build its own map from the LIO cloud and pose: a bounded 5 cm voxel grid with observed and unknown cells, projected to 2D for goal picking. It needs no upstream change. It is labelled **Studio reconstruction; the planner does not use it**, because it skips the planner's self filter and its fusion rules.

### 5.3 A site map (persistent, across sessions)

For a room larger than 12 m, or for goals with names that stay valid across days:

1. **Mapping walk, once.** Walk the robot slowly through the space with SONIC's own planner and the remote, or carry the sensor head through it. LIO saves its point-cloud map (Point-LIO and FAST-LIO both can write a PCD).
2. **Import and annotate in Studio.** Studio stores the site like an arena: a decimated cloud, a 2D occupancy view, named goals ("door", "table"), floor marks for start poses and no-go zones.
3. **Localize every session.** Align the first scans against the site map to get the `map → odom` transform, using scan matching such as GICP or a LIO relocalization mode. Goals are picked in `map` and converted to `odom` before they are sent. Studio shows the alignment quality and refuses goals when it is poor.
4. **The site map never goes to the planner.** The planner keeps planning from its own fresh memory. A stale map must not hide an obstacle that moved.

Candidate tools need a license and version review before anything is installed (CODE_REFERENCES § external references).

### 5.4 Scan to twin: a simulation copy of the real course

This is the feature that connects the real room to everything Studio already does:

1. The robot scans the course (pre-scan or a short walk).
2. Studio fits boxes from the planner's memory with the same rules as Flow's `memory_boxes` (connected occupied cells become one ground box; seen ceilings become overhead slabs).
3. The boxes become a new Studio arena with the robot's real start pose. The operator corrects it in the arena editor.
4. Rehearse the planned goal on the twin at L1, L2 and later L3, with the actuator profile of our robot. The Runs report predicts the outcome before the real run.
5. After the real run, compare it with its rehearsal in the Runs table: path, time, torque, clearance.

The twin also lets us test WX-RF on boxes that came from perception instead of exact ones, which is the question Flow's round ST is studying. That stays a simulation result: a real WX run needs a robot-side node for Flow's callback, which does not exist.

Steps 2–4 can be built and checked now, in simulation: the CPU rehearsals already record the planner's memory from simulated LiDAR, so the fitted twin can be scored against the true arena.

## 6. Assigning goals

### 6.1 Phase 0: a course built from an arena (no new robot interface)

1. Design or pick an arena in Studio and rehearse it.
2. Studio prints a **build sheet**: obstacle positions and sizes measured from a start mark on the floor, the robot's start heading, and the goal as *ahead, left* from the start. *Built (2026-10-21): Arena → **Build sheet**, `/sheet.html`, see WORKBENCH.md §1. Checked in simulation and print only; no course has been built from it yet.*
3. Build the course, stand the robot on the start mark and run the console exactly as today: `./g1 robot --iface eth0 --goal AHEAD LEFT ...`. The console already uses `--goal-frame start`.
4. Afterwards, import the node log, the memory dump and a Studio capture into replay, next to the rehearsal of the same arena. The arena boxes are drawn as "course as designed", and the memory dump shows how well the robot saw them.

Studio sends nothing to the robot in this phase. The build sheet removes guesswork from goal coordinates, and placement error at the start mark is visible in the replay.

### 6.2 Phase 2: click a goal on the live map

**Pick.** The operator clicks a point and a heading on the live map (the planner's memory, or the site map converted to `odom`).

**Check.** Studio checks the goal before staging and shows each result:

| Check | Rule |
|---|---|
| Inside the planner's memory | Within the 12 × 12 m grid, with margin |
| Seen and free | The goal cell and its arrival radius are observed and not occupied (same inflation as the route) |
| Reachable | A path through seen free cells exists; a goal behind unseen space is flagged |
| Within the ladder's limits | For example, 2–3 m and no overhead obstacles at H5 (HARDWARE.md §4) |
| Not in a no-go zone | Site-map annotations |

**Stage.** Only while the robot stands (node phase WAIT, ARRIVED or STOPPED), Studio sends the goal to the node's control socket.

- Today's command is relative to the pose at the moment it is applied. That is accurate only while the robot is not moving, which is why staging is limited to standing.
- Studio then reads the goal back from the node's status and refuses it if it differs from the click by more than 5 cm.
- U1 adds an absolute goal in `odom`, which removes this conversion.

**Go.** In Phase 2, starting a walk stays the operator's action: `g` on the node console. Studio shows "goal staged, waiting for the operator".

### 6.3 Later

- **Retarget while walking.** The node already accepts a new goal mid-run, but this is not rehearsed in the real-time chain.
- **Missions.** A list of waypoints; the next one is staged after ARRIVED.
- **A Studio Go button.** Only with a hold-to-run control and a separate approval.

## 7. Proposed changes in g1-student-deploy (not applied)

These belong to the deploy repository and its owner. Studio would only propose them.

| # | Change | Why |
|---|---|---|
| U1 | `{"cmd":"goal","x":..,"y":..,"frame":"odom"}`, echoed with a sequence number in status and events | A clicked goal lands exactly where it was clicked, also while walking |
| U2 | An optional telemetry PUB (`--telemetry-bind`, loopback): phase, goal, route corridor and the memory's observed cells at 1–2 Hz | Studio shows the map the planner uses, live, without touching the control socket |
| U3 | Bind `:5556` and `:5562` to loopback by default | Nothing on the robot network can send goals or read plans by accident |

Without U1–U3, Phase 0 and Phase 1 still work; Phase 2 uses the stand-only conversion and readback above.

## 7a. Replaying deploy-kit robot sessions

The deploy kit's console (`./g1 robot`, `./g1 sim` on branch `integration` of g1-student-deploy) records every session
with a passive recorder, `g1deploy/recorder.py`, in format `g1deploy.recording.v1`:
- `rec/` holds `meta.json`, `rec/<stream>/NNNNNN.npz` chunks (`lowstate` at 1 kHz, `lowcmd`, raw lidar, `zmq_odom`, ...)
  and `node_status.jsonl`;
- next to it sit `session.json`, `node.log` and `node_plans.json`.

Studio replays these sessions read-only. Copy or link a session directory, or a robot-day directory of sessions, into
`<data root>/robot-sessions/`. Replay lists it under **Robot sessions (deploy kit)**, with evidence level **M4 ·
recorded real robot session**.

- **Joints:** measured, from `rt/lowstate` `q`, with duplicate samples dropped.
- **Pose:** an estimate. It comes from the LIO bridge (`rec/zmq_odom`) when recorded, else from the node's own status
  at 5 Hz (xy, FK pelvis height and heading), interpolated. Tilt always comes from the pelvis IMU.
  `metadata.pose_basis` says which.
- **Timeline:** node events from `node.log`; plans from `node_plans.json`, timed from `node_up` + tick × 20 ms; the
  node's phase and goal per frame.
- **Map:** the node's final memory when the session dumped one (`node_memory.npz`).
- **Not shown:** the recorded lidar (raw sensor frame), `rt/lowcmd`, ground truth and contact forces. A real robot has
  no ground truth or contact measurement.

The reader is Studio's own, numpy only (`studio/replay.py` `_console`). It follows `g1deploy/recording.py`; Studio
imports no deploy code and opens no DDS participant to replay a session. Browser check:
`tools/browser/validation/replay_robot_session.mjs`.

## 8. Safety rules for robot mode

- Studio never writes `rt/lowcmd` or hand commands and never creates a DDS writer. The SONIC runner stays the only motor writer.
- The remote, the physical E-stop and the gantry or spotter stay with people. A Studio "stand" request, if it is ever added, is labelled *not an emergency stop*.
- Studio stages goals only while the robot stands (Phase 2). The node's supervisor stays the authority: tilt E-stop, stale-state E-stop, stand on LiDAR loss.
- Closing the browser or losing the tunnel changes nothing on the robot. This is tested before any robot step, as M5 already requires.
- Every staged goal is logged with the operator, time, the check results and the readback.
- Each phase is a separate authorization, mapped onto the robot ladder: observation from H1, Phase 0 courses at H5 (open floor) and H6 (ground obstacles), goal staging only after a successful H5 with console goals.

## 9. Rehearse the whole workflow first

The L3 chain (`tools/l3_rehearsal.sh`) runs the same `node.py`, with the same pose stream and control socket, against a simulated G1 whose MID-360 publishes on the robot's real DDS topic. So the live view, the goal checks, staging and readback can be built and accepted against L3 before the robot, on the same ports and commands. Only odometry differs: simulator truth instead of LIO, which an odometry-noise option can approximate. L3's first run still needs the operator command in STATUS open issue 1.

## 10. Build plan

| Phase | What | Approval | Accepted when |
|---|---|---|---|
| 0 | Build sheet from an arena; import of node log, memory dump and capture into replay | None (simulation, files) | An L3 run's outputs open in replay next to their L1 rehearsal |
| Twin | Boxes from the planner's memory → arena → rehearsal | None (simulation) | Twins of recorded simulation runs match the true arenas; rehearsal outcomes on twin and original are compared |
| 1 | Live view from the collector: pose, cloud, Studio display map, reference, health | Robot: the M5 safety review; development: none (against L3) | Ages and stale states correct on L3; closing the browser or tunnel leaves the chain unaffected |
| 2 | Goal picking, checks, staging, readback | Your decision on the control socket; U1–U3 with the deploy repo's owner | On L3: click → readback → operator Go → arrival; every refusal case covered |
| 3 | Site map, localization, named goals, missions | License review of the mapping tools; robot sessions | A goal named on the site map is reached on two different days |

## 11. Decisions needed

1. **Control socket.** Decided 2026-10-21: Studio may send `status`, a checked `goal` and `stand`; never `go` or `quit`.
2. **Deploy-repo changes.** May we propose U1–U3 to g1-student-deploy's owner? We would not edit that repository ourselves.
3. **Policy for real runs.** The bundle (LiDAR student) is the only policy that runs on the robot's own perception today. WX-RF waits for a LiDAR-conditioned block from Flow.
4. **First real course.** Its size (inside the 12 × 12 m memory), its obstacles, and confirmation that nothing is overhead until H7.
