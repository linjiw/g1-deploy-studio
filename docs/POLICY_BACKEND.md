# Fresh CPU policy rehearsal backend

`studio.policy_worker` executes the existing `g1-student-deploy/sim/lockstep.py` Flow planner, fused SONIC ONNX tracker and MuJoCo physics in an owned subprocess. It consumes the frozen local planner/checkpoint and existing Python environment read-only. It does not launch the C++ runner, open DDS/ZMQ participants, connect to a robot, or claim hardware readiness.

The configured dependency interpreter is `/home/linjiw/code/g1-student-deploy/.venv/bin/python` (Python 3.11). It already provides Torch, ONNX Runtime, MuJoCo and SciPy. Studio's Python 3.10 environment intentionally does not import these policy dependencies into the HTTP server. No reference environment is modified. GPU visibility is disabled before runtime imports, Torch/BLAS threads are capped at two and SONIC ONNX uses its source CPU provider with one inference thread. NVML still reports a driver/library mismatch on this host; this is not treated as spare GPU capacity.

The source callable is:

```python
sim.lockstep.run_episode(task_path, seed, native_output,
    device="cpu", planner_impl="eager", start="stand",
    route_source="sensor", lidar="mjray", deadline_s=duration_s,
    planner_overrides={"candidates": 2, "ode_steps": 4})
```

The quick-test budget differs from the deployed 16 candidates and 10 ODE steps. The request and session record the actual values; operators can select up to 16 and 10. CPU computation pauses lockstep physics while planning. Measured inference/planner times and wall/simulation time ratio are useful diagnostics, but this is not a real-time deadline or separate-process DDS validation.

## Input contract

The worker accepts one JSON request, maximum 1 MiB:

```json
{
  "schema_version": 1,
  "id": "test-corridor",
  "goal_xy": [1.5, 0],
  "start_xy": [0, 0],
  "start_yaw_rad": 0,
  "duration_s": 2,
  "seed": 0,
  "planner": {"candidates": 2, "ode_steps": 4},
  "map": {
    "id": "corridor",
    "label": "Operator configured corridor",
    "kind": "boxes",
    "frame_id": "world",
    "boxes": [
      {"center_xy": [1, 1], "half_xy": [1.5, 0.12], "yaw": 0,
       "z_bottom": 0, "z_top": 1.2}
    ]
  }
}
```

Coordinates use metres, positive z up, radians and `world` frame. Simulation duration is bounded at 10 seconds; the application manager additionally limits wall duration and concurrent jobs. Requests cannot choose an interpreter, arbitrary executable, model weight, CUDA device, network interface or middleware domain. Collision maps are explicit static boxes, maximum 128. A real scan is not collision geometry: `kind: scan` is rejected by this physics backend until a separately validated collision reconstruction exists.

Invoke from the Studio root, with a new output directory:

```bash
PYTHONDONTWRITEBYTECODE=1 CUDA_VISIBLE_DEVICES='' \
  /home/linjiw/code/g1-student-deploy/.venv/bin/python -m studio.policy_worker \
  --request /absolute/path/request.json --output /absolute/data/root/new-run
```

Use the application's owned job manager for wall-time enforcement and cancellation. The CLI is intended for controlled local acceptance runs, with the same responsibility on its caller.

## Actual observations and recording

Process-local observational subclasses wrap source methods without editing any reference file. Physics inputs, gains, integration and policy outputs remain source-owned. `Physics.step` supplies the actual SONIC PD target; the tracker policy call is timed directly. Pre-action state, post-action state and all 67 reference columns are compared exactly against the independent native NPZ decoder before completion.

`CloudMemory.add_cloud` supplies raw world-registered MuJoCo ray returns. `CloudMemory.evidence` supplies the actual points remaining after source range gating and robot capsule filtering. Map snapshots contain the consumed support/ceiling layers, observed indices and unknown-cell count; no values are painted into unknown cells. Source selection currently treats unseen cells as free, which is recorded as a planner limitation rather than hidden by the visualization. The MID-360 mount transform comes from the source memory, relative to the pelvis. Camera images and physical IMU acceleration are unavailable.

The worker records:

- `latest.json`: atomically replaced live snapshot, at most 10 Hz wall time, with normalized frame, metadata, latest perception, progress and status.
- `progress.jsonl`: compact actual state/health at the 50 Hz simulation control clock; maximum 500 frames per allowed run.
- `session.json`: replay-compatible normalized session, with measured simulation truth, reference windows, actual commanded joint targets, timing, events and causal perception frames.
- `native/closed_loop.npz`, `native/plans.json`, `native/run_config.json`: unmodified source backend recording format.
- `task.json`, `boxes.json`, `initial_state.npz`, `request.json`: exact owned simulation inputs.
- `result.json`: backend outcome, wall time, parity receipt and explicit lack of hardware/DDS execution.

Perception is sampled at 5 Hz simulation time. Raw and filtered clouds are each decimated to at most 1,500 points; support and ceiling each to at most 1,000 displayed points. Full observed-cell indices preserve mask membership. `sensor_capture_time` and `map_time` are separate: consumed map fusion includes the source's 100 ms latency. State `time` and `source_time` use simulation seconds; `receipt_time` uses host monotonic seconds and its clock domain is named explicitly. Do not subtract these different clocks.

An outcome of `timeout` means the bounded policy horizon ended without goal completion. A completed worker process does not imply policy success. Fall/contact/goal results retain the source scorer's rules, whose exact thresholds are written in `task.json`.

## Exercised evidence

Local evidence is under `/home/linjiw/research-data/g1-deploy-studio/evidence/policy-workbench/` and is not committed. The initial `run-smoke` produced 20 actual control steps over 0.4 simulation seconds, three Flow replans, real SONIC inference, live ray returns and filtered consumed map. Source/observer state parity was exact. The longer `run-boxes-2s` uses a newly configured two-wall corridor and a 1.5 m navigation goal. See each run's `result.json` for its actual outcome and timing rather than inferring policy success from completion.

Worker validation tests: `.venv/bin/python -m unittest tests.test_policy_worker -v`.
