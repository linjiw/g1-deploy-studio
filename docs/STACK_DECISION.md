# Local replay stack decision

Use a small Python read-only gateway and Three.js ES modules. The gateway translates existing NumPy/JSON rehearsal data and reads the matching local MJCF/STL files. The browser needs no robot middleware or credentials. Python and browser dependencies are pinned and installed only inside this checkout.

Foxglove supports custom schemas through MCAP or custom loaders ([official custom-data documentation](https://docs.foxglove.dev/docs/getting-started/custom)). It is a good independent inspection tool, but these recordings require decoding and careful clock/semantic interpretation regardless of viewer. The first cockpit needs explicit distinctions between simulator truth, planner diagnostic world position, controller references, unavailable low commands, and final map snapshots. A compact custom view makes those distinctions persistent. MCAP export preserves a portable route to other tools; native Foxglove 3D schema conversion is separate future work.

[MCAP](https://mcap.dev/spec) provides timestamped heterogeneous messages and indexes; use its maintained Python writer, not a new container format. Relative replay timestamps must be labelled relative rather than fabricated Unix acquisition timestamps.

[Three.js](https://threejs.org/docs/) supplies 3D transforms, mesh loading, and orbit controls. Actual local MJCF joint offsets/axes and raw STL files drive the twin; there is no hand-authored robot skeleton. MuJoCo kinematics provides an independent frame-alignment oracle. No vendor meshes or third-party source are committed. The referenced SONIC repository has an Apache-2.0 root license; model-specific redistribution rights have not been established, so assets remain local references.

ROS 2 discovery cannot describe direct Unitree DDS or ZMQ traffic. This host has no verified ROS 2 installation. The initial graph therefore labels source-configured topology and recorded evidence explicitly; ROS graph/TF/QoS discovery and DDS participant discovery remain unimplemented. The ZMQ recorder reports its own observed receive rates and missing source metadata without claiming publisher discovery.

The canonical SONIC C++ runner currently hard-codes DDS domain 0. Launching it would violate the requested simulator-domain boundary. The cockpit opens existing recordings; it does not start that runner or alter its repository.
