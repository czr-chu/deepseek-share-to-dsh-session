# 常见问题排查

按流程顺序排列。遇到问题时，先跑 `bash scripts/selftest.sh` 确认工具链本身正常，
再逐步定位到具体环节。

## 0. 环境自检

```bash
node -v          # 需要 ≥ 22.15（内置 zstd）
node -e "console.log(typeof require('zlib').zstdCompressSync)"   # 应为 function
command -v dsh   # 校验/挂载/继续对话需要
echo "$DSH_HOME" # 默认 ~/.dsh
```

`zstdCompressSync` 为 `undefined` 说明 Node 太旧：升级到 22.15+ 或 23.8+。

## 1. 抓取阶段（`fetch-share.mjs`）

| 现象 | 处理 |
|---|---|
| `HTTP 404` / 返回 HTML | share_id 抄错，或分享已取消。确认链接形如 `chat.deepseek.com/share/<id>` |
| `API code=… ` 非 0 | 分享内容不可公开访问；换成新的分享链接 |
| 抓到 0 条消息 | 同上；先 `curl` 原始接口看 `data.biz_data.messages` 是否为空 |
| node fetch 失败但 curl 成功 | 代理环境导致；脚本会自动回落 curl。也可显式设置 `HTTPS_PROXY` |
| 消息条数与网页端不一致 | 网页端可能隐藏了失败回复；对照 `meta.json` 的 `role_counts` / `all_status_finished` |

## 2. 生成阶段（`build-session.mjs`）

| 现象 | 处理 |
|---|---|
| `source messages.json is empty` | `--src` 指错，或抓取产物为空 |
| 标题乱/太长 | 显式传 `--title` |
| 不想要思维链 | 加 `--no-reasoning` |
| 不想读本机其它会话 | `--system-prompt none`，或用 `--system-prompt <文件>` |
| `--sessions-root` 不生效 | 需要 ≥ 本仓库当前版本（kebab-case 参数已修） |
| 生成的 `cwd` 不是想要的工作区 | `--cwd` 必须是**已存在的绝对路径**；它决定会话属于哪个工作区 |

生成后可以先用 `node scripts/verify-session.mjs out/session.v4.jsonl.zstd` 做 Stage A 校验
（此时还没安装，Stage B 会打印 `listed=no`，属正常）。

## 3. 安装阶段（`install-session.sh`）

| 现象 | 处理 |
|---|---|
| `missing artifact` | 先跑 `build-session.mjs`，manifest 里记了产物路径 |
| 权限被拒 | 目标在 `$DSH_HOME`（默认 `~/.dsh`）下，需要写权限；容器/沙箱里要给该路径放行 |
| 同 id 出现在两个位置 | 脚本会自动删除其它项目目录下的同名副本；若手工搬运请自行清理 |
| macOS 上 `sha256sum: command not found` | 已兼容：脚本会回落 `shasum -a 256` |

## 4. 挂载阶段（`attach-workspace.mjs`）

| 现象 | 处理 |
|---|---|
| `cannot reach the DSH web server` | 没在跑 `dsh web`；或端口不同，用 `--url` 指定 |
| `401 rejected the local session credential` | `$DSH_HOME` 与正在运行的服务不是同一个家目录 |
| `session/conflict … belongs to "X", not "Y"` | 会话已被活取、cwd 固定；**重启 `dsh web`** 后重跑（脚本已提前拦截，不会破坏文件） |
| `session/create failed: session/…` | 看 `error.code`：`gateway/bad-request` 多半是参数名不对，本仓库脚本已对齐 |
| 目标工作区不存在 | 省略 `--workspace` 用默认；或 `--create-path <目录>` 指定；或先 `--ensure-only` 建好 |
| `ATTACH-OK` 但页面看不到 | 刷新页面；确认 `workspace.sessionIds` 里包含该 id（脚本输出里会打印） |
| 想撤销 | 网页端拖走/归档，或 `register-workspace.mjs --remove`（需重启生效） |

不想让脚本读 `~/.dsh/.credentials.yaml`：改用在网页端手动新建会话、或使用兜底脚本
（见 [workspace-attach.md](workspace-attach.md) 第 6 节）。

## 5. 校验阶段（`verify-session.mjs`）

| 现象 | 报错/含义 | 处理 |
|---|---|---|
| `cannot locate the DSH packages` | 找不到 DSH 安装 | 设 `DSH_PACKAGES_DIR=<...>/node_modules/@deepseek-ai`，或确保 `dsh` 在 PATH |
| `first zstd frame is not exactly one header line` | header 没独占第一帧 | 用本仓库的 `build-session.mjs` 重新生成；别手工拼容器 |
| `UNEXPECTED: visible=N, manifest says M` | 可见消息数与源不一致 | 检查抓取阶段是否漏消息；或 `--no-reasoning` 之外的内容被过滤 |
| Stage B `listed=no` | 还没安装 | 属正常；要做端到端校验就加 `--require-installed` 并先 `install-session.sh` |
| `round-trip=MISMATCH` | 磁盘与读回不一致 | 文件被并发改写（服务正在写同一会话）；停掉相关操作后重试 |

## 6. 在网页端使用

| 现象 | 说明 |
|---|---|
| 出现在「未分组」 | 未挂载成功；见第 4 节 |
| 能打开但助手回复空白 | 检查 `assistant/message` 的 `content` 是否有 `text` 块；`stream` 为 `[]` 是允许的 |
| 思维链看不到 | 生成时用了 `--no-reasoning`，或源数据本身没有 `THINK` 片段 |
| 继续对话时报模型相关错误 | 会话里记录的 `source.model` 是历史来源（网页版），续聊用当前会话/本机默认模型；换用本机可用模型即可 |
| 上下文太长 | 源对话很长时，全部历史都会进上下文；可用 DSH 的压缩命令或新建会话 |

## 7. 还是不行？

收集这些信息再提 Issue：

```bash
node -v; dsh --version 2>/dev/null || true
cat out/manifest.json
node scripts/verify-session.mjs out/session.v4.jsonl.zstd --manifest out/manifest.json
```

**提交前请脱敏**：不要贴分享链接原文、会话 id、工作区路径、`~/.dsh` 下的凭据内容。
