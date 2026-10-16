#!/usr/bin/env bash
# 自检：用 examples/ 里的合成对话跑一遍「生成 → 两段式校验」。
# 不联网、不写真实会话库（产物落在临时目录，结束即删）。
#
# 用法: bash scripts/selftest.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[selftest] 1/2 生成会话（--system-prompt none，不读取本机其它会话）"
node "$HERE/build-session.mjs" \
  --src "$HERE/../examples/messages.sample.json" \
  --out "$TMP/out" \
  --cwd "$TMP" \
  --title "selftest" \
  --system-prompt none >/dev/null

if command -v dsh >/dev/null 2>&1 || [ -n "${DSH_PACKAGES_DIR:-}" ]; then
  echo "[selftest] 2/2 两段式校验（用 DSH 自己的代码解码 + 真实 persistence list/open）"
  node "$HERE/verify-session.mjs" "$TMP/out/session.v4.jsonl.zstd" --manifest "$TMP/out/manifest.json"
else
  echo "[selftest] 2/2 跳过校验：未检测到 DSH 安装（装好 dsh，或设置 DSH_PACKAGES_DIR 后重跑）"
fi

echo "[selftest] OK"
