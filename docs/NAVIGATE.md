# Navigate: goals on the robot's own map

**Status (2026-10-21): built and validated in simulation; the real-robot link is checked against a protocol fixture, not a robot.** Design rationale: [REAL_WORLD_DEPLOYMENT.md](REAL_WORLD_DEPLOYMENT.md). The second half of this page is the contract between the workspace, the simulated robot (`studio/nav_worker.py`), the real-robot link (`studio/robot_link.py`), goal checks (`studio/goal_check.py`) and scan-to-twin (`studio/twin.py`).

## Using it

**Simulated robot** (no robot, no permissions needed):

1. Open **Navigate** in the left rail. Choose a world (any arena or scene) and a start. The robot only knows the world through its own LiDAR, as on a real site.
2. **Start session.** The robot stands and scans. The floor shows what it has seen: teal floor, amber low obstacles it can step over, red obstacles, purple overhead. Never-seen space stays empty. The true world is hidden; tick *Show the true world* to compare.
3. **Click the map** to place a goal. Studio checks it on the robot's map: inside the map, seen and free, no low ceiling, a path through what it knows, and how much of that path is unseen. A blocked goal cannot be sent.
4. **Send goal**, then **Go**. Watch the plan, the reference SONIC tracks, distance, speed and the timeline. **Stand** settles it to a stand (not an emergency stop).
5. It arrives and stands; simulated time pauses while it waits. Place the next goal: the map keeps everything it saw.
6. **End session.** The recording opens in Replay with every walk. **Make an arena twin** fits boxes to the robot's map and saves them as an arena you can edit, rehearse and print as a build sheet.

Advanced settings: planner budget (quick is about real time on an idle host and slows to 0.4–0.7× as the map grows; the deployed budget is 0.16× idle and as low as 0.03× on a loaded host), planner latency (160 ms is the deploy PC budget, with predictive anchoring), hardware limits (G1 revision), odometry drift (LIO-level or poor) and the map memory: **keep** one memory for the session as node.py does, or **fresh**, cleared at every Go as each evaluated rehearsal starts (see the phantom-ceiling finding below). A session records at most 180 s of motion (about 60 MB); End always ends it, also during a deferred stand, and the recording opens in Replay.

**Real robot** (on the deploy PC, next to the robot, under the operator procedure):

1. Copy `config/robot_link.example.json` to `config/robot_link.json` (ignored by Git). The endpoints are loopback only. `limits.max_goal_distance_m` (default 3 m, the ladder's first walks) caps how far a goal may be.
2. Start the runner and `node.py` with the console **on LIO odometry** (`./g1 robot ... --odom zmq`; the console's default `--odom leg` gives the node a different frame from Studio's, and Studio then refuses goals), and the LIO bridge with `--forward-cloud` so Studio sees the registered LiDAR. Open Navigate, choose **Real robot** and **Connect**.
3. Studio shows the LIO pose (labelled LIO ESTIMATE), the LiDAR and its reconstruction of the map within the planner's 12 × 12 m memory, the plan reference and every stream's age. Without the runner's joint stream the robot is drawn as a pose marker.
4. **The node's goal** is always shown with where it came from: *verified by Studio*, *unverified* (a readback that did not match, or a console `n`) or *not from Studio* (the launch `--goal`). Anything but verified is a red warning: do not press g.
5. Click a goal and **Send goal**. The gateway checks it on the map and refuses it if the check cannot run or blocks (fail closed). The robot link converts it to the node's *ahead, left* command only while the robot has been still for 0.5 s, the node's position matches LIO within 0.1 m, and nothing is in flight; then it reads the goal back from the node's status. A readback off by more than 5 cm is marked unverified: node.py has already applied it and has no command to clear it, so stage a new goal.
6. **Before g on the console** lists what must hold: fresh status and odometry, frames that match, the robot still, the goal verified, inside the memory and the distance limit, no deferred stand. **The operator starts the walk on the console (`g`) or the remote (F1)**; Studio never sends Go. **Stand** asks the node to settle; the remote's D-up and Select, the gantry and the physical E-stop stay with people. A deferred stand (a low ceiling near the robot in the node's map) is shown in red.
7. **End session** stops Studio's link only. The robot session opens in Replay. A link that a previous gateway started is shown as detached and End still stops it.

**Course on a real floor without the link (Phase 0):** in Arena, pick a saved arena and preset, click **Build sheet**, build the course from the sheet, and run the console command it prints.

## 1. One workflow, two robots

| | Simulated robot | Real robot |
|---|---|---|
| Process | `studio/nav_worker.py`, owned by the gateway: MuJoCo + SONIC ONNX + the frozen bundle planner on CPU, with the node's state machine | `studio/robot_link.py`, owned by the gateway: subscribes to the deploy PC's loopback streams and talks to `node.py`'s control socket |
| World frame | `world` (simulator), the robot's estimate is labelled | `odom` (LIO): floor z = 0, yaw 0 = start heading |
| Map | The planner's own `CloudMemory` | Studio's reconstruction from the LIO cloud until the node publishes its memory (U2) |
| Go | The Go button | Never from Studio: `g` on the console or F1 on the remote |

The gateway treats both the same way: a session directory with a live snapshot, a command inbox, a memory file and, at the end, a recording.

## 2. Session directory

```text
<data_root>/jobs/<id>/run/
  latest.json        live snapshot, atomically replaced (schema below)
  memory.npz         the current map in node dump format (§4), atomically replaced
  inbox/NNNNNN.json  operator commands written by the gateway, applied in sequence order
  session.json       the recording, written when the session ends
  result.json        written last: {status, report, error, recording_complete, hardware_enabled}
```

## 3. Live snapshot (`latest.json`)

The existing worker snapshot (`frame`, `perception`, `environment`, `metadata`, `progress`) plus:

```text
kind: "navigation"
robot: "simulated" | "real"
navigation: {
  phase: BOOT | WAIT | PRESCAN | RUN | ARRIVED | STOPPED | ENDED     (node.py phases + BOOT/ENDED)
  standing: bool
  goal: {xy: [x, y], frame_id, seq, staged_at_s} | null
  goal_dist_m: number | null
  legs: [{index, goal_xy, staged_at_s, go_at_s, start_xy, end_s, outcome, duration_s, path_m, final_dist_m,
          max_contact_n, plans}]
  commands: [{seq, cmd, status: applied | rejected, reason, time_s}]     (last 20)
  can: {goal, go, stand, end}                                          (what the operator may do now)
  go_note: string | null                                               (real robot: where Go happens)
  streams: [{id, label, age_s, rate_hz, threshold_s, status: fresh | stale | unavailable}]
  map: {basis, seq, observed_fraction, updated_s}
  check: <the last goal check, §5>
}
```

Real robot only (the robot link adds):

```text
  goal: {..., source: "node status", verification: verified | unverified | external, detail, status: fresh | stale}
  goal_warning: string | null                 (red: do not press g)
  pending_stand: string | null                (inferred: ARRIVED / STOPPED with the node's standing false)
  memory: {origin_xy, half_extent_m: 6, basis: "ASSUMED: ..."}   (the planner memory's square, drawn on the map)
  ready: [{id, label, status, detail}], ready_ok   (node_status, odometry, frame, still, goal_verified, goal_range, stand)
  can_reasons: {goal, go, stand, end}         (why an action is not possible now)
  still, frame_check, limits, walks, arrived, motion_s, phase_status
```

Frames keep the replay frame format and carry `navigation: {phase, walk, goal_xy}`. A real-robot frame without measured joints has `joints: null` and `qpos: null` (the robot is drawn as a LIO pose marker); its velocity is `linear_velocity_w`. Missing data is never filled with zeros.

## 4. Commands

The gateway assigns `seq` (strictly increasing) and writes `inbox/NNNNNN.json` atomically: `{seq, cmd, ...}`.

| Command | Fields | Accepted when | Effect |
|---|---|---|---|
| `goal` | `xy` | The robot stands (WAIT, ARRIVED, STOPPED) and the goal check has no blocking result | Stages the goal (sim); robot: sends `{"cmd":"goal","ahead","left"}` from the current odom pose, then reads it back from the node's status (≤ 5 cm or rejected) |
| `go` | — | Sim: a staged goal, robot standing. Real: always rejected with `go_note` | PRESCAN → RUN |
| `stand` | — | PRESCAN or RUN | Settle to stand (deferred near low ceilings, as in node.py). Not an emergency stop |
| `takeover` | — | Sim only, while walking or with a deferred stand | The remote's D-up: stand now, ignoring the deferral. Real robot: refused (use the remote) |
| `clear` | — | Sim only, a staged goal | Unstage it. Real robot: refused (node.py has no clear) |
| `end` | — | Any time | Sim: stand, write the recording, exit. Real: stop the link (nothing is sent to the node) |

For the real robot the gateway checks a goal on the link's map before writing it to the inbox and refuses it when the check blocks or cannot run; the link refuses any goal without `check.ok` true. The link also requires fresh odometry (≤ 0.1 s) and node status (≤ 1.5 s), a still robot, matching frames and no command in flight before it sends a goal; Stand is sent on the last known phase. Before the first status the phase is `null`; when the status goes stale the last phase is kept with `phase_status: "stale"`.

Every command produces an entry in `navigation.commands` and an event in the recording.

## 5. Map files and goal checks

**Node dump format** (`node.py --dump-memory`, also used for `memory.npz`): `support` and `ceiling` (n × n float64, NaN = never observed, `ceiling` +inf = observed clear), `lo` (2,), `res` (scalar), `boxes` (JSON string, Flow `memory_boxes`), `stats` (JSON string). Cell `[i, j]` has its centre at `lo + (i, j) * res`, i along x (Flow `sensor_map.py`, `indexing="ij"`).

**Goal check** (`studio.goal_check.check_goal(grid, robot_xy, goal_xy, **options)`) returns `{ok, checks: [{id, status: pass | warn | block, label, detail}], straight_m, path_m, path_xy, unknown_fraction, grid: {basis, res_m, observed_fraction}}`. `ok` means no blocking check. The six checks, always in this order:

| Check | Block | Warn |
|---|---|---|
| inside | outside the grid or within 0.5 m of its edge | — |
| seen | — | goal cell or most of its arrival disc never observed |
| free | an obstacle above 0.25 m within the robot radius (0.30 m) | inside the route's 0.35 m margin, or a low obstacle (0.05–0.25 m) |
| overhead | a ceiling below 1.35 m within node.py's `ceiling_near` window (0.8 m): the node would defer its stand | — |
| reachable | no route | over 30 % of the route crosses never-observed cells; start escaped from occupancy |
| distance | — | beyond `max_distance_m` when set |

Reachability is Flow's `SensorRoute` exactly: occupied = observed support above 0.25 m, dilated by a 0.35 m disc, never-observed cells within 0.1 m of a seen obstacle also occupied (`grow_unknown_m`, the node's configuration), other unseen cells free. It was compared with the scipy source on 25 recorded node dumps (200 routes in the development comparison, no mismatch; the repository's opt-in test checks 50).

**A finding from these checks (2026-10-21).** The source perception (`CloudMemory`) can file the top edge of an obstacle 0.8–1.35 m tall (a 1.0 m pillar in simulation; 0.83–0.96 m cells in the recorded `g5-dds/detour-100` run) as an overhead ceiling. node.py then defers its stand next to it, and when the current plan runs out the robot holds the plan's last pose. In simulation it leaned on the pillar (107 N) and drifted about 1 m over 70 s before the stand was issued. Studio blocks goals there, explains a deferred stand and, for the simulated robot, offers the remote's takeover. On a real course, tables and boxes in that height range need the same care; the deploy repository owns the fix.

**A second finding (validation, 2026-10-21): phantom ceilings from the robot's own body.** In long sessions the planner memory gains ceiling cells at 0.88–1.27 m within about 0.2 m of where the robot stood or walked, also in empty worlds (14–19 cells on flat ground). They are self-returns from the arms that escape the self-filter (3 cm capsule margin, 4 cm for hands) through range noise, and a single high return is enough to make an overhead cell (the solid rule needs three low returns; the overhead rule needs none). Because the memory never forgets, they accumulate. The validation saw false goal refusals, stalls (`stop_max_clearance`), deferred stands and falls without contact next to them; with fresh memory the same walks fell 0 of 4 times instead of 3 of 4. node.py keeps one memory per process on the robot too, so this needs the deploy repository's attention (a minimum count for overhead cells, a wider hand margin, or decay). Studio exposes it, explains deferrals, and offers the **fresh** map mode for comparison.

## 6. Twin

`studio.twin` turns a map in node dump format into an arena document (boxes plus a start/goal preset) that passes `validate_map` and `validate_presets`. With the true boxes of a simulation it also reports the fit quality.
