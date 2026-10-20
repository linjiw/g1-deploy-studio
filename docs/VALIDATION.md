# Independent validation · 2026-10-20

Scope: every user-facing feature of the cockpit at commit `3f3dfa5` (working tree; this validation added only `docs/VALIDATION.md` and `tools/browser/validation/`), driven through a real browser against a real owned CPU simulation. **81 PASS · 20 FAIL · 0 BLOCKED** across 101 checks. Failures are listed under [Failures](#failures), most severe first.

This is a simulation and UI validation. It is not hardware verification. No robot, DDS or ZMQ connection was made.

## Setup

| Item | Value |
|---|---|
| Gateway | Own instance, `.venv/bin/python -m studio.server --port 8792 --data-root ~/research-data/g1-deploy-studio/validation-workbench --config tools/browser/validation/sessions.validation.json` (`tools/browser/validation/gateway.sh start/stop`), serving the working tree. The user's service on 8790 was only read (`GET /api/version`). |
| Sessions | `config/sessions.json` (sonic-lockstep, sonic-dds-tutorial, wire-local) plus `perf-large-job`, a read-only reference to the 41 MB `session.json` of main-workbench `job-bfc2868af973` (10 s slalom), used for the open-time and playback tests. |
| Browser | Playwright 1.61.1, `/opt/google/chrome/chrome` headless, `--use-gl=angle --use-angle=swiftshader` (software GL), 1600×1000; mobile 390×844 at DPR 2 with touch. |
| Simulation | 14 owned CPU runs, each 2–5 s simulated at K2/ODE4: 12 bundle (`flow-bundle-20261008`) and 2 WX-RF (`flow-wx-rf-23326aa-s0`). Longest wall time about 25 s. No GPU, no training. |
| Error capture | Page errors, console errors, failed requests and HTTP ≥ 400 are collected on every page and attributed to the running check. Expected 4xx (invalid-input tests) and refused connections while the gateway was down are whitelisted per check. A check with unexpected errors is a FAIL. |
| Host | Shared, load average 12–16 on 32 cores. |

### Reproduce

```bash
tools/browser/validation/gateway.sh start                      # port 8792, validation data root
STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/arena.mjs        # §3, no runs (needs < 60 saved arenas)
STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/rehearse.mjs     # §4, ≤ 7 short runs (ONLY=4.7,4.11 to select)
STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/suite_cancel.mjs # §4 suite, 2 runs
STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/cancel_header.mjs # §4.9b, 1 run
STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/replay.mjs       # §1 2 6 7 9, read-only
STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/runs.mjs         # §5, read-only
STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/robustness.mjs   # §8, 2 runs, restarts the 8792 gateway, fills arenas to 64
node tools/browser/validation/report.mjs                        # merged summary → evidence/validation-summary.json
tools/browser/validation/gateway.sh stop
```

`probe_*.mjs` are the one-off diagnostics behind F15, O4, O5 and the 5.4 / 1.9 instrument fixes.

Evidence: `~/research-data/g1-deploy-studio/evidence/validation-20261020/`, outside Git. Per-script results are in `results-<script>.json`, and the merged table is in `validation-summary.json`. Screenshot names below are relative to that directory.

## Checklist

| Section | PASS | FAIL | BLOCKED |
|---|---|---|---|
| 1. Replay | 17 | 2 | 0 |
| 2. Inspector | 9 | 2 | 0 |
| 3. Arena | 17 | 7 | 0 |
| 4. Rehearse | 12 | 4 | 0 |
| 5. Runs | 9 | 0 | 0 |
| 6. Sensors | 4 | 1 | 0 |
| 7. System | 4 | 0 | 0 |
| 8. Robustness and honesty | 6 | 4 | 0 |
| 9. Performance | 3 | 0 | 0 |
| **Total** | **81** | **20** | **0** |


### 1. Replay

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 1.1 | Session picker: groups, outcome marks, policy and id suffix | PASS | CPU rehearsals group listed first; ✓ / ⏱ / ✕ marks, `· wx-rf-23326aa` policy suffix and `#xxxxxx` id suffix match `/api/sessions`. `results-replay.json` |
| 1.2 | Open each configured recording and a job recording | PASS | sonic-lockstep 159 ticks, sonic-dds-tutorial 1922, wire-local 55, bundle job 100, WX job 182; no error banner. `results-replay.json` · `replay-open-sonic-lockstep.png`, `replay-open-sonic-dds-tutorial.png` |
| 1.3 | Transport buttons: play/pause, restart, step forward/back | PASS | step ±20 ms exact; Play label/aria and PLAYING badge; Restart → first frame. `results-replay.json` |
| 1.4 | Keyboard: Space, ←/→, Shift+←/→, J/K/L, F/T/O/G/R, M, 1–7, ? | PASS | all keys on the DDS tutorial (it has a map for M); J/L clamp at 0.25× / 4×; 1–7 select the 7 tabs. `results-replay.json` |
| 1.4b | Shortcuts do not fire while typing in inputs/selects | PASS | typing `3f 7r?` and → in Rehearse › Seed, and `3` in the joint select, fired no shortcut. `results-replay.json` |
| 1.5 | Speed and loop | PASS | 2×/1× clock-rate ratio 2.33; Loop wraps to start; without Loop playback stops at the end (absolute rate is frame-capped, see O4). `results-replay.json` |
| 1.6 | Scrub slider seeks | PASS | slider midpoint click lands within 3 % of the span. `results-replay.json` |
| 1.7 | Lanes canvas: click and drag seek; hover tooltip | PASS | click and drag seek within 1 % of span; tooltips `Planner compute 398.6 ms … deploy replan 160 ms`, `Goal distance 3.542 m`; hides on leave. `results-replay.json` · `replay-lanes.png` |
| 1.8 | Hide lanes toggle | PASS | lanes 150 px → 0 → 150 px, button text toggles. `results-replay.json` · `replay-lanes-hidden.png` |
| 1.9 | Camera buttons incl. Fit shows start+goal; Orbit auto-recenters during playback | PASS | Fit: START and GOAL inside the frame; Orbit at 4× on the 10 s slalom: robot travelled 3.67 m and was re-centred (one sample reached NDC 0.97 at ~3 fps). `results-replay-b.json` · `replay-b-camera-fit.png` |
| 1.10 | Robot view inset renders | PASS | inset label visible, aria-pressed, extra draws. `results-replay.json` · `replay-robot-view.png` |
| 1.11 | Layers popover: each layer toggles its object; unavailable layers disabled | PASS | each layer hides only its own objects (robot, ghost + ref line, futures + plan line, paths, collision scene, markers, sensor layer, axes, map); DDS: Reference disabled; wire: robot/reference/future/path/scene/frames/map disabled. `results-replay.json` |
| 1.11b | Navigation layer is disabled when the recording has no start/goal | **FAIL** | see F17. `results-replay.json` · `replay-fail-1.11b.png` |
| 1.12 | HUD values sane and consistent with the inspector | PASS | HUD goal 3.11 m vs Intent 3.108 m vs frame truth (±0.6 mm); contact 0.0 N vs Health 0.00 N; speed 0.81 m/s, tilt 0.16 rad. `results-replay.json` |
| 1.13 | Evidence key popover | PASS | 8 evidence rows; closes on outside click. `results-replay.json` · `replay-evidence-key.png` |
| 1.13b | Popover buttons reset aria-expanded when the popover closes | **FAIL** | see F18. `results-replay.json` · `replay-fail-1.13b.png` |
| 1.14 | Help popover (button, ?, Escape) | PASS | button, `?` toggle, Escape. `results-replay.json` |
| 1.15 | View link round trip: session/time/panel/camera/speed/loop/map/pin/robot_view/workspace | PASS | `?session=job-8d961faaff59&camera=follow&time=1.234&speed=2&panel=health&loop=1&map=1&robot_view=1&workspace=sensors&pin=base_pose` restored all fields in a fresh page. `results-replay.json` |
| 1.16 | Status bar build id matches /api/version | PASS | `build 3f3dfa5` = `/api/version` commit. `results-replay.json` |

### 2. Inspector

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 2.1 | Intent tab | PASS | navigation target, planner selection, reference window, observed execution; raw reference values expand. `results-replay.json` · `replay-intent.png` |
| 2.2 | Joints tab: row click selects joint; chart cursor follows time | PASS | 29 named rows; row click sets the select and chart (aria label names the joint); cursor x = 30 + t/T·262 at two seeks and after playback; cell equals frame value. `results-replay.json` · `replay-joints.png` |
| 2.2b | Joints: clicking a row highlights it immediately (paused) | **FAIL** | see F16. `results-replay.json` · `replay-fail-2.2b.png` |
| 2.3 | Health tab: outcome, fidelity, torque, budgets, events seek, held state → STALE | PASS | outcome card, fidelity, leg-torque table, 3 budgets; event button seeks to 1.760 s; hold → STALE, `STATE HELD`, `DIAGNOSTIC HELD STATE`; release → SIM-TRUTH. `results-replay.json` · `replay-health-held.png` |
| 2.4 | Map tab: causal perception (bundle), final-snapshot honesty (DDS), unavailable by design (WX) | PASS | bundle: causal snapshot with age; DDS: `Final snapshot without capture time`; WX: `Privileged WX block … No simulated LiDAR`; lockstep: `no map/point cloud was recorded`. `results-replay.json` · `replay-map-bundle.png` |
| 2.5 | Pipeline tab: stage buttons, tensors, conditioning maps, block select | PASS | 5 stage buttons (available / not captured); Flow: 3 conditioning maps with value ranges (uniform at this cursor); ONNX: 2 tensors + block select; `stage=` kept in URL. `results-replay.json` |
| 2.5b | Pipeline cross-links: "Inspect all joints" and "Open sensor browser" | **FAIL** | see F10. `results-replay.json` · `replay-fail-2.5b.png` |
| 2.6 | Graph tab: compact system map, open full map | PASS | compact map 10 nodes; Open full map → System workspace. `results-replay.json` |
| 2.7 | Source tab: provenance and MCAP export download | PASS | profile identity, `Hardware command path None`, artifacts; MCAP downloaded, magic `\x89MCAP0\r\n`. `results-replay.json` |
| 2.8 | Tab arrow-key navigation (wraps; does not step time) | PASS | → moves to Joints, ←← wraps to Source; time unchanged; roving tabindex. `results-replay.json` |
| 2.9 | Inspector resize handle (bounded, persisted) | PASS | 372 → 492 px (+120), clamps at 720, persisted after reload. `results-replay.json` |

### 3. Arena

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 3.1 | Every template loads with expected boxes/presets and passes preflight | PASS | empty 0/1, corridor 2/2, doorway 2/2, slalom 3/2, beam 3/1 (overhead box), U-trap 3/2, clutter 9/2 boxes/presets, all ✓; clutter seed reproducible. `results-arena.json` · `arena-template-empty.png`, `arena-template-corridor.png` |
| 3.2 | Start from existing maps (Flow arenas, beam scene) | PASS | flow-detour 1, flow-slalom 3, flow-corridor 3, beam-scene 2 boxes = `/api/map`; label `· edited`, UNSAVED DRAFT. `results-arena.json` |
| 3.3 | Tools: wall, beam, pillar, start, goal by mouse on the canvas | PASS | wall (2,1) half 1×0.12, z 0–1.2; beam z 1.05–1.25; pillar 0.3 m; start/goal placed by click. `results-arena.json` · `arena-tools.png` |
| 3.4 | Select tool: drag box, resize handles (x, y, corner), rotate handle, drag start/goal/heading | PASS | move, x/y/corner resize, rotate handle → 90°, goal/start drag, heading tip → 90°, empty-space pan. `results-arena.json` · `arena-handles.png` |
| 3.5 | Keyboard: D duplicates, R rotates 15°, arrows nudge, Del removes, Esc deselects | PASS | D (+0.3,−0.3), R ±15°, ↑ 5 cm, Shift+→ 25 cm, Del, Esc; typing `dr⌫⌫` in the name field with a box selected changed nothing; replay keys suppressed. `results-arena.json` |
| 3.6 | Snap toggle: endpoints snap to 5 cm when on, free when off | PASS | snap off keeps 1 mm values, snap on rounds to 5 cm. `results-arena.json` |
| 3.7 | Wheel zoom changes the view and Fit view restores it | PASS | wheel zoom 105 → 192 px/m; Fit restores the fitted view exactly. `results-arena.json` |
| 3.8 | Selected-box numeric fields edit X/Y/length/width/yaw/bottom/top | PASS | X/Y/length/width/yaw/bottom/top fields applied exactly. `results-arena.json` |
| 3.9 | 3D preview toggle shows boxes and start/goal markers | PASS | 3D preview: 5 box meshes + START/GOAL markers + bounds; updates on edit. `results-arena.json` · `arena-preview3d.png` |
| 3.9b | 3D preview toggle stays in sync after the panel re-renders | **FAIL** | see F15. `results-arena.json` · `arena-fail-3.9b.png` |
| 3.10 | Presets: add, rename, mirror, select, remove; 16-preset cap | PASS | add, rename, mirror (y, yaw negated), select, remove; add disabled at 16; mirror respects cap. `results-arena.json` |
| 3.11 | Random goals: count/min/max/seed/heading, same seed reproduces, random start, append | PASS | 6 presets in 1.5–4 m, heading toward goal, all ✓; same seed identical, other seed differs; random start varies; fixed heading; append 6→12→16 (cap). `results-arena.json` · `arena-random-goals.png` |
| 3.11b | Random goals: description keeps one provenance note across regenerations (integer band) | **FAIL** | see F14. `results-arena.json` · `arena-fail-3.11b.png` |
| 3.11c | Random goals: an impossible band does not discard existing presets | **FAIL** | see F9. `results-arena.json` · `arena-fail-3.11c.png` |
| 3.11d | Random goals: same seed reproduces after an intervening random-start generation | **FAIL** | see F13. `results-arena.json` · `arena-fail-3.11d.png` |
| 3.11e | Random goals: the Append option stays selected after Generate | **FAIL** | see F12. `results-arena.json` · `arena-fail-3.11e.png` |
| 3.12 | Preflight: goal inside a wall shows ✕ and Save refuses | PASS | ✕ mark + `goal an obstacle intersects …`; Save → `Fix before saving …`, no POST sent. `results-arena.json` · `arena-preflight-blocked.png` |
| 3.13 | Save arena is immutable: edit + save creates a new id; the old map is unchanged | PASS | arena-a91a2bd8b14a saved; edit → UNSAVED; Save → arena-1e47dbde1d80; old sha256 unchanged. `results-arena.json` |
| 3.14 | Rehearse → opens Rehearse with the saved arena | PASS | Rehearse opens with the saved arena; `Preview · Validation arena A`. `results-arena.json` · `arena-rehearse-from-arena.png` |
| 3.15 | JSON export then import round-trip | PASS | export `{kind: boxes, frame_id: world, units: m}`; import restores label, boxes, presets. `results-arena.json` |
| 3.16 | JSON import of 129 boxes: limit message and Save refuses; placing a box at the cap is refused | PASS | 129-box import → `more than 128 boxes`, Save refused; at 128 a new pillar → `at most 128 boxes`. `results-arena.json` |
| 3.17 | Wall drawn right-to-left (yaw = 180°) can be saved | **FAIL** | see F5. `results-arena.json` · `arena-fail-3.17.png` |
| 3.18 | Box yaw field 180° can be saved | **FAIL** | see F5. `results-arena.json` · `arena-fail-3.18.png` |
| 3.19 | 64-arena limit: Save shows the limit message | PASS | 52 arenas added by API to reach 64; UI Save → `Arena limit reached (64); archive saved arenas first`. `results-robustness.json` · `robustness-arena-limit.png` |

### 4. Rehearse

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 4.1 | Flow research sync text shows the adopted block | PASS | `CONFIGURED Adopted block WX · 2026-10-16 16:13 · commit 4ba73cb`. `results-rehearse.json` |
| 4.2 | Policy cards: select changes profile/budget/wall limit; ADOPTED BLOCK; limitations expand | PASS | 2 cards; WX tagged ADOPTED BLOCK; WX → K8/ODE6, 480 s; bundle → K4/ODE6, 180 s; limitations expand. `results-rehearse.json` · `rehearse-policy-cards.png` |
| 4.3 | Arena / preset selection updates the 3D preview and readout | PASS | preview goal follows preset 0 → 2; readout updates; switching to flow-detour previews its box. `results-rehearse.json` · `rehearse-preview-flow-detour.png` |
| 4.4 | Budget buttons set K/ODE and highlight | PASS | Quick 2/4, Balanced 4/6, Wide 8/6, Deployed 16/10 set fields and highlight. `results-rehearse.json` |
| 4.5 | Criterion select | PASS | criterion kept across a re-render. `results-rehearse.json` |
| 4.6 | Latency select + anchor enabling rules (anchor disabled for WX and for no latency) | PASS | bundle: 0 ms → anchor disabled, 200 ms → enabled + L2 text; WX → disabled (request forces `measured`). `results-rehearse.json` |
| 4.7 | Invalid settings show an error and start nothing (duration 0, 20; K 0) | PASS | `duration must be finite in [1, 10]` (0 and 20), `candidates must be an integer in [1, 16]`; no job started. `results-rehearse-b.json` |
| 4.8 | Run preset (bundle K2/ODE4, 2 s): live attach, frames grow, LIVE badge, Health worker card, recorded result opens | PASS | job-8d961faaff59: LIVE badge, frames 1 → 6, Follow camera, Health with Owned CPU worker; completed → recording opens, `REPLAY · CPU REHEARSAL · L1`, Timed Out chip. `results-rehearse.json` · `rehearse-live-bundle.png`, `rehearse-result-bundle.png` |
| 4.9 | Cancel during a run: status cancelled, UI recovers | PASS | job-808aec2e7337 → cancelled; Run re-enabled, Cancel gone; listed `· no recording` (disabled), never as success. `results-rehearse.json` · `rehearse-cancelled.png` |
| 4.9b | After Cancel the header, outcome chip and transport stop showing LIVE / Running | **FAIL** | see F2. `results-cancel.json` · `cancel-fail-4.9b.png` |
| 4.10 | Run suite: table fills; during run 2 the UI keeps Cancel and attaches the live run | **FAIL** | see F1. `results-suite.json` · `suite-fail-4.10.png` |
| 4.10a | Suite run 2 is attached live to the viewport | PASS | suite run 2 (job-289615aa2f2d) attached live. `results-suite.json` |
| 4.10c | Cancel suite mid-way: current run cancelled, remaining skipped, UI recovers | **FAIL** | see F4 (cancel worked: run 3 skipped, suite cancelled). `results-suite.json` · `suite-fail-4.10c.png` |
| 4.11 | WX run with 200 ms latency: anchor forced/disabled, reload mid-run re-attaches, fidelity badge L2≈ | PASS | job-0df4cd5dd574 (WX K2/ODE4, 200 ms): anchor disabled, request `measured`; reload mid-run re-attached (frames 1 → 8); result badge `L2≈`. `results-rehearse-b.json` · `rehearse-b-live-wx-after-reload.png`, `rehearse-b-result-wx-lat200.png` |
| 4.12 | Bundle run with 200 ms latency: fidelity badge L2 | PASS | job-6dc4c9d6a032 (bundle, 200 ms predict): result badge `L2`, Health `L2 · lockstep with 200 ms planner latency`. `results-rehearse-b.json` · `rehearse-b-result-bundle-lat200.png` |
| 4.13 | Suite label stays within the 100-character limit for a long arena name | **FAIL** | see F8. `results-rehearse-b.json` · `rehearse-b-fail-4.13.png` |

### 5. Runs

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 5.1 | Runs list matches /api/runs | PASS | 13 rows = `/api/runs`; cancelled run shows Cancelled, not a goal. `results-runs.json` · `runs-list.png` |
| 5.2 | Filters: arena, policy, outcome | PASS | policy, outcome and arena filters match API counts. `results-runs.json` |
| 5.3 | Color modes: by outcome / by policy | PASS | colour by policy: one colour per policy, distinct; back to outcome restores. `results-runs.json` |
| 5.4 | Select / deselect updates the comparison canvas | PASS | canvas changes on select, second select, deselect. `results-runs.json` · `runs-compare-one.png` |
| 5.5 | Select all in view (respects filters) | PASS | Select all in view = runs with trajectories under the active filter. `results-runs.json` · `runs-compare-all.png` |
| 5.6 | Robustness report numbers match a hand recomputation from /api/runs | PASS | 3 groups; goals/n, reach/n, Wilson CI text and contact-run counts equal an independent recomputation (but see O1). `results-runs.json` |
| 5.7 | CSV and JSON export download and contain the rows in view | PASS | CSV header + 13 rows; JSON 13 runs + report, no trajectories. `results-runs.json` |
| 5.8 | Replay button opens the run in Replay (Health tab) | PASS | Replay → Replay workspace, Health tab. `results-runs.json` · `runs-replay-from-runs.png` |
| 5.9 | 3D comparison overlay is cleared after leaving Runs | PASS | 3D comparison overlay cleared after leaving Runs. `results-runs.json` |

### 6. Sensors

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 6.1 | Sensors list: available and unavailable sources with reasons | PASS | 13 sources; 8 available, 5 unavailable with reasons (registered cloud, odometry, LiDAR IMU, RGB, depth). `results-replay.json` · `replay-sensors-list.png` |
| 6.2 | Pin up to 3; the 4th is refused with a message | PASS | 3 pinned; 4th → `Unpin a view first: the viewport holds three sensor cards.`; `pin=` in URL. `results-replay.json` · `replay-sensors-pinned.png` |
| 6.3 | Pinned dock cards update while playing | PASS | dock card text changes during 1.5 s playback. `results-replay.json` |
| 6.4 | Pinned point clouds overlay the scene and follow the Layers toggle | PASS | LiDAR raw + filtered overlay (2); Layers › Pinned point clouds hides/shows the sensor layer; dock Unpin removes overlays. `results-replay.json` · `replay-overlay-off.png`, `replay-overlay-on.png` |
| 6.5 | WX recording: perception unavailable by design in Sensors | **FAIL** | see F11. `results-replay.json` · `replay-fail-6.5.png` |

### 7. System

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 7.1 | System: node click updates details | PASS | LiDAR / SONIC / PD detail headers; Enter key selects Flow. `results-replay.json` |
| 7.2 | System: deploy-topology toggle | PASS | toggle → `Real-time deployment (source-configured)`, 0 → 12 dashed configured edges; back restores. `results-replay.json` · `replay-system-deploy.png` |
| 7.3 | System: contract tables render | PASS | 3 contract tables; joint table 29 rows = `/api/robot`. `results-replay.json` · `replay-system-contract.png` |
| 7.4 | System: discrepancy cards sorted by severity | PASS | 15 cards: high ×3, medium ×7, low ×5 in order. `results-replay.json` |

### 8. Robustness and honesty

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 8.1 | Restart the gateway (and its worker, as systemd does) mid-run → job recovered as failed with a reason, never success | PASS | job-6cdb3918e2c4: gateway + worker SIGTERM mid-run; after restart `failed` — `Gateway ownership was interrupted; no worker lock or successful completion receipt remains.`; job card failed; Runs row failed, no outcome (header issue → F2). `results-robustness.json` · `robustness-gateway-down.png`, `robustness-gateway-recovered.png` |
| 8.1b | After a gateway restart the open page can still POST (CSRF token refreshed) without a reload | **FAIL** | see F6. `results-robustness.json` · `robustness-fail-8.1b.png` |
| 8.1c | Plain SIGTERM of the gateway only (worker survives): job shown detached, never success until its completion receipt exists | PASS | job-542f8c005376: gateway-only SIGTERM, worker survived → `detached` → `completed` only once `result.json` said completed. `results-robustness-b.json` |
| 8.1d | A detached job that completes after the restart is replayable (Runs → Replay opens it) | **FAIL** | see F3. `results-robustness-b.json` · `robustness-b-fail-8.1d.png` |
| 8.2a | Reload the page mid-run (in Rehearse) re-attaches to the live job | PASS | reload in Rehearse re-attached (frames 1 → 6, LIVE). `results-robustness.json` · `robustness-reload-in-rehearse.png` |
| 8.2b | Reload while in Replay during a live run keeps the live view updating | **FAIL** | see F7. `results-robustness.json` · `robustness-fail-8.2b.png` |
| 8.3 | UI through a Host-preserving TCP tunnel (localhost:<other port>) | PASS | `http://localhost:38995` tunnel: page, session, arena Save (POST) work; foreign Host → 403. `results-robustness.json` |
| 8.4 | Mobile 390×844: no horizontal scroll; core controls reachable in every workspace | PASS | scrollWidth = 390 in all 6 workspaces; Play tappable; picker, rail, Arena Save reachable (rail scrolls; see O7). `results-robustness.json` |
| 8.5 | No console errors or failed HTTP requests across all flows | **FAIL** | only 2 unexpected errors across all flows, both inside failing checks: the `__workbench` TypeError (F10) and the `Unknown session or resource` console error (F3); no other unexpected HTTP ≥ 400 or failed request (whitelisted: invalid-input 422s, gateway-down window). `validation-summary.json` |
| 8.6 | Honesty scan: no NaN/undefined/null/[object] text; unavailable stays "Unavailable" | PASS | no NaN/undefined/null/[object]/Infinity in HUD, inspector or captions for 5 sessions × 7 tabs; DDS/wire budgets `Unavailable`. `results-replay.json` |

### 9. Performance

| # | Feature | Result | Evidence / notes |
|---|---|---|---|
| 9.1 | Time to open a large job session (41 MB JSON) | PASS | 41 MB JSON (14.1 MB gzip on the wire), 500 frames: cold open 4.3 s, warm 1.7 s. `results-replay.json` |
| 9.2 | Frames rendered while idle (paused) stay flat | PASS | 0 draws in 2 s while paused. `results-replay.json` |
| 9.3 | Playback responsiveness: no main-thread stall > 200 ms during 5 s of 4× playback | PASS | 0 stalls > 200 ms (max 35 ms) by MessageChannel heartbeat; 2.4 fps rendering under software GL; longtask observer inert here (O5). `results-replay.json` |

## Failures

Ordered by severity. Each was reproduced in the real UI on the validation gateway (port 8792, commit `3f3dfa5` working tree). "Suspected" lines are from reading the code after the failure was observed; they are not patched (Studio product code was not edited).

### F1 · High · A running suite never shows Cancel, and Run preset / Run suite stay enabled (4.10)
- **Repro:** Rehearse → arena with 3 presets → bundle, Quick 2/4, 3 s → **Run suite · 3 runs**. Watch the action bar during run 1 and run 2.
- **Expected:** the Cancel button is present and the Run buttons are disabled while any suite run is active.
- **Actual:** during both run 1 and run 2 the bar shows only **▶ Run preset** and **Run suite · 3 runs**, both enabled; no Cancel (`suite-suite-run2.png`, `rehearse-suite-running.png`). The suite can only be cancelled after leaving and re-entering Rehearse, which forces a re-render (used as the workaround in 4.10c). Clicking Run during a suite only gets a server refusal.
- **Suspected:** `apps/web/js/rehearse.js:185` replaces `rh.job` with a stub `{status: 'running'}` before calling `poll()`. `poll()` then sees no status change (`rehearse.js:173`) and calls only `renderJob()`, so `render()` never redraws the action bar with `active = true`.

### F2 · High (honesty) · After Cancel (or a gateway-interrupted run) the header keeps claiming a live, running simulation (4.9b)
- **Repro:** Rehearse → Run preset (bundle, 3 s) → Cancel when live. Wait.
- **Expected:** the header, outcome chip, transport and Health show the run as cancelled or stopped, not live.
- **Actual:** the job card says **Cancelled**, but the mode badge still reads `● LIVE CPU SIMULATION · L1`, the outcome chip `● Running`, the transport badge `LIVE`, and Health `LIVE CPU WORKER`. It stays that way indefinitely (job-d5f38bf10504, `cancel-after-cancel.png`; also `rehearse-cancelled.png`). The same stuck LIVE/Running header appears after a gateway restart recovered the run as **failed** (`robustness-gateway-recovered.png`). After a suite cancel, it shows LIVE + Running + `RUN COMPLETED` at the same time (`suite-fail-4.10c.png`).
- **Suspected:** `apps/web/app.js:311-319` (`rehearse:finished`) only acts when `job.result_session_id` exists. With no recording, the live session's `metadata.mode` stays `simulation`, so `updateModeBadge` (`app.js:110-118`) keeps rendering LIVE/running. `app.js:305-306` copies the worker's `latest.status`, not the job status.

### F3 · Medium · A run that completes while its gateway was restarted is listed as replayable but cannot be opened (8.1d)
- **Repro:** Start a run. SIGTERM only the gateway, so the worker (own session) survives. Restart the gateway and wait for the job to turn `completed`. Then Runs → **Replay** on that row.
- **Expected:** the recording opens (Runs says `replayable: true` and the job has `result_session_id`).
- **Actual:** `/api/sessions` does not list it, `GET /api/session?id=job-542f8c005376` → 404, and the UI shows `Cannot open this recording: Unknown session or resource` plus a console error (`robustness-b-detached-replay.png`). The recording only becomes openable after another gateway restart.
- **Suspected:** `studio/workbench.py:444-461` (`_reconcile_recovered`) sets `status='completed'` and `result_session_id` but never calls `_register_result` (`workbench.py:482`). Only `_reload_jobs` at start-up registers results.

### F4 · Medium · A cancel that races worker finalization discards a completed recording and mislabels the run (4.10c)
- **Repro:** Run suite (3 × 3 s). Cancel during run 2 when it is near the end of its simulation.
- **Expected:** a single consistent state. Either the run was cancelled (no policy outcome, excluded from the trial counts), or it completed and stays replayable.
- **Actual:** job-289615aa2f2d is `cancelled` in `/api/jobs`, yet the worker exited 0 and wrote `result.json` (`status: completed`, 3.0 s) and a 12.5 MB `session.json`. Its recording is not registered (`result_session_id: null`, Runs `replayable: false`). The suite table shows **Timed out** for the cancelled run and counts `2/3 finished`, and the run is counted as a timeout trial in the robustness report (n = 9 group).
- **Suspected:** `studio/workbench.py:739-740` lets `status == 'cancelling'` override a clean exit with a completed receipt. `workbench.py:1028-1030` copies the scorer outcome into the suite run regardless of status. `apps/web/js/rehearse.js:218` and `apps/web/js/runs.js:24` count any run that has an outcome.

### F5 · Medium · Arenas containing a 180° box cannot be saved (3.17, 3.18)
- **Repro:** Arena → Empty → Wall tool → drag from (3, 1.5) to (1, 1.5), i.e. right to left → Save arena. Or select any box and type Yaw ° = 180 → Save.
- **Expected:** saved (180° is a valid wall orientation).
- **Actual:** `box yaw must be finite in [-3.141592653589793, 3.141592653589793]`; nothing is saved. Any box whose yaw rounds above π at 6 decimals triggers it, which includes every horizontal wall drawn right to left (common with 5 cm snapping) and a box rotated to 180° with R.
- **Suspected:** `apps/web/js/arena.js:322` exports `Number(b.yaw.toFixed(6))`, which rounds π up to 3.141593 > π. `studio/workbench.py:189` validates against exactly ±π. Wrapping after rounding, or a small server tolerance, would fix it.

### F6 · Medium · After a gateway restart the open page cannot save or run until reloaded (8.1b)
- **Repro:** Open the UI, restart the gateway, then (without reloading) Arena → Save arena. Run preset and every other POST use the same cached token.
- **Expected:** the page recovers, for example by refetching the token on 403.
- **Actual:** `Same-origin preparation token required` (HTTP 403). It persists until a manual reload (`robustness-fail-8.1b.png`).
- **Suspected:** `apps/web/app.js:362` caches the catalog and token once. `studio/workbench.py:331` generates a new token per gateway start, and `util.js:request` never refreshes it.

### F7 · Medium · Reloading during a live run while in Replay freezes the live view (8.2b)
- **Repro:** Run preset → while live, click the Replay rail → reload the page (URL `?session=<job>`).
- **Expected:** the live run keeps updating, as it does after a reload in Rehearse (8.2a passes).
- **Actual:** the viewport shows `● LIVE CPU SIMULATION · L1` / `LIVE`, but the frame count stays at 1 (1 → 1 over 2.5 s) until the user opens Rehearse (`robustness-reload-in-replay.png`).
- **Suspected:** live polling starts only from `initRehearse → refreshActive` (`apps/web/js/rehearse.js:20, 156`), and `app.js:309` attaches only when `workspace === 'rehearse'`.

### F8 · Low-Medium · Run suite is refused for a long arena name (4.13)
- **Repro:** Save an arena whose name is around 96 characters (the field allows 100) → Rehearse → Run suite.
- **Actual:** `Label must contain 1–100 characters`; no suite starts.
- **Suspected:** `apps/web/js/rehearse.js:146` builds the suite label without `.slice(0, 100)`. The scenario label at `rehearse.js:122` is sliced; the server `label()` enforces 100.

### F9 · Low-Medium · Random goals with an infeasible band deletes all existing presets (3.11c)
- **Repro:** Arena → Slalom (2 presets) → Random goals: count 4, min 30, max 40 → Generate.
- **Actual:** the message `Only 0 of 4 goals fit …` appears, and the preset list is now empty (2 → 0).
- **Suspected:** `apps/web/js/arena.js:67` assigns `arena.presets = out` even when `out` is empty.

### F10 · Low-Medium · Pipeline "Open sensor browser" throws (2.5b)
- **Repro:** Replay a bundle job → Pipeline → 01 Sensors → **Open sensor browser**.
- **Actual:** nothing happens; page error `Cannot read properties of undefined (reading 'workspace')`.
- **Suspected:** `apps/web/pipeline.js:57` calls `window.__workbench.workspace('sensors')`. `__workbench` is defined only in the legacy `apps/web/workbench.js:266`, which `index.html` does not load. It should call `window.__studio.setWorkspace`.

### F11 · Low (honesty wording) · Sensors for a WX recording do not say perception is unavailable by design (6.5)
- **Repro:** Replay a WX-RF job → Sensors.
- **Actual:** LiDAR and map cards show the generic replay reasons: `No support-map snapshot was recorded.` and, for raw LiDAR, `Raw MID-360 packets were not recorded; a final map cannot reconstruct them.` (there is no final map in a WX run). The Map tab correctly says `Privileged WX block … No simulated LiDAR was generated`.
- **Suspected:** `studio/sensors.py:42-44` (`_MISSING`) is used for every session. It ignores `metadata.privileged_map` and the session's `perception.reason`.

### F12 · Low · The Random goals "Append" option resets after each Generate (3.11e)
- **Repro:** Tick Append → Generate → Generate.
- **Actual:** the second Generate replaces the appended set, because the checkbox re-renders unchecked.
- **Suspected:** `apps/web/js/arena.js:410` renders `rg-append` without `checked`. `arena.rg.replace` is stored but not used for rendering.

### F13 · Low · "Same seed → same presets" fails after a random-start generation (3.11d)
- **Repro:** Slalom → seed 42 (fixed start) → note the presets → seed 42 with Random start → untick Random start → seed 42 again.
- **Actual:** different presets (start [0,0] → [0.85,1.55]). The fixed start is taken from the currently active preset, which is now a random one, and the description does not record it.
- **Suspected:** `apps/web/js/arena.js:54` (`base = arena.presets[arena.active]`) and `arena.js:68` (`active = 0`).

### F14 · Low · Random-preset provenance notes accumulate in the arena description (3.11b)
- **Repro:** Random goals with an integer band (min 2, max 4) → Generate × 3.
- **Actual:** the description contains the note three times.
- **Suspected:** the regex at `apps/web/js/arena.js:70` assumes the note has three periods, which is true only when both distances have decimals.

### F15 · Low · The 3D preview toggle desynchronises after a panel re-render (3.9b)
- **Repro:** Arena → 3D preview → + Add preset → click 3D preview.
- **Actual:** after the re-render the button shows not-pressed while 3D is on. The next click turns 3D "on" again; it takes two clicks to return to the 2D editor.
- **Suspected:** `apps/web/js/arena.js:395` hard-codes `aria-pressed="false"`, and `arena.js:430` derives the next state from that attribute instead of `arena.preview3d`.

### F16 · Low · Clicking a joint row does not highlight it until the cursor moves (2.2b)
- **Repro:** Replay a job, paused → Joints → click a row. The select and chart switch to that joint, but the row stays unhighlighted until the next seek or step.
- **Suspected:** `apps/web/js/inspector.js:72-74` updates the select and the chart but not `row.classList`. That is done only in `updateJoints` on the next frame.

### F17 · Low · The Start / goal layer is never disabled when there is no start or goal (1.11b)
- **Repro:** wire-local and sonic-lockstep have no `goal_xy`, yet Layers › Start / goal (and Pinned point clouds on wire-local) stay enabled and toggle nothing.
- **Suspected:** `apps/web/app.js:81` disables only robot / future / trajectory / environment / frames / reference.

### F18 · Low (accessibility) · Popover buttons keep `aria-expanded="true"` after the popover closes (1.13b)
- **Repro:** closing Evidence key or Layers by an outside click or Escape hides the popover but leaves `aria-expanded="true"`.
- **Suspected:** `apps/web/app.js:462, 502` hide popovers without resetting their buttons; only `togglePopover` (`app.js:429`) sets the attribute.


## Observations (not counted as checklist results)

- **O1 · Robustness report denominators include non-policy terminations.** The bundle K2/ODE4 group reports `0/9`. Its n includes job-6cdb3918e2c4 (`failed`: gateway restart, infrastructure) as an *error* trial and job-289615aa2f2d (`cancelled`, see F4) as a timeout. The arithmetic matches the rows (5.6 PASS), but infrastructure interruptions arguably belong outside a policy success-rate denominator (`apps/web/js/runs.js:24`).
- **O2 · Error callouts are never cleared within a workspace.** `candidates must be an integer in [1, 16]` stayed on screen through three later successful runs (`rehearse-suite-running.png`), and `Failed to fetch` stayed after the gateway recovered (`robustness-gateway-recovered.png`). `#workbench-error` is hidden only on a workspace change (`apps/web/app.js:371`).
- **O3 · After a reload mid-run, the live view starts from the reload.** The re-attached session had 1 frame and grew from there; the earlier trajectory appears only when the recording opens. This is correct, but nothing tells the user the history is missing.
- **O4 · The playback clock is tied to rendered frames.** Under software GL (SwiftShader, ~1.5 M triangles per frame) the scene renders at 2.4–4 fps while playing. JS per frame is under 13 ms and the main thread never stalls more than 40 ms, so the bottleneck is GPU-process rasterisation. Because `dt` is capped at 0.25 s (`apps/web/app.js:227`), "1×" advances at only 0.43–0.51× wall-clock, and the UI does not show this. No GPU host was available to measure hardware rendering.
- **O5 · Long-task measurement.** `PerformanceObserver({type: 'longtask'})` reports nothing in this headless Chrome, even for a deliberate 300 ms busy loop. Check 9.3 therefore uses a MessageChannel heartbeat.
- **O6 · Documentation drift.** `docs/WORKBENCH.md` says "Tick up to 12 runs" to compare; the code allows 64 and silently refuses the 65th (`apps/web/js/runs.js:126`). It also says a suite runs "at most 12 runs", while the server allows 48 (`MAX_SUITE_RUNS`) and the UI offers up to 16 presets × 4 seeds = 64 (not exercised).
- **O7 · Mobile 390 px.** There is no page-level horizontal scroll. However, the rail scrolls sideways (System is partly off-screen until scrolled), the viewport title is overlapped by the Layers button, and lane labels run into "Unavailable in this recording" (`robustness-mobile-replay.png`). The transport is hidden in Arena, Runs and System, which use 2D stages.
- **O8 · Pressing Play on a navigation run switches Fit to Follow** (`apps/web/app.js:213`). This is intentional (review UX-2) and was not counted.
- **O9 · Live frame rate.** Live attach updated at about 3 Hz as documented; WX live frames arrive about once per replan (8 frames in 3 s).


## Instrument corrections made during validation

These were defects in the validation scripts, found and fixed before the final runs. They are not product findings.
- The page CSP forbids `eval`, so scene inspection uses `import('/js/scene.js')`, which returns the page's own module instance.
- Chrome logs every HTTP error twice (response and console). The console copy is now attributed to the response check, so expected 422s are not counted twice.
- Clock-rate checks use `setPlaying()` and a 2×/1× ratio rather than click timing.
- Camera projections are read after the slow software renderer has drawn the new frame.
- Sensor unpinning re-queries the re-rendered dock.
- The first rehearse pass was stopped during 4.11, because a 2 s WX run finished before the reload completed. 4.7 and 4.11–4.13 were re-run (`results-rehearse-b.json`), and the suite checks were re-run with 3 s runs and fast server polling (`results-suite.json`).
- In 5.4, a re-drawn comparison differs from the first draw only by canvas antialiasing; it is visually identical (`probe-compare-a.png` / `probe-compare-c.png`).

## State left behind

- `~/research-data/g1-deploy-studio/validation-workbench/` holds 14 jobs, 2 suites, 64 arenas (filled by the limit test) and the saved scenarios. It is separate from the user's workbench and can be deleted.
- The 8792 gateway was stopped at the end of the validation. No reference repository, service, environment or product file was modified.
