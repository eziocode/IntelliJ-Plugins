#!/usr/bin/env bash
# Periodic snapshot for cold starts. Run from cron/Catalyst cron, or after a big reindex.
# Keeps the last N snapshots locally; upload to Stratus with a signed PUT URL (SNAPSHOT_PUT_URL).
set -euo pipefail
DATA_DIR="${DATA_DIR:-data}"
KEEP="${KEEP:-3}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DATA_DIR/snap-$STAMP.sqlite"
npx tsx src/cli.ts snapshot "$OUT" >/dev/null
GZ="$OUT.gz"
if [[ -n "${SNAPSHOT_PUT_URL:-}" ]]; then
  curl -fsS -X PUT --data-binary @"$GZ" -H "content-type: application/gzip" "${SNAPSHOT_PUT_URL}"
  echo "uploaded $GZ"
fi
# local retention
ls -1t "$DATA_DIR"/snap-*.sqlite.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
rm -f "$OUT"
echo "snapshot $GZ ($(stat -f%z "$GZ" 2>/dev/null || stat -c%s "$GZ") bytes)"
