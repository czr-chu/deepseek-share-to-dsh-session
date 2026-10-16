#!/usr/bin/env node
/**
 * Convert a normalized DeepSeek-web share conversation (messages.json) into a
 * DSH Session format-v4 JSONL log (`session.v4.jsonl.zstd`).
 *
 * Usage:
 *   node build-session.mjs --src messages.json [--out DIR] [--cwd /abs/path]
 *                          [--id session-<uuid>] [--title "..."] [--no-reasoning]
 *                          [--system-prompt auto|none|FILE]
 *                          [--sessions-root ~/.dsh/sessions] [--eventsPerFrame N]
 *
 * Outputs into --out:
 *   session.jsonl            plain physical rows (header + events), for review
 *   session.v4.jsonl.zstd    the actual DSH artifact (single zstd frame, checksummed)
 *   manifest.json            identity + install instructions
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const HOME = process.env.HOME ?? '';
const DSH_HOME = process.env.DSH_HOME ?? path.join(HOME, '.dsh');
const DEFAULTS = {
  src: 'messages.json',
  out: 'out',
  cwd: process.cwd(),
  sessionsRoot: path.join(DSH_HOME, 'sessions'),
  provider: 'deepseek-official',
  // The share payload carries no model name (""); the conversation was produced
  // by the DeepSeek web app, so attribute it as such rather than to the local model.
  historyModel: 'deepseek-chat',
  // The model the session will continue with (matches the local profile default).
  nextModel: 'deepseek-flash',
  reasoningEffort: 'high',
  agentPreset: 'standard',
  permissionPreset: 'workspace-write',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'ask',
  title: undefined,
  eventsPerFrame: 16,
  includeReasoning: true,
  // 'auto'  = 从本机已有 DSH 会话里取一份真实系统提示词快照（默认，最像原生会话）
  // 'none'  = 不写系统消息（续聊时由 DSH 自己注入当前提示词）
  // <path>  = 用指定文件的内容作为系统提示词
  systemPrompt: 'auto',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'no-reasoning') { out.includeReasoning = false; continue; }
    // kebab-case CLI 名映射到 camelCase 配置键：--system-prompt / --sessions-root
    const camel = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    out[camel] = argv[++i];
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const cfg = {
  ...DEFAULTS,
  ...opts,
  includeReasoning: opts.includeReasoning === undefined ? DEFAULTS.includeReasoning : opts.includeReasoning,
};

/** DSH's projectKey(): mirror of dsh-session-persistence-jsonl for locating the session directory. */
function projectKey(cwd) {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** DSH's encodeSegment(): a Session id is already path-safe here, but stay faithful. */
function encodeSegment(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (const ch of raw) {
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Pull a real DSH system prompt (plus its source workspace) out of an existing local session. */
function findSystemPrompt() {
  let projects = [];
  try {
    projects = fs.readdirSync(cfg.sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('--') && e.name.endsWith('--'))
      .map((e) => path.join(cfg.sessionsRoot, e.name));
  } catch { return undefined; }
  const candidates = [];
  for (const project of projects) {
    let dirs = [];
    try { dirs = fs.readdirSync(project, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(project, e.name)); }
    catch { continue; }
    for (const dir of dirs) {
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      try { candidates.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* no v4 log */ }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of candidates.slice(0, 60)) {
    const rows = readJsonlFrames(file);
    const header = rows.find((row) => row?.type === 'session');
    for (const row of rows) {
      if (row?.type !== 'system/message') continue;
      const message = row.data?.message;
      const text = Array.isArray(message?.content)
        ? message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        : '';
      if (typeof text === 'string' && text.length > 0) return { text, cwd: header?.cwd };
    }
  }
  return undefined;
}

/** Read a DSH concatenated-frame JSONL log. */
function readJsonlFrames(file) {
  const buffer = fs.readFileSync(file);
  const starts = [0];
  for (let i = 1; i < buffer.length - 3; i++) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i);
  }
  const rows = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length;
    let text;
    try { text = zlib.zstdDecompressSync(buffer.subarray(starts[k], end)).toString('utf8'); }
    catch { continue; }
    for (const line of text.split('\n')) if (line.trim().length > 0) {
      try { rows.push(JSON.parse(line)); } catch { /* torn tail */ }
    }
  }
  return rows;
}

/** Resolve `[reference:N]` markers to markdown links using the extractor's citation map. */
function resolveCitations(text, citationMap) {
  if (typeof text !== 'string' || !Array.isArray(citationMap) || citationMap.length === 0) return text;
  const byMarker = new Map();
  for (const entry of citationMap) {
    if (entry && typeof entry.marker === 'string' && typeof entry.url === 'string') byMarker.set(entry.marker, entry.url);
  }
  return text.replace(/\[reference:(\d+)\]/g, (whole, n) => {
    const url = byMarker.get(`[reference:${n}]`) ?? byMarker.get(whole);
    return url === undefined ? whole : `[[${n}]](${url})`;
  });
}

function main() {
  const messages = JSON.parse(fs.readFileSync(cfg.src, 'utf8'));
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('source messages.json is empty');

  const sessionId = cfg.id ?? `session-${crypto.randomUUID()}`;
  const firstMs = Math.round(Number(messages[0].timestamp) * 1000);
  const createdAt = Number.isFinite(firstMs) ? firstMs : Date.now();

  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt,
    cwd: cfg.cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: cfg.agentPreset,
  };

  // 系统提示词快照。'auto' 时取自本机某个真实会话，并把里面写的工作目录改写成
  // 本会话的 cwd，使这条历史系统消息与 header 一致（纯本地读取，不联网）。
  const promptSource = cfg.systemPrompt === 'none' || cfg.systemPrompt === 'auto'
    ? findSystemPrompt()
    : { text: fs.readFileSync(cfg.systemPrompt, 'utf8'), cwd: undefined };
  const systemPrompt = cfg.systemPrompt === 'none' || promptSource === undefined
    ? undefined
    : promptSource.cwd === undefined || promptSource.cwd === cfg.cwd
      ? promptSource.text
      : promptSource.text.split(promptSource.cwd).join(cfg.cwd);
  const events = [];
  let seq = 0;
  let lastTime = createdAt - 1;
  const at = (ms) => {
    const value = Number.isFinite(ms) ? Math.round(ms) : lastTime + 1;
    lastTime = Math.max(lastTime + 1, value);
    return lastTime;
  };
  const push = (type, data, extra) => {
    const event = { type, seq: seq++, time: lastTime, data, ...(extra ?? {}) };
    events.push(event);
    return event;
  };

  push('permission/preset', { preset: cfg.permissionPreset });
  push('sandbox/mode', { mode: cfg.sandboxMode });
  push('approval/policy', { policy: cfg.approvalPolicy });
  push('model/selection', { provider: cfg.provider, model: cfg.nextModel, reasoningEffort: cfg.reasoningEffort });

  // Walk the transcript in order, pairing each human turn with the assistant reply that follows it.
  const turns = [];
  let pendingUser = undefined;
  for (const message of messages) {
    const role = String(message.role ?? '').toLowerCase();
    if (role === 'user') {
      if (pendingUser !== undefined) turns.push({ user: pendingUser, assistant: undefined });
      pendingUser = message;
    } else if (role === 'assistant') {
      turns.push({ user: pendingUser, assistant: message });
      pendingUser = undefined;
    }
  }
  if (pendingUser !== undefined) turns.push({ user: pendingUser, assistant: undefined });

  const firstUserText = String(turns[0]?.user?.content ?? '').replace(/\s+/g, ' ').trim();
  const title = cfg.title ?? (firstUserText.length > 0
    ? firstUserText.slice(0, 24)
    : '导入的 DeepSeek 分享对话');

  turns.forEach((turn, index) => {
    const turnNo = index + 1;
    const userMs = Number(turn.user?.timestamp) * 1000;
    const assistantMs = Number(turn.assistant?.timestamp) * 1000;
    at(userMs);
    push('turn/start', { turn: turnNo });
    push('step/start', { turn: turnNo, step: 1 });

    if (turnNo === 1 && systemPrompt !== undefined) {
      push('system/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'system',
          content: [{ type: 'text', text: systemPrompt }],
          source: { kind: 'system-prompt' },
          id: crypto.randomUUID(),
        },
      }, { surfaceOp: 'append' });
    }

    if (turn.user !== undefined) {
      const text = resolveCitations(String(turn.user.content ?? ''), turn.user.citation_map);
      push('user/message', {
        content: [{ type: 'text', text }],
        source: {
          kind: 'user',
          rpcId: crypto.randomUUID(),
          clientTimeZone: 'Asia/Hong_Kong',
        },
        role: 'user',
        id: crypto.randomUUID(),
      }, { surfaceOp: 'append' });
    }

    if (turnNo === 1) {
      push('request/header', {
        header: {
          config: {
            provider: cfg.provider,
            model: cfg.nextModel,
            reasoningEffort: cfg.reasoningEffort,
            maxTokens: 256000,
          },
          adapterDefaults: { maxTokens: true },
        },
        reason: 'initial',
      });
      push('request/context', {
        provider: cfg.provider,
        model: cfg.nextModel,
        contextWindow: 1000000,
        systemPromptUpdate: 'in-history',
      });
      const firstUserSeq = events.find((e) => e.type === 'user/message')?.seq;
      if (firstUserSeq !== undefined) {
        push('session/title', {
          title,
          messageSeqs: [firstUserSeq],
          source: { kind: 'fallback' },
        });
      }
    }

    if (turn.assistant !== undefined) {
      const text = resolveCitations(String(turn.assistant.content ?? ''), turn.assistant.citation_map);
      const blocks = [];
      const reasoning = cfg.includeReasoning ? String(turn.assistant.reasoning ?? '') : '';
      if (reasoning.length > 0) blocks.push({ type: 'reasoning', text: reasoning });
      blocks.push({ type: 'text', text });
      at(assistantMs);
      push('assistant/message', {
        turn: turnNo,
        step: 1,
        message: {
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: cfg.provider, model: cfg.historyModel },
          id: crypto.randomUUID(),
        },
        // Restored sessions require the settlement stream to be an array; the
        // imported reply was produced elsewhere, so no delta stream is replayed.
        stream: [],
      }, { surfaceOp: 'append' });
    }

    push('step/end', { turn: turnNo, step: 1 });
    push('turn/end', { turn: turnNo, reason: { kind: 'completed' } });
  });

  const headerLine = JSON.stringify(header) + '\n';
  const eventLines = events.map((e) => JSON.stringify(e) + '\n');
  const jsonl = headerLine + eventLines.join('');
  fs.mkdirSync(cfg.out, { recursive: true });
  fs.writeFileSync(path.join(cfg.out, 'session.jsonl'), jsonl);

  // DSH's concatenated-frame container requires the header to occupy its own
  // first frame (`assertZstdHeaderFrame` / `assertIndependentHeaderFrame`);
  // whole event lines follow in batches, each batch its own checksummed frame.
  const COMPRESS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
  const frames = [zlib.zstdCompressSync(headerLine, COMPRESS)];
  for (let i = 0; i < eventLines.length; i += cfg.eventsPerFrame) {
    frames.push(zlib.zstdCompressSync(eventLines.slice(i, i + cfg.eventsPerFrame).join(''), COMPRESS));
  }
  const compressed = Buffer.concat(frames);
  fs.writeFileSync(path.join(cfg.out, 'session.v4.jsonl.zstd'), compressed);

  const project = projectKey(cfg.cwd);
  const installDir = path.join(cfg.sessionsRoot, project, encodeSegment(sessionId));
  const manifest = {
    sessionId,
    title,
    systemPromptMode: cfg.systemPrompt,
    source: path.resolve(cfg.src),
    createdAt,
    cwd: cfg.cwd,
    header,
    eventCount: events.length,
    recordCount: events.length + 1,
    turns: turns.length,
    messages: messages.length,
    bytes: { jsonl: Buffer.byteLength(jsonl), zstd: compressed.length },
    systemPrompt: systemPrompt === undefined ? null : {
      chars: systemPrompt.length,
      sourceCwd: promptSource?.cwd ?? null,
      rebasedTo: cfg.cwd,
    },
    artifacts: {
      jsonl: path.join(cfg.out, 'session.jsonl'),
      zstd: path.join(cfg.out, 'session.v4.jsonl.zstd'),
    },
    install: {
      sessionsRoot: cfg.sessionsRoot,
      projectDir: project,
      sessionDir: installDir,
      targetFile: path.join(installDir, 'session.v4.jsonl.zstd'),
      lockFile: path.join(installDir, 'session.lock'),
    },
  };
  fs.writeFileSync(path.join(cfg.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(JSON.stringify({
    sessionId,
    out: cfg.out,
    events: events.length,
    turns: turns.length,
    zstdBytes: compressed.length,
    installTarget: manifest.install.targetFile,
    systemPromptChars: manifest.systemPrompt?.chars ?? null,
  }, null, 2));
}

main();
