# Flow stage: see the plan and its execution

The Flow stage is a focused view of Studio's existing rehearsal and replay pipeline. It makes the intended body motion and the simulated execution easier to compare while retaining the selected policy's identity, data provenance and run outcome. It does not replace the planner or tracker.

## Use it

Open the local Studio gateway at [Rehearse in focus mode](http://127.0.0.1:8790/?workspace=rehearse&focus=1). The query parameters select the workspace and presentation; opening the link does not start a run.

1. Open **Setup** to use the existing Rehearse controls. Check the policy profile, arena and start/goal preset, criterion, latency, actuator limits and sampling budget.
2. Start a bounded simulation with **Run preset**. The existing owned worker runs the policy; Studio follows its snapshots and opens the recording when it finishes.
3. Use the camera and visual layers to inspect the robot, reference body, plan and room. Compare the reference with execution at the same simulation time. Available replay controls inspect the recording; they do not pause the simulation worker.
4. Return to the ordinary Studio layout for the full inspector, sensors, timeline and run comparison.

**Details** opens the existing diagnostic inspector. Escape closes a sheet and restores its trigger; outside a sheet it exits the stage. Opening Setup preserves the displayed recording. Changing the arena or preset deliberately enters a labeled preview with unavailable telemetry until a new run supplies samples. Playback controls never pause the live worker; **Cancel run** delegates to the existing owned-worker cancellation action.

Layers retain their meaning: the reference ghost is the pose SONIC is asked to track, the plan is the planner's intended future, and the executed robot is simulator state. A reference pose is not a prediction that the tracker will realize it. Missing channels remain unavailable. In particular, WXD's configured boxes are privileged simulation geometry, not a LiDAR observation.

## What we learned from SuperMimic

The [SuperMimic project page](https://supermimic.github.io/) makes model behavior understandable through a large interactive scene, a small set of controls, and synchronized comparisons. Its comparison scenarios isolate policy state and floor friction. The useful principle for Studio is to put the body and the consequence of a decision together, then let the viewer reveal explanatory layers.

This is an independent visual adaptation. The [demo license](https://supermimic.github.io/demo/LICENSE.html) restricts reverse engineering, automated access, copying materials, and using demo outputs to train or evaluate another system. No demo code, models, assets or outputs are incorporated here. The license discloses three.js, MuJoCo WebAssembly and mjlab, but the demo's neural inference runtime, worker layout and scheduling implementation were not verified. They are not a specification for Studio.

The [paper's training-loop description](https://arxiv.org/pdf/2610.28480) supports the following distinction:

| Component | SuperMimic research | Studio's Flow rehearsal |
|---|---|---|
| Goal | Reference motion supplied to the controller | Navigation destination and scene constraints |
| Planner / reference | A motion supplies the tracking target | Flow produces future whole-body references |
| Controller | Learned goal-conditioned tracking policy | Frozen SONIC tracking policy |
| Learned dynamics | World model predicts action consequences and supplies gradients during policy training | WM-v2 checks estimated execution when enabled by the selected Flow profile |
| Physics | MuJoCo supplies simulator transitions | MuJoCo executes SONIC actions and supplies the displayed simulated state |

SuperMimic's policy-training world model and Flow's execution check have different roles. The stage does not label the reference ghost as a world-model rollout or suggest that Flow has adopted SuperMimic's training method.

## Use the complete adopted pipeline

As documented on 2026-10-22, Flow's adopted research block is **WXD**, represented locally by `flow-wxd-rf-5658a6d-s0`: teacher `sk1_s0`, retrieval-free selection, DP2 duck keys and the WM-v2 execution check. Rehearse selects an available profile matching the adoption heading, otherwise its deploy-bundle fallback. Check the displayed profile rather than assuming that a preferred model is installed.

The gateway-backed WXD worker is the appropriate target for this stage because it executes the pinned Flow callback, including its planning and execution-check rules. Research adoption is not robot deployment qualification. WXD uses exact scene boxes; Navigate's sensor-driven deploy bundle is a different profile. Budget, latency and simulator differences remain visible and must not inherit research success rates. See [policy identities and fidelity](DEPLOY_FIDELITY.md#5-policies-and-labels).

The separate browser prototype at `/home/linjiw/code/g1-live-demo/docs/PLANNER.md` documents network and sampled-plan parity checks, but lists route planning, execution-check features and clearance, sensor-map work, and integration with the live simulation as remaining work. A browser network export is therefore not yet the complete WXD navigation pipeline. This stage reuses the existing Python worker and browser visualization rather than claiming that port is complete.

Implementation references:

- [`studio/policies.py`](../studio/policies.py): available profiles and research-adoption matching; reads the heading in `/home/linjiw/flow/research/BEST_MODEL.md`.
- [`studio/flow_policy_worker.py`](../studio/flow_policy_worker.py): pinned Flow callback, SONIC and MuJoCo execution.
- [`apps/web/js/rehearse.js`](../apps/web/js/rehearse.js): setup, owned-run lifecycle and live attachment.
- [`apps/web/js/scene.js`](../apps/web/js/scene.js): articulated robot, reference ghost and scene layers.
- [`apps/web/js/focus.js`](../apps/web/js/focus.js) and [`apps/web/focus.css`](../apps/web/focus.css): stage controls, provenance, responsive sheets and presentation.
- [`apps/web/app.js`](../apps/web/app.js): workspace selection, replay cursor and layer availability.
- [Architecture](ARCHITECTURE.md), [workbench usage](WORKBENCH.md), and [public-site boundaries](SITE.md).

The change is local presentation and simulation integration. It neither publishes a site nor exports weights, and it adds no robot motor-command path.

## Verification

Validated on 2026-10-22 in the isolated `codex/flow-navigation-stage` worktree. Review gateway: `http://127.0.0.1:8797/`; its workbench is separate from the normal service at `~/research-data/g1-deploy-studio/flow-stage-workbench`.

- Existing Python suite: 384 tests ran successfully, with 11 optional tests skipped.
- Browser acceptance started exactly one real WXD run through Setup: `job-867be1ba5c0a`, wall-detour arena, 4 simulated seconds, K8/ODE6, zero added planning latency. Live samples advanced, and the finished recording contains 200 changing MuJoCo poses with the pinned WXD identity. The run reached its time limit; it is not a navigation-success claim.
- The final replay-only browser check passes 11 checks, including actual scene-layer visibility, seek/play/restart, camera changes, S2 selection without relabeling the WXD recording, Details and Escape, 390/320 px layouts, and exact restoration of the original scene palette. No browser errors or failed requests were observed. Visual inspection prompted fixes for panel stacking, light-panel text contrast and the narrow-screen metrics/hint overlap.
- Evidence and screenshots: `~/research-data/g1-deploy-studio/evidence/flow-stage-20261022/` (`flow-stage.json`, `flow-stage-recheck.json`, `unit-tests.log`).

To recheck this existing recording without launching another worker:

```bash
STUDIO_URL=http://127.0.0.1:8797 FLOW_STAGE_JOB=job-867be1ba5c0a npm run test:flow-stage
```

Without `FLOW_STAGE_JOB`, the browser test starts one bounded simulation and refuses to duplicate a run already registered in its evidence directory. Use an isolated workbench for that path. This verifies visualization and integration, not WXD performance, real-time fidelity or hardware readiness.
