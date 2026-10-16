#!/usr/bin/env bash
# Install a generated Session v4 artifact into the DSH session store, under the
# project directory implied by the manifest's `cwd`. A stale copy of the same
# session id in another project directory is removed (a session lives in one).
#
# Usage: bash install-session.sh [out/manifest.json]
# Requires write access to ${DSH_HOME:-~/.dsh}
set -euo pipefail

MAN="${1:-./out/manifest.json}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
SESSIONS_ROOT="$DSH_HOME/sessions"

[ -f "$MAN" ] || { echo "missing manifest: $MAN" >&2; exit 1; }

SID=$(node -e "process.stdout.write(require(require('path').resolve('$MAN')).sessionId)")
SRC=$(node -e "process.stdout.write(require(require('path').resolve('$MAN')).artifacts.zstd)")
PROJECT=$(node -e "process.stdout.write(require(require('path').resolve('$MAN')).install.projectDir)")
TARGET="$SESSIONS_ROOT/$PROJECT/$SID"

[ -f "$SRC" ] || { echo "missing artifact: $SRC" >&2; exit 1; }
# 新工作区对应的项目目录可能还不存在，按 DSH 的规则建出来
mkdir -p "$SESSIONS_ROOT/$PROJECT"

for dir in "$SESSIONS_ROOT"/*/"$SID"; do
  [ -d "$dir" ] || continue
  if [ "$dir" != "$TARGET" ]; then
    echo "removing stale copy: $dir"
    rm -rf "$dir"
  fi
done

mkdir -p "$TARGET"
install -m 600 "$SRC" "$TARGET/session.v4.jsonl.zstd"
: > "$TARGET/session.lock"

echo "session id : $SID"
echo "workspace  : $PROJECT"
echo "installed  : $TARGET/session.v4.jsonl.zstd"
echo "--- checksum ---"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$SRC" "$TARGET/session.v4.jsonl.zstd"
else
  shasum -a 256 "$SRC" "$TARGET/session.v4.jsonl.zstd"
fi
