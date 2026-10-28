# Deploy: the robot workflow in Studio

**Status (2026-10-28).** Practice was verified end to end on the real chain on 2026-10-28: Studio's page and gateway
drove the deploy kit's real deploy service and console with the simulated robot, from a practice scan to a walk and
its review. **Robot hardware has not run under Studio yet**; the robot has walked under the deploy kit's console (robot
days 2026-10-24 and 2026-10-27). The contract v3 additions below (after an external review of the Deploy workspace:
session receipts, rehearsal identity, freshness, uncertain acts, Review, profile goal checks, recording health) are
built and tested in the gateway against `tools/fake_deploy_hub.py` and against replies recorded from the kit's real
deploy service (`tests/fixtures/deploy_v1`); the kit's side of v3 is being built. Until a kit has a v3 capability, the
gateway answers that endpoint with `{supported: false, capability}` instead of guessing.

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

## 2. Decisions

The review asked the operators to decide these; they are encoded centrally and can be revised.

| Question | Decision |
|---|---|
| Rehearsal advisory or required? | Robot sessions: GO needs a matching **complete** rehearsal set (`/api/deploy/rehearsal/match`), or an explicit operator override that is recorded with the attempt. Practice: advisory. |
| Task success for gap and door trials | In the Goal step the operator may mark "must pass through this gap" (offered when the goal check finds a passage under 1.0 m on the straight line or the route). Rehearsal runs and real attempts are then scored on the passage as well as on arrival: a detour around the gap is no task pass. |
| A second browser | A read-only viewer by default: it sees everything and holds no lease. Taking control is an explicit, logged takeover. |
| Mandatory streams | Robot: lowstate, lowcmd, lidar_raw, node_status, node_events, plans, console_events, attempts, plus lio_odom and lio_cloud when the odometry is zmq or fused. Practice: the same (LIO streams for zmq, fused, lio); rehearsals add the simulator's truth. Optional: video, runner_log, report (written at the end). |
| Retention | Not decided here (left to the user). |

## 3. Safety model

- **Studio relays an operator's press to the deploy kit's console, which owns the robot and every gate.** Studio never
  makes up a press. The gateway retries nothing; the page repeats only E-STOP, every 300 ms until every console
  acknowledged.
- **Studio has no DDS participant and no motor path.** It never publishes `rt/lowcmd`, hand commands or ZMQ `pose`. The
  SONIC runner stays the only motor writer.
- **Every gate is the console's.** GO is refused, with a reason, unless SONIC is in CONTROL (not E-STOP) for 2 s, no
  rehearsal holds the machine, the node is ready, a goal was confirmed by the node in this cycle and the 10 s
  Clear-map scan finished. Studio shows the console's reasons (`go_locks`); it does not decide them.
- **E-STOP goes through the console process.** Studio's E-STOP, Stand and Takeover go from the gateway straight to
  each live console's panel, not through the deploy service, so they work while the deploy service is down. They still
  need the console process: Studio's E-STOP, the phone panel, the remote's Select while the student streams and the
  node's own stops (tilt, stale state) all reach the runner through the console. If the console hangs, none of them can
  stop the robot. **Only the physical E-stop is independent of the console.** The page polls the console heartbeat
  once a second on that same direct path; when it is older than 1 s or cannot be measured the page says
  "CONSOLE NOT RESPONDING — use the physical E-stop".
- **Freshness locks motion, never stops.** Each source (deploy service state, console heartbeat, panel, node view,
  lidar, map, plan, recorder) is aged from when it was received plus the age the source reported. Arm, Start SONIC,
  Clear map, Send goal and GO lock while a source they depend on is stale (console and node view > 1 s; panel and
  deploy service > 3 s) or unknown. E-STOP, Stand and Takeover are never locked by staleness.
- **An unacknowledged press is "unknown", not "refused".** When the reply to a relayed act is lost (a timeout, a
  closed connection, the deploy service's 502 "panel unreachable"), the gateway answers 202 `{state: "unknown"}`. It is
  never sent again; the page reads the console's own record of that act id instead.
- **One controlling page: the operator lease.** Motion-enabling acts need it (below). The page renews it every second
  and loses it 3 s after the last renewal, so a hidden or closed tab stops controlling. While a Studio page holds it,
  the console refuses GO from the phone panel; the phone's E-STOP, Stand and Takeover always work.
- **A goal is sent only with a fresh check of the session's profile.** `send_goal` needs a `check_id` from Studio's goal
  check on that scan and goal, issued in the last 10 minutes, not blocked, on the scan's memory as it is now, and made
  with the route configuration of the profile the live session runs (its receipt's profile sha). The gateway refuses
  anything else with the reason. The deploy service then checks the goal again on the live node memory in the
  converted frame.
- **Nothing automatic.** Studio does not stop the robot when its live view goes stale; it greys the robot, locks Arm,
  Send goal and GO, keeps E-STOP, Stand and Takeover live and says "the robot may still be walking".
- **Guards while the kit runs a session.** Navigate's robot link only observes while the deploy service reports a
  robot session: the gateway refuses goal and stand before writing anything, and the link itself refuses them. The
  workbench starts no CPU job (rehearsal runs, suites, Navigate's simulated robot) while any kit session (robot,
  practice, real-time rehearsal) runs. `tools/studio_service.sh release|stop|restart` refuses while a session is live,
  because the gateway carries Deploy's E-STOP; `--force` overrides explicitly and `guard` reports without acting.
  A session the deploy service last reported stays in force while the service cannot be reached.

## 4. Frames

Poses are `[x, y, yaw]` (m, rad); `R(a)` rotates counter-clockwise; "A_from_B" is the pose of B's origin in A.

| Frame | What | Who maps it |
|---|---|---|
| `memory_S` | A scan's memory grid (memory.npz `lo`, `res`); the robot stood at `start_S` (leg odometry with IMU yaw: 1.2-1.4 rad on the lab robot). The scan twin is in this frame. | `scene_from_memory = inverse(start_S)` |
| `scene` | The scan robot frame: `start_S` at the origin, x ahead. A scan's course is in this frame. Every goal crosses the API as `goal_scene [x, y]`. | — |
| `odom_K` | Console K's node odometry (leg: node start with IMU yaw; LIO and fused: the LIO world; a rehearsal: the course frame) | the deploy service: `scene_from_odom` from the start check |

Studio's goal check maps `goal_scene` to `memory_S` with `start_S` and maps its geometry back. The deploy service maps
`goal_scene` to `odom_K` with `inverse(scene_from_odom)` before the console's `goal_odom`. Tests use
`start_S = [0.3, -0.2, 1.2]` and a 20 deg / 0.2 m start offset: an identity transform is not a test of this.

## 5. Gateway endpoints

**GET** (loopback rules as every Studio GET):

| Path | Returns |
|---|---|
| `/api/deploy/state`, `readiness?scan=&slot=`, `scan/live`, `scan/scene?name=`, `live?slot=&cloud_after=&mem_after=`, `rehearsal/track?name=`, `manifest?name=`, `panel?slot=` | The deploy service's answer, re-sanitised to strict JSON (non-finite numbers become null). `state` adds `studio: {estop_targets, hub, lease, refresher, audit, capabilities}` (as `/api/deploy/link`), also on its 503 when the service cannot be reached. `state`, `live` and `panel` add `source_age_s` (Freshness, below); `live`, `panel` and `rehearsal/track` answer 200 `{ok: false, ended, starting, error}` for a slot that ended (404) or a console that is starting or does not answer (502). |
| `/api/deploy/link` | `{estop_targets: [{slot, name, mode, practice, port, reachable_token, error, seen_age_s}], hub: {ok, age_s, error, ever_ok, version}, lease: {holder, until, since} \| null, refresher, audit: {ok, errors, last_error, at, writes, path}, capabilities: {<v3 capability>: true \| false \| null}}`: what the gateway would E-STOP now, whether its audit log is being written, and which v3 capabilities the deploy service has (null: it never answered). No token. |
| `/api/deploy/heartbeat` | `{consoles: [{slot, session, reached, console_age_s, latency_ms, at, state: fresh \| stale \| unknown, error}], hub: {ok, age_s, error, ever_ok}, stale_after_s: 1.0, t}`: each console the gateway last knew as live, measured **now** on the E-STOP's path (its panel's `/state`, not the deploy service), 0.5 s each, so it works while the deploy service is down. `console_age_s` = now − its `console_t_mono` (one host, one monotonic clock); a console that does not answer is `reached: false`, `console_age_s: null`, `state: "unknown"`. The page polls it at 1 Hz. |
| `/api/deploy/session?name=` | The deploy service's session detail (`receipt, ended, attempts` with tags and tag history, check, start check, rehearsal, passage; `manifest`, `recording`) plus `replay: {catalog_id, state: registered \| not_registered \| indexing \| error, detail, studio_id}`: the exact Replay id in Studio's catalog. When the id is not listed yet the gateway forces the catalog's robot-sessions discovery (at most every 2 s). |
| `/api/deploy/act_status?slot=&id=` | The console's record of that act through the deploy service: `{known, id, act, result: done \| refused \| queued \| pending, reason, t_mono, session}`. |
| `/api/deploy/rehearsal/match?scan=&x=&y=&profile=&odom=` | `{complete, running, others: [{name, state, mismatch: [field], missing}]}`: the newest complete rehearsal set whose identity matches (scan and its memory sha, goal within 0.08 m, profile name and sha, bundle and rules sha, odometry, start poses), the newest matching one still running, and every other set of that scan with what differs. Rehearsal sets are listed newest first. |
| `/api/deploy/session/receipt?name=`, `recording?name=`, `profile/route?name=`, `sessions?offset=&limit=` | Passthrough (v3: the session receipt, the live recording health, a profile's route configuration). |
| `/api/deploy/model` | `{spec, joint_names[29], source}`: the G1 29-DoF model the console replay uses (`sim/assets/g1_29dof.xml` under the deploy root), meshes served at `/assets/mesh/…`. |
| `/api/deploy/goal_check?scan=&x=&y=&profile=` | `{ok, checks[7], straight_m, path_m, path_xy, unknown_fraction, grid, blocking_xy, gap, direct_gap, check_id, check_ttl_s, issued_at, expires_at, config: {profile, sha, params, basis, source_basis, detail}, memory_sha, binding: {scan, memory_sha, goal_scene, config_sha}, scan, goal_scene, goal_xy, robot_xy, start_S, frame: "scene"}`. Checks: inside, seen, free, overhead, reachable, distance (studio/goal_check.py, from the scan pose) and `gap`: the narrowest passage along the route between the scan twin's boxes (block below the robot's width, warn below 1.0 m). The parameters (robot radius, route margin, step-over, ceiling height and reach, growth into unseen space) are the kit's route configuration for `profile` (`basis: "profile route config"`), else Studio's generic ones (`basis: "Studio generic check"`, also when the kit has none). The receipt is good for 10 min (`expires_at`); send_goal refuses it once expired, when the scan's memory changed, or when its `config.sha` is not the live session receipt's profile sha. Geometry in scene. |

**POST with the CSRF token** (`X-Studio-Token`, as every Studio POST):

| Path | Body → reply |
|---|---|
| `/api/deploy/lease` | `{operator, take_over?}` → `{lease_id, holder, until, ttl_s}`; another holder → 409 `{error, holder}` unless `take_over: true` (logged) |
| `/api/deploy/lease/renew` | `{lease_id}` → `{until, holder}`; lost or taken → 409 `{error, holder}` |
| `/api/deploy/lease/release` | `{lease_id}` → `{released}` |
| `/api/deploy/act` | `{act, slot?, lease_id?, id?, expect?, …}` → the deploy service's reply and status. Acts: start, stop, scan, practice_scan, rehearse, start_check, send_goal, doctor (deploy service) and arm, s, c, g, h, t, tag, note (console, through the service). start, stop, scan, practice_scan, rehearse, send_goal, arm, s, c, g need a live `lease_id` (else 409 `need: "lease"`); send_goal needs a valid goal-check receipt (else 409 `need: "goal_check"`, `why: missing \| expired \| other goal \| blocked \| memory changed \| config mismatch \| memory mismatch`). The gateway sets `source: "studio"`, `operator` (the lease holder) and `id` when missing. **When the reply is lost** (no answer in 8 s, a closed connection, or the deploy service's 502/504 for a console act): 202 `{state: "unknown", id, act, slot, session, reconcile: "act_status" \| "state", retried: false, detail}`; nothing is sent again. |
| `/api/deploy/tag` | `{name, n, tag, note, operator?, lease_id?}` → the deploy service's tag of attempt `n` of a live or ended session (append-only history there). The operator is the lease holder, else the named viewer (`operator`); 400 `need: "operator"` without either. Audited. |

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

**Freshness.** `/api/deploy/state`, `live`, `panel` and `recording` add `source_age_s`: now minus the source's own
monotonic time (`t_mono`, the view's `t_mono`, the panel's `console_t_mono`), measured in the gateway, which shares the
deploy PC's monotonic clock with the deploy service and its consoles (loopback only). The page adds the time since it
received the reply.

**A deploy service without v3.** Each v3 route needs a capability in the deploy service's state (`capabilities`:
session_receipt, rehearsal_match, rehearsal_identity, passage, act_status, session_detail, session_tag, profile_route,
recording_health, manifest_v2). A service that answers 404 "unknown endpoint" gets `{supported: false, capability,
detail}` (HTTP 200) from the gateway; the goal check falls back to Studio's generic parameters and says so.

**Evidence.** The gateway appends every relayed act, unknown outcome, tag, lease change, E-STOP and direct press to
`<workbench data root>/deploy/gateway_actions.jsonl`. A failed write is counted and shown in `/api/deploy/link`
`audit` (and printed on stderr), never silently dropped; E-STOP and the direct path hand their rows to a writer thread so
they never wait on the disk. The kit's `hub_actions.jsonl` and each session's `console_events.jsonl` are the record of
what the robot side did.

**Installed vs candidate.** `/api/version` adds `release: {served_from: release | worktree, commit, dirty,
installed_commit, is_installed}`: whether this gateway serves the release worktree that `tools/studio_service.sh`
installs, and that release's commit, so the page can show a candidate under test apart from the installed build.

## 6. Developing with the fake deploy hub

`tools/fake_deploy_hub.py` stands in for the deploy service (v1 and v3) and its consoles: a synthetic room (or a real
scan with `--scan-dir`), non-identity frames (`start_S = [0.3, -0.2, 1.2]`, an odometry frame at 0.9 rad, a start 0.2 m
and 20 deg off the scan pose), a kinematic robot behind the console's gates, rehearsal sets with identity and passage
scoring, session receipts, act records, session detail and tags, profile route configurations (deploy, low-margin and
near differ), recording health and manifest v2, and one panel per console (the robot slot on `--panel-port`, the sim
slot on a free port). It follows the kit's service where the first fake did not: rehearsal sets and sessions newest
first; a refused POST answers 200 with `ok: false` and a reason; acts reach the console over HTTP, so a lost console
reply is the service's 502 "panel unreachable". `--v1-only` serves the service as it was before v3; `--studio-data DIR`
links the fake day into `DIR/robot-sessions` (a development gateway's `--data-root`), so Review finds the sessions and
Replay opens them. Nothing in it talks to a robot, DDS or ZMQ.

```bash
.venv/bin/python tools/fake_deploy_hub.py --port 8779 --panel-port 8780 --studio-data /tmp/studio-deploy-dev
# config/local.json: "deploy_service": {"url": "http://127.0.0.1:8779"}   (or G1_DEPLOY_SERVICE=...)
G1_PANEL_TOKEN=fake-token .venv/bin/python -m studio.server --port 8792 --data-root /tmp/studio-deploy-dev
```

**Fault switches** reproduce the review's cases: `POST /api/fake/faults?t=TOKEN` with a JSON object (`GET` shows them;
`{"reset": true}` clears). Counters fail that many requests (-1: until cleared).

| Switch | Effect |
|---|---|
| `console_drop_reply: N`, `console_drop_acts: [..]` | The console carries out the next N acts (default any but E-STOP and lease renewals) and drops the HTTP reply; the service answers 502. |
| `hub_drop_reply: N` | The service carries out the next N POSTs and closes the connection without a reply. |
| `act_delay_s: S`, `hub_delay_s: S` | Acts / every request wait S seconds first (a stalled request mid-confirmation). |
| `hub_down_s: S` | The service stops listening for S seconds (connection refused), then comes back on its port; the consoles keep running. |
| `freeze_panel`, `freeze_view` | The service serves the panel state / the node view frozen while the console runs on. |
| `hang_console: true \| "robot" \| "sim"` | The console's panel stops answering (state, acts, act records, E-STOP) while the service runs. |
| `manifest_fail`, `recording_fail`, `track_fail`, `session_fail: N` | 503 for the next N requests, then recovery (`track_fail_name`: only that run's track). |
| `manifest_mode: "failing"`, `recording_mode: "degraded"` | A required stream partial with gaps / stalled, low disk, recorder errors. |
| `rehearsal_fail_run`, `rehearsal_stop_after` | A rehearsal run errors (set `failed`) / the set stops after a run (`partial`). |

`POST /api/fake/rehearsals {preset: "f02"}` seeds the review's rehearsal cases (an older pass, a newer failure, a rerun in
progress, other odometry, changed profile contents, another start, a missing identity field); `POST /api/fake/profile
{name, params}` changes a profile's contents under the same name (its sha changes).

Never point a development gateway at the service's data root, and never at a live deploy service with a robot session
for development. Tests: `.venv/bin/python -m unittest tests.test_deploy_link tests.test_fake_deploy_hub` (in-process
fake, ephemeral ports; `tests/fixtures/deploy_v1` holds replies recorded read-only from the kit's real deploy service).
