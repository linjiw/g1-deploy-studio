# Verified local code references

Initial inventory observed 2026-10-15. Paths were inspected read-only. Run the checker to detect missing paths/HEAD drift; it does not prove runtime correctness or clean worktrees.

## flow_deploy

Root: `/home/linjiw/code/g1-student-deploy`

Primary integration: Flow planner, perception and SONIC real-time rehearsal.

Observed HEAD: `df53fd02d153759746779cc6674a8644a0faf757`

- `README.md`
- `g1deploy/node.py`
- `g1deploy/contract.py`
- `g1deploy/zmq_stream.py`
- `g1deploy/adapters/ros2_lio_bridge.py`
- `sim/realtime/rehearse.py`
- `docs/HARDWARE.md`
- `docs/READINESS.md`

## sonic_runner

Root: `/home/linjiw/lucid-sonic/lucid-g1-deploy`

Canonical C++ SONIC runner, DDS/CRC conventions, output telemetry and bundled SDKs.

Observed HEAD: `e994a9857add86dbba086aa90e41b7dee3bebb94`

- `README.md`
- `runner/src/g1/g1_deploy_onnx_ref/src/g1_deploy_onnx_ref.cpp`
- `runner/src/g1/g1_deploy_onnx_ref/include/output_interface/zmq_output_handler.hpp`
- `runner/src/g1/g1_deploy_onnx_ref/include/output_interface/ros2_output_handler.hpp`
- `runner/thirdparty/unitree_sdk2`
- `sdk/unitree_sdk2py`
- `sim/gear_sonic_sim/unitree_sdk2py_bridge.py`
- `docs/ETHERNET_AND_SDK.md`
- `docs/HARDWARE_RUNS.md`

## grandloco_deploy

Root: `/home/linjiw/newton-terrain/deploy_g1`

Alternative policy backend and official-interface simulator rehearsal; source is not a Git repository here.

Observed HEAD: `not available`

- `README.md`
- `runner.py`
- `policy_io.py`
- `sim_g1.py`
- `mapping_node.py`
- `msgs.py`
- `third_party/unitree_sdk2_python`
- `third_party/unitree_mujoco`
- `third_party/unitree_rl_gym`

## sonic_backend

Root: `/home/linjiw/groot-wbc-sonic-sim-trackb`

Shared Isaac/SONIC research execution backend: reference only, do not modify running experiments.

Observed HEAD: `305d83c0a79e4c74bfc1a78d79613b13ef728517`

- `gear_sonic_deploy`
- `external_dependencies/unitree_sdk2_python`

## flow

Root: `/home/linjiw/flow`

Ongoing planning/map/safety research. Read latest notes before selecting a checkpoint; do not equate latest HEAD with deployment qualification.

Observed HEAD: `9bd50c205b26ab03160a930002f7a11965c98fe8`

- `research/CLOSED_LOOP_TEACHER_RESULT.md`
- `research/ROUND_AV_PLAN.md`
- `src/motion2scene_flow`

## grandloco_snapshot

Root: `/home/linjiw/g1-grandloco`

Published research mirror, not necessarily synchronized with the active workspace.

Observed HEAD: `96920e82f65c81eb5a4a2c8e188c0268a29e459b`

- `docs/research_log/LEDGER.md`

## sonic_sgs

Root: `/home/linjiw/code/sonic-sgs-planner`

Ongoing token policy and planning experiments; no committed HEAD observed. Not a qualified deployment default.

Observed HEAD: `not available`

- `research/STATUS.md`
- `research/TWO_STAGE_DESIGN.md`

## Reuse strategy

Start with flow_deploy's sim/realtime and sonic_runner's output telemetry. Use grandloco_deploy to validate the same observability contracts against a different deployment process. Never put both low-level controllers on the same hardware bus.

The SDKs are vendored in several old worktrees. Prefer an explicit pinned dependency from the selected runner, not a global PYTHONPATH that accidentally imports another copy. Review Unitree SDK/model licenses and record both repo revision and dirty-tree provenance when using local sources. Do not vendor checkpoints or recursively copy simulation outputs.

External references to evaluate (not installed or version-verified by this bootstrap): Unitree SDK2/SDK2 Python, unitree_mujoco, Unitree ROS 2 integration, ROS 2 TF2/robot_state_publisher/diagnostics, Foxglove bridge, MCAP/rosbag2, Point-LIO/FAST-LIO. Resolve official upstreams, compatibility and licenses before installing.
