# Simulation integration

The cockpit replays real historical MuJoCo/SONIC executions. `tools/accept_wire.py` exercises recorded reference values over an owned random-port loopback ZMQ connection; it does not run controller inference or physics.

A new full C++/DDS rehearsal is blocked: the canonical SONIC runner hard-codes domain 0, which does not satisfy this project's nonzero simulator-domain requirement. No launcher is enabled. The host also reports an NVML driver/library mismatch. See `docs/LIVE_OBSERVATION.md` for the reviewed integration prerequisites.

Future integration must keep existing environments, weights and source trees intact, validate every participant's explicit simulator domain/interface, and fail closed. No hardware script may be used as discovery setup.
