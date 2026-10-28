# Website and Studio experience release — 2026-10-28

This release integrates the reviewed recovery, accessibility and rendering fixes with the current light Studio design, then makes the public site explain Learning from Hallucination and show actual recorded behavior first.

## Try it

- Public site: <https://linjiw.github.io/g1-deploy-studio/>
- New research film: <https://linjiw.github.io/g1-deploy-studio/#research-film>
- Interactive explanation: <https://linjiw.github.io/g1-deploy-studio/#learning>
- Recorded Film camera: <https://linjiw.github.io/g1-deploy-studio/demo/#doorway/g18-14/film>
- Local Studio service: <http://127.0.0.1:8790/>. The service serves a committed release worktree, with hardware disabled.

The local Rehearse policy chooser includes **Flow WXD-TNP-R2-RF · research teacher · tnp_s0**, bundle `flow-wxd-tnp-r2-rf-7fb8423-s0`. Its CPU dependency pins include the teacher, WM2 and all four WM5 refinement checkpoints. The adopted-heading detector remains faithful to the research heading; the newer bundle records its explicit adoption evidence without pretending that the stale heading matches it.

## What changed

- Studio preserves the current Stage/Details layout and improves load retry, cancellation, workspace races, keyboard focus, sensor recovery, empty states and small-screen controls.
- Paused and offscreen 3D views stop rendering. Path updates reuse buffers; obsolete loads release resources; context loss has an explicit recovery path.
- Public Film mode frames the task, tracks the recorded body and shows its finish. Seeking is deterministic, dragging takes camera control, and reduced-motion preferences use a still view. Robot poses are unchanged.
- The LfH explanation follows motion, compatible scenes, conditional learning, runtime candidates, execution checks and SONIC tracking. Conceptual illustrations are distinct from recorded evidence, and original LfH/HLSD sources are linked.
- Two native, captioned films load only on playback and pause offscreen. The newer research film is directly reachable from the hero. Navigation, touch controls and the explanatory diagrams remain usable at 320 px.

## Evidence identity

The Navigate showcase contains three selected clean arrivals from the frozen October 8 student bundle: doorway `g18-14`, detour `g17-01`, and clutter `g20-12`. Selection requires zero recorded obstacle contact, final truth error at most 0.4 m, duration at most 20 seconds, then the farthest goal. The existing 473-walk catalog, outcomes and failures are preserved.

The newer research film contains only two explicitly selected R2 retrieval-free development recordings: `drill_duck-60000` and `storage_clutter-60000`. These are Isaac/SONIC recordings with privileged scene geometry, not MuJoCo/LiDAR Navigate runs. Arrival times are 6.12 s and 10.02 s, final truth distances 0.363 m and 0.307 m, with zero recorded obstacle contact in both. This is a showcase, not an aggregate policy comparison. The recorded goal rule permits motion at arrival.

Export checks verify the exact recording and callback hashes, original 50 Hz clock, source/reference joint order, quaternion convention, state continuity, contact samples and final goal distance. Full sessions stay outside the public release. The public G1 mesh is a display avatar; original recording-time checkpoint hashes were not saved. Sanitized provenance describes these limits explicitly.

## Validation

- Python: **421 tests, 14 skips**, no failures.
- Studio: replay acceptance, Stage, replay edge cases, responsive UI/sensor edge cases, and rendering lifecycle checks.
- Website: general acceptance, failure recovery, cinematic camera, story/data parity, responsive navigation, and actual video decoding/playback/seeking/captions.
- R2 CPU smoke: real SONIC ONNX and MuJoCo, 10 ticks / 0.2 simulated seconds, two accepted WM5 refinement passes. Replay roundtrip error below `3e-8`. The expected deadline outcome was `timeout`; this is integration evidence, not a goal-success test. Planner p50 was 2.065 s and p95 2.448 s, so this CPU path is slower than real time.
- Research-film export: 307 duck and 502 clutter pose samples including the final post-action state; exact state continuity and final-distance parity; no fabricated LiDAR or estimated pose.

Browser checks use Chromium with real WebGL and recorded data at desktop, tablet, 320/390 px phone and landscape sizes. They do not establish cross-browser or hardware qualification. Evidence is stored outside Git in `~/research-data/g1-deploy-studio/evidence/site-launch-20261028/` and `evidence/uiux-20261028/`.

The website uses checksummed `site-v5` release assets. No weights, full recording logs, machine paths or local-only next-step material are published. Publishing the public site and updating the local committed release were explicitly requested by the owner.
