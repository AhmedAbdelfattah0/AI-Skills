#!/usr/bin/env node
/**
 * Main-tree tripwire (ASTF-15, S-03a): prove a reviewer lane left the checked-out tree untouched.
 *
 *   tree-snapshot.mjs snapshot --repo <path> [--lane <id>] [--out <file>]    start/end state record (JSON)
 *   tree-snapshot.mjs compare  --before <file> (--repo <path> | --after <file>)
 *
 * INVARIANT: for every difference of the working tree that git itself would see, or that changes what is
 * enumerated, the snapshot either HASHES it (=> `changed`) or the result is `unknown`. It can never be `unchanged`.
 * (tree-snapshot.test.mjs checks this generically against an independent observation, plus one test per sibling.)
 *
 * The orchestrator takes a snapshot before a reviewer lane starts and runs `compare --repo` after it. Wiring into the
 * lane lifecycle is S-03b; this slice is the stand-alone check. `--out` must live OUTSIDE the checked tree (and its
 * git dir): a path resolving inside is refused, so the tool can neither modify the tree it checks nor make it `changed`.
 * A snapshot records, from git and the filesystem and never from anything the tree configures: HEAD (symbolic ref
 * and sha), the index (stage entries, assume-unchanged/skip-worktree flags, intent-to-add),
 * the ignore rules (info/exclude, core.excludesFile resolved against the tree top, every .gitignore seen) and the hooks
 * directory (content, owner exec bit, subdirectories, symlink targets), and for every path of the tree (tracked, untracked, and any directory entry git does not list) its
 * kind, OWNER exec bit (git's rule: group/other bits are invisible to git and are not compared) and the sha256 of its
 * CONTENT (a symlink: of its target). Path keys are the hex of the raw path bytes. It does not hash `git status` text
 * and does not trust mtime. Files are read raw (no autocrlf, textconv or filters). Taking a snapshot never rewrites
 * the index (GIT_OPTIONAL_LOCKS=0, read-only git commands). A git warning on a listing is a failure, not a pass.
 *
 * SHARED git state (every other ref, tags, remote-tracking refs, the common config) is moved by sibling worktrees, fetches and
 * maintenance, so it is stored by ref name and reported separately as `shared_git` (ref names whose sha moved, config changed);
 * it never changes the tree verdict or exit code unless `compare --strict-shared`. HEAD and its symref DO decide.
 * `--out` is written only as a NEW file (exclusive temp file, linked into place); an existing path is refused.
 *
 * Result: unchanged | changed | unknown. `unknown` (an unreadable path or directory, a git failure, an invalid
 * record) is a FAIL, never "unchanged". Exit: 0 unchanged, 1 changed/unknown/failure, 2 usage.
 *
 * DETECTED-class, not a boundary: a same-user reviewer can also change what this check reads, or restore it.
 * Documented limits (also printed in every verdict): the CONTENT of git-ignored files is not examined (a lane can
 * make a file ignored, which the ignore-rule hashes catch, but not edits to an already-ignored file); the shared .git
 * is covered by HEAD, refs, index, config, hooks and exclude only (objects, reflogs, other config files are not);
 * writes by absolute path outside this tree are not seen; a nested repository or submodule is covered by the HEAD
 * its own directory reports (files inside are not); a process the lane leaves running can write after the compare;
 * where the OS has no exec bit (Windows) file modes are NOT compared (reported as `degraded`, never as equal).
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, linkSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'tree-snapshot/1';
export const LIMITS = [
  'the content of git-ignored files is not examined (the ignore rules themselves are hashed)',
  'shared .git state (other refs, tags, common config) is reported as shared_git and does not decide the verdict unless --strict-shared; objects, reflogs and other config files are not examined',
  'writes by absolute path outside this tree are not seen',
  'nested repositories and submodules are covered by the HEAD their directory reports; files inside are not',
  'only the owner exec bit is compared (git ignores group/other bits); not compared at all where the OS has none',
  'point-in-time: a process the lane leaves running can write after the compare',
  'detected-class check, not an isolation boundary (same user)',
];
const MAX_LISTED = 200;
const KINDS = ['file', 'symlink', 'repo', 'dir', 'missing', 'unreadable', 'other', 'emptydir'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const caseFold = process.platform === 'win32' || process.platform === 'darwin';
// Every inherited GIT_* variable removed (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*, GIT_REPLACE_REF_BASE ...); no
// replacement objects, literal pathspecs, no fsmonitor hook, no optional index-refresh lock.
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
/** Run git; a non-zero exit throws; with `strict`, ANY stderr output (a warning such as "could not open directory") throws too. */
function gitRaw(cwd, args, strict = false) {
  const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  if (strict && r.stderr.length > 0) throw new Error(`git ${args[0]} warned: ${r.stderr.toString().split('\n')[0]}`);
  return r.stdout;
}
const text = (b) => b.toString().replace(/\n$/, '');
const zList = (buf) => buf.toString('latin1').split('\0').filter(Boolean).map((x) => Buffer.from(x, 'latin1'));
const hexOf = (raw) => raw.toString('hex');
const sub = (parent, name) => (parent.length ? Buffer.concat([parent, Buffer.from('/'), name]) : name);
/** A path usable with fs: a string when it round-trips through UTF-8 (so Windows namespacing applies), else the raw Buffer. */
const absOf = (top, raw) => { const s = raw.toString('utf8'); return Buffer.from(s, 'utf8').equals(raw) ? top + sep + s : Buffer.concat([Buffer.from(top + sep), raw]); };
/** sha256 of a file read in 1 MiB chunks (no whole-file Buffer, so no 2 GiB ceiling). */
function hashFile(path) {
  const h = createHash('sha256'); const fd = openSync(path, 'r'); const buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest('hex');
}
const fileSha = (path) => { try { return hashFile(path); } catch (e) { if (e.code === 'ENOENT') return 'absent'; throw e; } };
const hasDotGit = (abs) => { try { lstatSync(join(abs.toString(), '.git')); return true; } catch { return false; } };
/** Digest of a directory tree (git's hooks): relative path, kind, owner exec bit, and content (symlink: target); subdirectories enumerated. */
function dirDigest(dir, modeSupported) {
  const rows = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name); const r = rel ? rel + '/' + name : name; const st = lstatSync(full);
      if (st.isSymbolicLink()) rows.push([r, 'l', readlinkSync(full)]);
      else if (st.isDirectory()) { rows.push([r, 'd']); visit(full, r); }
      else if (st.isFile()) rows.push([r, 'f', modeSupported ? (st.mode & 0o100) !== 0 : null, hashFile(full)]);
      else rows.push([r, 'o']);
    }
  };
  try { visit(dir, ''); } catch (e) { if (e.code === 'ENOENT' && rows.length === 0) return 'absent'; throw e; }
  return sha(JSON.stringify(rows));
}

function entryOf(top, raw, modeSupported) {
  const base = { p: hexOf(raw), n: raw.toString('utf8') };
  const abs = absOf(top, raw);
  let st;
  try { st = lstatSync(abs); } catch (e) { return { ...base, k: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable' }; }
  try {
    if (st.isSymbolicLink()) return { ...base, k: 'symlink', h: sha(readlinkSync(abs, { encoding: 'buffer' })) };
    if (st.isDirectory()) {
      if (!hasDotGit(abs)) return { ...base, k: 'dir' }; // an ordinary directory (even one where git expects a file): enumerated by the walk
      let head = 'none'; try { head = text(gitRaw(abs.toString(), ['rev-parse', '--verify', '-q', 'HEAD'])); } catch { /* no commits */ } // nested repository / submodule: HEAD only (documented limit)
      return { ...base, k: 'repo', h: head };
    }
    if (!st.isFile()) return { ...base, k: 'other' };
    return { ...base, k: 'file', x: modeSupported ? (st.mode & 0o100) !== 0 : null, h: hashFile(abs) };
  } catch { return { ...base, k: 'unreadable' }; }
}

/**
 * Directory entries git does not list: anything on disk that is not tracked, not listed untracked and not ignored
 * (an unreadable or empty directory, a case-alias spelling) becomes an entry, so git's blind spots are hashed or unknown.
 */
function walk(top, rel, ctx, out) {
  let names;
  try { names = readdirSync(rel.length ? absOf(top, rel) : top, { encoding: 'buffer' }); } catch { out.push({ p: hexOf(rel), n: rel.toString('utf8'), k: 'unreadable' }); return; }
  if (names.length === 0 && rel.length && !ctx.known.has(hexOf(rel))) out.push({ p: hexOf(rel), n: rel.toString('utf8'), k: 'emptydir' });
  for (const name of names) {
    if (!rel.length && name.equals(Buffer.from('.git'))) continue;
    const raw = sub(rel, name); const key = hexOf(raw);
    let st; try { st = lstatSync(absOf(top, raw)); } catch { out.push({ p: key, n: raw.toString('utf8'), k: 'unreadable' }); continue; }
    if (st.isDirectory()) { if (!ctx.ignoredDirs.has(key) && !hasDotGit(absOf(top, raw))) walk(top, raw, ctx, out); } // every directory, whatever git knows about the path; nested repositories are HEAD-only
    else if (!ctx.known.has(key) && !ctx.ignoredFiles.has(key)) out.push(entryOf(top, raw, ctx.modeSupported));
  }
}

const bodyOf = (s) => ({ schema: s.schema, lane: null, top: s.top, mode_checked: s.mode_checked, head: s.head, refs: s.refs, index: s.index, config: s.config, excludes: s.excludes, hooks: s.hooks, entries: s.entries });
const REAL = (p) => realpathSync.native(p);

/** The real top level and git directories of `repo` (what `--out` must stay out of). Throws when git cannot say. */
export function treeRoots(repo) {
  const top = REAL(text(gitRaw(REAL(repo), ['rev-parse', '--show-toplevel'])));
  const gd = (flag) => REAL(resolve(top, text(gitRaw(top, ['rev-parse', flag]))));
  return { top, roots: [top, gd('--absolute-git-dir'), gd('--git-common-dir')] };
}
/** Real path of `p`: every existing component resolved through symlinks (a dangling link followed to its target); the missing remainder appended. */
export function realOutPath(p) {
  let cur = resolve(p); const rest = [];
  for (let guard = 0; guard < 64; guard++) {
    try { const r = REAL(cur); return rest.length ? join(r, ...rest.reverse()) : r; } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    let link = null; try { if (lstatSync(cur).isSymbolicLink()) link = resolve(dirname(cur), readlinkSync(cur)); } catch { /* not a link */ }
    if (link) { cur = link; continue; }
    const parent = dirname(cur); if (parent === cur) throw new Error('no existing ancestor');
    rest.push(basename(cur)); cur = parent;
  }
  throw new Error('too many symbolic links');
}
export function isInside(p, roots) {
  const f = (x) => (caseFold ? x.toLowerCase() : x);
  return roots.some((r) => f(p) === f(r) || f(p).startsWith(f(r) + sep));
}

/** Take a snapshot of the tree at `repo`. Throws when git cannot describe the repository (the caller treats that as a FAIL). */
export function takeSnapshot(repo, { lane = null, platform = process.platform } = {}) {
  const { top } = treeRoots(repo);
  const modeSupported = platform !== 'win32';
  let headSha = null; try { headSha = text(gitRaw(top, ['rev-parse', '--verify', '-q', 'HEAD'])); } catch { /* unborn */ }
  let symref = null; try { symref = text(gitRaw(top, ['symbolic-ref', '-q', 'HEAD'])); } catch { /* detached */ }
  const refs = text(gitRaw(top, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)'], true)).split('\n').filter(Boolean).sort(); // shared state: reported by name, never decides the tree verdict
  // The index: stage entries, assume-unchanged/skip-worktree flags, and the in-memory flags (intent-to-add, stage, valid, skip-worktree).
  const flags = [...gitRaw(top, ['ls-files', '--debug'], true).toString().matchAll(/^\s+size: -?\d+\tflags: ([0-9a-f]+)$/gm)].map((m) => ((parseInt(m[1], 16) & 0x6000b000) >>> 0).toString(16));
  const index = sha(Buffer.concat([gitRaw(top, ['ls-files', '-s', '-z'], true), Buffer.from('\0--flags--\0'), gitRaw(top, ['ls-files', '-v', '-z'], true), Buffer.from('\0--debug--\0' + flags.join(','))]));
  const gitPath = (name) => resolve(top, text(gitRaw(top, ['rev-parse', '--git-path', name])));
  const config = fileSha(gitPath('config'));
  let configured = null; try { configured = text(gitRaw(top, ['config', '--path', '--get', 'core.excludesFile'])); } catch { /* unset */ }
  // git resolves a relative core.excludesFile against the work tree top (never the caller's cwd); a configured file we cannot read is unknown, not absent
  const excludesFile = configured ? resolve(top, configured) : join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.config'), 'git', 'ignore');
  const excludesSha = configured ? hashFile(excludesFile) : fileSha(excludesFile);
  const hooks = dirDigest(gitPath('hooks'), modeSupported);
  const tracked = zList(gitRaw(top, ['ls-files', '-z'], true));
  const untracked = zList(gitRaw(top, ['ls-files', '-z', '--others', '--exclude-standard'], true));
  const ignored = zList(gitRaw(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], true));
  const strip = (r) => (r[r.length - 1] === 0x2f ? r.subarray(0, r.length - 1) : r); // nested repositories and ignored directories carry a trailing "/"
  const ctx = { known: new Set(), ignoredDirs: new Set(), ignoredFiles: new Set(), modeSupported };
  const byKey = new Map();
  for (const r of [...tracked, ...untracked]) { const t = strip(r); ctx.known.add(hexOf(t)); if (!byKey.has(hexOf(t))) byKey.set(hexOf(t), entryOf(top, t, modeSupported)); }
  for (const r of ignored) {
    const t = strip(r); (t !== r ? ctx.ignoredDirs : ctx.ignoredFiles).add(hexOf(t));
    if (t === r && (t.equals(Buffer.from('.gitignore')) || t.subarray(Math.max(0, t.length - 11)).equals(Buffer.from('/.gitignore')))) byKey.set(hexOf(t), entryOf(top, t, modeSupported)); // an ignored ignore-file still defines "ignored"
  }
  const extra = []; walk(top, Buffer.alloc(0), ctx, extra);
  for (const e of extra) if (!byKey.has(e.p)) byKey.set(e.p, e);
  const entries = [...byKey.values()].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const excludes = sha(JSON.stringify([fileSha(gitPath('info/exclude')), excludesSha]));
  const rec = { schema: SCHEMA, lane, top, mode_checked: modeSupported, head: { sha: headSha, symref }, refs, index, config, excludes, hooks, entries };
  return { ...rec, identity: sha(JSON.stringify(bodyOf(rec))) };
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Why a record is not a well-formed snapshot (the reason), or null. A record that fails is `unknown`, never equal to anything. */
export function validateSnapshot(s) {
  const bad = (why) => why;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return bad('not an object');
  if (s.schema !== SCHEMA) return bad('unknown schema');
  if (s.lane !== null && typeof s.lane !== 'string') return bad('lane');
  if (typeof s.top !== 'string' || !s.top) return bad('top');
  if (typeof s.mode_checked !== 'boolean') return bad('mode_checked');
  const h = s.head;
  if (!h || typeof h !== 'object' || !(h.sha === null || /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(h.sha)) || !(h.symref === null || typeof h.symref === 'string')) return bad('head');
  if (!Array.isArray(s.refs) || !s.refs.every((r) => typeof r === 'string' && /^\S+ [0-9a-f]{40,64}( \S*)?$/.test(r))) return bad('refs');
  for (const k of ['index', 'excludes', 'identity']) if (typeof s[k] !== 'string' || !HEX64.test(s[k])) return bad(k);
  for (const k of ['config', 'hooks']) if (typeof s[k] !== 'string' || !(s[k] === 'absent' || HEX64.test(s[k]))) return bad(k);
  if (!Array.isArray(s.entries)) return bad('entries');
  let prev = null;
  for (const e of s.entries) {
    if (!e || typeof e !== 'object' || typeof e.p !== 'string' || !/^([0-9a-f]{2})+$/.test(e.p) || typeof e.n !== 'string' || !KINDS.includes(e.k)) return bad('entry shape');
    if (prev !== null && !(prev < e.p)) return bad('entries unordered or duplicated');
    prev = e.p;
    const needsHash = e.k === 'file' || e.k === 'symlink';
    if (needsHash && !(typeof e.h === 'string' && HEX64.test(e.h))) return bad('entry hash');
    if (e.k === 'repo' && !(typeof e.h === 'string' && /^(none|[0-9a-f]{40}|[0-9a-f]{64})$/.test(e.h))) return bad('entry head');
    if (!needsHash && e.k !== 'repo' && e.h !== undefined) return bad('entry hash on a hashless kind');
    if (e.k === 'file' ? !(s.mode_checked ? typeof e.x === 'boolean' : e.x === null) : e.x !== undefined) return bad('entry mode');
  }
  if (sha(JSON.stringify(bodyOf(s))) !== s.identity) return bad('identity does not match the record');
  return null;
}

/** Compare two snapshots. `unchanged` only when nothing differs AND nothing was unreadable AND both records are valid. */
export function compareSnapshots(before, after, { strictShared = false } = {}) {
  const base = { limits: LIMITS, lane: before?.lane ?? null, before_identity: before?.identity ?? null, after_identity: after?.identity ?? null };
  const invalid = validateSnapshot(before) ? 'before: ' + validateSnapshot(before) : validateSnapshot(after) ? 'after: ' + validateSnapshot(after) : null;
  if (invalid) return { ...base, result: 'unknown', reason: 'invalid snapshot record (' + invalid + ')', changed: [], degraded: [] };
  if (before.top !== after.top) return { ...base, result: 'unknown', reason: 'snapshots describe different repositories', changed: [], degraded: [] };
  const changed = []; const degraded = [];
  const flag = (what, ok) => { if (!ok) changed.push({ path: null, what }); };
  flag('head', before.head.sha === after.head.sha && before.head.symref === after.head.symref);
  for (const k of ['index', 'excludes', 'hooks']) flag(k, before[k] === after[k]);
  // Shared state (every other ref, tags, remote-tracking refs, the common config) moves with sibling worktrees, IDE fetches and maintenance:
  // reported separately and NOT part of the tree verdict unless strictShared.
  const refMap = (snap) => new Map(snap.refs.map((r) => [r.split(' ')[0], r]));
  const rb = refMap(before); const ra = refMap(after); const sharedRefs = [];
  for (const name of [...new Set([...rb.keys(), ...ra.keys()])].sort()) if (rb.get(name) !== ra.get(name)) sharedRefs.push({ ref: name, before: rb.get(name)?.split(' ')[1] ?? null, after: ra.get(name)?.split(' ')[1] ?? null });
  const shared_git = { result: sharedRefs.length || before.config !== after.config ? 'changed' : 'unchanged', refs: sharedRefs.slice(0, MAX_LISTED), config: before.config !== after.config };
  const modes = before.mode_checked && after.mode_checked;
  if (!modes) degraded.push('file_mode_not_compared');
  const b = new Map(before.entries.map((e) => [e.p, e])); const a = new Map(after.entries.map((e) => [e.p, e]));
  let unknown = false;
  for (const p of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const x = b.get(p); const y = a.get(p); const n = (y || x).n;
    if ((x && x.k === 'unreadable') || (y && y.k === 'unreadable')) { unknown = true; changed.push({ path: n, what: 'unknown' }); continue; }
    if (!x || !y) { changed.push({ path: n, what: x ? 'removed' : 'added' }); continue; }
    if (x.k !== y.k) changed.push({ path: n, what: 'kind' });
    else if (x.h !== y.h) changed.push({ path: n, what: 'content' });
    else if (modes && x.x !== y.x) changed.push({ path: n, what: 'mode' });
  }
  let result = changed.some((c) => c.what !== 'unknown') ? 'changed' : unknown ? 'unknown' : 'unchanged';
  if (result === 'unchanged' && strictShared && shared_git.result === 'changed') result = 'changed';
  return { ...base, result, changed: changed.slice(0, MAX_LISTED), changed_count: changed.length, degraded, shared_git };
}

function parseFlags(argv, allowed) {
  const f = {};
  for (let i = 0; i < argv.length; i += 2) { if (!argv[i].startsWith('--') || !allowed.includes(argv[i].slice(2)) || argv[i + 1] === undefined || argv[i + 1].startsWith('--') || f[argv[i].slice(2)] !== undefined) return null; f[argv[i].slice(2)] = argv[i + 1]; }
  return f;
}
/**
 * Write `data` to a NEW file `out`, never opening an existing one (a hard link or bind mount of a tracked inode, a symlink, an
 * existing record): temp file created exclusively (0600, no symlink following) in the same directory, then linked into place
 * (fails if `out` exists), falling back to rename only where hard links are unsupported. Returns a refusal reason or null.
 */
function writeNew(out, data) {
  try { lstatSync(out); return `--out ${'exists'}: refusing to open an existing file (choose a new path outside the tree)`; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = join(dirname(out), `.${basename(out)}.tmp-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { writeSync(fd, data); } finally { closeSync(fd); }
  try { linkSync(tmp, out); unlinkSync(tmp); } catch (e) {
    if (e.code === 'EEXIST') { unlinkSync(tmp); return '--out exists: refusing to open an existing file'; }
    try { renameSync(tmp, out); } catch (e2) { try { unlinkSync(tmp); } catch { /* gone */ } throw e2; }
  }
  return null;
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const unknownOut = (reason) => { process.stdout.write(JSON.stringify({ result: 'unknown', reason, changed: [], limits: LIMITS }) + '\n'); return 1; };

export function main(argv) {
  const [cmd, ...rest] = argv;
  const usage = () => { process.stderr.write('Usage: tree-snapshot.mjs snapshot --repo <path> [--lane <id>] [--out <file outside the tree>] | compare --before <file> (--repo <path> | --after <file>)\n'); return 2; };
  try {
    if (cmd === 'snapshot') {
      const f = parseFlags(rest, ['repo', 'lane', 'out']);
      if (!f || !f.repo) return usage();
      if (f.out !== undefined) {
        const out = realOutPath(f.out);
        if (isInside(out, treeRoots(f.repo).roots)) return unknownOut('--out resolves inside the checked tree or its git directory; write the record outside it');
      }
      const out = JSON.stringify(takeSnapshot(resolve(f.repo), { lane: f.lane ?? null })) + '\n';
      if (f.out) { const why = writeNew(f.out, out); if (why) return unknownOut(why); } else process.stdout.write(out);
      return 0;
    }
    if (cmd === 'compare') {
      const strictShared = rest.includes('--strict-shared');
      const f = parseFlags(rest.filter((a) => a !== '--strict-shared'), ['before', 'repo', 'after']);
      if (!f || !f.before || (f.repo === undefined) === (f.after === undefined)) return usage();
      const before = readJson(f.before);
      const after = f.after ? readJson(f.after) : (validateSnapshot(before) ? null : takeSnapshot(resolve(f.repo), { lane: before.lane }));
      const v = compareSnapshots(before, after, { strictShared });
      process.stdout.write(JSON.stringify(v) + '\n');
      return v.result === 'unchanged' ? 0 : 1;
    }
  } catch (e) {
    return unknownOut('git or the filesystem could not describe the tree: ' + String(e.message).split('\n')[0]);
  }
  return usage();
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
