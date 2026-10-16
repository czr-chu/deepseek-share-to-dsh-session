---
name: deepseek-share-to-dsh-session
description: 把 DeepSeek 网页版分享链接(chat.deepseek.com/share/<id>)的整段对话转成 DSH Session v4 会话文件并装入 $DSH_HOME/sessions，使其能在 DeepSeek Harness 网页端直接打开、继续对话。含公开抓取接口、v4 事件映射、物理帧格式硬要求、调本地服务 API 自动挂到指定工作区、两段式校验脚本。
whenToUse: 用户给出 chat.deepseek.com/share/... 链接或 share_id，要求"导入/转成 dsh 会话""在 harness 里打开并继续这段对话""搬到某个工作区"；或需要把外部对话写成 DSH 会话格式时。
---

# DeepSeek 分享对话 → DSH 会话

把 `https://chat.deepseek.com/share/<share_id>` 的完整对话转成 DSH **Session format v4** 日志，
装进 `$DSH_HOME/sessions/<项目键>/<会话id>/session.v4.jsonl.zstd`，在 DSH 网页端可见、可继续对话。

## 脚本（本 skill 的 `scripts/`）

| 脚本 | 作用 |
|---|---|
| `fetch-share.mjs` | 抓分享内容 → `raw.json` / `messages.json` / `preview*.txt` / `meta.json` |
| `build-session.mjs` | `messages.json` → `session.jsonl` + `session.v4.jsonl.zstd` + `manifest.json` |
| `install-session.sh` | 按 manifest 装进 `$DSH_HOME/sessions/<项目键>/`，清掉同一 id 的旧位置，缺项目目录会自动建 |
| **`attach-workspace.mjs`** | **装好后调运行中 `dsh web` 的本地 API，把会话挂进目标工作区并验证**（默认工作区「网页对话提取」） |
| `verify-session.mjs` | 两段式校验（格式/逻辑 + 真实 persistence list/open 往返） |
| `register-workspace.mjs` | 兜底：服务没跑时直接写 `workspace.json`（要重启才生效，且会被运行中的服务覆盖） |

## 标准流程

在仓库根目录执行（`<skill>` = 本仓库路径；装成 DSH Skill 后就是
`~/.dsh/skills/deepseek-share-to-dsh-session`）：

```bash
# 1) 抓取（公开接口，无需登录）
node <skill>/scripts/fetch-share.mjs https://chat.deepseek.com/share/<share_id> --outdir ./deepseek-share

# 2) 生成 v4 会话（--cwd 可省略；第 3 步会按目标工作区自动重建）
node <skill>/scripts/build-session.mjs --src ./deepseek-share/messages.json --out ./out --title "自定义标题"

# 3) 装进会话库 + 挂到工作区（要写 $DSH_HOME 并调本机 dsh web，容器/沙箱里需放行）
node <skill>/scripts/attach-workspace.mjs --manifest ./out/manifest.json
#    默认工作区「网页对话提取」（$DSH_IMPORT_WORKSPACE 或 ~/dsh-web-conversations）
#    换目标：--workspace <标题|workspaceId|/绝对路径>；只建工作区：--ensure-only
#    期望最后一行 ATTACH-OK（脚本已验证工作区 sessionIds 里确实有它）

# 4) 两段式校验（--require-installed 强制必须已被 persistence 列出）
node <skill>/scripts/verify-session.mjs ./out/session.v4.jsonl.zstd \
     --manifest ./out/manifest.json --require-installed
# 期望 VERIFY-OK
```

第 3 步完成后**不用重启**：刷新页面即可在目标工作区分组下看到它。
续聊时工具的工作目录就是工作区路径。

只想先看效果、不碰真实会话库：`bash <skill>/scripts/selftest.sh`（用
`examples/messages.sample.json` 离线跑一遍生成 + 校验）。

## 关键事实（踩过的坑，别再试错）

### 1. 抓取：真实接口是 `/api/v0/share/content`
```bash
curl -sS -H 'Accept: application/json' \
  'https://chat.deepseek.com/api/v0/share/content?share_id=<ID>' -o raw.json
```
无需登录/token/自定义头。**不是** `/api/v0/chat/history_messages`（要 token，返回 `40003 INVALID_TOKEN`），
**也不是** `/api/v0/chat/share_conversation`（不存在，回落 SPA HTML）。数据在
`data.biz_data.messages[]`，一次给全，无分页。

### 2. 正文要按 fragment 组装
每条 message 的 `fragments[]` 里：`REQUEST`=用户正文，`RESPONSE`=助手 markdown，
`THINK`=思维链，`TOOL_SEARCH`=搜索词+结果，`TOOL_OPEN`=打开的网页，`TIP`=免责声明。
`[reference:N]` 靠 `RESPONSE.references[]` 指向的 fragment 反查（`fetch-share.mjs` 已做，见 `citation_map`）。

### 3. DSH v4 事件映射（每条 envelope 都是 `{type,seq,time,data}`，`seq` 从 0 连续）

| 事件 | 必需字段 / 坑 |
|---|---|
| header | `{type:"session",version:4,id:"session-<uuid>",createdAt:<ms>,cwd:"<绝对路径>",isSeeded:false,delegationDepth:0,agentPreset:"standard"}` |
| `permission/preset` `sandbox/mode` `approval/policy` `model/selection` | 会话级配置头，放最前 |
| `turn/start{turn}` + `step/start{turn,step}` + `step/end` + `turn/end{turn,reason:{kind:"completed"}}` | 一次用户提问 = 一个 turn、一个 step；**必须成对闭合** |
| `user/message` | `{content:[{type:"text",text}],source:{kind:"user",...},role:"user",id}`，且事件上带 `surfaceOp:"append"` |
| `assistant/message` | `{turn,step,message:{role:"assistant",content:[…],source:{kind:"model",provider,model},id},stream:[]}` + `surfaceOp:"append"`。**`stream` 必须是数组**（空数组合法，DSH 显式允许空流，正文以 `message.content` 为准） |
| `system/message` | `{turn,step,message:{role:"system",content:[…],source:{kind:"system-prompt"},id}}` + `surfaceOp:"append"`。**必须是 surface 里第一个节点**（否则后续系统消息无法 append）。可从本机真实会话里取一份现成提示词 |
| `request/header` | `{header:{config:{provider,model,reasoningEffort,maxTokens},adapterDefaults:{maxTokens:true}},reason:"initial"}`（`reason` 只能是 initial/resume/change/series） |
| `request/context` | `{provider,model,contextWindow:1000000,systemPromptUpdate:"in-history"}` |
| `session/title` | `{title,messageSeqs:[<更早的 user/message seq>],source:{kind:"fallback"}}`；`messageSeqs` 引用的必须是 source.kind==="user" 的更早 `user/message` |

校验细节：`source.kind` 不能为空且不能是 `"plugin"`；`user/message` 的 data 本身就是 message，
`assistant/system/tool` 的 message 在 `data.message` 下。

### 4. 物理容器：header 必须独占第一帧（最容易静默失败）★

`.jsonl.zstd` 是**多帧拼接**容器，且 DSH 强制 `assertZstdHeaderFrame` / `assertIndependentHeaderFrame`：

```
帧 1 : JSON(header) + "\n"        ← 必须正好一行，单独一帧
帧 2..: 每帧 N 条整行事件（N≈16）
每帧: zlib.zstdCompressSync(text, {params:{[zlib.constants.ZSTD_c_checksumFlag]:1}})
```

**把 header 和事件压进同一帧的文件能正常解码、看着一切正常，但 `persistence.list()` 会直接跳过它 —— 侧边栏里根本不会出现。**
`verify-session.mjs` 的 Stage B 就是专门抓这个的。

### 5. 目录与命名规则

* 项目目录 = `--` + `cwd`（`/ \ :` 折成 `-`，其他非法字符转 `~XXXX`，截断 251）+ `--`
  → `/srv/project` ⇒ `--srv-project--`
* 会话目录 = `encodeSegment(sessionId)`（安全字符原样，其余 `~XXXX`）
* 目录里放 `session.v4.jsonl.zstd`（0600）+ 空 `session.lock`
* 不用手算：`build-session.mjs` 会把 `manifest.install.*` 算好

### 6. 工作区分组：必须调运行中服务的本地 API（最关键的一节）★

侧边栏分组只认 `$DSH_HOME/storages/workspace.json` 里工作区的 `sessionIds`，
而 `WorkspaceEntity.sessionIds` 还会用一张**只在 `dsh web` 启动时重建**的
「会话 id → 项目路径」内存索引过滤；非 GUI 创建的会话**不会**被自动 attach。
所以外部新增的会话默认永远落在「未分组」。

**坑一：直接改 `workspace.json` 没用。** 运行中的服务把整份状态缓存在内存里，
任何一次工作区变更（新建/重命名/归档/排序）都会用内存状态原子重写整个文件，外部写入被静默覆盖。
（实测：2026-10-07 写进去的登记，10-09 就被覆盖了，会话一直是「未分组」。）

**正确做法：调运行中服务自己的 API**，让服务自己去 attach：

```bash
node <skill>/scripts/attach-workspace.mjs --manifest out/manifest.json                    # 默认「网页对话提取」
node <skill>/scripts/attach-workspace.mjs --manifest out/manifest.json --workspace MyProject
node <skill>/scripts/attach-workspace.mjs --manifest out/manifest.json --workspace /abs/dir  # 按目录建/取工作区
node <skill>/scripts/attach-workspace.mjs --manifest out/manifest.json --ensure-only         # 只建/取工作区
```

它依次做：`install-session.sh`（保证产物已入库）→ `workspace/create`（幂等；必要时建目录、
不在 store 里的标题按 `$DSH_IMPORT_WORKSPACE` 的同级目录推断，可用 `--create-path` 覆盖）→
cwd 不一致时用 `build-session.mjs` 以目标路径**重建并重装（同一 session id，保留标题）** →
`session/create{workspaceId,sessionId}`（服务端 `ensureSession` + `attachSession`）→
再取一次工作区视图**验证** `sessionIds` 里确实有它。成功输出 `ATTACH-OK`，**无需重启**。

认证从哪来：本地 web 服务用「持久化签名密钥 + 签名 cookie」鉴权
（`packages/client/connection/src/browser-auth.ts`）。密钥明文存在
`$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session`；脚本按同一算法
（cookie 名 `dsh-auth-<b64u(sha256(authority))>`，值 `v1.<b64u(payload)>.<b64u(hmac-sha256)>`）
现场签一个 cookie，调 `POST /api/<controller>/<method>`，请求体
`{type:"client-request",rpcId,method,payload:{args:{<参数名>:…}}}`，
等价于浏览器里那个已登录会话。前提：`dsh web` 正在运行、`$DSH_HOME` 指向同一个家目录。

**坑二：会话一旦被「活取」，cwd 就固定了。** 会话在网页里打开过（或用本工具挂载过）后，
服务端内存里那份的 `header.cwd` 已定；此时改文件里的 cwd 再挂到别的工作区会得到
`session/conflict: session … belongs to "X", not "Y"`。脚本会先查 `session/list` 的
`agentAvailable` **提前拦住**（此时不做任何写入），提示：重启一次 `dsh web` 再改挂。
新导入、还没打开过的会话不受影响 —— 所以**先挂载、后打开**。

**兜底**：`dsh web` 没在跑时用 `register-workspace.mjs`（直接写 `workspace.json`，
幂等、`--remove` 撤销），但它要重启后才生效，且期间任何工作区变更都会覆盖它。
### 7. 为什么要两段式校验

* **Stage A**（格式/逻辑）：`sessionFormatCatalog.createRestore(header,{recovery:'recoverable',validation:'current'})`
  → 内部跑 `restoreReleasedV4Artifact` + `Session.fromRestore`，再用 `deriveEventMessage` 数可见消息。
* **Stage B**（真实后端）：`new JsonlSessionPersistence(ctx,{root:$DSH_HOME/sessions,compression:'zstd'})`
  → `list()` 找到它 + `open(id,'read')` 读回来与磁盘逐条比对（round-trip）。
  这正是网页端列侧边栏、打开会话走的代码。
* **A 通过 ≠ 会被列出**（第 4 条那个帧的坑），所以两个都要跑。
* 脚本会自己找 DSH 包（`which dsh` / `npm root -g`，也可用 `DSH_PACKAGES_DIR` 指定），并用
  `createRequire` 走包 manifests 解析，换版本/换安装前缀都能用。

### 8. 权限

写 `~/.dsh/**`（sessions、storages）在工作区沙箱外，必须用 `danger-full-access`
（bash 的 `sandbox_permissions`）或让用户点同意；只读操作不受影响。
`attach-workspace.mjs` 要写 sessions（装产物）**并且**要能访问 `127.0.0.1:3080`，
所以同样需要放行；它调 API 本身不产生额外权限需求。
另外默认工作区目录（`$DSH_IMPORT_WORKSPACE` 或 `~/dsh-web-conversations`）需要可创建；
若放在沙箱外，建目录这一步也要放行。

## 已知取舍（照实处理，不要臆造）

* `[reference:N]`：`TOOL_OPEN` 有 `url` → 转成 markdown 链接 `[N](url)`；`TOOL_SEARCH` 的 `url` 是 `null`
  （只指向搜索结果组）→ 保持原样 `[reference:N]`，并在交付说明里讲清楚。
* 源数据里生成失败的回复（例如正文只有一个 `"<"`）原样保留。
* 分享数据不带模型名（`model:""`）：助手消息 `source.model` 记 `deepseek-chat`（网页版来源），
  续聊按会话/本机默认模型走。
* 思维链写入 `reasoning` 块：DSH 缺 replayState 时按未签名 thinking 重放（是 DSH 自己支持的降级路径）；
  不想要就 `--no-reasoning`。
* 注入的 `system/message` 取自本机某个真实会话（工作目录会被改写成目标 `cwd`）。续聊时若当前提示词不同，
  DSH 会自己再追加一条新的系统消息，属正常。
* 时间戳用源数据真实 `inserted_at`，`createdAt` 取首条消息时间，不要改成"现在"。

## 快速自检清单

- [ ] `fetch-share.mjs` 报的消息条数与角色计数和源站一致，`all_status_finished` 为 true
- [ ] `verify-session.mjs` 输出 `VERIFY-OK`，且 Stage A 的 user/assistant 条数符合预期
- [ ] Stage B `listed=yes` + `round-trip=exact`（用 `--require-installed` 强制）
- [ ] `attach-workspace.mjs` 输出 `ATTACH-OK`，且 `workspace.sessionIds` 里包含该会话、`attached:true`
- [ ] 目标工作区标题/路径符合用户预期（默认「网页对话提取」= `<home>/Piwork/网页对话提取`）
- [ ] 把"先挂载、后打开"讲清楚：会话一旦在页面里打开过，改工作区就得先重启 `dsh web`
- [ ] 服务没在跑时才退回 `register-workspace.mjs`，并说明要重启

## 已验证的规模与回归

工具在真实分享链接上验证过：**62 条消息（user 31 / assistant 31）**的对话可以完整转换，
生成 194 个事件 / 31 个 turn，两段式校验均为 `round-trip=exact` + `VERIFY-OK`，
并通过本地 API 成功挂载到工作区（`ATTACH-OK`）。

日常回归用 `bash scripts/selftest.sh`（离线、合成样本）。改动格式或校验逻辑时，
**Stage A 与 Stage B 都要保持通过** —— 只过 Stage A 不足以证明会话会被 DSH 列出。

## 关于本 Skill

本 Skill 与仓库其余部分一样，是在 DSH 会话中与 AI Agent 协作完成、经人工复核后发布的。
执行会写入 `$DSH_HOME` 或调用本机服务的步骤前，请先自行审阅对应脚本。
