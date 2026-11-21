#!/bin/sh
# Container entry: make sure the master-only mirror exists (clone once, reuse the volume afterwards), then start the server.
#   GIT_REMOTE        repo URL                         required on first start
#   GIT_TOKEN         read-only repo token              required on first start (HTTP Basic, user GIT_USER)
#   GIT_USER          login for Basic auth              default aswin.kg
#   MCP_TOKEN         admin bearer key                  recommended
set -u
mkdir -p "$DATA_DIR" "$(dirname "$MIRROR_DIR")"
if [ ! -d "$MIRROR_DIR/objects" ]; then
  if [ -z "${GIT_REMOTE:-}" ]; then echo "[mirror] GIT_REMOTE not set; the server starts but cannot index"; else
    echo "[mirror] cloning master (blobless) into $MIRROR_DIR"
    git init -q --bare "$MIRROR_DIR" && git -C "$MIRROR_DIR" remote add origin "$GIT_REMOTE" || exit 1
    if [ -n "${GIT_TOKEN:-}" ]; then
      B=$(printf '%s:%s' "${GIT_USER:-aswin.kg}" "$GIT_TOKEN" | base64 | tr -d '\n')
      git -C "$MIRROR_DIR" config http.extraHeader "Authorization: Basic $B"
    fi
    GIT_TERMINAL_PROMPT=0 git -C "$MIRROR_DIR" fetch -q --filter=blob:none --no-tags origin '+refs/heads/master:refs/remotes/origin/master' \
      && echo "[mirror] ready" || { echo "[mirror] clone failed"; rm -rf "$MIRROR_DIR"; }
  fi
fi
export REPOS="${REPOS:-$REPO_NAME=$MIRROR_DIR}"
exec node --import tsx src/server.ts
