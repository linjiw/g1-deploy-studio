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
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${STUDIO_DATA:-$HOME/research-data/g1-deploy-studio}"
RELEASE="$DATA/release"
UNIT="g1-deploy-studio"
PORT="${STUDIO_PORT:-8790}"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT.service"
PYTHON="$REPO/.venv/bin/python"

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
MemoryHigh=4G
MemoryMax=5G
Nice=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

release() {
  local rev="${1:-HEAD}" commit
  commit="$(git -C "$REPO" rev-parse --verify "$rev^{commit}")"
  if [[ -d "$RELEASE/.git" || -f "$RELEASE/.git" ]]; then
    git -C "$RELEASE" checkout --quiet --detach "$commit"
  else
    mkdir -p "$DATA"
    git -C "$REPO" worktree add --quiet --detach "$RELEASE" "$commit"
  fi
  # Untracked runtime dependencies come from the development checkout.
  ln -sfn "$REPO/node_modules" "$RELEASE/node_modules"
  printf '%s\n' "$commit" >"$DATA/release.commit"
  echo "Release worktree $RELEASE at $commit"
  if [[ -f "$UNIT_FILE" ]]; then systemctl --user restart "$UNIT"; fi
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
  release) release "${2:-HEAD}"; [[ -f "$UNIT_FILE" ]] && wait_ready ;;
  install)
    [[ -e "$RELEASE/.git" ]] || release HEAD
    write_unit
    systemctl --user enable --now "$UNIT"
    wait_ready ;;
  start|stop|restart) systemctl --user "$1" "$UNIT"; [[ "$1" == stop ]] || wait_ready ;;
  status) systemctl --user status "$UNIT" --no-pager | head -12; echo "Served commit: $(cat "$DATA/release.commit" 2>/dev/null || echo unknown)" ;;
  logs) journalctl --user -u "$UNIT" --no-pager -n "${2:-80}" ;;
  url) echo "http://127.0.0.1:$PORT/" ;;
  uninstall)
    systemctl --user disable --now "$UNIT" || true
    rm -f "$UNIT_FILE"; systemctl --user daemon-reload ;;
  *) echo "usage: $0 release [REV]|install|start|stop|restart|status|logs [N]|url|uninstall" >&2; exit 2 ;;
esac
