#!/usr/bin/env bash
# Assemble the static site: site/ + three.js from node_modules + the exported data and the tour video.
#   tools/site/build.sh <out dir> <site-data dir> [media dir]
# The data and media are not in Git (they are generated, see docs/SITE.md); CI downloads them from a release.
# NEXT_LOCAL=<json> adds material to the next-step page that is not published (a local build only: never in CI);
# without it the page gets an empty data/next-local.json and shows only what Studio measured.
set -euo pipefail
OUT=${1:?out dir}
DATA=${2:?site-data dir}
MEDIA=${3:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
THREE="$ROOT/node_modules/three"
[ -f "$THREE/build/three.module.min.js" ] || { echo "three.js missing: run npm ci" >&2; exit 1; }
[ -f "$DATA/worlds.json" ] || { echo "$DATA has no worlds.json: run tools/site/export.py" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)   # absolute: the copies below run from other directories
mkdir -p "$OUT/vendor/three/addons/controls" "$OUT/vendor/three/addons/lines" "$OUT/vendor/three/addons/utils" "$OUT/data" "$OUT/media"
cp -r "$ROOT/site/." "$OUT/"
cp "$THREE/build/three.module.min.js" "$THREE/build/three.core.min.js" "$OUT/vendor/three/"
cp "$THREE/LICENSE" "$OUT/vendor/three/LICENSE"
cp "$THREE/examples/jsm/controls/OrbitControls.js" "$OUT/vendor/three/addons/controls/"
cp "$THREE/examples/jsm/lines/"{Line2,LineGeometry,LineMaterial,LineSegments2,LineSegmentsGeometry}.js "$OUT/vendor/three/addons/lines/"
cp "$THREE/examples/jsm/utils/BufferGeometryUtils.js" "$OUT/vendor/three/addons/utils/"
# Data: everything the exporter wrote except the local mesh list (absolute source paths).
(cd "$DATA" && tar --exclude='robot-meshes.txt' --exclude='*.tmp' -cf - .) | tar -xf - -C "$OUT/data"
if [ -n "$MEDIA" ] && [ -d "$MEDIA" ]; then cp -r "$MEDIA/." "$OUT/media/"; fi
if [ -n "${NEXT_LOCAL:-}" ]; then
  [ -z "${CI:-}" ] || { echo "NEXT_LOCAL is for local builds only" >&2; exit 1; }
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$NEXT_LOCAL"
  cp "$NEXT_LOCAL" "$OUT/data/next-local.json"
  echo "next-local: $NEXT_LOCAL (local build: do not publish $OUT)"
else
  echo '{}' > "$OUT/data/next-local.json"
fi
touch "$OUT/.nojekyll"
echo "site: $OUT ($(du -sh "$OUT" | cut -f1))"
