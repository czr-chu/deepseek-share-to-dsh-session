# Session format v4：会话日志格式与事件映射

本文记录把一段外部对话写成 DSH 会话时，**必须遵守**的格式约束。
内容来自对 DSH 实现的阅读与实际验证（`dsh-session`、`dsh-session-format-*`、
`dsh-session-persistence-jsonl` 等包），仅供本工具使用与排错参考；
DSH 若升级格式版本，应以实际实现为准。

> 校验方式见 [`scripts/verify-session.mjs`](../scripts/verify-session.mjs)：
> 它直接用 DSH 自己的代码解码、restore、并用真实 persistence 后端读回比对。

## 1. 物理容器：`session.v4.jsonl.zstd`

这是一个**多帧拼接的 zstd 容器**，解压后得到 JSONL（每行一个 JSON 对象）。

```
帧 1 : JSON(header) + "\n"          ← 必须"正好一行"，单独成帧
帧 2..: 每帧 N 条完整事件行（N≈16）
每帧: zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
```

**硬要求**：第一帧必须是**且仅是** header 一行。DSH 在
`assertZstdHeaderFrame` / `assertIndependentHeaderFrame` 里强校验这一点。

> ⚠️ **最容易踩的坑**：把 header 和事件压进同一帧，文件本身能正常解压、看起来一切正常，
> 但 `persistence.list()` 会按"损坏"处理并**静默跳过**该文件 —— 网页端侧边栏里根本不会出现它。
> 所以自检必须包含"真实 persistence list/open"这一段（Stage B）。

## 2. 目录与命名

会话按 `<项目目录>/<会话 id>/session.v4.jsonl.zstd` 存放：

| 名称 | 规则 |
|---|---|
| 项目目录 | `--` + `cwd`（`/ \ :` 折成 `-`；其它非法字符转 `~XXXX`；截断 251 字符）+ `--` |
| 会话目录 | `encodeSegment(sessionId)`：安全字符原样，其余转 `~XXXX` |
| 日志文件 | `session.v4.jsonl.zstd`（v4 是当前代次，文件名带版本号） |
| 锁文件 | 同目录下空文件 `session.lock` |

例：`/opt/work/my project` → `--opt-work-my-project--`；中文会变成 `~XXXX` 转义序列。
`build-session.mjs` 会在 `manifest.json` 里把 `install.projectDir` / `install.targetFile` 算好。

## 3. Header

```json
{"type":"session","version":4,"id":"session-<uuid>","createdAt":1767225600000,
 "cwd":"/abs/path","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

* `version` 必须等于物理代次（4）
* `createdAt` 用**源对话的首条消息时间**（毫秒），不要写成"现在"
* `cwd` 必须是存在的绝对路径 —— 它同时决定会话属于哪个工作区
* `agentPreset` 可省略；省略时按本机默认预设

## 4. 事件信封

每个事件都是 `{type, seq, time, data}`，外加可选的 `surfaceOp` / `sourceEventSeqs`：

* `seq` 从 `0` 起连续递增，**不能跳号**（header 行不算 seq）
* `time` 单调不减（毫秒）
* `data` 的形状由 `type` 决定

## 5. 事件映射（外部对话 → v4）

一次"用户提问 + 助手回答" = 一个 `turn` + 一个 `step`：

```
turn/start{turn}
  step/start{turn, step}
    [system/message]            ← 只在该会话第一条 turn，且必须是 surface 的第一个节点
    user/message                ← surfaceOp:"append"
    [request/header]            ← 首个 turn
    [request/context]           ← 首个 turn
    [session/title]             ← 首个 turn
    assistant/message           ← surfaceOp:"append"
  step/end{turn, step}
turn/end{turn, reason:{kind:"completed"}}
```

### 会话级配置头（放在最前）

| 事件 | data |
|---|---|
| `permission/preset` | `{preset:"workspace-write"}` |
| `sandbox/mode` | `{mode:"workspace-write"}` |
| `approval/policy` | `{policy:"ask"}` |
| `model/selection` | `{provider, model, reasoningEffort}` |

### 消息事件

| 事件 | data 形状与要点 |
|---|---|
| `user/message` | **data 本身就是消息**：`{content:[{type:"text",...}], source:{kind:"user",...}, role:"user", id}` |
| `assistant/message` | `{turn, step, message:{role:"assistant", content:[…], source:{kind:"model",provider,model}, id}, stream:[]}` |
| `system/message` | `{turn, step, message:{role:"system", content:[…], source:{kind:"system-prompt"}, id}}` |

* `system/user/assistant/tool` 消息事件都属于 **surface**：必须带 `surfaceOp:"append"`
  （或替换操作对象），否则校验直接报错。
* `system/message` 的 `source.kind` 必须是 `"system-prompt"`；
  且它必须是 surface 里**第一个**节点，否则之后的系统消息无法 append
  （`system/message requires a protected first surface head`）。
* `assistant/message` 的 **`stream` 必须是数组**（可为 `[]`）。
  DSH 显式允许空流：`assertCurrentAssistantStreams` 对空流跳过一致性校验，
  正文以 `message.content` 为准。
* `source.kind` 不能为空、也不能是保留的 `"plugin"`。
* 内容块用 `{type:"text", text}` / `{type:"reasoning", text}`；
  工具调用块 `{type:"tool-call", id, name, arguments}` 必须与 `tool/call`、`tool/result`
  的生命周期事件配套，外部导入的对话**不要**伪造工具调用。

### 请求头

```json
{"type":"request/header","seq":…,"time":…,"data":{
  "header":{"config":{"provider":"deepseek-official","model":"deepseek-flash",
                      "reasoningEffort":"high","maxTokens":256000},
            "adapterDefaults":{"maxTokens":true}},
  "reason":"initial"}}
```

`reason` 只能是 `initial` / `resume` / `change` / `series` 之一。

### 标题

```json
{"type":"session/title","data":{"title":"…","messageSeqs":[<更早的 user/message seq>],
                               "source":{"kind":"fallback"}}}
```

`messageSeqs` 引用的必须是**更早的**、`source.kind === "user"` 的 `user/message` 事件
（标题为空则要求 `source.kind === "user"`）。

### 生命周期

* `step/end` / `turn/end` 必须成对闭合，且 `reason` 用 `{kind:"completed"}`
* `turn/end` 必须在没有打开 step 的状态下发出
* 事件序列里未闭合的 turn 会让后续 `turn/start` 校验失败

## 6. 校验层次

| 层次 | 检查内容 |
|---|---|
| 物理解码 | 帧结构（首帧独立）、zstd 校验和、JSON 合法性 |
| 格式恢复 | `restoreReleasedV4Artifact`：header、事件词汇表、消息 source、生命周期、surface 关系 |
| 安装态会话 | `Session.fromRestore`：事件信封、seq 连续性、surface 转移、消息形态 |
| 持久化读回 | `JsonlSessionPersistence.list()` / `open(id,'read')`：能否被枚举、逐条往返一致 |

只做前两层是不够的 —— 第 4 层才会发现"物理容器首帧不独立"这类静默失败。

## 7. `session/end-seed` 的小细节

`Session.fromRestore` 会在内存里的日志末尾补一条 `session/end-seed`（若原本没有），
所以"restore 出来的事件数"通常比"文件里的行数"多 1。这是正常现象：
比较时应该拿**磁盘上的行数**（`manifest.eventCount`）跟持久化读回的事件数比。
