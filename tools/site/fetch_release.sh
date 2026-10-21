#!/usr/bin/env bash
# Download the site data and media pinned in tools/site/release.json and check their SHA-256 before unpacking.
#   tools/site/fetch_release.sh <data dir> <media dir>
set -euo pipefail
DATA=${1:?data dir}; MEDIA=${2:?media dir}
HERE=$(cd "$(dirname "$0")" && pwd)
LOCK="$HERE/release.json"
read_lock() { python3 -c "import json,sys; d=json.load(open('$LOCK')); print(eval(sys.argv[1]))" "$1"; }
REPO=$(read_lock "d['repository']"); TAG=$(read_lock "d['tag']")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
for name in $(read_lock "' '.join(d['assets'])"); do
  want=$(read_lock "d['assets']['$name']")
  curl -fsSL --retry 3 -o "$TMP/$name" "https://github.com/$REPO/releases/download/$TAG/$name"
  got=$(sha256sum "$TMP/$name" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "$name: sha256 $got, expected $want" >&2; exit 1; }
done
mkdir -p "$DATA" "$MEDIA"
tar -xzf "$TMP/site-data.tar.gz" -C "$DATA"
tar -xzf "$TMP/site-media.tar.gz" -C "$MEDIA"
echo "fetched $TAG: $(du -sh "$DATA" | cut -f1) data, $(du -sh "$MEDIA" | cut -f1) media"
