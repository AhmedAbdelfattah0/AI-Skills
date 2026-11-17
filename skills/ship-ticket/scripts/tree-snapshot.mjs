#!/usr/bin/env node
/**
 * Main-tree tripwire (ASTF-15, S-03a): prove a reviewer lane left the checked-out tree untouched.
 *
 *   tree-snapshot.mjs snapshot --repo <path> [--lane <id>] [--out <file>]    start/end state record (JSON)
 *   tree-snapshot.mjs compare  --before <file> (--repo <path> | --after <file>)
 *
 * The orchestrator takes a snapshot before a reviewer lane starts and runs `compare --repo` after it. Wiring into the
 * lane lifecycle is S-03b; this slice is the stand-alone check. A snapshot records, from git and the filesystem and
 * never from anything the tree configures: HEAD (symbolic ref and sha), a hash of the ref set, a hash of the index
 * (stage entries and assume-unchanged/skip-worktree flags), a hash of the repository config, and for every tracked
 * and every untracked non-ignored path its kind, exec bit and the sha256 of its CONTENT (a symlink: of its target).
 * It does not hash `git status` text (a second edit to a dirty path leaves that text unchanged) and does not trust
 * mtime. Files are read raw (no autocrlf, textconv or filters); the exec bit is read with lstat (not core.fileMode).
 * Taking a snapshot never rewrites the index (GIT_OPTIONAL_LOCKS=0, read-only git commands).
 *
 * Result: unchanged | changed | unknown. `unknown` (an unreadable path or git failure) is a FAIL, never "unchanged".
 * Exit: 0 unchanged, 1 changed/unknown/failure, 2 usage.
 *
 * DETECTED-class, not a boundary: a same-user reviewer can also change what this check reads, or restore it.
 * Documented limits (also printed in every verdict): git-ignored files are not seen; the shared .git is only
 * covered by HEAD, refs, index and config (objects, hooks, reflogs, packed state are not); writes through an
 * absolute path to anywhere else are not seen; a nested repository or submodule is covered by its HEAD only;
 * where the OS has no exec bit (Windows) file modes are NOT compared (reported as `degraded`, never as equal).
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'tree-snapshot/1';
export const LIMITS = ['git-ignored files are not examined', 'shared .git is covered by HEAD, refs, index and config only', 'writes by absolute path outside this tree are not seen', 'nested repositories and submodules are covered by HEAD only', 'detected-class check, not an isolation boundary (same user)'];
const MAX_LISTED = 200;
const sha = (b) => createHash('sha256').update(b).digest('hex');
// Every inherited GIT_* variable removed (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*, GIT_REPLACE_REF_BASE ...); no
// replacement objects, literal pathspecs, no fsmonitor hook, no optional index-refresh lock.
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
const gitRaw = (cwd, args) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const zList = (buf) => buf.toString('latin1').split('\0').filter(Boolean).map((s) => Buffer.from(s, 'latin1'));
const pathKey = (raw) => { const p = raw.toString('utf8'); return Buffer.from(p, 'utf8').equals(raw) ? p : 'hex:' + raw.toString('hex'); };

function entryOf(top, raw, modeSupported) {
  const key = pathKey(raw);
  const abs = Buffer.concat([Buffer.from(top + sep), raw]);
  let st;
  try { st = lstatSync(abs); } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { p: key, k: 'missing' } : { p: key, k: 'unreadable' }; }
  try {
    if (st.isSymbolicLink()) return { p: key, k: 'symlink', h: sha(readlinkSync(abs, { encoding: 'buffer' })) };
    if (st.isDirectory()) { // submodule or nested repository: HEAD only (documented limit)
      let head = 'none'; try { head = gitRaw(abs.toString(), ['rev-parse', '--verify', '-q', 'HEAD']).toString().trim(); } catch { /* no commits or not a repo */ }
      return { p: key, k: 'repo', h: head };
    }
    if (!st.isFile()) return { p: key, k: 'other' };
    return { p: key, k: 'file', x: modeSupported ? (st.mode & 0o111) !== 0 : null, h: sha(readFileSync(abs)) };
  } catch { return { p: key, k: 'unreadable' }; }
}

/** Take a snapshot of the tree at `repo`. Throws when git cannot describe the repository (the caller treats that as a FAIL). */
export function takeSnapshot(repo, { lane = null, platform = process.platform } = {}) {
  const top = realpathSync.native(gitRaw(realpathSync.native(repo), ['rev-parse', '--show-toplevel']).toString().replace(/\n$/, ''));
  const modeSupported = platform !== 'win32';
  let headSha = null; try { headSha = gitRaw(top, ['rev-parse', '--verify', '-q', 'HEAD']).toString().trim(); } catch { /* unborn */ }
  let symref = null; try { symref = gitRaw(top, ['symbolic-ref', '-q', 'HEAD']).toString().trim(); } catch { /* detached */ }
  const refs = gitRaw(top, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']);
  const index = sha(Buffer.concat([gitRaw(top, ['ls-files', '-s', '-z']), Buffer.from('\0--flags--\0'), gitRaw(top, ['ls-files', '-v', '-z'])]));
  let config = 'absent';
  try { const cfgPath = resolve(top, gitRaw(top, ['rev-parse', '--git-path', 'config']).toString().replace(/\n$/, '')); config = sha(readFileSync(cfgPath)); } catch { /* no config file */ }
  const seen = new Set(); const raws = [];
  for (const r of [...zList(gitRaw(top, ['ls-files', '-z'])), ...zList(gitRaw(top, ['ls-files', '-z', '--others', '--exclude-standard']))]) {
    const t = r[r.length - 1] === 0x2f ? r.subarray(0, r.length - 1) : r; // nested repositories are listed with a trailing "/"
    const k = t.toString('hex'); if (!seen.has(k)) { seen.add(k); raws.push(t); }
  }
  raws.sort(Buffer.compare);
  const entries = raws.map((r) => entryOf(top, r, modeSupported));
  const body = { schema: SCHEMA, lane, top, mode_checked: modeSupported, head: { sha: headSha, symref }, refs: sha(refs), index, config, entries };
  return { ...body, identity: sha(JSON.stringify({ ...body, lane: null })) };
}

/** Compare two snapshots. `unchanged` only when nothing differs AND nothing was unreadable. */
export function compareSnapshots(before, after) {
  const base = { limits: LIMITS, lane: before?.lane ?? null, before_identity: before?.identity ?? null, after_identity: after?.identity ?? null };
  if (!before || !after || before.schema !== SCHEMA || after.schema !== SCHEMA || !Array.isArray(before.entries) || !Array.isArray(after.entries)) return { ...base, result: 'unknown', reason: 'snapshot missing or of an unknown schema', changed: [], degraded: [] };
  if (before.top !== after.top) return { ...base, result: 'unknown', reason: 'snapshots describe different repositories', changed: [], degraded: [] };
  const changed = []; const degraded = [];
  const flag = (what, ok) => { if (!ok) changed.push({ path: null, what }); };
  flag('head', before.head.sha === after.head.sha && before.head.symref === after.head.symref);
  flag('refs', before.refs === after.refs); flag('index', before.index === after.index); flag('config', before.config === after.config);
  const modes = before.mode_checked && after.mode_checked;
  if (!modes) degraded.push('file_mode_not_compared');
  const b = new Map(before.entries.map((e) => [e.p, e])); const a = new Map(after.entries.map((e) => [e.p, e]));
  let unknown = false;
  for (const p of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const x = b.get(p); const y = a.get(p);
    if ((x && x.k === 'unreadable') || (y && y.k === 'unreadable')) { unknown = true; changed.push({ path: p, what: 'unknown' }); continue; }
    if (!x || !y) { changed.push({ path: p, what: x ? 'removed' : 'added' }); continue; }
    if (x.k !== y.k) changed.push({ path: p, what: 'kind' });
    else if (x.h !== y.h) changed.push({ path: p, what: 'content' });
    else if (modes && x.x !== y.x) changed.push({ path: p, what: 'mode' });
  }
  const result = changed.some((c) => c.what !== 'unknown') ? 'changed' : unknown ? 'unknown' : 'unchanged';
  return { ...base, result, changed: changed.slice(0, MAX_LISTED), changed_count: changed.length, degraded };
}

function parseFlags(argv, allowed) {
  const f = {};
  for (let i = 0; i < argv.length; i += 2) { if (!argv[i].startsWith('--') || !allowed.includes(argv[i].slice(2)) || argv[i + 1] === undefined) return null; f[argv[i].slice(2)] = argv[i + 1]; }
  return f;
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

export function main(argv) {
  const [cmd, ...rest] = argv;
  const usage = () => { process.stderr.write('Usage: tree-snapshot.mjs snapshot --repo <path> [--lane <id>] [--out <file>] | compare --before <file> (--repo <path> | --after <file>)\n'); return 2; };
  try {
    if (cmd === 'snapshot') {
      const f = parseFlags(rest, ['repo', 'lane', 'out']);
      if (!f || !f.repo) return usage();
      const text = JSON.stringify(takeSnapshot(resolve(f.repo), { lane: f.lane ?? null })) + '\n';
      if (f.out) writeFileSync(f.out, text); else process.stdout.write(text);
      return 0;
    }
    if (cmd === 'compare') {
      const f = parseFlags(rest, ['before', 'repo', 'after']);
      if (!f || !f.before || (f.repo === undefined) === (f.after === undefined)) return usage();
      const before = readJson(f.before);
      const after = f.after ? readJson(f.after) : takeSnapshot(resolve(f.repo), { lane: before?.lane ?? null });
      const v = compareSnapshots(before, after);
      process.stdout.write(JSON.stringify(v) + '\n');
      return v.result === 'unchanged' ? 0 : 1;
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ result: 'unknown', reason: 'git or the filesystem could not describe the tree: ' + String(e.message).split('\n')[0], changed: [], limits: LIMITS }) + '\n');
    return 1;
  }
  return usage();
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
