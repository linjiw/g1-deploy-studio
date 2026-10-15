# G1 Deploy Studio

Local, read-only developer cockpit for Unitree G1 deployment replay. A working browser application decodes real recorded SONIC/MuJoCo executions, renders the matching articulated G1 model, and synchronizes reference intent, joints, planner timing, events, and provenance.

**Implemented and exercised:** recorded replay, local model rendering, reference-window inspection, final-map inspection, normalized MCAP export/import, and a bounded loopback ZMQ telemetry recorder. **Not hardware validated:** no robot connections, DDS participants, motor writers, or controller launchers exist in the dashboard. A new full C++/DDS simulation run is blocked by the referenced runner's hard-coded domain 0 and the host's NVML mismatch; see [limitations and evidence](docs/ACCEPTANCE.md).

## Run the cockpit

```bash
cd /home/linjiw/code/g1-deploy-studio
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
.venv/bin/python -m studio.server
```

Open **http://127.0.0.1:8790**. Port 8765 was already occupied on this host and is left alone. The gateway refuses public binding and cross-origin telemetry requests. Remote access requires an authenticated tunnel; it is not a public service.

The recording selector opens three explicitly selected local sources without copying their trees:

- **SONIC · recorded lockstep rehearsal** (default): 159 recorded pre-action poses over 3.16 seconds, 29-DoF rubber-hand G1, ten reference samples spanning 0–0.9 s, planner path and latency. This is real recorded in-process MuJoCo/SONIC ONNX execution; DDS/ZMQ was not used in that original run. The reference world path is a planner diagnostic, not an input consumed by SONIC.
- **SONIC · recorded C++ / DDS tutorial**: 1,922 articulated poses over about 40.39 seconds, Dex3 hands, planner events and final accumulated perception map. Reference and low-command packets were not captured, so the ghost and command metrics are unavailable. The map is an unsynchronized final snapshot, never a reconstruction of perception at the cursor.
- **ZMQ · observed transport diagnostics**: a new local capture of 40 reserialized recorded reference packets, plus actual connected, stale and disconnected receiver events. Replay its observed communication edge, rates, packet values and receipt ages. Robot pose is unavailable in this capture; the viewport explicitly says so. This is a transport rehearsal, not new SONIC inference or original deployment wire traffic.

Use play/pause, seek and speed to inspect the same session clock across panels. Orbit, Follow and Top cameras and layer switches control the digital twin. The inspector contains intent, joint errors, health, configured communication topology, and source fingerprints. Missing metrics remain unavailable. Simulation truth is never labelled physical measurement.

`config/sessions.json` registers the demonstrated paths. For a different local recording, create ignored `config/local.json` with the same `sessions` structure and run:

```bash
.venv/bin/python -m studio.server --config config/local.json --port 8790
```

Each entry needs `id`, `label`, and `path` (a supported recording directory, a Studio-exported `.mcap`, or a single-endpoint `pose` recorder `.jsonl` capture). An optional `environment_path` points to an explicitly chosen boxes JSON file. Model and mesh files stay in the existing reference repositories; those files must remain available for articulated MCAP replay. These are explicitly trusted local inputs, not arbitrary browser uploads.

## Record telemetry and export replay

Capture subscribes only to supported telemetry topics on literal loopback endpoints. It does not launch a runner or create a DDS participant. Only use endpoints belonging to an authorized isolated rehearsal:

```bash
.venv/bin/python -m studio.recorder --help
.venv/bin/python -m studio.recorder --endpoint tcp://127.0.0.1:5557 --topic g1_debug --output /absolute/data/root/capture.jsonl --duration 10
```

This command is an example, not a statement that a debug producer is currently running. The capture keeps wire bytes, normalized messages, receive health and transport events; it is independent of browser lifetime. There is no dashboard control API.

Export the demonstrated replay to indexed MCAP (exclusive creation; output must not already exist):

```bash
.venv/bin/python -m studio.export \
  /home/linjiw/code/g1-student-deploy/runs/smoke/__start_stand_ \
  /absolute/data/root/sonic-replay.mcap \
  --environment /home/linjiw/code/g1-student-deploy/runs/rt/replay-beams2-101/boxes.json
```

MCAP indexes use explicitly labelled session-relative nanoseconds; they are not invented Unix acquisition times. Source clocks and unavailable receipt timestamps remain in each frame. Generic MCAP tools can inspect JSON fields; native Foxglove 3D conversion is not implemented. Single-endpoint `pose` recorder JSONL opens as a diagnostics replay with no world-space robot pose. Other recorded topics can be decoded and inspected in JSONL, but do not yet have a browser capture importer.

## Verify

```bash
python3 tools/check_references.py
.venv/bin/python -m unittest discover -s tests -v
# With the cockpit running:
npm run test:browser
# Real recorded values → actual source serializer → owned random-loopback ZMQ → decoder:
.venv/bin/python tools/accept_wire.py --output-dir /absolute/data/root/new-wire-evidence
```

Browser acceptance requires a Chromium executable (the test uses the installed Chrome on this host; `CHROME_PATH` can override it). Evidence and screenshots are written outside Git. See [acceptance](docs/ACCEPTANCE.md), [interfaces](docs/INTERFACES.md), [source findings](docs/SOURCE_FINDINGS.md), [stack decision](docs/STACK_DECISION.md), and [live observation preparation](docs/LIVE_OBSERVATION.md).

## Start here

- [Verified local code references](docs/CODE_REFERENCES.md)
- [Architecture and SONIC contract](docs/ARCHITECTURE.md)
- [Implementation milestones](docs/ROADMAP.md)
- [Agent development rules](AGENTS.md)
- [Machine-readable references](config/references.json)

```bash
cd /home/linjiw/code/g1-deploy-studio
python3 tools/check_references.py
.venv/bin/python -m unittest discover -s tests -v
```

The checker only reads paths and Git metadata. It does not import deployment libraries, open DDS participants, start simulations or connect to robots. Observed Git heads are provenance snapshots, not dependency locks: referenced worktrees may be dirty and may move. Review/version actual integration dependencies before use.

## Product modes

1. **Replay:** synchronized state, reference, maps, perception, diagnostics and communication events.
2. **Simulation rehearsal:** existing SONIC deployment processes, simulator-only DDS domain, telemetry sidecar.
3. **Live observation:** read-only robot telemetry after separate safety review. No motor publisher in the dashboard.

The first vertical slice uses actual recorded simulation data. Synthetic packets in malformed-input unit tests are test fixtures, not integration evidence. The wire acceptance reserializes real recorded reference values through the actual source serializer; it does not claim new controller inference or original wire capture.

## Source boundaries

This repository integrates the existing deployment stacks rather than copying them. Keep native policy execution and safety in their deployment processes; observe through adapters. ROS 2, Unitree DDS and ZMQ are distinct transports and all must appear in the communication view. No hardware success is established by this repository.

Large recordings belong outside Git (recommended data root `~/research-data/g1-deploy-studio`). No external dependency, policy weight, robot mesh, recording or third-party source is vendored. No third-party redistribution license is assumed.
