# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的风格，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-16

首个公开版本。

### Added

* `scripts/fetch-share.mjs` —— 抓取 DeepSeek 分享页完整对话（公开 JSON 接口，无需登录），
  产出 `raw.json` / `messages.json` / `preview*.txt` / `meta.json`
* `scripts/build-session.mjs` —— 把规范化消息转成 DSH **Session format v4** 日志
  （多帧 zstd 容器 + JSONL），支持思维链、引用解析、系统提示词来源选择
* `scripts/install-session.sh` —— 按 `manifest.json` 装进 `$DSH_HOME/sessions/<项目键>/<会话 id>/`
* `scripts/attach-workspace.mjs` —— 调运行中 `dsh web` 的本地 API（`workspace/create` +
  `session/create`）把会话挂进指定工作区，并回读验证
* `scripts/register-workspace.mjs` —— 服务未运行时的兜底：直接写 `storages/workspace.json`
* `scripts/verify-session.mjs` —— 两段式校验：DSH 格式代码解码恢复 + 真实 persistence
  `list()`/`open()` 往返比对
* `scripts/selftest.sh` —— 离线自检（用合成样本跑生成 + 校验）
* `SKILL.md` —— 可作为 DSH Skill 安装（`~/.dsh/skills/`）
* `docs/session-format-v4.md`、`docs/workspace-attach.md`、`docs/troubleshooting.md`
* `examples/messages.sample.json` —— 合成对话样本（含 reasoning / 引用 / 搜索片段）

### Notes

* 零第三方依赖；Node ≥ 22.15（需要内置 zstd）
* 已验证规模：62 条消息 / 31 轮的真实分享对话可完整转换并通过两段式校验

[1.0.0]: https://github.com/czr-chu/deepseek-share-to-dsh-session/releases/tag/v1.0.0
