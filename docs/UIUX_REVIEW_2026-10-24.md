# UI, UX and visualization review — 2026-10-24

Reviewed and improved the public project page, standalone demo, comparison/next-step page and local Studio. The starting commit was `14a5e7a`; the results below describe the working-tree changes from this review. Validation used Chromium with software WebGL, actual recorded walks, and one bounded CPU rehearsal. Nothing was published or run on a physical robot. The release service was left unchanged.

## Findings and fixes

| Area | Finding | Result |
|---|---|---|
| Replay loading | Failed model loads could leave labels describing a different recording than the scene; empty catalogs left no recovery action | Keep the current scene and metadata until the replacement is ready. Show persistent Retry, mark empty data unavailable, disable transport while loading, cancel superseded session downloads |
| Navigation races | A slow workspace request could activate an editor after the user left | Ignore completion from superseded workspace requests; preserve the newest loading state during startup switching |
| Keyboard | Space on a button/summary could play the recording; Escape inside inputs or Arena failed to dismiss help; the resize separator had no keyboard action | Preserve native control activation, move focus into popovers and back on Escape, support arrow/Home/End resizing with an accessible value |
| Responsive layout | The inspector disappeared at tablet widths; narrow desktop panels clipped camera controls; mobile hid the evidence key | Keep the inspector accessible, stack controls according to the actual viewport width, retain the evidence key and use 44 px touch controls |
| Sensors | Failed requests left old samples and clouds looking current and could repeatedly retry; refresh removed focus | Hide unavailable samples/overlays, offer Retry, bound retries and preserve focus and expanded provenance |
| Arena/timeline | Cancelled or secondary-pointer gestures could continue editing/seeking; browser shortcuts and empty numbers changed geometry | Track the primary gesture, clear cancelled drags, preserve browser shortcuts and reject empty numeric edits. Improve narrow timeline labels and tooltip bounds |
| Public demo loading | Failed boot left partial viewers alive and no useful recovery; loading could not be cancelled | Release failed/cancelled viewers and downloads, provide retry/cancel controls, check WebGL 2, and expose unavailable rooms/recordings |
| Demo/comparison state | A rejected old walk could restore a cleared goal; comparison failures mismatched the caption; picker rebuilds lost focus | Ignore stale responses, preserve the last successful comparison with retry, retain picker focus and clear filtered-out chart selections |
| Rendering | Studio kept two idle animation loops; public paths replaced GPU geometry repeatedly; abandoned models leaked materials | Wake rendering only when needed, reuse line buffers, dispose superseded builds and allow failed mesh loads to retry |
| Visualization integrity | Truncated mesh downloads could become zero-filled geometry; map scale ignored changed resolution; portrait top cameras could clamp too close | Reject corrupt downloads, update scale with resolution, fit portrait cameras, cap large-canvas pixels, and pause/recover after graphics-context loss |

Existing evidence categories and playback semantics remain intact: missing values stay unavailable, simulator truth stays distinct from estimates and commands, and Go on a physical robot remains an operator action. The System boundary text now agrees with Navigate's documented goal/stand-only robot link.

## Measured performance

Paused Studio, same real `sonic-lockstep` recording, 1280 × 900 viewport, 1.2-second sample after settling:

| Measurement | Starting commit | Updated tree |
|---|---:|---:|
| Animation callbacks | 146 | 0 |
| GPU draws | 0 | 0 |

The improvement removes idle JavaScript work; it is not an FPS or battery-life claim. A separate one-second probe measured Studio control updates falling from 60 to zero. Across 200 public path updates that fit the existing buffer, geometry replacements fell from 200 to zero. Public replay also recorded zero idle control updates and draws. Regression checks verify buffer reuse, disposal after cancellation, corrupted downloads, context recovery, and map/camera geometry.

## Executed validation

Evidence is outside Git at `~/research-data/g1-deploy-studio/evidence/uiux-20261024/`.

| Check | Result | Evidence |
|---|---|---|
| Python unit/integration discovery | 385 tests, OK; 11 opt-in runtime tests skipped | `unit-tests.log` |
| Studio replay acceptance | 15/15: pose parity for both models, stale/disconnected telemetry, cameras, layers, system, view links and mobile | `studio-final/ui-acceptance.json` |
| Replay failure/race/keyboard checks | 8/8 | `replay-edges/results-replay-edges.json` |
| Studio responsive, touch, sensors and editor checks | 6/6 | `studio-ux.json`, `studio-*.png` |
| Public site acceptance with 473 recorded walks | 25/25 | `site-check/results.json` |
| Public failure/cancellation/mobile checks | 9/9 | `public-edges-integrated/ux-edges.json` |
| Visualization/resource lifecycle checks | 12/12 | `results-visualization-performance.json` |
| Idle comparison | 146 → 0 callbacks | `idle-comparison.json` |
| Control/buffer comparison | 60 → 0 idle updates; 200 → 0 geometry replacements | `visualization-before-after.json` |
| Real UI rehearsal | Saved arena → live CPU run → recording → Runs comparison passed | `rehearsal/` |

The rehearsal used `flow-bundle-20261008`, four simulated seconds, K4/ODE6, and produced 200 frames. Its scorer outcome was **timeout**, not arrival. This validates the UI workflow and recorded simulation path, not navigation success or hardware readiness.

Reproduce against a checkout gateway and an assembled local public site:

```bash
.venv/bin/python -m unittest discover -s tests -v
STUDIO_URL=http://127.0.0.1:8796 npm run test:browser
STUDIO_URL=http://127.0.0.1:8796 npm run test:browser:edges
SITE_URL=http://127.0.0.1:8816/ npm run site:check
SITE_URL=http://127.0.0.1:8816/ npm run site:check:edges
SITE_URL=http://127.0.0.1:8816/ STUDIO_URL=http://127.0.0.1:8796 npm run test:visualization
STUDIO_URL=http://127.0.0.1:8796 STUDIO_POLICIES=flow-bundle-20261008 STUDIO_DURATION=4 npm run test:rehearsal
```

## Coverage limits

This is targeted edge-case coverage, not an exhaustive accessibility or device certification. Firefox, Safari, physical phones, screen readers, real GPU performance and long-duration memory behavior still need separate validation. The 11 skipped Python tests require explicit runtime integration settings; the bounded rehearsal above was run separately. No robot connection, network reconfiguration, reference-repository modification or external deployment was part of this session.
