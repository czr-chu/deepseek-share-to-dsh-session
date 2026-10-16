#!/usr/bin/env node
/**
 * fetch_share.mjs — 抓取 DeepSeek 网页版公开分享链接的完整对话
 *
 * 用法:
 *   node fetch-share.mjs <share_url_or_id> [--outdir DIR]
 *
 * 真实接口（无需登录 / 无需 token / 不需要 x-app-version 等自定义头）:
 *   GET https://chat.deepseek.com/api/v0/share/content?share_id=<SHARE_ID>
 *   Header: Accept: application/json
 *
 * 注意: /api/v0/chat/history_messages 需要 token（返回 40003 INVALID_TOKEN），
 *       /api/v0/chat/share_conversation 不存在。分享页真正用的是 /api/v0/share/content。
 *
 * 产物:
 *   raw.json          服务端返回的原始 JSON（逐字节原样保存，不丢字段）
 *   raw.pretty.json   同一份内容的缩进美化版（便于人工查看）
 *   messages.json     规范化数组 [{index, role, content, reasoning, searches, sources, ...}]
 *   preview.txt       人可读纯文本：可见对话正文，每条前加 "===== [n] role ====="
 *   preview_full.txt  同上，但附带 thinking / 搜索查询 / 引用来源
 *   meta.json         会话级元信息 + 抓取信息
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const API = 'https://chat.deepseek.com/api/v0/share/content';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------- CLI ----------
const argv = process.argv.slice(2);
let outdir = process.cwd();
let target;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--outdir') outdir = argv[++i];
  else if (argv[i] === '--help' || argv[i] === '-h') target = undefined, printUsage();
  else target = argv[i];
}
if (!target) printUsage();
function printUsage() {
  console.error('usage: node fetch-share.mjs <https://chat.deepseek.com/share/<id> | share_id> [--outdir DIR]');
  process.exit(2);
}
const shareId = /\/share\/([A-Za-z0-9_-]+)/.exec(target)?.[1] ?? target;
fs.mkdirSync(outdir, { recursive: true });

// ---------- fetch (node fetch first, curl fallback) ----------
const url = `${API}?share_id=${encodeURIComponent(shareId)}`;
let body;
try {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA, Referer: `https://chat.deepseek.com/share/${shareId}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  body = await res.text();
  console.error(`[fetch] node fetch OK (HTTP ${res.status}, ${body.length} bytes)`);
} catch (e) {
  console.error(`[fetch] node fetch failed (${e.message}); falling back to curl`);
  body = execFileSync(
    'curl',
    ['-sS', '--max-time', '60', '-H', 'Accept: application/json', '-H', `User-Agent: ${UA}`, url],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  console.error(`[fetch] curl OK (${body.length} bytes)`);
}

// raw.json = 服务端字节原样
fs.writeFileSync(path.join(outdir, 'raw.json'), body);

const payload = JSON.parse(body);
if (payload.code !== 0) throw new Error(`API code=${payload.code} msg=${payload.msg}`);
const biz = payload.data?.biz_data ?? {};
const rawMessages = biz.messages ?? [];

// 建立 fragment id -> fragment 索引，用于解析 [reference:N]
const fragById = new Map();
for (const m of rawMessages) for (const f of m.fragments ?? []) fragById.set(f.id, f);

const fragText = (m, type) =>
  (m.fragments ?? [])
    .filter((f) => f.type === type && typeof f.content === 'string' && f.content.trim())
    .map((f) => f.content)
    .join('\n\n');

const messages = rawMessages.map((m, i) => {
  const role = String(m.role || '').toLowerCase() === 'user' ? 'user' : 'assistant';
  const content = role === 'user' ? fragText(m, 'REQUEST') : fragText(m, 'RESPONSE');
  const reasoning = fragText(m, 'THINK');

  // 网页搜索片段
  const searches = (m.fragments ?? [])
    .filter((f) => f.type === 'TOOL_SEARCH')
    .map((f) => ({
      content: f.content ?? '',
      queries: (f.queries ?? []).map((q) => q.query ?? q),
      results: (f.results ?? []).map((r) => ({
        url: r.url, title: r.title, snippet: r.snippet,
        site_name: r.site_name ?? null, published_at: r.published_at ?? null,
      })),
    }));

  // 打开的网页（引用来源）
  const sources = (m.fragments ?? [])
    .filter((f) => f.type === 'TOOL_OPEN' && f.result)
    .map((f) => ({
      fragment_id: f.id, url: f.result.url, title: f.result.title,
      snippet: f.result.snippet, site_name: f.result.site_name ?? null,
      published_at: f.result.published_at ?? null,
    }));

  // 解析正文里的 [reference:N] 标记 -> 真实来源
  const citationMap = [];
  for (const f of (m.fragments ?? []).filter((x) => x.type === 'RESPONSE')) {
    for (const [n, ref] of (f.references ?? []).entries()) {
      const src = fragById.get(ref.id);
      if (!src) continue;
      const r = src.result ?? null;
      citationMap[n] = {
        marker: `[reference:${n}]`, ref_type: ref.type, fragment_id: ref.id,
        url: r?.url ?? null, title: r?.title ?? null, snippet: r?.snippet ?? null,
      };
    }
  }

  const tips = (m.fragments ?? [])
    .filter((f) => f.type === 'TIP')
    .map((f) => ({ content: f.content, style: f.style ?? null }));

  return {
    index: i,
    message_id: m.message_id,
    parent_id: m.parent_id ?? null,
    role,
    content,
    reasoning: reasoning || null,
    timestamp: m.inserted_at ?? null,
    timestamp_iso: m.inserted_at ? new Date(m.inserted_at * 1000).toISOString() : null,
    model: m.model ?? null,
    status: m.status ?? null,
    conversation_mode: m.conversation_mode ?? null,
    thinking_enabled: m.thinking_enabled ?? null,
    search_enabled: m.search_enabled ?? null,
    accumulated_token_usage: m.accumulated_token_usage ?? null,
    incomplete_message: m.incomplete_message ?? null,
    searches,
    sources,
    citation_map: citationMap,
    tips,
    fragment_types: (m.fragments ?? []).map((f) => f.type),
    fragments: m.fragments ?? [], // 原样保留全部片段（含 THINK/TOOL_*/TIP 的完整字段）
  };
});

fs.writeFileSync(path.join(outdir, 'messages.json'), JSON.stringify(messages, null, 2));
fs.writeFileSync(path.join(outdir, 'raw.pretty.json'), JSON.stringify(payload, null, 2));

const line = '='.repeat(60);
const head = (m) => `===== [${m.index}] ${m.role} =====`;
let preview = '';
let full = '';
for (const m of messages) {
  preview += `${head(m)}\n${m.content}\n\n`;
  full += `${head(m)}\n`;
  if (m.timestamp_iso) full += `# ${m.timestamp_iso}  mode=${m.conversation_mode ?? '-'} tokens=${m.accumulated_token_usage ?? '-'}\n`;
  full += `${m.content}\n`;
  if (m.reasoning) full += `\n--- [${m.index}] reasoning ---\n${m.reasoning}\n`;
  if (m.searches.length) {
    full += `\n--- [${m.index}] web searches ---\n`;
    for (const s of m.searches) {
      full += `queries: ${s.queries.join(' | ')}\nresults: ${s.results.length}\n`;
      for (const r of s.results) full += `  - ${r.title ?? ''} ${r.url ?? ''}\n`;
    }
  }
  if (m.sources.length) {
    full += `\n--- [${m.index}] opened sources (${m.sources.length}) ---\n`;
    for (const s of m.sources) full += `  - ${s.title ?? ''} ${s.url ?? ''}\n`;
  }
  full += '\n';
}
fs.writeFileSync(path.join(outdir, 'preview.txt'), preview);
fs.writeFileSync(path.join(outdir, 'preview_full.txt'), full);

const ts = messages.map((m) => m.timestamp).filter(Boolean);
const meta = {
  source_url: `https://chat.deepseek.com/share/${shareId}`,
  share_id: shareId,
  api_endpoint: url,
  api_requires_auth: false,
  fetched_at: new Date().toISOString(),
  title: biz.title ?? null,
  model_type: biz.model_type ?? null,
  message_count: messages.length,
  role_counts: messages.reduce((a, m) => ((a[m.role] = (a[m.role] ?? 0) + 1), a), {}),
  message_ids_sequential: messages.every((m, i) => m.message_id === i + 1),
  first_role: messages[0]?.role ?? null,
  last_role: messages.at(-1)?.role ?? null,
  all_status_finished: messages.every((m) => m.status === 'FINISHED'),
  any_incomplete: messages.some((m) => m.incomplete_message),
  conversation_started: ts.length ? new Date(Math.min(...ts) * 1000).toISOString() : null,
  conversation_ended: ts.length ? new Date(Math.max(...ts) * 1000).toISOString() : null,
  models: [...new Set(messages.map((m) => m.model))],
  conversation_modes: [...new Set(messages.map((m) => m.conversation_mode).filter(Boolean))],
  raw_bytes: body.length,
  message_keys: [...new Set(messages.flatMap((m) => Object.keys(m.fragments[0] ?? {})))],
  raw_message_fields: [...new Set(rawMessages.flatMap((m) => Object.keys(m)))],
  raw_fragment_fields: [...new Set(rawMessages.flatMap((m) => (m.fragments ?? []).flatMap((f) => Object.keys(f))))],
  fragment_type_counts: rawMessages
    .flatMap((m) => m.fragments ?? [])
    .reduce((a, f) => ((a[f.type] = (a[f.type] ?? 0) + 1), a), {}),
};
fs.writeFileSync(path.join(outdir, 'meta.json'), JSON.stringify(meta, null, 2));

console.error(`${line}\n[fetch_share] share_id=${shareId} messages=${messages.length} -> ${outdir}`);
console.error(JSON.stringify(meta.role_counts), 'fragments:', JSON.stringify(meta.fragment_type_counts));
console.log(
  messages
    .slice(0, 30)
    .map((m) => `[${m.index}] ${m.role}: ${(m.content.split('\n')[0] || '').slice(0, 70)}`)
    .join('\n')
);
