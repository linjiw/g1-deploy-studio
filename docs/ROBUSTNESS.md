# Navigation robustness campaign: WX-RF on random goals (2026-10-20)

**Question.** If we pick random navigation goals, how does the current best Flow policy (WX-RF) behave, and is it robust?

**Short answer.** In synchronous CPU lockstep (L1), WX-RF reached and held **every valid random goal at seed 0 (18/18)**, and **29/30** once seeds 1–2 on the clutter arena are added. On the obstructed goals it beat the frozen LiDAR bundle (6/6 against 2/6). Two weaknesses showed up:

- **Stopping is its weak point.** WX tends to arrive fast, overshoot and come back. One seed parked 0.32 m from the goal and never re-entered the 0.3 m arrival radius.
- **It is not robust to planner latency.** With a 200 ms delay (Studio's L2-approx model), arrive-and-hold fell to **1/12**, with oscillation at the goal, one fall and one collision. Post-hoc Flow reach stayed at 11/12, and leg torque was clamped in 11/12 runs.

The bundle with 200 ms predictive latency scored 9/12, against 8/12 without latency.

All of this is a small-n MuJoCo CPU simulation from standing starts. It is not hardware evidence.

- Gateway: the release service on 127.0.0.1:8790, commit `3f3dfa5`. All runs are in the main run history.
- Raw data, CSV and screenshots: `~/research-data/g1-deploy-studio/evidence/robustness-20261020/` (outside Git; see [Evidence](#evidence)).

## 1. What ran

| Phase | Policy · budget | Latency | Seeds | Scenarios | Suite | Status |
|---|---|---|---|---:|---|---|
| P1 | WX-RF `flow-wx-rf-23326aa-s0` · K8/ODE6 | 0 | 0 | 24 (all presets) | `suite-e2d12bc1a09e` | done; 6 open-floor runs are **tool errors** (§6) |
| P2 | Bundle `flow-bundle-20261008` · K4/ODE6 | 0 | 0 | 24 (same scenarios) | `suite-ea5cbe7c270e` | done |
| P3 | WX-RF · K8/ODE6 | 200 ms, measured (L2-approx) | 0 | 12 (clutter + doorway) | `suite-9fc5afef9d18` | done |
| P4 | WX-RF · K8/ODE6 | 0 | 1, 2 | 12 (clutter) | `suite-5c4d567c2418` | done |
| P5 | WX-RF · **K16/ODE10** (evaluated budget) | 0 | 0 | 4 (2 clutter, 2 doorway; the obstructed ones, chosen before any run) | `suite-13036095b516` | done |
| P6 | Bundle · K4/ODE6 | 200 ms, predict (L2) | 0 | 12 (clutter + doorway) | `suite-ddeae9356fd8` | done |
| DET | WX-RF, re-run of P1 clutter #4 | 0 | 0 | 1 | `suite-66b38b1d668b` | done |

- **Totals.** 89 runs, all with the *arrive & hold* criterion and a 10 s horizon, executed one at a time through suites. Worker wall time was 47 min (suites 01:34–02:23 EDT), and the campaign took about 1 h 5 min including setup and analysis.
- **Fidelity.**
  - Latency 0 is synchronous lockstep (L1): physics waits for every replan.
  - The bundle's 200 ms run uses the source `run_episode(latency_s, anchor='predict')` (L2).
  - WX's 200 ms run is Studio's delayed-execution wrapper around a callback that is not latency-aware (L2-approx). Each plan is executed from its request tick + 10 ticks, and the callback still anchors its next replan on the latest computed plan. The replan period is 8 ticks (160 ms), so with 200 ms every plan starts 2 ticks after the next replan has already been requested.

### Arenas (made in the Arena workspace with the seeded random-goal generator)

Each arena has 6 presets with heading set to *toward goal*. The generator never produced fewer than 6 valid goals.

| Key | Arena id (sha256) | Template | Generator | Goals with the straight line blocked by a box |
|---|---|---|---|---|
| open | `arena-629e9b7e71cf` (`2bc58e51…`) | empty | seed 101, 1.5–4.5 m, **random start** | — (no boxes) |
| clutter | `arena-bae0a875684c` (`52e85540…`) | clutter, seed 7 (9 pillars) | seed 102, 1.5–4.5 m, start (0, 0) | 2/6 |
| doorway | `arena-4d5b7a376e26` (`ff8a5fc3…`) | doorway 0.8 m | seed 103, 2.0–4.5 m, start (0, 0) | 2/6 (one more passes 0.55 m from the wall end) |
| slalom | `arena-c9dbe354d628` (`1e683f54…`) | slalom | seed 104, 1.5–4.5 m, start (0, 0) | 2/6 |

**Caveat on "random".** The generator samples uniformly inside the arena bounds. The bounds reach about 3 m behind and beside the start. As a result, **only 6 of the 18 obstacle-arena goals require passing an obstacle**. The rest are open-floor walks with the obstacles behind or beside the robot (see §7). The results below are therefore split by obstruction.

## 2. Results per arena and policy (P1, P2: latency 0, seed 0, K8/ODE6 WX vs K4/ODE6 bundle)

*Arrive & hold* is the source scorer: within 0.3 m, below 0.25 m/s for 0.4 s, with collision above 100 N. *Post-hoc reach* is the Flow arena protocol (0.4 m, 2 m/s for 0.1 s, contact ≤ 5 N), re-evaluated on the recorded 50 Hz simulator-truth trajectory. Brackets are Wilson 95% intervals. Categories run goal / timeout ≤ 0.5 m / timeout > 0.5 m / collision / fall / error. Times and distances are medians, and path efficiency is computed over runs that reached the goal post hoc. Peak contact and maximum tilt are maxima over runs; planner p50/p95 are medians of the per-run values.

| Policy · arena | n | Arrive & hold | Post-hoc reach | Categories | t goal s | t reach s | Path eff. | Final m | Peak contact N | Max tilt rad | Planner p50 / p95 ms |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|
| WX · open | 0 | n/a: 6 tool errors excluded (§6) | n/a | — | — | — | — | — | — | — | — |
| WX · clutter | 6 | 6/6 [61–100] | 6/6 [61–100] | 6/0/0/0/0/0 | 3.46 | 2.35 | 0.86 | 0.17 | 0 | 0.31 | 1138 / 1323 |
| WX · doorway | 6 | 6/6 [61–100] | 6/6 [61–100] | 6/0/0/0/0/0 | 3.96 | 2.82 | 0.92 | 0.16 | 0 | 0.28 | 887 / 1087 |
| WX · slalom | 6 | 6/6 [61–100] | 6/6 [61–100] | 6/0/0/0/0/0 | 4.73 | 2.30 | 0.82 | 0.19 | 0 | 0.23 | 896 / 1057 |
| **WX · all valid** | **18** | **18/18 [82–100]** | **18/18 [82–100]** | 18/0/0/0/0/0 | 3.76 | 2.67 | 0.87 | 0.19 | 0 | 0.31 | 900 / 1174 |
| Bundle · open | 6 | 6/6 [61–100] | 6/6 [61–100] | 6/0/0/0/0/0 | 3.80 | 2.38 | 0.87 | 0.20 | 0 | 0.27 | 445 / 588 |
| Bundle · clutter | 6 | 5/6 [44–97] | 5/6 [44–97] | 5/0/1/0/0/0 | 3.62 | 2.30 | 0.84 | 0.15 | 0 | 0.29 | 498 / 679 |
| Bundle · doorway | 6 | 3/6 [19–81] | 4/6 [30–90] | 3/0/2/1/0/0 | 4.18 | 2.71 | 0.88 | 0.37 | 194 | 0.43 | 399 / 982 |
| Bundle · slalom | 6 | 5/6 [44–97] | 5/6 [44–97] | 5/0/0/1/0/0 | 3.32 | 2.26 | 0.91 | 0.15 | 151 | 0.47 | 447 / 491 |
| **Bundle · all** | **24** | **19/24 [60–91]** | **20/24 [64–93]** | 19/0/3/2/0/0 | 3.62 | 2.56 | 0.88 | 0.22 | 194 | 0.47 | 447 / 596 |

| Split | WX (P1) | Bundle (P2) |
|---|---|---|
| Straight line blocked (6 goals) | **6/6** | **2/6** |
| Unobstructed, obstacle arenas (12) | 12/12 | 11/12 |
| Unobstructed, open floor (6) | tool error | 6/6 |

**Paired on the 18 identical scenarios WX could run:**
- Outcome: WX 5 wins, 0 losses, 13 both goal.
- Post-hoc reach: 4 wins, 0 losses.
- Time to goal on the 13 shared goals: medians 3.50 s for WX and 3.62 s for the bundle; WX was faster in 8 and slower in 5.
- Final distance (5 cm tolerance): WX closer in 6, bundle in 4, tied in 8; all 4 bundle "wins" are both-goal cases.

### Per-preset matrix

Cells: `G t` goal at t s; `T≤` / `T>` timeout with the final distance; `C` collision; `F` fall; `TE` tool error; `·` not run.

| Arena #preset | start → goal (m) | d / line clearance m | P1 WX | P2 bundle | P3 WX lat200 | P4 WX s1 | P4 WX s2 | P5 WX K16/10 | P6 bundle lat200p |
|---|---|---|---|---|---|---|---|---|---|
| open #0 | (4.15, −2.05) → (2.95, 1.4) | 3.65 / — | TE | G 5.5 | · | · | · | · | · |
| open #1 | (2.85, −0.9) → (1.9, −2.3) | 1.69 / — | TE | G 3.3 | · | · | · | · | · |
| open #2 | (−0.2, 1.9) → (−2.35, 0.15) | 2.77 / — | TE | G 4.0 | · | · | · | · | · |
| open #3 | (−0.2, −0.05) → (−1.95, −0.55) | 1.82 / — | TE | G 3.6 | · | · | · | · | · |
| open #4 | (−0.95, 1.6) → (1, 0.2) | 2.40 / — | TE | G 3.4 | · | · | · | · | · |
| open #5 | (−1.85, −1.3) → (−0.05, −0.85) | 1.86 / — | TE | G 4.2 | · | · | · | · | · |
| clutter #0 | (0, 0) → (0, 1.55) | 1.55 / 1.18 | G 3.0 | G 3.6 | T≤ 0.25m | T≤ 0.32m | G 2.9 | · | G 3.1 |
| clutter #1 | (0, 0) → (2.4, 1.85) | 3.03 / **blocked** | G 5.1 | G 6.2 | T≤ 0.48m | G 5.0 | G 5.3 | G 7.1 | C @2.0s |
| clutter #2 | (0, 0) → (−1.3, −0.8) | 1.53 / 1.18 | G 3.1 | G 2.8 | T≤ 0.47m | G 3.1 | G 2.8 | · | G 2.6 |
| clutter #3 | (0, 0) → (−2.25, −1.15) | 2.53 / 1.18 | G 3.5 | G 4.0 | T> 1.37m | G 3.9 | G 3.4 | · | G 3.3 |
| clutter #4 | (0, 0) → (3, −0.3) | 3.01 / **blocked** | G 9.8 | T> 1.50m | T> 0.52m | G 7.2 | G 6.5 | G 6.6 | T> 0.97m |
| clutter #5 | (0, 0) → (−0.95, 1.85) | 2.08 / 1.18 | G 3.5 | G 3.6 | T> 2.75m | G 4.0 | G 3.8 | · | G 3.2 |
| doorway #0 | (0, 0) → (0, 2.5) | 2.50 / 1.88 | G 4.0 | G 4.0 | F @3.5s | · | · | · | G 4.1 |
| doorway #1 | (0, 0) → (1.35, 2.35) | 2.71 / 0.55 | G 3.9 | C @4.5s | T≤ 0.44m | · | · | · | G 3.9 |
| doorway #2 | (0, 0) → (−2.1, 1.5) | 2.58 / 1.92 | G 3.6 | G 4.2 | T≤ 0.18m | · | · | · | G 3.8 |
| doorway #3 | (0, 0) → (−2.3, −1.45) | 2.72 / 1.92 | G 3.6 | G 4.7 | T> 0.96m | · | · | · | G 3.6 |
| doorway #4 | (0, 0) → (3.9, 1.4) | 4.14 / **blocked** | G 6.4 | T> 1.52m | G 7.4 | · | · | G 5.9 | G 9.9 |
| doorway #5 | (0, 0) → (2.8, 0.65) | 2.87 / **blocked** | G 5.8 | T> 2.29m | C @2.9s | · | · | G 5.2 | T≤ 0.08m |
| slalom #0 | (0, 0) → (3.15, −2) | 3.73 / **blocked** | G 6.1 | G 5.8 | · | · | · | · | · |
| slalom #1 | (0, 0) → (0, −2.1) | 2.10 / 1.18 | G 6.0 | G 3.4 | · | · | · | · | · |
| slalom #2 | (0, 0) → (0.7, 1.45) | 1.61 / 0.48 | G 3.0 | G 3.3 | · | · | · | · | · |
| slalom #3 | (0, 0) → (2.9, 1.25) | 3.16 / **blocked** | G 6.0 | C @7.0s | · | · | · | · | · |
| slalom #4 | (0, 0) → (−1.95, −1.2) | 2.29 / 1.18 | G 3.5 | G 3.1 | · | · | · | · | · |
| slalom #5 | (0, 0) → (0.85, −1.55) | 1.77 / 1.06 | G 3.0 | G 3.3 | · | · | · | · | · |

## 3. Perturbations

| Comparison (paired, identical scenarios) | n | Arrive & hold | Post-hoc reach | Outcome flips | Notes |
|---|---:|---|---|---|---|
| **WX latency 200 ms** (P3) vs 0 (P1), clutter + doorway | 12 | **1/12 [1–35]** vs 12/12 | 11/12 vs 12/12 | 11 losses, 0 wins | Categories 1/5/4/1/1/0. Path efficiency (reached) fell from ~0.88 to 0.49 and max tilt rose to 0.93 rad. 11/12 runs had leg torque clamped (P1: 2/18) |
| Bundle latency 200 ms predict (P6) vs 0 (P2), clutter + doorway | 12 | 9/12 [47–91] vs 8/12 | 9/12 vs 9/12 | 2 wins, 1 loss (7 both goal, 2 both fail) | Changes in both directions, so no systematic degradation at this n |
| WX seeds 0/1/2 (P1 + P4), clutter | 18 | 17/18 | 18/18 | 1 of 6 presets flips (clutter #0, seed 1) | Final-distance spread per preset ≤ 0.18 m; time to goal on clutter #4 is 9.84 / 7.20 / 6.52 s |
| WX K16/ODE10 (P5) vs K8/ODE6 (P1), 4 obstructed | 4 | 4/4 vs 4/4 | 4/4 vs 4/4 | none | Time to goal 7.12 / 6.64 / 5.86 / 5.16 s vs 5.12 / 9.84 / 6.38 / 5.80 s. Planner p50 rose from ~0.8–1.3 s to ~1.7–2.8 s and p95 to 2.9–4.9 s. No torque clamping (K8: 2/4 runs) |
| Determinism: P1 clutter #4 re-run (`job-2daad56c20d1` vs `job-0d845fb506bb`) | 1 | goal / goal | — | — | Same outcome, final 0.2745 m and t 9.84 s. 492 progress rows: **qpos max difference 0.0**. Native `closed_loop.npz` (pre-action, realized and estimated qpos, references, contacts): **all max differences 0.0** |

### Torque (commanded PD torque vs the MuJoCo model limit)

The values are *commanded* per physics substep (source `pd_torque`, simulator-commanded, not measured). MuJoCo clamps them to `actuatorfrcrange`, which is 88 N·m for hip pitch, roll and yaw. Peaks of exactly 139 N·m are the source's own clip at the training effort limit.

| Phase | Runs with any joint over the model limit | Joints (runs · peak N·m · clamped joint-substeps) | Clamped / total substeps |
|---|---|---|---|
| P1 WX | 2/18 (`job-619033c8f277`, `job-0d845fb506bb`) | L hip pitch 2 · 139 · 16; R hip pitch 2 · 139 · 8 | 24 / 16 568 |
| P2 bundle | 5/24 (all 2 collisions, 2 of 3 timeouts and 1 goal) | L hip pitch 5 · 139 · 42; R hip pitch 2 · 139 · 40 | 82 / 23 472 |
| **P3 WX lat 200** | **11/12** | L/R hip pitch 11 · 139 · 1081/1419; L/R hip roll 10 · 139 · 304/282 | **3086 / 20 756** (worst: 210 clamped joint-substeps in 692 substeps, the fall `job-2878c2250350`) |
| P4 WX seeds 1–2 | 1/12 (`job-4445cab6a505`) | hip pitch · 139 | 14 / 11 580 |
| P5 WX K16/ODE10 | 0/4 | — | 0 / 4 956 |
| P6 bundle lat 200p | 4/12 | L hip roll 3 · 121.9; L hip pitch 1 · 122.6; R hip pitch 1 · 89.3 | 24 / 11 888 |

Only hip pitch and hip roll ever exceeded the limit; knees (limit 139) and ankles never did. At latency 0 the excursions are short spikes. Under WX + 200 ms they are sustained, which agrees with the visible jitter (§4). The robot contract still has the open 139 vs 88 N·m hip-limit question ([ROBOT_CONTRACT.md](ROBOT_CONTRACT.md)). This campaign shows that question matters for WX: its training-effort commands were clamped in MuJoCo even in successful runs.

## 4. Behaviours worth knowing (job ids, screenshots in `screens/`)

1. **WX goes through obstacles; the bundle detours around them.** On every blocked goal WX threaded the gap: through the 0.8 m door, between clutter pillars and around the slalom wall tips. On the same goals the bundle took wide detours (path efficiency 0.36 on clutter #4) or hit the wall ends. Examples:
   - clutter #4: WX `job-0d845fb506bb` vs bundle `job-ace5d2b9d81c`, which went all the way below the clutter field and timed out 1.5 m away (`notable-clutter4-wx-loop-vs-bundle-detour.png`);
   - doorway #4/#5: bundle `job-5660e53074d4` and `job-adea7c010046` (`notable-doorway-bundle-failures-vs-wx.png`).
2. **WX overshoots and loops back.** It arrives fast and brakes late. In 14/18 goal runs it spent at least 0.5 s inside 0.3 m above 0.25 m/s (50 Hz finite difference). The median delay from first 0.3 m entry to completed hold was 1.1 s, with a maximum of 3.6 s. Examples:
   - clutter #4 `job-0d845fb506bb`: entered at 7.2 s, passed 2 cm from the goal, left the radius and held only at 9.84 s, 0.16 s before the horizon (59/62 replans in tight mode, both hips clamped);
   - slalom #1 `job-c6ac80c821e8`: unobstructed 2.1 m goal, reached post hoc at 2.3 s, overshot and held at 5.96 s; path efficiency 0.69 (`notable-slalom-wx-detours-bundle-collision.png`).
3. **WX can park just outside the arrival radius.** In clutter #0 at seed 1 (`job-a63f1d9b5bf9`) it overshot to 0.40 m, came back to 0.30–0.37 m and stood there for 6 s. That counts as Flow reach (0.4 m) but as an arrive-and-hold timeout. Seeds 0 and 2 succeeded (`notable-clutter0-seed1-parks-outside-radius.png`). This is the one seed flip in P4.
4. **Under 200 ms latency WX keeps stepping around the goal.**
   - 11/12 runs entered 0.3 m, but only 1 held. The trajectories zig-zag with repeated entries and exits; clutter #0 `job-9f167e029b95` had 7 entries (`runs-clutter-P3-lat200-only-by-outcome.png`, `runs-doorway-P3-lat200-only-by-outcome.png`).
   - Doorway #0 `job-2878c2250350` **fell** 0.5 s after entering the radius in open space (tilt 0.93 rad, root height 0.31 m, nearest box 1.75 m away).
   - Doorway #5 `job-0fabefd33c9b` **hit the door edge** at 2.94 s (186 N) (`notable-doorway-lat200-fall-collision.png`).
   - Whether this is WX itself or the L2-approx wrapper can only be settled with a latency-aware callback on the Flow side (§8).
5. **Bundle failures cluster at wall ends.**
   - Doorway #1 `job-373a9382e621`: inside 0.3 m at 2.98 s, then hit the upper wall end at 4.46 s (194 N; closest root–box distance 0.09 m).
   - Slalom #3 `job-46ae47850a01`: hit the middle wall tip at 6.98 s (151 N).
   - P6 clutter #1 `job-8af73e6b9104`: hit a pillar at 2.0 s (257 N).
   - P6 doorway #5 `job-b32fd8389882`: sat 0.08 m from the goal from 7.7 s with 37 N wall contact and never satisfied the hold. Post-hoc reach also fails, because contact exceeded 5 N.
6. **Planner cost.** In P1, WX K8/ODE6 replans had a median p50 of 0.9 s and p95 of 1.2 s on this shared CPU. The maximum p95 was 3.9 s, on doorway #4 `job-619033c8f277`: 21/40 replans in tight mode, with `stop_max_clearance` and `resampled_safe` rules and up to 3 execution-check tries. K16/ODE10 had p95 2.9–4.9 s. The deploy budget is 160 ms, so lockstep hides a gap of one to two orders of magnitude.

## 5. Is WX-RF robust? (reading the numbers)

**Yes, for reaching random goals in L1 lockstep:**
- 18/18 arrive-and-hold at seed 0 (Wilson lower bound 82%) and 29/30 including seeds 1–2 on clutter;
- no contact and no falls;
- unchanged at the evaluated K16/ODE10 budget;
- bit-identical on re-run.

**No, for the deployment questions:**
- Stopping at the goal is marginal. Holds often complete 1–4 s after arrival, and one seed never completed. WX was trained and evaluated on *reach*, not *arrive & hold*.
- A 200 ms plan delay breaks stopping and stability (1/12, with a fall and a collision).
- Legs are commanded above the MuJoCo hip limit.

The bundle comparison favours WX, but it is not like for like: WX is *privileged* and plans from the exact boxes, while the bundle plans from simulated LiDAR with unseen cells treated as free.

## 6. Tool errors (excluded) and product/UX issues found

1. **Bug, confirmed by the lead engineer; fix pending release.** WX-RF fails at its first replan on any box-free map.
   - Error: `ValueError: Out of range float values are not JSON compliant`.
   - Cause: the planner reports infinite clearance, which Studio's wrapper copies as `float(inf)` (`studio/flow_policy_worker.py:371`, pipeline clearance fields) into JSON written with `allow_nan=False` (`policy_worker._atomic`). Flow's own `native/plans.json` writes `null`.
   - Repro: Arena → template *Empty floor* → save → Rehearse → WX-RF, any preset.
   - **Affected:** suite `suite-e2d12bc1a09e`; jobs `job-81291a64113d`, `job-2524f6592ff8`, `job-19a0348430a8`, `job-4d2ac4a295dc`, `job-6688bed52256`, `job-71017de4214e` (open #0–#5).
   - Each failed at control step 0, about 3.5 s after launch, and is excluded from all WX statistics. The bundle is unaffected (6/6 on the same scenarios).
   - Before the lead's instruction not to work around it, a copy of the open arena with one distant sentinel pillar was saved (`arena-e283fa0ee715`). **Nothing was run on it.**
2. **UX: the Runs robustness report counts tool/worker errors as policy failures.** The open-floor WX group shows "0/6 source-scorer goals 0% [0–39%]", while "Outcomes in view" omits the same failed runs (`report-open-report.png`). Errors should leave the denominator, or be shown as a separate "n excluded (error)".
3. **UX: repeated identical scenarios count as independent trials.** After the determinism re-run, the clutter WX group reads 18/19, although only 18 distinct scenarios exist (`report-clutter-report.png`). Repeats should be deduplicated by scenario id or content hash, or flagged as repeats.
4. **UX: run labels lose the preset when the arena label contains " · ".**
   - Runs rows show only the first two label parts (`shortLabel`). For these arenas every row reads "Robustness · clutter s7", so presets are told apart only by time.
   - The Rehearse suite table shows label part 2. By code inspection, an arena named by the clutter template ("Clutter (seeded) · seed 7") would show "seed 7" on every row.
   - A structured preset label on the run row would avoid both.
5. **UX/design: random goals rarely require passing obstacles.** Sampling is uniform over the bounds, which extend 3 m behind the start, so only 6/18 obstacle-arena goals were line-of-sight blocked. Two options would help: a "beyond the obstacles / line-of-sight blocked" filter or a forward sector, and showing the blocked fraction in the generator note.
6. **Minor: the Runs Arena filter is truncated.** The select shows "Robustness" for every campaign arena; it should be wider or show a title on hover.

No gateway outage, suite failure or worker failure other than item 1 occurred, and the single-worker lock was never contended.

## 7. Limitations

- **CPU MuJoCo lockstep (L1)** for every latency-0 result: physics pauses while planning, so real-time planner cost (0.9–4.9 s per replan here, against a 160 ms budget) never delays a plan.
- **200 ms runs.** The bundle's L2 is the source latency model with predictive anchoring. WX's L2-approx is a Studio wrapper around a callback that does not model latency.
- **WX is privileged:** it uses the exact boxes and no LiDAR. The WM-v2 execution check is Isaac-trained, and its MuJoCo accuracy is unmeasured.
- **Starts, robot model and budget.**
  - Every run starts from a standing pose; Isaac arena tasks start walking at about 1 m/s.
  - There is one robot model (29-DoF rubber-hand G1) and one tracker (SONIC ONNX).
  - WX runs at the reduced K8/ODE6 budget, except the 4 runs in P5.
- **Small n.**
  - 18 valid WX scenarios at seed 0, with 6 obstructed goals per policy.
  - The Wilson intervals are wide: 82–100% for 18/18.
  - Seed variance was measured on one arena only, and latency at one value only.
- **Simulation scope.** This is MuJoCo, not Isaac, so the WX Isaac numbers do not transfer. Only a 10 s horizon and the arrive-and-hold criterion were run; reach is evaluated post hoc only.
- **Data provenance.**
  - Torque is simulator-commanded.
  - Contact is sampled normal force.
  - Every metric is simulator ground truth from `progress.jsonl` and the source scorer.
- **No hardware, DDS, ZMQ or GPU was involved.**

## 8. Suggested follow-ups

- Re-run the 6 open-floor WX scenarios after the JSON fix is released; the lead plans to do this. Scenario ids are in `campaign_state.json` under the tags `P1:open:*`.
- Check WX latency on the Flow side with a latency-aware callback. Then measure dose-response at 60, 100 and 160 ms on the P3 presets.
- Score WX with `arena_reach` and with arrive-and-hold side by side on more seeds, to separate "cannot stop" from "cannot reach".
- Decide the hip effort limit (139 vs 88 N·m) before reading torque-clamped runs as hardware-plausible.

## Evidence

All under `~/research-data/g1-deploy-studio/evidence/robustness-20261020/`:

| File | Contents |
|---|---|
| `arenas.json` | Arena ids, hashes, template and generator parameters, generated and server presets, boxes, bounds (UI-created) |
| `campaign_state.json`, `suite-*.json`, `progress.log` | Scenario ids per phase tag, suite ids and states, timestamped progress |
| `runs-final.json` | Raw `GET /api/runs` used for the analysis; `runs-after-P*.json` are snapshots after each phase |
| `runs-campaign.json`, `runs-campaign.csv` | Per-run records: outcome, category, derived metrics, torque, behaviour flags, trajectory |
| `summary.json`, `tables.md`, `matrix.md` | Aggregates, paired comparisons, seed variance, torque, determinism, full per-run table |
| `screens/` | Arena editor captures (`arena-*.png`), Runs comparisons (`runs-*.png`), notable behaviours (`notable-*.png`), robustness report panels (`report-*-report.png`) |
| `arenas-extra-UNUSED-workaround-not-run.json` | Record of the unused sentinel-pillar arena |

Reproduce, read-only against an existing campaign:

```bash
node tools/campaign/make_arenas.mjs                       # Step 1: arenas through the UI generator (writes arenas.json)
python3 tools/campaign/campaign.py --evidence <dir>        # Step 2: P1–P6 suites (resumable; --only P3 etc.)
python3 tools/campaign/campaign.py --evidence <dir> --determinism <scenario-id>
.venv/bin/python tools/campaign/analyze.py --evidence <dir>   # Step 3: tables, summary, determinism (numpy for NPZ parity)
node tools/campaign/screens.mjs <spec.json> <dir>/screens     # Runs-workspace captures
```
