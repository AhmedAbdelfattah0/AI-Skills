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
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GitError, composeEnv, decodeStrict, gitRunner, hermeticPolicy, zSplit } from './git-exec.mjs';
import { GitCapabilityError } from './git-capability.mjs';

const fail = (code, op) => new GitError(code, { op });
const invalid = () => fail('git_op_invalid');
const OID = /^[0-9a-f]{40}$/;
const MIB = 1024 * 1024;
const SLASH = Buffer.from('/');
const EMPTY = Buffer.alloc(0);
const RD_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

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
/** lstat, null when absent; any other failure (EACCES, ELOOP, ...) is a typed refusal, never a raw fs error. */
const lstatOrNull = (p) => { try { return lstatSync(p); } catch (e) { if (missing(e)) return null; throw fail('worktree_entry_unsupported', 'lstat'); } };
const sameNode = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
/** `child` equals or lies under `parent` (both realpath Buffers): a component-wise byte compare. */
const inside = (child, parent) => child.equals(parent) || (child.length > parent.length && child.subarray(0, parent.length + 1).equals(Buffer.concat([parent, SLASH])));
/** A lossless Map key for path bytes (hex; never displayed, never compared with text). */
const hexKey = (b) => b.toString('hex');
/** The one exclusive directory create of the lib: non-recursive, mode 0700. */
const mkdir0700 = (p) => mkdirSync(p, 0o700);
const writeNew = (p, data) => writeFileSync(p, data, { flag: 'wx', mode: 0o600 });
// The prefix is passed as a (strict-decoded) string: Node 18.20.8 mkdtempSync throws a TypeError on a Buffer prefix (MEASURED).
const tempDir = (parent, prefix) => mkdtempSync(`${str(parent)}/${prefix}`, { encoding: 'buffer' });

/** A counter that throws `code` once its total passes `cap` or the clock passes `deadline`: every charge checks both. */
/** The deadline check of a per-entry loop (each iteration does filesystem work: lstat, open, read). */
const due = (deadline, code, op) => { if (Date.now() > deadline) throw fail(code, op); };
const meter = (cap, code, op, deadline = Infinity) => { let n = 0; return (k) => { n = n + k; if (n > cap || Date.now() > deadline) throw fail(code, op); return n; }; };

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
 * spawn or write (OC-4); an unqualified cell refuses after the probe and before any write (OC-5).
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
  const R = tempDir(realpathSync.native(tmp, { encoding: 'buffer' }), 'ship-ticket-git-');
  const rst = lstatSync(R);
  if (!realpathSync.native(R, { encoding: 'buffer' }).equals(R) || !rst.isDirectory() || rst.uid !== uid()) throw fail('owned_dir_invalid', 'context.create');
  for (const d of ['hooks', 'home', 'cwd', 'template']) mkdir0700(join(R, B(d)));
  writeNew(join(R, B('empty.gitconfig')), '');
  const Rs = str(R);
  const env = composeEnv({ ambient: process.env, gitInfo: runner.info, hooksDir: `${Rs}/hooks`, policy: hermeticPolicy({ home: `${Rs}/home`, globalConfig: `${Rs}/empty.gitconfig` }) });
  const ctx = Object.freeze({ dispose: () => disposeContext(ctx) });
  CTX.set(ctx, Object.freeze({ root: R, rootPath: Rs, rootStat: rst, runner, env, cell, timeoutMs, maxFiles, maxBytes, maxObjectBytes, maxTotalObjectBytes, removeEntries, maxObjects }));
  return ctx;
}

/** The live state of a context: refused once disposed, or when R/hooks is not empty or R was replaced (context_tampered). */
function live(ctx, op) {
  const st = CTX.get(ctx);
  if (!st) throw invalid();
  if (DISPOSED.has(ctx)) throw fail('context_disposed', op);
  const now = lstatOrNull(st.root);
  let hooks = null;
  try { hooks = listDir(join(st.root, B('hooks')), () => 0); } catch { hooks = null; }
  if (!sameNode(now, st.rootStat) || hooks === null || hooks.length !== 0) throw fail('context_tampered', op);
  return st;
}
function disposeContext(ctx) {
  const st = CTX.get(ctx);
  if (!st || DISPOSED.has(ctx)) return;
  DISPOSED.add(ctx);
  // Only the R this context created is removed: a replaced R (another inode) is left alone and reported.
  if (!sameNode(lstatOrNull(st.root), st.rootStat)) throw fail('context_tampered', 'context.dispose');
  removeTree(st.root, st.rootStat.dev, st.removeEntries, Date.now() + st.timeoutMs);
}
/** An existing directory whose realpath is itself (no symlink anywhere in its chain). */
function canonicalDir(p) {
  try { return realpathSync.native(p, { encoding: 'buffer' }).equals(p) && lstatSync(p).isDirectory(); } catch { return false; }
}
const handleOf = (h, kind) => { const s = HANDLES.get(h); if (!s || s.kind !== kind) throw invalid(); return s; };

// ------------------------------------------------------------------ bounded host reads (v3.1 R4)

/** Directory names as Buffers, one entry at a time, each charged to `spend` (no readdirSync: no full allocation first). */
function listDir(p, spend) {
  let d;
  try { d = opendirSync(p, { encoding: 'buffer' }); } catch { throw fail('worktree_entry_unsupported', 'listdir'); }
  const names = [];
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) { spend(1); names.push(e.name); }
  } finally { d.closeSync(); }
  return names;
}

/** Whether a directory has any entry: one bounded read, charged one entry (a populated gitlink is never enumerated). */
function hasEntry(p, spend) {
  let d;
  try { d = opendirSync(p, { encoding: 'buffer' }); } catch { throw fail('worktree_entry_unsupported', 'listdir'); }
  try { const e = d.readSync(); spend(1); return e !== null; } finally { d.closeSync(); }
}

/** A regular file owned by the uid, at most `cap` bytes, read through a descriptor that matches the lstat. */
function readBounded(p, cap, op) {
  const before = lstatSync(p);
  if (!before.isFile()) throw fail('worktree_entry_unsupported', op);
  if (before.uid !== uid()) throw fail('repo_owner_mismatch', op);
  let fd;
  try { fd = openSync(p, RD_FLAGS); } catch { throw fail('worktree_entry_unsupported', op); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || !sameNode(s, before) || s.uid !== uid()) throw fail('worktree_entry_unsupported', op);
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (let got = 1; got > 0 && n <= cap;) { got = readSync(fd, buf, n, cap + 1 - n, null); n = n + got; }
    if (n > cap) throw fail('worktree_entry_unsupported', op);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

/** `gitdir: <path>` / `<path>` (commondir), one line, strict UTF-8, resolved against `base`, as a realpath Buffer. */
function pointer(bytes, base, prefix, op) {
  const text = decodeStrict(bytes, 'path_not_utf8');
  const line = text.endsWith('\n') ? text.slice(0, text.length - 1) : text;
  if (!line.startsWith(prefix) || line.length === prefix.length || /[\x00-\x1f\x7f]/.test(line)) throw fail('repo_layout_unsupported', op);
  const target = line.slice(prefix.length);
  const p = target.startsWith('/') ? B(target) : join(base, B(target));
  try { return realpathSync.native(p, { encoding: 'buffer' }); } catch { throw fail('repo_layout_unsupported', op); }
}

function ownedDir(p, op) {
  const s = lstatOrNull(p);
  if (!s || !s.isDirectory()) throw fail('repo_layout_unsupported', op);
  if (s.uid !== uid()) throw fail('repo_owner_mismatch', op);
  return s;
}

// ------------------------------------------------------------------ openSource: filesystem bootstrap, no spawn (v3 §2.1)

/**
 * The builder repository at `toplevel`: `.git` is a directory, or a gitfile (<= 4 KiB) naming one, whose optional
 * `commondir` (<= 4 KiB) names the common dir. Shallow, grafts and alternates refuse; toplevel, git dir, common dir and
 * objects must be owned by the uid; their (dev, ino) are re-checked later. `<common>/info/exclude` (<= 1 MiB) is copied
 * into R. Nothing is spawned and nothing in the builder repository is written.
 */
export function openSource(ctx, { toplevel, ...unknown } = {}) {
  const op = 'source.open';
  const st = live(ctx, op);
  if (Object.keys(unknown).length || !isAbsPath(toplevel)) throw invalid();
  let top;
  try { top = realpathSync.native(toplevel, { encoding: 'buffer' }); } catch { throw fail('repo_layout_unsupported', op); }
  const tst = ownedDir(top, op);
  const dotgit = join(top, B('.git'));
  const ds = lstatOrNull(dotgit);
  if (!ds || !(ds.isDirectory() || ds.isFile())) throw fail('repo_layout_unsupported', op);
  const gitDir = ds.isDirectory() ? realpathSync.native(dotgit, { encoding: 'buffer' }) : pointer(readBounded(dotgit, 4096, op), top, 'gitdir: ', op);
  const gst = ownedDir(gitDir, op);
  const cd = join(gitDir, B('commondir'));
  const common = lstatOrNull(cd) ? pointer(readBounded(cd, 4096, op), gitDir, '', op) : gitDir;
  const cst = ownedDir(common, op);
  const objects = join(common, B('objects'));
  const ost = ownedDir(objects, op);
  if (lstatOrNull(join(common, B('shallow')))) throw fail('shallow_unsupported', op);
  if (lstatOrNull(join(common, B('info/grafts')))) throw fail('grafts_present', op);
  if (alternatesPresent(objects)) throw fail('alternates_present', op);
  if ([top, common].some((d) => inside(st.root, d))) throw fail('owned_dir_invalid', op);
  const ex = join(common, B('info/exclude'));
  const exBytes = lstatOrNull(ex) ? readBounded(ex, MIB, op) : EMPTY;
  const exDir = tempDir(st.root, 'x-');
  const excludeCopy = join(exDir, B('info-exclude'));
  writeNew(excludeCopy, exBytes);
  const handle = Object.freeze({});
  HANDLES.set(handle, Object.freeze({
    kind: 'source', ctx, top, common, objects, excludeCopy, checks: Object.freeze([[top, tst], [gitDir, gst], [common, cst], [objects, ost]]),
    excludeSha256: exBytes.length ? createHash('sha256').update(exBytes).digest('hex') : null,
  }));
  return handle;
}
const alternatesPresent = (objects) => ['info/alternates', 'info/http-alternates'].some((f) => lstatOrNull(join(objects, B(f))) !== null);
/** The source's dirs are the same inodes as at open, and still carry no alternates (context_tampered otherwise). */
function recheckSource(s, op) {
  if (!s.checks.every(([p, before]) => sameNode(lstatOrNull(p), before)) || alternatesPresent(s.objects)) throw fail('context_tampered', op);
}

// ------------------------------------------------------------------ the store (v3 §2.2 + v3.1 R2): the only write path

const STORE_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tcommitGraph = false\n\tmultiPackIndex = false\n[gc]\n\tauto = 0\n';
const VIEW_CONFIG = `${STORE_CONFIG}[pack]\n\tuseBitmaps = false\n\treadReverseIndex = false\n\tthreads = 1\n`;
const INDEX_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tcommitGraph = false\n\tmultiPackIndex = false\n\tuntrackedCache = false\n\tsparseCheckout = false\n\tsymlinks = true\n\tignorecase = false\n\tprecomposeUnicode = false\n[gc]\n\tauto = 0\n';
const STORE_MARKER = 'ship-ticket-store v1\n';

/** One spawn of a row on a lib git dir, bounded by the deadline. */
function git(st, id, gitDir, operands, { workTree, stdin, deadline, maxBuffer = 64 * MIB } = {}) {
  const r = OPS.get(id);
  if ((r.stdin === null) !== (stdin === undefined)) throw invalid();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw fail('git_timeout', id);
  const pre = gitDir === null ? [] : [`--git-dir=${gitDir}`, ...(workTree === undefined ? [] : [`--work-tree=${workTree}`])];
  return st.runner.run({ args: [...pre, ...argvOf(r, operands)], cwd: `${st.rootPath}/cwd`, env: st.env, op: id, status: r.status, stdin, timeoutMs: remaining, maxBuffer });
}
/** A failed ingest row means the objects cannot be read as claimed (missing, corrupt, unparseable): object_corrupt. */
const corruptOnFail = (fn, id) => { try { return fn(); } catch (e) { if (e instanceof GitError && e.code === 'git_failed') throw fail('object_corrupt', id); throw e; } };
/** Newline-terminated output lines (strict UTF-8); a missing final newline is object_corrupt. */
function lines(stdout, op) {
  const t = decodeStrict(stdout);
  if (t === '') return [];
  if (!t.endsWith('\n')) throw fail('object_corrupt', op);
  return t.slice(0, t.length - 1).split('\n');
}
/** The data-only stdin form of git-exec (oid strings, at most 99 per call): the runner builds the bytes. */
const oidChunks = (oids) => { const out = []; for (let i = 0; i < oids.length; i = i + 99) out.push(Object.freeze({ kind: 'oid-lines', oids: Object.freeze(oids.slice(i, i + 99)) })); return out; };

/** A lib git dir under R: lib-written config, HEAD = oid, alternates = `objects` (an absolute realpath Buffer). */
function libGitDir(st, prefix, config, oid, objects) {
  const d = tempDir(st.root, prefix);
  writeNew(join(d, B('config')), config);
  writeNew(join(d, B('HEAD')), `${oid}\n`);
  for (const x of ['objects', 'objects/info', 'objects/pack', 'refs', 'tmp']) mkdir0700(join(d, B(x)));
  writeNew(join(d, B('objects/info/alternates')), `${str(objects)}\n`);
  return d;
}

/**
 * Fill a fresh hermetic bare store at `dir` (must not exist; created here, exclusively) with every object reachable
 * from `oids` ([head] or [head, base]) in the source: sizes checked before packing (R2), pack-objects in a lib view V
 * over the builder's object files, producer .idx/.rev dropped, index-pack re-hashes every object into the store,
 * rev-list proves connectivity, refs/pin/{head,base} are set. On any failure the dir is quarantined and removed with
 * bounded work; if that removal fails it stays quarantined and the error is lane_remove_failed.
 */
export function initStore(ctx, { dir, source, oids, ...unknown } = {}) {
  const op = 'store.init';
  const st = live(ctx, op);
  const s = handleOf(source, 'source');
  if (Object.keys(unknown).length || !isAbsPath(dir) || !Array.isArray(oids) || oids.length < 1 || oids.length > 2 || !oids.every(isOid) || s.ctx !== ctx) throw invalid();
  const [head, base = oids[0]] = oids;
  const D = B(dir);
  const parent = D.subarray(0, D.lastIndexOf(0x2f) || 1);
  let real;
  try { real = realpathSync.native(parent, { encoding: 'buffer' }); } catch { throw fail('owned_dir_invalid', op); }
  if (!real.equals(parent) || [s.top, s.common, st.root].some((x) => inside(D, x) || inside(x, D)) || lstatOrNull(D)) throw fail('owned_dir_invalid', op);
  try { mkdir0700(D); } catch { throw fail('owned_dir_invalid', op); }
  const created = lstatSync(D);
  const deadline = Date.now() + st.timeoutMs;
  try {
    ingest(st, s, D, created, dir, head, base, deadline);
  } catch (e) {
    discard(st, D, created, parent, deadline);
    throw e;
  }
  return storeHandle(ctx, D, op);
}

function ingest(st, s, D, dst, dir, head, base, deadline) {
  git(st, 'store.init', null, [`${st.rootPath}/template`, dir], { deadline });
  unlinkSync(join(D, B('config')));
  writeNew(join(D, B('config')), STORE_CONFIG);
  writeNew(join(D, B('ship-ticket-store')), STORE_MARKER);
  const V = libGitDir(st, 'V-', VIEW_CONFIG, head, s.objects);
  const Vs = str(V);
  // R2: every reachable object's inflated size, before any pack is parsed or written.
  const all = lines(corruptOnFail(() => git(st, 'store.walk', Vs, [head, base], { deadline }).stdout, 'store.walk'), 'store.walk');
  if (!all.every(isOid)) throw fail('object_corrupt', 'store.walk');
  if (all.length > st.maxObjects) throw fail('object_too_large', 'store.walk');
  const total = meter(st.maxTotalObjectBytes, 'object_too_large', 'store.sizes');
  for (const chunk of oidChunks(all)) {
    const sizes = lines(corruptOnFail(() => git(st, 'store.sizes', Vs, [], { stdin: chunk, deadline }).stdout, 'store.sizes'), 'store.sizes');
    if (sizes.length !== chunk.oids.length) throw fail('object_corrupt', 'store.sizes');
    for (const l of sizes) {
      const m = /^(\d{1,15}) (\d{1,15})$/.exec(l);
      if (!m) throw fail('object_corrupt', 'store.sizes');
      if (+m[1] > st.maxObjectBytes) throw fail('object_too_large', 'store.sizes');
      total(+m[1]);
    }
  }
  const tips = Object.freeze({ kind: 'oid-lines', oids: Object.freeze(head === base ? [head] : [head, base]) });
  const out = lines(corruptOnFail(() => git(st, 'store.pack', Vs, [`${Vs}/tmp/p`], { stdin: tips, deadline }).stdout, 'store.pack'), 'store.pack');
  if (out.length !== 1 || !isOid(out[0])) throw fail('object_corrupt', 'store.pack');
  const produced = join(V, B(`tmp/p-${out[0]}.pack`));
  for (const ext of ['idx', 'rev']) { const f = join(V, B(`tmp/p-${out[0]}.${ext}`)); if (lstatOrNull(f)) unlinkSync(f); }
  const pst = lstatSync(produced);
  if (!pst.isFile() || pst.size > st.maxTotalObjectBytes) throw fail('object_too_large', 'store.pack');
  const packPath = `${dir}/objects/pack/pack-${out[0]}.pack`;
  copyFileSync(produced, B(packPath), constants.COPYFILE_EXCL);
  unlinkSync(produced);
  corruptOnFail(() => git(st, 'store.index', dir, [st.maxTotalObjectBytes, packPath], { deadline }), 'store.index');
  corruptOnFail(() => git(st, 'store.connect', dir, [head, base], { deadline }), 'store.connect');
  git(st, 'store.pin', dir, ['head', head], { deadline });
  git(st, 'store.pin', dir, ['base', base], { deadline });
  removeTree(V, st.rootStat.dev, st.removeEntries, deadline);
  recheckSource(s, 'store.init');
  if (!sameNode(lstatOrNull(D), dst)) throw fail('context_tampered', 'store.init');
  checkStore(D, 'store.init');
}

/** The failure path of a lib-created dir: rename into `<parent>/.quarantine/`, then bounded removal (v3 §2.6, v3.1 R1). */
function discard(st, D, created, parent, deadline) {
  // Only the dir this call created is ever moved or removed: a replacement (another inode or owner) is left alone.
  const now = lstatOrNull(D);
  if (!sameNode(now, created) || !now.isDirectory() || now.uid !== uid()) throw fail('context_tampered', 'store.init');
  const q = join(parent, B('.quarantine'));
  try {
    const qs = lstatOrNull(q);
    if (!qs) mkdir0700(q);
    else if (!qs.isDirectory() || qs.uid !== uid()) throw fail('lane_remove_failed', 'store.init');
    const slot = tempDir(q, 'store-');
    const moved = join(slot, B('store'));
    renameSync(D, moved);
    removeTree(slot, lstatSync(slot).dev, st.removeEntries, deadline + st.timeoutMs);
  } catch { throw fail('lane_remove_failed', 'store.init'); }
}

/** The store is still the lib's: marker, lib config bytes, no alternates, grafts or shallow (context_tampered otherwise). */
function checkStore(D, op) {
  const okBytes = (name, want) => { try { return readBounded(join(D, B(name)), 4096, op).equals(B(want)); } catch { return false; } };
  if (!okBytes('config', STORE_CONFIG) || !okBytes('ship-ticket-store', STORE_MARKER) || alternatesPresent(join(D, B('objects')))
    || lstatOrNull(join(D, B('info/grafts'))) || lstatOrNull(join(D, B('shallow')))) throw fail('context_tampered', op);
}
function storeHandle(ctx, D, op) {
  const handle = Object.freeze({});
  HANDLES.set(handle, Object.freeze({ kind: 'store', ctx, storeDir: D, storePath: str(D), stat: lstatSync(D) }));
  return handle;
}

/** A store an earlier initStore made (any context): its realpath, owner, marker and lib config must hold. Read-only. */
export function openStore(ctx, { dir, ...unknown } = {}) {
  const op = 'store.open';
  live(ctx, op);
  if (Object.keys(unknown).length || !isAbsPath(dir)) throw invalid();
  const D = B(dir);
  let real;
  try { real = realpathSync.native(D, { encoding: 'buffer' }); } catch { throw fail('owned_dir_invalid', op); }
  const ds = lstatOrNull(D);
  if (!real.equals(D) || !ds || !ds.isDirectory() || ds.uid !== uid()) throw fail('owned_dir_invalid', op);
  try { checkStore(D, op); } catch { throw fail('owned_dir_invalid', op); }
  return storeHandle(ctx, D, op);
}

// ------------------------------------------------------------------ raw-object rows on a store

/**
 * `op(store, '<literal id>', [oid, ...])` for the raw-object rows. Returns: blob.read a Buffer (hash-verified),
 * tree.list frozen {mode, type, oid, path: Buffer} entries (every path checked, R6), tree.diff frozen records,
 * commit.resolve / commit.tree an oid or null, merge.base {bases, base} (base only when exactly one), object.exists a boolean.
 */
export function op(handle, id, operands = []) {
  const r = OPS.get(id);
  if (!r || r.policy !== 'raw-object' || !Array.isArray(operands)) throw invalid();
  const h = handleOf(handle, 'store');
  const st = live(h.ctx, id);
  if (!sameNode(lstatOrNull(h.storeDir), h.stat)) throw fail('context_tampered', id);
  checkStore(h.storeDir, id);
  const deadline = Date.now() + st.timeoutMs;
  if (id === 'tree.list') return listTree(st, h, operands, deadline);
  const res = git(st, id, h.storePath, operands, { deadline });
  const oid = operands[0];
  if (id === 'blob.read') return verifiedBlob(res.stdout, oid, id);
  if (id === 'tree.diff') return diffRecords(res.stdout, id);
  if (id === 'object.exists') return res.outcome === 'ok';
  const found = lines(res.stdout, id);
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

/** A path from a tree: no empty, `.`, `..` or `.git` (any case) component. */
function unsafePath(p) {
  const parts = [];
  let at = 0;
  for (let i = 0; i <= p.length; i++) if (i === p.length || p[i] === 0x2f) { parts.push(p.subarray(at, i)); at = i + 1; }
  return parts.some((c) => c.length === 0 || c.equals(B('.')) || c.equals(B('..')) || isDotGit(c));
}
const isDotGit = (c) => c.length === 4 && c[0] === 0x2e && (c[1] | 0x20) === 0x67 && (c[2] | 0x20) === 0x69 && (c[3] | 0x20) === 0x74;

/**
 * tree.list: `ls-tree -r -t` records, every entry checked (R6), then the RAW bytes of every tree involved (the root and
 * each subtree, through `cat-file --batch` in <= 99-oid batches) so an entry NAME holding a slash, which ls-tree prints
 * exactly like a subtree path, is refused. Returns the non-tree entries.
 */
function listTree(st, h, operands, deadline) {
  const id = 'tree.list';
  const all = treeEntries(git(st, id, h.storePath, operands, { deadline }).stdout, id);
  const root = lines(git(st, 'commit.tree', h.storePath, operands, { deadline }).stdout, id);
  if (root.length !== 1 || !isOid(root[0])) throw fail('object_corrupt', id);
  const trees = [root[0], ...all.filter((e) => e.type === 'tree').map((e) => e.oid)];
  for (const chunk of oidChunks(trees)) rawTrees(git(st, 'tree.raw', h.storePath, [], { stdin: chunk, deadline }).stdout, chunk.oids.length, id);
  return Object.freeze(all.filter((e) => e.type !== 'tree'));
}
const NL = Buffer.from('\n');
/** `cat-file --batch` output: exactly one `<oid> tree <size>` object per asked oid, each tree's entries checked. */
function rawTrees(buf, asked, id) {
  let objects = 0;
  for (let at = 0; at < buf.length;) {
    const nl = buf.indexOf(0x0a, at);
    const m = nl < 0 ? null : /^([0-9a-f]{40}) tree (\d{1,10})$/.exec(decodeStrict(buf.subarray(at, nl)));
    if (!m) throw fail('object_corrupt', id);
    const end = nl + 1 + +m[2];
    if (end >= buf.length || !buf.subarray(end, end + 1).equals(NL)) throw fail('object_corrupt', id);
    rawTreeNames(buf.subarray(nl + 1, end), id);
    at = end + 1;
    objects = objects + 1;
  }
  if (objects !== asked) throw fail('object_corrupt', id);
}
/** Raw tree entries `<mode> <name>\0<20-byte oid>`: a name holding a slash, or an unsafe component, refuses. */
function rawTreeNames(t, id) {
  for (let at = 0; at < t.length;) {
    const sp = t.indexOf(0x20, at);
    const nul = sp < 0 ? sp : t.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > t.length) throw fail('object_corrupt', id);
    const name = t.subarray(sp + 1, nul);
    if (name.indexOf(0x2f) >= 0 || unsafePath(name)) throw fail('tree_path_unsafe', id);
    at = nul + 21;
  }
}

const ENTRY_HEAD = /^(100644|100755|120000|160000|040000) (blob|commit|tree) ([0-9a-f]{40})$/;
const typeOfMode = (m) => (m === '160000' ? 'commit' : m === '040000' ? 'tree' : 'blob');
/** ls-tree -r -t -z records. Every entry is checked (no last-wins): unsafe components, duplicates, a path whose parent is no tree entry, and a non-tree entry that is a prefix of another path refuse (R6). */
function treeEntries(stdout, id) {
  const out = [];
  for (const rec of zSplit(stdout)) {
    const tab = rec.indexOf(0x09);
    if (tab < 0) throw fail('object_corrupt', id);
    const m = ENTRY_HEAD.exec(decodeStrict(rec.subarray(0, tab)));
    if (!m || typeOfMode(m[1]) !== m[2]) throw fail('object_corrupt', id);
    const path = Buffer.from(rec.subarray(tab + 1));
    if (unsafePath(path)) throw fail('tree_path_unsafe', id);
    out.push(Object.freeze({ mode: m[1], type: m[2], oid: m[3], path }));
  }
  const seen = new Set();
  const leaves = new Set();
  for (const e of out) {
    if (seen.has(hexKey(e.path))) throw fail('tree_path_unsafe', id);
    seen.add(hexKey(e.path));
    if (e.type !== 'tree') leaves.add(hexKey(e.path));
  }
  for (const e of out) for (const pre of prefixes(e.path)) if (leaves.has(hexKey(pre)) || !seen.has(hexKey(pre))) throw fail('tree_path_unsafe', id);
  return Object.freeze(out);
}
/** Every proper directory prefix of a path (`a/b/c` gives `a`, `a/b`). */
const prefixes = (p) => { const out = []; for (let i = 0; i < p.length; i++) if (p[i] === 0x2f) out.push(p.subarray(0, i)); return out; };

const DIFF_HEAD = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/;
function diffRecords(stdout, id) {
  const out = [];
  let head = null;
  for (const rec of zSplit(stdout)) {
    if (head === null) { head = rec; continue; }
    const m = DIFF_HEAD.exec(decodeStrict(head));
    head = null;
    if (!m || rec.length === 0) throw fail('object_corrupt', id);
    if (unsafePath(rec)) throw fail('tree_path_unsafe', id);
    out.push(Object.freeze({ srcMode: m[1], dstMode: m[2], srcOid: m[3], dstOid: m[4], status: m[5], path: Buffer.from(rec) }));
  }
  if (head !== null) throw fail('object_corrupt', id);
  return Object.freeze(out);
}

// ------------------------------------------------------------------ verifyWorktree (v3 §2.3 + v3.1 R4, R5, R8)

/** Exclusions in the v1 sense (candidate-id.mjs:83): an exact path or a directory prefix; Buffers, relative, normalised. */
function exclusionList(list) {
  if (!Array.isArray(list)) throw invalid();
  return list.map((x) => {
    const b = typeof x === 'string' ? B(x) : Buffer.isBuffer(x) ? Buffer.from(x) : null;
    const t = b && b.length > 1 && b.lastIndexOf(0x2f) === b.length - 1 ? b.subarray(0, b.length - 1) : b;
    if (!t || t.length === 0 || t.indexOf(0x2f) === 0 || unsafePath(t) || t.indexOf(0) >= 0) throw invalid();
    return t;
  });
}
const excludedBy = (ex) => (p) => ex.some((e) => p.equals(e) || (p.length > e.length && p.subarray(0, e.length + 1).equals(Buffer.concat([e, SLASH]))));

/** The v1 mode rule (candidate-id.mjs:118): any execute bit gives 100755. */
const fileMode = (s) => ((s.mode & 0o111) === 0 ? '100644' : '100755');
const special = (s) => s.isFIFO() || s.isSocket() || s.isBlockDevice() || s.isCharacterDevice();

/** sha1 of `blob <size>\0` + the file's bytes, read through O_NOFOLLOW|O_NONBLOCK in 1 MiB chunks; a change mid-read is worktree_unstable. */
function hashFile(p, lst, spendBytes, deadline, op) {
  let fd;
  try { fd = openSync(p, RD_FLAGS); } catch { throw fail('worktree_unstable', op); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || !sameNode(s, lst) || s.size !== lst.size) throw fail('worktree_unstable', op);
    const h = createHash('sha1').update(`blob ${s.size}\0`);
    const buf = Buffer.alloc(MIB);
    let n = 0;
    for (let got = 1; got > 0;) {
      if (Date.now() > deadline) throw fail('worktree_budget_exceeded', op);
      got = readSync(fd, buf, 0, MIB, null);
      n = n + got;
      if (n > s.size) throw fail('worktree_unstable', op);
      spendBytes(got);
      h.update(buf.subarray(0, got));
    }
    const after = fstatSync(fd);
    if (n !== s.size || after.size !== s.size || !sameNode(after, s)) throw fail('worktree_unstable', op);
    return h.digest();
  } finally { closeSync(fd); }
}

/** Bytes with every CRLF pair turned into LF (diagnostic only: `eol_hint`, never used to accept). */
function crlfToLf(b) {
  const parts = [];
  let at = 0;
  let prev = 0;
  for (let i = 0; i < b.length; i++) {
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
 * `.git`), worktree_unstable, worktree_budget_exceeded. Returns {equal, diffs: [{path, class, eol_hint?}],
 * untracked, gitignoreUntracked, infoExcludeSha256}; classes: content, mode, kind, missing, path_set, gitlink_populated.
 */
export function verifyWorktree(ctx, { source, dir, store, oid, exclusions = [], ...unknown } = {}) {
  const op = 'worktree.verify';
  const st = live(ctx, op);
  const h = handleOf(store, 'store');
  if (Object.keys(unknown).length || !isOid(oid) || (source === undefined) === (dir === undefined) || h.ctx !== ctx) throw invalid();
  const s = source === undefined ? null : handleOf(source, 'source');
  if (s && s.ctx !== ctx) throw invalid();
  if (s === null && !isAbsPath(dir)) throw invalid();
  const top = s ? s.top : B(dir);
  if (s) recheckSource(s, op);
  else if (!canonicalDir(top)) throw invalid();
  const excluded = excludedBy(exclusionList(exclusions));
  const deadline = Date.now() + st.timeoutMs;
  const spendFiles = meter(st.maxFiles, 'worktree_budget_exceeded', op, deadline);
  const spendBytes = meter(st.maxBytes, 'worktree_budget_exceeded', op, deadline);
  const entries = op_(st, h, 'tree.list', [oid], deadline).filter((e) => !excluded(e.path));
  spendFiles(entries.length);
  const diffs = [];
  const diff = (path, cls, extra = {}) => diffs.push(Object.freeze({ path: Buffer.from(path), class: cls, ...extra }));
  // Directory structure from the tree: dir key -> {files, dirs} (children by name).
  const dirs = new Map([[hexKey(EMPTY), { path: EMPTY, files: [], dirs: [] }]]);
  for (const e of entries) {
    let parent = EMPTY;
    for (const pre of [...prefixes(e.path), e.path]) {
      const isLeaf = pre.length === e.path.length;
      const name = parent.length ? pre.subarray(parent.length + 1) : pre;
      const node = dirs.get(hexKey(parent));
      if (isLeaf) node.files.push({ name, entry: e });
      else if (!dirs.has(hexKey(pre))) { dirs.set(hexKey(pre), { path: pre, files: [], dirs: [] }); node.dirs.push(name); }
      parent = pre;
    }
  }
  const absOf = (rel) => (rel.length ? join(top, rel) : top);
  const untrackedDirs = [];
  for (const queue = [EMPTY]; queue.length;) {
    const rel = queue.shift();
    const node = dirs.get(hexKey(rel));
    const names = listDir(absOf(rel), spendFiles);
    const present = new Set(names.map(hexKey));
    for (const n of names) if (isDotGit(n) && (rel.length > 0 || !n.equals(B('.git')))) throw fail('worktree_entry_unsupported', op);
    const childRel = (name) => (rel.length ? Buffer.concat([rel, SLASH, name]) : name);
    // Untracked (or ignored) directories here are scanned for a nested .git below (R5: tracked dir or not).
    const tracked = new Set([...node.dirs, ...node.files.map((f) => f.name)].map(hexKey));
    for (const n of names) {
      due(deadline, 'worktree_budget_exceeded', op);
      if (tracked.has(hexKey(n)) || isDotGit(n) || excluded(childRel(n))) continue;
      const us = lstatOrNull(absOf(childRel(n)));
      if (us && us.isDirectory() && !us.isSymbolicLink()) untrackedDirs.push(childRel(n));
    }
    // A tracked name must be listed byte-exactly; an absent gitlink is clean (an unpopulated submodule).
    const here = (name, gitlink = false) => {
      if (present.has(hexKey(name))) return true;
      const found = lstatOrNull(absOf(childRel(name)));
      if (!(gitlink && !found)) diff(childRel(name), found ? 'path_set' : 'missing');
      return false;
    };
    for (const name of node.dirs) {
      due(deadline, 'worktree_budget_exceeded', op);
      if (!here(name)) continue;
      const crel = childRel(name);
      const cs = lstatOrNull(absOf(crel));
      if (!cs) { diff(crel, 'missing'); continue; }
      if (cs.isSymbolicLink() || !cs.isDirectory()) { if (special(cs)) throw fail('worktree_entry_unsupported', op); diff(crel, 'kind'); continue; }
      queue.push(crel);
    }
    for (const { name, entry } of node.files) {
      due(deadline, 'worktree_budget_exceeded', op);
      if (!here(name, entry.mode === '160000')) continue;
      checkEntry(st, h, entry, absOf(entry.path), { diff, spendFiles, spendBytes, deadline, op });
    }
  }
  for (const queue = untrackedDirs; queue.length;) {
    const rel = queue.shift();
    if (Date.now() > deadline) throw fail('worktree_budget_exceeded', op);
    for (const n of listDir(absOf(rel), spendFiles)) {
      due(deadline, 'worktree_budget_exceeded', op);
      if (isDotGit(n)) throw fail('worktree_entry_unsupported', op);
      const crel = Buffer.concat([rel, SLASH, n]);
      const cs = lstatOrNull(absOf(crel));
      if (cs && cs.isDirectory() && !cs.isSymbolicLink() && !excluded(crel)) queue.push(crel);
    }
  }
  const others = untrackedLists(st, h, top, s, oid, deadline);
  const untracked = others.untracked.filter((p) => !excluded(p));
  const gitignoreUntracked = others.ignored.filter((p) => !excluded(p) && p.subarray(p.lastIndexOf(0x2f) + 1).equals(B('.gitignore')));
  if (s) recheckSource(s, op);
  live(ctx, op);
  return Object.freeze({
    equal: diffs.length === 0 && untracked.length === 0 && gitignoreUntracked.length === 0,
    diffs: Object.freeze(diffs), untracked: Object.freeze(untracked), gitignoreUntracked: Object.freeze(gitignoreUntracked),
    infoExcludeSha256: s ? s.excludeSha256 : null,
  });
}
/** A raw-object row from inside the lib (same checks as op()). */
function op_(st, h, id, operands, deadline) {
  if (!sameNode(lstatOrNull(h.storeDir), h.stat)) throw fail('context_tampered', id);
  checkStore(h.storeDir, id);
  if (id === 'tree.list') return listTree(st, h, operands, deadline);
  return verifiedBlob(git(st, id, h.storePath, operands, { deadline }).stdout, operands[0], id);
}

function checkEntry(st, h, e, abs, { diff, spendFiles, spendBytes, deadline, op }) {
  const lst = lstatOrNull(abs);
  if (!lst) return diff(e.path, 'missing');
  if (special(lst)) throw fail('worktree_entry_unsupported', op);
  if (e.mode === '160000') {
    if (lst.isDirectory()) { if (hasEntry(abs, spendFiles)) diff(e.path, 'gitlink_populated'); return undefined; }
    return diff(e.path, 'kind');
  }
  if (e.mode === '120000') {
    if (!lst.isSymbolicLink()) return diff(e.path, 'kind');
    const target = readlinkSync(abs, { encoding: 'buffer' });
    spendBytes(target.length);
    return blobHash(target).equals(Buffer.from(e.oid, 'hex')) ? undefined : diff(e.path, 'content');
  }
  if (!lst.isFile()) return diff(e.path, 'kind');
  if (Date.now() > deadline) throw fail('worktree_budget_exceeded', op);
  const sum = hashFile(abs, lst, spendBytes, deadline, op);
  if (!sum.equals(Buffer.from(e.oid, 'hex'))) diff(e.path, 'content', { eol_hint: eolHint(st, h, e, abs, lst, deadline, op) });
  if (fileMode(lst) !== e.mode) diff(e.path, 'mode');
  return undefined;
}
/** True when the worktree bytes and the blob are equal once CRLF pairs become LF (both bounded; diagnostic only). */
function eolHint(st, h, e, abs, lst, deadline, op) {
  if (lst.size > EOL_HINT_CAP) return false;
  let work;
  try { work = readBounded(abs, EOL_HINT_CAP, op); } catch { return false; }
  const blob = op_(st, h, 'blob.read', [e.oid], deadline);
  return blob.length <= EOL_HINT_CAP && !work.equals(blob) && crlfToLf(work).equals(crlfToLf(blob));
}

/** Untracked and ignored entries under `top`, listed by ls-files on a fresh index dir I (alternates = the store). */
function untrackedLists(st, h, top, s, oid, deadline) {
  const I = libGitDir(st, 'I-', INDEX_CONFIG, oid, join(h.storeDir, B('objects')));
  const Is = str(I);
  const excludeFrom = s ? str(s.excludeCopy) : `${Is}/tmp/empty-exclude`;
  if (!s) writeNew(B(excludeFrom), '');
  git(st, 'worktree.read', Is, [oid], { deadline });
  const tops = str(top);
  const list = (id) => zSplit(git(st, id, Is, [excludeFrom], { workTree: tops, deadline }).stdout).map((p) => Buffer.from(p));
  const untracked = list('worktree.others').map((p) => (p.lastIndexOf(0x2f) === p.length - 1 ? p.subarray(0, p.length - 1) : p));
  const ignored = list('worktree.ignored');
  removeTree(I, st.rootStat.dev, st.removeEntries, deadline + st.timeoutMs);
  return { untracked, ignored };
}

// ------------------------------------------------------------------ bounded removal (v3.1 R1) of lib-created dirs only

/**
 * Remove `root` (a lib-created dir) without following links: an iterative lstat walk restores u+w on owned
 * directories on the root's device, unlinks entries one at a time and removes directories bottom-up. `spend` (an
 * entry budget) and `deadline` bound the work; exhaustion or any failure throws (the caller quarantines).
 */
function removeTree(root, dev, budget, deadline) {
  // Every charge (each enumerated entry, each unlink, each rmdir) checks the entry budget AND the deadline; any failure,
  // a typed one from listDir included, is the mandatory removal code.
  const spend = meter(budget, 'lane_remove_failed', 'remove', deadline);
  try { removeTreeRaw(root, dev, spend, deadline); } catch (e) { if (e instanceof GitError && e.code === 'lane_remove_failed') throw e; throw fail('lane_remove_failed', 'remove'); }
}
function removeTreeRaw(root, dev, spend, deadline) {
  const order = [];
  for (const queue = [root]; queue.length;) {
    const d = queue.shift();
    const ds = lstatSync(d);
    if (!ds.isDirectory() || ds.dev !== dev || ds.uid !== uid()) throw fail('lane_remove_failed', 'remove');
    if ((ds.mode & 0o700) !== 0o700) chmodSync(d, (ds.mode & 0o7777) | 0o700);
    order.push(d);
    for (const name of listDir(d, spend)) {
      if (Date.now() > deadline) throw fail('lane_remove_failed', 'remove');
      const p = join(d, name);
      const s = lstatSync(p);
      if (s.isDirectory() && !s.isSymbolicLink()) queue.push(p);
      else { spend(1); unlinkSync(p); }
    }
  }
  for (const d of order.reverse()) {
    if (Date.now() > deadline) throw fail('lane_remove_failed', 'remove');
    spend(1);
    rmdirSync(d);
  }
}
