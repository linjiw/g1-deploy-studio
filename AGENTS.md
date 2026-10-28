# G1 Deploy Studio development rules

Read README.md, docs/CODE_REFERENCES.md and docs/ARCHITECTURE.md before implementation.

- Build working replay/simulation slices first, with visible evidence and real tests. The repository is a bootstrap, not a finished cockpit.
- Respect the SONIC pipeline: planner -> versioned ZMQ reference -> existing SONIC runner -> Unitree DDS commands. The dashboard never owns rt/lowcmd or hand-command writers.
- Deploy (docs/DEPLOY.md) relays an operator's press to the deploy kit's console, which owns the robot and every gate. Never synthesize a press, never retry an act in the gateway, never add a motor or DDS path, never move a gate into Studio. Keep `/api/deploy/estop` and `/api/deploy/direct` on the reserve admission tier and free of calls to the deploy service. Studio's E-STOP goes through the console process: wherever an E-STOP is shown, say that only the physical E-stop is independent of it.
- Never restart or release the gateway while the deploy kit reports a live session (`tools/studio_service.sh guard`); it carries Deploy's E-STOP.
- Default to replay/read-only. Live robot mode requires explicit operator authorization, safety review and physical emergency-stop/gantry procedures appropriate to the test. UI emergency controls cannot replace independent physical safety.
- Simulation and robot networks must be isolated. Use a simulator-specific DDS domain on loopback; never silently fall back to robot domain 0. Do not launch existing hardware scripts from discovery/check tools.
- References are read-only integration sources. Do not modify other repositories, their environments or running jobs without explicit approval. Never recursively copy outputs/input_snapshot trees.
- Preserve protocol framing, joint order by name, units, quaternion convention, timestamps, clock domain, model identity and gains. Verify against actual code and parity data; documentation may be stale.
- Mark measured / estimated / commanded / simulator-ground-truth data separately. Display stale/unknown states; never turn missing telemetry into healthy zero values.
- ROS graph is not the whole system. Identify DDS and ZMQ edges and distinguish configured topology from discovered/observed traffic. Record provenance and timestamp of every metric.
- Keep the visualization gateway off the real-time control path. Bound queues, decimate point clouds, prevent backpressure, and test disconnect behavior.
- No sealed-test reads, new research training, robot actuation, external publishing or global system/network changes as incidental setup.
- Do not commit credentials, local network secrets, weights, logs, recordings, vendor meshes or third-party source without a license review. Use config/local.json (ignored) for machine overrides.
- New agent work should run tests and a real replay/simulation acceptance path before claiming functionality. Readiness checklists and parsed source code are not hardware verification.
