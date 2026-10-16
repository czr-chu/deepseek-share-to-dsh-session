# 工作区分组与本地 API 挂载

这篇解释**为什么**新导入的会话会显示在「未分组」，以及**怎样**用一条命令把它放进指定工作区。
内容是阅读 DSH 实现（`dsh-workspace`、`dsh-api-workspace-controller`、
`dsh-api-session-controller`、`dsh-client-connection`）后的结论，并经过实测验证。

## 1. 分组由什么决定

侧边栏把会话分组到工作区，依据是 `$DSH_HOME/storages/workspace.json` 里每个工作区的
`sessionIds` 数组。但真正参与展示的并不是那个数组本身，而是：

```ts
get sessionIds() {
  return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path)
}
```

即：**记录里的 id** ∩ **「会话 id → 项目路径」内存索引里路径一致的那些**。

这张内存索引只在 `dsh web` **启动时**由所有已存会话的 header 重建
（`Service.init` → `replaceHeaderIndex`）。同时，**只有通过网页端创建的会话才会被自动挂载**
（`session.create` → `ensureSession` → `workspace.attachSession`）。

结论：**在 DSH 之外生成的会话，永远不会自己进任何工作区**，只会落在「未分组」。

## 2. 为什么直接改 `workspace.json` 不行

运行中的服务把整份工作区状态**缓存在内存里**；任何一次工作区变更
（新建 / 重命名 / 归档 / 排序 / 挂载）都会用内存状态**原子重写整个文件**。

因此：

* 外部写进去的 `sessionIds` 在服务下次写盘时会被覆盖掉；
* 即使侥幸活到下次重启，也要等**重启**才生效（因为内存索引要重建）。

实测结论：这条路线在"服务一直开着"的日常使用里不可靠，本仓库只把它保留为
`dsh web` 没运行时的**兜底**（`scripts/register-workspace.mjs`）。

## 3. 正确做法：调运行中服务自己的 API

让服务自己去做挂载，它就会同时更新内存记录与磁盘，**立即生效、无需重启**。
`scripts/attach-workspace.mjs` 就是这么做的：

```
workspace/create  {path}                    # 幂等：按目录建/取工作区
workspace/rename  {workspaceId, title}      # 标题与目录名不同时改名
session/create    {workspaceId, sessionId}  # 服务端 ensureSession + attachSession
workspace/create  {path}                    # 再取一次视图，验证 sessionIds 里确实有它
```

## 4. 认证：本地服务怎么认你

DSH 的 web 通道用**持久化的签名密钥 + 签名 cookie**鉴权（实现见
`packages/client/connection/src/browser-auth.ts`）：

* 签名密钥是随机 32 字节，保存在 `$DSH_HOME/.credentials.yaml` 的
  `client-connection/browser-session` 记录里（本机文件，明文）；
* 浏览器通过 `dsh web` 打印的带 `?token=` 的 URL 换取 cookie；
* 之后每个请求带 cookie，服务端用同一密钥验签。

编码格式（照着实现即可复刻）：

```
cookie 名  = "dsh-auth-" + base64url(sha256(authority))     # authority 形如 127.0.0.1:3080
cookie 值  = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))
payload    = {"version":1,"authority":"<host:port>","issuedAt":<ms>,"expiresAt":<ms>}
```

请求侧：

```
POST /api/<namespace>/<method>
content-type: application/json
{ "type":"client-request", "rpcId":"<uuid>", "method":"<namespace>/<method>",
  "payload": { "args": { "<参数名>": { … } } } }
```

响应：`{"type":"server-response","rpcId":…,"result":{"ok":true,"value":…}}`，
失败则是 `{"ok":false,"error":{"code","message","details"}}`。

> `payload` 里**有且只有一个** `args` 字段；`args` 的键名是服务端方法**形参名**
> （例如 `list(_request, signal)` 需要 `{"_request":{}}`，`create(request)` 需要 `{"request":{…}}`）。
> 另外服务端还有一层 Host 信任栅栏：请求的 `Host` 必须是 loopback（用 `127.0.0.1` 调用即可）。

**安全边界**：脚本只在**本机**读你自己的凭据文件、只调用**本机**服务，密钥不会被打印或外发。
如果不想让它读凭据，就别用 `attach-workspace.mjs`，改用兜底脚本或手动在网页端操作。

## 5. 一个硬限制：会话被"活取"后 cwd 就固定了

会话第一次被服务端采用（在网页里打开过，或用本工具挂载过）之后，
内存里那份的 `header.cwd` 已经确定。此时即使改了文件里的 cwd，再挂到别的工作区也会得到：

```
session/conflict: session "…" belongs to "/old/path", not "/new/path"
```

`attach-workspace.mjs` 会在动手**之前**查 `session/list` 的 `agentAvailable` 字段，
发现会话是 live 且目标 cwd 不同时**直接退出**（不做任何写入），并提示：

> 重启一次 `dsh web` 再改挂。

所以推荐顺序是：**先生成并挂载，再打开聊天**。

## 6. 兜底流程（服务没跑时）

```bash
node scripts/register-workspace.mjs --manifest out/manifest.json   # 写入 sessionIds
# 然后启动/重启 dsh web，让内存索引重建
```

撤销：`node scripts/register-workspace.mjs --manifest out/manifest.json --remove`

脚本采用"临时文件 + rename"原子替换，并在写入前校验目标工作区存在。

## 7. 排查速查

| 现象 | 原因 / 处理 |
|---|---|
| 侧边栏「未分组」里能看到，但不在目标工作区 | 没有挂载成功；用 `attach-workspace.mjs` 重跑，确认输出 `ATTACH-OK` |
| `401` | 服务端认为你没登录：确认 `$DSH_HOME` 指向正在运行的那个 DSH 家目录 |
| `session/conflict` | 会话已被活取且 cwd 不同；重启 `dsh web` 后重跑 |
| 请求报 `missing "_request"` / `args fields do not match` | `payload.args` 的键名要跟服务端形参名一致 |
| 挂载后立刻刷新看不到 | 用新会话页/刷新一次让工作区视图重新拉取；确认 `workspace.sessionIds` 已包含该 id |
| 重启后分组又没了 | 用兜底脚本写的登记被覆盖了；改用 `attach-workspace.mjs` |
