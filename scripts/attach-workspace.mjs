#!/usr/bin/env node
/**
 * attach-workspace.mjs — 把导入的 DSH 会话挂到指定工作区，并让它立刻出现在侧边栏该分组下。
 *
 * 背景：DSH 的侧边栏分组只认 `workspace.json` 里工作区的 `sessionIds`，
 * 而该记录 + 「会话 id → 项目路径」内存索引都只在 `dsh web` 启动时建立，
 * 外部写文件/改 JSON 都会被运行中的服务覆盖 —— 所以唯一可靠的做法是
 * 调用**运行中服务自己的 API**：`workspace/create` + `session/create{workspaceId,sessionId}`。
 *
 * 认证：本地 web 服务用「持久化签名密钥 + 签名 cookie」鉴权。密钥保存在
 * `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session`，
 * 本脚本按服务端同一算法（browser-auth.ts）现场签一个 cookie 来调用它，
 * 等价于浏览器已登录的会话；不读取、不修改你的任何登录凭据之外的东西。
 *
 * Usage:
 *   node attach-workspace.mjs --manifest out/manifest.json [options]
 *
 * Options:
 *   --workspace <title|id|/abs/path>  目标工作区（默认：$DSH_IMPORT_WORKSPACE 或 <home>/dsh-web-conversations）
 *   --title <name>                    目标工作区不存在时/需要改标题时使用的名字
 *   --create-path </abs/path>         允许新建工作区目录（默认允许默认路径）
 *   --no-rebase                       会话 cwd 与工作区路径不一致时不自动重建
 *   --url <http://127.0.0.1:3080>     本地 DSH web 地址（默认 $DSH_WEB_URL）
 *   --dry-run                         只打印将要执行的动作（不做任何写入/挂载）
 *   --ensure-only                     只确保目标工作区存在（不碰会话）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const DEFAULT_WORKSPACE_TITLE = '网页对话提取';
/**
 * 默认工作区目录：优先 $DSH_IMPORT_WORKSPACE，否则 <home>/dsh-web-conversations。
 * 用 --create-path 或 --workspace /abs/path 可指定任意目录。
 */
function defaultWorkspacePath() {
  if (process.env.DSH_IMPORT_WORKSPACE) return process.env.DSH_IMPORT_WORKSPACE;
  return path.join(os.homedir(), 'dsh-web-conversations');
}

function parseArgs(argv) {
  const out = { rebase: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-rebase') { out.rebase = false; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--ensure-only') { out.ensureOnly = true; continue; }
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[++i];
  }
  return out;
}
const opts = parseArgs(process.argv.slice(2));
const MAN = opts.manifest ?? 'out/manifest.json';
const manifest = JSON.parse(fs.readFileSync(MAN, 'utf8'));
const sessionId = manifest.sessionId;

// ── 1. 本地服务端认证（与服务端 browser-auth.ts 同算法）────────────────────────
function readSecret() {
  const file = path.join(DSH_HOME, '.credentials.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const block = /client-connection\/browser-session:([\s\S]*?)(?=\n\S|\s*$)/.exec(text);
  if (block === null) throw new Error(`no client-connection/browser-session record in ${file}`);
  const secret = /secret:\s*([A-Za-z0-9_-]+)/.exec(block[1]);
  if (secret === null) throw new Error(`browser-session record has no secret in ${file}`);
  const raw = secret[1];
  return Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (raw.length % 4)) % 4), 'base64');
}

const base = opts.url ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080';
const authority = new URL(base).host;
const b64u = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const cookieName = `dsh-auth-${b64u(crypto.createHash('sha256').update(authority).digest())}`;
const issuedAt = Date.now();
const cookieValue = (() => {
  const body = b64u(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 86_400_000 }));
  const sig = b64u(crypto.createHmac('sha256', readSecret()).update(body).digest());
  return `v1.${body}.${sig}`;
})();

async function rpc(method, args) {
  let res;
  try {
    res = await fetch(new URL(`/api/${method}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${cookieName}=${cookieValue}`, accept: 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    });
  } catch (error) {
    throw new Error(`cannot reach the DSH web server at ${base} (${error.message}); start it with \`dsh web\` or pass --url`);
  }
  if (res.status === 401) throw new Error(`the DSH web server at ${base} rejected the local session credential (401)`);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${method}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (body?.result?.ok !== true) {
    const error = body?.result?.error;
    throw new Error(`${method} failed: ${error?.code ?? 'unknown'} ${error?.message ?? text.slice(0, 200)}`);
  }
  return body.result.value;
}

/**
 * 已被服务端「活取」的会话 id 集合。
 * 一旦会话被 dsh web 采用（打开过 / 用本工具挂载过），它的 header cwd 就被内存里的
 * 那份固定住了：改文件里的 cwd 也没用，`session/create` 会报 session/conflict。
 * 所以改挂之前必须先确认它还没被活取。
 */
async function liveSessionIds() {
  try {
    const list = await rpc('session/list', { _request: {} });
    return new Set((list.items ?? []).filter((item) => item.agentAvailable === true).map((item) => item.sessionId));
  } catch {
    return new Set();
  }
}

// ── 2. 解析工作区：标题 / id / 路径 ────────────────────────────────────────────
function workspacesFromStore() {
  const file = path.join(DSH_HOME, 'storages', 'workspace.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(doc.tables.workspaces).map(([workspaceId, record]) => ({
    workspaceId, path: record.path, title: record.title, sessionIds: record.sessionIds ?? [],
  }));
}

async function resolveWorkspace() {
  const wanted = opts.workspace;
  if (wanted === undefined) {
    return { path: opts['create-path'] ?? defaultWorkspacePath(), title: opts.title ?? DEFAULT_WORKSPACE_TITLE };
  }
  if (wanted.startsWith('/')) {
    return { path: wanted, title: opts.title ?? path.basename(wanted) };
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) {
    const found = workspacesFromStore().find((w) => w.workspaceId === wanted);
    if (found === undefined) throw new Error(`no workspace with id ${wanted}`);
    return { path: found.path, title: opts.title };
  }
  const found = workspacesFromStore().find((w) => w.title === wanted);
  if (found !== undefined) return { path: found.path, title: found.title };
  // 未登记过的标题：按 $DSH_IMPORT_WORKSPACE 的同级目录推断（可用 --create-path 覆盖）
  const created = path.join(path.dirname(defaultWorkspacePath()), wanted);
  return { path: opts['create-path'] ?? created, title: wanted };
}

const target = await resolveWorkspace();
const steps = [];
const sessionCwd = manifest.cwd;

// ── 3. cwd 不一致时按工作区路径重建（同一 session id）────────────────────────
let rebased = false;
if (opts.ensureOnly) {
  if (!fs.existsSync(target.path)) { fs.mkdirSync(target.path, { recursive: true }); console.log(`created directory ${target.path}`); }
  const ensured = await rpc('workspace/create', { request: { path: target.path } });
  if (target.title !== undefined && ensured.workspace.title !== target.title) {
    await rpc('workspace/rename', { request: { workspaceId: ensured.workspace.workspaceId, title: target.title } });
  }
  const view = (await rpc('workspace/create', { request: { path: target.path } })).workspace;
  console.log(JSON.stringify({ ensureOnly: true, workspace: view }, null, 2));
  console.log('ENSURE-OK');
  process.exit(0);
}
if (path.resolve(sessionCwd) !== path.resolve(target.path)) {
  if (!opts.rebase) {
    console.error(`session cwd ${sessionCwd} does not match workspace path ${target.path}; re-run without --no-rebase to rebuild it`);
    process.exit(2);
  }
  steps.push(`rebuild session with --cwd ${target.path}`);
  if (!opts.dryRun && (await liveSessionIds()).has(sessionId)) {
    console.error(
      `session ${sessionId} is already live in the running dsh web, so its cwd is pinned to ${sessionCwd}.\n` +
      `  restart \`dsh web\` and re-run to move it to ${target.path},\n` +
      `  or pass --workspace with the workspace it already belongs to.`,
    );
    process.exit(3);
  }
  if (!opts.dryRun) {
    execFileSync(process.execPath, [
      path.join(HERE, 'build-session.mjs'),
      '--src', opts.src ?? inferSource(manifest),
      '--out', path.dirname(MAN),
      '--cwd', target.path,
      '--id', sessionId,
      ...((opts.title ?? manifest.title) !== undefined ? ['--title', opts.title ?? manifest.title] : []),
    ], { stdio: 'inherit' });
    execFileSync('bash', [path.join(HERE, 'install-session.sh'), MAN], { stdio: 'inherit' });
    rebased = true;
  }
}

function inferSource(m) {
  if (typeof m.source === 'string' && fs.existsSync(m.source)) return m.source;
  // 老 manifest 没记源路径时，按约定的 out/../deepseek-share/messages.json 猜
  const guess = path.join(path.dirname(path.dirname(MAN)), 'deepseek-share', 'messages.json');
  if (fs.existsSync(guess)) return guess;
  if (fs.existsSync('messages.json')) return 'messages.json';
  throw new Error('cannot infer --src; pass --src <messages.json>');
}

steps.push(`ensure the artifact is installed (${path.basename(MAN)} -> $DSH_HOME/sessions)`);
steps.push(`ensure workspace over ${target.path}${target.title === undefined ? '' : ` titled ${target.title}`}`);
steps.push(`attach session ${sessionId} to that workspace`);

if (opts.dryRun) {
  console.log(JSON.stringify({ dryRun: true, sessionId, target, rebased, steps }, null, 2));
  process.exit(0);
}

// ── 4. 保证产物已安装 ────────────────────────────────────────────────────────
if (!rebased) execFileSync('bash', [path.join(HERE, 'install-session.sh'), MAN], { stdio: 'inherit' });

// ── 5. 建/取工作区 ───────────────────────────────────────────────────────────
if (!fs.existsSync(target.path)) {
  fs.mkdirSync(target.path, { recursive: true });
  console.log(`created directory ${target.path}`);
}
const created = await rpc('workspace/create', { request: { path: target.path } });
const workspaceId = created.workspace.workspaceId;
if (target.title !== undefined && created.workspace.title !== target.title) {
  await rpc('workspace/rename', { request: { workspaceId, title: target.title } });
}

// ── 6. 挂载 ─────────────────────────────────────────────────────────────────
let adopted;
try {
  adopted = await rpc('session/create', { request: { workspaceId, sessionId } });
} catch (error) {
  if (/session\/conflict/.test(String(error.message))) {
    console.error(
      `${error.message}\n` +
      `  the running dsh web still holds a live copy with the old cwd: restart \`dsh web\` and re-run.`,
    );
    process.exit(3);
  }
  throw error;
}

// ── 7. 校验：工作区里确实有它 ────────────────────────────────────────────────
const after = await rpc('workspace/create', { request: { path: target.path } });

console.log(JSON.stringify({
  sessionId,
  rebased,
  workspace: {
    workspaceId,
    title: after.workspace.title,
    path: after.workspace.path,
    created: created.created,
    sessionIds: after.workspace.sessionIds,
    attached: after.workspace.sessionIds.includes(sessionId),
  },
  agentPreset: adopted.agentPreset ?? null,
}, null, 2));

if (!after.workspace.sessionIds.includes(sessionId)) {
  console.error('attach verification failed: the workspace does not list the session');
  process.exit(1);
}
console.log('ATTACH-OK');
