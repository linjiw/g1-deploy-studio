# Isolated real-time (L3) rehearsal

The Studio rehearsals so far run at L1/L2: an in-process CPU lockstep with optional modelled planner latency. L3 runs the real deployment chain as separate processes:
- the MuJoCo DDS simulator (`robot_sim.py`);
- the unchanged C++ SONIC runner with TensorRT;
- the planner node (`node.py`) over DDS and ZMQ.

Studio observes this chain read-only.

## Decision (owner-approved after research, 2026-10-20): network-namespace isolation

The unchanged chain runs inside an unprivileged **user + network + PID + mount namespace whose only interface is a private loopback**. DDS keeps domain 0 because the runner hard-codes it (`ChannelFactory::Instance()->Init(0, iface)`). In that namespace domain 0 has no route to any robot.

This deviates from the letter of `AGENTS.md` ("simulator-specific DDS domain") while meeting its intent. The deviation is recorded in every run's `l3_provenance.json` (`agents_md_deviation`), together with the Studio commit and the L3 simulator's actuator limits.

An upstream `--dds-domain` option for the runner remains a defence-in-depth follow-up. `node.py` already has `--domain`, and the simulator yaml has `DOMAIN_ID`.

Why not the upstream change first:
- It rebuilds the C++/TensorRT runner, which changes the artifact under test.
- It needs approval from two repository owners.
- It would leave the chain's `tcp://*` ZMQ binds, including the node's REP control socket `:5562`, exposed on the LAN and tailnet. The namespace confines those too.

### Verified facts (research probes, nothing from the chain launched)

| Item | Finding |
|---|---|
| CUDA for new processes | `cuInit` → 0 and 1 device (RTX 5080, cc 12.0), on the host and inside the namespace, despite the NVML 595.91/595.99 mismatch. Other jobs started today hold CUDA contexts on 595.99.02 |
| TensorRT engine | The runner links TensorRT 10.13.3. The engine cache key `sha256(sha256(sha256(onnx)+device)+"0")` **matches** `bundle/sonic/policy_sonic_release_g1.trt`, so no rebuild or write is expected. The old "builds on first boot ≤ 600 s" note was stale |
| Inference backend | TensorRT only; there is no CPU fallback with the runner's semantics |
| Namespace | Only `lo` exists and the route table is empty. `ping 192.168.1.1` → "Network is unreachable". `--iface eno2` fails closed ("does not match an available interface") |
| DDS in the namespace | CycloneDDS needs no multicast and no `CYCLONEDDS_URI`; on a non-multicast `lo` it adds unicast peers. `CYCLONEDDS_URI` is ignored for SDK-created domains. A throwaway domain-0 topic was 60/60 inside the namespace, with 0 messages leaking in either direction to a host subscriber |
| ZMQ in the namespace | `tcp://127.0.0.1` / `localhost` work. A host subscriber received nothing, and no listener appeared on the host |
| Process lifetime | With `--pid --fork --kill-child --mount-proc`, zero processes survive normal exit or a SIGKILL of `unshare`. Without `--pid`, a `setsid` child survives |
| Signals | util-linux 2.37 `unshare --fork` leaves SIGINT/SIGTERM ignored for every descendant. `env --default-signal=INT,TERM,QUIT,PIPE` restores them; the runner has no handler of its own |
| Robot-facing clients | The runner starts its MotionSwitcher `ReleaseMode` loop, the `AudioClient` and Dex3 hand commands unconditionally. All of them are contained by the namespace |
| GPU telemetry | NVML fails for new processes. An unrelated, still-running `nvidia-smi` logger (another experiment) shows 6–97 % utilisation and about 6–8 of 16.3 GiB in use, so an L3 run is timed **under contention** |

## Launcher: `tools/l3_rehearsal.sh <studio task.json> <run-id>`

Reviewed by the lead; the dry run (`DRY_RUN=1`) passed. It:
1. Refuses Flow panel tasks (a possible sealed set) and takes an exclusive GPU lock (`~/research-data/g1-deploy-studio/l3/.gpu-rehearsal.lock`).
2. Records a baseline: git status, the runner/ONNX/engine SHA-256, a GPU-log excerpt, and a backup of `/tmp/cdds.LOG` (the SDK overwrites it; it is restored afterwards).
3. Runs `rehearse.py --task … --out <run>/rehearse --boot-timeout 180` under `timeout` (about 520 s for a 10 s task) inside
   `unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc env --default-signal=INT,TERM,QUIT,PIPE -u CYCLONEDDS_URI …`.
   - Inside, it refuses unless the interfaces are exactly `lo` and no route exists to 192.168.123.161/.164, 192.168.1.1 or 8.8.8.8.
   - It starts `studio.recorder` (subscribe-only, `:5557` `g1_debug`/`robot_config` and `:5556` `pose`) before the chain.
4. Afterwards, from the host, checks: no surviving chain processes, no chain port ever bound in the host namespace (sampled every 2 s), unchanged git/SHA, and no files written in the reference repositories.

Outputs go to `~/research-data/g1-deploy-studio/l3/<run-id>/`. The gateway discovers them on its own: it rescans at most every 10 s and never launches anything. Each completed run appears in the session picker under **Real-time rehearsals (L3)**:
- `L3 real-time · <run-id>` is the separate-process recording, decoded by `studio.replay`, with the scene from `rehearse/boxes.json`. It is badged **REPLAY · REAL-TIME CHAIN · L3** and carries the namespace receipt from `l3_provenance.json`.
- `L3 wire capture · <run-id>` is the subscribe-only ZMQ capture.

Use Studio-authored tasks: every L1/L2 job writes a compatible `run/task.json` and `initial_state.npz` (family `studio-user-configured`). The launcher refuses anything else.

For an L1/L2 comparison, match the L3 chain:
- the node runs the frozen bundle at its deployed budget (K16/ODE10, LiDAR route), so use *Deployed 16/10*;
- the L3 simulator clips the hips at 88/88/88 (lucid `g1_29dof_sonic_model12.yaml`), so use the **`source`** actuator profile, not the `g1-current` default. Imported L3 sessions show that clip as their actuator limits.

**Status: ready, not yet run.** The first real launch was blocked by this session's automatic permission policy, which classes it as a deployment action. An operator runs it explicitly:

```bash
tools/l3_rehearsal.sh ~/research-data/g1-deploy-studio/workbench/jobs/job-1a99ab355aae/run/task.json l3-clutter-r1-a
```

### Known limits of L3 here
- Unicast discovery on `lo` instead of robot multicast.
- CRC and the 35 rad/s velocity abort are disabled in simulation.
- Dex3 hands and the C++ gains differ from L1/L2's rubber hands and Python gains.
- Host TensorRT is 10.13.3 vs 10.7 on the Orin.
- The runner gets no damping command on SIGINT (simulation only).
- This is not hardware verification.

## After L3: read-only physical G1 (M5)

M5 needs a separate safety review:
- an operator procedure with the physical E-stop and gantry;
- a robot-side collector with allowlisted DDS readers (`rt/lowstate`, `rt/secondary_imu`, `rt/utlidar/cloud_livox_mid360`) and the `g1_debug` subscriber;
- an observe-only banner in the live view.

The first passive reading must include `LowState.mode_machine`: it selects the hardware actuator limits ([ROBOT_CONTRACT.md](ROBOT_CONTRACT.md)). Studio writes no motor commands. Since 2026-10-21 (owner decision) Navigate's robot link may send node.py a checked goal while the robot stands and a stand request, never Go or quit ([NAVIGATE.md](NAVIGATE.md)).
