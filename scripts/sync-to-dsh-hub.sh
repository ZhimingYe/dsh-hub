#!/usr/bin/env bash
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-${DSH_HUB_PUBLISH:-}}"
if [[ -z "$dest" ]]; then
  dest="$(cd "$src/.." && pwd)/dsh-hub"
fi
if [[ ! -d "$dest/.git" ]]; then
  echo "destination is not a git repo: $dest" >&2
  echo "usage: scripts/sync-to-dsh-hub.sh /path/to/dsh-hub" >&2
  exit 1
fi

rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '*.tsbuildinfo' \
  --exclude 'hub.yaml' \
  --exclude 'hub.local.yaml' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.password' \
  --exclude '.dsh-hub-password' \
  "$src/" "$dest/"

echo "synced $src -> $dest"
