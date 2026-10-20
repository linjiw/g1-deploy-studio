# Next step: isolated real-time (L3) rehearsal

The Studio rehearsals so far run at L1/L2: an in-process CPU lockstep with optional modelled planner latency. The next fidelity step runs the real deployment chain as separate processes:
- the MuJoCo DDS simulator;
- the C++ SONIC runner with TensorRT;
- the planner node over DDS + ZMQ.

Studio observes this chain read-only.

## Readiness (run `tools/realtime_preflight.py`, which launches nothing)

| Check | Status (2026-10-20) |
|---|---|
| Runner binary, fused ONNX, obs config, `rehearse.py`, `robot_sim.py`, `node.py` | present |
| TensorRT engines | 5 prebuilt; `rehearse.py` builds the fused engine on first boot (≤ 600 s) |
| **Runner DDS domain** | **blocked: hard-coded `ChannelFactory::Instance()->Init(0, …)`** |
| Unprivileged network namespace | available. Inside, the only interface is a private `lo` with no route to a robot NIC |
| GPU | kernel module 595.91.07 vs user libraries 595.99.02. NVML fails, so utilisation is unknown (never assumed idle). Flow research jobs are using the GPU. |

## Two ways to unblock (owner decision)

1. **Upstream `--dds-domain`** (the cleanest option): add a domain option to the SONIC runner, `robot_sim` and `node.py`, failing closed on domain 0 in rehearsal mode. This changes `lucid-g1-deploy` and `g1-student-deploy` and needs their owners' approval.
2. **Network-namespace isolation** (no source change): run the unchanged chain inside `unshare --user --map-root-user --net`.
   - DDS still uses domain 0, but every participant lives in a namespace whose only interface is its own loopback. The traffic cannot reach the robot network.
   - This deviates from the letter of `AGENTS.md` ("simulator-specific DDS domain") while meeting its intent (no path to the robot). It therefore needs explicit approval.

Either option also needs approval to use the shared GPU for one bounded rehearsal at a time.

## What Studio would add once approved

- A `realtime-rehearsal` profile. It would launch only the existing `rehearse.py` inside the namespace, as an owned process group with the existing wall and output limits, and would never pass hardware interfaces.
- A read-only collector inside the same namespace: `studio.recorder` on `tcp://127.0.0.1:5557` for `g1_debug` and `robot_config`.
- Import of the run into the normal replay. The System map's DDS and ZMQ edges would then become **observed**, and stream ages would be shown against the source thresholds (LowState 500 ms runner stop, node 0.5 s estop, cloud 1.0 s, reference 150 ms cue).
- A parity report for the same scenario at L1/L2 (CPU lockstep) vs L3 (real-time chain): outcome, trajectory deviation, planner latency, `stall_risk`.

Sketch only. This has not been run:

```bash
unshare --user --map-root-user --net bash -c '
  ip link set lo up
  cd /home/linjiw/code/g1-student-deploy
  .venv/bin/python sim/realtime/rehearse.py --task <task.json> --out <owned-dir> &
  /home/linjiw/code/g1-deploy-studio/.venv/bin/python -m studio.recorder \
      --endpoint tcp://127.0.0.1:5557 --topic g1_debug --topic robot_config \
      --duration <s> --output <owned-dir>/g1_debug.jsonl
  wait'
```

## After L3: read-only physical G1 (M5)

M5 needs a separate safety review:
- an operator procedure with the physical E-stop and gantry;
- a robot-side collector with allowlisted DDS readers (`rt/lowstate`, `rt/secondary_imu`, `rt/utlidar/cloud_livox_mid360`) and the `g1_debug` subscriber;
- an observe-only banner in the live view.

Studio never connects to the node control port :5562 and never writes commands.
