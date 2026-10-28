# Deploy: the robot workflow in Studio

**Status (2026-10-28): the gateway side is built and tested against `tools/fake_deploy_hub.py` only.** Nothing in
Deploy has run against the deploy kit's real deploy service or a robot yet. The robot has walked under the deploy kit's
console (robot days 2026-10-24 and 2026-10-27), not under Studio. The page (`apps/web`) is built against the endpoints
below.

Deploy is the workspace where an operator takes the robot from a scan of the room to a walk and its evidence: Connect,
Scan, Goal, Rehearse, Deploy, Review, with a Readiness panel that stays on screen. It replaces the deploy kit's hub page
as the place to work; that page stays reachable at the kit's `/legacy`.

## 1. The seam

```text
Browser (Studio page, loopback or SSH tunnel)
   │  same-origin HTTP; no token of the kit ever reaches it
Studio gateway (studio/server.py + studio/deploy_link.py, 127.0.0.1 / ::1)
   │  allowlisted proxy, ?t=TOKEN                     │ E-STOP, Stand, Takeover: straight to each console's panel
Deploy service (the kit: ./g1 lab --headless, API v1) │
   │  starts and adopts sessions, scans, rehearsals   │
Console (one per session: robot slot, sim slot) ◄─────┘  every gate; the only process that drives the robot
   ├─ SONIC runner ─► rt/lowcmd (the only motor writer)
   └─ planner node (its view is polled by the deploy service at 5 Hz for the live 3D)
```

- **The deploy kit owns every process and every gate.** Its console runs the SONIC runner and the planner node and
  decides whether a press is accepted. Its deploy service starts sessions, scans and rehearsals and serves their data.
- **Studio owns the experience:** the page, the 3D scene, the goal check on the scan, the operator lease, and the fast
  path for E-STOP, Stand and Takeover.
- The token (`G1_PANEL_TOKEN`, else `~/.config/g1-deploy/panel_token`) stays in the gateway. Configuration:
  `config/local.json` → `deploy_service: {url, token_file}` (default `http://127.0.0.1:8769`); `G1_DEPLOY_SERVICE`
  overrides the URL. Loopback addresses only; the gateway never uses an HTTP proxy.

## 2. Safety model

- **Studio relays an operator's press to the deploy kit's console, which owns the robot and every gate.** Studio never
  makes up a press. The gateway retries nothing; the page repeats only E-STOP, every 300 ms until every console
  acknowledged.
- **Studio has no DDS participant and no motor path.** It never publishes `rt/lowcmd`, hand commands or ZMQ `pose`. The
  SONIC runner stays the only motor writer.
- **Every gate is the console's.** GO is refused, with a reason, unless SONIC is in CONTROL (not E-STOP) for 2 s, no
  rehearsal holds the machine, the node is ready, a goal was confirmed by the node in this cycle and the 10 s
  Clear-map scan finished. Studio shows the console's reasons (`go_locks`); it does not decide them.
- **E-STOP goes through the console process.** Studio's E-STOP, the phone panel, the remote's Select while the student
  streams and the node's own stops (tilt, stale state) all reach the runner through the console. **Only the physical
  E-stop is independent of the console.** When the console's heartbeat is older than 1 s the page says
  "CONSOLE NOT RESPONDING — use the physical E-stop".
- **One controlling page: the operator lease.** Motion-enabling acts need it (below). The page renews it every second
  and loses it 3 s after the last renewal, so a hidden or closed tab stops controlling. While a Studio page holds it,
  the console refuses GO from the phone panel; the phone's E-STOP, Stand and Takeover always work.
- **A goal is sent only with a fresh check.** `send_goal` needs a `check_id` from Studio's goal check on that scan and
  goal, issued in the last 10 minutes and not blocked. The deploy service then checks the goal again on the live node
  memory in the converted frame.
- **Nothing automatic.** Studio does not stop the robot when its live view goes stale; it greys the robot, locks Arm,
  Send goal and GO, keeps E-STOP, Stand and Takeover live and says "the robot may still be walking".
- **Guards while the kit runs a session.** Navigate's robot link only observes while the deploy service reports a
  robot session: the gateway refuses goal and stand before writing anything, and the link itself refuses them. The
  workbench starts no CPU job (rehearsal runs, suites, Navigate's simulated robot) while any kit session (robot,
  practice, real-time rehearsal) runs. `tools/studio_service.sh release|stop|restart` refuses while a session is live,
  because the gateway carries Deploy's E-STOP; `--force` overrides explicitly and `guard` reports without acting.
  A session the deploy service last reported stays in force while the service cannot be reached.

## 3. Frames

Poses are `[x, y, yaw]` (m, rad); `R(a)` rotates counter-clockwise; "A_from_B" is the pose of B's origin in A.

| Frame | What | Who maps it |
|---|---|---|
| `memory_S` | A scan's memory grid (memory.npz `lo`, `res`); the robot stood at `start_S` (leg odometry with IMU yaw: 1.2-1.4 rad on the lab robot). The scan twin is in this frame. | `scene_from_memory = inverse(start_S)` |
| `scene` | The scan robot frame: `start_S` at the origin, x ahead. A scan's course is in this frame. Every goal crosses the API as `goal_scene [x, y]`. | — |
| `odom_K` | Console K's node odometry (leg: node start with IMU yaw; LIO and fused: the LIO world; a rehearsal: the course frame) | the deploy service: `scene_from_odom` from the start check |

Studio's goal check maps `goal_scene` to `memory_S` with `start_S` and maps its geometry back. The deploy service maps
`goal_scene` to `odom_K` with `inverse(scene_from_odom)` before the console's `goal_odom`. Tests use
`start_S = [0.3, -0.2, 1.2]` and a 20 deg / 0.2 m start offset: an identity transform is not a test of this.

## 4. Gateway endpoints

**GET** (loopback rules as every Studio GET):

| Path | Returns |
|---|---|
| `/api/deploy/state`, `readiness?scan=&slot=`, `scan/live`, `scan/scene?name=`, `live?slot=&cloud_after=&mem_after=`, `rehearsal/track?name=`, `manifest?name=`, `panel?slot=` | The deploy service's answer, re-sanitised to strict JSON (non-finite numbers become null). `state` adds `studio: {estop_targets, hub, lease, refresher}`, also on its 503 when the service cannot be reached. |
| `/api/deploy/link` | `{estop_targets: [{slot, name, mode, practice, port, reachable_token, error, seen_age_s}], hub: {ok, age_s, error, ever_ok}, lease: {holder, until, since} \| null, refresher}`: what the gateway would E-STOP now. No token. |
| `/api/deploy/heartbeat` | `{targets: [{slot, name, ok, console_age_s, latency_ms, error}], t}`: each cached console's `/state` read on the E-STOP's path (not through the deploy service), 0.5 s each; `console_age_s` = now − its `console_t_mono` (one host, one monotonic clock). Above 1 s: CONSOLE NOT RESPONDING. |
| `/api/deploy/model` | `{spec, joint_names[29], source}`: the G1 29-DoF model the console replay uses (`sim/assets/g1_29dof.xml` under the deploy root), meshes served at `/assets/mesh/…`. |
| `/api/deploy/goal_check?scan=&x=&y=` | `{ok, checks[7], straight_m, path_m, path_xy, unknown_fraction, grid, blocking_xy, gap, check_id, check_ttl_s, scan, goal_scene, goal_xy, robot_xy, start_S, frame: "scene"}`. Checks: inside, seen, free, overhead, reachable, distance (studio/goal_check.py, from the scan pose) and `gap`: the narrowest passage along the route between the scan twin's boxes (block below 0.6 m, the robot's width in the checks; warn below 1.0 m). `gap: {width_m, at_xy, sides_xy} \| null`; `blocking_xy`: up to 200 cells behind a block. Geometry in scene. |

**POST with the CSRF token** (`X-Studio-Token`, as every Studio POST):

| Path | Body → reply |
|---|---|
| `/api/deploy/lease` | `{operator, take_over?}` → `{lease_id, holder, until, ttl_s}`; another holder → 409 `{error, holder}` unless `take_over: true` (logged) |
| `/api/deploy/lease/renew` | `{lease_id}` → `{until, holder}`; lost or taken → 409 `{error, holder}` |
| `/api/deploy/lease/release` | `{lease_id}` → `{released}` |
| `/api/deploy/act` | `{act, slot?, lease_id?, id?, expect?, …}` → the deploy service's reply and status. Acts: start, stop, scan, practice_scan, rehearse, start_check, send_goal, doctor (deploy service) and arm, s, c, g, h, t, tag, note (console, through the service). start, stop, scan, practice_scan, rehearse, send_goal, arm, s, c, g need a live `lease_id` (else 409 `need: "lease"`); send_goal needs a valid `check_id` (else 409 `need: "goal_check"`). The gateway sets `source: "studio"`, `operator` (the lease holder) and `id` when missing. |

**POST without the CSRF token** (it changes when the gateway restarts): a loopback Host, `Origin: http://<Host>` and
`X-Studio-Estop: 1`.

| Path | Body → reply |
|---|---|
| `/api/deploy/estop` | `{}` → 200 `{ok, targets: [{slot, name, ok, key_sent, runner_alive, confirmed, latency_ms, error}], t}`. Sent to every console the gateway last knew as live, in parallel, 1 s each; `ok` only when all acknowledged; no target → `ok: false` with the reason. |
| `/api/deploy/direct` | `{slot, act: "h" \| "t"}` → the console's act reply plus `slot`, `latency_ms` (Stand, Takeover on the same path, 1.5 s). |

**Admission.** The gateway serves 12 requests at a time. When they are all taken, a connection gets one of 4 reserve
slots, must send its request line and headers within 1 s, and is served only if it is one of the two paths above;
anything else gets 503. The E-STOP's targets come from a cache (each console's panel port, and its token from the
session's `panel_url.txt`), refreshed whenever the page polls the state and once a second while a Deploy page was
active in the last minute, so a press never waits on the deploy service. A console leaves the cache only when the
deploy service says it is no longer live. Measured on the deploy PC (loopback, the fake console): with the 12 general
slots held and the deploy service stopped, E-STOP is acknowledged in 1.7 ms median, 1.9 ms max (20 presses;
`tests/test_deploy_link.py` asserts under 300 ms).

**Evidence.** The gateway appends every relayed act, lease change, E-STOP and direct press to
`<workbench data root>/deploy/gateway_actions.jsonl`. The kit's `hub_actions.jsonl` and each session's
`console_events.jsonl` are the record of what the robot side did.

## 5. Developing with the fake deploy hub

`tools/fake_deploy_hub.py` stands in for the deploy service and its consoles: a synthetic room (or a real scan with
`--scan-dir`), non-identity frames (`start_S = [0.3, -0.2, 1.2]`, an odometry frame at 0.9 rad, a start 0.2 m and 20 deg
off the scan pose), a kinematic robot behind the console's gates, rehearsal runs, and one panel per console (the robot
slot on `--panel-port`, the sim slot on a free port). Nothing in it talks to a robot, DDS or ZMQ.

```bash
.venv/bin/python tools/fake_deploy_hub.py --port 8779 --panel-port 8780            # the fake deploy service
# config/local.json: "deploy_service": {"url": "http://127.0.0.1:8779"}   (or G1_DEPLOY_SERVICE=...)
G1_PANEL_TOKEN=fake-token .venv/bin/python -m studio.server --port 8792 --data-root /tmp/studio-deploy-dev
```

Never point a development gateway at the service's data root, and never at a live deploy service with a robot session
for development. Tests: `.venv/bin/python -m unittest tests.test_deploy_link` (in-process fake, ephemeral ports).
