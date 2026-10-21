# Navigate: goals on the robot's own map (contract)

**Status: in development (2026-10-21).** This page fixes the contracts shared by the Navigate workspace, the simulated robot (`studio/nav_worker.py`), the real-robot link (`studio/robot_link.py`), goal checks (`studio/goal_check.py`) and scan-to-twin (`studio/twin.py`). The design rationale is in [REAL_WORLD_DEPLOYMENT.md](REAL_WORLD_DEPLOYMENT.md).

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
| `end` | — | Any time | Sim: stand, write the recording, exit. Real: stop the link (nothing is sent to the node) |

Every command produces an entry in `navigation.commands` and an event in the recording.

## 5. Map files and goal checks

**Node dump format** (`node.py --dump-memory`, also used for `memory.npz`): `support` and `ceiling` (n × n float64, NaN = never observed, `ceiling` +inf = observed clear), `lo` (2,), `res` (scalar), `boxes` (JSON string, Flow `memory_boxes`), `stats` (JSON string). Cell `[i, j]` has its centre at `lo + (i, j) * res`, i along x (Flow `sensor_map.py`, `indexing="ij"`).

**Goal check** (`studio.goal_check.check_goal(grid, robot_xy, goal_xy, **options)`) returns `{ok, checks: [{id, status: pass | warn | block, label, detail}], straight_m, path_m, path_xy, unknown_fraction, grid: {basis, res_m, observed_fraction}}`. `ok` means no blocking check. The reachability rule mirrors Flow's `SensorRoute`: occupied = observed support above 0.25 m, inflated by 0.35 m, unseen cells free; Studio additionally reports unseen space on the path, low obstacles and low ceilings near the goal.

## 6. Twin

`studio.twin` turns a map in node dump format into an arena document (boxes plus a start/goal preset) that passes `validate_map` and `validate_presets`. With the true boxes of a simulation it also reports the fit quality.
