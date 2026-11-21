#!/bin/sh
# AppSail entry point (runs under dash: POSIX sh only).
# Starts the server at once (AppSail needs it listening within ~10 s); the master-only git mirror
# is cloned in the background and the server indexes master when the mirror appears.
#   GIT_REMOTE        repo URL (https)                 required for the clone
#   GIT_TOKEN         read-only repo token             required for the clone
#   GIT_USER          login name for Basic auth (default aswin.kg)
#   MCP_TOKEN         bearer token clients must send   strongly recommended
echo "[boot] cwd=$(pwd) files=$(ls -A | tr '\n' ' ')"
# dependencies ship as a tarball (the CLI does not upload node_modules); unpack at every boot (ephemeral disk)
if [ -f deps.tgz ]; then tar xzf deps.tgz && echo "[deps] unpacked" || { echo "[deps] unpack failed"; exit 1; }; fi
export PORT="${X_ZOHO_CATALYST_LISTEN_PORT:-${PORT:-9000}}"
export DATA_DIR="${DATA_DIR:-/tmp/crm-index/data}"
export REPO_NAME="${REPO_NAME:-zohocrm}"
MIRROR="${MIRROR_DIR:-/tmp/crm-index/mirror/$REPO_NAME.git}"
export REPOS="${REPOS:-$REPO_NAME=$MIRROR}"
# the mirror tracks master only, so list branches from the remote (cached 60 s)
export REMOTE_LIST="${REMOTE_LIST:-1}"
mkdir -p "$DATA_DIR" "$(dirname "$MIRROR")" /tmp/crm-index
echo "cloning" > /tmp/crm-index/mirror.status

clone_master() {
  if [ -d "$MIRROR/objects" ]; then return 0; fi
  if [ -z "$GIT_REMOTE" ]; then echo "[mirror] GIT_REMOTE not set"; return 1; fi
  echo "[mirror] cloning master (blobless) into $MIRROR"
  git init -q --bare "$MIRROR" && git -C "$MIRROR" remote add origin "$GIT_REMOTE" || return 1
  if [ -n "$GIT_TOKEN" ]; then
    # the repo host accepts HTTP Basic with the account login as username (Bearer and Zoho schemes are refused).
    # Stored in the mirror's own config so later blob prefetches and branch fetches authenticate too.
    GIT_BASIC=$(printf '%s:%s' "${GIT_USER:-aswin.kg}" "$GIT_TOKEN" | base64 | tr -d '\n')
    git -C "$MIRROR" config http.extraHeader "Authorization: Basic $GIT_BASIC"
  fi
  GIT_TERMINAL_PROMPT=0 git -C "$MIRROR" fetch -q --filter=blob:none --no-tags origin '+refs/heads/master:refs/remotes/origin/master' 2>/tmp/crm-index/clone.err
  rc=$?
  if [ $rc -eq 0 ]; then echo "[mirror] ready" > /tmp/crm-index/mirror.status; else echo "[mirror] clone failed rc=$rc" > /tmp/crm-index/mirror.status; rm -rf "$MIRROR"; return 1; fi
}
( clone_master ) &

exec node deploy/bootstrap.mjs
