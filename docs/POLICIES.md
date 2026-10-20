# Policy profiles and the Flow WX adapter

Studio separates **what is deployed** (a *policy profile*) from **where it runs** (an owned, isolated CPU worker). A profile pins the planner and tracker identity, source revision, config hash and checkpoint hashes. Every scenario and run records that identity. The HTTP gateway never imports a policy runtime. Profiles are discovered by `studio/policies.py`, and each profile's `loader` selects the worker.

| Profile | Loader / worker | What runs | Status |
|---|---|---|---|
| `flow-bundle-20261008` | `deploy-bundle` → `studio/policy_worker.py` | Frozen g1-student-deploy bundle (Flow student s2-kcsc on the `closed-loop-v2-main` planner snapshot) driven by `sim.lockstep.run_episode` with LiDAR (`mjray`) perception and a sensor route | Pre-dates the Flow research SKX2/WX blocks |
| `flow-wx-rf-23326aa-s0` | `flow-callback` → `studio/flow_policy_worker.py` | **Adopted Flow block WX, retrieval-free (WX-RF).** Flow's own `FlowClosedLoopCallback.run` from a hash-pinned snapshot, with teacher `sk1_s0` and the WM-v2 execution check | Matches the block named in `flow/research/BEST_MODEL.md` |

Both use the same fused SONIC ONNX tracker (`bundle/sonic/sonic_release_g1.onnx`, 1570 → 29) and the same MuJoCo `Physics` (`g1_29dof`, rubber hands) from g1-student-deploy. Neither opens DDS or ZMQ, uses a GPU, or connects to a robot.

## Flow research sync

`policies.flow_research_status()` parses only the adoption heading of `research/BEST_MODEL.md` and shows it in **Rehearse → Flow research sync**. On 2026-10-20 it read *WX, adopted 2026-10-16 16:13, commit 4ba73cb*. A profile is marked **ADOPTED BLOCK** only when its `research_block` equals that heading. Adoption is a research decision on Isaac panels, not deployment qualification. Studio reads no evaluation outputs, sealed or interim.

## How the WX-RF bundle is pinned

`tools/build_policy_bundle.py` builds `~/research-data/g1-deploy-studio/policies/flow-wx-rf-23326aa-s0/`, outside Git. It touches Flow read-only:

- **Source:** `git archive 23326aa src/`, 177 files, with every file hash in `manifest.json`.
  - This is not the adoption commit `4ba73cb`. That tree lacks `arena/probe.py` (`ARMS`), which tight-mode arm posture imports; the file was first committed in `f7a7734`. Isaac packets copied the working tree.
  - At 23326aa the WX arm config is byte-identical, and the WXR0 arm differs only in a note timestamp. Replans that do not use tight mode were bit-identical between the two trees in the feasibility check.
- **Config:** `configs/closed_loop_wxr0_c3.json` at that commit, sha256 `1ffc4069…441c4861`, arm `WXR0-g-s0`.
  - This is the retrieval-free arm (`gate_side.level.retrieval_k: 0`). It is the user-directed adopted block and equals the arm of the sealed-read config.
  - The planner `device` is overridden to `cpu`.
- **Checkpoints**, referenced in place by absolute path with size and SHA-256:
  - `flow/artifacts/sk1_s0/model.pt` (`3d3a2d55…`)
  - WM-v2 `rw-wm-v2h6/deploy/member{0,1,2}.pt`
  - the two planner geometry/reference artifacts, symlinked individually; the `artifacts/` tree is never linked or copied
- **Dependencies:** the humanoid_lfh bridge worktree `94be64cc`, plus the g1-student-deploy physics, SONIC and contract files, all with hashes.

`flow_policy_worker.py` re-verifies every hash before each run (`policy_bundle.verify`). It refuses to start if anything drifted, or if `motion2scene_flow` resolves outside the snapshot. It also asserts that `g1deploy.bundle`, `cloud_memory`, `fastplan`, Isaac and Omniverse modules are never imported.

```bash
.venv/bin/python tools/build_policy_bundle.py              # once (exclusive; refuses to overwrite)
.venv/bin/python tools/build_policy_bundle.py --verify-only
```

## How the WX worker runs

The worker writes `task.json` and `callback_config.json` exactly as Flow's `runner.prepare` would. It then runs the unmodified callback against a minimal fake Isaac environment:

- The callback's state writes reset MuJoCo.
- `env.step` executes the callback's (10, 67) SONIC reference through `Physics.step`.
- The capture buffers receive the 4 physics substeps per tick.

The callback config mirrors Flow `runner.prepare`: arm-level keys override config keys, and the `exec_model_xfit` fold and the opt-in keys are handled the same way. Every route, tight-mode, gate-side, execution-check and fall-safety rule is Flow's code. Studio wrappers observe:

- `Physics.step`: state, PD targets, obstacle contact per interval, SONIC inference time, and 10 Hz SONIC tensor samples;
- `make_planner().plan`: measured replan latency, rule, `exec_check`, and the first-forward Flow tensors, captured in a guarded way so telemetry can never alter planning.

The callback's native `closed_loop.npz` is decoded independently by `studio.replay.load_session` and checked against Studio's observed rows. The first run measured a round trip of 1.2e-7 (qpos) and 3e-8 (reference); storage is float32. This check catches tick misalignment and decoder errors; it is not a fidelity comparison with an Isaac episode. If Flow raises mid-episode, the real error is kept, the unmatched pre-action state is excluded, and the executed rows remain replayable. The result is an ordinary Studio replay with the same timeline, lanes, inspector and runs table as every other run.

## What the UI must keep saying (and does)

- **Privileged block.** The map, selection, guidance, execution check and route consume the exact configured boxes (simulator ground truth), not LiDAR. The bundle profile is the only LiDAR-driven profile here. Flow's LiDAR student (round ST) is not adopted. WX runs show perception as *unavailable by design*.
- **WM-v2 is Isaac-trained.** Its 3 cm execution margin is calibrated on Isaac SONIC executions, and its accuracy under MuJoCo is unmeasured. Each plan's `exec_check` is shown as *estimated (Isaac-trained)*.
- **No transfer of Isaac numbers.** WX's Isaac results (guard 121/156, V-learn 172/213, sealed 59.9 %) do not transfer to MuJoCo CPU lockstep. Studio starts standing, while Isaac arena tasks start from a recorded walk near 1 m/s. CPU randomness also differs from Isaac CUDA.
- **Budget.** The evaluated budget is K16/ODE10. On this shared CPU host one replan at that budget took about 3–4 s. Studio's WX default is **K8/ODE6** (about 1.3–1.5 s per replan) and is labelled as a deviation. *Deployed 16/10* stays selectable, and the WX wall limit is 480 s.
- **Lockstep timing.** Physics waits for each replan, so planner latency never delays a plan in simulation unless a latency model is selected (L2). On the robot a replan has about 160 ms (8 ticks).
- **No proprioceptive noise.** Isaac evaluates SONIC with proprioceptive noise (`native_proprio_noise_scale=1.0`); Studio's MuJoCo has none, so seeds vary planner sampling only.
- **Contact measurement.** Studio's obstacle force is the largest single MuJoCo contact normal per substep; Isaac sums force per robot-body/obstacle pair, so under the 5 N *reach* threshold multi-point contacts read lower here.
- **Success criteria.** A scenario chooses between:
  - **Arrive & hold** (Studio's deployment check): ≤ 0.3 m, ≤ 0.25 m/s held for 0.4 s, collision above 100 N.
  - **Reach** (Flow Isaac arena protocol): ≤ 0.4 m, ≤ 2.0 m/s held for 0.1 s, collision above 5 N, fall at 0.38 m / 0.8 rad.

  WX was trained and evaluated on *reach*, so arrive-and-hold also tests whether it stops.

## Latency and torque checks

- **Latency (L2).** Scenarios can add a planner latency: a plan requested at tick t starts at t + latency while physics keeps running.
  - The bundle uses g1-student-deploy's `run_episode(latency_s, anchor_mode, inflight=1)`.
  - WX uses a Studio delayed-execution wrapper around `plan_target`. Each plan runs from its request tick + latency, and the previous plan keeps driving SONIC meanwhile. This is an approximation (L2≈): the callback still anchors its next replan on the latest computed plan, and Flow has no predictive anchoring. WX was evaluated synchronously in Isaac, so latency sensitivity is untested on the research side.
- **Torque.** Both workers record the commanded PD torque per joint and how many physics substeps exceed MuJoCo's `actuatorfrcrange`.
  - In the G1 model the hips are limited to 88 N·m, while training and `g1deploy.contract` use 139 N·m.
  - A first WX check commanded up to 131 N·m at the hip roll, clamped by MuJoCo in 22 of 600 substeps. A bundle check stayed below 60 N·m.
  - This shows the source discrepancy in `ROBOT_CONTRACT.md` is binding for WX in simulation.

## Adding another policy

1. Pin it. Write a bundle/manifest builder similar to `build_policy_bundle.py`, or reference an existing frozen bundle. Never vendor weights into Git.
2. Add a profile builder to `studio/policies.py` with an `id`, a `loader`, `artifacts` (hashed), `limits` (candidates, ODE, duration, wall seconds), `default_planner`, `research_block` if it is a Flow block, and honest `limitations`.
3. Add or reuse a worker that accepts the common request (`studio.policy_worker.validate_request`) and writes the standard outputs: `latest.json` (live), `progress.jsonl`, `session.json`, `result.json` and `physics_observations.npz`. It must verify the parity of its own observations against an independent decoder.
4. Map the loader to the worker script in `Workbench.start_job`.

A real-time profile (separate processes over an isolated, non-zero DDS domain) needs the runner's hard-coded domain 0 removed upstream first; see `ROBOT_CONTRACT.md` → *domain_zero_everywhere*.
