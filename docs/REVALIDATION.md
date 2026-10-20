# Independent re-validation · 2026-10-20

Scope: every FAIL in [VALIDATION.md](VALIDATION.md) (run against `3f3dfa5`), every fix listed in commits `1e80684` and `6dbb261`, and a regression pass over the core flows. The product code under test is the working tree at **`15959b7`**. This re-validation added scripts under `tools/browser/validation/` and this document. It changed no product code.

**111 PASS · 7 FAIL · 0 BLOCKED** across 118 checks, plus 221 unit tests OK (2 skipped). The 7 FAILs come from 5 distinct defects. Two FAILs are side effects of N3: 4.13 and 8.5 (unexpected errors). The lead reports that 4 of the defects (N1–N4, covering 6 FAIL rows) are **fixed in `codex/v0.3-fixes`** (commits `101d7b0`, `15491e0` after rebase) and **verified by the lead against the fix build**. This document records the original results on `15959b7`. The fix build was not re-verified here. N5 was open at the time of this report; it was fixed afterwards in `6065846`. The re-run of the fixed build is under **Fix verification** at the end.

This is a simulation and UI validation, not hardware verification. No robot, DDS or ZMQ connection was made.

## Previous failures: status

| Previous | Check(s) | Status on `15959b7` | Evidence |
|---|---|---|---|
| F1 · suite never shows Cancel; Run enabled | 4.10, 4.10a | **PASS** | Cancel shown and Run preset / Run suite disabled during run 1 and run 2; run 2 is attached live. `reval-rehearse-suite-run1.png`, `reval-rehearse-suite-run2.png` |
| F2 · header stays LIVE after cancel / restart failure / suite cancel | 4.9b, 4.9b-restart, 4.10c | **PASS** | `RUN CANCELLED · PARTIAL LIVE SAMPLES` / `RUN FAILED · PARTIAL LIVE SAMPLES`. Chip `cancelled`/`failed`, transport `RUN CANCELLED`/`RUN FAILED`, Health `PARTIAL LIVE SAMPLES · RUN ENDED WITHOUT RECORDING`, warning callout. `reval-rehearse-after-cancel-header.png`, `reval-restart-gateway-recovered.png`, `reval-rehearse-suite-cancelled.png` |
| F3 · run finishing during a gateway restart not replayable | 8.1d | **PASS** | job-70f9fe304788: `detached` → `completed` with `teardown_warning: Recovered after gateway restart…`. Right after completion, `/api/sessions` lists it, `GET /api/session` → 200, the Runs row is replayable, and Runs → Replay opens the recording (no second restart). `reval-restart-b-detached-replay.png`. The open page itself does not follow (see N4 / 8.1e). |
| F4 · cancel racing completion discards a completed run | 4.10c, 4.10c-race-job, 4.10c-race-suite | **PASS** | UI suite cancel: run 2 `cancelled` (no outcome), run 3 `skipped`, table `1/3 finished`. Race, single job: cancel POSTed the instant `result.json` appeared, while the worker was still alive; the cancel was accepted (`cancelling`), and the job still ended `completed`, exit 0, replayable. Race, suite: suite cancel at `session.json`; the run stayed `completed` with its outcome and replayable, and the suite ended `cancelled`. `results-reval-race.json` |
| F5 · 180° box cannot be saved | 3.17, 3.18 | **PASS** | Both saved; the server stores yaw `3.141592653589793`. `probe-label-click.json`. Only passes when the name field is blurred first (see N1). |
| F6 · no POST after a gateway restart without reload | 8.1b, 8.1b-run | **PASS** | Save arena after a restart (403 → token refresh → 201), and Run preset after an idle restart, both without reload |
| F7 · reload in Replay during a live run freezes | 8.2b | **PASS** | Frames 1 → 5 in 1.2 s after the reload in Replay; the recording then opens automatically. `reval-restart-reload-in-replay.png` |
| F8 · long arena name breaks suite label | 4.13 | **FAIL** (label fixed) | The suite for a 96-character name was accepted; label exactly 100 characters. The check fails only on the unexpected 422 / console error from **N3**. Fixed in `codex/v0.3-fixes`, verified by the lead against the fix build |
| F9 · impossible band wipes presets | 3.11c | **PASS** | `Only 0 of 4 …`, presets kept |
| F10 · Open sensor browser throws | 2.5b | **PASS** | Opens Sensors |
| F11 · WX Sensors wording | 6.5 | **PASS** | All 5 perception channels (raw/registered/filtered LiDAR, support/ceiling map): `Unavailable by design: this privileged policy planned from the exact configured boxes…`. `reval-rehearse-sensors-wx.png` |
| F12 · Append resets | 3.11e | **PASS** | |
| F13 · same seed differs after random start | 3.11d | **PASS** | The fix introduced N2 |
| F14 · notes pile up | 3.11b | **PASS** | One `[random: …]` note after 3 generations |
| F15 · 3D preview toggle desync | 3.9b | **PASS** | |
| F16 · joint row not highlighted | 2.2b | **PASS** | |
| F17 · Start/goal layer enabled without goal | 1.11b | **PASS** | |
| F18 · aria-expanded not reset | 1.13b | **PASS** | |
| 8.5 · console errors / failed requests | 8.5 | **FAIL** | Only N3 (2 × 422 + 2 console errors, same root cause). Fixed in `codex/v0.3-fixes`, verified by the lead against the fix build |
| O1 · error runs in report denominators | 5.10 | **PASS** | `1 error run excluded from rates`; the error category is absent from the rates |

## Review fixes: status

| Fix | Check | Status | Evidence |
|---|---|---|---|
| WX run on an empty map completes | B.wx-empty | **PASS** | job-cba7e3cd30bb: `flow-wx-rf-23326aa-s0` on `flat-ground` (0 boxes), K2/ODE4, 2 s, 200 ms: `completed`, replayable (timeout at 0.37 m: completion, not success). 5.2 s wall |
| System workspace: LiDAR/perception/route edges not used | B.system | **PASS** | `lidar-perception`, `state-perception`, `perception-route` are dotted at 0.35 opacity with `not used: privileged block`. `route-flow` is `privileged cost route on exact boxes (SIM-TRUTH)`. LiDAR/Perception nodes are badged `not used (privileged)`, and the panel reads `PRIVILEGED block…`. `reval-rehearse-system-wx.png` |
| Graph tab, same | B.graph | **PASS** | Same edges; intro `PRIVILEGED block…`. `reval-rehearse-graph-wx.png` |
| PRIVILEGED MAP chip | B.priv-chip | **PASS** | Visible for WX, hidden for bundle. `reval-rehearse-privileged-chip.png` |
| Robot view says approximate viewpoint (WX) | B.robot-view | **PASS** | WX: `ROBOT VIEW · approximate viewpoint 0.45 m above the pelvis (no mount extrinsics…)`. Bundle: `recorded MID-360 mount pose` |
| Running suite refuses a manual Run preset | B.suite-refuses | **PASS** | No manual job ever started. A stale second tab (Run still enabled) → `A simulation job is already active`. 12 API POSTs across the run 1 → run 2 gap → 6 × `Suite suite-… is running; cancel it or wait before starting another run`, 6 × `A simulation job is already active` (all 422) |
| Runs newest first after a gateway restart | B.order | **PASS** | `/api/runs` is sorted by `started_unix_s` descending, the UI order equals the API order, and the newest run is first after 3 restarts |
| Report: error run excluded; identical re-run counted once | 5.6, 5.10, 5.11 | **PASS** | Bundle lat-0 K2/ODE4 group: 4 runs of one scenario → `3 identical re-runs counted once`. job-f620490a39f1 (killed by restart) → `1 error run excluded from rates`; n = 3. An independent recomputation matches |
| Same, edge case | 5.13 | **FAIL (N5)** | See N5 |
| Run rows show `<arena> · <preset name>` | 5.12 | **PASS** | Every row with `preset_label`; the full label is in the tooltip |
| Random goals "Behind an obstacle" | 3.11f, 3.11h | **PASS** | Slalom, seed 3: 8 saved presets. Independent 1 cm sampling against each footprint: 7 lines cross a box strictly, 1 passes within the 0.15 m pad. The same seed without the option gives 4 clear lines. On an empty arena: `Only 0 of 4`, presets kept |
| Latency select + anchor rules | 4.6 | **PASS** | Bundle 0 ms → anchor disabled; 200 ms → enabled + L2 text; WX → disabled, request forces `measured` |
| Fidelity badge L2 / L2≈ | 4.12, 4.11 | **PASS** | Bundle 200 ms predict → `REPLAY · CPU REHEARSAL · L2` + Health `L2 · lockstep with 200 ms planner latency`; WX 200 ms → `L2≈` |
| Health torque card for a new run | B.torque | **PASS** | `Leg torque vs model limit`, table rows present |
| `release` refuses while a job is active | B.release-guard, B.release-guard-job | **PASS** | Read the script logic. Ran its `active_runs` function (extracted with `sed`) plus the same refusal test against **this gateway (8795)**. During a suite: `WOULD REFUSE: job-9baf7117361e suite-e5c3fd366b21`; during a single job: `WOULD REFUSE: job-bfbfd767e879`; idle: `WOULD RELEASE`. `release` / `restart` were never called. See O4 |

## New failures (most severe first)

Each repro is on `15959b7` (gateway on 8795, own data root). N1–N4 are fixed in `codex/v0.3-fixes` and verified by the lead against the fix build (root causes from the lead). N5 is open.

### N1 · Medium · First click after typing an arena name is swallowed (3.20) · fixed in `codex/v0.3-fixes`
- **Repro:** Arena → Corridor → click the name field, type a name → click **Save arena** once.
- **Expected:** saved.
- **Actual:** nothing: no POST, no message. The second click saves. The same happens to **+ Add preset** (presets 2 → 2) and any other panel button clicked while the name field has focus. This silently hides the primary save action, and it also broke the old 3.13, 3.17, 3.18 and 8.3 instruments. `reval-arena-extra-first-click-lost.png`, `probe-label-click.json`
- **Cause (lead):** `apps/web/js/arena.js:446` re-rendered the panel on the field's `change` event. Blur from the mousedown replaced the clicked button before `click` fired. Added in `1e80684`.

### N3 · Low-Medium · Cancelling a suite before its first run is attached re-attaches the previous run (N3; also 4.13, 8.5) · fixed in `codex/v0.3-fixes`
- **Repro:** Rehearse → Run preset → Cancel when live (no recording). Then **Run suite** → press **Cancel** as soon as it appears, before the first suite run is picked up (within about 1 s).
- **Expected:** the suite is cancelled. The previous run stays closed and no error appears.
- **Actual:** the error banner shows `Cannot open this recording: [Errno 2] No such file or directory: '/home/linjiw/research-data/…/jobs/job-3f497ae0f65d/run/session.json'`, exposing the absolute server path. `GET /api/session` returns 422 and the console logs an error. **Current run** shows the *previous* job; the suite's own cancelled run never appears. Reproduced 2/2 (`reval-rehearse-long-name-suite.png`, `reval-stale-cancel-stale-cancel.png`).
- **Cause (lead):** the stale `rh.job` was polled after a suite started. A run without a recording returned a raw FileNotFoundError as 422; it now returns 404 "no replayable recording", and terminal runs without a recording are never attached.

### N4 · Low-Medium (honesty) · After a gateway-only restart the open page claims the run ended without a recording (8.1e) · fixed in `codex/v0.3-fixes`
- **Repro:** Run preset → SIGTERM only the gateway (the worker survives) → restart it. Do not reload the page.
- **Expected:** the page keeps following the detached run and opens its recording when it completes.
- **Actual:** badge `RUN DETACHED · PARTIAL LIVE SAMPLES`, Health `PARTIAL LIVE SAMPLES · RUN ENDED WITHOUT RECORDING`. Polling stops. About 3 s later the run completes with a recording, but the page still says it ended without one, and the `Failed to fetch` callout stays. Reproduced 2/2 (job-ca2643abc222, job-70f9fe304788; `reval-restart-b-detached-open-page.png`). Runs → Replay does open the recording (8.1d PASS). The state does not arise under systemd, whose stop kills the whole unit cgroup.
- **Cause (lead):** Rehearse treated `detached` as finished and stopped polling; it now follows the run to its recording.

### N2 · Low-Medium · Random goals reuse the first base start of the page session (3.11g) · fixed in `codex/v0.3-fixes`
- **Repro:** Arena → Slalom → Random goals → Generate. Then Doorway → select **Offset approach** (start `[0, −1.2]`) → Generate.
- **Expected:** presets start at `[0, −1.2]`.
- **Actual:** all presets start at `[0, 0]`, and the description records `start fixed (0, 0)`. Moving the start or switching arena never changes the base again in that page. On an arena where `[0, 0]` is blocked or out of bounds, this gives a misleading `Only 0 of N fit`. `reval-arena-extra-stale-base.png`
- **Cause (lead):** a sticky `rg.baseStart`, introduced by the F13 fix.

### N5 · Low · Report drops a scored trial when its latest identical re-run is an error (5.13) · fixed in `6065846`
- **Repro:** shipped `report()` from `/js/runs.js`, rows: scenario s1 `goal_completion` at t=1, the same s1 `failed` (worker error) at t=2, and s2 `timeout` at t=3.
- **Expected:** s1 counts once, from its scored run: n = 2, goals = 1, 1 error listed.
- **Actual:** n = 1, goals = 0, errors = 1, repeats = 1. The goal disappears from the report, and the row is reported as "1 error run excluded" rather than a repeat of a scored scenario. Demonstrated on synthetic rows through the real function; no live repro was spent on it.
- **Suspected:** `apps/web/js/runs.js:30-35`: latest-by-start dedupe happens before error exclusion. Dropping errors first, then keeping the latest scored run per scenario, would fix it.

## Regression pass

| Area | Result | Notes |
|---|---|---|
| Replay 1.1–1.16 | 19/19 PASS | Includes view-link round trip, keyboard, layers, Fit/Orbit, robot view, build id |
| Inspector 2.1–2.9 | 10/10 PASS | MCAP export magic OK |
| Arena 3.1–3.18 | 23/23 PASS | After the instrument blurs the name field (N1); new 3.11f/3.11h PASS |
| Rehearse | PASS | 4.8 live attach (frames grow, LIVE badge, Follow camera, Health worker card, result opens); 4.9 cancel |
| Runs 5.1–5.9 | 9/9 PASS | Filters, colours, compare overlay, CSV/JSON export, Replay button, overlay cleared |
| Sensors 6.1–6.4 | 4/4 PASS | |
| System 7.1–7.4 | 4/4 PASS | |
| Recovery 8.1, 8.1c, 8.2a | PASS | Gateway + worker kill → `failed` with `Gateway ownership was interrupted…`; detached never shown completed before its receipt |
| Host-preserving tunnel 8.3 | PASS | `localhost:40069` → page, session, Save; foreign Host → 403 |
| Mobile 390×844 8.4 | PASS | `scrollWidth = 390` in all 6 workspaces |
| Honesty 8.6, performance 9.1–9.3 | PASS | 41 MB session cold 4.6 s / warm 2.0 s; 0 stalls > 200 ms (max 24 ms) |
| Unit tests | 221 OK, 2 skipped | `.venv/bin/python -m unittest discover -s tests`, `unit-tests.txt` |

## Observations (not counted)

- **O1 · 1× playback is still below real time under software GL.** Measured 0.75× at 1× and 1.23× at 2× (about 2.6 fps under SwiftShader), up from 0.43–0.51×. The frame-time cap is 0.5 s (`apps/web/app.js:241`), and the UI does not show the slowdown.
- **O2 · Error callouts remain sticky** (VALIDATION O2). `Failed to fetch` stays after the gateway recovers. `Fix before saving …` stays after the problem is fixed and through later checks. `#workbench-error` is hidden only on a workspace change (`app.js:405`).
- **O3 · Residual cancel/teardown window (code reading).** If a cancel's SIGTERM lands after `result.json` is written but before the worker exits, `_monitor` takes the `failed` branch: `studio/workbench.py:789` accepts a complete receipt only with exit 0 or a teardown warning. Two targeted attempts did not hit it; the worker exited 0 within the 85 ms cancel call.
- **O4 · Release guard scope (code reading).** Only `release` is guarded; `restart` / `stop` (`tools/studio_service.sh:100`) still kill active runs. The guard is check-then-act. `PORT` comes from `STUDIO_PORT` (line 17), so `PORT=… tools/studio_service.sh …` does not retarget it. A down gateway gives an empty list, so release proceeds. `detached` is not counted, which is fine under systemd's cgroup kill.
- **O5 · "Behind an obstacle" uses a 0.15 m pad.** 1 of 8 presets (`Random 7 · seed 3`) grazes a wall end rather than crossing it. That is reasonable for a robot footprint but looser than the tooltip's "crosses an obstacle".
- **O6 · WX MID-360 IMU card** keeps the generic `MID-360 IMU packets were not recorded.` That is true for every CPU run. The old 6.5 instrument flagged it, so it was superseded by the targeted 6.5.
- **O7 · 129-box JSON import is now refused at import time** (`≤128 entries`), not imported and then blocked at Save. The 3.16 instrument was adapted, and the 128-box cap still refuses a new pillar.
- **O8 · Mobile layout.** No page-level scroll. The rail, the arena base select and the System contract table overflow inside their own scrollers (VALIDATION O7).
- **O9 · Stale-tab refusal message.** During a suite run the stale tab gets `A simulation job is already active`. The suite-specific message appears only in the gap between runs. Both are clear and no job leaks.

## Setup

| Item | Value |
|---|---|
| Gateway | Own instance on **port 8795**: `.venv/bin/python -m studio.server --port 8795 --data-root ~/research-data/g1-deploy-studio/validation-workbench-2 --config tools/browser/validation/sessions.validation.json` (`PORT=8795 DATA_ROOT=… EVIDENCE=… tools/browser/validation/gateway.sh start/stop`). Port 8793 was held by a user's 4-day-old `python3 -m http.server 8793` (not a Studio gateway); it was left alone. The service on 8790 was only read (`GET /api/version` → `15959b7`, before and after). |
| Code | Working tree at `15959b7`. At 02:50, commit `9439057` (`docs/ROBUSTNESS.md`, `tools/campaign/latency_followup.py` only) landed in this tree, so gateway restarts after that served `9439057`. `git diff 15959b7 9439057 -- studio apps` is empty. |
| Browser | Playwright, `/opt/google/chrome/chrome` headless, SwiftShader, 1600×1000; mobile 390×844 DPR 2 |
| Simulation | **14 owned CPU runs** (budget 16), K2/ODE4, 2–3 s, policies `flow-bundle-20261008` and `flow-wx-rf-23326aa-s0`. A bundle 2 s run took about 7 s wall; WX 2 s took about 5 s. No GPU, no training. Host load average 7–9 on 32 cores. |
| Error capture | As in VALIDATION.md: page errors, console errors, failed requests and HTTP ≥ 400 are attributed per check. Expected 4xx (invalid input, token refresh, suite refusals) and the gateway-down window are whitelisted per check (48 entries). |

### Reproduce

```bash
export PORT=8795 DATA_ROOT=~/research-data/g1-deploy-studio/validation-workbench-2 \
  EVIDENCE=~/research-data/g1-deploy-studio/evidence/revalidation-20261020 \
  STUDIO_URL=http://127.0.0.1:8795 STUDIO_EVIDENCE=$EVIDENCE STUDIO_DATA_ROOT=$DATA_ROOT
tools/browser/validation/gateway.sh start
node tools/browser/validation/arena.mjs               # §3, no runs
node tools/browser/validation/reval_arena_extra.mjs   # 3.20, 3.11f–h, no runs
node tools/browser/validation/reval_rehearse.mjs      # 6 runs: 4.x, WX empty map, privileged honesty, suite, release guard
node tools/browser/validation/reval_race.mjs          # 2 runs: cancel at receipt / suite cancel at recording
node tools/browser/validation/reval_restart.mjs       # 3 runs, restarts THIS gateway: 8.1, 8.1b, 8.1c–e, 8.2a/b, order
node tools/browser/validation/reval_stale_cancel.mjs  # 2 runs: N3
node tools/browser/validation/runs.mjs                # §5, read-only
node tools/browser/validation/replay.mjs              # §1 2 6 7 9, read-only
ONLY=8.3,8.4 node tools/browser/validation/robustness.mjs
node tools/browser/validation/reval_report.mjs        # merged → $EVIDENCE/revalidation-summary.json
tools/browser/validation/gateway.sh stop
```

Evidence: `~/research-data/g1-deploy-studio/evidence/revalidation-20261020/`, outside Git. Per-script results are in `results-*.json`, merged results in `revalidation-summary.json`, and logs in `*.log`. Screenshot names above are relative to that directory.

## Instrument corrections

These are not product findings.
- `arena.mjs`: accepts the v0.3 random-goal note format (`[random: …]`). It now blurs the name field before panel clicks (`setLabel`), which is the N1 workaround that lets 3.13/3.17/3.18 test what they intend; first-pass results are in `arena.log`. 3.16 accepts the new import-time refusal and tests the 128-box cap with a 128-box import.
- `replay.mjs`: the frame counter reads `sample N / M` (it was `tick`). The HUD may label finite-difference speed `Speed (fd)`.
- `runs.mjs`: the 5.6 recomputation follows the v0.3 report semantics (dedupe per scenario, errors listed). 5.8 now picks a row that is not already open; the first pass read the state before the load finished. Added 5.10–5.13.
- `reval_restart.mjs` 8.1d waits for the recording itself. The first pass read the stale partial-live session, which has the same id; its screenshot already showed the recording opening.
- `robustness.mjs` 8.3 blurs the name field (N1).
- `reval_rehearse.mjs` 6.5 targets the five perception channels covered by the fix (see O6).

## State left behind

- `~/research-data/g1-deploy-studio/validation-workbench-2/` (103 MB): 14 jobs, 4 suites, 14 arenas, 12 scenarios. It is separate from the user's workbench and can be deleted.
- The 8795 gateway is stopped and no worker remains. No reference repository, service, environment, network setting or product file was modified. New and changed files: `docs/REVALIDATION.md` and `tools/browser/validation/` (`reval_*.mjs`, `probe_label_click.mjs`, and backward-compatible edits to `arena.mjs`, `replay.mjs`, `runs.mjs`, `robustness.mjs`). Nothing is committed.

## Fix verification (lead, merged build `974b469`)

The lead fixed every N-defect and three observations, then re-ran the instruments above unchanged, apart from two additions:
- `runs.mjs` 5.13 now asserts the corrected counts;
- `reval_report.mjs` no longer hard-codes 5.13 as FAIL.

The gateway ran on port 8796 with a fresh data root (`validation-workbench-3`) and 13 owned CPU runs (bundle K2/ODE4 and WX-RF, 2–3 s). Evidence is in `~/research-data/g1-deploy-studio/evidence/revalidation-fixes-20261020/`; the re-run of two scripts is in its `rerun/` folder.

| Fix | Commit | Instrument | Result |
|---|---|---|---|
| N1 · panel text fields no longer re-render on `change`; Save and Rehearse follow the saved state | `101d7b0` | 3.20, plus 3.13/3.17/3.18 | PASS |
| N2 · random goals use the active preset's start; the previous base is reused only while the presets are unchanged since the last generation | `101d7b0`, `6065846` | 3.11g, 3.11d | PASS (3.11d had regressed on the first fix and was corrected in `6065846`) |
| N3 · a suite start stops following the previous run; Cancel polls the suite; a run without a recording returns 404 *no replayable recording*, with no server path | `101d7b0`, `15491e0` | N3, 4.13, 8.5 | PASS; no unexpected page errors or HTTP failures in the whole pass |
| N4 · Rehearse follows a `detached` run read-only, labels it DETACHED and opens the recording when the receipt appears | `15491e0` | 8.1c, 8.1d, 8.1e | PASS |
| N5 · error runs are set aside before the latest-per-scenario dedupe | `6065846` | 5.13 (now asserting n 2, goals 1, errors 1, repeats 0) | PASS |
| O2 · lost-poll callout clears on recovery; a successful save or run start hides an earlier error | `15491e0`, `974b469` | 8.1e (no `Failed to fetch` left) | PASS |
| O3 · a cancel that lands after the completion receipt (written last by both workers) leaves the run completed, with a teardown warning | `974b469` | unit test `test_cancel_after_complete_receipt_keeps_the_run_completed` (deterministic window); browser races 4.10c-race-* still pass but do not hit the window | PASS |
| O4 · `studio_service.sh restart` / `stop` refuse while runs or suites are active (`FORCE=1` overrides) | `6609cdf` | script logic; B.release-guard | PASS |
| O6 · privileged (WX) runs report the MID-360 IMU as unavailable by design | `6065846` | unit test; replay 6.5 now passes without being superseded | PASS |
| CSP · `script-src` allows the hashed importmap instead of `'unsafe-inline'` | `101d7b0` | unit test; `ui_acceptance.mjs` 15/15 under the new header | PASS |

**Result.**
- First pass: **115 PASS · 3 FAIL · 0 BLOCKED** across 118 checks, with 226 unit tests OK (2 skipped). Zero unexpected page errors and zero unexpected HTTP failures.
- 6.3 and B.suite-refuses passed when their scripts were re-run, so both failures were timing:
  - B.suite-refuses polled across the short gap between suite runs and sent no POST in that window. On the re-run, the stale tab was refused with *A simulation job is already active*, and six POSTs were refused (one with the suite-specific message). No job leaked.
  - 6.3 samples the dock after 1.5 s of software-rendered playback.
- **1.5 still fails (open, environment-limited).** The 2×/1× playback-rate ratio was 2.45 and then 2.54, against a bound of 1.6–2.4. 1× ran at 0.73–0.76× real time.
  - The playback step is linear in speed, `dt = min(wall dt, 0.5 s) × speed`.
  - The ratio leaves 2 only when SwiftShader frames take longer than the 0.5 s cap, which happened on this host at load average about 20, caused by other users' CPU jobs.
  - This is O1. Hardware-accelerated rendering should not hit the cap, but that was not measured here, and the UI still does not show render-limited playback.

This remains a simulation and UI validation. It is not hardware verification.

