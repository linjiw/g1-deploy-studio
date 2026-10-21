#!/usr/bin/env bash
# Record every site world: a coarse pass over all worlds first (so a partial batch covers every room), then the rest.
# Resumable: finished walks are skipped. Every worker runs at nice 19 with two threads (tools/site/record_goals.py).
#   tools/site/record_all.sh <recordings dir> [workers]
set -euo pipefail
OUT=${1:?recordings dir}
WORKERS=${2:-6}
cd "$(dirname "$0")/../.."
WORLDS=(detour doorway corridor slalom clutter)
for limit in 60 ""; do
  for w in "${WORLDS[@]}"; do
    .venv/bin/python -B -m tools.site.record_goals --world "$w" --out "$OUT" --workers "$WORKERS" ${limit:+--limit $limit}
  done
done
echo "all worlds recorded"
