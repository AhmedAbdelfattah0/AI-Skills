// S-02a0c: the store-backed hardened git surface. Design: consolidation-2026-11/S02-REDESIGN-v3-2026-11-23.md (v3)
// as amended by S02-REDESIGN-v3.1-AMENDMENTS-2026-11-23.md (R1-R16), owner-approved 2026-11-23.
// PRINCIPLE: no git process ever receives the builder's git dir, config, index, refs, info/* or hooks. Every spawn
// runs hermetic on a lib-written git dir (the store, a view V or an index dir I). The builder repository contributes
// only its object files (read by git through lib-written alternates), its worktree bytes (read here), its directory
// entries and .gitignore files (read by ls-files under I) and the bytes of <common>/info/exclude (copied here).
// Custom code; nothing is copied from upstream. Node 18 compatible, synchronous, POSIX only (win32 refuses first).
// Written in the T4a grammar (lib/git-exec.test.mjs): no lossy decode, no reflection, Buffers for every path byte.
// BOUNDARIES (owner-approved amendment T1', 2026-11-23): arbitrary malicious JavaScript executing inside the trusted host
// process is out of scope; T1 (git-hardened.test.mjs) is a development lint/guardrail, not a security isolation boundary.
// The runtime protections are independent of T1: module-private WeakMaps (no exported runner or state), opaque frozen
// handles (a forged or copied handle is git_op_invalid), the closed OPS table, strict typed refusals.
// DEADLINES (owner-approved attempt 3, 2026-11-23): every filesystem call goes through one per-operation gateway `fsx`
// that checks the operation's deadline before the call; CPU loops check every 1,024 units; each public success return is
// preceded by a terminal check; recovery (quarantine, removal) runs on a derived grace deadline with lane_remove_failed.
// LIMITATIONS of that guarantee (not hard-timeout protection): an fs call already in progress (a hung network syscall)
// and a slow descriptor close are not interrupted; the concurrent-writer and walk race windows are unchanged. Outside
// fsx (residual R-b, documented and tested for typed failure): git-exec's preflight statSync of the lib-owned cwd before
// each spawn (its time is not deducted from that spawn's timeout; the next gateway check refuses with the operation code;
// a failing stat is git_launch_failed) and the git probe in createContext (PATH stat/access/realpath and a --version spawn
// with its own 10 s SIGKILL bound; not charged to any operation deadline; a failure is a typed GitCapabilityError).
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GitError, composeEnv, decodeStrict, gitRunner, hermeticPolicy } from './git-exec.mjs';
import { GitCapabilityError } from './git-capability.mjs';

const fail = (code, op) => new GitError(code, { op });
const invalid = () => fail('git_op_invalid');
const OID = /^[0-9a-f]{40}$/;
const MIB = 1024 * 1024;
const SLASH = Buffer.from('/');
const EMPTY = Buffer.alloc(0);

// ------------------------------------------------------------------ qualified cells (OC-5, v3.1 R9)

/**
 * A cell is the full `git --version` line x OS x CPU arch x Node major. Only a cell whose full suite passed (start-up,
 * error, timeout and overflow paths, canary positive controls, the post-SIGKILL process check) is listed; it enters
 * through a PR that records that run. Everything else, newer gits included, refuses loudly (O-7).
 * Recorded by the S-02a0c PR: four local darwin cells (full suite incl. the 30k cost cell, on the committed lib) and the
 * four CI runner cells (git 2.56.1 on ubuntu-latest and macos-latest, Node 18/22) whose first full-suite run was green.
 */
export const QUALIFIED_CELLS = Object.freeze([
  Object.freeze({ git: 'git version 2.50.1 (Apple Git-155)', os: 'darwin', arch: 'arm64', node: 18 }),
  Object.freeze({ git: 'git version 2.50.1 (Apple Git-155)', os: 'darwin', arch: 'arm64', node: 22 }),
  Object.freeze({ git: 'git version 2.55.0', os: 'darwin', arch: 'arm64', node: 18 }),
  Object.freeze({ git: 'git version 2.55.0', os: 'darwin', arch: 'arm64', node: 22 }),
  Object.freeze({ git: 'git version 2.56.1', os: 'darwin', arch: 'arm64', node: 18 }),
  Object.freeze({ git: 'git version 2.56.1', os: 'darwin', arch: 'arm64', node: 22 }),
  Object.freeze({ git: 'git version 2.56.1', os: 'linux', arch: 'x64', node: 18 }),
  Object.freeze({ git: 'git version 2.56.1', os: 'linux', arch: 'x64', node: 22 }),
]);
export class GitCellUnqualified extends GitCapabilityError {
  constructor(cell) {
    super('git_cell_unqualified');
    this.message = `${cell.git} on ${cell.os}-${cell.arch} with Node ${cell.node} is not a qualified cell; qualify it (see lib/git-ops.golden.json cells) or use a qualified git`;
  }
}
const sameCell = (a, b) => a.git === b.git && a.os === b.os && a.arch === b.arch && a.node === b.node;

// ------------------------------------------------------------------ the closed OPS table (golden: lib/git-ops.golden.json)

/**
 * Every git argv the lib can run. `<oid>`, `<path>`, `<n>` and `<name>` are filled from validated operands in order;
 * nothing else reaches argv. `dir`: the git dir the row runs on (`store`, the view `view`, an index dir `index`, or
 * `none` for init). `write`: what the row may write. `stdin`: 'oid-lines' rows only (git-exec R3). raw-object rows are
 * the only ones `op()` runs; the rest are internal to initStore and verifyWorktree. `callers`: registered callers.
 */
const row = (id, policy, dir, write, argv, status, stdin) => Object.freeze({ id, policy, dir, write, argv: Object.freeze(argv), status: Object.freeze(status), stdin, callers: Object.freeze([]) });
export const OPS_TABLE = Object.freeze([
  row('blob.read', 'raw-object', 'store', 'ro', ['cat-file', 'blob', '--end-of-options', '<oid>'], { 0: 'ok' }, null),
  row('tree.list', 'raw-object', 'store', 'ro', ['ls-tree', '-r', '-t', '-z', '--full-tree', '--end-of-options', '<oid>'], { 0: 'ok' }, null),
  row('tree.diff', 'raw-object', 'store', 'ro', ['diff-tree', '-z', '-r', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '--end-of-options', '<oid>', '<oid>'], { 0: 'ok' }, null),
  row('commit.resolve', 'raw-object', 'store', 'ro', ['rev-parse', '--verify', '--quiet', '--end-of-options', '<oid>^{commit}'], { 0: 'ok', 1: 'absent' }, null),
  row('commit.tree', 'raw-object', 'store', 'ro', ['rev-parse', '--verify', '--quiet', '--end-of-options', '<oid>^{tree}'], { 0: 'ok', 1: 'absent' }, null),
  row('merge.base', 'raw-object', 'store', 'ro', ['merge-base', '--all', '--end-of-options', '<oid>', '<oid>'], { 0: 'ok', 1: 'none' }, null),
  row('object.exists', 'raw-object', 'store', 'ro', ['cat-file', '-e', '--end-of-options', '<oid>'], { 0: 'ok', 1: 'absent' }, null),
  row('tree.raw', 'internal', 'store', 'ro', ['cat-file', '--batch'], { 0: 'ok' }, 'oid-lines'),
  row('store.init', 'internal', 'none', 'creates', ['init', '--bare', '--quiet', '--initial-branch=pin', '--object-format=sha1', '--template=<path>', '--end-of-options', '<path>'], { 0: 'ok' }, null),
  row('store.walk', 'internal', 'view', 'ro', ['rev-list', '--objects', '--no-object-names', '--end-of-options', '<oid>', '<oid>'], { 0: 'ok' }, null),
  row('store.sizes', 'internal', 'view', 'ro', ['cat-file', '--batch-check=%(objectsize) %(objectsize:disk)'], { 0: 'ok' }, 'oid-lines'),
  row('store.pack', 'internal', 'view', 'writes-r', ['pack-objects', '--revs', '--quiet', '<path>'], { 0: 'ok' }, 'oid-lines'),
  row('store.index', 'internal', 'store', 'writes', ['index-pack', '--max-input-size=<n>', '<path>'], { 0: 'ok' }, null),
  row('store.connect', 'internal', 'store', 'ro', ['rev-list', '--objects', '--quiet', '--end-of-options', '<oid>', '<oid>'], { 0: 'ok' }, null),
  row('store.pin', 'internal', 'store', 'writes', ['update-ref', 'refs/pin/<name>', '<oid>'], { 0: 'ok' }, null),
  row('worktree.read', 'internal', 'index', 'writes-i', ['read-tree', '--end-of-options', '<oid>'], { 0: 'ok' }, null),
  row('worktree.others', 'internal', 'index', 'ro', ['ls-files', '-z', '--others', '--exclude-per-directory=.gitignore', '--exclude-from=<path>'], { 0: 'ok' }, null),
  row('worktree.ignored', 'internal', 'index', 'ro', ['ls-files', '-z', '--others', '--ignored', '--directory', '--exclude-per-directory=.gitignore', '--exclude-from=<path>'], { 0: 'ok' }, null),
]);
const OPS = new Map(OPS_TABLE.map((r) => [r.id, r]));
const PIN_NAMES = ['head', 'base'];

/** A lib-internal absolute path string: `/`-rooted, normalised, strict UTF-8, no control byte (it is only ever joined after `=` or passed whole). */
const isAbsPath = (s) => typeof s === 'string' && s.startsWith('/') && s.length > 1 && !/[\x00-\x1f\x7f]/.test(s) && !s.endsWith('/')
  && s.slice(1).split('/').every((c) => c.length > 0 && c !== '.' && c !== '..') && decodeStrict(Buffer.from(s), 'path_not_utf8') === s;
const isOid = (s) => typeof s === 'string' && OID.test(s);

/** argv for one row: each placeholder takes the next operand of its kind, validated; a leftover or missing operand is refused. */
function argvOf(r, operands) {
  const queue = [...operands];
  const out = [];
  for (const token of r.argv) {
    let t = token;
    for (const [mark, ok] of [['<oid>', isOid], ['<path>', isAbsPath], ['<n>', (v) => Number.isSafeInteger(v)], ['<name>', (v) => PIN_NAMES.includes(v)]]) {
      if (!t.includes(mark)) continue;
      const v = queue.shift();
      if (!ok(v) || (mark === '<n>' && v <= 0)) throw invalid();
      t = t.replace(mark, () => `${v}`);
    }
    out.push(t);
  }
  if (queue.length) throw invalid();
  return out;
}

// ------------------------------------------------------------------ contexts and handles (opaque tokens, module-private state)

const CTX = new WeakMap();
const HANDLES = new WeakMap();
const DISPOSED = new WeakSet();
const uid = () => process.getuid();
const join = (a, name) => Buffer.concat([a, SLASH, name]);
const B = (s) => Buffer.from(s);
const str = (b) => decodeStrict(b, 'path_not_utf8');
const missing = (e) => e.code === 'ENOENT' || e.code === 'ENOTDIR';
const sameNode = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
/** `child` equals or lies under `parent` (both realpath Buffers): a component-wise byte compare. */
const inside = (child, parent) => child.equals(parent) || (child.length > parent.length && child.subarray(0, parent.length + 1).equals(Buffer.concat([parent, SLASH])));
/** A lossless Map key for path bytes (hex; never displayed, never compared with text). */
const hexKey = (b) => b.toString('hex');

// ------------------------------------------------------------------ fsx: the one gateway for filesystem work (attempt 3)

/** Deadline refusals, created only by fsx: every catch in this module rethrows them first, so expiry is never remapped. */
const EXPIRED = new WeakSet();
const expired = (e) => EXPIRED.has(e);
/**
 * The per-operation gateway (owner-approved attempt-3 design, 2026-11-23). EVERY filesystem call of this module goes
 * through one `fx`: `check()` runs before each call (expired: a GitError with the operation's code, recorded in EXPIRED),
 * `tick()` checks every 1,024 units of CPU work, `derive()` gives recovery (quarantine, removal) its own grace deadline
 * and code. `close` is the one unchecked call, so an expired deadline never leaks a descriptor.
 * LIMITATIONS (stated, not hard-timeout protection): a syscall already in progress (a hung network lstat), a slow close,
 * and the concurrent-writer and walk race windows are not interrupted; git-exec's preflight stat of the lib-owned cwd and
 * the git probe run outside fsx (documented in the header and tested for typed failure).
 */
function fsx({ deadline, code, op }) {
  let ticks = 0;
  // A failed close never replaces the error in flight (a deadline sentinel or a typed refusal): it is recorded, and the
  // success path's terminal `done()` refuses on it.
  let closeFailed = false;
  let finished = false;
  const quietClose = (f) => { try { f(); } catch { closeFailed = true; } };
  const RD_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const check = () => { if (Date.now() >= deadline) { const e = fail(code, op); EXPIRED.add(e); throw e; } };
  const guard = (f) => (...a) => { check(); return f(...a); };
  /** The lib's one directory create: non-recursive, mode 0700, exclusive (EEXIST throws). */
  const mkdir0700 = (p) => mkdirSync(p, 0o700);
  return Object.freeze({
    deadline, code, op, check,
    /** The terminal check before a public success return: the deadline, and no descriptor that failed to close. */
    done: () => { check(); if (closeFailed) throw fail('worktree_entry_unsupported', 'close'); finished = true; },
    ok: () => finished,
    tick: () => { ticks = ticks + 1; if (ticks > 1023) { ticks = 0; check(); } },
    derive: (o) => fsx(o),
    lstat: guard((p) => lstatSync(p)),
    lstatOrNull: (p) => { check(); try { return lstatSync(p); } catch (e) { if (missing(e)) return null; throw fail('worktree_entry_unsupported', 'lstat'); } },
    fstat: guard((fd) => fstatSync(fd)),
    open: guard((p) => openSync(p, RD_FLAGS)),
    read: guard((fd, buf, at, len) => readSync(fd, buf, at, len, null)),
    close: (fd) => quietClose(() => closeSync(fd)),
    openDir: (p) => { check(); const d = opendirSync(p, { encoding: 'buffer' }); return Object.freeze({ read: () => { check(); return d.readSync(); }, close: () => quietClose(() => d.closeSync()) }); },
    readLink: guard((p) => readlinkSync(p, { encoding: 'buffer' })),
    realPath: guard((p) => realpathSync.native(p, { encoding: 'buffer' })),
    chmod: guard((p, m) => chmodSync(p, m)),
    unlink: guard((p) => unlinkSync(p)),
    rmdir: guard((p) => rmdirSync(p)),
    rename: guard((a, b) => renameSync(a, b)),
    copyFile: guard((a, b) => copyFileSync(a, b, constants.COPYFILE_EXCL)),
    mkdir: guard(mkdir0700),
    // The prefix is passed as a (strict-decoded) string: Node 18.20.8 mkdtempSync throws a TypeError on a Buffer prefix (MEASURED).
    makeTemp: guard((parent, prefix) => mkdtempSync(`${str(parent)}/${prefix}`, { encoding: 'buffer' })),
    writeNew: guard((p, data) => writeFileSync(p, data, { flag: 'wx', mode: 0o600 })),
  });
}
/** A counter that throws `code` once its total passes `cap`; every charge also checks the operation's deadline. */
const meter = (cap, code, op, fx) => { let n = 0; return (k) => { fx.check(); n = n + k; if (n > cap) throw fail(code, op); return n; }; };
/**
 * The recovery gateway of an operation (approved design note v2): ONE grace window ending at the operation's deadline +
 * timeoutMs, shared by every recovery step of that operation, with lane_remove_failed. A recovery that finds the window
 * spent refuses (the dir then stays where it is, quarantined or at its own name, and is never reused).
 */
const recovery = (fx, st, op) => fx.derive({ deadline: fx.deadline + st.timeoutMs, code: 'lane_remove_failed', op });

/** Positive safe integers only; the caller may lower any default. */
export const DEFAULTS = Object.freeze({
  timeoutMs: 120_000, maxFiles: 1_000_000, maxBytes: 16 * 1024 * MIB, maxObjectBytes: 512 * MIB, maxTotalObjectBytes: 4 * 1024 * MIB, removeEntries: 1_000_000,
  // R2 cost bound: the size precheck batches at most 99 oids per cat-file (R3's 4 KiB stdin), about 4-6 ms per batch
  // (MEASURED, darwin): 1,000,000 objects is about 10,100 batches, roughly 45-65 s, inside the 120 s default deadline.
  maxObjects: 1_000_000,
});

/**
 * A context: one private root R (mkdtemp, 0700) holding hooks/ (empty), home/, an empty global config, an empty
 * init template and cwd/; every spawn is hermetic (no user, system or ambient git config). win32 refuses before any
 * spawn or write (OC-4); an unqualified cell refuses after the probe and before any write (OC-5). The probe is not
 * charged to any deadline (R-b); the context's own few fs calls run on an fx with its timeoutMs.
 */
export function createContext({ timeoutMs = DEFAULTS.timeoutMs, maxFiles = DEFAULTS.maxFiles, maxBytes = DEFAULTS.maxBytes, maxObjectBytes = DEFAULTS.maxObjectBytes,
  maxTotalObjectBytes = DEFAULTS.maxTotalObjectBytes, removeEntries = DEFAULTS.removeEntries, maxObjects = DEFAULTS.maxObjects, ...unknown } = {}) {
  if (process.platform === 'win32') throw fail('platform_unsupported', 'context.create');
  if (Object.keys(unknown).length || ![timeoutMs, maxFiles, maxBytes, maxObjectBytes, maxTotalObjectBytes, removeEntries, maxObjects].every((n) => Number.isSafeInteger(n) && n > 0)) throw invalid();
  const runner = gitRunner({});
  const cell = Object.freeze({ git: runner.info.raw, os: process.platform, arch: process.arch, node: +process.versions.node.split('.')[0] });
  if (!QUALIFIED_CELLS.some((c) => sameCell(c, cell))) throw new GitCellUnqualified(cell);
  const tmp = process.env.TMPDIR || '/tmp';
  if (!tmp.startsWith('/')) throw fail('owned_dir_invalid', 'context.create');
  const fx = fsx({ deadline: Date.now() + timeoutMs, code: 'git_timeout', op: 'context.create' });
  const R = fx.makeTemp(fx.realPath(tmp), 'ship-ticket-git-');
  let rst = null;
  try {
    rst = fx.lstat(R);
    if (!fx.realPath(R).equals(R) || !rst.isDirectory() || rst.uid !== uid()) throw fail('owned_dir_invalid', 'context.create');
    for (const d of ['hooks', 'home', 'cwd', 'template']) fx.mkdir(join(R, B(d)));
    fx.writeNew(join(R, B('empty.gitconfig')), '');
    fx.done();
  } finally {
    // A refused context removes the R it made, on its recovery window (only when R's identity is known).
    if (rst !== null && !fx.ok()) removeTree(fx.derive({ deadline: fx.deadline + timeoutMs, code: 'lane_remove_failed', op: 'context.create' }), R, rst.dev, DEFAULTS.removeEntries);
  }
  const Rs = str(R);
  const env = composeEnv({ ambient: process.env, gitInfo: runner.info, hooksDir: `${Rs}/hooks`, policy: hermeticPolicy({ home: `${Rs}/home`, globalConfig: `${Rs}/empty.gitconfig` }) });
  const ctx = Object.freeze({ dispose: () => disposeContext(ctx) });
  CTX.set(ctx, Object.freeze({ root: R, rootPath: Rs, rootStat: rst, runner, env, cell, timeoutMs, maxFiles, maxBytes, maxObjectBytes, maxTotalObjectBytes, removeEntries, maxObjects }));
  return ctx;
}

/** A context's state, refused once disposed. */
function state(ctx, op) {
  const st = CTX.get(ctx);
  if (!st) throw invalid();
  if (DISPOSED.has(ctx)) throw fail('context_disposed', op);
  return st;
}
/** The operation gateway: one fx per public call, deadline = now + the context's timeoutMs. */
const opFx = (st, code, op) => fsx({ deadline: Date.now() + st.timeoutMs, code, op });
/** R/hooks must still be empty and R the same inode (context_tampered otherwise); an expiry here stays an expiry. */
function live(st, fx, op) {
  const now = fx.lstatOrNull(st.root);
  let hooks = null;
  try { hooks = listDir(fx, join(st.root, B('hooks')), () => 0); } catch (e) { if (expired(e)) throw e; hooks = null; }
  if (!sameNode(now, st.rootStat) || hooks === null || hooks.length !== 0) throw fail('context_tampered', op);
  return st;
}
function disposeContext(ctx) {
  const st = CTX.get(ctx);
  if (!st || DISPOSED.has(ctx)) return;
  DISPOSED.add(ctx);
  const fx = opFx(st, 'lane_remove_failed', 'context.dispose');
  // Only the R this context created is removed: a replaced R (another inode) is left alone and reported.
  if (!sameNode(fx.lstatOrNull(st.root), st.rootStat)) throw fail('context_tampered', 'context.dispose');
  removeTree(fx, st.root, st.rootStat.dev, st.removeEntries);
  fx.done();
}
/** An existing directory whose realpath is itself (no symlink anywhere in its chain). */
function canonicalDir(fx, p) {
  try { return fx.realPath(p).equals(p) && fx.lstat(p).isDirectory(); } catch (e) { if (expired(e)) throw e; return false; }
}
const handleOf = (h, kind) => { const s = HANDLES.get(h); if (!s || s.kind !== kind) throw invalid(); return s; };

// ------------------------------------------------------------------ bounded host reads (v3.1 R4)

/** Directory names as Buffers, one entry at a time, each charged to `spend` (no readdirSync: no full allocation first). */
function listDir(fx, p, spend) {
  let d;
  try { d = fx.openDir(p); } catch (e) { if (expired(e)) throw e; throw fail('worktree_entry_unsupported', 'listdir'); }
  const names = [];
  try {
    for (let e = d.read(); e !== null; e = d.read()) { spend(1); names.push(e.name); }
  } finally { d.close(); }
  return names;
}

/** Whether a directory has any entry: one bounded read, charged one entry (a populated gitlink is never enumerated). */
function hasEntry(fx, p, spend) {
  let d;
  try { d = fx.openDir(p); } catch (e) { if (expired(e)) throw e; throw fail('worktree_entry_unsupported', 'listdir'); }
  try { const e = d.read(); spend(1); return e !== null; } finally { d.close(); }
}

/** A regular file owned by the uid, at most `cap` bytes, read through a descriptor that matches the lstat. */
function readBounded(fx, p, cap, op) {
  const before = fx.lstat(p);
  if (!before.isFile()) throw fail('worktree_entry_unsupported', op);
  if (before.uid !== uid()) throw fail('repo_owner_mismatch', op);
  let fd;
  try { fd = fx.open(p); } catch (e) { if (expired(e)) throw e; throw fail('worktree_entry_unsupported', op); }
  try {
    const s = fx.fstat(fd);
    if (!s.isFile() || !sameNode(s, before) || s.uid !== uid()) throw fail('worktree_entry_unsupported', op);
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (let got = 1; got > 0 && n <= cap;) { got = fx.read(fd, buf, n, cap + 1 - n); n = n + got; }
    if (n > cap) throw fail('worktree_entry_unsupported', op);
    return buf.subarray(0, n);
  } finally { fx.close(fd); }
}

/** `gitdir: <path>` / `<path>` (commondir), one line, strict UTF-8, resolved against `base`, as a realpath Buffer. */
function pointer(fx, bytes, base, prefix, op) {
  const text = decodeStrict(bytes, 'path_not_utf8');
  const line = text.endsWith('\n') ? text.slice(0, text.length - 1) : text;
  if (!line.startsWith(prefix) || line.length === prefix.length || /[\x00-\x1f\x7f]/.test(line)) throw fail('repo_layout_unsupported', op);
  const target = line.slice(prefix.length);
  const p = target.startsWith('/') ? B(target) : join(base, B(target));
  try { return fx.realPath(p); } catch (e) { if (expired(e)) throw e; throw fail('repo_layout_unsupported', op); }
}

function ownedDir(fx, p, op) {
  const s = fx.lstatOrNull(p);
  if (!s || !s.isDirectory()) throw fail('repo_layout_unsupported', op);
  if (s.uid !== uid()) throw fail('repo_owner_mismatch', op);
  return s;
}

// ------------------------------------------------------------------ openSource: filesystem bootstrap, no spawn (v3 §2.1)

/**
 * The builder repository at `toplevel`: `.git` is a directory, or a gitfile (<= 4 KiB) naming one, whose optional
 * `commondir` (<= 4 KiB) names the common dir. Shallow, grafts and alternates refuse; toplevel, git dir, common dir and
 * objects must be owned by the uid; their (dev, ino) are re-checked later. `<common>/info/exclude` (<= 1 MiB) is copied
 * into R. Nothing is spawned and nothing in the builder repository is written. Expiry: git_timeout.
 */
export function openSource(ctx, { toplevel, ...unknown } = {}) {
  const op = 'source.open';
  const st = state(ctx, op);
  const fx = opFx(st, 'git_timeout', op);
  live(st, fx, op);
  if (Object.keys(unknown).length || !isAbsPath(toplevel)) throw invalid();
  let top;
  try { top = fx.realPath(toplevel); } catch (e) { if (expired(e)) throw e; throw fail('repo_layout_unsupported', op); }
  const tst = ownedDir(fx, top, op);
  const dotgit = join(top, B('.git'));
  const ds = fx.lstatOrNull(dotgit);
  if (!ds || !(ds.isDirectory() || ds.isFile())) throw fail('repo_layout_unsupported', op);
  const gitDir = ds.isDirectory() ? fx.realPath(dotgit) : pointer(fx, readBounded(fx, dotgit, 4096, op), top, 'gitdir: ', op);
  const gst = ownedDir(fx, gitDir, op);
  const cd = join(gitDir, B('commondir'));
  const common = fx.lstatOrNull(cd) ? pointer(fx, readBounded(fx, cd, 4096, op), gitDir, '', op) : gitDir;
  const cst = ownedDir(fx, common, op);
  const objects = join(common, B('objects'));
  const ost = ownedDir(fx, objects, op);
  if (fx.lstatOrNull(join(common, B('shallow')))) throw fail('shallow_unsupported', op);
  if (fx.lstatOrNull(join(common, B('info/grafts')))) throw fail('grafts_present', op);
  if (alternatesPresent(fx, objects)) throw fail('alternates_present', op);
  if ([top, common].some((d) => inside(st.root, d))) throw fail('owned_dir_invalid', op);
  const ex = join(common, B('info/exclude'));
  const exBytes = fx.lstatOrNull(ex) ? readBounded(fx, ex, MIB, op) : EMPTY;
  const exDir = fx.makeTemp(st.root, 'x-');
  const excludeCopy = join(exDir, B('info-exclude'));
  fx.writeNew(excludeCopy, exBytes);
  fx.done();
  const handle = Object.freeze({});
  HANDLES.set(handle, Object.freeze({
    kind: 'source', ctx, top, common, objects, excludeCopy, checks: Object.freeze([[top, tst], [gitDir, gst], [common, cst], [objects, ost]]),
    excludeSha256: exBytes.length ? createHash('sha256').update(exBytes).digest('hex') : null,
  }));
  return handle;
}
const alternatesPresent = (fx, objects) => ['info/alternates', 'info/http-alternates'].some((f) => fx.lstatOrNull(join(objects, B(f))) !== null);
/** The source's dirs are the same inodes as at open, and still carry no alternates (context_tampered otherwise). */
function recheckSource(fx, s, op) {
  if (!s.checks.every(([p, before]) => sameNode(fx.lstatOrNull(p), before)) || alternatesPresent(fx, s.objects)) throw fail('context_tampered', op);
}

// ------------------------------------------------------------------ the store (v3 §2.2 + v3.1 R2): the only write path

const STORE_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tcommitGraph = false\n\tmultiPackIndex = false\n[gc]\n\tauto = 0\n';
const VIEW_CONFIG = `${STORE_CONFIG}[pack]\n\tuseBitmaps = false\n\treadReverseIndex = false\n\tthreads = 1\n`;
const INDEX_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tcommitGraph = false\n\tmultiPackIndex = false\n\tuntrackedCache = false\n\tsparseCheckout = false\n\tsymlinks = true\n\tignorecase = false\n\tprecomposeUnicode = false\n[gc]\n\tauto = 0\n';
const STORE_MARKER = 'ship-ticket-store v1\n';

/**
 * One spawn of a row on a lib git dir: the gateway is checked first (an expired operation refuses with its own code),
 * then the remaining time is the spawn's timeout (a git subprocess killed there stays git_timeout from git-exec).
 */
function git(fx, st, id, gitDir, operands, { workTree, stdin, maxBuffer = 64 * MIB } = {}) {
  const r = OPS.get(id);
  if ((r.stdin === null) !== (stdin === undefined)) throw invalid();
  fx.check();
  const remaining = fx.deadline - Date.now();
  if (remaining <= 0) fx.check();
  const pre = gitDir === null ? [] : [`--git-dir=${gitDir}`, ...(workTree === undefined ? [] : [`--work-tree=${workTree}`])];
  return st.runner.run({ args: [...pre, ...argvOf(r, operands)], cwd: `${st.rootPath}/cwd`, env: st.env, op: id, status: r.status, stdin, timeoutMs: remaining, maxBuffer });
}
/** A failed ingest row means the objects cannot be read as claimed (missing, corrupt, unparseable): object_corrupt. */
const corruptOnFail = (fn, id) => { try { return fn(); } catch (e) { if (expired(e)) throw e; if (e instanceof GitError && e.code === 'git_failed') throw fail('object_corrupt', id); throw e; } };
/** Newline-terminated output lines (strict UTF-8); a missing final newline is object_corrupt. */
function lines(fx, stdout, op) {
  const t = decodeStrict(stdout);
  if (t === '') return [];
  if (!t.endsWith('\n')) throw fail('object_corrupt', op);
  const out = t.slice(0, t.length - 1).split('\n');
  fx.check();
  return out;
}
/** The data-only stdin form of git-exec (oid strings, at most 99 per call): the runner builds the bytes. */
const oidChunks = (fx, oids) => { const out = []; for (let i = 0; i < oids.length; i = i + 99) { fx.tick(); out.push(Object.freeze({ kind: 'oid-lines', oids: Object.freeze(oids.slice(i, i + 99)) })); } return out; };

/** A lib git dir under R: lib-written config, HEAD = oid, alternates = `objects` (an absolute realpath Buffer). */
function libGitDir(fx, st, prefix, config, oid, objects) {
  const d = fx.makeTemp(st.root, prefix);
  fx.writeNew(join(d, B('config')), config);
  fx.writeNew(join(d, B('HEAD')), `${oid}\n`);
  for (const x of ['objects', 'objects/info', 'objects/pack', 'refs', 'tmp']) fx.mkdir(join(d, B(x)));
  fx.writeNew(join(d, B('objects/info/alternates')), `${str(objects)}\n`);
  return d;
}

/**
 * Fill a fresh hermetic bare store at `dir` (must not exist; created here, exclusively) with every object reachable
 * from `oids` ([head] or [head, base]) in the source: sizes checked before packing (R2), pack-objects in a lib view V
 * over the builder's object files, producer .idx/.rev dropped, index-pack re-hashes every object into the store,
 * rev-list proves connectivity, refs/pin/{head,base} are set. On any failure, an expiry included, the dir is quarantined
 * and removed on the recovery gateway (grace deadline); if that fails it stays quarantined and the error is lane_remove_failed.
 */
export function initStore(ctx, { dir, source, oids, ...unknown } = {}) {
  const op = 'store.init';
  const st = state(ctx, op);
  const fx = opFx(st, 'git_timeout', op);
  live(st, fx, op);
  const s = handleOf(source, 'source');
  if (Object.keys(unknown).length || !isAbsPath(dir) || !Array.isArray(oids) || oids.length < 1 || oids.length > 2 || !oids.every(isOid) || s.ctx !== ctx) throw invalid();
  const [head, base = oids[0]] = oids;
  const D = B(dir);
  const parent = D.subarray(0, D.lastIndexOf(0x2f) || 1);
  let real;
  try { real = fx.realPath(parent); } catch (e) { if (expired(e)) throw e; throw fail('owned_dir_invalid', op); }
  if (!real.equals(parent) || [s.top, s.common, st.root].some((x) => inside(D, x) || inside(x, D)) || fx.lstatOrNull(D)) throw fail('owned_dir_invalid', op);
  try { fx.mkdir(D); } catch (e) { if (expired(e)) throw e; throw fail('owned_dir_invalid', op); }
  let created = null;
  let handle = null;
  try {
    created = fx.lstat(D);
    ingest(fx, st, s, D, created, dir, head, base);
    handle = storeHandle(fx, ctx, D);
  } finally {
    // Any failure, an expiry (even at the terminal check) included, discards the dir on the recovery gateway. Without a
    // verified creation identity (an expiry between the mkdir and its lstat) nothing is moved or removed: the empty dir
    // stays at its own name and is never reused (LIMITATION).
    if (handle === null && created !== null) discard(recovery(fx, st, op), st, D, created, parent);
  }
  return handle;
}

function ingest(fx, st, s, D, dst, dir, head, base) {
  git(fx, st, 'store.init', null, [`${st.rootPath}/template`, dir]);
  fx.unlink(join(D, B('config')));
  fx.writeNew(join(D, B('config')), STORE_CONFIG);
  fx.writeNew(join(D, B('ship-ticket-store')), STORE_MARKER);
  const V = libGitDir(fx, st, 'V-', VIEW_CONFIG, head, s.objects);
  const Vs = str(V);
  // R2: every reachable object's inflated size, before any pack is parsed or written.
  const all = lines(fx, corruptOnFail(() => git(fx, st, 'store.walk', Vs, [head, base]).stdout, 'store.walk'), 'store.walk');
  if (!all.every((o) => { fx.tick(); return isOid(o); })) throw fail('object_corrupt', 'store.walk');
  if (all.length > st.maxObjects) throw fail('object_too_large', 'store.walk');
  const total = meter(st.maxTotalObjectBytes, 'object_too_large', 'store.sizes', fx);
  for (const chunk of oidChunks(fx, all)) {
    const sizes = lines(fx, corruptOnFail(() => git(fx, st, 'store.sizes', Vs, [], { stdin: chunk }).stdout, 'store.sizes'), 'store.sizes');
    if (sizes.length !== chunk.oids.length) throw fail('object_corrupt', 'store.sizes');
    for (const l of sizes) {
      const m = /^(\d{1,15}) (\d{1,15})$/.exec(l);
      if (!m) throw fail('object_corrupt', 'store.sizes');
      if (+m[1] > st.maxObjectBytes) throw fail('object_too_large', 'store.sizes');
      total(+m[1]);
    }
  }
  const tips = Object.freeze({ kind: 'oid-lines', oids: Object.freeze(head === base ? [head] : [head, base]) });
  const out = lines(fx, corruptOnFail(() => git(fx, st, 'store.pack', Vs, [`${Vs}/tmp/p`], { stdin: tips }).stdout, 'store.pack'), 'store.pack');
  if (out.length !== 1 || !isOid(out[0])) throw fail('object_corrupt', 'store.pack');
  const produced = join(V, B(`tmp/p-${out[0]}.pack`));
  for (const ext of ['idx', 'rev']) { const f = join(V, B(`tmp/p-${out[0]}.${ext}`)); if (fx.lstatOrNull(f)) fx.unlink(f); }
  const pst = fx.lstat(produced);
  if (!pst.isFile() || pst.size > st.maxTotalObjectBytes) throw fail('object_too_large', 'store.pack');
  const packPath = `${dir}/objects/pack/pack-${out[0]}.pack`;
  fx.copyFile(produced, B(packPath));
  fx.unlink(produced);
  corruptOnFail(() => git(fx, st, 'store.index', dir, [st.maxTotalObjectBytes, packPath]), 'store.index');
  corruptOnFail(() => git(fx, st, 'store.connect', dir, [head, base]), 'store.connect');
  git(fx, st, 'store.pin', dir, ['head', head]);
  git(fx, st, 'store.pin', dir, ['base', base]);
  removeTree(recovery(fx, st, 'store.init'), V, st.rootStat.dev, st.removeEntries);
  recheckSource(fx, s, 'store.init');
  if (!sameNode(fx.lstatOrNull(D), dst)) throw fail('context_tampered', 'store.init');
  checkStore(fx, D, 'store.init');
}

/** The failure path of a lib-created dir, on the recovery gateway: rename into `<parent>/.quarantine/`, then bounded removal (v3 §2.6, v3.1 R1). */
function discard(gx, st, D, created, parent) {
  // Only the dir this call created is ever moved or removed: a replacement (another inode or owner) is left alone.
  const now = gx.lstatOrNull(D);
  if (!sameNode(now, created) || !now.isDirectory() || now.uid !== uid()) throw fail('context_tampered', 'store.init');
  const q = join(parent, B('.quarantine'));
  try {
    const qs = gx.lstatOrNull(q);
    if (!qs) gx.mkdir(q);
    else if (!qs.isDirectory() || qs.uid !== uid()) throw fail('lane_remove_failed', 'store.init');
    const slot = gx.makeTemp(q, 'store-');
    gx.rename(D, join(slot, B('store')));
    removeTree(gx, slot, gx.lstat(slot).dev, st.removeEntries);
  } catch (e) { if (expired(e)) throw e; throw fail('lane_remove_failed', 'store.init'); }
}

/** The store is still the lib's: marker, lib config bytes, no alternates, grafts or shallow (context_tampered otherwise; an expiry stays an expiry). */
function checkStore(fx, D, op) {
  const okBytes = (name, want) => { try { return readBounded(fx, join(D, B(name)), 4096, op).equals(B(want)); } catch (e) { if (expired(e)) throw e; return false; } };
  if (!okBytes('config', STORE_CONFIG) || !okBytes('ship-ticket-store', STORE_MARKER) || alternatesPresent(fx, join(D, B('objects')))
    || fx.lstatOrNull(join(D, B('info/grafts'))) || fx.lstatOrNull(join(D, B('shallow')))) throw fail('context_tampered', op);
}
function storeHandle(fx, ctx, D) {
  const stat = fx.lstat(D);
  fx.done();
  const handle = Object.freeze({});
  HANDLES.set(handle, Object.freeze({ kind: 'store', ctx, storeDir: D, storePath: str(D), stat }));
  return handle;
}

/** A store an earlier initStore made (any context): its realpath, owner, marker and lib config must hold. Read-only. */
export function openStore(ctx, { dir, ...unknown } = {}) {
  const op = 'store.open';
  const st = state(ctx, op);
  const fx = opFx(st, 'git_timeout', op);
  live(st, fx, op);
  if (Object.keys(unknown).length || !isAbsPath(dir)) throw invalid();
  const D = B(dir);
  let real;
  try { real = fx.realPath(D); } catch (e) { if (expired(e)) throw e; throw fail('owned_dir_invalid', op); }
  const ds = fx.lstatOrNull(D);
  if (!real.equals(D) || !ds || !ds.isDirectory() || ds.uid !== uid()) throw fail('owned_dir_invalid', op);
  try { checkStore(fx, D, op); } catch (e) { if (expired(e)) throw e; throw fail('owned_dir_invalid', op); }
  return storeHandle(fx, ctx, D);
}

// ------------------------------------------------------------------ raw-object rows on a store

/**
 * `op(store, '<literal id>', [oid, ...])` for the raw-object rows. Returns: blob.read a Buffer (hash-verified),
 * tree.list frozen {mode, type, oid, path: Buffer} entries (every path checked, R6), tree.diff frozen records,
 * commit.resolve / commit.tree an oid or null, merge.base {bases, base} (base only when exactly one), object.exists a boolean.
 * Expiry: git_timeout (a terminal check refuses a result produced after the deadline).
 */
export function op(handle, id, operands = []) {
  const r = OPS.get(id);
  if (!r || r.policy !== 'raw-object' || !Array.isArray(operands)) throw invalid();
  const h = handleOf(handle, 'store');
  const st = state(h.ctx, id);
  const fx = opFx(st, 'git_timeout', id);
  live(st, fx, id);
  const result = rawRow(fx, st, h, id, operands);
  fx.done();
  return result;
}
function rawRow(fx, st, h, id, operands) {
  if (!sameNode(fx.lstatOrNull(h.storeDir), h.stat)) throw fail('context_tampered', id);
  checkStore(fx, h.storeDir, id);
  if (id === 'tree.list') return listTree(fx, st, h, operands);
  const res = git(fx, st, id, h.storePath, operands);
  const oid = operands[0];
  if (id === 'blob.read') return verifiedBlob(res.stdout, oid, id);
  if (id === 'tree.diff') return diffRecords(fx, res.stdout, id);
  if (id === 'object.exists') return res.outcome === 'ok';
  const found = lines(fx, res.stdout, id);
  if (!found.every(isOid)) throw fail('object_corrupt', id);
  if (id === 'merge.base') return Object.freeze({ bases: Object.freeze(found), base: found.length === 1 ? found[0] : null });
  if (res.outcome === 'absent') return null;
  if (found.length !== 1) throw fail('object_corrupt', id);
  return found[0];
}

const blobHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest();
function verifiedBlob(bytes, oid, id) {
  if (!blobHash(bytes).equals(Buffer.from(oid, 'hex'))) throw fail('object_corrupt', id);
  return bytes;
}

/** A path from a tree: no empty, `.`, `..` or `.git` (any case) component (components found by indexOf; a tick each). */
function unsafePath(fx, p) {
  for (let at = 0; at <= p.length;) {
    fx.tick();
    const cut = p.indexOf(0x2f, at);
    const c = p.subarray(at, cut < 0 ? p.length : cut);
    if (c.length === 0 || c.equals(B('.')) || c.equals(B('..')) || isDotGit(c)) return true;
    if (cut < 0) return false;
    at = cut + 1;
  }
  return false;
}
const isDotGit = (c) => c.length === 4 && c[0] === 0x2e && (c[1] | 0x20) === 0x67 && (c[2] | 0x20) === 0x69 && (c[3] | 0x20) === 0x74;

/**
 * tree.list: `ls-tree -r -t` records, every entry checked (R6), then the RAW bytes of every tree involved (the root and
 * each subtree, through `cat-file --batch` in <= 99-oid batches) so an entry NAME holding a slash, which ls-tree prints
 * exactly like a subtree path, is refused. Returns the non-tree entries.
 */
function listTree(fx, st, h, operands) {
  const id = 'tree.list';
  const all = treeEntries(fx, git(fx, st, id, h.storePath, operands).stdout, id);
  const root = lines(fx, git(fx, st, 'commit.tree', h.storePath, operands).stdout, id);
  if (root.length !== 1 || !isOid(root[0])) throw fail('object_corrupt', id);
  const trees = [root[0], ...all.filter((e) => { fx.tick(); return e.type === 'tree'; }).map((e) => e.oid)];
  for (const chunk of oidChunks(fx, trees)) rawTrees(fx, git(fx, st, 'tree.raw', h.storePath, [], { stdin: chunk }).stdout, chunk.oids.length, id);
  return Object.freeze(all.filter((e) => { fx.tick(); return e.type !== 'tree'; }));
}
const NL = Buffer.from('\n');
/** NUL-separated records as Buffers (the trailing terminator stripped), found by native indexOf with a tick per record. */
function zRecords(fx, buf) {
  const out = [];
  let at = 0;
  for (let nul = buf.indexOf(0, at); nul >= 0; nul = buf.indexOf(0, at)) { fx.tick(); out.push(buf.subarray(at, nul)); at = nul + 1; }
  if (at < buf.length) out.push(buf.subarray(at));
  return out;
}
/** `cat-file --batch` output: exactly one `<oid> tree <size>` object per asked oid, each tree's entries checked. */
function rawTrees(fx, buf, asked, id) {
  let objects = 0;
  for (let at = 0; at < buf.length;) {
    fx.tick();
    const nl = buf.indexOf(0x0a, at);
    const m = nl < 0 ? null : /^([0-9a-f]{40}) tree (\d{1,10})$/.exec(decodeStrict(buf.subarray(at, nl)));
    if (!m) throw fail('object_corrupt', id);
    const end = nl + 1 + +m[2];
    if (end >= buf.length || !buf.subarray(end, end + 1).equals(NL)) throw fail('object_corrupt', id);
    rawTreeNames(fx, buf.subarray(nl + 1, end), id);
    at = end + 1;
    objects = objects + 1;
  }
  if (objects !== asked) throw fail('object_corrupt', id);
}
/** Raw tree entries `<mode> <name>\0<20-byte oid>`: a name holding a slash, or an unsafe component, refuses. */
function rawTreeNames(fx, t, id) {
  for (let at = 0; at < t.length;) {
    fx.tick();
    const sp = t.indexOf(0x20, at);
    const nul = sp < 0 ? sp : t.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > t.length) throw fail('object_corrupt', id);
    const name = t.subarray(sp + 1, nul);
    if (name.indexOf(0x2f) >= 0 || unsafePath(fx, name)) throw fail('tree_path_unsafe', id);
    at = nul + 21;
  }
}

const ENTRY_HEAD = /^(100644|100755|120000|160000|040000) (blob|commit|tree) ([0-9a-f]{40})$/;
const typeOfMode = (m) => (m === '160000' ? 'commit' : m === '040000' ? 'tree' : 'blob');
/**
 * ls-tree -r -t -z records. Every entry is checked (no last-wins): unsafe components and duplicates refuse, and so does
 * a path whose IMMEDIATE parent is not a tree entry (linear: with `-t` every tree is listed, so a blob that prefixes a
 * path is a duplicate or a non-tree parent).
 */
function treeEntries(fx, stdout, id) {
  const out = [];
  for (const rec of zRecords(fx, stdout)) {
    fx.tick();
    const tab = rec.indexOf(0x09);
    if (tab < 0) throw fail('object_corrupt', id);
    const m = ENTRY_HEAD.exec(decodeStrict(rec.subarray(0, tab)));
    if (!m || typeOfMode(m[1]) !== m[2]) throw fail('object_corrupt', id);
    const path = Buffer.from(rec.subarray(tab + 1));
    if (unsafePath(fx, path)) throw fail('tree_path_unsafe', id);
    out.push(Object.freeze({ mode: m[1], type: m[2], oid: m[3], path }));
  }
  const seen = new Set();
  const leaves = new Set();
  for (const e of out) {
    fx.tick();
    if (seen.has(hexKey(e.path))) throw fail('tree_path_unsafe', id);
    seen.add(hexKey(e.path));
    if (e.type !== 'tree') leaves.add(hexKey(e.path));
  }
  for (const e of out) {
    fx.tick();
    const cut = e.path.lastIndexOf(0x2f);
    if (cut < 0) continue;
    const parentKey = hexKey(e.path.subarray(0, cut));
    if (leaves.has(parentKey) || !seen.has(parentKey)) throw fail('tree_path_unsafe', id);
  }
  return Object.freeze(out);
}

const DIFF_HEAD = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/;
function diffRecords(fx, stdout, id) {
  const out = [];
  let head = null;
  for (const rec of zRecords(fx, stdout)) {
    fx.tick();
    if (head === null) { head = rec; continue; }
    const m = DIFF_HEAD.exec(decodeStrict(head));
    head = null;
    if (!m || rec.length === 0) throw fail('object_corrupt', id);
    if (unsafePath(fx, rec)) throw fail('tree_path_unsafe', id);
    out.push(Object.freeze({ srcMode: m[1], dstMode: m[2], srcOid: m[3], dstOid: m[4], status: m[5], path: Buffer.from(rec) }));
  }
  if (head !== null) throw fail('object_corrupt', id);
  return Object.freeze(out);
}

// ------------------------------------------------------------------ verifyWorktree (v3 §2.3 + v3.1 R4, R5, R8)

/** Exclusions in the v1 sense (candidate-id.mjs:83): an exact path or a directory prefix; Buffers, relative, normalised. */
function exclusionList(fx, list) {
  if (!Array.isArray(list)) throw invalid();
  return list.map((x) => {
    const b = typeof x === 'string' ? B(x) : Buffer.isBuffer(x) ? Buffer.from(x) : null;
    const t = b && b.length > 1 && b.lastIndexOf(0x2f) === b.length - 1 ? b.subarray(0, b.length - 1) : b;
    if (!t || t.length === 0 || t.indexOf(0x2f) === 0 || unsafePath(fx, t) || t.indexOf(0) >= 0) throw invalid();
    return t;
  });
}
const excludedBy = (fx, ex) => (p) => ex.some((e) => { fx.tick(); return p.equals(e) || (p.length > e.length && p.subarray(0, e.length + 1).equals(Buffer.concat([e, SLASH]))); });

/** The v1 mode rule (candidate-id.mjs:118): any execute bit gives 100755. */
const fileMode = (s) => ((s.mode & 0o111) === 0 ? '100644' : '100755');
const special = (s) => s.isFIFO() || s.isSocket() || s.isBlockDevice() || s.isCharacterDevice();

/** sha1 of `blob <size>\0` + the file's bytes, read through O_NOFOLLOW|O_NONBLOCK in 1 MiB chunks; a change mid-read is worktree_unstable. */
function hashFile(fx, p, lst, spendBytes, op) {
  let fd;
  try { fd = fx.open(p); } catch (e) { if (expired(e)) throw e; throw fail('worktree_unstable', op); }
  try {
    const s = fx.fstat(fd);
    if (!s.isFile() || !sameNode(s, lst) || s.size !== lst.size) throw fail('worktree_unstable', op);
    const h = createHash('sha1').update(`blob ${s.size}\0`);
    const buf = Buffer.alloc(MIB);
    let n = 0;
    for (let got = 1; got > 0;) {
      got = fx.read(fd, buf, 0, MIB);
      n = n + got;
      if (n > s.size) throw fail('worktree_unstable', op);
      spendBytes(got);
      h.update(buf.subarray(0, got));
    }
    const after = fx.fstat(fd);
    if (n !== s.size || after.size !== s.size || !sameNode(after, s)) throw fail('worktree_unstable', op);
    return h.digest();
  } finally { fx.close(fd); }
}

/** Bytes with every CRLF pair turned into LF (diagnostic only: `eol_hint`, never used to accept); the deadline every 1,024 bytes. */
function crlfToLf(fx, b) {
  const parts = [];
  let at = 0;
  let prev = 0;
  for (let i = 0; i < b.length; i++) {
    if ((i & 1023) === 0) fx.check();
    const c = b[i];
    if (c === 10 && prev === 13) { parts.push(b.subarray(at, i - 1)); at = i; }
    prev = c;
  }
  parts.push(b.subarray(at));
  return Buffer.concat(parts);
}
const EOL_HINT_CAP = 64 * MIB;

/**
 * Is the tree at `dir` (a source's toplevel, or an absolute dir such as a lane) exactly `tree(oid)` from `store`?
 * A tree-driven walk hashes every tracked byte (no index, no stat cache); an index dir I under R lists untracked and
 * ignored entries with the tracked .gitignore files plus the copied <common>/info/exclude. Exclusions (v1) are
 * skipped on both sides. Refusals: tree_path_unsafe, worktree_entry_unsupported (FIFO, socket, device, a nested
 * `.git`), worktree_unstable, worktree_budget_exceeded (budgets and the deadline: every fs call, CPU work every 1,024
 * units, and a terminal check). Returns {equal, diffs: [{path, class, eol_hint?}], untracked, gitignoreUntracked,
 * infoExcludeSha256}; classes: content, mode, kind, missing, path_set, gitlink_populated.
 */
export function verifyWorktree(ctx, { source, dir, store, oid, exclusions = [], ...unknown } = {}) {
  const op = 'worktree.verify';
  const st = state(ctx, op);
  const fx = opFx(st, 'worktree_budget_exceeded', op);
  live(st, fx, op);
  const h = handleOf(store, 'store');
  if (Object.keys(unknown).length || !isOid(oid) || (source === undefined) === (dir === undefined) || h.ctx !== ctx) throw invalid();
  const s = source === undefined ? null : handleOf(source, 'source');
  if (s && s.ctx !== ctx) throw invalid();
  if (s === null && !isAbsPath(dir)) throw invalid();
  const top = s ? s.top : B(dir);
  if (s) recheckSource(fx, s, op);
  else if (!canonicalDir(fx, top)) throw invalid();
  const excluded = excludedBy(fx, exclusionList(fx, exclusions));
  const spendFiles = meter(st.maxFiles, 'worktree_budget_exceeded', op, fx);
  const spendBytes = meter(st.maxBytes, 'worktree_budget_exceeded', op, fx);
  const entries = op_(fx, st, h, 'tree.list', [oid]).filter((e) => { fx.tick(); return !excluded(e.path); });
  spendFiles(entries.length);
  const diffs = [];
  const diff = (path, cls, extra = {}) => diffs.push(Object.freeze({ path: Buffer.from(path), class: cls, ...extra }));
  // Directory structure from the tree: dir key -> {files, dirs}. Each directory node is created once (linear).
  const dirs = new Map([[hexKey(EMPTY), { path: EMPTY, files: [], dirs: [] }]]);
  const parentOf = (q) => { const cut = q.lastIndexOf(0x2f); return cut < 0 ? EMPTY : q.subarray(0, cut); };
  const baseName = (q) => q.subarray(q.lastIndexOf(0x2f) + 1);
  const ensureDir = (p) => {
    const chain = [];
    for (let q = p; !dirs.has(hexKey(q)); q = parentOf(q)) { fx.tick(); chain.push(q); }
    for (const q of chain.reverse()) {
      dirs.get(hexKey(parentOf(q))).dirs.push(baseName(q));
      dirs.set(hexKey(q), { path: q, files: [], dirs: [] });
    }
    return dirs.get(hexKey(p));
  };
  for (const e of entries) { fx.tick(); ensureDir(parentOf(e.path)).files.push({ name: baseName(e.path), entry: e }); }
  const absOf = (rel) => (rel.length ? join(top, rel) : top);
  const untrackedDirs = [];
  for (const queue = [EMPTY]; queue.length;) {
    const rel = queue.shift();
    const node = dirs.get(hexKey(rel));
    const names = listDir(fx, absOf(rel), spendFiles);
    const present = new Set(names.map(hexKey));
    for (const n of names) { fx.tick(); if (isDotGit(n) && (rel.length > 0 || !n.equals(B('.git')))) throw fail('worktree_entry_unsupported', op); }
    const childRel = (name) => (rel.length ? Buffer.concat([rel, SLASH, name]) : name);
    // Untracked (or ignored) directories here are scanned for a nested .git below (R5: tracked dir or not).
    const tracked = new Set([...node.dirs, ...node.files.map((f) => f.name)].map(hexKey));
    for (const n of names) {
      if (tracked.has(hexKey(n)) || isDotGit(n) || excluded(childRel(n))) continue;
      const us = fx.lstatOrNull(absOf(childRel(n)));
      if (us && us.isDirectory() && !us.isSymbolicLink()) untrackedDirs.push(childRel(n));
    }
    // A tracked name must be listed byte-exactly; an absent gitlink is clean (an unpopulated submodule).
    const here = (name, gitlink = false) => {
      if (present.has(hexKey(name))) return true;
      const found = fx.lstatOrNull(absOf(childRel(name)));
      if (!(gitlink && !found)) diff(childRel(name), found ? 'path_set' : 'missing');
      return false;
    };
    for (const name of node.dirs) {
      if (!here(name)) continue;
      const crel = childRel(name);
      const cs = fx.lstatOrNull(absOf(crel));
      if (!cs) { diff(crel, 'missing'); continue; }
      if (cs.isSymbolicLink() || !cs.isDirectory()) { if (special(cs)) throw fail('worktree_entry_unsupported', op); diff(crel, 'kind'); continue; }
      queue.push(crel);
    }
    for (const { name, entry } of node.files) {
      if (!here(name, entry.mode === '160000')) continue;
      checkEntry(fx, st, h, entry, absOf(entry.path), { diff, spendFiles, spendBytes, op });
    }
  }
  for (const queue = untrackedDirs; queue.length;) {
    const rel = queue.shift();
    for (const n of listDir(fx, absOf(rel), spendFiles)) {
      if (isDotGit(n)) throw fail('worktree_entry_unsupported', op);
      const crel = Buffer.concat([rel, SLASH, n]);
      const cs = fx.lstatOrNull(absOf(crel));
      if (cs && cs.isDirectory() && !cs.isSymbolicLink() && !excluded(crel)) queue.push(crel);
    }
  }
  const others = untrackedLists(fx, st, h, top, s, oid);
  const untracked = others.untracked.filter((p) => { fx.tick(); return !excluded(p); });
  const gitignoreUntracked = others.ignored.filter((p) => { fx.tick(); return !excluded(p) && p.subarray(p.lastIndexOf(0x2f) + 1).equals(B('.gitignore')); });
  if (s) recheckSource(fx, s, op);
  live(st, fx, op);
  fx.done();
  return Object.freeze({
    equal: diffs.length === 0 && untracked.length === 0 && gitignoreUntracked.length === 0,
    diffs: Object.freeze(diffs), untracked: Object.freeze(untracked), gitignoreUntracked: Object.freeze(gitignoreUntracked),
    infoExcludeSha256: s ? s.excludeSha256 : null,
  });
}
/** A raw-object row from inside the lib (same checks as op()), on the caller's gateway. */
function op_(fx, st, h, id, operands) {
  if (!sameNode(fx.lstatOrNull(h.storeDir), h.stat)) throw fail('context_tampered', id);
  checkStore(fx, h.storeDir, id);
  if (id === 'tree.list') return listTree(fx, st, h, operands);
  return verifiedBlob(git(fx, st, id, h.storePath, operands).stdout, operands[0], id);
}

function checkEntry(fx, st, h, e, abs, { diff, spendFiles, spendBytes, op }) {
  const lst = fx.lstatOrNull(abs);
  if (!lst) return diff(e.path, 'missing');
  if (special(lst)) throw fail('worktree_entry_unsupported', op);
  if (e.mode === '160000') {
    if (lst.isDirectory()) { if (hasEntry(fx, abs, spendFiles)) diff(e.path, 'gitlink_populated'); return undefined; }
    return diff(e.path, 'kind');
  }
  if (e.mode === '120000') {
    if (!lst.isSymbolicLink()) return diff(e.path, 'kind');
    const target = fx.readLink(abs);
    spendBytes(target.length);
    return blobHash(target).equals(Buffer.from(e.oid, 'hex')) ? undefined : diff(e.path, 'content');
  }
  if (!lst.isFile()) return diff(e.path, 'kind');
  const sum = hashFile(fx, abs, lst, spendBytes, op);
  if (!sum.equals(Buffer.from(e.oid, 'hex'))) diff(e.path, 'content', { eol_hint: eolHint(fx, st, h, e, abs, lst, op) });
  if (fileMode(lst) !== e.mode) diff(e.path, 'mode');
  return undefined;
}
/** True when the worktree bytes and the blob are equal once CRLF pairs become LF (both bounded; diagnostic only; expiry stays an expiry). */
function eolHint(fx, st, h, e, abs, lst, op) {
  if (lst.size > EOL_HINT_CAP) return false;
  let work;
  try { work = readBounded(fx, abs, EOL_HINT_CAP, op); } catch (err) { if (expired(err)) throw err; return false; }
  const blob = op_(fx, st, h, 'blob.read', [e.oid]);
  return blob.length <= EOL_HINT_CAP && !work.equals(blob) && crlfToLf(fx, work).equals(crlfToLf(fx, blob));
}

/** Untracked and ignored entries under `top`, listed by ls-files on a fresh index dir I (alternates = the store). */
function untrackedLists(fx, st, h, top, s, oid) {
  const I = libGitDir(fx, st, 'I-', INDEX_CONFIG, oid, join(h.storeDir, B('objects')));
  const Is = str(I);
  const excludeFrom = s ? str(s.excludeCopy) : `${Is}/tmp/empty-exclude`;
  if (!s) fx.writeNew(B(excludeFrom), '');
  git(fx, st, 'worktree.read', Is, [oid]);
  const tops = str(top);
  const list = (id) => zRecords(fx, git(fx, st, id, Is, [excludeFrom], { workTree: tops }).stdout).map((p) => { fx.tick(); return Buffer.from(p); });
  const untracked = list('worktree.others').map((p) => (p.lastIndexOf(0x2f) === p.length - 1 ? p.subarray(0, p.length - 1) : p));
  const ignored = list('worktree.ignored');
  removeTree(recovery(fx, st, 'worktree.verify'), I, st.rootStat.dev, st.removeEntries);
  return { untracked, ignored };
}

// ------------------------------------------------------------------ bounded removal (v3.1 R1) of lib-created dirs only

/**
 * Remove `root` (a lib-created dir) without following links, on the removal gateway `gx` (its own deadline, code
 * lane_remove_failed): an iterative lstat walk restores u+w on owned directories on the root's device, unlinks
 * entries one at a time and removes directories bottom-up. Every fs call (lstat, chmod, opendir, each read, unlink,
 * rmdir) checks the deadline; `budget` bounds the entries. Any failure is lane_remove_failed (the caller quarantines).
 */
function removeTree(gx, root, dev, budget) {
  const spend = meter(budget, 'lane_remove_failed', 'remove', gx);
  try { removeTreeRaw(gx, root, dev, spend); } catch (e) { if (expired(e)) throw e; if (e instanceof GitError && e.code === 'lane_remove_failed') throw e; throw fail('lane_remove_failed', 'remove'); }
}
function removeTreeRaw(gx, root, dev, spend) {
  const order = [];
  for (const queue = [root]; queue.length;) {
    const d = queue.shift();
    const ds = gx.lstat(d);
    if (!ds.isDirectory() || ds.dev !== dev || ds.uid !== uid()) throw fail('lane_remove_failed', 'remove');
    if ((ds.mode & 0o700) !== 0o700) gx.chmod(d, (ds.mode & 0o7777) | 0o700);
    order.push(d);
    for (const name of listDir(gx, d, spend)) {
      const p = join(d, name);
      const s = gx.lstat(p);
      if (s.isDirectory() && !s.isSymbolicLink()) queue.push(p);
      else { spend(1); gx.unlink(p); }
    }
  }
  for (const d of order.reverse()) { spend(1); gx.rmdir(d); }
}
