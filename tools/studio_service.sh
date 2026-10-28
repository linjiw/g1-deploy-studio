#!/usr/bin/env bash
# Durable, loopback-only G1 Deploy Studio gateway as a systemd --user service.
#
# The service serves a *committed* revision from a separate release worktree, so
# in-progress edits in the development checkout never reach the user's port.
# It binds 127.0.0.1/::1 only; remote access uses an authenticated SSH tunnel.
#
#   tools/studio_service.sh release [REV]   # check out REV (default HEAD) and restart
#   tools/studio_service.sh install         # write + enable the user unit (once)
#   tools/studio_service.sh start|stop|restart|status|logs|url
#   tools/studio_service.sh guard           # would release/stop/restart be refused now? (changes nothing)
#
# release, stop and restart refuse while owned runs are active or while the deploy kit reports a live session (Deploy's
# E-STOP, Stand and Takeover live in this gateway; docs/DEPLOY.md). --force (or FORCE=1) overrides both, explicitly.
set -euo pipefail

ARGS=()
for arg in "$@"; do
  if [[ "$arg" == --force ]]; then FORCE=1; else ARGS+=("$arg"); fi
done
set -- ${ARGS[@]+"${ARGS[@]}"}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$REPO/.venv/bin/python"
# The data root follows studio/paths.py: $STUDIO_DATA, config/local.json "paths", or ~/research-data/g1-deploy-studio.
DATA="$( (cd "$REPO" && PYTHONPATH="$REPO" "$PYTHON" -m studio.paths data_root) 2>/dev/null || echo "${STUDIO_DATA:-$HOME/research-data/g1-deploy-studio}")"
RELEASE="$DATA/release"
UNIT="g1-deploy-studio"
PORT="${STUDIO_PORT:-8790}"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT.service"

write_unit() {
  mkdir -p "$(dirname "$UNIT_FILE")"
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=G1 Deploy Studio (loopback replay + owned CPU simulation; hardware disabled)

[Service]
Type=simple
WorkingDirectory=$RELEASE
ExecStart=$PYTHON -m studio.server --port $PORT
Environment=PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
# The owned CPU policy worker is a child in this cgroup; bound both together.
# OOMPolicy=continue: if the kernel OOM-kills the worker, the gateway keeps
# serving and records the run as killed instead of the whole unit stopping.
MemoryHigh=4G
MemoryMax=5G
OOMPolicy=continue
Nice=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

active_runs() {
  # Owned runs/suites in progress on the served gateway (empty when idle or down).
  curl -fsS "http://127.0.0.1:$PORT/api/jobs" 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); print(" ".join(j["id"] for j in d.get("jobs",[]) if j.get("status") in ("starting","running","cancelling")))' 2>/dev/null
  curl -fsS "http://127.0.0.1:$PORT/api/suites" 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); print(" ".join(s["id"] for s in d.get("suites",[]) if s.get("status") in ("queued","running","cancelling")))' 2>/dev/null
}

guard_idle() {
  # Stopping the unit kills its cgroup, including an owned worker mid-run.
  local busy
  busy="$(active_runs | xargs)"
  if [[ -n "$busy" && "${FORCE:-0}" != 1 ]]; then
    echo "Refusing to $1: active runs/suites would be killed: $busy" >&2
    echo "Wait for them to finish, cancel them in Rehearse, or rerun with --force." >&2
    return 3
  fi
  guard_deploy "$1"
}

guard_deploy() {
  # The deploy kit's live sessions, asked of its deploy service, else of the served gateway's cache
  # (studio/deploy_link.py live: exit 0 none, 1 live, 2 nobody could say).
  local text code=0
  text="$(cd "$REPO" && PYTHONPATH="$REPO" "$PYTHON" -m studio.deploy_link live --gateway "http://127.0.0.1:$PORT" 2>&1)" || code=$?
  case "$code" in
    0) return 0 ;;
    1)
      if [[ "${FORCE:-0}" == 1 ]]; then
        echo "Forced $1 although $text" >&2
        return 0
      fi
      echo "Refusing to $1: $text" >&2
      echo "While the gateway restarts, Deploy's E-STOP, Stand and Takeover are gone (the phone panel, the remote and the" >&2
      echo "physical E-stop are not). End the session first, or rerun with --force." >&2
      return 3 ;;
    *) echo "Note: could not tell whether a deploy-kit session is live ($text); continuing." >&2; return 0 ;;
  esac
}

release() {
  local rev="${1:-HEAD}" commit
  commit="$(git -C "$REPO" rev-parse --verify "$rev^{commit}")"
  guard_idle release || return 3
  # Stop before switching files so the old gateway never imports code from the new tree.
  if [[ -f "$UNIT_FILE" ]]; then systemctl --user stop "$UNIT"; fi
  if [[ -d "$RELEASE/.git" || -f "$RELEASE/.git" ]]; then
    git -C "$RELEASE" checkout --quiet --detach "$commit"
  else
    mkdir -p "$DATA"
    git -C "$REPO" worktree add --quiet --detach "$RELEASE" "$commit"
  fi
  # Untracked runtime dependencies and this machine's ignored config come from the development checkout.
  ln -sfn "$REPO/node_modules" "$RELEASE/node_modules"
  for cfg in local.json robot_link.json; do
    if [[ -f "$REPO/config/$cfg" ]]; then ln -sfn "$REPO/config/$cfg" "$RELEASE/config/$cfg"; else rm -f "$RELEASE/config/$cfg"; fi
  done
  printf '%s\n' "$commit" >"$DATA/release.commit"
  echo "Release worktree $RELEASE at $commit"
  if [[ -f "$UNIT_FILE" ]]; then systemctl --user daemon-reload; systemctl --user start "$UNIT"; fi
}

wait_ready() {
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/safety"; then
      echo "Ready: http://127.0.0.1:$PORT/"; return 0
    fi
    sleep 0.5
  done
  echo "Gateway did not answer on 127.0.0.1:$PORT" >&2
  systemctl --user status "$UNIT" --no-pager | tail -20 >&2
  return 1
}

case "${1:-status}" in
  release) release "${2:-HEAD}" && { [[ -f "$UNIT_FILE" ]] && wait_ready || true; } ;;
  install)
    [[ -e "$RELEASE/.git" ]] || release HEAD
    write_unit
    systemctl --user enable --now "$UNIT"
    wait_ready ;;
  start) systemctl --user start "$UNIT"; wait_ready ;;
  stop|restart) guard_idle "$1" || exit 3; systemctl --user "$1" "$UNIT"; [[ "$1" == stop ]] || wait_ready ;;
  guard) guard_idle "release, stop or restart" && echo "release/stop/restart would proceed." ;;
  status) systemctl --user status "$UNIT" --no-pager | head -12; echo "Served commit: $(cat "$DATA/release.commit" 2>/dev/null || echo unknown)" ;;
  logs) journalctl --user -u "$UNIT" --no-pager -n "${2:-80}" ;;
  url) echo "http://127.0.0.1:$PORT/" ;;
  uninstall)
    systemctl --user disable --now "$UNIT" || true
    rm -f "$UNIT_FILE"; systemctl --user daemon-reload ;;
  *) echo "usage: $0 release [REV]|install|start|stop|restart|status|logs [N]|url|uninstall|guard [--force]" >&2; exit 2 ;;
esac
