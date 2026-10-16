# DeepSeek Share Link → DSH Session

[中文](README.md) | English

> Turn a public DeepSeek web share link (`chat.deepseek.com/share/<id>`) into a
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) session you can
> **keep talking in**.
>
> Fetch → convert into a DSH **Session format v4** log → install it into the session store → attach it to the workspace you pick.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.15-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)

---

## Why you need it

A DeepSeek web share page is a read-only web page:

* there is no export button, so you cannot get the conversation as structured data;
* even if you copy the text out by hand, it **cannot be plugged back into any agent tooling** — the next time you want to continue, you have to paste the whole context again.

DSH keeps its sessions in a log format of its own (multi-frame zstd + JSONL, see [docs/session-format-v4.md](docs/session-format-v4.md)), and an external conversation cannot simply be dropped into it.

This project fills in the step in between and produces a session record that is **indistinguishable from a native one**: it shows up in the sidebar, opens and reads like any other session, and you can **keep typing in the composer** — the history (chain of thought included) is automatically sent to the model as context.

## What it looks like

```console
$ node scripts/fetch-share.mjs https://chat.deepseek.com/share/<share_id> --outdir ./deepseek-share
[fetch] node fetch OK (HTTP 200, 956728 bytes)
{"user":31,"assistant":31} fragments: {"REQUEST":31,"RESPONSE":31,"THINK":80,"TOOL_SEARCH":29,"TOOL_OPEN":115,"TIP":9}

$ node scripts/build-session.mjs --src ./deepseek-share/messages.json --out ./out --title "Custom title"
{ "sessionId": "session-<uuid>", "events": 194, "turns": 31, "zstdBytes": 90… }

$ node scripts/attach-workspace.mjs --manifest ./out/manifest.json
{ "workspace": { "title": "网页对话提取", "attached": true }, "agentPreset": "standard" }
ATTACH-OK

$ node scripts/verify-session.mjs ./out/session.v4.jsonl.zstd --manifest ./out/manifest.json --require-installed
=== STAGE A: format + logical restore ===    … users: 31, assistants: 31
=== STAGE B: real JsonlSessionPersistence list/open ===
listed=yes  open=read events=194  round-trip=exact
VERIFY-OK
```

Once it finishes, refresh the DSH web UI and the session will be in the sidebar — **no service restart required**.

## Features

* **Zero dependencies** — Node built-ins only (`fetch` + zstd from `node:zlib`); no `npm install`
* **Fetched over a public endpoint** — `/api/v0/share/content`, no login, no token, no pagination
* **Faithful restore** — message text, chain of thought (`reasoning`), web-search citations and timestamps all land on disk exactly as they appear in the source data
* **A real DSH session** — not "a file that happens to look plausible", but one that passes DSH's own format validation and persistence read-back
* **Two-stage self-check** — first decode and validate with DSH's format code, then round-trip through the real persistence backend via `list()`/`open()`
* **One command to attach it to a workspace** — calls the running service's local API, so the session lands in the right group immediately
* **Usable as a DSH Skill** — `git clone` it into `~/.dsh/skills/` and agents can invoke it automatically

## Requirements

| Dependency | Notes |
|---|---|
| Node.js | **≥ 22.15** (or ≥ 23.8). Built-in zstd is used (`zlib.zstdCompressSync`); older versions do not have it |
| DeepSeek Harness | Validation, workspace attach and continued chatting all need a local `dsh` (having `dsh web` running is the easiest setup) |
| Network | Only needed to fetch the share content; every other step is fully local |
| API key | **Not needed.** Fetching uses a public endpoint, and everything else reads and writes local DSH data |

## Quick start

```bash
git clone https://github.com/czr-chu/deepseek-share-to-dsh-session.git
cd deepseek-share-to-dsh-session

# 1) Fetch the shared conversation (public endpoint, no login)
node scripts/fetch-share.mjs https://chat.deepseek.com/share/<share_id> --outdir ./deepseek-share

# 2) Build the DSH Session v4 log
node scripts/build-session.mjs \
     --src ./deepseek-share/messages.json \
     --out ./out \
     --title "Custom title"        # omit it to derive the title from the first question

# 3) Install into the session store + attach to a workspace (default workspace title: 网页对话提取)
#    Note: this step writes to ~/.dsh and talks to `dsh web` on 127.0.0.1
node scripts/attach-workspace.mjs --manifest ./out/manifest.json

# 4) Self-check (optional but recommended)
node scripts/verify-session.mjs ./out/session.v4.jsonl.zstd \
     --manifest ./out/manifest.json --require-installed
```

Once step 3 is done, **refresh the DSH web UI** and you will see the session under the target workspace's group.

> Just want to try it out without touching your real session store? `bash scripts/selftest.sh`
> runs the whole "build → verify" flow against
> [`examples/messages.sample.json`](examples/messages.sample.json) (a synthetic Markdown Q&A),
> completely offline, writing its artifacts to a temporary directory.

## Commands

### `scripts/fetch-share.mjs`

Fetches the complete conversation behind a share page (through the public JSON endpoint, in one shot, no pagination).

```bash
node scripts/fetch-share.mjs <share url or share_id> [--outdir DIR]
```

Output: `raw.json` (verbatim), `messages.json` (normalized message array), `preview.txt` / `preview_full.txt`
(human-readable), `meta.json` (integrity self-check).

### `scripts/build-session.mjs`

Converts `messages.json` into DSH's physical log.

```bash
node scripts/build-session.mjs --src messages.json [--out DIR] [--cwd /abs/path]
     [--id session-<uuid>] [--title "..."] [--no-reasoning]
     [--system-prompt auto|none|FILE] [--eventsPerFrame N] [--sessions-root DIR]
```

| Option | Default | Description |
|---|---|---|
| `--cwd` | current directory | Working directory of the session; **this is what determines which workspace it belongs to**, and it must be an existing absolute path |
| `--id` | random UUID | Pin the session id, which makes re-installs idempotent |
| `--title` | first 24 characters of the first question | Sidebar title |
| `--no-reasoning` | off | Do not write the chain of thought (`reasoning` blocks) |
| `--system-prompt` | `auto` | `auto` = take a real system-prompt snapshot from an existing local DSH session; `none` = write none; `FILE` = use the given file |
| `--eventsPerFrame` | 16 | How many events go into each frame |

Output: `session.jsonl` (plaintext, easy to review), `session.v4.jsonl.zstd` (the real artifact), `manifest.json`.

### `scripts/install-session.sh`

Installs the artifacts described by the manifest into `$DSH_HOME/sessions/<project key>/<session id>/` and removes any stale copies of the same id.

```bash
bash scripts/install-session.sh [out/manifest.json]
```

### `scripts/attach-workspace.mjs`

**Attaches the session to the workspace you choose** (this is what decides its sidebar group).

```bash
node scripts/attach-workspace.mjs --manifest out/manifest.json [options]
```

| Option | Description |
|---|---|
| `--workspace <title \| workspaceId \| /absolute/path>` | Target workspace; the default workspace is used when omitted |
| `--create-path <dir>` | Directory for the target workspace; created if it does not exist |
| `--title <name>` | Workspace title |
| `--ensure-only` | Only create/fetch the workspace, leave sessions alone |
| `--no-rebase` | Fail instead of rebuilding when the session `cwd` and the workspace path differ |
| `--dry-run` | Only print the actions that would be taken |
| `--url` | Local DSH address, defaults to `$DSH_WEB_URL` or `http://127.0.0.1:3080` |

Default workspace directory: `$DSH_IMPORT_WORKSPACE` or `~/dsh-web-conversations`, with the title `网页对话提取` ("web conversation import").

It works through the following steps: make sure the artifact is installed → `workspace/create` (idempotent) → rebuild the session against the target path when necessary (same id, title preserved)
→ `session/create` (server-side attach) → fetch the workspace view again and **verify** that `sessionIds` really contains it, printing `ATTACH-OK` on success.

### `scripts/register-workspace.mjs`

**Fallback**: when `dsh web` is not running, write the id directly into `$DSH_HOME/storages/workspace.json`.

```bash
node scripts/register-workspace.mjs [--manifest out/manifest.json] [--remove]
```

> It only takes effect after `dsh web` is **restarted**, and any workspace change made before
> that restart will overwrite it. Prefer `attach-workspace.mjs` whenever the service is running.

### `scripts/verify-session.mjs`

Runs a two-stage check using **DSH's own code**:

* **Stage A**: decode the physical container the way the backend does → `sessionFormatCatalog.createRestore(..., {validation:'current'})`
  (which internally runs `restoreReleasedV4Artifact` + `Session.fromRestore`) → re-derive the visible messages with `deriveEventMessage`;
* **Stage B**: instantiate the real `JsonlSessionPersistence`, find the session with `list()`, read it back with
  `open(id,'read')`, and compare it row by row against what is on disk (round-trip) — this is exactly the code path the web UI takes when it lists the sidebar and opens a session.

```bash
node scripts/verify-session.mjs out/session.v4.jsonl.zstd \
     [--manifest out/manifest.json] [--expect-users N] [--expect-assistants N] [--require-installed]
```

> **Why both stages are mandatory**: passing Stage A does not mean the session will be listed.
> The physical container has a trap — the header must own the first frame on its own, otherwise
> `persistence.list()` will **silently skip** the entire file (see [docs/session-format-v4.md](docs/session-format-v4.md)).

## How it works

```
Share link ──► /api/v0/share/content ──► messages.json
                                        │  (REQUEST / RESPONSE / THINK / TOOL_* assembled per fragment)
                                        ▼
                            build-session.mjs  ──►  session.v4.jsonl.zstd
                                        │              (header owns frame 1; events batched into frames)
                                        ▼
                           install-session.sh  ──►  $DSH_HOME/sessions/<project key>/<session id>/
                                        │
                                        ▼
                         attach-workspace.mjs  ──►  workspace/create + session/create
                                        │        (calls the local API of the running `dsh web`)
                                        ▼
                              appears in the sidebar under its group; open it and keep chatting
```

In-depth docs:

* [docs/session-format-v4.md](docs/session-format-v4.md) — session format, event mapping, physical frame layout
* [docs/workspace-attach.md](docs/workspace-attach.md) — workspace grouping and the local-API attach mechanism
* [docs/troubleshooting.md](docs/troubleshooting.md) — troubleshooting common problems

## Install as a DSH Skill

This repository is itself a DSH Skill (the [`SKILL.md`](SKILL.md) at its root):

```bash
git clone https://github.com/czr-chu/deepseek-share-to-dsh-session.git \
  ~/.dsh/skills/deepseek-share-to-dsh-session
```

After that, just say "import this share link as a session" in a conversation and the agent will follow the `SKILL.md` workflow.
DSH watches the skills directory, so newly added skills are usually picked up without a restart.

## Privacy and security

* **Nothing is uploaded anywhere**: apart from step 1 fetching public share content, every operation happens on your machine.
* **No API key required**: the fetch endpoint is public, and this project never touches or stores any model key.
* **Local DSH data is only read**:
  * `build-session.mjs --system-prompt auto` **takes a system-prompt snapshot** from a session that
    already exists in `$DSH_HOME/sessions` (a purely local read; the working directory inside it is
    rewritten to the target `cwd`). If you would rather it did not read anything, use
    `--system-prompt none` or point it at a file.
  * `attach-workspace.mjs` reads the **web session signing key** from `$DSH_HOME/.credentials.yaml`
    and signs a cookie on the spot with the same algorithm the server uses, in order to call the
    local service on `127.0.0.1`. This is equivalent to clicking the workspace attach action as your
    already-logged-in browser; the key never leaves your machine and is never printed.
* **The artifacts are the session**: the files in `out/` contain the full transcript, so take care not to commit them to a public repository (see [.gitignore](.gitignore)).

## Known limitations

* **Share content depends on DeepSeek's public endpoint**, which is not a documented contract — if it changes, fetching may break (the other steps are unaffected).
* **The web share payload carries no model name**, so assistant messages are recorded with `source.model` set to `deepseek-chat` (their origin is the web app);
  continued turns use the current session's model or the local default.
* **Citation markers**: `[reference:N]` entries that resolve to a URL (`TOOL_OPEN`) become Markdown links;
  those that only point at a "web search result set" (`TOOL_SEARCH`, whose `url` is `null` in the source data) are kept as they are.
* **Replies that failed to generate in the source data** are preserved verbatim (nothing is invented or completed).
* **Once a session has been "live-opened" by the server** (opened in the web UI), its `cwd` is pinned in memory;
  moving it to another workspace then requires restarting `dsh web` first (the scripts detect this up front and warn you instead of corrupting files).
  This is why the recommended order is **attach first, open later**.
* **The workspace directory gets created**: `~/dsh-web-conversations` by default, overridable with `--workspace`/`--create-path`.

## Repository layout

```
.
├── README.md                          # Chinese documentation (primary)
├── README.en.md                       # English
├── SKILL.md                           # DSH Skill definition (what agents read)
├── LICENSE                            # MIT
├── CHANGELOG.md
├── CONTRIBUTING.md
├── package.json
├── .github/workflows/selftest.yml     # CI: runs the self-test
├── scripts/
│   ├── fetch-share.mjs                # fetch the shared conversation
│   ├── build-session.mjs              # build the Session v4 log
│   ├── install-session.sh             # install into the session store
│   ├── attach-workspace.mjs           # attach to a workspace (calls the local API)
│   ├── register-workspace.mjs         # fallback: write workspace.json directly
│   ├── verify-session.mjs             # two-stage verification
│   └── selftest.sh                    # local self-test (offline)
├── docs/
│   ├── session-format-v4.md
│   ├── workspace-attach.md
│   └── troubleshooting.md
└── examples/
    ├── messages.sample.json           # synthetic conversation sample
    └── README.md
```

## Development

```bash
bash scripts/selftest.sh     # offline self-test: build + verify (never touches the real session store)
```

* No third-party dependencies, no `npm install` needed.
* When you change the verification logic, keep both Stage A and Stage B covered; Stage A passing on its own does not mean DSH will list the session.

## About this project

This project was **built inside a DeepSeek Harness session in collaboration with an AI agent**: the
format reverse-engineering, the scripts, the notes on what went wrong and the documentation were all
AI-assisted and human-reviewed before release. Please review the code yourself before using it,
especially the scripts that write to `$DSH_HOME` and call the local service.

Issues and PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
