// Tests for risk-floor.mjs, the structural path floor (S-10 / ASTF-11). Assertions are on codes and shapes, not message text.
// Repositories are built in temp directories with the local git binary (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, chmodSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as RF from './risk-floor.mjs';

const SCRIPT = fileURLToPath(new URL('./risk-floor.mjs', import.meta.url));
const NIX = { skip: process.platform === 'win32' && 'windows: no control characters in file names, no exec bit, no unprivileged symlinks' };
const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
const out = (r) => JSON.parse(r.stdout);
const G = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const DECL = { version: 1, classes: [
  { name: 'money', floor: 'ELEVATED', globs: ['apps/api/src/billing/**', 'apps/api/src/pricing/', '**/checkout/**', '*.pricing.ts', 'src/cart-validation.service.ts'] },
  { name: 'auth', floor: 'ELEVATED', globs: ['apps/api/src/auth/**', 'apps/api/src/middleware/auth*.ts', 'src/id/page.tsx', '.env'] },
  { name: 'schema', floor: 'ELEVATED', globs: ['db/migrations/**', '*.sql'] }] };
const DECL_PATH = '.ship-ticket/risk-paths.json';
function repo(files = { 'README.md': 'x\n' }, decl = DECL) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'rfrepo-')));
  G(dir, 'init', '-q', '-b', 'main');
  const all = decl ? { ...files, [DECL_PATH]: JSON.stringify(decl) } : files;
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: G(dir, 'rev-parse', 'HEAD') };
}
const commit = (dir, msg = 'c') => { G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', msg); return G(dir, 'rev-parse', 'HEAD'); };
const chk = (r, paths, claimed = 'STANDARD', ai = 'STANDARD') => RF.check({ repo: r.dir, base: r.base, plannedPaths: paths, claimed, ai });
const line = (r) => `risk_floor: risk-floor: floor=STANDARD; classes=none; claimed=STANDARD; ai=STANDARD; final=STANDARD; paths=1; matched=0; base=${r.base.slice(0, 12)}; head=planned; declaration=none`;
const re = (r, head, claimed = 'STANDARD', ai = 'STANDARD', recordedLine = line(r)) => RF.reassess({ repo: r.dir, base: r.base, head, recordedLine, claimed, ai });
const cli = (args, input) => run(args, input);
const tmpFile = (bytes) => { const f = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'rfp-'))), 'p.json'); writeFileSync(f, bytes); return f; };

// ---- globs ----
test('glob semantics: ** spans segments, * stays in a segment, no-slash patterns match at any depth', () => {
  const y = [['apps/api/src/billing/**', 'apps/api/src/billing/a/b/c.ts'], ['apps/api/src/billing/**', 'apps/api/src/billing'], ['*.sql', 'db/a/b/x.sql'], ['**/checkout/**', 'a/b/checkout/c/d'],
    ['apps/api/src/pricing/', 'apps/api/src/pricing/x/y.ts'], ['auth*.ts', 'src/middleware/authz.ts'], ['a/**/b', 'a/b'], ['a/**/b', 'a/x/y/b'], ['src/id/page.tsx', 'src/id/page.tsx']];
  for (const [g, p] of y) assert.equal(RF.globMatches(g, p), true, `${g} ~ ${p}`);
  const n = [['apps/api/src/billing/**', 'apps/api/src/billings/x.ts'], ['apps/api/src/billing/**', 'xapps/api/src/billing/x.ts'], ['*.sql', 'db/x.sql.bak'], ['src/*.ts', 'src/a/b.ts'], ['db/migrations/**', 'db/migration/x.md'], ['a/b', 'a']];
  for (const [g, p] of n) assert.equal(RF.globMatches(g, p), false, `${g} !~ ${p}`);
});

test('B1 directory semantics: a pattern matches a path or ANY ANCESTOR of it (db/migrations, migrations/, checkout, ...)', () => {
  for (const [g, p] of [['db/migrations', 'db/migrations/1.sql'], ['db/migrations/', 'db/migrations/1.sql'], ['checkout', 'src/checkout/pay.ts'], ['migrations/', 'db/migrations/1.sql'], ['checkout/', 'a/checkout/b/c.ts'],
    ['db/migrations', 'db/migrations'], ['apps/api', 'apps/api/src/x.ts'], ['.env', '.env/x']]) assert.equal(RF.globMatches(g, p), true, `${g} ~ ${p}`);
  assert.equal(RF.globMatches('db/migrations', 'db/migration/x'), false); assert.equal(RF.globMatches('checkout', 'src/checkouts/x'), false);
});

test('B1 property: for every declared glob and every generated path it matches, every descendant is matched too', () => {
  const globs = ['a/b', 'a/b/', 'a/b/**', 'b', 'b/', '*.sql', '*.pricing.ts', 'a/*/c', 'a/**/c', '**/c/**', 'auth*.ts', '.env', 'x/y*z', '**', '*', 'a/b/c/d'];
  const segs = ['a', 'b', 'c', 'd', 'x', 'yz', 'ymz', 'q.sql', 'f.pricing.ts', 'authz.ts', '.env', 'Z'];
  const gen = []; for (const s1 of segs) { gen.push([s1]); for (const s2 of segs) { gen.push([s1, s2]); for (const s3 of segs.slice(0, 6)) gen.push([s1, s2, s3]); } }
  let checked = 0;
  for (const g of globs) for (const p of gen) {
    if (!RF.globMatches(g, p.join('/'))) continue;
    for (const tail of ['more', 'more/deeper/x.ts']) { assert.equal(RF.globMatches(g, `${p.join('/')}/${tail}`), true, `${g} ~ ${p.join('/')}/${tail}`); checked++; }
  }
  assert.ok(checked > 1000);
});

test('glob path forms: case, backslashes, ./ and dot segments, NFD, spaces, ignorable characters; traversal and absolute forms are malformed', () => {
  const g = 'apps/api/src/billing/**';
  for (const f of ['apps/api/src/billing/x.ts', 'APPS/API/SRC/BILLING/X.TS', 'apps\\api\\src\\billing\\x.ts', './apps/api/src/billing/x.ts', 'apps/./api//src/billing/x.ts', 'apps/api/src/billing/x/',
    'apps/api/src/billing/ spaced name .ts', 'apps/api/src/billing/Café.ts', 'apps/api/src/billing/Cafe\u0301.ts', 'apps/api/src/bil\u200Cling/x.ts', 'apps/api/src/billing/link -> etc-passwd']) assert.equal(RF.globMatches(g, f), true, JSON.stringify(f));
  assert.equal(RF.globMatches('apps/api/src/billing/café.ts', 'apps/api/src/billing/Cafe\u0301.ts'), true);
  for (const b of ['../apps/api/src/billing/x.ts', 'apps/../billing/x.ts', '/apps/x.ts', 'C:\\apps\\x.ts', '', '.', './', 'a\u0000b', 'a\uD800b', 'a\uFFFDb', 5, null]) assert.throws(() => RF.globMatches(g, b), (e) => e.code === 'malformed_input', String(b));
  for (const b of ['../x', '/abs', '']) assert.throws(() => RF.compileGlob(b), (e) => e.code === 'malformed_input');
});

test('grammar (M5): every metacharacter except * and a whole-segment **, edge whitespace and a leading ! are rejected loudly (compile and declaration)', () => {
  for (const g of ['a?c', 'a[b]c', '[id]', 'a{b,c}', '{a,b}', '!a', 'a\\b', '(a)', 'a**b', '**a', 'a**', 'x/***/y', 'apps/api/src/billing/** ', ' apps/x', 'a/ b', 'a/b ']) {
    assert.throws(() => RF.compileGlob(g), (e) => e.code === 'malformed_input', JSON.stringify(g));
    const x = chk(repo({ 'README.md': 'x' }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: [g] }] }), ['README.md']);
    assert.equal(x.final, 'ELEVATED', g); assert.ok(x.errors.includes('declaration_invalid'), g);
  }
  for (const g of ['a*b', '*', '**', 'a/**', 'a/', '*.sql', '**/x/**', '.env', 'dir/file with space.ts']) assert.doesNotThrow(() => RF.compileGlob(g), g);
});

test('budgets: pattern, segment, path, count and byte limits fail closed', () => {
  const dec = (globs) => repo({ 'README.md': 'x' }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs }] });
  assert.throws(() => RF.compileGlob('a'.repeat(257)), (e) => e.code === 'malformed_input'); assert.doesNotThrow(() => RF.compileGlob('a'.repeat(256)));
  assert.throws(() => RF.compileGlob(Array(33).fill('a').join('/')), (e) => e.code === 'malformed_input'); assert.doesNotThrow(() => RF.compileGlob(Array(32).fill('a').join('/')));
  assert.ok(chk(dec(Array.from({ length: 257 }, (_, i) => `d${i}/**`)), ['README.md']).errors.includes('declaration_invalid'));
  assert.equal(chk(dec(Array.from({ length: 256 }, (_, i) => `d${i}/**`)), ['README.md']).errors.length, 0);
  const r = repo();
  for (const p of ['a'.repeat(4097), Array(65).fill('a').join('/')]) assert.ok(chk(r, [p]).errors.includes('malformed_input'));
  assert.equal(chk(r, ['a'.repeat(4096)]).errors.length, 0); assert.equal(chk(r, [Array(64).fill('a').join('/')]).errors.length, 0);
  const pad = repo({ 'README.md': 'x' }, null); mkdirSync(join(pad.dir, '.ship-ticket')); writeFileSync(join(pad.dir, DECL_PATH), JSON.stringify(DECL) + ' '.repeat(RF.MAX_DECLARATION + 1));
  const x = RF.check({ repo: pad.dir, base: commit(pad.dir), plannedPaths: ['README.md'], claimed: 'STANDARD', ai: 'STANDARD' }); assert.equal(x.final, 'ELEVATED'); assert.ok(x.errors.includes('malformed_input'));
  writeFileSync(join(pad.dir, 'README.md'), 'changed'); // head-commit mode never reads the working tree: only the base size check can refuse
  const pb = { dir: pad.dir, base: G(pad.dir, 'rev-parse', 'HEAD') }; writeFileSync(join(pad.dir, DECL_PATH), JSON.stringify(DECL)); const ph = commit(pad.dir);
  const z = RF.reassess({ repo: pb.dir, base: pb.base, head: ph, recordedLine: line(pb), claimed: 'STANDARD', ai: 'STANDARD' }); assert.ok(z.errors.includes('malformed_input'), JSON.stringify(z.errors));
  const big = repo(); writeFileSync(join(big.dir, DECL_PATH), ' '.repeat(RF.MAX_DECLARATION + 1)); const y = chk(big, ['README.md']); assert.equal(y.final, 'ELEVATED'); assert.ok(y.errors.includes('malformed_input'));
});

test('work is bounded: worst-case matching stays within STEP_BOUND_PER_PAIR; a global step budget fails closed', () => {
  const g = RF.compileGlob(`*${'a'.repeat(254)}b`), ctx = { steps: 0 };
  assert.equal(RF.matchSegments(g, ['a'.repeat(4096)], ctx), false);
  assert.ok(ctx.steps <= RF.STEP_BOUND_PER_PAIR && ctx.steps > 100_000, String(ctx.steps));
  const many = Array.from({ length: 200 }, () => 'a'.repeat(4096));
  const dec = repo({ 'README.md': 'x' }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: [`*${'a'.repeat(254)}b`, `*${'a'.repeat(253)}bb`, `*${'a'.repeat(252)}bbb`] }] });
  const x = chk(dec, many); assert.equal(x.final, 'ELEVATED'); assert.ok(x.errors.includes('malformed_input'));
  assert.equal(chk(repo(), Array.from({ length: 5000 }, (_, i) => `src/m${i}/file${i}.ts`)).floor, 'STANDARD');
});

test('paths are literal text: only the PATTERN * is a wildcard (literal *, **, ?, [ in filenames)', () => {
  for (const [g, p] of [['*.sql', 'db/*secret.sql'], ['*.sql', 'db/**.sql'], ['*.sql', 'db/?x.sql'], ['db/*', 'db/*'], ['db/**', 'db/**/x'], ['*secret*', 'a/**secret**'], ['*.ts', 'src/[id].ts'], ['*.ts', 'src/a?b*.ts']])
    assert.equal(RF.globMatches(g, p), true, `${g} ~ ${p}`);
  assert.equal(RF.globMatches('a*b', 'a*c'), false); assert.equal(RF.globMatches('x.sql', '*.sql'), false); assert.equal(RF.globMatches('db/x', 'db/*'), false);
  assert.equal(chk(repo(), ['db/*secret.sql']).floor, 'ELEVATED');
});

// ---- floor, final, profiles, record ----
test('AC1: a SCRUM-202-shaped plan touching a declared money path is floored to ELEVATED even when claimed and AI say STANDARD', () => {
  const r = chk(repo(), ['apps/api/src/billing/cart-validation.service.ts', 'apps/storefront/src/app/features/cart/cart.component.ts']);
  assert.equal(r.floor, 'ELEVATED'); assert.equal(r.final, 'ELEVATED'); assert.deepEqual(r.floor_classes, ['money']); assert.equal(RF.exitCodeFor(r), 2);
});
test('AC2: a typo-only plan is not floored', () => { const r = chk(repo(), ['README.md', 'docs/intro.md']); assert.equal(r.floor, 'STANDARD'); assert.equal(RF.exitCodeFor(r), 0); });
test('AC3: final = max(floor, claimed, ai); profiles are normalised, unknown ones fail closed', () => {
  const r = repo(), rank = { STANDARD: 0, ELEVATED: 1 };
  for (const hit of [true, false]) for (const c of ['STANDARD', 'standard', 'Elevated', ' ELEVATED ']) for (const a of ['STANDARD', 'elevated']) {
    const x = chk(r, [hit ? 'db/migrations/1.sql' : 'README.md'], c, a);
    assert.equal(rank[x.final], Math.max(hit ? 1 : 0, rank[c.trim().toUpperCase()], rank[a.toUpperCase()])); assert.equal(x.errors.length, 0);
  }
  for (const bad of ['garbage', '', 'LOW', null, 42, undefined]) for (const which of ['claimed', 'ai']) {
    const x = RF.check({ repo: r.dir, base: r.base, plannedPaths: ['README.md'], claimed: which === 'claimed' ? bad : 'STANDARD', ai: which === 'ai' ? bad : 'STANDARD' });
    assert.equal(x.final, 'ELEVATED'); assert.equal(RF.exitCodeFor(x), 1);
  }
});
test('AC4/M1: the record line names classes, counts, base and declaration hashes, never raw paths; errors in it are the real ones', () => {
  const r = repo(), x = chk(r, ['apps/api/src/billing/SECRET-customer-list.ts', 'README.md']);
  assert.match(x.record_line, /^risk-floor: floor=ELEVATED; classes=money; claimed=STANDARD; ai=STANDARD; final=ELEVATED; paths=2; matched=1; base=[0-9a-f]{12}; head=planned; declaration=[0-9a-f]{16}$/);
  assert.ok(x.record_line.includes(`base=${r.base.slice(0, 12)}`)); assert.ok(!x.record_line.includes('SECRET') && !JSON.stringify(x.reasons).includes('SECRET'));
  const y = RF.check({ repo: r.dir, base: 'nope', plannedPaths: ['a'], claimed: 'STANDARD', ai: 'STANDARD' }); assert.ok(y.record_line.includes('errors=base_invalid') && !y.record_line.includes('malformed_input'));
});

// ---- declaration handling ----
test('no declaration at base: floor STANDARD with no_risk_paths_declared; a declaration only in the working tree is ignored but counts as a declaration change', () => {
  const r = repo({ 'README.md': 'x' }, null);
  const x = chk(r, ['db/migrations/1.sql']); assert.equal(x.floor, 'STANDARD'); assert.deepEqual(x.reasons, ['no_risk_paths_declared']); assert.equal(RF.exitCodeFor(x), 0);
  assert.equal(chk(r, ['db/migrations/1.sql'], 'STANDARD', 'ELEVATED').final, 'ELEVATED');
  mkdirSync(join(r.dir, '.ship-ticket')); writeFileSync(join(r.dir, DECL_PATH), JSON.stringify(DECL));
  const y = chk(r, ['db/migrations/1.sql']); assert.ok(y.floor_classes.includes(RF.CHANGED)); assert.deepEqual(y.floor_classes.filter((c) => c !== RF.CHANGED), []);
});
test('M2/(d) any change to the declaration floors ELEVATED (risk_declaration_changed) at check and reassess; a legitimate edit can reach exit 0 when ELEVATED is recorded', () => {
  const exp = (x, code) => { assert.equal(x.final, 'ELEVATED'); assert.ok(x.floor_classes.includes(RF.CHANGED), JSON.stringify(x.floor_classes)); assert.equal(RF.exitCodeFor(x), code); };
  let r = repo(); exp(chk(r, [DECL_PATH, 'README.md']), 2); // planned path equal to the declaration
  r = repo(); exp(chk(r, ['.ship-ticket/other.json']), 2); // anything under .ship-ticket/
  r = repo(); writeFileSync(join(r.dir, DECL_PATH), JSON.stringify({ ...DECL, classes: DECL.classes.slice(0, 1) })); exp(chk(r, ['README.md']), 2); // working-tree edit
  r = repo(); writeFileSync(join(r.dir, DECL_PATH), JSON.stringify({ ...DECL, classes: DECL.classes.slice(0, 1) })); let h = commit(r.dir); exp(re(r, h), 2); exp(re(r, h, 'ELEVATED', 'STANDARD'), 0); // committed edit: exit 0 reachable
  r = repo(); rmSync(join(r.dir, DECL_PATH)); exp(re(r, commit(r.dir)), 2); // deletion
  r = repo(); G(r.dir, 'mv', DECL_PATH, '.ship-ticket/moved.json'); exp(re(r, commit(r.dir)), 2); // rename (both paths)
  r = repo({ 'README.md': 'x' }, null); mkdirSync(join(r.dir, '.ship-ticket')); writeFileSync(join(r.dir, DECL_PATH), JSON.stringify(DECL)); exp(re(r, commit(r.dir)), 2); // addition
  r = repo(); rmSync(join(r.dir, DECL_PATH)); exp(re(r, 'WORKTREE'), 2);
  assert.ok(chk(repo({ 'README.md': 'x' }, { version: 1, classes: [{ name: RF.CHANGED, floor: 'ELEVATED', globs: ['x'] }] }), ['README.md']).errors.includes('declaration_invalid')); // reserved class name
});
test('(d) tampering: a symlink, mode change, directory or gitlink in the declaration slot is declaration_tampered (exit 1), even with identical bytes', NIX, () => {
  const exp = (x) => { assert.equal(x.final, 'ELEVATED'); assert.ok(x.errors.includes('declaration_tampered'), JSON.stringify(x.errors)); assert.ok(x.record_line.includes('errors=declaration_tampered')); assert.equal(RF.exitCodeFor(x), 1); };
  let r = repo(); rmSync(join(r.dir, DECL_PATH)); symlinkSync('/nonexistent/target', join(r.dir, DECL_PATH)); exp(re(r, commit(r.dir)));
  r = repo(); const bytes = readFileSync(join(r.dir, DECL_PATH), 'utf8'); rmSync(join(r.dir, DECL_PATH)); writeFileSync(join(r.dir, 'real.json'), bytes); symlinkSync('real.json', join(r.dir, DECL_PATH)); exp(re(r, commit(r.dir)));
  r = repo(); chmodSync(join(r.dir, DECL_PATH), 0o755); exp(re(r, commit(r.dir)));
  r = repo(); chmodSync(join(r.dir, DECL_PATH), 0o755); exp(chk(r, ['README.md'])); // working-tree mode change at check time
  r = repo(); rmSync(join(r.dir, DECL_PATH)); mkdirSync(join(r.dir, DECL_PATH)); exp(re(r, 'WORKTREE')); exp(chk(r, ['README.md']));
  r = repo(); rmSync(join(r.dir, DECL_PATH)); symlinkSync('x', join(r.dir, DECL_PATH)); exp(chk(r, ['README.md']));
  r = repo(); G(r.dir, 'rm', '-q', '--cached', DECL_PATH); G(r.dir, 'update-index', '--add', '--cacheinfo', `160000,${r.base},${DECL_PATH}`); G(r.dir, 'commit', '-q', '-m', 'g'); exp(re(r, G(r.dir, 'rev-parse', 'HEAD'))); // gitlink at head
});
test('the declaration is read from base only: a staged edit restored in the working tree is still seen; schema, floor, names, globs, extra keys and bad JSON/encodings fail closed', () => {
  const r = repo(); const orig = readFileSync(join(r.dir, DECL_PATH)); writeFileSync(join(r.dir, DECL_PATH), JSON.stringify({ ...DECL, classes: DECL.classes.slice(0, 1) })); G(r.dir, 'add', DECL_PATH); writeFileSync(join(r.dir, DECL_PATH), orig);
  assert.ok(chk(r, ['README.md']).floor_classes.includes(RF.CHANGED)); assert.ok(re(r, 'WORKTREE').floor_classes.includes(RF.CHANGED)); // index differs, working tree equals base
  const bads = [{ version: 2, classes: DECL.classes }, { version: 1 }, { version: 1, classes: [] }, { version: 1, classes: [{ name: 'A', floor: 'ELEVATED', globs: ['x'] }] }, { version: 1, classes: [{ name: 'a', floor: 'STANDARD', globs: ['x'] }] },
    { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: [] }] }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['../x'] }] }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['/abs'] }] },
    { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: [5] }] }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['x'], extra: 1 }] },
    { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['x'] }, { name: 'a', floor: 'ELEVATED', globs: ['y'] }] }, { version: 1, classes: DECL.classes, extra: 1 }, []];
  for (const d of bads) { const x = chk(repo({ 'README.md': 'x' }, d), ['README.md']); assert.equal(x.final, 'ELEVATED', JSON.stringify(d)); assert.ok(x.errors.includes('declaration_invalid'), JSON.stringify(d)); }
  for (const text of ['{not json', 'null', '']) { const raw = repo({ 'README.md': 'x' }, null); mkdirSync(join(raw.dir, '.ship-ticket')); writeFileSync(join(raw.dir, DECL_PATH), text);
    assert.ok(RF.check({ repo: raw.dir, base: commit(raw.dir), plannedPaths: ['README.md'], claimed: 'STANDARD', ai: 'STANDARD' }).errors.includes('declaration_invalid'), text); }
  const u16 = repo({ 'README.md': 'x' }, null); mkdirSync(join(u16.dir, '.ship-ticket')); writeFileSync(join(u16.dir, DECL_PATH), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(DECL), 'utf16le')]));
  assert.ok(RF.check({ repo: u16.dir, base: commit(u16.dir), plannedPaths: ['README.md'], claimed: 'STANDARD', ai: 'STANDARD' }).errors.length);
});
test('the index entry of the declaration is compared: git rm --cached (working tree untouched) is a declaration change', () => {
  const r = repo(); G(r.dir, 'rm', '-q', '--cached', DECL_PATH);
  assert.ok(chk(r, ['README.md']).floor_classes.includes(RF.CHANGED));
});
test('--base and --repo are validated: flag-looking, unknown or missing values are errors with final ELEVATED', () => {
  const r = repo();
  for (const base of ['--output=x', 'nonexistent-ref', '', undefined]) { const x = RF.check({ repo: r.dir, base, plannedPaths: ['README.md'], claimed: 'STANDARD', ai: 'STANDARD' }); assert.equal(x.final, 'ELEVATED'); assert.equal(RF.exitCodeFor(x), 1); }
  assert.equal(RF.check({ repo: '/nonexistent', base: 'HEAD', plannedPaths: ['a'], claimed: 'STANDARD', ai: 'STANDARD' }).final, 'ELEVATED');
});

// ---- planned paths ----
test('malformed planned paths fail closed: shape, element types, NUL, surrogates, traversal, absolute, empty, oversized', () => {
  const r = repo();
  const bad = [null, undefined, {}, 'src/billing', 5, [], [''], [5], [null], ['a\u0000b'], ['a\uD800b'], ['a\uFFFDb'], ['../x'], ['/abs/x'], ['ok', '..'], ['x'.repeat(RF.MAX_INPUT + 1)], Array(RF.MAX_PATHS + 1).fill('a')];
  for (const p of bad) { const x = chk(r, p); assert.equal(x.final, 'ELEVATED'); assert.equal(RF.exitCodeFor(x), 1); assert.ok(x.errors.includes('malformed_input')); }
});
test('M6 planned directories and wildcards are conservative: they floor if a declared glob matches them, an ancestor, or anything that may lie below', () => {
  const r = repo();
  for (const p of ['db/', 'db', 'src/**', 'apps/', 'apps/api', 'apps/api/src/', 'apps/api/src/**/*.ts', 'apps/api/src/bill*', '*', '**/x']) assert.equal(chk(r, [p]).floor, 'ELEVATED', p);
  const narrow = repo({ 'README.md': 'x' }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['db/migrations/**'] }] });
  for (const p of ['db/', 'db', 'src/**', 'db/*', 'db/migrations/', '**']) assert.equal(chk(narrow, [p]).floor, p === 'src/**' ? 'STANDARD' : 'ELEVATED', p);
  for (const p of ['docs/', 'docs', 'README.md', 'src/app.ts']) assert.equal(chk(narrow, [p]).floor, 'STANDARD', p);
});

// ---- reassess ----
test('reassess: a change outside the plan that touches a declared path forces a raise; benign changes do not', () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a' });
  writeFileSync(join(r.dir, 'README.md'), 'typo fixed'); let h = commit(r.dir);
  let x = re(r, h); assert.equal(x.floor, 'STANDARD'); assert.equal(RF.exitCodeFor(x), 0);
  mkdirSync(join(r.dir, 'db/migrations'), { recursive: true }); writeFileSync(join(r.dir, 'db/migrations/2.sql'), 'alter'); h = commit(r.dir);
  x = re(r, h); assert.equal(x.floor, 'ELEVATED'); assert.deepEqual(x.floor_classes, ['schema']); assert.equal(RF.exitCodeFor(x), 2);
  assert.equal(RF.exitCodeFor(re(r, h, 'ELEVATED')), 0); assert.equal(RF.exitCodeFor(re(r, h, 'ELEVATED', 'STANDARD')), 0);
});
test('M1 base pinning: reassess needs the recorded line; a different base, a missing or duplicated record, or a non-ancestor base is base_mismatch (exit 1)', () => {
  const r = repo({ 'README.md': 'x' }); writeFileSync(join(r.dir, 'README.md'), 'y'); const h1 = commit(r.dir); writeFileSync(join(r.dir, 'README.md'), 'z'); const h2 = commit(r.dir);
  assert.equal(RF.exitCodeFor(re(r, h2)), 0);
  const other = { ...r, base: h1 }; // the caller picks a different base: the recorded line names the original
  for (const x of [RF.reassess({ repo: r.dir, base: h1, head: h2, recordedLine: line(r), claimed: 'STANDARD', ai: 'STANDARD' }), re(r, h2, 'STANDARD', 'STANDARD', line(r).replace(/base=[0-9a-f]{12}/, 'base=000000000000'))]) { assert.equal(x.final, 'ELEVATED'); assert.ok(x.errors.includes('base_mismatch')); assert.equal(RF.exitCodeFor(x), 1); }
  for (const bad of ['no record here', null, `${line(r)}\n${line(r)}`]) { const x = re(r, h2, 'STANDARD', 'STANDARD', bad); assert.equal(x.final, 'ELEVATED'); assert.ok(x.errors.includes('recorded_line_invalid')); assert.equal(RF.exitCodeFor(x), 1); }
  assert.equal(RF.exitCodeFor(RF.reassess({ repo: r.dir, base: h1, head: h2, recordedLine: line(other), claimed: 'STANDARD', ai: 'STANDARD' })), 0);
  G(r.dir, 'checkout', '-q', '-b', 'side', r.base); writeFileSync(join(r.dir, 'side.txt'), 's'); const side = commit(r.dir);
  const x = RF.reassess({ repo: r.dir, base: h2, head: side, recordedLine: line({ base: h2 }), claimed: 'STANDARD', ai: 'STANDARD' }); assert.ok(x.errors.includes('base_mismatch')); // base not an ancestor of head
});
test('B2 WORKTREE is the UNION of working tree, index and untracked: staged-then-restored, intent-to-add, staged deletion, staged rename, mode-only, untracked', () => {
  const mk = () => repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a', 'apps/api/src/auth/b.ts': 'b' });
  let r = mk(); const f = join(r.dir, 'apps/api/src/billing/a.ts');
  writeFileSync(f, 'changed'); G(r.dir, 'add', 'apps/api/src/billing/a.ts'); writeFileSync(f, 'a'); writeFileSync(join(r.dir, 'README.md'), 'edit'); // staged, then restored in the working tree
  assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['money']);
  r = mk(); mkdirSync(join(r.dir, 'db/migrations'), { recursive: true }); writeFileSync(join(r.dir, 'db/migrations/n.sql'), 'x'); G(r.dir, 'add', '-N', 'db/migrations/n.sql'); assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['schema']); // intent-to-add
  r = mk(); G(r.dir, 'rm', '-q', 'apps/api/src/auth/b.ts'); assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['auth']); // staged deletion
  r = mk(); G(r.dir, 'mv', 'apps/api/src/billing/a.ts', 'docs-a.ts'); assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['money']); // staged rename: the OLD path counts
  r = mk(); mkdirSync(join(r.dir, 'db/migrations'), { recursive: true }); writeFileSync(join(r.dir, 'db/migrations/new.sql'), 'x'); assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['schema']); // untracked
  r = mk(); assert.equal(re(r, 'WORKTREE').errors.includes('malformed_input'), true); // nothing changed: not a basis for STANDARD
});
test('B2 mode-only change counts in WORKTREE and in a commit', NIX, () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a' }); G(r.dir, 'config', 'core.fileMode', 'true'); chmodSync(join(r.dir, 'apps/api/src/billing/a.ts'), 0o755);
  assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['money']); assert.deepEqual(re(r, commit(r.dir)).floor_classes, ['money']);
});
test('reassess counts a committed rename (old AND new path), deletions; an assume-unchanged index flag fails closed', () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a'.repeat(200), 'apps/api/src/auth/b.ts': 'b' });
  G(r.dir, 'mv', 'apps/api/src/billing/a.ts', 'docs-a.ts'); assert.deepEqual(re(r, commit(r.dir)).floor_classes, ['money']);
  const r2 = repo({ 'README.md': 'x', 'apps/api/src/auth/b.ts': 'b' }); rmSync(join(r2.dir, 'apps/api/src/auth/b.ts')); assert.deepEqual(re(r2, commit(r2.dir)).floor_classes, ['auth']);
  G(r.dir, 'update-index', '--assume-unchanged', 'README.md'); const x = re(r, 'WORKTREE'); assert.equal(RF.exitCodeFor(x), 1); assert.ok(x.errors.includes('index_flags_hidden'));
});
test('reassess: newline/space filenames survive git -z; bad and flag-looking heads fail closed; no declaration gives the reason', NIX, () => {
  const r = repo({ 'README.md': 'x' });
  mkdirSync(join(r.dir, 'apps/api/src/billing'), { recursive: true }); writeFileSync(join(r.dir, 'apps/api/src/billing/new\nline name.ts'), 'x'); const h = commit(r.dir);
  assert.deepEqual(re(r, h).floor_classes, ['money']);
  for (const head of ['--output=x', 'no-such-ref', '', undefined]) assert.equal(RF.exitCodeFor(re(r, head)), 1, String(head));
  const dead = repo({ 'README.md': 'x' }, null); writeFileSync(join(dead.dir, 'db.sql'), 'x'); assert.deepEqual(re(dead, commit(dead.dir)).reasons, ['no_risk_paths_declared']);
});

// ---- confirmation repair: recorded line, HEAD in the union, git-side ignored pass, Unicode order, budgets ----
const rec = (r, o = {}) => `${o.key ?? 'risk_floor: '}risk-floor: floor=${o.floor ?? 'ELEVATED'}; classes=money; claimed=${o.claimed ?? 'STANDARD'}; ai=${o.ai ?? 'ELEVATED'}; final=${o.final ?? 'ELEVATED'}; paths=1; matched=1; base=${r.base.slice(0, 12)}; head=planned; declaration=${o.decl ?? 'abcdef0123456789'}`;
test('R-B1 the WHOLE recorded line counts: final is never lower than the recorded claim, ai or final (siblings: each field, now-values, strictness)', () => {
  const r = repo(); writeFileSync(join(r.dir, 'README.md'), 'typo'); const h = commit(r.dir);
  for (const o of [{}, { floor: 'STANDARD', ai: 'STANDARD', claimed: 'ELEVATED', final: 'STANDARD' }, { floor: 'STANDARD', ai: 'STANDARD', claimed: 'STANDARD', final: 'ELEVATED' }, { floor: 'STANDARD', ai: 'ELEVATED', claimed: 'STANDARD', final: 'STANDARD' }]) {
    const x = re(r, h, 'STANDARD', 'STANDARD', rec(r, o)); assert.equal(x.floor, 'STANDARD'); assert.equal(x.final, 'ELEVATED', JSON.stringify(o)); assert.equal(RF.exitCodeFor(x), 2, JSON.stringify(o));
    assert.equal(RF.exitCodeFor(re(r, h, 'ELEVATED', 'STANDARD', rec(r, o))), 0);
  }
  const ok = re(r, h, 'STANDARD', 'STANDARD', rec(r, { ai: 'STANDARD', final: 'STANDARD', floor: 'STANDARD' })); assert.equal(RF.exitCodeFor(ok), 0);
  for (const bad of [rec(r).replace('ai=ELEVATED', 'ai=LOW'), rec(r).replace('; paths=1', '; extra=1; paths=1'), `${rec(r)}\n${rec(r)}`, `${rec(r)}\n${rec(r, { key: 'risk_floor: ' })}`, rec(r) + '; trailing', rec(r).replace('final=ELEVATED', 'final=')]) {
    const x = re(r, h, 'ELEVATED', 'ELEVATED', bad); assert.equal(RF.exitCodeFor(x), 1, bad); assert.ok(x.errors.includes('recorded_line_invalid'), bad);
  }
  assert.equal(RF.exitCodeFor(re(r, h, 'STANDARD', 'STANDARD', `${rec(r)}\n${rec(r, { key: 'risk_reassess: ' })}`)), 2); // a risk_reassess: line is ignored, not a duplicate
  assert.equal(RF.exitCodeFor(re(r, h, 'ELEVATED', 'ELEVATED', rec(r).replace('risk_floor: ', ''))), 0); // the bare check line is accepted
  assert.equal(RF.exitCodeFor(re(r, h, 'ELEVATED', 'ELEVATED', `     ${rec(r)}`)), 0); // the plan template indents header lines
  const inc = re(r, h, 'ELEVATED', 'ELEVATED', rec(r, { floor: 'ELEVATED', final: 'STANDARD' })); assert.ok(inc.errors.includes('recorded_line_invalid')); // a floor above its own final is inconsistent
});
test('R-M2 WORKTREE includes base->HEAD: a committed change restored in index and working tree still counts (paths and declaration)', () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a' });
  writeFileSync(join(r.dir, 'apps/api/src/billing/a.ts'), 'changed'); commit(r.dir); G(r.dir, 'checkout', r.base, '--', 'apps/api/src/billing/a.ts'); writeFileSync(join(r.dir, 'README.md'), 'edit');
  assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['money']);
  const d = repo(); writeFileSync(join(d.dir, DECL_PATH), JSON.stringify({ ...DECL, classes: DECL.classes.slice(0, 1) })); commit(d.dir); G(d.dir, 'checkout', d.base, '--', DECL_PATH);
  assert.ok(re(d, 'WORKTREE').floor_classes.includes(RF.CHANGED)); assert.ok(chk(d, ['README.md']).floor_classes.includes(RF.CHANGED)); // also at check time
});
test('git-IGNORED untracked files are outside release scope (not enumerated, no second engine); a FORCE-ADDED ignored file is caught by the index and HEAD diffs', () => {
  const r = repo({ 'README.md': 'x' }); writeFileSync(join(r.dir, '.git/info/exclude'), 'apps/\n.env\n*.sql\n.ship-ticket/other.json\n'); writeFileSync(join(r.dir, 'README.md'), 'edit');
  mkdirSync(join(r.dir, 'apps/api/src/auth'), { recursive: true }); writeFileSync(join(r.dir, 'apps/api/src/auth/x.ts'), 'x'); writeFileSync(join(r.dir, '.env'), 'S=1'); writeFileSync(join(r.dir, 'q.sql'), 'x');
  const x = re(r, 'WORKTREE'); assert.equal(x.counts.paths, 1); assert.equal(x.floor, 'STANDARD'); assert.equal(x.errors.length, 0); // ignored files do not exist for the floor
  G(r.dir, 'add', '-f', '.env', 'q.sql', 'apps/api/src/auth/x.ts'); const y = re(r, 'WORKTREE'); assert.deepEqual(y.floor_classes, ['auth', 'schema']); // staged by force: seen through the index
  const h = commit(r.dir); const z = re(r, h); assert.deepEqual(z.floor_classes, ['auth', 'schema']); // and through the commit
  const src = readFileSync(SCRIPT, 'utf8'); assert.doesNotMatch(src, /GIT_LITERAL_PATHSPECS: '0'|'-o', '-i'|\$\{x\}`/); assert.match(src, /outside release scope/);
});
test('check and reassess classify EACH path identically (one engine; planned-directory conservatism is the only intended difference)', () => {
  const paths = ['.env', 'db/x.sql', 'DB/MIGRATIONS/1.SQL', 'apps/api/src/billing/a.ts', 'apps/api/src/auth/Cafe\u0301.ts', 'apps/api/src/AUTH/x.ts', 'src/checkout/pay.ts', 'README.md', 'docs/a b.md', 'apps/api/src/pricing/x/y.ts', 'a.pricing.ts', 'libs/none/z.ts'];
  const r = repo({ 'README.md': 'x' }); let base = r.base, n = 0;
  for (const f of paths) {
    mkdirSync(dirname(join(r.dir, f)), { recursive: true }); writeFileSync(join(r.dir, f), `v${n++}`); const h = commit(r.dir);
    const a = chk(r, [f]), b = RF.reassess({ repo: r.dir, base, head: h, recordedLine: line({ base }), claimed: 'STANDARD', ai: 'STANDARD' });
    assert.deepEqual(a.floor_classes, b.floor_classes, f); assert.equal(a.counts.matched, b.counts.matched, f); base = h; // roll the base forward so each reassess sees exactly one new path
  }
});
test('bounded enumeration: caps apply WHILE scanning (before any array/view is built), dedupe precedes counting, and hidden-flag scanning allocates nothing', () => {
  const nul = (n, f = (i) => `p${i}`) => Buffer.from(Array.from({ length: n }, (_, i) => f(i)).join('\0') + '\0');
  const big = nul(RF.MAX_PATHS + 1);
  assert.throws(() => RF.addEntries(new Map(), big), (e) => e.code === 'malformed_input');
  const m = new Map(); RF.addEntries(m, nul(150_000)); RF.addEntries(m, nul(150_000)); assert.equal(m.size, 150_000); // duplicates across union components are counted once
  assert.throws(() => RF.addEntries(m, nul(60_000, (i) => `q${i}`)), (e) => e.code === 'malformed_input'); // 150k + 60k distinct > cap
  assert.equal(RF.hiddenFlagged(Buffer.from('H a\0h b\0S c\0')), true); assert.equal(RF.hiddenFlagged(Buffer.from('H a\0H b\0')), false);
});
test('a FIFO installed AFTER lstat (race) fails closed without hanging: O_NONBLOCK + fstat before read', NIX, (t) => {
  const r = repo(); const full = join(r.dir, DECL_PATH);
  const probe = join(r.dir, 'probe.fifo'); if (spawnSync('mkfifo', [probe]).status !== 0) return t.skip('mkfifo is unavailable on this platform'); rmSync(probe);
  RF.testHooks.afterLstat = () => { rmSync(full); spawnSync('mkfifo', [full]); };
  try { const x = chk(r, ['README.md']); assert.ok(x.errors.includes('declaration_tampered'), JSON.stringify(x.errors)); assert.equal(RF.exitCodeFor(x), 1); } finally { RF.testHooks.afterLstat = null; }
  const r2 = repo(); rmSync(join(r2.dir, DECL_PATH)); spawnSync('mkfifo', [join(r2.dir, DECL_PATH)]); assert.ok(chk(r2, ['README.md']).errors.includes('declaration_tampered')); // already a FIFO at lstat
});
test('Unicode order and case folding: Cf stripped, NFC, then PER-CODE-POINT case folding (no context), on pattern AND path', () => {
  const yes = [['café.ts', 'cafe\u200d\u0301.ts'], ['café.ts', 'cafe\u0301.ts'], ['cafe\u0301.ts', 'café.ts'], ['CAFÉ.ts', 'cafe\u200d\u0301.ts'], ['caf\u200de\u0301.ts', 'CAFÉ.TS'],
    ['οσ/**', 'ΟΣ/x.ts'], ['ος/**', 'ΟΣ/x.ts'], ['οσ/**', 'ος/x.ts'], ['ΟΣ/**', 'οσ/x'], ['strasse', 'STRASSE'], ['strasse', 'straße'], ['STRASSE', 'straße/x.ts'], ['istanbul', 'İSTANBUL'], ['İSTANBUL', 'istanbul/x'],
    ['strasse.ts', 'STRAẞE.ts'], ['straße.ts', 'STRAẞE.ts'], ['straße.ts', 'STRASSE.ts'], ['STRAẞE/**', 'strasse/x'], ['οσ*.ts', 'οσα.ts'], ['οσ*.ts', 'ΟΣΑ.ts'], ['οσ*.ts', 'οςα.ts'], ['*σ', 'ΛΟΓΟΣ'], ['*ς', 'λογοσ'], ['λογος/**', 'ΛΟΓΟΣ/x'],
    ['kelvin', '\u212Aelvin'], ['\u212Aelvin', 'kelvin'], ['caf\u0065\u0301/**', 'CAF\u00C9/x'], ['ხ/**', 'ხ/x'], ['\u13A0\u13A1/**', '\uAB70\uAB71/x'], ['file', '\uFB01le'], ['isim', '\u0131s\u0131m']];
  for (const [g, p] of yes) assert.equal(RF.globMatches(g, p), true, JSON.stringify([g, p]));
  // stated behaviour: upper/lower folding also folds the ligature U+FB01 to fi and dotless i to i (over-classifies, never under); unrelated spellings stay apart
  for (const [g, p] of [['strasse', 'strase'], ['ss', 's']]) assert.equal(RF.globMatches(g, p), false, JSON.stringify([g, p]));
});
test('case-variant property: every sample name, in generated case/Unicode variants, gives a stable result as a pattern and as a path', () => {
  const per = (x, f) => [...x].map(f).join('');
  for (const k of ['billing', 'apps/api/src/auth', 'db migrations', 'Café', 'Straße', 'λογος', 'ΛΟΓΟΣ', 'οσα', 'İstanbul', 'Köln', 'ǅ', 'ᾈ', 'ﬁle', '\u212Aelvin', 'ǆ-x']) {
    const w = k.replace(/ /g, '-'), vs = new Set([w, w.toUpperCase(), w.toLowerCase(), per(w, (c) => c.toUpperCase()), per(w, (c) => c.toLowerCase()), w.replace(/^./, (c) => c.toUpperCase()), w.normalize('NFD'), w.normalize('NFC')]);
    for (const a of vs) for (const b of vs) assert.equal(RF.globMatches(a, `${b}/x.ts`), true, `${a} ~ ${b}`);
  }
});
test('budgets count every DP row/cell: 200 classes x 32-segment ** patterns against 200000 planned paths fail closed fast; one pair stays within the bound', () => {
  const glob = Array.from({ length: 32 }, (_, i) => (i % 2 ? 'a' : '**')).join('/'), g = RF.compileGlob(glob), ctx = { steps: 0 };
  RF.matchSegments(g, ['a', 'a', 'a'], ctx); assert.ok(ctx.steps > 30 && ctx.steps <= RF.STEP_BOUND_PER_PAIR, String(ctx.steps));
  const dec = repo({ 'README.md': 'x' }, { version: 1, classes: Array.from({ length: 200 }, (_, i) => ({ name: `c${i}`, floor: 'ELEVATED', globs: [['**', `z${i}`, ...Array.from({ length: 30 }, (_, k) => (k % 2 ? 'a' : '**'))].join('/')] })) });
  const t = Date.now(), x = chk(dec, Array(RF.MAX_PATHS).fill('a/a/a')); assert.equal(x.final, 'ELEVATED'); assert.ok(x.errors.includes('malformed_input')); assert.ok(Date.now() - t < 60_000);
});

// ---- CLI ----
test('CLI: exit 0 / 2 / 1, both flag forms, strict parsing, own-property commands, recorded line from file or stdin', () => {
  const r = repo(), common = ['--base', r.base, '--repo', r.dir, '--claimed', 'STANDARD', '--ai', 'STANDARD'];
  assert.equal(cli(['check', '--planned-paths', '["README.md"]', ...common]).status, 0);
  const hi = cli(['check', '--planned-paths', '["db/migrations/1.sql"]', ...common]); assert.equal(hi.status, 2); assert.equal(out(hi).final, 'ELEVATED');
  assert.equal(cli(['check', `--base=${r.base}`, `--repo=${r.dir}`, '--claimed=elevated', '--ai=standard', '--planned-paths=["db/migrations/1.sql"]']).status, 0);
  assert.equal(cli(['check', '--planned-paths', tmpFile('["README.md"]'), ...common]).status, 0);
  writeFileSync(join(r.dir, 'x.txt'), 'x');
  assert.equal(cli(['reassess', '--head', 'WORKTREE', '--recorded-line', '-', ...common], line(r)).status, 0);
  assert.equal(cli(['reassess', '--head', 'WORKTREE', '--recorded-line', tmpFile(line(r)), ...common]).status, 0);
  assert.equal(cli(['reassess', '--head', 'WORKTREE', '--recorded-line', tmpFile('nothing'), ...common]).status, 1);
  const bads = [[], ['check'], ['verify'], ['check', ...common], ['check', '--planned-paths', '["a"]', ...common, '--ai', 'STANDARD'], ['check', '--planned-paths', '["a"]', ...common, 'extra'], ['check', '--planned-paths', '["a"]', ...common, '--nope', 'x'],
    ['check', '--planned-paths', ...common], ['check', '--planned-paths', '--base', r.base], ['reassess', '--planned-paths', '["a"]', ...common], ['reassess', '--head', 'WORKTREE', ...common]];
  for (const a of bads) { const x = cli(a); assert.equal(x.status, 1, a.join(' ')); assert.equal(out(x).final, 'ELEVATED'); }
  for (const c of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) { const x = cli([c, '--base', 'x', '--claimed', 'S']); assert.equal(x.status, 1, c); assert.equal(out(x).final, 'ELEVATED'); }
  for (const p of ['{"a":1}', '"x"', 'null', '[1]', '[""]', '[bad', '[]', '["../x"]', '["a\\u0000b"]', '["a\\ud800"]', '/nonexistent/file.json']) assert.equal(cli(['check', '--planned-paths', p, ...common]).status, 1, p);
  for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('["a"]', 'utf16le')]), Buffer.from('["a\0b"]'), Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]), Buffer.alloc(RF.MAX_INPUT + 1, 97)]) assert.equal(cli(['check', '--planned-paths', tmpFile(bytes), ...common]).status, 1);
  for (const c of ['garbage', '']) assert.equal(cli(['check', '--planned-paths', '["README.md"]', '--base', r.base, '--repo', r.dir, '--claimed', c, '--ai', 'STANDARD']).status, 1);
});

// ---- docs ----
test('docs: debate rule is consistent, the unrelated preflight paragraph is intact, honesty wording, no keyword floor left', () => {
  const root = new URL('../', import.meta.url);
  const files = ['SKILL.md', ...readdirSync(new URL('references/', root)).map((f) => `references/${f}`)];
  for (const f of files) {
    const t = readFileSync(new URL(f, root), 'utf8');
    assert.doesNotMatch(t, /debate runs only for money or auth|cross-model plan debate\s+only for money or auth|Skip it, and record the skip, for UI|only a ticket below the floor may record|only below the floor\./i, f);
    assert.doesNotMatch(t, /risk-floor\.mjs verify|verify --plan|best-effort lexical|--ticket <file/, f);
  }
  const ref = (f) => readFileSync(new URL(f, root), 'utf8').replace(/\s+/g, ' ');
  assert.match(ref('SKILL.md'), /If the independent primary route or enforceable deadline is absent, follow the capability\/explicit-exception procedure in the review reference before REVIEW begins\. Missing Codex falls back to a fresh Fable session; if neither can run, use \*\*WAIT_FOR_USER\*\* — the second opinion is mandatory\. Missing concurrency only serializes the two reviews\./);
  // RC-1 (owner-approved): the PLAN debate is required for security-sensitive work only, not for every ELEVATED ticket.
  assert.match(ref('references/cross-model.md'), /PLAN debate is required only for security-sensitive work .* not for every ELEVATED ticket/);
  assert.match(ref('SKILL.md'), /Use the cross-model plan debate only for security-sensitive work/); assert.match(ref('SKILL.md'), /including other ELEVATED ones, skip it/);
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, root), 'utf8').replace(/\s+/g, ' '), /debate (?:is )?required when the risk floor|risk floor or your own assessment is ELEVATED/, f);
  for (const f of ['SKILL.md', 'references/plan.md']) { assert.match(ref(f), /not evidence of low risk/); assert.match(ref(f), /advisory, not enforced/i); }
  assert.match(ref('SKILL.md'), /no_risk_paths_declared/); assert.match(ref('SKILL.md'), /ignored/i); assert.match(ref('SKILL.md'), /Pin `--base`/); assert.match(ref('SKILL.md'), /--recorded-line <file\|->/); assert.match(ref('references/plan.md'), /risk_reassess/); assert.match(ref('scripts/risk-floor.mjs'), /worst-case/i); assert.match(ref('SKILL.md'), /outside release scope/); assert.match(ref('references/plan.md'), /outside release scope/); assert.match(ref('scripts/risk-floor.mjs'), /serves PLANNED and ACTUAL paths/); assert.doesNotMatch(ref('scripts/risk-floor.mjs'), /ONLY for PLANNED/);
  assert.doesNotMatch(ref('SKILL.md') + ref('scripts/risk-floor.mjs'), /never under-classify|is final: it forces/);
  assert.doesNotThrow(() => RF.validateDeclaration(JSON.parse(readFileSync(new URL('references/risk-paths.example.json', root), 'utf8'))));
});

test('fold expansion cannot exceed the matched-text budget (ﬃ expands 3x): post-fold length is enforced, fail closed', () => {
  // 4096 raw characters pass the raw limit but fold to 12288: must be malformed_input, never matched with an oversized text.
  assert.throws(() => RF.globMatches('a', 'ﬃ'.repeat(4096)), (e) => e.code === 'malformed_input');
  assert.throws(() => RF.compileGlob('ﬃ'.repeat(256)), (e) => e.code === 'malformed_input');
  // within the budget after folding it still matches (fold works): 1365 ligatures fold to 4095 characters
  assert.equal(RF.globMatches('ffi*', 'ﬃ'.repeat(1365)), true);
  assert.doesNotThrow(() => RF.compileGlob('ﬃ'.repeat(85)));
});
