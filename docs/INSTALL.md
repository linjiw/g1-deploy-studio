# Install Studio and the navigation deploy policy on another machine

This guide installs Studio, the deploy stack it drives and the pinned navigation policy, configures them, and checks the result. One command does each step. Each step can be rerun safely: it skips what is already in place and never overwrites a checkout or a config file.

What is pinned lives in [`config/deploy.json`](../config/deploy.json):

| Piece | Where it comes from | Pinned as |
|---|---|---|
| Studio | this repository (public) | the commit you check out |
| Deploy stack: `node.py`, the route adapters, the MuJoCo rehearsal | `linjiw/g1-student-deploy` (**private**) | tag `deploy-2026-10-23` (`6a86c86`) |
| Navigation policy: the frozen bundle (the student planner `student-s2-kcsc_s0` from 2026-10-08, its planner source, SONIC ONNX, the MID-360 pattern) | assets of that tag's private release, about 0.87 GB | each asset's SHA-256, then every file against `bundle/MANIFEST.json` at the tag |
| SONIC C++ runner | `linjiw/lucid-g1-deploy` (public) | commit `e994a98` |

In Studio this policy is the profile `flow-bundle-20261008`. It is the only profile that Navigate, the robot link and the robot run. The weights, the planner source and the recordings stay out of this public repository: you need `gh auth login` with access to the private repo.

There are three levels. Each needs the ones before it.

| Level | What works | Steps |
|---|---|---|
| **Replay** | The browser app: Arena, Runs, System, and the recordings this machine has (a new machine has none until its first Navigate session or rehearsal, or until `config/local.json` lists some) | 1 |
| **Simulation** | Navigate's simulated robot and Rehearse, with the deploy policy on the CPU | 1–3 |
| **Robot link** | The deploy PC next to the robot: the SONIC runner and `config/robot_link.json` | 1–5 |

**Target:** Ubuntu 22.04 on x86_64.
- **Replay:** Python 3.10+ with its venv module, Node.js 18+ (`npm`) and `git`. On a stock Ubuntu 22.04, run `sudo apt install python3-venv git`. Its apt Node.js is too old, so use [nvm](https://github.com/nvm-sh/nvm) or NodeSource. The installer stops with that advice when either is missing.
- **Simulation:** also the [GitHub CLI](https://cli.github.com) logged in, and [uv](https://docs.astral.sh/uv/) for the deploy venv (Python 3.11).
- **Disk:** about 10 GB (the deploy venv with CUDA torch is about 7 GB).
- **Memory:** a simulation session uses about 2.5 GB.
- **The robot:** an NVIDIA GPU for the planner. Studio's simulations run on the CPU.

## 1. Studio

```bash
git clone https://github.com/linjiw/g1-deploy-studio ~/code/g1-deploy-studio
cd ~/code/g1-deploy-studio
tools/install.sh                 # .venv + requirements.txt, npm ci (three.js, Inter), then tools/doctor.py
```

Every machine path has a default under `$HOME`:
- deploy stack: `~/code/g1-student-deploy`;
- runner: `~/lucid-sonic/lucid-g1-deploy`;
- data: `~/research-data/g1-deploy-studio`.

To put them elsewhere, add `--deploy-root DIR`, `--lucid-root DIR` or `--data-root DIR`. The installer then writes them into `config/local.json`, which Git ignores ([Configuration](#configuration)).

## 2–3. The deploy stack and the navigation policy

```bash
gh auth login                    # once, with access to linjiw/g1-student-deploy
tools/install.sh --deploy
```

This does three things:
- clones the deploy repo and checks out the pinned tag (detached);
- creates its venv with the versions g1-student-deploy's `docs/OPERATOR_GUIDE.md` pins (Python 3.11, torch 2.7.0 with CUDA 12.8, its `requirements.txt`);
- runs `tools/deploy_bundle.py fetch`, which downloads the release assets with your gh login, checks them against `config/deploy.json`, extracts them into `bundle/`, and verifies all 141 files against the tag's `MANIFEST.json`.

`cyclonedds` builds against the C library that the runner's `setup.sh` installs (step 4). Until that exists it is skipped, and only the robot needs it.

**Without network for the bundle:**
1. Copy the two assets from the release page (or from `~/research-data/g1-deploy-studio/deploy-assets/deploy-2026-10-23/` on the machine that packed them).
2. Run `.venv/bin/python tools/deploy_bundle.py fetch --from DIR`. The checks are the same.

This covers the bundle only. Two other pieces still need network or a copy:
- the deploy repo clone (or a copy of the checkout at the tag);
- the Python packages of both venvs.

`fetch` never overwrites a file that exists and differs. It refuses before downloading, and names the file; move it out of `bundle/` and fetch again. A complete bundle downloads nothing. `.venv/bin/python tools/deploy_bundle.py verify` rechecks every file at any time.

The TensorRT engines (`*.trt`) are not in the bundle. The runner builds them for the local GPU on its first start: about 30 s for the policy and about 7 min for SONIC's planner.

## 4. The SONIC runner (deploy PC only)

```bash
tools/install.sh --runner        # clones lucid-g1-deploy at the pinned commit; never builds, never uses sudo
cd ~/lucid-sonic/lucid-g1-deploy && bash setup.sh && source env.sh && bash build.sh   # in a real terminal: setup.sh asks for sudo
cd ~/code/g1-deploy-studio && tools/install.sh --deploy                              # now adds cyclonedds to the deploy venv
```

Until the runner is built, `doctor --for robot` reports it ✗ with the build command. `install.sh` shows that verdict but still exits 0: building the runner is the one step it leaves to you.

## 5. The robot link (deploy PC only)

```bash
tools/install.sh --robot-link    # config/robot_link.json from the example (loopback endpoints; not overwritten)
```

Studio runs on the deploy PC beside `node.py`, the SONIC runner and the LIO bridge, and talks to them on loopback only. It sends `node.py` a checked goal (only while the robot stands) or a stand request, and reads its status. It never sends Go: the operator presses `g` on the node console and keeps the remote and the physical E-stop. `limits.max_goal_distance_m` (3 m) caps a goal. See [NAVIGATE.md](NAVIGATE.md) (Real robot) and the deploy repo's `docs/OPERATOR_GUIDE.md` and `docs/HARDWARE.md`.

## 6. Check

```bash
.venv/bin/python tools/doctor.py               # exit 0 when Simulation is ready (tools/doctor.py also works: it reruns under .venv)
.venv/bin/python tools/doctor.py --for robot   # the deploy PC
```

`doctor` is read-only. It lists every check with ✓, ! (warning), ✗ (blocking) or · (information), gives the command that fixes each ✗, and ends with one line: `Ready for: Replay yes, Simulation (Navigate, Rehearse) yes, Robot link (deploy PC) yes`.

What it checks:
- **Studio:** packages and browser files.
- **Paths:** each root, and where its value came from.
- **Deploy stack:** the commit against the pin, a clean tree, and that the deploy interpreter imports torch, MuJoCo and onnxruntime.
- **Bundle:** the full SHA-256 check (`--quick` checks sizes only).
- **Robot:** the runner binary and its commit, CycloneDDS, `config/robot_link.json`.

"Ready" for the robot means configured, not tested on hardware: nothing in Studio has run on a robot.

## 7. Test and use

```bash
.venv/bin/python -m unittest discover -s tests                     # unit + integration; skips what this machine lacks
.venv/bin/python -m studio.server --port 8790                      # or once: tools/studio_service.sh install (systemd --user)
```

Open http://127.0.0.1:8790/, or from another computer through `ssh -N -L 8790:127.0.0.1:8790 <user>@<host>`. The gateway listens on loopback only. A new machine opens on Navigate with "No recordings yet" until it has one.

1. **Simulated robot.** Open Navigate, pick a world, then Start session, a goal on the map, Send, Go. Studio runs the deploy policy and node.py's state machine in MuJoCo and records the session. **Use deploy settings** sets the planner budget, latency rule, odometry and stand behaviour to node.py's on the robot ([DEPLOY_FIDELITY.md](DEPLOY_FIDELITY.md)); Advanced settings change each one ([NAVIGATE.md](NAVIGATE.md)). End session: the recording opens in Replay.
2. **Browser acceptance**, once a recording exists: `STUDIO_URL=http://127.0.0.1:8790 npm run test:browser` (read-only; it needs Chrome at `/opt/google/chrome/chrome` or `CHROME_PATH`). It replays the newest recording. The checks that need the original machine's three demonstration recordings are listed as skipped, never as passed.
3. **Robot link without a robot.** `tools/fake_node.py` is a loopback protocol fixture, not a robot. It speaks the deploy PC's wire formats and can inject a readback error, a frame offset or a deferred stand. Point a scratch copy of `config/robot_link.json` at its endpoints with `STUDIO_ROBOT_LINK=<file>`, then Connect in Navigate (Real robot).
4. **The robot.** Follow the deploy repo's hardware ladder. Studio's part is steps 4–5 above and [NAVIGATE.md](NAVIGATE.md).

## Configuration

| File (all ignored by Git except the examples and the pin) | What it holds |
|---|---|
| `config/local.json` (template [`config/local.example.json`](../config/local.example.json)) | `paths`: `deploy_root`, `lucid_root`, `data_root`, and the optional `flow_root`, `sonic_backend_root`, `grandloco_root`. `sessions`: this machine's own recordings, with the same entries as `config/sessions.json` |
| `config/robot_link.json` (template `config/robot_link.example.json`) | The deploy PC's loopback endpoints and goal limits |
| `config/deploy.json` (in Git) | The pin: deploy repo, tag and commit, release assets and their SHA-256, the runner commit |

Environment variables override `config/local.json`:
- `G1_STUDENT_DEPLOY` (the same name the deploy repo's `env.sh` uses);
- `LUCID_DEPLOY_ROOT`;
- `STUDIO_DATA`;
- `FLOW_ROOT`;
- `G1_DEPLOY_PYTHON`;
- `STUDIO_ROBOT_LINK` (another robot link file).

[`studio/paths.py`](../studio/paths.py) resolves them all; `python -m studio.paths` prints the result. The configs in Git (`config/references.json`, `config/robots/g1_29dof.json`, `config/sessions.json`) record the paths of the machine that wrote them, and Studio maps those onto this machine's roots. `tools/studio_service.sh release` links `config/local.json` and `config/robot_link.json` into the service's release worktree.

## Updating the pinned policy

When a new deploy state is chosen, follow these steps on the machine that holds it.

1. **In g1-student-deploy:** commit the change. If the bundle changed, refreeze it and commit its `MANIFEST.json`. Then push the branch and a new tag:

   ```bash
   git push git@github.com:linjiw/g1-student-deploy.git <branch> <commit>:refs/tags/deploy-YYYY-MM-DD
   ```

2. **In Studio:** pack the assets:

   ```bash
   .venv/bin/python tools/deploy_bundle.py pack --out ~/research-data/g1-deploy-studio/deploy-assets/deploy-YYYY-MM-DD
   ```

3. **Publish them** as a release of the private repo:

   ```bash
   gh release create deploy-YYYY-MM-DD -R linjiw/g1-student-deploy --verify-tag <the assets>
   ```

4. **Update `config/deploy.json`:** set `deploy_stack.tag` and `deploy_stack.commit`, and copy the `bundle` fields from the pack's `assets.json`.
5. **Check and commit:** run `.venv/bin/python tools/doctor.py` and the tests, then commit Studio.

On every other machine:
1. `git pull` in Studio;
2. `git -C ~/code/g1-student-deploy fetch --tags && git -C ~/code/g1-student-deploy checkout --detach deploy-YYYY-MM-DD`;
3. `.venv/bin/python tools/deploy_bundle.py fetch`;
4. `.venv/bin/python tools/doctor.py`.
