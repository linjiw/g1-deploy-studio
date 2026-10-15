# Adapters

Implemented read-only adapters live in `studio/replay.py` (Flow/SONIC recorded sessions), `studio/protocols.py` (SONIC/Flow ZMQ decoding) and `studio/capture_replay.py` (captured receiver diagnostics). Their tests use actual source serialization and real recorded values.

Unitree DDS, ROS 2 discovery/TF and Grandloco runtime collectors remain future work. No adapter starts hardware control as an import side effect. See `docs/INTERFACES.md` for exact observability boundaries.
