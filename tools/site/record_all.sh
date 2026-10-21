#!/usr/bin/env bash
# Record every site world in coverage order: the 2-spacing lattice of every room first (so a partial batch covers
# every room), then the checkerboard (level 1), then the remaining cells (level 2). Resumable: finished walks are
# skipped. Every worker runs at nice 19 with two threads (tools/site/record_goals.py).
#   tools/site/record_all.sh <recordings dir> [workers] [max level]
set -euo pipefail
OUT=${1:?recordings dir}
WORKERS=${2:-6}
MAX=${3:-2}
cd "$(dirname "$0")/../.."
WORLDS=(detour slalom corridor doorway clutter)
for level in $(seq 0 "$MAX"); do
  for w in "${WORLDS[@]}"; do
    .venv/bin/python -B -m tools.site.record_goals --world "$w" --out "$OUT" --workers "$WORKERS" --max-level "$level"
  done
done
echo "all worlds recorded to level $MAX"
