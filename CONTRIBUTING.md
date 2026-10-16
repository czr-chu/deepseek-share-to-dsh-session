# 贡献指南

感谢愿意帮忙改进这个项目。改动前请先读一遍本文件，能省掉不少来回。

## 提交 Issue 前

1. 先看 [docs/troubleshooting.md](docs/troubleshooting.md)；
2. 跑一次 `bash scripts/selftest.sh`，确认工具链本身是好的；
3. **务必脱敏**再贴日志 —— 不要包含：
   * 分享链接 / `share_id` 原文
   * 会话 id、工作区 id、工作区绝对路径
   * `~/.dsh` 下的任何凭据内容（`.credentials.yaml` 等）
   * 内网 IP、代理地址、API Key

   用 `<share_id>`、`/path/to/workspace`、`session-<uuid>` 这类占位符代替。

## 开发环境

* Node.js ≥ 22.15（需要内置 zstd）
* 无第三方依赖，不需要 `npm install`
* 建议装有可运行的 DSH（`dsh web`），这样 `verify-session.mjs` 的 Stage B 才能跑到

## 分支与提交

* 分支名：`feat/xxx`、`fix/xxx`、`docs/xxx`
* 提交信息用祈使句，首行 ≤ 72 字符，例如：
  * `fix(build): 让 --sessions-root 生效`
  * `docs(readme): 补充 Node 版本要求`

## 改代码时的硬性要求

1. **两段式校验都要过**：`node scripts/verify-session.mjs out/session.v4.jsonl.zstd --manifest out/manifest.json`。
   注意：Stage A 通过**不代表**会话会被 DSH 列出（物理容器首帧必须独立），
   所以不要以"能解码"作为完成标准。
2. **不要引入运行时依赖**，除非在 Issue 里说明必要性并获得认可。
3. **保持零个人信息**：任何示例、注释、文档里都不要出现真实的
   分享链接、会话 id、工作区路径、用户名或机器路径。
4. **新增/修改 CLI 参数**要同步更新：
   `README.md`、`README.en.md`、`SKILL.md` 以及脚本头部的 usage 注释。
5. **格式相关的结论要可复现**：说明是在哪个 DSH 版本上验证的，并给出验证命令。

## Pull Request 清单

- [ ] `bash scripts/selftest.sh` 通过
- [ ] （若有 DSH）`verify-session.mjs` Stage A + Stage B 通过
- [ ] 文档与 usage 注释同步更新
- [ ] 没有提交 `out/`、`deepseek-share/` 之类的产物
- [ ] 全文搜索一遍，确认没有个人信息（见上文脱敏清单）

## 关于 AI 辅助贡献

本项目本身就是在 DSH 会话中与 AI Agent 协作完成的，**欢迎 AI 辅助提交**。
但请在 PR 描述里说明，并对生成内容做过人工审阅 —— 尤其是会写 `$DSH_HOME`、
调用本机服务、或修改格式校验逻辑的部分。
