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

Advanced settings: planner budget (quick is about real time on this CPU; the deployed budget is about 0.15× real time), planner latency (160 ms is the deploy PC budget, with predictive anchoring), hardware limits (G1 revision) and odometry drift (LIO-level or poor).

**Real robot** (on the deploy PC, next to the robot, under the operator procedure):

1. Copy `config/robot_link.example.json` to `config/robot_link.json` (ignored by Git). The endpoints are loopback only.
2. Start the runner, `node.py` and the LIO bridge with the console as usual (`./g1 robot ...`), then open Navigate, choose **Real robot** and **Connect**.
3. Studio shows the LIO pose, the LiDAR and its reconstruction of the map, the plan reference and every stream's age. Click a goal and **Send goal**. Studio converts it to the node's *ahead, left* command while the robot stands and reads it back from the node (within 5 cm, or it is refused).
4. **Start the walk on the console (`g`) or the remote (F1).** Studio never sends Go. **Stand** asks the node to settle; the remote's D-up and Select, the gantry and the physical E-stop stay with people.
5. **End session** stops Studio's link only. The robot session opens in Replay.

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

Frames keep the replay frame format. A real-robot frame without measured joints has `joints: null`; missing data is never filled with zeros.

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

For the real robot the gateway checks a goal on the link's map before writing it to the inbox; a blocked goal is refused there and never reaches the node. The link also requires fresh odometry (≤ 0.1 s) and node status (≤ 1.5 s) and no command in flight before it sends anything; phase and standing are `null` while the node's status is unknown.

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

Reachability is Flow's `SensorRoute` exactly: occupied = observed support above 0.25 m, dilated by a 0.35 m disc, never-observed cells within 0.1 m of a seen obstacle also occupied (`grow_unknown_m`, the node's configuration), other unseen cells free. It was compared with the scipy source on 25 recorded node dumps (200 routes, no mismatch).

**A finding from these checks (2026-10-21).** The source perception (`CloudMemory`) can file the top edge of an obstacle 0.8–1.35 m tall (a 1.0 m pillar in simulation; 0.83–0.96 m cells in the recorded `g5-dds/detour-100` run) as an overhead ceiling. node.py then defers its stand next to it, and when the current plan runs out the robot holds the plan's last pose. In simulation it leaned on the pillar (107 N) and drifted about 1 m over 70 s before the stand was issued. Studio blocks goals there, explains a deferred stand and, for the simulated robot, offers the remote's takeover. On a real course, tables and boxes in that height range need the same care; the deploy repository owns the fix.

## 6. Twin

`studio.twin` turns a map in node dump format into an arena document (boxes plus a start/goal preset) that passes `validate_map` and `validate_presets`. With the true boxes of a simulation it also reports the fit quality.
