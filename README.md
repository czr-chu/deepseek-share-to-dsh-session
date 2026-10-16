# DeepSeek 分享对话 → DSH 会话

> 把 DeepSeek 网页版的公开分享链接（`chat.deepseek.com/share/<id>`），变成一条**能继续对话**的
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）会话。
>
> 抓取 → 转成 DSH **Session format v4** 日志 → 装进会话库 → 挂到你指定的工作区。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.15-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)

---

## 为什么需要它

DeepSeek 网页版的分享页是一张「只读网页」：

* 没有导出按钮，拿不到结构化的对话数据；
* 就算手工复制出来，也**接不回任何 Agent 工具** —— 下次想接着问，只能重新贴一遍上下文。

而 DSH 的会话是自己的一套日志格式（多帧 zstd + JSONL，见 [docs/session-format-v4.md](docs/session-format-v4.md)），
外部对话没法直接塞进去。

这个项目补上中间那一步，产出一条**和原生会话一模一样**的会话记录：侧边栏能看到、点开能读，
**直接在下框接着聊**，历史（含思维链）会自动作为上下文发给模型。

## 效果

```console
$ node scripts/fetch-share.mjs https://chat.deepseek.com/share/<share_id> --outdir ./deepseek-share
[fetch] node fetch OK (HTTP 200, 956728 bytes)
{"user":31,"assistant":31} fragments: {"REQUEST":31,"RESPONSE":31,"THINK":80,"TOOL_SEARCH":29,"TOOL_OPEN":115,"TIP":9}

$ node scripts/build-session.mjs --src ./deepseek-share/messages.json --out ./out --title "自定义标题"
{ "sessionId": "session-1f0c…", "events": 194, "turns": 31, "zstdBytes": 90… }

$ node scripts/attach-workspace.mjs --manifest ./out/manifest.json
{ "workspace": { "title": "网页对话提取", "attached": true }, "agentPreset": "standard" }
ATTACH-OK

$ node scripts/verify-session.mjs ./out/session.v4.jsonl.zstd --manifest ./out/manifest.json --require-installed
=== STAGE A: format + logical restore ===    … users: 31, assistants: 31
=== STAGE B: real JsonlSessionPersistence list/open ===
listed=yes  open=read events=194  round-trip=exact
VERIFY-OK
```

完成后刷新 DSH 网页端，侧边栏里就会出现这条会话 —— **不需要重启服务**。

## 特性

* **零依赖**：只用 Node 内置模块（`fetch` + `node:zlib` 的 zstd），不需要 `npm install`
* **公开接口抓取**：`/api/v0/share/content`，无需登录、无需 token、无分页
* **忠实还原**：正文、思维链（`reasoning`）、联网搜索引用、时间戳全部按源数据落盘
* **真实的 DSH 会话**：不是"伪造一个能看的文件"，而是通过 DSH 自己的格式校验与持久化读回
* **两段式自检**：先用 DSH 的格式代码解码校验，再用真实 persistence 后端 `list()`/`open()` 往返比对
* **一条命令挂到工作区**：调运行中服务的本地 API 完成 attach，立即出现在对应分组
* **可作为 DSH Skill 使用**：`git clone` 到 `~/.dsh/skills/` 即可被 Agent 自动调用

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js | **≥ 22.15**（或 ≥ 23.8）。用到内置 zstd（`zlib.zstdCompressSync`）；更低版本没有 |
| DeepSeek Harness | 校验、挂载工作区、继续对话都需要本机有 `dsh`（`dsh web` 正在运行最方便） |
| 网络 | 仅抓取分享内容时需要；其余步骤全在本地 |
| API Key | **不需要**。抓取用的是公开接口，读写的是本机 DSH 数据 |

## 快速开始

```bash
git clone https://github.com/czr-chu/deepseek-share-to-dsh-session.git
cd deepseek-share-to-dsh-session

# 1) 抓取分享内容（公开接口，无需登录）
node scripts/fetch-share.mjs https://chat.deepseek.com/share/<share_id> --outdir ./deepseek-share

# 2) 生成 DSH Session v4 日志
node scripts/build-session.mjs \
     --src ./deepseek-share/messages.json \
     --out ./out \
     --title "自定义标题"        # 省略则用首条提问自动生成

# 3) 装进会话库 + 挂到工作区（默认工作区「网页对话提取」）
#    注意：这一步会写 ~/.dsh，并且要访问本机 127.0.0.1 的 dsh web
node scripts/attach-workspace.mjs --manifest ./out/manifest.json

# 4) 自检（可选但推荐）
node scripts/verify-session.mjs ./out/session.v4.jsonl.zstd \
     --manifest ./out/manifest.json --require-installed
```

第 3 步完成后，**刷新 DSH 网页端**即可在目标工作区分组下看到它。

> 想先看效果、又不想动真实会话库？`bash scripts/selftest.sh` 会用
> [`examples/messages.sample.json`](examples/messages.sample.json)（一段合成的 Markdown 问答）
> 跑一遍「生成 → 校验」，全程离线、产物写到临时目录。

## 命令

### `scripts/fetch-share.mjs`

抓取分享页的完整对话（走公开 JSON 接口，一次给全，无分页）。

```bash
node scripts/fetch-share.mjs <分享链接或 share_id> [--outdir DIR]
```

产物：`raw.json`（原样）、`messages.json`（规范化的消息数组）、`preview.txt` / `preview_full.txt`
（人可读）、`meta.json`（完整性自检）。

### `scripts/build-session.mjs`

把 `messages.json` 转成 DSH 的物理日志。

```bash
node scripts/build-session.mjs --src messages.json [--out DIR] [--cwd /abs/path]
     [--id session-<uuid>] [--title "..."] [--no-reasoning]
     [--system-prompt auto|none|FILE] [--eventsPerFrame N] [--sessions-root DIR]
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--cwd` | 当前目录 | 会话的工作目录；**决定它属于哪个工作区**，必须是存在的绝对路径 |
| `--id` | 随机 UUID | 固定会话 id，便于幂等重装 |
| `--title` | 首条提问前 24 字 | 侧边栏标题 |
| `--no-reasoning` | 否 | 不写入思维链（`reasoning` 块） |
| `--system-prompt` | `auto` | `auto`=从本机已有 DSH 会话里取一份真实系统提示词快照；`none`=不写；`FILE`=用指定文件 |
| `--eventsPerFrame` | 16 | 每帧装多少条事件 |

产物：`session.jsonl`（明文，便于 review）、`session.v4.jsonl.zstd`（真正的产物）、`manifest.json`。

### `scripts/install-session.sh`

按 manifest 把产物放进 `$DSH_HOME/sessions/<项目键>/<会话 id>/`，并清掉同一 id 的旧位置。

```bash
bash scripts/install-session.sh [out/manifest.json]
```

### `scripts/attach-workspace.mjs`

**把会话挂到你指定的工作区**（这一步决定它在侧边栏的分组）。

```bash
node scripts/attach-workspace.mjs --manifest out/manifest.json [options]
```

| 参数 | 说明 |
|---|---|
| `--workspace <标题 \| workspaceId \| /绝对路径>` | 目标工作区；省略则用默认工作区 |
| `--create-path <目录>` | 目标工作区目录；不存在会自动创建 |
| `--title <名字>` | 工作区标题 |
| `--ensure-only` | 只创建/取回工作区，不碰会话 |
| `--no-rebase` | 会话 `cwd` 与工作区路径不一致时直接报错，不自动重建 |
| `--dry-run` | 只打印将要执行的动作 |
| `--url` | 本地 DSH 地址，默认 `$DSH_WEB_URL` 或 `http://127.0.0.1:3080` |

默认工作区目录：`$DSH_IMPORT_WORKSPACE` 或 `~/dsh-web-conversations`，标题「网页对话提取」。

它依次做：保证产物已入库 → `workspace/create`（幂等）→ 必要时按目标路径重建会话（同一 id、保留标题）
→ `session/create`（服务端 attach）→ 再取一次工作区视图**验证** `sessionIds` 里确实有它，成功输出 `ATTACH-OK`。

### `scripts/register-workspace.mjs`

**兜底方案**：`dsh web` 没在运行时，直接把 id 写进 `$DSH_HOME/storages/workspace.json`。

```bash
node scripts/register-workspace.mjs [--manifest out/manifest.json] [--remove]
```

> 它要等 `dsh web` **重启**后才生效，而且重启前任何一次工作区变更都会把它覆盖掉。
> 服务能跑的时候，请优先用 `attach-workspace.mjs`。

### `scripts/verify-session.mjs`

用 **DSH 自己的代码**做两段式校验：

* **Stage A**：按后端顺序解码物理容器 → `sessionFormatCatalog.createRestore(..., {validation:'current'})`
  （内部即 `restoreReleasedV4Artifact` + `Session.fromRestore`）→ 用 `deriveEventMessage` 重新导出可见消息；
* **Stage B**：直接实例化真实的 `JsonlSessionPersistence`，`list()` 找到它并 `open(id,'read')`
  读回来与磁盘逐条比对（round-trip）—— 这正是网页端列侧边栏、打开会话走的代码。

```bash
node scripts/verify-session.mjs out/session.v4.jsonl.zstd \
     [--manifest out/manifest.json] [--expect-users N] [--expect-assistants N] [--require-installed]
```

> **为什么必须两段**：Stage A 通过 ≠ 会话会被列出。物理容器有个坑 —— header 必须独占第一帧，
> 否则 `persistence.list()` 会**静默跳过**整个文件（详见 [docs/session-format-v4.md](docs/session-format-v4.md)）。

## 工作原理

```
分享链接 ──► /api/v0/share/content ──► messages.json
                                        │  (REQUEST / RESPONSE / THINK / TOOL_* 按 fragment 组装)
                                        ▼
                            build-session.mjs  ──►  session.v4.jsonl.zstd
                                        │              (header 独占第一帧 + 事件分批成帧)
                                        ▼
                       install-session.sh  ──►  $DSH_HOME/sessions/<项目键>/<id>/
                                        │
                                        ▼
                     attach-workspace.mjs  ──►  workspace/create + session/create
                                        │        (调运行中 dsh web 的本地 API)
                                        ▼
                              侧边栏对应分组下出现，点开即可继续对话
```

细节文档：

* [docs/session-format-v4.md](docs/session-format-v4.md) —— 会话格式、事件映射、物理帧布局
* [docs/workspace-attach.md](docs/workspace-attach.md) —— 工作区分组与本地 API 挂载机制
* [docs/troubleshooting.md](docs/troubleshooting.md) —— 常见问题排查

## 安装为 DSH Skill

这个仓库本身就是一个 DSH Skill（根目录的 [`SKILL.md`](SKILL.md)）：

```bash
git clone https://github.com/czr-chu/deepseek-share-to-dsh-session.git \
  ~/.dsh/skills/deepseek-share-to-dsh-session
```

之后在会话里直接说「把这个分享链接导入成会话」，Agent 就会按 `SKILL.md` 的流程走。
DSH 会监听 skills 目录，新增后通常无需重启即可被发现。

## 隐私与安全

* **不联网上传任何东西**：除第 1 步抓取公开分享内容外，全部操作都在本机完成。
* **不需要 API Key**：抓取接口是公开的；本项目不接触、不保存任何模型密钥。
* **只读本机 DSH 数据**：
  * `build-session.mjs --system-prompt auto` 会从 `$DSH_HOME/sessions` 里已有的会话中
    **取一份系统提示词快照**（纯本地读取，且会把里面的工作目录改写成目标 `cwd`）。
    不想让它读，用 `--system-prompt none` 或指定文件。
  * `attach-workspace.mjs` 会读 `$DSH_HOME/.credentials.yaml` 里 **web 端会话签名密钥**，
    按服务端同一算法现场签一个 cookie 去调 `127.0.0.1` 的本地服务。
    这等价于「用你已登录的浏览器身份」去点一下工作区挂载，密钥不会离开本机、也不会被打印。
* **产物即会话**：`out/` 里的文件包含对话全文，注意别误提交到公开仓库（见 [.gitignore](.gitignore)）。

## 已知限制

* **分享内容依赖 DeepSeek 的公开接口**，非文档化契约，接口变动可能导致抓取失败（其余步骤不受影响）。
* **网页端分享数据里的模型名是空的**，助手消息的 `source.model` 统一记为 `deepseek-chat`（来源是网页版）；
  继续对话时使用当前会话/本机默认模型。
* **引用标记**：`[reference:N]` 中能取到 URL 的（`TOOL_OPEN`）会转成 Markdown 链接；
  只指向"联网搜索结果集"的（`TOOL_SEARCH`，源数据里 `url` 为 `null`）保持原样。
* **源数据里生成失败的回复**会原样保留（不臆造补全）。
* **会话一旦被服务端"活取"**（在网页里打开过），它的 `cwd` 就固定在内存里；
  此时想改挂到别的工作区，需要先重启 `dsh web`（脚本会提前检测并提示，不会破坏文件）。
  —— 所以推荐 **先挂载、后打开**。
* **工作区目录会被创建**：默认 `~/dsh-web-conversations`，可用 `--workspace/--create-path` 指定。

## 目录结构

```
.
├── README.md                          # 中文说明（主）
├── README.en.md                       # English
├── SKILL.md                           # DSH Skill 定义（Agent 读这个）
├── LICENSE                            # MIT
├── CHANGELOG.md
├── CONTRIBUTING.md
├── package.json
├── .github/workflows/selftest.yml     # CI：跑自检
├── scripts/
│   ├── fetch-share.mjs                # 抓取分享内容
│   ├── build-session.mjs              # 生成 Session v4 日志
│   ├── install-session.sh             # 装进会话库
│   ├── attach-workspace.mjs           # 挂到工作区（调本地 API）
│   ├── register-workspace.mjs         # 兜底：直接写 workspace.json
│   ├── verify-session.mjs             # 两段式校验
│   └── selftest.sh                    # 本地自检（离线）
├── docs/
│   ├── session-format-v4.md
│   ├── workspace-attach.md
│   └── troubleshooting.md
└── examples/
    ├── messages.sample.json           # 合成的对话样本
    └── README.md
```

## 开发

```bash
bash scripts/selftest.sh     # 离线自检：生成 + 校验（不碰真实会话库）
```

* 无第三方依赖，不需要 `npm install`。
* 改动校验逻辑时，请保证 Stage A / Stage B 都覆盖；只有 Stage A 通过并不代表会话会被 DSH 列出。

## 关于本项目

本项目是**在 DeepSeek Harness 会话中与 AI Agent 协作完成**的：格式逆向、脚本实现、
踩坑记录与文档均由 AI 辅助生成，经人工复核后发布。使用前请自行审阅代码，
尤其是会写入 `$DSH_HOME` 与调用本地服务的那几个脚本。

欢迎 Issue / PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
