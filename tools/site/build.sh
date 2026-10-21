#!/usr/bin/env bash
# Assemble the static site: site/ + three.js from node_modules + the exported data and the tour video.
#   tools/site/build.sh <out dir> <site-data dir> [media dir]
# The data and media are not in Git (they are generated, see docs/SITE.md); CI downloads them from a release.
set -euo pipefail
OUT=${1:?out dir}
DATA=${2:?site-data dir}
MEDIA=${3:-}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
THREE="$ROOT/node_modules/three"
[ -f "$THREE/build/three.module.min.js" ] || { echo "three.js missing: run npm ci" >&2; exit 1; }
[ -f "$DATA/worlds.json" ] || { echo "$DATA has no worlds.json: run tools/site/export.py" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT/vendor/three/addons/controls" "$OUT/vendor/three/addons/lines" "$OUT/vendor/three/addons/utils" "$OUT/data" "$OUT/media"
cp -r "$ROOT/site/." "$OUT/"
cp "$THREE/build/three.module.min.js" "$THREE/build/three.core.min.js" "$OUT/vendor/three/"
cp "$THREE/LICENSE" "$OUT/vendor/three/LICENSE"
cp "$THREE/examples/jsm/controls/OrbitControls.js" "$OUT/vendor/three/addons/controls/"
cp "$THREE/examples/jsm/lines/"{Line2,LineGeometry,LineMaterial,LineSegments2,LineSegmentsGeometry}.js "$OUT/vendor/three/addons/lines/"
cp "$THREE/examples/jsm/utils/BufferGeometryUtils.js" "$OUT/vendor/three/addons/utils/"
# Data: everything the exporter wrote except the local mesh list (absolute source paths).
(cd "$DATA" && find . -type f ! -name 'robot-meshes.txt' ! -name '*.tmp' -print0 | xargs -0 -I{} cp --parents {} "$OUT/data/")
if [ -n "$MEDIA" ] && [ -d "$MEDIA" ]; then cp -r "$MEDIA/." "$OUT/media/"; fi
touch "$OUT/.nojekyll"
echo "site: $OUT ($(du -sh "$OUT" | cut -f1))"
