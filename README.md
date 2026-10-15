# G1 Deploy Studio

Developer cockpit for Unitree G1 deployment rehearsal, perception, synchronized digital-twin visualization and deployment observability. **Bootstrap repository: no dashboard or robot adapter is implemented yet.**

## Start here

- [Verified local code references](docs/CODE_REFERENCES.md)
- [Architecture and SONIC contract](docs/ARCHITECTURE.md)
- [Implementation milestones](docs/ROADMAP.md)
- [Agent development rules](AGENTS.md)
- [Machine-readable references](config/references.json)

```bash
cd /home/linjiw/code/g1-deploy-studio
python3 tools/check_references.py
python3 -m unittest discover -s tests -v
```

The checker only reads paths and Git metadata. It does not import deployment libraries, open DDS participants, start simulations or connect to robots. Observed Git heads are provenance snapshots, not dependency locks: referenced worktrees may be dirty and may move. Review/version actual integration dependencies before use.

## Product modes

1. **Replay:** synchronized state, reference, maps, perception, diagnostics and communication events.
2. **Simulation rehearsal:** existing SONIC deployment processes, simulator-only DDS domain, telemetry sidecar.
3. **Live observation:** read-only robot telemetry after separate safety review. No motor publisher in the dashboard.

First milestone: one real recorded/simulated SONIC deployment session displayed in a browser with measured robot pose, reference ghost, point cloud/map, protocol graph, timing and replay. Synthetic fixtures must be visibly labelled and never presented as real robot evidence.

## Source boundaries

This repository integrates the existing deployment stacks rather than copying them. Keep native policy execution and safety in their deployment processes; observe through adapters. ROS 2, Unitree DDS and ZMQ are distinct transports and all must appear in the communication view. No hardware success is established by this repository.

Large recordings belong outside Git (recommended configurable data root `~/research-data/g1-deploy-studio`). That data folder is not created by this bootstrap. No external dependency or robot model is vendored and no third-party redistribution license is assumed.
