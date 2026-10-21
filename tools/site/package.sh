#!/usr/bin/env bash
# Pack the exported site data and the media for a release and print the lock entry for tools/site/release.json.
#   tools/site/package.sh <site-data dir> <media dir> <out dir> <tag>
# Then: gh release create <tag> <out dir>/site-data.tar.gz <out dir>/site-media.tar.gz --title ... --notes ...
set -euo pipefail
DATA=${1:?site-data dir}; MEDIA=${2:?media dir}; OUT=${3:?out dir}; TAG=${4:?tag}
mkdir -p "$OUT"
# Deterministic archives: sorted names, fixed owner and time; the local mesh list (absolute paths) stays out.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' --exclude='robot-meshes.txt' --exclude='*.tmp' \
  -C "$DATA" -cf - . | gzip -9n > "$OUT/site-data.tar.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' -C "$MEDIA" -cf - . | gzip -1n > "$OUT/site-media.tar.gz"
python3 - "$OUT" "$TAG" <<'PY'
import hashlib, json, sys
out, tag = sys.argv[1], sys.argv[2]
assets = {n: hashlib.sha256(open(f'{out}/{n}', 'rb').read()).hexdigest() for n in ('site-data.tar.gz', 'site-media.tar.gz')}
print(json.dumps({'repository': 'linjiw/g1-deploy-studio', 'tag': tag, 'assets': assets}, indent=1))
PY
ls -la "$OUT"
