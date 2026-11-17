// Tests for risk-floor.mjs, the structural path floor (S-10 / ASTF-11). Assertions are on codes and shapes, not message text.
// Repositories are built in temp directories with the local git binary (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as RF from './risk-floor.mjs';

const SCRIPT = fileURLToPath(new URL('./risk-floor.mjs', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8' });
const out = (r) => JSON.parse(r.stdout);
const G = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const DECL = { version: 1, classes: [
  { name: 'money', floor: 'ELEVATED', globs: ['apps/api/src/billing/**', 'apps/api/src/pricing/', '**/checkout/**', '*.pricing.ts', 'src/cart-validation.service.ts'] },
  { name: 'auth', floor: 'ELEVATED', globs: ['apps/api/src/auth/**', 'apps/api/src/middleware/auth*.ts', 'src/[id]/page.tsx', '.env'] },
  { name: 'schema', floor: 'ELEVATED', globs: ['db/migrations/**', '*.sql'] }] };
function repo(files = { 'README.md': 'x\n' }, decl = DECL) {
  const dir = mkdtempSync(join(tmpdir(), 'rfrepo-'));
  G(dir, 'init', '-q', '-b', 'main');
  const all = decl ? { ...files, '.ship-ticket/risk-paths.json': JSON.stringify(decl) } : files;
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: G(dir, 'rev-parse', 'HEAD') };
}
const commit = (dir, msg = 'c') => { G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', msg); return G(dir, 'rev-parse', 'HEAD'); };
const chk = (r, paths, claimed = 'STANDARD', ai = 'STANDARD') => RF.check({ repo: r.dir, base: r.base, plannedPaths: paths, claimed, ai });
const cli = (args, input) => run(args, input);

// ---- globs ----
test('glob semantics: ** spans segments, * stays in a segment, no-slash patterns match at any depth, trailing slash is dir/**', () => {
  const y = [['apps/api/src/billing/**', 'apps/api/src/billing/a/b/c.ts'], ['apps/api/src/billing/**', 'apps/api/src/billing'], ['*.sql', 'db/a/b/x.sql'], ['**/checkout/**', 'a/b/checkout/c/d'],
    ['apps/api/src/pricing/', 'apps/api/src/pricing/x/y.ts'], ['auth*.ts', 'src/middleware/authz.ts'], ['a?c.ts', 'abc.ts'], ['src/[id]/page.tsx', 'src/[id]/page.tsx'], ['a/**/b', 'a/b'], ['a/**/b', 'a/x/y/b']];
  for (const [g, p] of y) assert.equal(RF.globMatches(g, p), true, `${g} ~ ${p}`);
  const n = [['apps/api/src/billing/**', 'apps/api/src/billings/x.ts'], ['apps/api/src/billing/**', 'xapps/api/src/billing/x.ts'], ['*.sql', 'db/x.sql.bak'], ['src/*.ts', 'src/a/b.ts'],
    ['a?c.ts', 'ac.ts'], ['src/[id]/page.tsx', 'src/1/page.tsx'], ['db/migrations/**', 'db/migration/x.sql'.replace('.sql', '.md')]];
  for (const [g, p] of n) assert.equal(RF.globMatches(g, p), false, `${g} !~ ${p}`);
});

test('glob path forms: case, backslashes, ./ and dot segments, trailing slash, NFD, spaces, newlines, symlink-looking names', () => {
  const g = 'apps/api/src/billing/**';
  const forms = ['apps/api/src/billing/x.ts', 'APPS/API/SRC/BILLING/X.TS', 'apps\\api\\src\\billing\\x.ts', './apps/api/src/billing/x.ts', 'apps/./api//src/billing/x.ts', 'apps/api/src/billing/x/',
    'apps/api/src/billing/ spaced name .ts', 'apps/api/src/billing/line\nbreak.ts', 'apps/api/src/billing/link -> etc-passwd', 'apps/api/src/billing/Café.ts', 'apps/api/src/billing/Cafe\u0301.ts'];
  for (const f of forms) assert.equal(RF.globMatches(g, f), true, JSON.stringify(f));
  assert.equal(RF.globMatches('apps/api/src/billing/café.ts', 'apps/api/src/billing/Cafe\u0301.ts'), true); // NFD vs NFC
  for (const b of ['../apps/api/src/billing/x.ts', 'apps/../billing/x.ts', '/apps/api/src/billing/x.ts', 'C:\\apps\\x.ts', '', '.', './', 'a\u0000b', 'a\uD800b', 'a\uFFFDb', 5, null]) assert.throws(() => RF.globMatches(g, b), (e) => e.code === 'malformed_input', String(b));
  for (const b of ['../x', '/abs', '', 'a/../b']) assert.throws(() => RF.compileGlob(b), (e) => e.code === 'malformed_input');
});

test('glob performance: pathological patterns and 50k paths stay fast', () => {
  const t = Date.now();
  assert.equal(RF.globMatches('a*a*a*a*a*a*a*b', 'a'.repeat(5000)), false);
  assert.equal(RF.globMatches('**/**/**/**/x', 'a/'.repeat(500) + 'y'), false);
  const paths = Array.from({ length: 50_000 }, (_, i) => `src/m${i}/file${i}.ts`);
  const r = chk(repo(), paths);
  assert.equal(r.floor, 'STANDARD'); assert.equal(r.counts.paths, 50_000);
  assert.ok(Date.now() - t < 8000);
});

// ---- floor, final, profiles ----
test('AC1: a SCRUM-202-shaped plan touching a declared money path is floored to ELEVATED even when claimed and AI say STANDARD', () => {
  const r = chk(repo(), ['apps/api/src/billing/cart-validation.service.ts', 'apps/storefront/src/app/features/cart/cart.component.ts']);
  assert.equal(r.floor, 'ELEVATED'); assert.equal(r.final, 'ELEVATED'); assert.deepEqual(r.floor_classes, ['money']); assert.equal(RF.exitCodeFor(r), 2);
});
test('AC2: a typo-only plan is not floored', () => {
  const r = chk(repo(), ['README.md', 'docs/intro.md']);
  assert.equal(r.floor, 'STANDARD'); assert.equal(r.final, 'STANDARD'); assert.equal(RF.exitCodeFor(r), 0);
});
test('AC3: final = max(floor, claimed, ai) and never lower than any of them; profiles are normalised, unknown ones fail closed', () => {
  const r = repo(), hit = ['db/migrations/1.sql'], miss = ['README.md'];
  const rank = { STANDARD: 0, ELEVATED: 1 };
  for (const paths of [hit, miss]) for (const c of ['STANDARD', 'standard', 'Elevated', ' ELEVATED ']) for (const a of ['STANDARD', 'elevated']) {
    const x = chk(r, paths, c, a), want = Math.max(paths === hit ? 1 : 0, rank[c.trim().toUpperCase()], rank[a.toUpperCase()]);
    assert.equal(rank[x.final], want, `${paths}/${c}/${a}`); assert.equal(x.errors.length, 0);
  }
  for (const bad of ['garbage', '', 'LOW', null, 42, undefined]) for (const which of ['claimed', 'ai']) {
    const x = RF.check({ repo: r.dir, base: r.base, plannedPaths: miss, claimed: which === 'claimed' ? bad : 'STANDARD', ai: which === 'ai' ? bad : 'STANDARD' });
    assert.equal(x.final, 'ELEVATED'); assert.equal(RF.exitCodeFor(x), 1); assert.ok(x.errors.length);
  }
});
test('AC4: the record line names classes and counts only, never raw paths', () => {
  const x = chk(repo(), ['apps/api/src/billing/SECRET-customer-list.ts', 'README.md'], 'STANDARD', 'STANDARD');
  assert.match(x.record_line, /^risk-floor: floor=ELEVATED; classes=money; claimed=STANDARD; ai=STANDARD; final=ELEVATED; paths=2; matched=1; declaration=[0-9a-f]{16}$/);
  assert.ok(!x.record_line.includes('SECRET') && !JSON.stringify(x.reasons).includes('SECRET'));
});

// ---- declaration handling ----
test('no declaration at base: floor STANDARD with reason no_risk_paths_declared; a declaration only in the working tree is ignored', () => {
  const r = repo({ 'README.md': 'x' }, null);
  const x = chk(r, ['db/migrations/1.sql']); assert.equal(x.floor, 'STANDARD'); assert.deepEqual(x.reasons, ['no_risk_paths_declared']); assert.equal(RF.exitCodeFor(x), 0);
  assert.equal(chk(r, ['db/migrations/1.sql'], 'STANDARD', 'ELEVATED').final, 'ELEVATED'); // the AI assessment still raises
  mkdirSync(join(r.dir, '.ship-ticket')); writeFileSync(join(r.dir, '.ship-ticket/risk-paths.json'), JSON.stringify(DECL));
  assert.equal(chk(r, ['db/migrations/1.sql']).floor, 'STANDARD');
});
test('the declaration is read from base: a working-tree edit, deletion or replacement fails closed (declaration_tampered)', () => {
  const f = (r) => join(r.dir, '.ship-ticket/risk-paths.json');
  let r = repo(); writeFileSync(f(r), JSON.stringify({ version: 1, classes: [{ name: 'x', floor: 'ELEVATED', globs: ['nothing/**'] }] }));
  let x = chk(r, ['README.md']); assert.equal(x.final, 'ELEVATED'); assert.ok(x.errors.includes('declaration_tampered')); assert.equal(RF.exitCodeFor(x), 1);
  r = repo(); rmSync(f(r)); assert.ok(chk(r, ['README.md']).errors.includes('declaration_tampered'));
  r = repo(); rmSync(f(r)); mkdirSync(f(r)); assert.ok(chk(r, ['README.md']).errors.includes('declaration_tampered'));
});
test('an invalid declaration at base fails closed: schema, floor, names, globs, traversal, extra keys', () => {
  const bads = [{ version: 2, classes: DECL.classes }, { version: 1 }, { version: 1, classes: [] }, { version: 1, classes: [{ name: 'A', floor: 'ELEVATED', globs: ['x'] }] },
    { version: 1, classes: [{ name: 'a', floor: 'STANDARD', globs: ['x'] }] }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: [] }] }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['../x'] }] },
    { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['/abs'] }] }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: [5] }] }, { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['x'], extra: 1 }] },
    { version: 1, classes: [{ name: 'a', floor: 'ELEVATED', globs: ['x'] }, { name: 'a', floor: 'ELEVATED', globs: ['y'] }] }, { version: 1, classes: DECL.classes, extra: 1 }, []];
  for (const d of bads) { const x = chk(repo({ 'README.md': 'x' }, d), ['README.md']); assert.equal(x.final, 'ELEVATED', JSON.stringify(d)); assert.ok(x.errors.includes('declaration_invalid'), JSON.stringify(d)); }
  for (const text of ['{not json', 'null', '']) {
    const raw = repo({ 'README.md': 'x' }, null); mkdirSync(join(raw.dir, '.ship-ticket')); writeFileSync(join(raw.dir, '.ship-ticket/risk-paths.json'), text); const b = commit(raw.dir);
    assert.ok(RF.check({ repo: raw.dir, base: b, plannedPaths: ['README.md'], claimed: 'STANDARD', ai: 'STANDARD' }).errors.includes('declaration_invalid'), text);
  }
  const u16 = repo({ 'README.md': 'x' }, null); mkdirSync(join(u16.dir, '.ship-ticket')); writeFileSync(join(u16.dir, '.ship-ticket/risk-paths.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(DECL), 'utf16le')]));
  assert.ok(RF.check({ repo: u16.dir, base: commit(u16.dir), plannedPaths: ['README.md'], claimed: 'STANDARD', ai: 'STANDARD' }).errors.length);
});
test('--base is validated: a flag-looking, unknown or missing base is an error with final ELEVATED', () => {
  const r = repo();
  for (const base of ['--output=x', 'nonexistent-ref', '', undefined]) { const x = RF.check({ repo: r.dir, base, plannedPaths: ['README.md'], claimed: 'STANDARD', ai: 'STANDARD' }); assert.equal(x.final, 'ELEVATED'); assert.equal(RF.exitCodeFor(x), 1); }
  assert.equal(RF.check({ repo: '/nonexistent', base: 'HEAD', plannedPaths: ['a'], claimed: 'STANDARD', ai: 'STANDARD' }).final, 'ELEVATED');
});

// ---- malformed planned paths ----
test('malformed planned paths fail closed (library): shape, element types, NUL, surrogates, traversal, absolute, empty, oversized', () => {
  const r = repo();
  const bad = [null, undefined, {}, 'src/billing', 5, [], [''], [5], [null], ['a\u0000b'], ['a\uD800b'], ['a\uFFFDb'], ['../x'], ['/abs/x'], ['ok', '..'], ['x'.repeat(RF.MAX_INPUT + 1)], Array(RF.MAX_PATHS + 1).fill('a')];
  for (const p of bad) { const x = chk(r, p); assert.equal(x.final, 'ELEVATED', JSON.stringify(p)?.slice(0, 60)); assert.equal(RF.exitCodeFor(x), 1); assert.ok(x.errors.includes('malformed_input')); }
});

// ---- reassess against the ACTUAL changed paths ----
const re = (r, head, claimed = 'STANDARD', ai = 'STANDARD') => RF.reassess({ repo: r.dir, base: r.base, head, claimed, ai });
test('reassess: a change outside the plan that touches a declared path forces a raise; benign changes do not', () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a' });
  writeFileSync(join(r.dir, 'README.md'), 'typo fixed'); let h = commit(r.dir);
  let x = re(r, h); assert.equal(x.floor, 'STANDARD'); assert.equal(RF.exitCodeFor(x), 0);
  mkdirSync(join(r.dir, 'db/migrations'), { recursive: true }); writeFileSync(join(r.dir, 'db/migrations/2.sql'), 'alter'); h = commit(r.dir);
  x = re(r, h); assert.equal(x.floor, 'ELEVATED'); assert.deepEqual(x.floor_classes, ['schema']); assert.equal(RF.exitCodeFor(x), 2);
  assert.equal(RF.exitCodeFor(re(r, h, 'ELEVATED')), 0);
  assert.equal(RF.exitCodeFor(re(r, h, 'ELEVATED', 'STANDARD')), 0);
});
test('reassess counts renames (old AND new path), deletions, mode-only changes and untracked files', () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a', 'apps/api/src/auth/b.ts': 'b', 'tools/run.sh': 'echo' });
  renameSync(join(r.dir, 'apps/api/src/billing/a.ts'), join(r.dir, 'docs-a.ts')); assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['money']); // new path benign, old path sensitive
  G(r.dir, 'checkout', '-q', '--', '.'); G(r.dir, 'clean', '-fdq');
  rmSync(join(r.dir, 'apps/api/src/auth/b.ts')); assert.deepEqual(re(r, commitAll(r)).floor_classes, ['auth']); // deletion
});
const commitAll = (r) => commit(r.dir);
test('reassess: mode-only change and untracked file in WORKTREE mode', () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a' });
  G(r.dir, 'config', 'core.fileMode', 'true'); chmodSync(join(r.dir, 'apps/api/src/billing/a.ts'), 0o755);
  assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['money']);
  G(r.dir, 'checkout', '-q', '--', '.');
  mkdirSync(join(r.dir, 'db/migrations'), { recursive: true }); writeFileSync(join(r.dir, 'db/migrations/new.sql'), 'x');
  assert.deepEqual(re(r, 'WORKTREE').floor_classes, ['schema']);
  assert.equal(re(r, 'HEAD').errors.includes('malformed_input'), true); // HEAD == base: zero changed paths is not a basis for STANDARD
});
test('reassess: a committed rename counts the OLD sensitive path; an assume-unchanged index flag fails closed', () => {
  const r = repo({ 'README.md': 'x', 'apps/api/src/billing/a.ts': 'a'.repeat(200) });
  G(r.dir, 'mv', 'apps/api/src/billing/a.ts', 'docs-a.ts'); const h = commit(r.dir);
  assert.deepEqual(re(r, h).floor_classes, ['money']);
  G(r.dir, 'update-index', '--assume-unchanged', 'README.md');
  const x = re(r, 'WORKTREE'); assert.equal(RF.exitCodeFor(x), 1); assert.ok(x.errors.includes('index_flags_hidden'));
});
test('reassess: filenames with newlines and spaces survive git -z; a changed declaration, bad head and flag-looking head fail closed', () => {
  const r = repo({ 'README.md': 'x' });
  mkdirSync(join(r.dir, 'apps/api/src/billing'), { recursive: true }); writeFileSync(join(r.dir, 'apps/api/src/billing/new\nline name.ts'), 'x'); let h = commit(r.dir);
  assert.deepEqual(re(r, h).floor_classes, ['money']);
  writeFileSync(join(r.dir, '.ship-ticket/risk-paths.json'), JSON.stringify({ version: 1, classes: [{ name: 'x', floor: 'ELEVATED', globs: ['nothing/**'] }] })); h = commit(r.dir);
  const x = re(r, h); assert.ok(x.errors.includes('declaration_tampered')); assert.equal(x.final, 'ELEVATED'); assert.equal(RF.exitCodeFor(x), 1);
  for (const head of ['--output=x', 'no-such-ref', '', undefined]) assert.equal(RF.exitCodeFor(re(r, head)), 1, String(head));
  const dead = repo({ 'README.md': 'x' }, null); writeFileSync(join(dead.dir, 'db.sql'), 'x'); const hd = commit(dead.dir);
  assert.deepEqual(re(dead, hd).reasons, ['no_risk_paths_declared']);
});

// ---- CLI ----
test('CLI: exit 0 / 2 / 1, both flag forms, strict parsing', () => {
  const r = repo(), common = ['--base', r.base, '--repo', r.dir, '--claimed', 'STANDARD', '--ai', 'STANDARD'];
  assert.equal(cli(['check', '--planned-paths', '["README.md"]', ...common]).status, 0);
  const hi = cli(['check', '--planned-paths', '["db/migrations/1.sql"]', ...common]); assert.equal(hi.status, 2); assert.equal(out(hi).final, 'ELEVATED');
  assert.equal(cli(['check', `--base=${r.base}`, `--repo=${r.dir}`, '--claimed=elevated', '--ai=standard', '--planned-paths=["db/migrations/1.sql"]']).status, 0);
  const f = join(mkdtempSync(join(tmpdir(), 'rfp-')), 'p.json'); writeFileSync(f, '["README.md"]');
  assert.equal(cli(['check', '--planned-paths', f, ...common]).status, 0);
  writeFileSync(join(r.dir, 'x.txt'), 'x'); assert.equal(cli(['reassess', '--head', 'WORKTREE', ...common]).status, 0);
  const bads = [[], ['check'], ['verify'], ['check', ...common], ['check', '--planned-paths', '["a"]', ...common, '--ai', 'STANDARD'], ['check', '--planned-paths', '["a"]', ...common, 'extra'], ['check', '--planned-paths', '["a"]', ...common, '--nope', 'x'],
    ['check', '--planned-paths', ...common], ['check', '--planned-paths', '--base', r.base], ['reassess', '--planned-paths', '["a"]', ...common]];
  for (const a of bads) { const x = cli(a); assert.equal(x.status, 1, a.join(' ')); assert.equal(out(x).final, 'ELEVATED'); }
  for (const p of ['{"a":1}', '"x"', 'null', '[1]', '[""]', '[bad', '[]', '["../x"]', '["a\\u0000b"]', '["a\\ud800"]', '/nonexistent/file.json']) assert.equal(cli(['check', '--planned-paths', p, ...common]).status, 1, p);
  for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('["a"]', 'utf16le')]), Buffer.from('["a\0b"]'), Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]), Buffer.alloc(RF.MAX_INPUT + 1, 97)]) {
    const g = join(mkdtempSync(join(tmpdir(), 'rfp-')), 'p.json'); writeFileSync(g, bytes); assert.equal(cli(['check', '--planned-paths', g, ...common]).status, 1);
  }
  for (const c of ['garbage', '']) assert.equal(cli(['check', '--planned-paths', '["README.md"]', '--base', r.base, '--repo', r.dir, '--claimed', c, '--ai', 'STANDARD']).status, 1);
});

// ---- docs ----
test('docs: debate rule is ELEVATED-floor-or-AI consistent in SKILL.md and every reference; honesty wording; no keyword floor left', () => {
  const root = new URL('../', import.meta.url);
  const files = ['SKILL.md', ...readdirSync(new URL('references/', root)).map((f) => `references/${f}`)];
  for (const f of files) {
    const t = readFileSync(new URL(f, root), 'utf8');
    assert.doesNotMatch(t, /debate runs only for money or auth|cross-model plan debate\s+only for money or auth|Skip it, and record the skip, for UI|only a ticket below the floor may record|only below the floor\./i, f);
    assert.doesNotMatch(t, /risk-floor\.mjs verify|verify --plan|best-effort lexical|--ticket <file/, f);
  }
  const ref = (f) => readFileSync(new URL(f, root), 'utf8');
  assert.match(ref('references/cross-model.md'), /both STANDARD/);
  assert.match(ref('SKILL.md'), /risk floor is ELEVATED/i);
  assert.match(ref('SKILL.md'), /your own assessment is also STANDARD/);
  for (const f of ['SKILL.md', 'references/plan.md']) { assert.match(ref(f), /not evidence of low risk/); assert.match(ref(f), /advisory, not enforced/i); }
  assert.match(ref('SKILL.md'), /no_risk_paths_declared/);
  assert.doesNotMatch(ref('SKILL.md') + ref('scripts/risk-floor.mjs'), /never under-classify|is final: it forces/);
  assert.doesNotMatch(ref('scripts/risk-floor.mjs'), /KEYWORDS|CLASSES|squash/);
  const ex = JSON.parse(ref('references/risk-paths.example.json')); assert.doesNotThrow(() => RF.validateDeclaration(ex));
});
