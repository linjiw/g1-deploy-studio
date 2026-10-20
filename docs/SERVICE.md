# Running Studio as a durable local service

## Why the gateway used to disappear

On 2026-10-19 nothing listened on 8790. The last log, `~/research-data/g1-deploy-studio/server-20261016-final-review.log`, ends mid-request at 2026-10-16 11:43, with no shutdown message and no OOM record. The gateway had been started from an interactive agent shell, and it was killed together with that session's process group. Earlier "running" claims described a process that no longer existed.

## Current setup

`tools/studio_service.sh` installs a **systemd user unit**, `g1-deploy-studio`. This matches the host's other long-running local tools; user lingering is enabled. The unit:

- binds **127.0.0.1:8790 and [::1]:8790 only**; the gateway refuses non-loopback binds;
- serves a **committed revision** from a separate release worktree, `~/research-data/g1-deploy-studio/release`, so in-progress edits never reach the user's port (review CODE-1). The served commit is shown in the status bar and at `/api/version`;
- restarts on failure, and bounds the gateway plus its owned CPU worker to `MemoryHigh=4G` / `MemoryMax=5G`. With `OOMPolicy=continue`, an OOM-killed worker is recorded as killed and the gateway keeps serving;
- logs to the user journal (polling and mesh requests are not logged).

```bash
tools/studio_service.sh install         # once: release worktree + unit, enabled at login/boot
tools/studio_service.sh release [REV]   # serve a new commit (default HEAD); refuses while runs/suites are active
FORCE=1 tools/studio_service.sh release # override: kills in-flight runs (they are recorded as interrupted)
tools/studio_service.sh status          # unit state and served commit
tools/studio_service.sh logs 100
tools/studio_service.sh restart | stop | start   # restart/stop refuse while runs/suites are active (FORCE=1 overrides)
tools/studio_service.sh uninstall       # disable and remove the unit (data is kept)
```

Development uses a second gateway on another port. It serves the working tree directly:

```bash
.venv/bin/python -m studio.server --port 8791            # shares the run history
.venv/bin/python -m studio.server --port 8791 --data-root ~/research-data/g1-deploy-studio/dev-workbench
```

Only one simulation worker can run per data root at a time, enforced by a kernel lock. Restarting the service ends the owned worker, and its job is then marked failed with the reason.

## Access

- On this machine: **http://127.0.0.1:8790/**
- From another computer, use an authenticated SSH tunnel. Never expose the port publicly:

  ```bash
  ssh -N -L 8790:127.0.0.1:8790 linjiw@<this-host>
  # then open http://localhost:8790/ on the laptop
  ```

  A different local port works too, for example `-L 18790:127.0.0.1:8790` with `http://localhost:18790/`. The gateway accepts a loopback `Host` with any port and rejects foreign hosts, cross-origin requests and `X-Forwarded-*` overrides.
- Editor port forwarding (VS Code, Claude desktop) forwards to a local browser port. Open the forwarded URL rather than starting another server on that port.

There is no authentication layer inside Studio. The SSH tunnel *is* the authentication, so do not put the port behind a public tunnel, a reverse proxy or a 0.0.0.0 bind.
