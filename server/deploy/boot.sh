#!/usr/bin/env bash
# Cold start for an ephemeral host (AppSail redeploy/restart wipes the disk).
#   1. index present in DATA_DIR?           -> just start
#   2. SNAPSHOT_GZ (local file) or SNAPSHOT_URL (signed GET to Stratus) set? -> restore, then start
#   3. otherwise: index master from the mirror (slow, needs REPOS mirror + credentials)
# Then the server starts; master refresh and PRELOAD_REFS run in the background.
set -euo pipefail
DATA_DIR="${DATA_DIR:-data}"
mkdir -p "$DATA_DIR"
REPO_NAME="${REPO_NAME:-zohocrm}"
DB="$DATA_DIR/$REPO_NAME.sqlite"
GZ="$DATA_DIR/snapshot.sqlite.gz"

if [[ -f "$DB" ]]; then
  echo "[boot] index present: $DB"
elif [[ -n "${SNAPSHOT_GZ:-}" && -f "$SNAPSHOT_GZ" ]]; then
  echo "[boot] restoring from $SNAPSHOT_GZ"
  DATA_DIR="$DATA_DIR" npx tsx src/cli.ts restore "$SNAPSHOT_GZ"
elif [[ -n "${SNAPSHOT_URL:-}" ]]; then
  echo "[boot] downloading snapshot"
  curl -fsS --retry 3 -o "$GZ" "$SNAPSHOT_URL"
  DATA_DIR="$DATA_DIR" npx tsx src/cli.ts restore "$GZ"
else
  echo "[boot] no snapshot: master will be indexed from the mirror at startup"
fi

exec node --import tsx src/server.ts
