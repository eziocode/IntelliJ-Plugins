#!/bin/sh
# Builds the AppSail bundle: Linux dependencies packed as deps.tgz (the CLI does not upload node_modules).
# Usage: sh deploy/prepare-bundle.sh <new-bundle-dir> [--branch-pool]
set -e
OUT="$1"
case "${2:-}" in ""|--branch-pool) ;; *) echo "unknown bundle option" >&2; exit 2;; esac
[ -n "$OUT" ] || { echo "missing bundle directory" >&2; exit 2; }
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r src deploy eval tsconfig.json "$OUT"/
cp package.json package-lock.json "$OUT"/
if [ "${2:-}" = "--branch-pool" ]; then touch "$OUT/deploy/branch-pool-enabled"; fi
cd "$OUT" && npm ci --omit=dev --os=linux --cpu=x64 --no-audit --no-fund
tar czf deps.tgz node_modules && rm -rf node_modules
ls -la deps.tgz
