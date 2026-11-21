#!/bin/sh
# Builds the AppSail bundle: Linux dependencies packed as deps.tgz (the CLI does not upload node_modules).
# Usage: sh deploy/prepare-bundle.sh <bundle-dir>
set -e
OUT="$1"
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r src deploy eval tsconfig.json "$OUT"/
cp package.json "$OUT"/
cd "$OUT" && npm install --omit=dev --os=linux --cpu=x64 --no-audit --no-fund >/dev/null 2>&1
tar czf deps.tgz node_modules && rm -rf node_modules
ls -la deps.tgz
