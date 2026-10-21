#!/usr/bin/env bash
# Start/stop the isolated validation gateway (port 8792, separate data root).
# Never touches the systemd service on 8790.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT=${PORT:-8792}
ROOT=${DATA_ROOT:-$HOME/research-data/g1-deploy-studio/validation-workbench}
EVID=${EVIDENCE:-$HOME/research-data/g1-deploy-studio/evidence/validation-20261020}
PIDF="$EVID/gateway-$PORT.pid"
mkdir -p "$EVID"
case "${1:-start}" in
  start)
    # A gateway already answering on this port would make the readiness check below pass for the wrong process.
    if curl -sf "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then echo "port $PORT is already served by another gateway; stop it first"; exit 1; fi
    nohup .venv/bin/python -m studio.server --port "$PORT" --data-root "$ROOT" \
      --config tools/browser/validation/sessions.validation.json >>"$EVID/gateway-$PORT.log" 2>&1 &
    echo $! >"$PIDF"
    for i in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/api/version" >/dev/null && { echo "up pid $(cat "$PIDF")"; exit 0; }; sleep 0.5; done
    echo "gateway did not come up"; exit 1 ;;
  stop)
    [ -f "$PIDF" ] && kill -${SIG:-TERM} "$(cat "$PIDF")" 2>/dev/null || true
    for i in $(seq 1 40); do kill -0 "$(cat "$PIDF")" 2>/dev/null || { echo stopped; rm -f "$PIDF"; exit 0; }; sleep 0.25; done
    echo "still running" ;;
  pid) cat "$PIDF" ;;
esac
