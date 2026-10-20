# Unitree G1 29-DoF robot contract

Machine-readable profile: [`config/robots/g1_29dof.json`](../config/robots/g1_29dof.json). Loader and verifier: `studio/robot_profile.py` (stdlib only). Every value in the JSON carries `{path, line, match}`; `verify_against_sources()` re-reads those files read-only (regex, `ast`, `xml.etree`) and reports drift. Run:

```bash
.venv/bin/python -m unittest tests.test_robot_profile -v
```

## Evidence level

**Nothing in this contract is runtime- or hardware-verified.** No process was launched, no DDS participant or socket was created, no deployment runtime was imported. The labels below describe the source, not the robot.

| Label | Meaning | Examples |
|---|---|---|
| source_inspected | value configured in the cited code | gains, topics, thresholds, ports |
| doc_only | stated only in a reference document | rt/lowstate 500 Hz, lidar 10 Hz / IMU 200 Hz on hardware |
| inferred | follows from a convention, not stated in the file | MuJoCo body-frame gyro, `rt/api/motion_switcher/*` names, CRC equivalence |
| conflict | sources disagree, both kept | OdoState quaternion order, hip effort limits |
| runtime_verified | observed packets or hardware behaviour | **none** |

Inspected 2026-10-19: g1-student-deploy `6a86c860` (Studio `config/references.json` still lists `df53fd02`), lucid-g1-deploy `e994a985`, groot-wbc-sonic-sim-trackb `305d83c0`, newton-terrain/deploy_g1 (not git). Cited files had no uncommitted changes.

Abbreviations: **pp** = lucid `runner/.../include/policy_parameters.hpp`, **rp** = `robot_parameters.hpp`, **cpp** = `runner/.../src/g1_deploy_onnx_ref.cpp`, **ct** = g1-student-deploy `g1deploy/contract.py`, **node** = `g1deploy/node.py`, **xml** = `sim/assets/g1_29dof.xml`, **g1.py** = groot `gear_sonic/envs/manager_env/robots/g1.py`, **bridge** = lucid `sim/gear_sonic_sim/unitree_sdk2py_bridge.py`, **yaml** = lucid `sim/wbc_configs/g1_29dof_sonic_model12.yaml`.

## Joint table

Unitree motor index = MuJoCo body-joint index (rp:90-126 enum, ct:5, xml hinge order, yaml MOTOR2JOINT identity). IsaacLab index from ct:31 `ISAAC_TO_MJ`, cpp-side `mujoco_to_isaaclab` (pp:103) and g1.py:31. kp/kd/scale/default: pp:109-240 (runner, kp/kd stored as `float`), Python value in parentheses: ct:37-91. Effort "train / sim": g1.py:250-323 vs lucid torque clip yaml:241 (also MJCF `actuatorfrcrange`). Limits: xml:52-224, identical in the lucid Dex3 MJCF and the bundle `sonic_model_contract.json`.

| M/U | Isaac | Joint | Group | Default rad | kp C++ (Py) | kd C++ (Py) | Action scale C++ | Effort N·m train / sim | Limits rad |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | left_hip_pitch | 7520_22 | -0.312 | 99.0984 (99.13) | 6.3088 (6.31) | 0.3507 | 139 / 88 **≠** | -2.5307 … 2.8798 |
| 1 | 3 | left_hip_roll | 7520_22 | 0 | 99.0984 (99.13) | 6.3088 (6.31) | 0.3507 | 139 / 88 **≠** | -0.5236 … 2.9671 |
| 2 | 6 | left_hip_yaw | 7520_14 | 0 | 40.1792 (40.18) | 2.5579 (2.56) | 0.5475 | 88 / 88 | -2.7576 … 2.7576 |
| 3 | 9 | left_knee | 7520_22 | 0.669 | 99.0984 (99.13) | 6.3088 (6.31) | 0.3507 | 139 / 139 | -0.087267 … 2.8798 |
| 4 | 13 | left_ankle_pitch | 2x5020 | -0.363 | 28.5012 (28.51) | 1.8144 (1.81) | 0.4386 | 50 / 50 | -0.87267 … 0.5236 |
| 5 | 17 | left_ankle_roll | 2x5020 | 0 | 28.5012 (28.51) | 1.8144 (1.81) | 0.4386 | 50 / 50 | -0.2618 … 0.2618 |
| 6 | 1 | right_hip_pitch | 7520_22 | -0.312 | 99.0984 (99.13) | 6.3088 (6.31) | 0.3507 | 139 / 88 **≠** | -2.5307 … 2.8798 |
| 7 | 4 | right_hip_roll | 7520_22 | 0 | 99.0984 (99.13) | 6.3088 (6.31) | 0.3507 | 139 / 88 **≠** | -2.9671 … 0.5236 |
| 8 | 7 | right_hip_yaw | 7520_14 | 0 | 40.1792 (40.18) | 2.5579 (2.56) | 0.5475 | 88 / 88 | -2.7576 … 2.7576 |
| 9 | 10 | right_knee | 7520_22 | 0.669 | 99.0984 (99.13) | 6.3088 (6.31) | 0.3507 | 139 / 139 | -0.087267 … 2.8798 |
| 10 | 14 | right_ankle_pitch | 2x5020 | -0.363 | 28.5012 (28.51) | 1.8144 (1.81) | 0.4386 | 50 / 50 | -0.87267 … 0.5236 |
| 11 | 18 | right_ankle_roll | 2x5020 | 0 | 28.5012 (28.51) | 1.8144 (1.81) | 0.4386 | 50 / 50 | -0.2618 … 0.2618 |
| 12 | 2 | waist_yaw | 7520_14 | 0 | 40.1792 (40.18) | 2.5579 (2.56) | 0.5475 | 88 / 88 | -2.618 … 2.618 |
| 13 | 5 | waist_roll | 2x5020 | 0 | 28.5012 (28.51) | 1.8144 (1.81) | 0.4386 | 50 / 50 | -0.52 … 0.52 |
| 14 | 8 | waist_pitch | 2x5020 | 0 | 28.5012 (28.51) | 1.8144 (1.81) | 0.4386 | 50 / 50 | -0.52 … 0.52 |
| 15 | 11 | left_shoulder_pitch | 5020 | 0.2 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -3.0892 … 2.6704 |
| 16 | 15 | left_shoulder_roll | 5020 | 0.2 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -1.5882 … 2.2515 |
| 17 | 19 | left_shoulder_yaw | 5020 | 0 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -2.618 … 2.618 |
| 18 | 21 | left_elbow | 5020 | 0.6 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -1.0472 … 2.0944 |
| 19 | 23 | left_wrist_roll | 5020 | 0 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -1.97222 … 1.97222 |
| 20 | 25 | left_wrist_pitch | 4010 | 0 | 16.7783 (16.78) | 1.0681 (1.068) | 0.0745 | 5 / 5 | -1.61443 … 1.61443 |
| 21 | 27 | left_wrist_yaw | 4010 | 0 | 16.7783 (16.78) | 1.0681 (1.068) | 0.0745 | 5 / 5 | -1.61443 … 1.61443 |
| 22 | 12 | right_shoulder_pitch | 5020 | 0.2 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -3.0892 … 2.6704 |
| 23 | 16 | right_shoulder_roll | 5020 | -0.2 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -2.2515 … 1.5882 |
| 24 | 20 | right_shoulder_yaw | 5020 | 0 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -2.618 … 2.618 |
| 25 | 22 | right_elbow | 5020 | 0.6 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -1.0472 … 2.0944 |
| 26 | 24 | right_wrist_roll | 5020 | 0 | 14.2506 (14.25) | 0.9072 (0.907) | 0.4386 | 25 / 25 | -1.97222 … 1.97222 |
| 27 | 26 | right_wrist_pitch | 4010 | 0 | 16.7783 (16.78) | 1.0681 (1.068) | 0.0745 | 5 / 5 | -1.61443 … 1.61443 |
| 28 | 28 | right_wrist_yaw | 4010 | 0 | 16.7783 (16.78) | 1.0681 (1.068) | 0.0745 | 5 / 5 | -1.61443 … 1.61443 |

- **KP discrepancy confirmed.** 7520_22: Python 99.13 vs runner/training formula 99.0984 (+0.032 %); 2x5020 28.51 vs 28.5012; kd differs by up to 0.25 % (1.81 vs 1.8144). The in-process lockstep and the Studio CPU worker use the Python values (ct:86-91, `g1deploy/sonic.py:128-130`); `rt/lowcmd` carries the C++ values (cpp:3127-3128). Training (g1.py:13-29) matches the C++ formula exactly.
- **Hip effort conflict (material).** Training and ct use 139 N·m for hip pitch and roll. Both deployment MJCFs and gear_sonic_sim's `np.clip` (base_sim.py:466) use 88. The rev_1_0 MJCF in the bundle contract says pitch 88 / roll 139. The runner applies no torque limit; pp:110 notes "old is 7520_14 new is 7520_22", so the physical limit depends on the motor revision.
- Velocity limits (training only, g1.py:256-331): 20 rad/s hip pitch/roll/knee, 32 hip/waist yaw, 37 ankle/waist roll-pitch/arm, 22 wrist pitch/yaw.
- Waist roll/pitch (13/14) are marked INVALID for waist-locked units (rp:108-111). The runner has no waist-lock branch. `mode_pr` is always PR = 0 (cpp:2170, 2663), so 4/5, 10/11 and 13/14 are pitch/roll joints, not A/B motors. `mode_machine` is echoed from LowState (cpp:2644, 2664). gear_sonic_sim never sets it, so the physical variant stays unknown.
- Hands: lockstep uses rubber hands (xml); the C++/DDS rehearsal uses Dex3 (yaml:3 `scene_43dof.xml`). Dex3 qpos interleaves 7 hand joints after each arm.

## Unitree SDK2 HG DDS (configured, not observed)

| Topic | IDL type | Writer | Reader | Rate (configured / doc) |
|---|---|---|---|---|
| `rt/lowcmd` | `unitree_hg::msg::dds_::LowCmd_` | runner (rp:27, cpp:2258) | robot; sim bridge:89 | 500 Hz writer (cpp:2164) |
| `rt/lowstate` | `LowState_` | robot; sim bridge:67 | runner cpp:2261, node:74, LIO bridge:58 | robot 500 Hz doc_only (HARDWARE.md:11); sim ≤200 Hz (yaml:22) |
| `rt/secondary_imu` | `IMUState_` (torso) | robot; sim bridge:79 | runner cpp:2263 (required, age unchecked) | sim per physics step |
| `rt/odostate` | `OdoState_` (Python SDK only) | sim bridge:73 (ground truth) | node:77 with `--odom dds` (default) | sim per physics step; no hardware writer found |
| `rt/utlidar/cloud_livox_mid360` | `sensor_msgs::msg::dds_::PointCloud2_` | PC1 lidar_driver; robot_sim.py:127 | node:199 (`--cloud dds`) | 10 Hz doc_only (unitree_lidar.py:4) |
| `rt/utlidar/imu_livox_mid360` | local `Imu_` | PC1 | none | 200 Hz doc_only |
| `rt/dex3/{left,right}/cmd` | `HandCmd_` | runner, **always**, every 2 ms (dex3_hands.hpp:93, cpp:2682) | sim bridge:93; Dex3 hardware | 500 Hz |
| `rt/dex3/{left,right}/state` | `HandState_` | sim bridge:83; Dex3 | runner dex3_hands.hpp:76 | — |
| `rt/api/motion_switcher/*` | SDK RPC (inferred names) | runner ReleaseMode loop (cpp:2252) | robot service | startup |

- Arrays: `LowCmd_.motor_cmd[35]`, `LowState_.motor_state[35]`; only slots 0-28 are used. `MotorCmd_` = mode, q, dq, tau, kp, kd (float32). LowState = version[2], mode_pr, mode_machine, tick (u32), imu_state, motor_state[35], wireless_remote[40], reserve[4], crc (LowState_.hpp:28-36). The runner writes mode=1, dq=0, tau=0 and q = default + scale·action without clamping (cpp:2669, 3123-3129).
- CRC: last u32 `crc`. `Crc32Core` uses poly 0x04C11DB7, init 0xFFFFFFFF, MSB-first per u32 word, no final XOR (utils.hpp:105-125). It covers `(sizeof>>2)-1` words of the C++ struct, not CDR bytes (cpp:2618, 2677). A bad LowState is dropped (cpp:2620). The simulator computes no CRC, so rehearsals pass `--disable-crc-check` (rehearse.py:168).
- IMU: LowState quaternion is **wxyz** (cpp:2895, node:83). Gyro frame is not stated; the sim writes free-joint `qvel[3:6]`, which MuJoCo defines body-local (inferred). The sim accelerometer is `qacc[0:3]`, a world-frame coordinate acceleration without gravity rather than a specific force (bridge:190-194). `tick` is sim milliseconds in the sim (bridge:202) and is read by nobody. Runner and node stamp arrival with steady_clock / `time.monotonic()` (utils.hpp:64, node:85).
- **DDS domain 0 everywhere.** It is hard-coded in the runner (cpp:2185) and in the Dex3 helper (dex3_hands.hpp:71, unused with ""). It is the default in yaml:6 (`DOMAIN_ID`), base_sim.py:607, run_robot_sim.py:136, node:740 `--domain 0` and check_robot.py:31. The LIO bridge has no option (ros2_lio_bridge.py:58). Grandloco defaults to 1 (g1_common.py:23). Interfaces: runner argv[1] (cpp:4153), with `lo` from rehearse.py:167. Others: yaml:10, node:739, robot_sim.py:43; loopback Cyclone config at cyclonedds_loopback.xml:13-18.

## ZMQ (all producers bind `tcp://*`, every interface)

| Endpoint | Pattern / producer → consumer | Payload | Studio |
|---|---|---|---|
| `:5556 pose` | node PUB bind (zmq_stream.py:116, node:751, HWM 4) → runner SUB `tcp://localhost:5556` (cpp:4173-4175) | `pose` + 1280 B JSON header + LE arrays; joint_pos/vel IsaacLab order, body_quat wxyz, frame_index i64, timestamp_monotonic | observe only |
| `:5557 g1_debug` | runner PUB bind (zmq_output_handler.hpp:143, cpp:4179-4180) | msgpack, MuJoCo order; 50 Hz **only in CONTROL** (cpp:3971) | observe only |
| `:5557 robot_config` | same socket | msgpack, every 2.0 s (zmq_output_handler.hpp:242), also during INIT | observe only |
| `:5560 cloud` | robot_sim.py:44 PUB 10 Hz → node:747 | stamp = sim seconds (robot_sim.py:222); LIO bridge stamp = monotonic | observe only |
| `:5561 odom` | ros2_lio_bridge.py:44 (UNTESTED) → node:746 (CONFLATE) | pos, quat_wxyz, lin_w, ang_w all-zero placeholder (:99), stamp monotonic | observe only |
| `:5562 control` | node **REP** bind (node:783, 363) | JSON status/go/stand/goal/quit | **forbidden: never connect** |

## Frames

`world_sim | odom → pelvis → waist_yaw_link → waist_roll_link → torso_link → mid360`. Odom depends on `--odom`. With dds it is simulator ground truth. With zmq it is the LIO world: gravity aligned, floor z = 0, origin under the start pelvis, x = start heading (lio.py:10). With leg it is the first sample, yaw from the IMU (node:163). The pelvis MJCF default height is 0.793 m (xml:44). g1_debug `base_trans_measured` is a fixed `(0, -1, 0.793)` placeholder (output_interface.hpp:186). Torso origin at zero waist is (-0.0039635, 0, **0.054**) m in the deployment MJCFs (xml:132+136) but **0.044** in rev_1_0 (g1_29dof_rev_1_0.xml:192) and in `mid360.py:18`. The MID-360 nominal mount on the torso is (0.0002835, 0.00003, 0.428434) m with rpy (π, 0.0511, 0), URDF fixed-axis, R = Rz·Ry·Rx (mid360.py:19-31; upside down). unitree_rl_gym URDFs instead give z 0.41618 / 0.40618 m, rpy (0, 0.0401, 0). `--mount-calib` overrides the mount. Quaternions are wxyz everywhere except **rt/odostate**: its IDL comment says xyzw (`_OdoState_.py:28`), while the sim writes wxyz and the node reads wxyz (node:93).

## Safety thresholds (source configuration for UI gauges)

| Id | Value | Owner | Effect | Source |
|---|---|---|---|---|
| runner_lowstate_absent | 500 ms | runner | stop → one damping cmd (kp 0, kd 8) | cpp:296, 2773 |
| runner_lowstate_late_cue | 50 ms | runner | audio cue only | cpp:295, 2987 |
| runner_reference_absent_cue | 150 ms | runner | debounced audio cue only (2 late ticks; up to ~8 s to clear) | cpp:287-288, 2982 |
| runner_joint_velocity_abort | 35 rad/s | runner | stop; **one-sided** (`dq > 35`), **disabled with --disable-crc-check** | cpp:2832 |
| runner_motor_temp | ≥90 / <85 raw | runner | warning only | cpp:258-259 |
| runner_stream_playback_hold | 46 frames | runner | streamed motion holds | cpp:834, 3395 |
| runner_init_ramp | 3.0 s | runner | ramp to default pose | cpp:2168 |
| node_state_stale_estop | 0.5 s | node | `estop` event + node exits; orchestrator sends `o` | node:671-673, rehearse.py:236 |
| node_tilt_estop | 0.75 rad | node | estop, RUN only, pelvis IMU tilt | node:768, 675, 59 |
| node_cloud_timeout_stand | 1.0 s | node | settle to stand (deferred under ceilings) | node:769, 721 |
| node plan rejection | z < 0.35 m or > 1.0 m; mean speed > 2.5 m/s; non-finite; stale anchor | node | plan dropped | node:506-536, 771-772 |
| node_reference_joint_velocity_clip | 30 rad/s | node | clip, not reject | node:774, 539 |
| node_stall_risk | 46 frames | node | event only | zmq_stream.py:37, node:726 |

## Discrepancies with Studio documents

- `docs/INTERFACES.md` calls runner hand commands "optional". They are created and published every 2 ms unconditionally.
- `INTERFACES.md` lists "optional `rt/odostate`" for the simulator bridge. For G1 it is always published, and it is simulator ground truth.
- `docs/SENSORS.md` maps PD gains and effort limits from `contract.py`: hip pitch/roll 139 N·m, Python-rounded kp. The MuJoCo models those simulations use declare 88 N·m for hip pitch/roll, and the C++ path sends the formula kp.
- HEAD drift: `config/references.json` (df53fd02) vs g1-student-deploy 6a86c860.
- Confirmed, no change needed: `LIVE_OBSERVATION.md`'s reference to cpp line 2185 (`Init(0, networkInterface)`) is still accurate, as is the 46-frame stall in `SOURCE_FINDINGS.md`.
- Reference-doc conflicts kept in the JSON `discrepancies[]`:
  - lucid `ETHERNET_AND_SDK.md:196` says `rt/odostate` goes to the runner.
  - `HARDWARE.md:32` says state stale → stand; the code estops.
  - pp:11 says the "robot SDK" uses IsaacLab order.
  - Mapping-array names are inverted between ct and cpp/g1.py.
  - The unused sim yaml gains swap the hip pitch/yaw labels.
