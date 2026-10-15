# Replay source verification

Inspected read-only on 2026-10-15. The repository reference checker passed all seven configured dependencies without HEAD drift. This document describes observed source and recording contents, not hardware validation. No policy execution, DDS participant, hardware connection, source-tree edit, sealed-result read, or recording copy is required by the replay adapter.

## Demonstrated recordings

The initial full reference session is `/home/linjiw/code/g1-student-deploy/runs/smoke/__start_stand_/closed_loop.npz`: 159 simulation ticks, at 20 ms per tick. Its provenance is independently connected to the explicitly recorded C++ rehearsal by `runs/rt/replay-beams2-101/config.json`, whose `replay` field names this smoke episode. The same rehearsal's `boxes.json` supplies the matching obstacle geometry. No `score.json` or external panel outcomes are read. The recording is real MuJoCo physics with the fused SONIC ONNX tracker; it ran in-process and must not be represented as a DDS recording.

`sim/lockstep.py:218` and `:293` establish the NPZ contract:

| Array | Shape | Meaning |
| --- | --- | --- |
| `pre_action_qpos` | T × 36 | Simulator state before each action: xyz, quaternion wxyz, 29 named joints in native order |
| `realized_qpos` | T × 36 | State after that action, timestamp is one 20 ms control tick later |
| `references` | T × 10 × 67 | Actual reference window supplied to the SONIC adapter |
| `estimated_qpos` | empty for this session | No separate estimated trajectory available |

`plans.json` contains each selection's simulation tick, measured wall-clock planner computation duration, selection rule, waypoint, predicted root xy and z. It does not contain raw candidates, confidence, SONIC inference latency or motor commands. Planner computation time is not end-to-end latency, and the lockstep simulation clock must not be equated with real-time wall execution.

The second session is `/home/linjiw/code/g1-student-deploy/runs/video/A_quickstart`. It is explicitly referenced by the source README's tutorial and `tools/make_tutorial.py`. This capture contains actual simulator execution alongside separate SONIC C++/TensorRT runner and planner processes. It contains 1,922 qpos rows over 40.394009 s of host-monotonic recording time, plus process logs, plan timing and a final accumulated perception map. It has no recorded reference frames or low-level targets, so its ghost and tracking errors are unavailable.

The simulator source records root/wall timestamps every two physics steps and qpos every four. Its `sim.npz` has 3,843 root/timestamp samples and 1,922 qpos samples. The correct qpos time array is `wall[::2]`, corroborated by identical sampled root positions. The adapter validates the ratio and root values rather than resampling by guessed frequency. `t` is simulation time, while `wall` is host `time.monotonic()`, despite its name. Neither is Unix UTC.

## Model identity and joint order

Lockstep uses `g1-student-deploy/sim/assets/g1_29dof.xml`: 36 qpos values, 29 body joints, rubber hands. `sim/scene.py` checks the XML joint list against `g1deploy/contract.py`. The adapter also validates all 29 names and qpos addresses.

The C++ rehearsal uses `lucid-g1-deploy/sim/models/g1/scene_43dof.xml`: 50 qpos values, 43 joints including Dex3 hands. Finger joints are interleaved before the right arm in MuJoCo qpos order. Consequently, slicing `qpos[7:36]` would assign wrong measurements to the right arm. The adapter queries the local MuJoCo model's `jnt_qposadr` for each named body joint and preserves the full qpos for rendering fingers. The model and meshes are read from their original local paths; no redistribution license is assumed and no assets are copied into Git.

## SONIC reference and token observability

Verified against the frozen source actually selected by the deployment bundle: `bundle/flow/src/motion2scene_flow/closed_loop/feed.py`, `g1deploy/sonic.py`, `g1deploy/contract.py`, and `g1deploy/zmq_stream.py`.

The recorded 10 × 67 reference window has rows at 0, 0.1, …, 0.9 s from the current 50 Hz control tick. Columns 0:29 are joint angles in radians, 29:58 are joint velocities in rad/s, 58:64 are the first two columns of the relative pelvis rotation matrix flattened row-major, and 64:67 are diagnostic root deltas in measured heading axes. The last three values are **not consumed by SONIC**. They permit faithful display of the planner's predicted world root position, but do not establish that SONIC receives or tracks a global position target.

The learned 6D orientation is not always orthonormal in the recording. The actual tracker applies Gram–Schmidt projection before inference, including a defined degenerate-vector fallback. The browser ghost uses that same projection followed by the measured pelvis rotation; raw 10 × 67 values remain available unchanged for inspection. Tests compare this calculation to the pure projection function parsed from the actual source without importing deployment runtimes.

The fused tracker takes 1,570 observation values and returns 29 continuous action values. This capture records neither latent tokens nor the output action/PD targets. It does not provide semantic codes for labels such as “duck” or “step.” Selection-rule names from the planner are displayed as source rule strings, not token meanings or confidence scores.

Native reference rows and ZMQ wire joint order differ. `pose_message()` converts body joint positions and velocities to IsaacLab order. The v1 single-part packet is `pose` bytes, a 1,280-byte NUL-padded JSON header, then ordered little-endian typed arrays. The runner's future reads use ten rows spaced five ticks apart; the existing stream helper documents a 46-frame minimum buffering requirement. The dashboard has no publisher for `pose` or `rt/lowcmd`.

## Map evidence and missing data

`node_memory.npz` contains 241 × 241 support and ceiling arrays, a two-dimensional origin, and 0.05 m resolution. `CloudMemory._cells` and the base memory's grid construction establish array indexing as `[x, y]` with centers at `lo + index × res`. NaN is unknown; positive-infinite ceiling is observed clear rather than a finite obstacle height. The adapter preserves separate observed masks and bounds displayed finite samples to 6,000 points.

This map is saved when the node exits and has no capture timestamp or history. It is therefore an explicitly labelled final snapshot, not current perception at the cursor. The two sessions must not borrow maps or poses from one another. Raw/filtered LiDAR, historical self-filtered returns, per-sensor extrinsics, actual low-command timestamps and packet gaps remain unavailable.

Process logs establish process lifecycle events and source configuration establishes DDS/ZMQ topology. Neither establishes packet-level runtime discovery. Graph edges remain labelled configured, with unknown message rates, gaps, QoS and participant identities. Historical source uses loopback but does not establish a nonzero DDS domain; the dashboard does not launch those historical bring-up scripts.

## Verification

```bash
cd /home/linjiw/code/g1-deploy-studio
.venv/bin/python -m unittest tests.test_replay -v
.venv/bin/python -m studio.replay \
  /home/linjiw/code/g1-student-deploy/runs/smoke/__start_stand_ \
  --environment /home/linjiw/code/g1-student-deploy/runs/rt/replay-beams2-101/boxes.json
.venv/bin/python -m studio.replay \
  /home/linjiw/code/g1-student-deploy/runs/video/A_quickstart
```

The twelve tests cover actual source joint-name parity, sampled NPZ state/reference parity, current tracker orientation-projection parity, Dex3 joint address mapping, mixed-rate time alignment, causal seek and stale gaps, bounded downsampling, invalid values, 180° quaternion conversion and unknown/clear map masks. Full browser acceptance is recorded separately in the handoff evidence.
