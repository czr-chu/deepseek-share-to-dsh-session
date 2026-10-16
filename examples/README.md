# examples

## `messages.sample.json`

一段**合成**的 Markdown 问答（2 轮对话），用来演示与自检，不含任何真实对话内容。
它刻意覆盖了几种典型情况：

| 覆盖点 | 位置 |
|---|---|
| 普通用户提问 | `index: 0`、`index: 2` |
| 助手正文（含代码块、列表、表格） | `index: 1`、`index: 3` |
| 思维链 `THINK` → `reasoning` | `index: 1`、`index: 3` |
| 可解析的引用 `TOOL_OPEN` → Markdown 链接 | `index: 1`（`[reference:0]` → `https://example.com/...`） |
| 无 URL 的引用 `TOOL_SEARCH` → 保持 `[reference:N]` 原样 | `index: 3` |
| 免责声明 `TIP`（不写入会话） | `index: 1` |

这就是 `fetch-share.mjs` 产出的 `messages.json` 的**中间格式**：
每条消息含 `role` / `content`（正文）/ `reasoning`（思维链）/ `timestamp`（Unix 秒）/
`citation_map`（`[reference:N]` → 真实来源）/ `searches` / `sources` / `fragments`（原样片段）。

字段说明可对照 `scripts/fetch-share.mjs` 里构造对象的那一段。

## 跑一遍

```bash
# 用样本生成一条会话（不联网、不写会话库）
node scripts/build-session.mjs \
  --src examples/messages.sample.json \
  --out /tmp/dsh-sample --cwd /tmp \
  --title "Sample import" --system-prompt none

# 校验
node scripts/verify-session.mjs /tmp/dsh-sample/session.v4.jsonl.zstd \
  --manifest /tmp/dsh-sample/manifest.json
```

或者直接：

```bash
bash scripts/selftest.sh
```

> 想真的放进 DSH 看看？把 `--cwd` 换成你某个工作区的路径，然后跑
> `node scripts/attach-workspace.mjs --manifest <out>/manifest.json`
> —— 注意这会往你的会话库里新增一条会话。
