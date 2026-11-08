#!/usr/bin/env bash
# Sync this fork to an upstream OpenBot release and rebuild it with the local patches.
#
#   ./scripts/local/sync.sh                  # latest upstream release tag
#   ./scripts/local/sync.sh v0.66.0          # one specific tag
#   SKIP_BUILD=1 ./scripts/local/sync.sh     # sync only, no bun install / build
#
#   main  = a pristine snapshot of the upstream release tag. Never edited by hand.
#   local = main + fork-patches/*.patch. This is the branch that gets built.
#
# History is shallow on purpose: one commit per release tag. `git am` replays the
# patch series, so no shared ancestry with upstream is needed.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG="$(git ls-remote --tags --refs upstream 'refs/tags/v*' \
    | awk -F/ '{print $NF}' | sort -V | tail -1)"
fi
echo "[sync] target $TAG"

fetch_tag() {
  local tag="$1" attempt
  for attempt in 1 2 3 4; do
    if git fetch --depth=1 --no-tags upstream "refs/tags/$tag:refs/tags/$tag" 2>/dev/null; then
      return 0
    fi
    echo "[sync] fetch of $tag failed (attempt $attempt), retrying"
    sleep 5
  done
  return 1
}
fetch_tag "$TAG"

git checkout -q main
git reset -q --hard "refs/tags/$TAG"
git branch -f local main
git checkout -q local

ABORT=0
if compgen -G "fork-patches/*.patch" > /dev/null; then
  for p in fork-patches/*.patch; do
    echo "[sync] applying $(basename "$p")"
    if ! git am --3way "$p"; then
      echo "[sync] FAILED on $p. Resolve the conflict, then:"
      echo "        git add -A && git am --continue"
      ABORT=1
      break
    fi
  done
fi
if [ "$ABORT" = "1" ]; then
  echo "[sync] stopped with the series half-applied; build skipped"
  exit 1
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  bun install
  bun run dist:linux
  echo "[sync] artifact: dist/OpenBot-*.AppImage"
fi
echo "[sync] done at $(git log --oneline -1)"
