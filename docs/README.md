# Documentation index

Start with **[STATUS.md](STATUS.md)**: one page with what works, the current results, the open issues and who owns each one.

## Current guides (kept up to date)

| Document | Read it for |
|---|---|
| [STATUS.md](STATUS.md) | Current state, results, open issues, decisions and their dates |
| [INSTALL.md](INSTALL.md) | Installing Studio, the deploy stack and the pinned navigation policy on another machine; configuration; updating the pin |
| [SERVICE.md](SERVICE.md) | Starting, releasing and reaching Studio (systemd unit, SSH tunnel) |
| [WORKBENCH.md](WORKBENCH.md) | Arena editor, rehearsals, suites, the Runs report, data layout and API |
| [POLICIES.md](POLICIES.md) | Policy profiles, how the Flow WX-RF block is pinned and run, latency anchoring, actuator profiles |
| [ROBOT_CONTRACT.md](ROBOT_CONTRACT.md) | Source-verified Unitree G1 contract: joint order, gains, limits per hardware revision, discrepancies |
| [REALTIME_REHEARSAL.md](REALTIME_REHEARSAL.md) | The isolated L3 chain: decision, verified probes, the launcher, the M5 read-only robot plan |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Studio's place in the SONIC pipeline and its integration contract |
| [ROADMAP.md](ROADMAP.md) | Next steps toward a read-only physical G1 |
| [NAVIGATE.md](NAVIGATE.md) | **Navigate**: goals on the robot's own map with the simulated or the real robot; goal checks, scan to twin; the session contract |
| [DEPLOY_FIDELITY.md](DEPLOY_FIDELITY.md) | How close the simulated robot is to node.py: stand modes and their measured contacts, node.py's latency rule, the deploy preset, the remaining gaps |
| [REAL_WORLD_DEPLOYMENT.md](REAL_WORLD_DEPLOYMENT.md) | Design: seeing the robot's perception, building maps from it, putting goals on them and watching real runs |
| [STAGE.md](STAGE.md) | Stage: one run full screen, its layers and provenance, what it took from SuperMimic and Codex, and its browser test |
| [SITE.md](SITE.md) | The public site: recorded walks of the real stack, how they are made, hosted and kept light |
| [CODE_REFERENCES.md](CODE_REFERENCES.md) | Verified file references in the reference repositories |
| [../tools/video/README.md](../tools/video/README.md) | Rebuilding the introduction video |

## Evidence reports (dated; numbers are tied to the commit they ran on)

| Document | Contents |
|---|---|
| [UIUX_REVIEW_2026-10-24.md](UIUX_REVIEW_2026-10-24.md) | Website, demo and Studio UX fixes, rendering measurements, failure/mobile regressions and CPU rehearsal evidence |
| [ROBUSTNESS.md](ROBUSTNESS.md) | Random-goal campaign. Addenda: open floor (A), latency (B), predictive anchoring (C), actuator profiles (D) and firming runs (E) |
| [VALIDATION.md](VALIDATION.md) | First independent validation (v0.2, 101 checks) |
| [REVALIDATION.md](REVALIDATION.md) | Re-validation (v0.3, 118 checks) and the fix verification |
| [REVIEW-20261021-NAVIGATE.md](REVIEW-20261021-NAVIGATE.md) | Navigate review session: what was built, the review, validation and verification findings and their fixes, final regression |
| [REVIEW-20261020.md](REVIEW-20261020.md) | v0.4 review session: independent review, two verifications, every finding and its fix, final regression, a 10-minute walkthrough |
| [ACCEPTANCE.md](ACCEPTANCE.md) | Executed acceptance checks (v0.2) |

## Background and history (accurate when written; superseded where STATUS.md says so)

[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) · [STACK_DECISION.md](STACK_DECISION.md) · [SOURCE_FINDINGS.md](SOURCE_FINDINGS.md) · [INTERFACES.md](INTERFACES.md) · [MODEL_PIPELINE.md](MODEL_PIPELINE.md) · [SENSORS.md](SENSORS.md) · [SCENES.md](SCENES.md) · [POLICY_BACKEND.md](POLICY_BACKEND.md) · [NAVIGATION_TESTS.md](NAVIGATION_TESTS.md) · [FIXED_PLANNER_GOALS.md](FIXED_PLANNER_GOALS.md) · [PLANNER_REVIEW.md](PLANNER_REVIEW.md) · [LIVE_OBSERVATION.md](LIVE_OBSERVATION.md)
