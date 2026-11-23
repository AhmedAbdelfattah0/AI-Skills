// S-02a0c tests: node --test skills/ship-ticket/scripts/lib/git-hardened.test.mjs
// Design: S02-REDESIGN-v3 + v3.1 amendments. Every test drives the real git through the lib (fixtures are built with the
// real git directly, never through the lib). POSIX only: on win32 the only test is the refusal (OC-4).
// Tags [Mxx] name the mutant (lib/git-hardened-mutation.test.mjs) each guard's assertion must kill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeGit } from './git-capability.mjs';
import { cellQualified, commitAll, currentCell, fixtureEnv, loadHardened, makeRepo, out, sh, tmp, writeTree } from './git-hardened.test-helper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const POSIX = WIN ? 'POSIX only: win32 refuses (OC-4); the win32 refusal test runs instead' : false;
const { H, X, copied } = await loadHardened();
const { GIT_CODES, GitError } = X;
const REAL_GIT = WIN ? null : probeGit().path;
const code = (c) => (e) => { assert.ok(e instanceof GitError, `GitError ${c}, got ${e?.name} ${e?.code} ${e?.message}`); assert.equal(e.code, c); return true; };
const S = (b) => Buffer.from(b).toString('latin1');

/** Run fn with process.env keys set (undefined deletes), restored afterwards. */
function withEnv(vars, fn) {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
/** A test-only `git` first on PATH: answers --version like the real git (or `version`), runs `body` (sh), then execs the real git. */
function wrapper(t, body = '', version = null) {
  const d = join(tmp(t, 'gh-wrap-'), 'bin');
  mkdirSync(d);
  const v = version ? `echo ${JSON.stringify(version)}; exit 0` : `exec ${JSON.stringify(REAL_GIT)} --version`;
  writeFileSync(join(d, 'git'), `#!/bin/sh\nif [ "$1" = "--version" ]; then ${v}; fi\n${body}\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`);
  chmodSync(join(d, 'git'), 0o755);
  return d;
}
const onPath = (dir, fn) => withEnv({ PATH: `${dir}:${process.env.PATH}` }, fn);
function ctxOf(t, o) {
  const c = H.createContext(o);
  t.after(() => { try { c.dispose(); } catch { /* a test that exhausts the removal budget disposes itself */ } });
  return c;
}
/** openSource + initStore on the success path: an unexpected refusal is an assertion failure (so a mutant reads as killed, not invalid). */
function storeOf(t, ctx, top, oids) {
  const dir = join(tmp(t), 'store');
  try {
    const source = H.openSource(ctx, { toplevel: top });
    return { source, dir, store: H.initStore(ctx, { dir, source, oids }) };
  } catch (e) { return assert.fail(`openSource/initStore refused: ${e?.code ?? e}`); }
}
const diffsOf = (v) => v.diffs.map((d) => [S(d.path), d.class]).sort();
const names = (list) => list.map(S).sort();
/** A loose object file written by hand (zlib of `<type> <len>\0<content>`); returns its oid. */
function looseObject(objects, type, content, at = null) {
  const body = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
  const oid = at ?? createHash('sha1').update(body).digest('hex');
  const f = join(objects, oid.slice(0, 2), oid.slice(2));
  mkdirSync(dirname(f), { recursive: true });
  if (existsSync(f)) { chmodSync(f, 0o644); unlinkSync(f); }
  writeFileSync(f, deflateSync(body));
  return oid;
}
/** A raw tree object written with --literally from [mode, name(Buffer|string), oid] entries (no sorting or checks). */
function literalTree(top, entries) {
  const raw = Buffer.concat(entries.map(([m, n, o]) => Buffer.concat([Buffer.from(`${m} `), Buffer.from(n), Buffer.from([0]), Buffer.from(o, 'hex')])));
  return out(top, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], { input: raw });
}
const commitTree = (top, tree, parents = [], msg = 'x') => out(top, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', msg]);
const blobOf = (top, content) => out(top, ['hash-object', '-w', '--stdin'], { input: Buffer.from(content) });
const procs = (needle) => spawnSync('ps', ['-axo', 'pid=,command=']).stdout.toString('latin1').split('\n').filter((l) => l.includes(needle) && !l.includes('ps -axo'));
const mkfifo = (p) => assert.equal(spawnSync('mkfifo', [p]).status, 0, 'mkfifo');

// ------------------------------------------------------------------ win32 (OC-4): refusal before any spawn or write

test('[M01] win32: createContext refuses platform_unsupported before any spawn or filesystem write', (t) => {
  const log = join(tmp(t, 'gh-w32-'), 'spawned');
  const bin = join(dirname(log), 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 0\n`);
  if (!WIN) chmodSync(join(bin, 'git'), 0o755);
  const tmpRoot = join(dirname(log), 'tmp');
  mkdirSync(tmpRoot);
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    withEnv({ PATH: `${bin}${WIN ? ';' : ':'}${process.env.PATH}`, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot }, () => assert.throws(() => H.createContext(), code('platform_unsupported')));
  } finally { Object.defineProperty(process, 'platform', { value: real, configurable: true }); }
  assert.equal(existsSync(log), false, 'zero spawns (not even the version probe)');
  assert.deepEqual(readdirSync(tmpRoot), [], 'zero writes');
});

// ------------------------------------------------------------------ module surface, golden and T1

test('the export list is pinned', () => {
  assert.deepEqual(Object.keys(H).sort(), ['DEFAULTS', 'GitCellUnqualified', 'OPS_TABLE', 'QUALIFIED_CELLS', 'createContext', 'initStore', 'op', 'openSource', 'openStore', 'verifyWorktree']);
});
test('T1: the closed OPS table and the qualified cells equal lib/git-ops.golden.json exactly', async () => {
  const golden = JSON.parse(readFileSync(join(here, 'git-ops.golden.json'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(H.OPS_TABLE)), golden.ops);
  const committed = await import(pathToFileURL(join(here, 'git-hardened.mjs')).href);
  assert.deepEqual(JSON.parse(JSON.stringify(committed.QUALIFIED_CELLS)), golden.cells, 'the committed cells (not the bootstrap copy)');
  assert.ok(Object.isFrozen(H.OPS_TABLE) && H.OPS_TABLE.every((r) => Object.isFrozen(r) && Object.isFrozen(r.argv)));
  for (const r of H.OPS_TABLE) {
    assert.ok(r.argv.every((a) => typeof a === 'string'), r.id);
    if (r.policy === 'raw-object') assert.equal(r.write, 'ro', `${r.id}: raw-object rows never write`);
    assert.equal(r.stdin === 'oid-lines', ['store.sizes', 'store.pack'].includes(r.id), `${r.id}: only the two R2/R3 rows take stdin`);
    for (const flag of ['--filters', '--textconv', '--ext-diff', '--recurse-submodules', '--follow-symlinks', '--strict']) assert.ok(!r.argv.includes(flag), `${r.id} never carries ${flag}`);
  }
  assert.ok(H.OPS_TABLE.find((r) => r.id === 'merge.base').argv.includes('--all'), 'merge.base keeps --all');
  assert.ok(!H.OPS_TABLE.some((r) => r.argv.includes('worktree')), 'no `git worktree` row exists');
});

// T1 caller scan (V2 row 8): git-exec.mjs is imported only by the hardened libs; a git-hardened `op` call takes a literal,
// registered id; the op binding is never aliased, passed or re-exported.
const VENDOR = join(here, '..', '..', 'vendor', 'acorn');
const UP = JSON.parse(readFileSync(join(VENDOR, 'UPSTREAM.json'), 'utf8'));
const vendorOk = ['LICENSE', 'acorn.mjs'].every((f) => createHash('sha256').update(readFileSync(join(VENDOR, f))).digest('hex') === UP.files[f]?.sha256);
const acorn = vendorOk ? await import(pathToFileURL(join(VENDOR, 'acorn.mjs')).href) : null;
const HARDENED_LIBS = ['lib/git-hardened.mjs', 'lib/git-checkout.mjs'];
/** T1 offences in one module (path relative to scripts/, `/`-separated), as strings. */
function t1(rel, src, ops = H.OPS_TABLE) {
  assert.ok(acorn, 'vendored acorn failed its integrity check');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  const off = [];
  const target = (spec) => { try { return relative(join(here, '..'), fileURLToPath(new URL(spec, pathToFileURL(join(here, '..', rel))))).split(sep).join('/'); } catch { return null; } };
  const opNames = new Set();
  const nsNames = new Set();
  for (const d of ast.body) {
    if (!/^(?:Import|ExportNamed|ExportAll)Declaration$/.test(d.type) || !d.source) continue;
    const to = target(d.source.value);
    if (to === 'lib/git-exec.mjs' && !HARDENED_LIBS.includes(rel)) off.push(`${rel} imports lib/git-exec.mjs`);
    if (to !== 'lib/git-hardened.mjs') continue;
    if (d.type !== 'ImportDeclaration') { off.push(`${rel} re-exports from lib/git-hardened.mjs`); continue; }
    for (const s of d.specifiers) {
      if (s.type === 'ImportNamespaceSpecifier' || s.type === 'ImportDefaultSpecifier') nsNames.add(s.local.name);
      else if ((s.imported.name ?? s.imported.value) === 'op') opNames.add(s.local.name);
    }
  }
  const parents = new Map();
  const walk = (n, p) => { parents.set(n, p); for (const k of Object.keys(n)) { const v = n[k]; for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') walk(c, n); } };
  walk(ast, null);
  const literalCall = (call) => {
    const id = call.arguments[1];
    if (!(id?.type === 'Literal' && typeof id.value === 'string')) return off.push(`${rel}: op id is not a literal`);
    const r = ops.find((x) => x.id === id.value);
    if (!r || r.policy !== 'raw-object') return off.push(`${rel}: op id ${id.value} is not a raw-object row`);
    if (!r.callers.includes(rel)) off.push(`${rel}: op ${id.value} is not registered for this caller`);
    return undefined;
  };
  for (const [n, p] of parents) {
    if (n.type !== 'Identifier' || !p) continue;
    if (p.type === 'ImportSpecifier' || p.type === 'ImportNamespaceSpecifier' || p.type === 'ImportDefaultSpecifier') continue;
    if (opNames.has(n.name)) {
      if (p.type === 'CallExpression' && p.callee === n) literalCall(p);
      else if (!(p.type === 'MemberExpression' && p.property === n && !p.computed)) off.push(`${rel}: op used other than as a direct call`);
    }
    if (nsNames.has(n.name) && !(p.type === 'MemberExpression' && p.object === n)) off.push(`${rel}: the git-hardened namespace used as a value`);
    if (nsNames.has(n.name) && p.type === 'MemberExpression' && p.object === n) {
      const key = p.computed ? null : p.property.name;
      const call = parents.get(p);
      if (key === null) off.push(`${rel}: computed member of the git-hardened namespace`);
      else if (key === 'op') { if (call?.type === 'CallExpression' && call.callee === p) literalCall(call); else off.push(`${rel}: op used other than as a direct call`); }
    }
  }
  return off;
}
function scriptModules(dir = join(here, '..'), rel = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (['node_modules', 'vendor'].includes(d.name) ? [] : scriptModules(join(dir, d.name), `${rel}${d.name}/`))
    : /\.(?:mjs|js|cjs)$/.test(d.name) && !/\.test\.|\.test-helper\./.test(d.name) ? [`${rel}${d.name}`] : []));
}
test('T1: no runtime module outside the hardened libs imports git-exec.mjs, and every op call names a literal registered id', () => {
  const offences = scriptModules().flatMap((rel) => t1(rel, readFileSync(join(here, '..', rel), 'utf8')));
  assert.deepEqual(offences, []);
  assert.ok(scriptModules().includes('lib/git-hardened.mjs') && scriptModules().length > 20, 'the scan reached the scripts tree');
});
test('T1: the scan flags every planted pattern (positive controls)', () => {
  const ops = [{ id: 'blob.read', policy: 'raw-object', callers: ['x.mjs'] }, { id: 'store.init', policy: 'internal', callers: [] }];
  const cases = [
    ["import { gitRunner } from './lib/git-exec.mjs';", /imports lib\/git-exec\.mjs/],
    ["import * as X from './lib/../lib/git-exec.mjs';", /imports lib\/git-exec\.mjs/],
    ["import { op } from './lib/git-hardened.mjs';\nconst id = 'blob.read';\nop(h, id, []);", /not a literal/],
    ["import { op } from './lib/git-hardened.mjs';\nop(h, 'store.init', []);", /not a raw-object row/],
    ["import { op } from './lib/git-hardened.mjs';\nconst o = op;", /other than as a direct call/],
    ["import { op as run } from './lib/git-hardened.mjs';\nfoo(run);", /other than as a direct call/],
    ["export { op } from './lib/git-hardened.mjs';", /re-exports/],
    ["import * as G from './lib/git-hardened.mjs';\nconst f = G.op;", /other than as a direct call/],
    ["import * as G from './lib/git-hardened.mjs';\nG['op'](h, 'blob.read');", /computed member/],
    ["import * as G from './lib/git-hardened.mjs';\nuse(G);", /namespace used as a value/],
  ];
  for (const [src, why] of cases) assert.ok(t1('x.mjs', src, ops).some((o) => why.test(o)), src);
  assert.deepEqual(t1('x.mjs', "import { op } from './lib/git-hardened.mjs';\nop(h, 'blob.read', [o]);", ops), [], 'a registered literal call passes');
  assert.deepEqual(t1('y.mjs', "import { op } from './lib/git-hardened.mjs';\nop(h, 'blob.read', [o]);", ops), ['y.mjs: op blob.read is not registered for this caller']);
  assert.deepEqual(t1('lib/git-hardened.mjs', "import { gitRunner } from './git-exec.mjs';", ops), [], 'the hardened lib itself may import the core');
});

// ------------------------------------------------------------------ qualified cells (OC-5, R9)

test('qualification: this cell is qualified in the committed lib (CI records the cell string; unqualified = loud red)', { skip: POSIX }, async (t) => {
  const cell = currentCell();
  t.diagnostic(`cell: ${JSON.stringify(cell)}`);
  assert.equal(await cellQualified(), true, `unqualified cell ${JSON.stringify(cell)}: run the full suite on it and add it through a PR (R9)`);
});
test('[M02] an unqualified cell refuses loudly with the R9 message: another build, another patch, a pre-release; newer included', { skip: POSIX }, (t) => {
  const c = currentCell();
  const m = /^git version (\d+)\.(\d+)\.(\d+)(.*)$/.exec(c.git);
  const variants = [
    `git version ${m[1]}.${m[2]}.${+m[3] + 1}${m[4]}`, // newer patch, same major.minor
    `git version ${m[1]}.${+m[2] + 1}.0${m[4]}`, // newer minor
    `git version ${m[1]}.${m[2]}.${m[3]}${m[4] ? '' : ' (Other Build-1)'}`, // the same numbers, another build string
    `git version ${m[1]}.${m[2]}.${m[3]}.rc1${m[4]}`,
  ];
  for (const v of variants) {
    const bin = wrapper(t, '', v);
    onPath(bin, () => assert.throws(() => H.createContext(), (e) => {
      assert.ok(e instanceof H.GitCellUnqualified && e.code === 'git_cell_unqualified', `${v}: ${e}`);
      assert.equal(e.message, `${v} on ${c.os}-${c.arch} with Node ${c.node} is not a qualified cell; qualify it (see lib/git-ops.golden.json cells) or use a qualified git`);
      return true;
    }, v));
  }
  const same = wrapper(t, '', c.git);
  onPath(same, () => ctxOf(t), 'control: the exact qualified string through the same wrapper is accepted');
});

// ------------------------------------------------------------------ contexts

test('[M03] context: R is 0700, use after dispose is context_disposed, a planted hook or a replaced R is context_tampered', { skip: POSIX }, (t) => {
  const { top } = makeRepo(t, { a: 'a' });
  const ctx = ctxOf(t);
  assert.deepEqual(Object.keys(ctx), ['dispose'], 'the context exposes no runner');
  assert.ok(Object.isFrozen(ctx));
  const src = H.openSource(ctx, { toplevel: top });
  assert.ok(src && Object.keys(src).length === 0 && Object.isFrozen(src), 'handles are opaque frozen tokens');
  ctx.dispose();
  assert.throws(() => H.openSource(ctx, { toplevel: top }), code('context_disposed'));
  assert.doesNotThrow(() => ctx.dispose(), 'dispose is idempotent');
  for (const plant of ['hook', 'swap']) {
    const tmpRoot = tmp(t, 'gh-ctxroot-');
    withEnv({ TMPDIR: tmpRoot }, () => {
      const c = ctxOf(t);
      const [R] = readdirSync(tmpRoot).map((n) => join(tmpRoot, n));
      assert.equal(lstatSync(R).mode & 0o777, 0o700);
      if (plant === 'hook') writeFileSync(join(R, 'hooks', 'pre-commit'), '#!/bin/sh\n');
      else { renameSync(R, `${R}.moved`); mkdirSync(R, { mode: 0o700 }); mkdirSync(join(R, 'hooks')); writeFileSync(join(R, 'not-ours'), 'x'); }
      assert.throws(() => H.openSource(c, { toplevel: top }), code('context_tampered'), plant);
      if (plant === 'swap') {
        assert.throws(() => c.dispose(), code('context_tampered'), 'dispose never removes a replaced R');
        assert.ok(existsSync(join(R, 'not-ours')), 'the replacement is left in place');
      }
    });
  }
});
test('context options: unknown keys and non-positive budgets are refused', { skip: POSIX }, () => {
  for (const o of [{ x: 1 }, { timeoutMs: 0 }, { maxFiles: -1 }, { maxBytes: 1.5 }, { maxObjectBytes: '1' }, { timeoutMs: Infinity }]) assert.throws(() => H.createContext(o), code('git_op_invalid'), JSON.stringify(o));
  assert.deepEqual(Object.keys(H.DEFAULTS).sort(), ['maxBytes', 'maxFiles', 'maxObjectBytes', 'maxTotalObjectBytes', 'removeEntries', 'timeoutMs']);
});

// ------------------------------------------------------------------ openSource: layout, refusals, bounded reads (v3 §2.1, R4)

test('openSource: no .git, a symlinked .git or a FIFO .git is repo_layout_unsupported; bad arguments are git_op_invalid', { skip: POSIX }, (t) => {
  const ctx = ctxOf(t);
  const d = tmp(t);
  mkdirSync(join(d, 'plain'));
  assert.throws(() => H.openSource(ctx, { toplevel: join(d, 'plain') }), code('repo_layout_unsupported'));
  const { top } = makeRepo(t, { a: 'a' });
  mkdirSync(join(d, 'linked'));
  symlinkSync(join(top, '.git'), join(d, 'linked', '.git'));
  assert.throws(() => H.openSource(ctx, { toplevel: join(d, 'linked') }), code('repo_layout_unsupported'));
  mkdirSync(join(d, 'fifo'));
  mkfifo(join(d, 'fifo', '.git'));
  assert.throws(() => H.openSource(ctx, { toplevel: join(d, 'fifo') }), code('repo_layout_unsupported'));
  for (const bad of [{ toplevel: 'rel' }, { toplevel: `${top}/` }, { toplevel: `${top}/../x` }, { toplevel: Buffer.from(top) }, { toplevel: top, extra: 1 }, {}]) assert.throws(() => H.openSource(ctx, bad), code('git_op_invalid'), JSON.stringify(bad));
});
test('openSource: a gitfile and a commondir are followed (bounded, strict); oversized, FIFO, multi-line or non-UTF-8 pointers refuse', { skip: POSIX }, (t) => {
  const ctx = ctxOf(t);
  const { top, head } = makeRepo(t, { a: 'a' });
  // A linked-worktree layout made by hand: wt/.git -> gitfile -> L (commondir -> top/.git).
  const d = tmp(t);
  const wt = join(d, 'wt');
  const L = join(d, 'L');
  mkdirSync(wt); mkdirSync(L);
  writeFileSync(join(L, 'HEAD'), `${head}\n`);
  writeFileSync(join(L, 'commondir'), `${join(top, '.git')}\n`);
  writeFileSync(join(wt, '.git'), `gitdir: ${L}\n`);
  writeFileSync(join(wt, 'a'), 'a');
  const src = H.openSource(ctx, { toplevel: wt });
  const { store } = { store: H.initStore(ctx, { dir: join(d, 'store'), source: src, oids: [head] }) };
  assert.equal(H.verifyWorktree(ctx, { source: src, store, oid: head }).equal, true, 'objects come from the common dir');
  const refuse = (content, c, label) => { writeFileSync(join(wt, '.git'), content); assert.throws(() => H.openSource(ctx, { toplevel: wt }), code(c), label); };
  refuse(`gitdir: ${L}\n${'x'.repeat(5000)}`, 'worktree_entry_unsupported', 'gitfile over 4 KiB');
  refuse(`gitdir: ${L}\nsecond line\n`, 'repo_layout_unsupported', 'two lines');
  refuse(Buffer.concat([Buffer.from('gitdir: '), Buffer.from([0xff, 0xfe])]), 'path_not_utf8', 'not UTF-8');
  refuse(`notgitdir: ${L}\n`, 'repo_layout_unsupported', 'no gitdir: prefix');
  refuse('gitdir: /nonexistent-gh-x\n', 'repo_layout_unsupported', 'a missing target');
  writeFileSync(join(wt, '.git'), `gitdir: ${L}\n`);
  writeFileSync(join(L, 'commondir'), 'x'.repeat(4097));
  assert.throws(() => H.openSource(ctx, { toplevel: wt }), code('worktree_entry_unsupported'), 'commondir over 4 KiB');
  unlinkSync(join(L, 'commondir')); mkfifo(join(L, 'commondir'));
  assert.throws(() => H.openSource(ctx, { toplevel: wt }), code('worktree_entry_unsupported'), 'a FIFO commondir (O_NONBLOCK: no hang)');
  unlinkSync(join(L, 'commondir')); symlinkSync('/dev/zero', join(L, 'commondir'));
  assert.throws(() => H.openSource(ctx, { toplevel: wt }), code('worktree_entry_unsupported'), 'commondir -> /dev/zero');
});
test('[M04][M05][M06] openSource: shallow, grafts, alternates and http-alternates refuse with their codes', { skip: POSIX }, (t) => {
  const ctx = ctxOf(t);
  for (const [file, c] of [['shallow', 'shallow_unsupported'], ['info/grafts', 'grafts_present'], ['objects/info/alternates', 'alternates_present'], ['objects/info/http-alternates', 'alternates_present']]) {
    const { top } = makeRepo(t, { a: 'a' });
    mkdirSync(dirname(join(top, '.git', file)), { recursive: true });
    writeFileSync(join(top, '.git', file), '\n');
    assert.throws(() => H.openSource(ctx, { toplevel: top }), code(c), file);
  }
});
test('[M07] openSource: info/exclude is read bounded (FIFO, /dev/zero link, over 1 MiB refuse); R inside the clone (TMPDIR) refuses', { skip: POSIX }, (t) => {
  const ctx = ctxOf(t);
  const ex = (top) => join(top, '.git', 'info', 'exclude');
  for (const [label, plant] of [['FIFO', (p) => mkfifo(p)], ['/dev/zero', (p) => symlinkSync('/dev/zero', p)], ['1 MiB + 1', (p) => writeFileSync(p, Buffer.alloc((1 << 20) + 1, 0x61))]]) {
    const { top } = makeRepo(t, { a: 'a' });
    rmSync(ex(top), { force: true });
    plant(ex(top));
    assert.throws(() => H.openSource(ctx, { toplevel: top }), code('worktree_entry_unsupported'), label);
  }
  const { top } = makeRepo(t, { a: 'a' });
  writeFileSync(ex(top), Buffer.alloc(1 << 20, 0x23));
  assert.doesNotThrow(() => H.openSource(ctx, { toplevel: top }), 'exactly 1 MiB is accepted');
  const inner = join(top, 'tmpdir');
  mkdirSync(inner);
  withEnv({ TMPDIR: inner }, () => { const c = ctxOf(t); assert.throws(() => H.openSource(c, { toplevel: top }), code('owned_dir_invalid'), 'TMPDIR inside the clone'); });
});
test('[M08] openSource: a foreign-owned repository refuses repo_owner_mismatch (root-only fixture)', { skip: POSIX || (process.getuid() !== 0 && 'needs root to chown a fixture to another uid (CI root cell)') }, (t) => {
  const ctx = ctxOf(t);
  const { top } = makeRepo(t, { a: 'a' });
  spawnSync('chown', ['-R', '65534', join(top, '.git')]);
  assert.throws(() => H.openSource(ctx, { toplevel: top }), code('repo_owner_mismatch'));
});

// ------------------------------------------------------------------ initStore / openStore (v3 §2.2, R2, R1)

test('initStore: a fresh self-contained store; pins, rows and a dispose -> new-context openStore work after the source is deleted', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'a.txt': 'one\n' });
  writeTree(top, { 'b.txt': 'two\n' });
  const second = commitAll(top);
  const ctx = ctxOf(t);
  const { store, dir } = storeOf(t, ctx, top, [second, head]);
  assert.equal(H.op(store, 'commit.resolve', [second]), second);
  assert.equal(H.op(store, 'commit.tree', [second]), out(top, ['rev-parse', `${second}^{tree}`]));
  assert.deepEqual(H.op(store, 'merge.base', [second, head]), { bases: [head], base: head });
  assert.deepEqual(readdirSync(join(dir, 'objects', 'pack')).filter((f) => f.endsWith('.pack')).length, 1);
  assert.equal(out(dir, ['--git-dir', dir, 'rev-parse', 'refs/pin/head', 'refs/pin/base']).split('\n').join(' '), `${second} ${head}`);
  assert.equal(existsSync(join(dir, 'objects', 'info', 'alternates')), false, 'the store has no alternates');
  ctx.dispose();
  rmSync(top, { recursive: true, force: true });
  const ctx2 = ctxOf(t);
  const again = H.openStore(ctx2, { dir });
  assert.deepEqual([...H.op(again, 'blob.read', [out(dir, ['--git-dir', dir, 'rev-parse', `${second}:b.txt`])])], [...Buffer.from('two\n')]);
});
test('initStore: an existing dir, a symlinked parent, a store inside the source and bad oids refuse before any write', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  const ctx = ctxOf(t);
  const source = H.openSource(ctx, { toplevel: top });
  const d = tmp(t);
  mkdirSync(join(d, 'exists'));
  assert.throws(() => H.initStore(ctx, { dir: join(d, 'exists'), source, oids: [head] }), code('owned_dir_invalid'));
  symlinkSync(d, join(d, 'via'));
  assert.throws(() => H.initStore(ctx, { dir: join(d, 'via', 'store'), source, oids: [head] }), code('owned_dir_invalid'));
  assert.throws(() => H.initStore(ctx, { dir: join(top, 'store'), source, oids: [head] }), code('owned_dir_invalid'));
  assert.throws(() => H.initStore(ctx, { dir: join(top, '.git', 'store'), source, oids: [head] }), code('owned_dir_invalid'));
  for (const oids of [[], [head, head, head], ['HEAD'], [head.toUpperCase()], [`-${head.slice(1)}`], [head.slice(1)], [Buffer.from(head)], 'x']) {
    assert.throws(() => H.initStore(ctx, { dir: join(d, 's'), source, oids }), code('git_op_invalid'), JSON.stringify(oids));
  }
  assert.deepEqual(readdirSync(d).sort(), ['exists', 'via']);
});
test('[M09][M10] initStore: a swapped loose blob is stored under its true hash and connectivity fails closed (object_corrupt), the dir is gone', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'a.txt': 'genuine\n' });
  const blob = out(top, ['rev-parse', `${head}:a.txt`]);
  looseObject(join(top, '.git', 'objects'), 'blob', Buffer.from('forged!\n'), blob);
  const ctx = ctxOf(t);
  const source = H.openSource(ctx, { toplevel: top });
  const parent = tmp(t);
  assert.throws(() => H.initStore(ctx, { dir: join(parent, 'store'), source, oids: [head] }), code('object_corrupt'));
  assert.equal(existsSync(join(parent, 'store')), false, 'the failed store is not left in place');
  assert.deepEqual(existsSync(join(parent, '.quarantine')) ? readdirSync(join(parent, '.quarantine')) : 'never quarantined', [], 'quarantined, then removed');
});
test('[M10] initStore: zero-padded modes, dangling and non-tip commits ingest (non-strict index-pack: no history-wide refusal)', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'a.txt': 'a\n' });
  const blob = blobOf(top, 'x\n');
  const sub = literalTree(top, [['100644', 'f', blob]]);
  const padded = literalTree(top, [['100644', 'a.txt', out(top, ['rev-parse', `${head}:a.txt`])], ['040000', 'd', sub]]);
  const odd = commitTree(top, padded, [head]);
  const dangling = commitTree(top, out(top, ['rev-parse', `${head}^{tree}`]), [], 'dangling');
  const ctx = ctxOf(t);
  const { store } = storeOf(t, ctx, top, [odd, dangling]);
  assert.equal(H.op(store, 'object.exists', [blob]), true);
  assert.deepEqual(H.op(store, 'merge.base', [odd, dangling]), { bases: [], base: null }, 'disjoint: zero bases');
});
test('initStore: more than 99 objects go through several bounded stdin batches (R2 x R3)', { skip: POSIX }, (t) => {
  const files = Object.fromEntries(Array.from({ length: 260 }, (_, i) => [`f/${i}.txt`, `${i}\n`]));
  const { top, head } = makeRepo(t, files);
  const ctx = ctxOf(t);
  const { store } = storeOf(t, ctx, top, [head]);
  assert.equal(H.op(store, 'tree.list', [head]).length, 260);
});
test('[M11][M12] R2: an object over the per-object cap, or a delta pack over the total cap, is object_too_large before index-pack', { skip: POSIX }, (t) => {
  const big = Buffer.alloc(3 << 20, 0x61);
  const big2 = Buffer.concat([big, Buffer.from('tail')]);
  const { top, head } = makeRepo(t, { 'a.bin': big, 'b.bin': big2 });
  sh(top, ['gc', '-q', '--aggressive']);
  const packBytes = readdirSync(join(top, '.git', 'objects', 'pack')).filter((f) => f.endsWith('.pack')).reduce((n, f) => n + lstatSync(join(top, '.git', 'objects', 'pack', f)).size, 0);
  assert.ok(packBytes < 512 << 10, `the fixture is a small delta pack (${packBytes} bytes) that inflates to 6 MiB`);
  for (const [o, label] of [[{ maxObjectBytes: 2 << 20 }, 'per-object'], [{ maxTotalObjectBytes: 5 << 20 }, 'total']]) {
    const ctx = ctxOf(t, o);
    const source = H.openSource(ctx, { toplevel: top });
    const parent = tmp(t);
    assert.throws(() => H.initStore(ctx, { dir: join(parent, 'store'), source, oids: [head] }), code('object_too_large'), label);
    assert.equal(existsSync(join(parent, 'store')), false);
  }
  const ctx = ctxOf(t, { maxObjectBytes: 4 << 20, maxTotalObjectBytes: 8 << 20 });
  assert.doesNotThrow(() => storeOf(t, ctx, top, [head]), 'control: within both caps');
});
test('R2: a hostile .idx or .bitmap in the builder pack dir fails closed (object_corrupt) or is ignored; content is never wrong', { skip: POSIX }, (t) => {
  for (const ext of ['idx', 'bitmap', 'rev']) {
    const { top, head } = makeRepo(t, { 'a.txt': 'payload\n' });
    sh(top, ['gc', '-q']);
    const pack = join(top, '.git', 'objects', 'pack');
    const base = readdirSync(pack).find((f) => f.endsWith('.pack')).slice(0, -5);
    const f = join(pack, `${base}.${ext}`);
    if (existsSync(f)) chmodSync(f, 0o644);
    writeFileSync(f, Buffer.concat([Buffer.from(ext === 'idx' ? [0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2] : [0x42, 0x49, 0x54, 0x4d]), Buffer.alloc(64, 0xff)]));
    const ctx = ctxOf(t);
    let store = null;
    try { store = H.initStore(ctx, { dir: join(tmp(t), 'store'), source: H.openSource(ctx, { toplevel: top }), oids: [head] }); } catch (e) { assert.ok(e instanceof GitError && ['object_corrupt', 'git_stderr'].includes(e.code), `${ext}: ${e.code}`); continue; }
    const blob = H.op(store, 'tree.list', [head])[0].oid;
    assert.deepEqual(S(H.op(store, 'blob.read', [blob])), 'payload\n', `${ext}: ingested content is the true content`);
  }
});
test('[M13] initStore: alternates added to the source mid-ingest are context_tampered (re-check after ingest)', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  const bin = wrapper(t, `case " $* " in *" index-pack "*) echo /nonexistent > ${JSON.stringify(join(top, '.git', 'objects', 'info', 'alternates'))};; esac`);
  onPath(bin, () => {
    const ctx = ctxOf(t);
    const source = H.openSource(ctx, { toplevel: top });
    const parent = tmp(t);
    assert.throws(() => H.initStore(ctx, { dir: join(parent, 'store'), source, oids: [head] }), code('context_tampered'));
    assert.equal(existsSync(join(parent, 'store')), false);
  });
});
test('[M14] timeouts: every write row bounded by the deadline; the store dir is quarantined then removed; nothing survives SIGKILL', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  for (const sub of ['init', 'rev-list', 'cat-file', 'pack-objects', 'index-pack', 'update-ref']) {
    const bin = wrapper(t, `case " $* " in *" ${sub} "*) exec sleep 41;; esac`);
    onPath(bin, () => {
      const ctx = ctxOf(t, { timeoutMs: 1500 });
      const source = H.openSource(ctx, { toplevel: top });
      const parent = tmp(t);
      const t0 = Date.now();
      assert.throws(() => H.initStore(ctx, { dir: join(parent, 'store'), source, oids: [head] }), code('git_timeout'), sub);
      assert.ok(Date.now() - t0 < 1500 + 3000, `${sub}: bounded return`);
      assert.equal(existsSync(join(parent, 'store')), false, `${sub}: no store left`);
      assert.deepEqual(existsSync(join(parent, '.quarantine')) ? readdirSync(join(parent, '.quarantine')) : 'never quarantined', [], `${sub}: quarantined, then emptied`);
      assert.deepEqual(procs('sleep 41'), [], `${sub}: the killed child did not survive`);
    });
  }
});
test('timeouts: a pipe-holding grandchild cannot hold initStore past its deadline (bounded return; the residual descendant is reaped here)', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  const pidFile = join(tmp(t), 'gc.pid');
  t.after(() => { try { process.kill(+readFileSync(pidFile, 'latin1'), 'SIGKILL'); } catch { /* gone */ } });
  const bin = wrapper(t, `case " $* " in *" pack-objects "*) sh -c 'echo $$ > ${pidFile}; exec sleep 43' & exec sleep 43;; esac`);
  onPath(bin, () => {
    const ctx = ctxOf(t, { timeoutMs: 1500 });
    const source = H.openSource(ctx, { toplevel: top });
    const t0 = Date.now();
    assert.throws(() => H.initStore(ctx, { dir: join(tmp(t), 'store'), source, oids: [head] }), code('git_timeout'));
    assert.ok(Date.now() - t0 < 1500 + 3000, 'bounded return despite the pipe-holding grandchild');
  });
});
test('[M15] R1: when bounded removal of a failed store exhausts its budget, the dir stays quarantined and the error is lane_remove_failed', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'a.txt': 'genuine\n' });
  looseObject(join(top, '.git', 'objects'), 'blob', Buffer.from('forged!\n'), out(top, ['rev-parse', `${head}:a.txt`]));
  const ctx = H.createContext({ removeEntries: 3 });
  const source = H.openSource(ctx, { toplevel: top });
  const parent = tmp(t);
  assert.throws(() => H.initStore(ctx, { dir: join(parent, 'store'), source, oids: [head] }), code('lane_remove_failed'));
  assert.equal(existsSync(join(parent, 'store')), false, 'never left at its own name, never reused');
  const q = readdirSync(join(parent, '.quarantine'));
  assert.equal(q.length, 1);
  assert.ok(existsSync(join(parent, '.quarantine', q[0])), 'kept in quarantine for a later prune');
  assert.throws(() => ctx.dispose(), code('lane_remove_failed'), 'the same budget bounds dispose');
});
test('[M16] R1: bounded removal restores u+w on owned dirs and never follows a symlink out of the removed tree', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  const outside = tmp(t);
  writeFileSync(join(outside, 'keep'), 'k');
  const store = join(tmp(t), 'store');
  // The wrapper makes the store hostile to plain removal just before the failing row: a 000 subdir and a link outside.
  const bin = wrapper(t, `case " $* " in *" update-ref "*) mkdir -p ${store}/x/y && ln -s ${outside} ${store}/x/out && touch ${store}/x/y/f && chmod 000 ${store}/x/y ${store}/x && exit 3;; esac`);
  onPath(bin, () => {
    const ctx = ctxOf(t);
    const source = H.openSource(ctx, { toplevel: top });
    assert.throws(() => H.initStore(ctx, { dir: store, source, oids: [head] }), code('git_failed'));
  });
  assert.equal(existsSync(store), false);
  assert.deepEqual(existsSync(join(dirname(store), '.quarantine')) ? readdirSync(join(dirname(store), '.quarantine')) : 'never quarantined', [], 'removed despite chmod 000');
  assert.deepEqual(readdirSync(outside), ['keep'], 'the symlink target is intact');
});
test('[M41] openStore: a foreign repository, a non-canonical path or a tampered config is owned_dir_invalid; raw rows are read-only', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  const ctx = ctxOf(t);
  assert.throws(() => H.openStore(ctx, { dir: join(top, '.git') }), code('owned_dir_invalid'), 'no marker, git-written config');
  const { dir } = storeOf(t, ctx, top, [head]);
  symlinkSync(dir, `${dir}-link`);
  assert.throws(() => H.openStore(ctx, { dir: `${dir}-link` }), code('owned_dir_invalid'));
  const cfg = join(dir, 'config');
  writeFileSync(cfg, `${readFileSync(cfg, 'latin1')}[core]\n\tfsmonitor = /bin/sh\n`);
  assert.throws(() => H.openStore(ctx, { dir }), code('owned_dir_invalid'));
});

// ------------------------------------------------------------------ raw-object rows

test('[M17] blob.read verifies sha1(blob n NUL bytes): a hand-written loose object with another body is object_corrupt', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  const ctx = ctxOf(t);
  const { store, dir } = storeOf(t, ctx, top, [head]);
  const fake = createHash('sha1').update('anything').digest('hex');
  looseObject(join(dir, 'objects'), 'blob', Buffer.from('not the bytes of that oid'), fake);
  assert.equal(H.op(store, 'object.exists', [fake]), true, 'git itself serves it');
  assert.throws(() => H.op(store, 'blob.read', [fake]), code('object_corrupt'));
  const real = out(top, ['rev-parse', `${head}:a`]);
  assert.equal(S(H.op(store, 'blob.read', [real])), 'a');
});
test('[M18][M19] R6: duplicate paths, a blob that prefixes another path, and unsafe components refuse tree_path_unsafe on head and base', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { ok: 'ok' });
  const b = blobOf(top, 'b\n');
  const sub = literalTree(top, [['100644', 'b', b]]);
  const trees = {
    duplicate: literalTree(top, [['100644', 'x', b], ['100644', 'x', blobOf(top, 'other\n')]]),
    prefix: literalTree(top, [['100644', 'a', b], ['40000', 'a', sub]]),
    slashName: literalTree(top, [['100644', 'a/b', b], ['40000', 'a', sub]]),
    dotgit: literalTree(top, [['40000', '.git', sub]]),
    dotGIT: literalTree(top, [['40000', 'd', literalTree(top, [['100644', '.GiT', b]])]]),
    dotdot: literalTree(top, [['40000', '..', sub]]),
    dot: literalTree(top, [['100644', '.', b]]),
  };
  for (const [label, tree] of Object.entries(trees)) {
    const bad = commitTree(top, tree, [head], label);
    const ctx = ctxOf(t);
    const { store } = storeOf(t, ctx, top, [bad, head]);
    assert.throws(() => H.op(store, 'tree.list', [bad]), code('tree_path_unsafe'), `${label}: head side`);
    const { store: s2 } = storeOf(t, ctx, top, [head, bad]);
    assert.throws(() => H.op(s2, 'tree.list', [bad]), code('tree_path_unsafe'), `${label}: base side`);
    assert.throws(() => H.verifyWorktree(ctx, { dir: tmp(t), store, oid: bad }), code('tree_path_unsafe'), `${label}: verify refuses before reading the worktree`);
  }
});
test('tree.list and tree.diff: Buffer paths byte-exact (invalid UTF-8 included), records parsed, no textconv', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'a.txt': 'a\n' });
  const odd = Buffer.from([0x6e, 0xff, 0x2e, 0x74]);
  const tree2 = literalTree(top, [['100644', 'a.txt', blobOf(top, 'changed\n')], ['100755', odd, blobOf(top, 'x')]]);
  const next = commitTree(top, tree2, [head]);
  const ctx = ctxOf(t);
  const { store } = storeOf(t, ctx, top, [next, head]);
  const list = H.op(store, 'tree.list', [next]);
  assert.ok(list.some((e) => e.path.equals(odd) && e.mode === '100755'), 'the invalid-UTF-8 name round-trips');
  assert.ok(list.every((e) => Buffer.isBuffer(e.path) && Object.isFrozen(e)));
  const diff = H.op(store, 'tree.diff', [head, next]);
  assert.deepEqual(diff.map((d) => [d.status, S(d.path)]).sort(), [['A', S(odd)], ['M', 'a.txt']]);
});
test('[M20] merge.base keeps --all: a criss-cross gives two bases and no single base (S-02a refuses); one base gives base', { skip: POSIX }, (t) => {
  const { top, head: A } = makeRepo(t, { a: '1' });
  const tree = out(top, ['rev-parse', `${A}^{tree}`]);
  const B1 = commitTree(top, tree, [A], 'b1');
  const B2 = commitTree(top, tree, [A], 'b2');
  const M1 = commitTree(top, tree, [B1, B2], 'm1');
  const M2 = commitTree(top, tree, [B2, B1], 'm2');
  const ctx = ctxOf(t);
  const { store } = storeOf(t, ctx, top, [M1, M2]);
  const r = H.op(store, 'merge.base', [M1, M2]);
  assert.deepEqual([[...r.bases].sort(), r.base], [[B1, B2].sort(), null]);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.bases));
  assert.deepEqual(H.op(store, 'merge.base', [M1, B1]), { bases: [B1], base: B1 });
});
test('[M45] op: operands are validated (no option or rev syntax reaches argv); only raw-object rows; only store handles', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  const ctx = ctxOf(t);
  const { store, source } = storeOf(t, ctx, top, [head]);
  for (const bad of [['-x'], ['--output=/tmp/x'], ['HEAD'], [':/re'], ['@{u}'], [head.toUpperCase()], [head.slice(1)], [`${head}0`], [`${head}^{tree}`], [Buffer.from(head)], [new String(head)], [1], []]) {
    assert.throws(() => H.op(store, 'blob.read', bad), code('git_op_invalid'), JSON.stringify(bad));
  }
  assert.throws(() => H.op(store, 'blob.read', [head, head]), code('git_op_invalid'), 'a leftover operand');
  for (const id of ['store.init', 'store.pack', 'worktree.others', 'nope', 'blob.read ']) assert.throws(() => H.op(store, id, [head]), code('git_op_invalid'), id);
  assert.throws(() => H.op(source, 'blob.read', [head]), code('git_op_invalid'), 'a source handle');
  assert.throws(() => H.op({}, 'blob.read', [head]), code('git_op_invalid'), 'a forged handle');
  assert.throws(() => H.op({ ...store }, 'blob.read', [head]), code('git_op_invalid'), 'a copied handle');
  assert.equal(H.op(store, 'commit.resolve', ['0'.repeat(40)]), null, 'absent');
  assert.equal(H.op(store, 'object.exists', ['0'.repeat(40)]), false);
});
test('[M21] store tamper: alternates, grafts, shallow or a changed config in the store make every row context_tampered', { skip: POSIX }, (t) => {
  for (const [file, content] of [['objects/info/alternates', '/x\n'], ['info/grafts', 'x\n'], ['shallow', 'x\n'], ['config', '[core]\n\tbare = true\n']]) {
    const { top, head } = makeRepo(t, { a: 'a' });
    const ctx = ctxOf(t);
    const { store, dir } = storeOf(t, ctx, top, [head]);
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
    assert.throws(() => H.op(store, 'object.exists', [head]), code('context_tampered'), file);
  }
});
test('replace refs written into the store change nothing (GIT_NO_REPLACE_OBJECTS)', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { a: 'a' });
  writeTree(top, { a: 'b' });
  const other = commitAll(top);
  const ctx = ctxOf(t);
  const { store, dir } = storeOf(t, ctx, top, [head, other]);
  sh(dir, ['--git-dir', dir, 'update-ref', `refs/replace/${head}`, other]);
  assert.equal(H.op(store, 'commit.tree', [head]), out(top, ['rev-parse', `${head}^{tree}`]));
});

// ------------------------------------------------------------------ verifyWorktree (v3 §2.3, R4, R5, R8; O-1)

function verify(t, files, mutate, o = {}) {
  const { top, head } = makeRepo(t, files, o.repo);
  o.pre?.(top);
  const ctx = ctxOf(t, o.ctx);
  const { store, source } = storeOf(t, ctx, top, [head]);
  mutate?.(top);
  return { v: H.verifyWorktree(ctx, { source, store, oid: head, exclusions: o.exclusions ?? [] }), top, head, ctx, store, source };
}
test('verify: a clean tree is equal (files, exec bit, symlink, nested dirs, an empty gitlink dir, text=auto with LF content: R16)', { skip: POSIX }, (t) => {
  const { v } = verify(t, { 'a.txt': 'a\n', '.gitattributes': '* text=auto\n', 'bin/run': { exec: '#!/bin/sh\n' }, 'deep/er/x': 'x', l: { link: 'a.txt' } });
  assert.deepEqual([v.equal, v.diffs, v.untracked, v.gitignoreUntracked], [true, [], [], []]);
  assert.match(v.infoExcludeSha256, /^[0-9a-f]{64}$/);
});
test('[M22] verify: content, mode, kind, missing and symlink-target diffs; every tracked byte is hashed even when size and mtime match', { skip: POSIX }, (t) => {
  const { v } = verify(t, { 'c.txt': 'abc\n', 'm.sh': 'x', 'k.txt': 'k', 'gone.txt': 'g', 'd/f': 'f', l: { link: 'c.txt' }, 'same.txt': 'aaaa' }, (top) => {
    const st = lstatSync(join(top, 'same.txt'));
    writeFileSync(join(top, 'c.txt'), 'abd\n');
    chmodSync(join(top, 'm.sh'), 0o755);
    unlinkSync(join(top, 'k.txt')); mkdirSync(join(top, 'k.txt'));
    unlinkSync(join(top, 'gone.txt'));
    unlinkSync(join(top, 'l')); symlinkSync('m.sh', join(top, 'l'));
    writeFileSync(join(top, 'same.txt'), 'bbbb');
    utimesSync(join(top, 'same.txt'), st.atime, st.mtime);
    assert.deepEqual([lstatSync(join(top, 'same.txt')).size, Math.trunc(lstatSync(join(top, 'same.txt')).mtimeMs / 1000)], [st.size, Math.trunc(st.mtimeMs / 1000)]);
  });
  assert.deepEqual(diffsOf(v), [['c.txt', 'content'], ['gone.txt', 'missing'], ['k.txt', 'kind'], ['l', 'content'], ['m.sh', 'mode'], ['same.txt', 'content']]);
  assert.equal(v.equal, false);
});
test('[M23] verify: CRLF/LF divergence is a content diff with eol_hint (S-02a: identity_divergent), never equal; other content has no hint', { skip: POSIX }, (t) => {
  const { v } = verify(t, { 'lf.txt': 'a\nb\n', 'crlf.txt': 'a\r\nb\r\n', 'other.txt': 'a\n' }, (top) => {
    writeFileSync(join(top, 'lf.txt'), 'a\r\nb\r\n');
    writeFileSync(join(top, 'crlf.txt'), 'a\nb\n');
    writeFileSync(join(top, 'other.txt'), 'z\n');
  });
  assert.equal(v.equal, false);
  assert.deepEqual(v.diffs.map((d) => [S(d.path), d.class, d.eol_hint]).sort(), [['crlf.txt', 'content', true], ['lf.txt', 'content', true], ['other.txt', 'content', false]]);
});
test('[M24] O-1: a staged-only edit refuses (bytes differ); staged-then-reverted (worktree == tree(head)) is equal; the index is never read', { skip: POSIX }, (t) => {
  const staged = verify(t, { 'a.txt': 'one\n' }, (top) => { writeFileSync(join(top, 'a.txt'), 'two\n'); sh(top, ['add', 'a.txt']); });
  assert.deepEqual(diffsOf(staged.v), [['a.txt', 'content']]);
  const reverted = verify(t, { 'a.txt': 'one\n' }, (top) => { writeFileSync(join(top, 'a.txt'), 'two\n'); sh(top, ['add', 'a.txt']); writeFileSync(join(top, 'a.txt'), 'one\n'); });
  assert.equal(reverted.v.equal, true, 'index-only divergence is accepted (O-1 class b)');
  const flags = verify(t, { 'a.txt': 'one\n', 'b.txt': 'b\n' }, (top) => {
    sh(top, ['update-index', '--skip-worktree', 'a.txt']); sh(top, ['update-index', '--assume-unchanged', 'b.txt']);
    writeFileSync(join(top, 'a.txt'), 'hidden from git status\n'); writeFileSync(join(top, 'b.txt'), 'also hidden\n');
  });
  assert.deepEqual(diffsOf(flags.v), [['a.txt', 'content'], ['b.txt', 'content']], 'skip-worktree / assume-unchanged cannot hide an edit');
  const racy = verify(t, { 'r.txt': 'xxxx' }, (top) => { writeFileSync(join(top, 'r.txt'), 'yyyy'); sh(top, ['update-index', '--refresh'], { allowFail: true }); });
  assert.deepEqual(diffsOf(racy.v), [['r.txt', 'content']]);
});
test('[M25] verify: gitlinks: absent or empty is clean; a populated submodule dir is gitlink_populated', { skip: POSIX }, (t) => {
  const { top: sub, head: subHead } = makeRepo(t, { s: 's' });
  const { top, head } = makeRepo(t, { a: 'a' });
  sh(top, ['update-index', '--add', '--cacheinfo', `160000,${subHead},vendor/sub`]);
  sh(top, ['commit', '-q', '-m', 'gitlink']);
  const withLink = out(top, ['rev-parse', 'HEAD']);
  const ctx = ctxOf(t);
  const { store, source } = storeOf(t, ctx, top, [withLink, head]);
  const run = () => H.verifyWorktree(ctx, { source, store, oid: withLink });
  mkdirSync(join(top, 'vendor'), { recursive: true });
  assert.equal(run().equal, true, 'absent gitlink dir');
  mkdirSync(join(top, 'vendor', 'sub'));
  assert.equal(run().equal, true, 'empty gitlink dir');
  rmSync(join(top, 'vendor', 'sub'), { recursive: true });
  sh(dirname(sub), ['clone', '-q', '--no-local', sub, join(top, 'vendor', 'sub')]);
  assert.deepEqual(diffsOf(run()), [['vendor/sub', 'gitlink_populated']]);
});
test('[M26][M27] R5: a tracked dir swapped for a symlink is kind (no descent); a nested .git of any case below the top refuses', { skip: POSIX }, (t) => {
  const outside = tmp(t);
  writeFileSync(join(outside, 'a.txt'), 'a\n');
  writeFileSync(join(outside, 'conftest.py'), 'payload');
  const { v } = verify(t, { 'src/a.txt': 'a\n', 'top.txt': 't' }, (top) => { rmSync(join(top, 'src'), { recursive: true }); symlinkSync(outside, join(top, 'src')); });
  assert.deepEqual(diffsOf(v), [['src', 'kind']], 'the symlinked dir is not followed (its conftest.py is never seen)');
  for (const nested of ['src/.git/conftest.py', 'src/.GIT/x', 'src/deep/.Git/x']) {
    assert.throws(() => verify(t, { 'src/a.txt': 'a\n', 'src/deep/b': 'b' }, (top) => writeTree(top, { [nested]: 'payload' })), code('worktree_entry_unsupported'), nested);
  }
  const probe = makeRepo(t, { a: 'a' });
  if (!existsSync(join(probe.top, '.GIT'))) assert.throws(() => verify(t, { a: 'a' }, (top) => writeTree(top, { '.GIT/x': 'x' })), code('worktree_entry_unsupported'), 'a case variant of .git at the top (case-sensitive filesystems)');
});
test('[M28] verify: FIFO, socket and device entries at tracked paths refuse; a FIFO is never opened (no hang)', { skip: POSIX }, (t) => {
  assert.throws(() => verify(t, { 'p.txt': 'p', q: 'q' }, (top) => { unlinkSync(join(top, 'p.txt')); mkfifo(join(top, 'p.txt')); }), code('worktree_entry_unsupported'), 'FIFO');
  const { v } = verify(t, { 'z.txt': 'z' }, (top) => { unlinkSync(join(top, 'z.txt')); symlinkSync('/dev/zero', join(top, 'z.txt')); });
  assert.deepEqual(diffsOf(v), [['z.txt', 'kind']], 'a link to /dev/zero is a kind change, never read');
  assert.throws(() => verify(t, { 's.txt': 's' }, (top) => {
    unlinkSync(join(top, 's.txt'));
    const r = spawnSync(process.execPath, ['-e', `const s=require('net').createServer().listen(${JSON.stringify(join(top, 's.txt'))},()=>{s.close=()=>{};process.exit(0)})`]);
    assert.equal(r.status, 0, 'socket made');
  }), code('worktree_entry_unsupported'), 'socket');
});
test('[M29] R8: NFC tree vs NFD disk and a case mismatch refuse (path_set or missing); nothing is normalised', { skip: POSIX }, (t) => {
  const nfc = 'café.txt';
  const nfd = 'café.txt';
  const a = verify(t, { [nfc]: 'x' }, (top) => { renameSync(join(top, nfc), join(top, 'tmp')); renameSync(join(top, 'tmp'), join(top, nfd)); });
  assert.equal(a.v.equal, false);
  assert.ok(a.v.diffs.some((d) => d.path.equals(Buffer.from(nfc)) && ['path_set', 'missing'].includes(d.class)), JSON.stringify(diffsOf(a.v)));
  const b = verify(t, { README: 'r' }, (top) => { renameSync(join(top, 'README'), join(top, 'tmp')); renameSync(join(top, 'tmp'), join(top, 'readme')); });
  assert.equal(b.v.equal, false);
  assert.ok(b.v.diffs.some((d) => S(d.path) === 'README' && ['path_set', 'missing'].includes(d.class)), JSON.stringify(diffsOf(b.v)));
});
test('R8: an invalid-UTF-8 tracked name round-trips and an invalid-UTF-8 exclusion matches it (Linux: APFS refuses such names)', { skip: POSIX || (process.platform === 'darwin' && 'APFS refuses non-UTF-8 file names (EILSEQ)') }, (t) => {
  const odd = Buffer.from([0x6e, 0xff, 0x2e, 0x74]);
  const { top, head } = makeRepo(t, { a: 'a' });
  writeFileSync(Buffer.concat([Buffer.from(`${top}/`), odd]), 'v');
  const next = commitAll(top);
  const ctx = ctxOf(t);
  const { store, source } = storeOf(t, ctx, top, [next, head]);
  assert.equal(H.verifyWorktree(ctx, { source, store, oid: next }).equal, true);
  writeFileSync(Buffer.concat([Buffer.from(`${top}/`), odd]), 'changed');
  assert.deepEqual(H.verifyWorktree(ctx, { source, store, oid: next }).diffs.map((d) => d.path), [odd]);
  assert.equal(H.verifyWorktree(ctx, { source, store, oid: next, exclusions: [odd] }).equal, true);
});
test('[M30] verify: v1 exclusions (exact path or dir prefix) skip tracked and untracked entries; empty or unsafe exclusions are refused', { skip: POSIX }, (t) => {
  const { v } = verify(t, { 'keep.txt': 'k', 'skip/a': 'a', 'skipme.txt': 's' }, (top) => writeTree(top, { 'skip/a': 'changed', 'skip/new': 'n', 'skipme.txt': 'changed', 'other.txt': 'u' }), { exclusions: ['skip/', 'skipme.txt'] });
  assert.deepEqual([diffsOf(v), names(v.untracked)], [[], ['other.txt']]);
  const { ctx, store, source, head } = verify(t, { a: 'a' });
  for (const bad of [[''], ['/abs'], ['..'], ['a/../b'], ['./a'], ['.git'], [1], 'a']) assert.throws(() => H.verifyWorktree(ctx, { source, store, oid: head, exclusions: bad }), code('git_op_invalid'), JSON.stringify(bad));
  const prefix = verify(t, { 'skip/a': 'a', 'skipped/b': 'b' }, (top) => writeTree(top, { 'skipped/b': 'changed' }), { exclusions: ['skip'] });
  assert.deepEqual(diffsOf(prefix.v), [['skipped/b', 'content']], 'a dir prefix is a path component, not a string prefix');
});
test('[M31] verify untracked: tracked .gitignore and info/exclude are honoured (E3); a tracked negation outranks info/exclude (E5); global excludes are not', { skip: POSIX }, (t) => {
  const home = tmp(t);
  writeFileSync(join(home, 'global-ignore'), 'global.tmp\n');
  writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${join(home, 'global-ignore')}\n`);
  const { v } = withEnv({ HOME: home, XDG_CONFIG_HOME: home }, () => verify(t, { '.gitignore': '*.log\n!keep.log\n', 'a.txt': 'a' }, (top) => {
    writeTree(top, { 'new.txt': 'n', 'x.log': 'l', 'keep.log': 'k', 'secret.tmp': 's', 'global.tmp': 'g' });
  }, { pre: (top) => writeFileSync(join(top, '.git', 'info', 'exclude'), 'secret.tmp\n*.log\n') }));
  assert.deepEqual(names(v.untracked), ['global.tmp', 'keep.log', 'new.txt']);
  assert.equal(v.equal, false);
});
test('[M32] verify untracked: a self-ignoring untracked .gitignore (root or a cache dir) is gitignoreUntracked', { skip: POSIX }, (t) => {
  const { v } = verify(t, { 'a.txt': 'a' }, (top) => writeTree(top, { 'cache/.gitignore': '*\n', 'cache/conftest.py': 'p' }));
  assert.deepEqual([names(v.gitignoreUntracked), names(v.untracked), v.equal], [['cache/.gitignore'], [], false]);
  const root = verify(t, { 'a.txt': 'a' }, (top) => writeTree(top, { '.gitignore': '*\n' }));
  assert.deepEqual(names(root.v.gitignoreUntracked), ['.gitignore']);
});
test('verify untracked: an untracked nested repository is listed (and refuses), never entered', { skip: POSIX }, (t) => {
  const { v } = verify(t, { 'a.txt': 'a' }, (top) => makeRepo(t, { s: 's' }, { dir: join(top, 'vendor') }));
  assert.deepEqual(names(v.untracked), ['vendor']);
});
test('[M33] verify: a FIFO .gitignore hangs ls-files, the deadline kills it (git_timeout) and no git process survives SIGKILL (ps)', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'a.txt': 'a' });
  mkdirSync(join(top, 'u'));
  mkfifo(join(top, 'u', '.gitignore'));
  const ctx = ctxOf(t, { timeoutMs: 1500 });
  const { store, source } = storeOf(t, ctx, top, [head]);
  const t0 = Date.now();
  assert.throws(() => H.verifyWorktree(ctx, { source, store, oid: head }), code('git_timeout'));
  assert.ok(Date.now() - t0 < 1500 + 3000);
  assert.deepEqual(procs(top), [], 'no process naming the worktree survived');
});
test('[M34][M35] verify budgets: maxFiles, maxBytes and the deadline refuse worktree_budget_exceeded', { skip: POSIX }, (t) => {
  const files = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`d/${i}`, 'x'.repeat(1000)]));
  assert.throws(() => verify(t, files, null, { ctx: { maxFiles: 40 } }), code('worktree_budget_exceeded'), 'files');
  assert.throws(() => verify(t, files, null, { ctx: { maxBytes: 30_000 } }), code('worktree_budget_exceeded'), 'bytes');
  assert.doesNotThrow(() => verify(t, files, null, { ctx: { maxFiles: 200, maxBytes: 60_000 } }), 'control: within both budgets');
  const big = verify(t, { 'big.bin': Buffer.alloc(1 << 20) });
  assert.equal(big.v.equal, true);
});
test('[M36] R4: a huge untracked directory inside a tracked dir is charged entry by entry (refused without a full listing)', { skip: POSIX }, (t) => {
  assert.throws(() => verify(t, { 'd/a': 'a' }, (top) => { for (let i = 0; i < 3000; i++) writeFileSync(join(top, 'd', `u${i}`), ''); }, { ctx: { maxFiles: 1000 } }), code('worktree_budget_exceeded'));
});
test('[M37] verify: a file that changes during the read is worktree_unstable (a writer appends throughout)', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'grow.bin': Buffer.alloc(32 << 20), a: 'a' });
  const ctx = ctxOf(t);
  const { store, source } = storeOf(t, ctx, top, [head]);
  const writer = spawnSync(process.execPath, ['-e', `
    const fs=require('fs');const {spawnSync}=require('child_process');
    const fd=fs.openSync(${JSON.stringify(join(top, 'grow.bin'))},'a');
    const child=require('child_process').spawn(process.execPath,['-e','const fs=require("fs");const fd=fs.openSync(process.argv[1],"a");for(;;)fs.writeSync(fd,"x")',${JSON.stringify(join(top, 'grow.bin'))}],{stdio:'ignore',detached:true});
    console.log(child.pid);process.exit(0)`], { encoding: 'latin1' });
  const pid = +writer.stdout.trim();
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  for (let i = 0; i < 50 && lstatSync(join(top, 'grow.bin')).size === 32 << 20; i++) spawnSync('sleep', ['0.05']);
  assert.throws(() => H.verifyWorktree(ctx, { source, store, oid: head }), code('worktree_unstable'));
});
test('verify: a lane-style dir (no source) is verified the same way; a non-canonical dir is git_op_invalid', { skip: POSIX }, (t) => {
  const { top, head } = makeRepo(t, { 'a.txt': 'a', 'd/b': 'b' });
  const ctx = ctxOf(t);
  const { store } = storeOf(t, ctx, top, [head]);
  const lane = tmp(t);
  sh(top, ['--work-tree', lane, 'checkout', head, '--', '.']);
  const v = H.verifyWorktree(ctx, { dir: lane, store, oid: head });
  assert.deepEqual([v.equal, v.infoExcludeSha256], [true, null]);
  symlinkSync(lane, `${lane}-l`);
  assert.throws(() => H.verifyWorktree(ctx, { dir: `${lane}-l`, store, oid: head }), code('git_op_invalid'));
  assert.throws(() => H.verifyWorktree(ctx, { dir: lane, store, oid: head, source: H.openSource(ctx, { toplevel: top }) }), code('git_op_invalid'), 'both source and dir');
});

// ------------------------------------------------------------------ the canary matrix (C1): hostile builder config never runs

test('[M38] canaries: builder filters (direct, include, includeIf, config.worktree, macro, info/attributes, process), textconv, fsmonitor, hooks and a populated submodule never run through the lib; each fires through the hostile git directly', { skip: POSIX }, (t) => {
  const d = tmp(t);
  const log = join(d, 'canary.log');
  const script = (name, body) => { const f = join(d, name); writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`); chmodSync(f, 0o755); return f; };
  const F = Object.fromEntries(['f-evil', 'f-inc', 'f-iff', 'f-wt', 'f-mac', 'f-ia', 'f-proc'].map((n) => [n, script(n, n === 'f-proc' ? 'exit 1' : 'exec cat')]));
  const tconv = script('textconv', 'exit 1');
  const fsm = script('fsmonitor', 'exit 1');
  const subFsm = script('sub-fsmonitor', 'exit 1');
  const other = script('other', 'exit 1');
  const hooks = join(d, 'hooks');
  mkdirSync(hooks);
  for (const h of ['pre-commit', 'post-commit', 'post-checkout', 'reference-transaction', 'pre-auto-gc', 'post-index-change']) { writeFileSync(join(hooks, h), `#!/bin/sh\necho "hook ${h}" >> ${JSON.stringify(log)}\n`); chmodSync(join(hooks, h), 0o755); }
  const { top: sub, head: subHead } = makeRepo(t, { s: 's' });
  const files = { 'a.txt': 'a\n', 'b.inc': 'b\n', 'c.mac': 'c\n', 'w.wt': 'w\n', 'x.iff': 'x\n', 'y.ia': 'y\n', 'z.proc': 'z\n',
    '.gitattributes': '*.txt filter=evil diff=tx\n*.inc filter=inc\n*.iff filter=iff\n*.wt filter=wt\n[attr]evilm filter=mac\n*.mac evilm\n*.proc filter=proc\n' };
  const { top, head: h0 } = makeRepo(t, files);
  sh(top, ['update-index', '--add', '--cacheinfo', `160000,${subHead},sub`]);
  sh(top, ['commit', '-q', '-m', 'sub']);
  const head = out(top, ['rev-parse', 'HEAD']);
  sh(dirname(sub), ['clone', '-q', '--no-local', sub, join(top, 'sub')]);
  const inc = join(d, 'inc.cfg');
  writeFileSync(inc, `[filter "inc"]\n\tclean = ${F['f-inc']}\n\tsmudge = ${F['f-inc']}\n`);
  const incIf = join(d, 'incif.cfg');
  writeFileSync(incIf, `[filter "iff"]\n\tclean = ${F['f-iff']}\n`);
  const cfg = (repo, extra) => writeFileSync(join(repo, '.git', 'config'), `${readFileSync(join(repo, '.git', 'config'), 'latin1')}${extra}`);
  cfg(top, `[filter "evil"]\n\tclean = ${F['f-evil']}\n\tsmudge = ${F['f-evil']}\n[filter "mac"]\n\tclean = ${F['f-mac']}\n[filter "ia"]\n\tclean = ${F['f-ia']}\n`
    + `[filter "proc"]\n\tprocess = ${F['f-proc']}\n[diff "tx"]\n\ttextconv = ${tconv}\n[core]\n\tfsmonitor = ${fsm}\n\thooksPath = ${hooks}\n\tpager = ${other}\n\teditor = ${other}\n`
    + `\taskPass = ${other}\n\tsshCommand = ${other}\n\talternateRefsCommand = ${other}\n[uploadpack]\n\tpackObjectsHook = ${other}\n[include]\n\tpath = ${inc}\n`
    + `[includeIf "gitdir:${top}/"]\n\tpath = ${incIf}\n[extensions]\n\tworktreeConfig = true\n`);
  writeFileSync(join(top, '.git', 'config.worktree'), `[filter "wt"]\n\tclean = ${F['f-wt']}\n`);
  writeFileSync(join(top, '.git', 'info', 'attributes'), '*.ia filter=ia\n');
  cfg(join(top, 'sub'), `[core]\n\tfsmonitor = ${subFsm}\n\thooksPath = ${hooks}\n[filter "evil"]\n\tclean = ${F['f-evil']}\n`);
  writeFileSync(join(top, 'sub', '.gitattributes'), '* filter=evil\n');
  // A stat-dirty worktree: every file touched, one edited.
  for (const f of Object.keys(files)) spawnSync('touch', [join(top, f)]);
  writeFileSync(join(top, 'b.inc'), 'b2\n');
  // Through the lib: every public row and every internal row (init, walk, sizes, pack, index, connect, pin, read, others, ignored).
  const snap = () => ['index', 'config', 'HEAD', 'config.worktree', 'info/attributes'].map((f) => readFileSync(join(top, '.git', f)).toString('hex'));
  const before = snap();
  const ctx = ctxOf(t);
  const { store, source } = storeOf(t, ctx, top, [head, h0]);
  const blob = out(top, ['rev-parse', `${head}:a.txt`]);
  H.op(store, 'blob.read', [blob]); H.op(store, 'tree.list', [head]); H.op(store, 'tree.diff', [h0, head]); H.op(store, 'commit.resolve', [head]);
  H.op(store, 'commit.tree', [head]); H.op(store, 'merge.base', [head, h0]); H.op(store, 'object.exists', [blob]);
  const v = H.verifyWorktree(ctx, { source, store, oid: head });
  assert.deepEqual(diffsOf(v), [['b.inc', 'content'], ['sub', 'gitlink_populated']], 'the lib saw raw bytes (no clean filter ran)');
  assert.equal(existsSync(log), false, `no canary fired through the lib: ${existsSync(log) ? readFileSync(log, 'latin1') : ''}`);
  assert.deepEqual(snap(), before, 'the builder index, config, HEAD and info/attributes are byte-unchanged (no git ran on the builder git dir)');
  // Positive controls, after the lib: the same repository through the hostile git, directly (each canary is armed).
  const fired = (label, args, want, cwd = top) => {
    rmSync(log, { force: true });
    sh(cwd, args, { env: fixtureEnv(), allowFail: true });
    const got = existsSync(log) ? readFileSync(log, 'latin1') : '';
    assert.ok(want.test(got), `${label} fires through the hostile git: ${got || 'nothing'}`);
  };
  for (const f of Object.keys(files).filter((f) => f !== '.gitattributes')) writeFileSync(join(top, f), 'edited\n');
  for (const [file, name] of [['a.txt', 'f-evil'], ['b.inc', 'f-inc'], ['x.iff', 'f-iff'], ['w.wt', 'f-wt'], ['c.mac', 'f-mac'], ['y.ia', 'f-ia'], ['z.proc', 'f-proc']]) {
    fired(`${name} (${file})`, ['diff', '--quiet', '--', file], new RegExp(`^${name} `, 'm'));
  }
  fired('textconv', ['diff', '--textconv', '--', 'a.txt'], /^textconv /m);
  fired('fsmonitor', ['status', '--porcelain'], /^fsmonitor /m);
  fired('hooks', ['commit', '-q', '--allow-empty', '-m', 'x'], /^hook pre-commit/m);
  fired('submodule config', ['status', '--porcelain'], /^sub-fsmonitor /m, join(top, 'sub'));
});
test('canaries (C1-b): a filter and attributes added to the builder mid-operation (between rows) never run; the result equals the clean run', { skip: POSIX }, (t) => {
  const d = tmp(t);
  const log = join(d, 'late.log');
  const late = join(d, 'late');
  writeFileSync(late, `#!/bin/sh\necho "late $*" >> ${JSON.stringify(log)}\nexec cat\n`);
  chmodSync(late, 0o755);
  const { top, head } = makeRepo(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  writeFileSync(join(top, 'b.txt'), 'b2\n');
  const clean = (() => { const ctx = ctxOf(t); const { store, source } = storeOf(t, ctx, top, [head]); return diffsOf(H.verifyWorktree(ctx, { source, store, oid: head })); })();
  const arm = `printf '[filter "late"]\\n\\tclean = ${late}\\n\\tsmudge = ${late}\\n[core]\\n\\tfsmonitor = ${late}\\n' >> ${JSON.stringify(join(top, '.git', 'config'))}; echo '* filter=late' > ${JSON.stringify(join(top, '.git', 'info', 'attributes'))}`;
  const bin = wrapper(t, `case " $* " in *" pack-objects "*|*" read-tree "*) ${arm};; esac`);
  const v = onPath(bin, () => { const ctx = ctxOf(t); const { store, source } = storeOf(t, ctx, top, [head]); return H.verifyWorktree(ctx, { source, store, oid: head }); });
  assert.deepEqual(diffsOf(v), clean, 'the result equals the clean run');
  assert.equal(existsSync(log), false, 'the filter added mid-operation never ran');
  sh(top, ['diff', '--quiet'], { allowFail: true });
  assert.ok(existsSync(log), 'positive control: the armed filter fires through the hostile git');
});
test('canaries: no lib row spawns a child process (GIT_TRACE through a wrapper); a fetch is the positive control', { skip: POSIX }, (t) => {
  const traceLog = join(tmp(t), 'trace.log');
  const bin = wrapper(t, `GIT_TRACE=${JSON.stringify(traceLog)}; export GIT_TRACE`);
  const { top, head } = makeRepo(t, { 'a.txt': 'a\n', '.gitignore': '*.tmp\n' });
  writeTree(top, { 'u.txt': 'u', 'x.tmp': 'x' });
  onPath(bin, () => {
    const ctx = ctxOf(t);
    const { store, source } = storeOf(t, ctx, top, [head]);
    for (const id of ['blob.read', 'tree.list', 'commit.resolve', 'commit.tree', 'object.exists']) H.op(store, id, [id === 'blob.read' ? out(top, ['rev-parse', `${head}:a.txt`]) : head]);
    H.op(store, 'tree.diff', [head, head]); H.op(store, 'merge.base', [head, head]);
    H.verifyWorktree(ctx, { source, store, oid: head });
  });
  const trace = readFileSync(traceLog, 'latin1');
  for (const sub of ['init', 'rev-list', 'cat-file', 'pack-objects', 'index-pack', 'update-ref', 'ls-tree', 'diff-tree', 'rev-parse', 'merge-base', 'read-tree', 'ls-files']) assert.match(trace, new RegExp(`trace: built-in: git ${sub}`), `${sub} was traced`);
  assert.doesNotMatch(trace, /run_command|start_command/, 'no lib row started a child process');
  const ctl = join(tmp(t), 'trace-ctl.log');
  sh(dirname(top), ['clone', '-q', '--no-local', top, join(dirname(ctl), 'clone')], { env: fixtureEnv({ GIT_TRACE: ctl }) });
  assert.match(readFileSync(ctl, 'latin1'), /run_command|start_command/, 'positive control: the trace shows a child when one is started');
});

// ------------------------------------------------------------------ property / differential: verifyWorktree vs the real git

function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let x = s; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
/** The reference: the real git's own view of the same worktree (hash-object --no-filters, ls-files --others), mapped to v3 classes. */
function reference(top, head) {
  const entries = sh(top, ['ls-tree', '-r', '-z', '--full-tree', head]).stdout.toString('latin1').split('\0').filter(Boolean).map((r) => { const [m, , o] = r.split('\t')[0].split(' '); return { mode: m, oid: o, path: r.split('\t')[1] }; });
  const diffs = new Set();
  const files = [];
  for (const e of entries) {
    const parts = e.path.split('/');
    let broken = false;
    for (let i = 1; i < parts.length && !broken; i++) {
      const pre = parts.slice(0, i).join('/');
      let st = null;
      try { st = lstatSync(join(top, pre)); } catch { /* missing */ }
      if (!st) { diffs.add(`${pre}\0missing`); broken = true; } else if (!st.isDirectory() || st.isSymbolicLink()) { diffs.add(`${pre}\0kind`); broken = true; }
    }
    if (broken) continue;
    let st = null;
    try { st = lstatSync(join(top, e.path)); } catch { /* missing */ }
    if (!st) { diffs.add(`${e.path}\0missing`); continue; }
    if (e.mode === '120000') {
      if (!st.isSymbolicLink()) diffs.add(`${e.path}\0kind`);
      else if (out(top, ['hash-object', '--stdin'], { input: readlinkSync(join(top, e.path), { encoding: 'buffer' }) }) !== e.oid) diffs.add(`${e.path}\0content`);
      continue;
    }
    if (!st.isFile()) { diffs.add(`${e.path}\0kind`); continue; }
    files.push(e);
    if (((st.mode & 0o111) ? '100755' : '100644') !== e.mode) diffs.add(`${e.path}\0mode`);
  }
  if (files.length) {
    const sums = out(top, ['hash-object', '--no-filters', '--stdin-paths'], { input: files.map((e) => `${e.path}\n`).join('') }).split('\n');
    files.forEach((e, i) => { if (sums[i] !== e.oid) diffs.add(`${e.path}\0content`); });
  }
  const untracked = sh(top, ['ls-files', '-z', '--others', '--exclude-standard']).stdout.toString('latin1').split('\0').filter(Boolean).sort();
  return { diffs: [...diffs].sort(), untracked };
}
test('property: verifyWorktree equals the real git over seeded random trees and random worktree edits (differential)', { skip: POSIX }, (t) => {
  const SEED = 0x5a0c;
  const rnd = prng(SEED);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const name = () => pick(['a', 'b', 'c', 'dd', 'e.txt', 'f.js', 'g h', 'x-y', 'n1', 'z_z']) + Math.floor(rnd() * 50);
  const RUNS = 12;
  let compared = 0;
  for (let run = 0; run < RUNS; run++) {
    const files = {};
    for (let i = 0; i < 25; i++) {
      const depth = Math.floor(rnd() * 3);
      const p = [...Array.from({ length: depth }, () => `d${Math.floor(rnd() * 4)}`), name()].join('/');
      if (Object.keys(files).some((k) => k.startsWith(`${p}/`) || p.startsWith(`${k}/`))) continue;
      const r = rnd();
      files[p] = r < 0.15 ? { link: pick(['x', '../y', 'a b']) } : r < 0.3 ? { exec: `#!${i}\r\n` } : pick(['', 'a\n', 'a\r\nb\r\n', `${i}`.repeat(i * 37)]);
    }
    const { top, head } = makeRepo(t, files);
    const keys = Object.keys(files);
    for (let k = 0; k < 6; k++) {
      const p = pick(keys);
      const f = join(top, p);
      const r = rnd();
      try {
        if (r < 0.2) writeFileSync(f, `edit${k}\n`);
        else if (r < 0.35) chmodSync(f, (lstatSync(f).mode & 0o111) ? 0o644 : 0o755);
        else if (r < 0.5) rmSync(f, { recursive: true, force: true });
        else if (r < 0.6) { rmSync(f, { force: true }); mkdirSync(f); }
        else if (r < 0.7) { rmSync(f, { force: true }); symlinkSync('elsewhere', f); }
        else if (r < 0.8) writeFileSync(join(top, `untracked${k}.u`), 'u');
        else if (r < 0.9) rmSync(dirname(f) === top ? f : dirname(f), { recursive: true, force: true });
        else writeFileSync(f, readFileSync(f).toString('latin1').replace(/\n/g, '\r\n'));
      } catch { /* a path removed by an earlier edit */ }
    }
    const ctx = ctxOf(t);
    const { store, source } = storeOf(t, ctx, top, [head]);
    const v = H.verifyWorktree(ctx, { source, store, oid: head });
    const ref = reference(top, head);
    const mine = v.diffs.map((d) => `${S(d.path)}\0${d.class}`).sort();
    assert.deepEqual(mine, ref.diffs, `seed ${SEED} run ${run}: diffs`);
    // ls-files lists an untracked dir's files individually; the lib lists the same entries (no --directory there).
    assert.deepEqual(v.untracked.map(S).sort(), ref.untracked, `seed ${SEED} run ${run}: untracked`);
    assert.equal(v.equal, mine.length === 0 && ref.untracked.length === 0);
    compared++;
  }
  assert.equal(compared, RUNS, 'every run compared');
});

// ------------------------------------------------------------------ the 30k-file cost cell (qualification; GIT_HARDENED_COST=1)

test('cost cell: a 30,000-file tree ingests and verifies within the default deadline', { skip: POSIX || (process.env.GIT_HARDENED_COST !== '1' && 'set GIT_HARDENED_COST=1 (qualification cells)') }, (t) => {
  const files = {};
  for (let i = 0; i < 30_000; i++) files[`d${i % 100}/f${i}.txt`] = `${i}\n`;
  const { top, head } = makeRepo(t, files);
  const ctx = ctxOf(t);
  const t0 = Date.now();
  const { store, source } = storeOf(t, ctx, top, [head]);
  const t1 = Date.now();
  const v = H.verifyWorktree(ctx, { source, store, oid: head });
  t.diagnostic(`30k cost cell: ingest ${t1 - t0} ms, verify ${Date.now() - t1} ms`);
  assert.equal(v.equal, true);
});

test('the suite ran against the committed lib or its qualification copy (diagnostic)', { skip: POSIX }, (t) => {
  t.diagnostic(copied ? `ran on a copy with the current cell added: ${JSON.stringify(currentCell())}` : 'ran on the committed lib (qualified cell)');
  assert.ok(GIT_CODES.includes('object_too_large'));
});
