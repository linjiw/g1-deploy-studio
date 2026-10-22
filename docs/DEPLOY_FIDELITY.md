# Deploy fidelity: Navigate's simulated robot against node.py

Navigate's simulated robot (`studio/nav_worker.py`) runs the deploy bundle's planner, SONIC and node.py's state machine in
CPU MuJoCo. On the robot, `g1-student-deploy/g1deploy/node.py` runs the same model asynchronously, with the fused CUDA
planner (same choices, not bitwise the same plans as Studio's eager CPU planner; `docs/PLANNER_SPEED.md`). This page
covers the switches that bring the simulation closer to the robot, what each one reproduces, and a measurement of the
stand chunk.

| Switch | Default (unchanged) | Opt-in |
|---|---|---|
| `stand_mode` | `default`: node.py `stand()`, all 29 joints to SONIC's default pose | `hold_upper`: the legs settle, waist and arms stay where they are |
| `latency` | `{ms, anchor}`: a fixed delay on the source lockstep loop | `{mode: 'node', ...}`: node.py's planning loop with a latency per plan |
| Navigate preset | quick budget, no latency, simulator-truth odometry | **Use deploy settings**: K 16 / ODE 10, node.py latency rule, LIO-level odometry, one map |

With both defaults, the physics and the plans are bitwise what they were before these switches existed; recordings
gain the contact fields of section 1. The unit tests check the stand chunk against the previous code and node.py's
source. An opt-in integration test runs a session with the fixed latency against the worker archived at `cbc7fcb`.
It compares every frame's pose and command and every plan. On 2026-10-22, one rehearsal-parity walk (goal at t = 0,
pillar world, seed 2, 160 ms predictive) gave 202 frames and 16 plans equal. The interactive goal/Go path and the 0 ms
default are covered by the unit tests only. Log: `~/research-data/g1-deploy-studio/evidence/deploy-fidelity-20261022/`.

## 1. The stand chunk (`stand_mode`)

node.py `stand()` (`g1deploy/node.py`, `StudentNode.stand`) streams a 4 s chunk from the measured pose. Over 1 s, all
29 joints blend (smoothstep) to SONIC's default pose; the pose is then held for 3 s. The default pose has the arms out:
shoulder roll ±0.2 rad and elbow 0.6 rad put the hands about 0.23 m to each side of the pelvis, plus about 5 cm of hand.
Stopping beside a wall therefore swings the hands outward. In Flow's closed-loop study (round SLR2,
`closed_loop/callback.py` `stand_chunk(hold_upper=True)`), holding the waist and arms cut stand-time arm contacts from
26 to 9. Those contacts came 0.2 s later instead, once the next plan landed, and SLR2 was not adopted
(`research/BEST_MODEL.md`, `research/ROUND_ST_PLAN.md`).

- **`default`**: node.py's chunk, unchanged (`nav_worker.stand_chunk`, used for every node stand).
- **`hold_upper`**: the legs (MuJoCo joints 0–11) settle as before. The waist and arms (12–28) stay exactly at the
  measured pose for the whole chunk, with zero reference velocity.
- The remote's takeover (D-up) and the boot stand always use `default`: neither is node.py's `stand()`.
- Set it in the worker request or in `POST /api/nav/start` as `"stand_mode": "hold_upper"`. The Navigate UI does not
  offer it: the robot runs node.py's chunk.

**Contact attribution.** Every walk now records its obstacle contacts as episodes, without touching the physics. The
source's maximum robot–obstacle force is returned unchanged; when it is positive, the same contacts are also split by
robot body group. An episode is a run of ticks with any robot–obstacle force. Each episode records:

- `start_s`, `end_s` and `peak_n`;
- `groups`: the peak force per body group (`arm`, `leg`, `torso`, `head`; the head mesh rides on `torso_link`);
- `first_group`: the group carrying the most force at first contact;
- `stand`, `stand_reason`, `stand_mode` and `stand_age_s`: whether a stand chunk was in force at first contact, and
  which one.

Where to find it:

- `metadata.navigation.legs[i].contacts`, with a `contact_summary` that splits stand-time from walking episodes by body
  group;
- `test_result.contacts`, the same summary over the whole session;
- `frames[k].post_action.contact.groups` and `.stand_in_force`, on frames with contact.

### Measurement

`tools/stand_contacts.py` runs paired walks: the same world, goal and seed once per stand mode. Each walk is one fresh
session, driven through the worker's inbox as the gateway drives it. Until the first stand both modes run the same
physics; the tool checks this with a hash of every frame before the first stand. Workers run at nice 19 on 2 threads, at
most 2 at a time, and start only while `MemAvailable` is at least 11 GiB.

```bash
OUT=~/research-data/g1-deploy-studio/evidence/stand-contacts-<date>
.venv/bin/python -m tools.stand_contacts --out $OUT --dry-run                  # the plan only
.venv/bin/python -m tools.stand_contacts --out $OUT --walks 8                  # the walks (resumable)
/home/linjiw/code/g1-student-deploy/.venv/bin/python -m tools.stand_contacts --out $OUT --clearance   # deploy interpreter
.venv/bin/python -m tools.stand_contacts --out $OUT --summarize-only           # tables, with clearance, into summary.json
```

Scenarios, all at the deploy profile (K 16 / ODE 10, 160 ms predictive, LIO-level odometry, one map):

- **detour**: goals 0.36–0.40 m from the faces and ends of the `flow-detour` wall; the robot stands wherever it enters
  the 0.4 m goal radius. The goal check refuses goals closer than 0.30 m to a tall obstacle.
- **narrow**: goals inside a 1.1 m passage between two 1.8 m walls, on the centre line and 0.18 m off it.
- **narrow-stop**: walking through the same passage towards a goal past its exit. The walk timeout (2.4, 2.8, 3.2 or
  3.5 s after Go, including the 0.5 s pre-scan) stops the robot mid-passage, as an operator's Stand would.

The deploy route keeps 0.35 m from walls and grows them 0.1 m into unseen space, so it cannot enter a passage much
narrower than 1.0 m: in smoke runs at 0.75 m and 0.9 m (not archived) the goal check reported "No route". Flow's
narrow-passage work (tight-mode corridors of 0.3–0.45 m, arm-height constrictions of 0.46–0.60 m; `BEST_MODEL.md`) is
out of the bundle's reach.

**Results (2026-10-22, deploy-fixes branch, CPU, 2 workers).** 24 paired walks per mode. In all 24 pairs the physics
before the first stand was bitwise equal across modes. Evidence:
`~/research-data/g1-deploy-studio/evidence/stand-contacts-20261022/` (`summary.json`, one folder per walk). Clearance is
the smallest distance from an arm collision geom to a wall over the recorded poses, from `--clearance`.

| World | Stand mode | Walks | Outcome | Falls | Contact episodes (stand / walking) | Arm clearance at stand start, median | Arm clearance during the stand, median / min |
|---|---|---|---|---|---|---|---|
| detour | default | 8 | 8 arrived | 0 | 0 / 0 | 0.319 m | 0.273 / 0.100 m |
| detour | hold_upper | 8 | 8 arrived | 0 | 0 / 0 | 0.319 m | 0.288 / 0.062 m |
| narrow | default | 8 | 8 arrived | 0 | 0 / 0 | 0.231 m | 0.207 / 0.074 m |
| narrow | hold_upper | 8 | 8 arrived | 0 | 0 / 0 | 0.231 m | 0.191 / 0.086 m |
| narrow-stop | default | 8 | 8 stopped; stand began inside (pelvis x 1.9–3.5 m) | 0 | 0 / 0 | 0.256 m | 0.184 / 0.116 m |
| narrow-stop | hold_upper | 8 | 8 stopped, as above | 0 | 0 / 0 | 0.256 m | 0.204 / 0.123 m |

- **No contact in either mode.** The stand never touched a wall, and neither did the walking.
- In narrow-stop the pelvis kept moving 0.2–0.6 m during the stand. One pair ended just past the passage exit
  (x 3.65 m). In w00 a remembered low ceiling deferred the stand for 0.1 s: the walls are 1.8 m high, so likely a
  phantom ceiling from the robot's own arms (`NAVIGATE.md`, second finding).
- An earlier narrow-stop batch with 4.5–7.5 s timeouts (16 walks, mostly arriving past the exit) had no contact either.
  It is kept in `stand-contacts-20261022-narrow-stop-late/`.
- **The stand moves the arms closer in both modes.** In 5–7 of 8 walks per world and mode, an arm comes more than
  1 cm closer to a wall at some point during the stand than it was when the stand began. The pelvis keeps moving
  during the 1 s settle, and the arms move with it.
- **Holding the arms changes the margin by a few centimetres, either way.** Per-world medians differ by at most 2 cm,
  and the minima by up to 4 cm. The smallest margin of all, 6.2 cm on the detour, came with `hold_upper`, with the arm
  held mid-swing towards the end of the wall.
- **Flow's 26 → 9 does not carry over at these settings.** Flow's narrow-passage work concerns gaps under 0.6 m. The
  bundle route keeps 0.35 m from walls, so its stops left every arm at least 6 cm from a wall.

## 2. Planner latency (`latency`)

**Fixed (the default mode).** `{"ms": <latency>, "anchor": "measured" | "predict"}` (default 0 ms; the deploy budget is
`{"ms": 160, "anchor": "predict"}`) is the source lockstep loop (`sim/lockstep.py`). A plan requested at tick t drives
SONIC from t + latency. With `predict`, it is planned from the state predicted at
t + latency (`g1deploy/latency.py`). Every plan has the same latency, and the planner knows it exactly.

**Node (opt-in).** `{"mode": "node", "preset": "bundle-fused"}` runs node.py's own loop (`StudentNode.request` /
`collect`):

| Rule | node.py | Studio |
|---|---|---|
| One plan in flight | `--inflight 1` | the next request waits until the plan in flight lands |
| Latency | whatever the planner took | drawn per plan from the preset (below); the CPU compute time is recorded as `compute_s` |
| Landing | polled once per 20 ms tick | request tick + ceil(latency / 20 ms), at least the next tick |
| Lead | `ceil(latency_est / DT) + 1`, with `latency_est` the q90 of the last 8 latencies and a 0.3 s first guess | the same (copied; tested against node.py's source text) |
| First plan | lead 0, started when it lands (the robot stands meanwhile) | the same |
| Late plan | streamed mid-window (`start = max(anchor, now - 2)`) | tracked from the landing tick, part-played |
| Early plan | takes over at its anchor tick | the same |
| Drops | `sane()`: non-finite, pelvis z outside [0.35, 1.0] m, mean speed > 2.5 m/s; stale anchors | node.py's own `sane()` and `parse()` defaults, imported at run time |
| Joint velocity | clipped to 30 rad/s | the same |
| Previous plan | never given to the planner | the same |
| Stand / Go | in-flight results dropped; a stand overwrites what was streamed | the same |

| Preset | Latency per plan | Source |
|---|---|---|
| `bundle-fused` | lognormal through p50 0.119 s, p95 0.167 s | g1-student-deploy `docs/PLANNER_SPEED.md`: the fused fp32 planner on 37 recorded states, loaded deploy-PC GPU |
| `flow-sk1` | 0.19 s first pool, 1.10 s when the fallback pools ran, +0.09 s if the execution check retried (never for the bundle planner: it has no execution check) | Flow `research/ROUND_ST_PLAN.md` round ST-L: FastWXPlanner bench medians for the ST1 student block, on the shared 5080 under Isaac load; applied to the pools the bundle planner used on that replan (Flow's `emulated_latency_s`) |
| `flow-wx` | 0.11 / 0.47 / +0.05 s, the same way | the same round, WX teacher |
| `custom` | `{"mode": "node", "distribution": {"kind": "fixed" \| "lognormal" \| "pools", ...}}` | yours |

Each plan row records `latency_s` (the simulated latency), `compute_s`, `lead_ticks`, `anchor_tick`, `land_tick`,
`landed_tick`, `late_ticks`, `latency_basis`, and `dropped` / `dq_clipped_from_rad_s` when they apply. The session's
`metadata.latency_model` describes the rules and adds `realized`: drops, clips, late plans, lead ticks and the
fallback share. `latency_model.ms` holds the preset's nominal value (p50, first-pool time or fixed value) for displays
that read one number. The inspector's fidelity card therefore reads "L2 predict · lockstep with 119 ms planner latency"
for `bundle-fused` and 190 ms for `flow-sk1`. It does not show the per-plan spread or the 1.1 s fallbacks; read those in
the plans and in `realized`.

`bundle-fused` has no dependence on the planner's work. PLANNER_SPEED.md measures 0.34–0.54 s (fused) when every pool is
unsafe, in about 4 % of plans in its realistic panel. A `pools` distribution charges its fallback time whenever the
resample pool ran, which happens more often than that, so it brackets the tail from above:
`{"mode": "node", "distribution": {"kind": "pools", "first_s": 0.12, "fallback_s": 0.45}}`.

## 3. Deploy settings in Navigate

**Use deploy settings** (Navigate → Simulated robot, above *Advanced*) sets:

- the deployed budget (K 16 / ODE 10, about 0.15× real time on this CPU);
- node.py's latency rule with the bundle planner's timing;
- LIO-level odometry drift (the G4 configuration);
- one map for the session (`keep`, as node.py);
- the current G1 actuator limits.

The latency menu also offers the node rule with Flow student-sk1 timing. The public site's recordings
(`tools/site/record_goals.py`, profile `deploy`) use the fixed 160 ms predictive model instead.

## 4. A deploy-settings rehearsal, end to end

1. **Check the inputs.** On the gateway, `GET /api/policies` lists the deploy bundle profile as available. Its label
   reads "student-s2-kcsc (2026-10-08 bundle), not Flow's current student-sk1".
2. **Interactive.** Navigate → *Simulated robot* → pick a world → **Use deploy settings** → **Start session**. Place a
   goal on the robot's map, read its checks, **Send goal**, **Go**. End the session; the recording opens in Replay. The
   timeline's *Planner compute* lane (drawn against the 160 ms deploy replan budget) shows the simulated latency per
   plan, and the inspector's *Effective planner configuration* shows `latency_mode: node`.
3. **Scripted.** The gateway accepts the same settings: `POST /api/nav/start` with
   `{"map_id": ..., "start_xy": ..., "planner": "deployed", "latency": {"mode": "node", "preset": "bundle-fused"}, "odometry": "lio", "map_mode": "keep"}`,
   then `{"id": <job>, "cmd": "goal", "xy": [x, y]}`, `go` and `end` through `POST /api/nav/command`. POSTs need a
   loopback `Host`, `Origin: http://<that Host>`, `Content-Type: application/json` and the `X-Studio-Token` from
   `GET /api/workbench` (`csrf_token`). Without the gateway, run the worker on the deploy interpreter and drive its
   inbox, as `tools/stand_contacts.py` does:

   ```bash
   .venv/bin/python -m tools.stand_contacts --profile deploy-node --worlds detour --walks 4 --modes default --out <dir>
   ```

4. **Compare the stand.** Run the same batch with `--modes default hold_upper` (section 1).
5. **Read it as simulation.** The result is L2: planner, tracker and node logic with modelled latency. It is not the
   C++/DDS chain (L3) and not hardware.

## 5. Policies and labels

- **Navigate and the robot** run the g1-student-deploy bundle. Its planner is **student-s2-kcsc (2026-10-08 bundle),
  not Flow's current student-sk1**. The policy catalog, Navigate recordings and rehearsal recordings all use this
  label.
- **Flow's adopted block** is WXD (WX + the DP2 duck keys, adopted 2026-10-20). It is pinned beside WX-RF as
  `flow-wxd-rf-5658a6d-s0`. The bundle was built read-only from Flow, and Rehearse preselects it because its block
  matches `BEST_MODEL.md`:

  ```bash
  .venv/bin/python tools/build_policy_bundle.py --block WXD --commit 5658a6d \
      --config configs/closed_loop_dp2_xdg.json --arm XGD-g-s0 --teacher sk1_s0 \
      --variant 'WXD-RF (WX + DP2 duck keys, retrieval-free; XGD arm)' \
      --label 'Flow WXD-RF · adopted block (2026-10-20) · teacher sk1_s0' --adopted-commit 5658a6d
  ```

  The guard config's arm (`closed_loop_dp2_guard.json`, `GD2-g-s0`) uses clips (`retrieval_k` 16), and the builder
  refuses it. The retrieval-free DP2 arm is `XGD-g-s0` in the xdg config: WX-RF's `WXR0` arm plus the six DP2 keys,
  without WXR0's two retrieval yaw caps (used only by retrieval, so inert at `retrieval_k` 0). WX-RF now reads
  "previously adopted (Flow now adopts WXD)".
- **WXD-RF smoke** (K8/ODE6, CPU, no latency, 6 s, a beam with its bottom at 1.05 m across the path): the robot ducked
  under the beam with the pelvis down to 0.65 m, without contact. It timed out at the 6 s cap, 0.42 m short of the goal
  (`evidence/deploy-fidelity-20261022/wxd-rf-smoke/`).
- WX-family profiles are privileged: they plan from the exact boxes, not from LiDAR. They run in Rehearse only.

## 6. Remaining gaps

- **student-sk1 is not deployable.** Flow's current LiDAR student is not in any deploy bundle. Navigate, the site and the
  robot run student-s2-kcsc. A new bundle would need the deploy repository's freeze tool and Flow artifacts; both are
  outside Studio.
- **node.py's `stand()` swings the arms out.** Changing it to hold the upper body is the user's call in
  g1-student-deploy. Studio only measures the option (section 1).
- **L3 has never run.** `tools/l3_rehearsal.sh` (the C++/DDS chain in an isolated namespace) is reviewed and waits for
  an operator. Node mode models node.py's timing, not its threads, transport, the runner's window or GPU contention.
- **Not modelled in node mode:**
  - the perception thread's 10 Hz route refresh (Studio refreshes the route at each request);
  - a fresh goal function per plan in node.py's workers (Studio keeps one per walk);
  - the stale-cloud stand and the stale-state E-stop;
  - latency correlated with the planner's work under `bundle-fused`.
- **Narrow passages.** The deploy route's 0.35 m margin keeps the bundle out of passages narrower than about 1.0 m, so
  the stand measurement covers wall-side stops and a 1.1 m passage only.
