# Stage: one run, full screen

**Stage** is a full-screen view of a Studio run, either a replay or a rehearsal: the robot, its reference, the plan and the room, with only the controls needed to watch them. It uses Studio's own scene, data and actions. It is a presentation, not a second app: it adds no worker, no model and no motor-command path. Codex built the first version as the "Flow stage". It was then reviewed, renamed and restyled to match Studio's white design and the site's demo.

## Use it

Click **Stage** in the top bar, or open a view link with `focus=1`, for example `http://127.0.0.1:8790/?workspace=rehearse&focus=1`. Opening the link never starts a run.

- **Top left** shows the title, the layer pills (Robot, Reference, Planned, Path, Room) and what the stage is showing:
  - the mode (recording replay, live CPU simulation, arena preview);
  - the run's title and its recorded outcome;
  - **Showing**: the policy that produced the displayed recording;
  - **Map**: where the planner's map came from (for example "Privileged scene boxes · simulator truth");
  - **Next run**: the policy selected for the next rehearsal. It is not the displayed one.
- **Top right**: *Back to Studio*, plus the simulated time, goal distance and obstacle contact at the cursor. A value that the recording does not carry reads **Unavailable**, never zero.
- **The dock**:
  - **Setup** opens the existing Rehearse form as a sheet (policy, arena and preset, criterion, latency, actuator limits, budget), and **Run preset** starts one bounded owned CPU rehearsal.
  - **Restart**, **Play** and the scrubber control the recording only. They never pause a live worker; **Cancel run** uses the owned-worker cancellation.
  - **Camera** cycles Orbit, Follow, Top and Fit.
  - **Details** opens the full inspector.
- **Keys:** Escape closes a sheet and returns focus to its button; outside a sheet it leaves the stage. Space plays when a recording is open.

Changing the arena or preset in Setup shows a labelled **arena preview**. Its facts stay unavailable until a run supplies samples.

## What the layers mean

- **Robot**: the executed body (simulator state in a rehearsal; the recorded state in a replay).
- **Reference** (pink): the pose SONIC is asked to track now. It is drawn behind the robot, so it shows only where it differs from the executed body. A reference is a command, not a prediction that the tracker will reach it.
- **Planned** (amber): the planner's intended future, at +0.4 s and +0.9 s.
- **Path**: the recorded path (grey) and the part travelled so far (teal).
- **Room**: the configured collision boxes. For a privileged profile (WX-RF, WXD) these are the exact boxes the planner used; they are not a LiDAR observation.

Missing channels stay missing. Coordinate frames are a Studio layer (off by default); the stage leaves them out.

## What we took from SuperMimic, and what we left

The [SuperMimic project page](https://supermimic.github.io/) explains a controller with one large interactive scene, very few controls, and comparisons that change one thing at a time. Its look is white and quiet. Studio and the [site](https://linjiw.github.io/g1-deploy-studio/) follow the same principles:

- the scene first, on a white floor, under floating white-glass chrome;
- one dock;
- the body and the consequence of a decision side by side, with explanatory layers revealed on request.

This is an independent adaptation of an idea. SuperMimic's [demo licence](https://supermimic.github.io/demo/LICENSE.html) forbids reverse engineering, automated access, copying its materials and using its outputs. No demo code, styles, models, assets or outputs are used here. SuperMimic trains a tracking policy with a world model. Flow plans whole-body references that a frozen SONIC tracker follows. The stage does not describe one in terms of the other.

From Codex's first version, we kept:
- the provenance block (Showing / Map / Next run);
- "Unavailable" in place of zeros;
- the setup and details sheets;
- the keyboard handling.

We dropped:
- the separate light palette that the stage swapped in and restored: all of Studio is light now;
- the heavy dark START/GOAL plates, now small white labels;
- the always-on axis lines, now an opt-in layer.

## Policies

Rehearse preselects the policy that Flow's adoption record names, when it is built locally, and otherwise the deploy bundle. Check **Showing** rather than assuming which model is installed. Research adoption is not robot qualification: the privileged profiles plan from the exact scene boxes, and Navigate's sensor-driven bundle is a different profile. Budget, latency and simulator differences remain visible. See [policies](POLICIES.md).

## Verification

`tools/browser/stage.mjs` (`npm run test:stage`) checks the stage against a gateway:

- the boot preview;
- the Setup sheet;
- one bounded live run, or a named recording with `STAGE_JOB`;
- real geometry, and layer switches that hide the actual scene objects;
- seek, play, restart and the cameras;
- the provenance when the next run's policy differs;
- the details sheet and Escape;
- 390 px and 320 px layouts without overlaps;
- returning to Studio.

Run it against an isolated gateway with its own workbench, not the service on 8790:

```bash
.venv/bin/python -m studio.server --port 8798 --data-root ~/research-data/g1-deploy-studio/<scratch-workbench>
STUDIO_URL=http://127.0.0.1:8798 npm run test:stage                       # starts one bounded run
STUDIO_URL=http://127.0.0.1:8798 STAGE_JOB=<job-id> npm run test:stage    # replay only
```

The live mode refuses to start while another worker is active, and refuses to start a second run from the same evidence directory. This verifies visualization and integration. It does not verify policy performance, real-time fidelity or hardware readiness.
