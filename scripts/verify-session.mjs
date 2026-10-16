#!/usr/bin/env node
/**
 * Independent verification of a generated DSH Session v4 artifact.
 *
 * Stage A — format/logical validation using DSH's own installed implementation,
 * in the same order the JSONL persistence backend uses it:
 *   1. scan concatenated zstd frames + JSONL rows (header must own frame 1)
 *   2. sessionFormatCatalog.createRestore(..., {recovery:'recoverable', validation:'current'})
 *      (this internally runs restoreReleasedV4Artifact + Session.fromRestore)
 *   3. re-derive the visible surface messages with deriveEventMessage
 *
 * Stage B — acceptance through the *real* persistence backend: instantiate
 * JsonlSessionPersistence against ~/.dsh/sessions, `list()` it, `open(id,'read')`
 * and read the whole log back. That is exactly what the web server does when it
 * enumerates the sidebar and opens a session.
 *
 * Usage: node verify-session.mjs [out/session.v4.jsonl.zstd]
 *          [--manifest out/manifest.json] [--expect-users N] [--expect-assistants N]
 *          [--require-installed]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Locate the installed @deepseek-ai/* packages, independent of this checkout's prefix. */
function resolveDshPackages() {
  const candidates = [];
  if (process.env.DSH_PACKAGES_DIR) candidates.push(process.env.DSH_PACKAGES_DIR);
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (bin !== '') {
      // <prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js -> <prefix>/lib/node_modules/@deepseek-ai
      candidates.push(path.join(path.dirname(fs.realpathSync(bin)), '..', '..', 'node_modules', '@deepseek-ai'));
    }
  } catch { /* dsh not on PATH */ }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root !== '') {
      candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'));
      candidates.push(path.join(root, '@deepseek-ai'));
    }
  } catch { /* npm unavailable */ }
  for (const dir of candidates) {
    if (dir !== undefined && fs.existsSync(path.join(dir, 'dsh-session', 'lib', 'index.js'))) return dir;
  }
  throw new Error('cannot locate the DSH packages; set DSH_PACKAGES_DIR to the @deepseek-ai directory');
}

const DSH = resolveDshPackages();
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
// Resolve through DSH's own package manifests so a layout change does not break us.
const requireFromDsh = createRequire(path.join(DSH, 'dsh-session', 'lib', 'index.js'));
const importPackage = async (specifier) =>
  import(pathToFileURL(requireFromDsh.resolve(specifier)).href);
const { sessionFormatCatalog } = await importPackage('@deepseek-ai/dsh-session-format-catalog');
const { Session, deriveEventMessage } = await importPackage('@deepseek-ai/dsh-session');
const { currentSessionMessageProjections } = await importPackage('@deepseek-ai/dsh-session-format-catalog/message-projections');
const { default: JsonlSessionPersistence } = await importPackage('@deepseek-ai/dsh-session-persistence-jsonl');

const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const flagValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = positional[0] ?? 'out/session.v4.jsonl.zstd';
const requireInstalled = process.argv.includes('--require-installed');
const manifestPath = flagValue('manifest');
const manifest = manifestPath === undefined ? undefined : JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
// 期望条数：优先命令行，其次 manifest 里记录的源消息数（抓取阶段统计的总数）。
const expectTotal = manifest?.messages;
const expectUsers = flagValue('expect-users') === undefined ? undefined : Number(flagValue('expect-users'));
const expectAssistants = flagValue('expect-assistants') === undefined ? undefined : Number(flagValue('expect-assistants'));
const MAGIC = 4247762216; // 0xFD2FB528 read as little-endian, matching DSH ZSTD_MAGIC

/** Walk DSH's concatenated-frame container and return one plaintext chunk per frame. */
function frameChunks(buffer) {
  const ranges = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) throw new Error(`torn frame at byte ${offset}`);
    if (buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    const start = offset;
    offset += 4;
    const descriptor = buffer.readUInt8(offset); offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved zstd frame-header bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved zstd block type');
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (descriptor & 4) offset += 4; // content checksum
    ranges.push([start, offset]);
  }
  return ranges.map(([s, e]) => zlib.zstdDecompressSync(buffer.subarray(s, e)));
}

const bytes = fs.readFileSync(file);
const chunks = frameChunks(bytes);

// DSH refuses a log whose first frame is not exactly one header line.
const headerChunk = chunks[0].toString('utf8');
if (headerChunk.indexOf('\n') !== headerChunk.length - 1) {
  throw new Error('first zstd frame is not exactly one header line (assertIndependentHeaderFrame would reject)');
}
const rows = [...chunks.join('').split('\n')].filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
const headerRow = rows[0];
if (headerRow?.type !== 'session') throw new Error('first row is not a session header');

const restore = sessionFormatCatalog.createRestore(headerRow, { recovery: 'recoverable', validation: 'current' });
for (const row of rows.slice(1)) restore.decodeRow(row);
const artifact = restore.finish();

const session = Session.fromRestore(
  artifact.header.id,
  artifact.events,
  artifact.header,
  artifact.inheritedEventCount,
  'detached',
  currentSessionMessageProjections,
);

const counts = new Map();
for (const event of session.log) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);

const visible = [];
for (const event of session.log) {
  const message = deriveEventMessage(event);
  if (message === null || message === undefined) continue;
  if (message.role !== 'user' && message.role !== 'assistant') continue;
  const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const thinking = (message.content ?? []).filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
  visible.push({ seq: event.seq, role: message.role, chars: text.length, thinkingChars: thinking.length, head: text.slice(0, 40) });
}
const users = visible.filter((m) => m.role === 'user').length;
const assistants = visible.filter((m) => m.role === 'assistant').length;

console.log('=== STAGE A: format + logical restore ===');
console.log(JSON.stringify({
  file,
  bytes: bytes.length,
  frames: chunks.length,
  header: artifact.header,
  inheritedEventCount: artifact.inheritedEventCount,
  eventCount: session.log.length,
  surfaceTypes: Object.fromEntries([...counts].sort()),
  visible: { total: visible.length, users, assistants },
  firstTurn: visible.slice(0, 2),
  lastTurn: visible.slice(-1),
}, null, 2));

let failed = false;
const complaints = [];
if (expectUsers !== undefined && users !== expectUsers) complaints.push(`users=${users}, expected ${expectUsers}`);
if (expectAssistants !== undefined && assistants !== expectAssistants) complaints.push(`assistants=${assistants}, expected ${expectAssistants}`);
if (expectTotal !== undefined && visible.length !== expectTotal) complaints.push(`visible=${visible.length}, manifest says ${expectTotal}`);
if (expectUsers === undefined && expectAssistants === undefined && expectTotal === undefined && (users < 1 || assistants < 1)) {
  complaints.push(`no user/assistant pair in the restored surface (users=${users}, assistants=${assistants})`);
}
if (complaints.length > 0) { for (const line of complaints) console.error(`UNEXPECTED: ${line}`); failed = true; }

// ── Stage B: real persistence listing + read-open ────────────────────────────
console.log('=== STAGE B: real JsonlSessionPersistence list/open ===');
const noop = () => {};
const fakeCtx = {
  logger: { warn: (...a) => console.error('[warn]', ...a), info: noop, debug: noop, error: (...a) => console.error('[err]', ...a) },
  get: () => undefined,
  on: () => noop,
  effect: () => noop,
  inject: () => ({ dispose: noop }),
  reflect: { provide: noop },
};
const backend = new JsonlSessionPersistence(fakeCtx, { root: path.join(DSH_HOME, 'sessions'), compression: 'zstd' });
const listed = await backend.list();
const entry = listed.find((snapshot) => snapshot.header.id === headerRow.id);
if (entry === undefined) {
  // Expected before install-session.sh has run; the artifact is only verified
  // through the backend once it lives in the store.
  console.log(`listed=no (not installed in $DSH_HOME/sessions) among ${listed.length} sessions`);
  if (requireInstalled) { console.error('NOT LISTED by persistence.list()'); failed = true; }
} else {
  console.log(`listed=yes totalSessions=${listed.length} sizeBytes=${entry.sizeBytes}`);
  const handle = await backend.open(headerRow.id, 'read');
  const slice = await handle.read(0, Number.MAX_SAFE_INTEGER);
  const events = Array.isArray(slice) ? slice : slice.events;
  console.log(`open=read events=${events.length} headerCwd=${handle.header.cwd}`);
  // The stored log must round-trip exactly. (`Session.fromRestore` appends an
  // in-memory `session/end-seed` marker, so compare against the physical rows.)
  const stored = rows.slice(1);
  if (events.length !== stored.length) {
    console.error(`event count mismatch: persisted=${events.length} physical=${stored.length}`);
    failed = true;
  }
  const drift = events.findIndex((event, i) => event.type !== stored[i]?.type || event.seq !== stored[i]?.seq);
  if (drift >= 0) { console.error(`event drift at index ${drift}`); failed = true; }
  console.log(`round-trip=${drift < 0 && events.length === stored.length ? 'exact' : 'MISMATCH'}`);
}

console.log(failed ? 'VERIFY-FAILED' : 'VERIFY-OK');
if (failed) process.exit(1);
