# Source-backed navigation scenes

The preparation catalog includes three fresh development layouts from the existing Flow scene generator in `/home/linjiw/code/g1-student-deploy/bundle/flow/src/motion2scene_flow/closed_loop/panel.py`. These are generated obstacle arenas, not recorded evaluation results. The catalog calls only the pure `layout(family, rng)` function using fresh Studio development seeds. It never calls `make_panel`, loads a research task template, reads a sealed panel or reads evaluation outcomes.

`/home/linjiw/code/verified-robot-arena/README.md` identifies that repository as a design/specification project without implemented scene code. Its proposed arenas are therefore not presented as runnable source integrations.

| Catalog ID | Existing source family | Geometry | Layout seed | Suggested goal XY, m |
| --- | --- | --- | --- | --- |
| `flow-detour` | `detour` | One 1.8 m standing wall across the direct route | 20261015 | 3.824712, −0.573828 |
| `flow-slalom` | `slalom` | Three alternating 1.9 m wall stubs | 20261016 | 3.876116, −0.090195 |
| `flow-corridor` | `corridor_beam` | Two 1.9 m side walls and one overhead beam | 20261017 | 4.262052, 0.053915 |

The source local frame is X forward and Y left. The catalog uses an explicit identity transform into world coordinates: origin `(0, 0)`, yaw `0`, metres, Z up. Every suggested scenario starts at `(0, 0)` with yaw `0`, requests eight simulation seconds, and uses four candidates/six ODE steps. The planner noise seed is independently set to `0`; it is not the layout seed. These are development settings, distinct from the deployed bundle's 16 candidates/10 ODE steps. The source goal is an editable suggestion, not evidence of reachability or success within the time limit.

Select a scene in **Prepare**, apply its suggested settings, then change the goal by clicking the map or entering world X/Y. A saved scenario records the actual map hash, start/goal, yaw, duration, planner noise seed and planner settings. Subsequent policy tests use those exact boxes in the existing MuJoCo collision builder and capture the resulting sensor observations. Scans remain inspection-only without collision geometry.

Every map exposes a `provenance` object with generator path, file SHA-256, family, layout seed, NumPy version and world alignment. The observed generator hash was `0572da17903622b3d0c4a6a587ffe42fc01a7f303f470ebdc3322bc5d59f3e3c`. A source change refreshes the cache and changes the recorded provenance. The isolated geometry subprocess has a five-second timeout and cannot select a browser-supplied executable or function. It imports no policy/controller runtime, disables bytecode writes, and does not edit the reference repository. Missing or failing sources are omitted; no replacement geometry is fabricated.

Only static native box colliders are supported. Nonzero source `velocity_xy` is rejected before normalization rather than silently freezing a moving scene. Floor height is explicitly zero. Conservative start/goal footprint checks reject immediate standing intersections; they do not establish that the route is navigable, safe or dynamically feasible. The existing Flow route implementation treats unseen map cells as free and may fall back to a direct route when search fails. The cockpit keeps unknown cells visually unknown and reports the real source outcome separately from worker completion.

Geometry validation compiled each map using the actual reference `sim.scene.build_model` and compared every `obstacle_i` position, quaternion and half-extent against the normalized boxes. All seven colliders matched exactly (maximum absolute error `0.0`). Evidence: `/home/linjiw/research-data/g1-deploy-studio/evidence/navigation-scenes/geometry-validation.json`. This check validates geometry integration, not policy navigation success or hardware readiness. Full policy execution and browser evidence are recorded separately in `docs/ACCEPTANCE.md`.

Focused adapter checks:

```bash
.venv/bin/python -m unittest tests.test_scene_catalog tests.test_workbench -v
```

Tests cover deterministic source generation, provenance refresh, absence of reference bytecode writes, rejection of moving boxes, standing-footprint validation and preservation of the 32-map import quota as built-in scenes are added.
