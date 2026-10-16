#!/usr/bin/env node
/**
 * Register the generated Session in its workspace's durable `sessionIds` account.
 *
 * A session created outside the Web GUI is never attached automatically: the
 * workspace registry only rebuilds its session-path index at startup, and only
 * sessions present in `sessionIds` are grouped. Writing the id here (plus a
 * `dsh web` restart, which rebuilds the index) makes the GUI list the session
 * under the workspace named by the manifest's `cwd`.
 *
 * Idempotent. Usage: node register-workspace.mjs [--manifest out/manifest.json] [--remove]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const remove = args.includes('--remove');

const MAN = argOf('manifest', 'out/manifest.json');
const manifest = JSON.parse(fs.readFileSync(MAN, 'utf8'));
const sessionId = manifest.sessionId;
const cwd = manifest.cwd;
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const STORE = path.join(DSH_HOME, 'storages', 'workspace.json');

const raw = fs.readFileSync(STORE, 'utf8');
const doc = JSON.parse(raw);
const table = doc?.tables?.workspaces;
if (table === undefined) throw new Error(`${STORE} has no tables.workspaces`);

const target = Object.entries(table).find(([, record]) => record.path === cwd);
if (target === undefined) throw new Error(`no registered workspace with path ${cwd}`);

const [targetId, targetRecord] = target;
let changed = false;

for (const [id, record] of Object.entries(table)) {
  const has = record.sessionIds.includes(sessionId);
  if (id === targetId) {
    if (remove && has) {
      record.sessionIds = record.sessionIds.filter((entry) => entry !== sessionId);
      record.updatedAt = new Date().toISOString();
      changed = true;
    } else if (!remove && !has) {
      record.sessionIds = [sessionId, ...record.sessionIds];
      record.updatedAt = new Date().toISOString();
      changed = true;
    }
  } else if (has) {
    // A session lives in exactly one workspace account.
    record.sessionIds = record.sessionIds.filter((entry) => entry !== sessionId);
    record.updatedAt = new Date().toISOString();
    changed = true;
  }
}

if (changed) {
  const tmp = `${STORE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, STORE);
}

console.log(JSON.stringify({
  store: STORE,
  sessionId,
  workspacePath: cwd,
  workspaceId: targetId,
  action: remove ? 'detach' : 'attach',
  changed,
  sessionIds: table[targetId].sessionIds,
}, null, 2));
