// S6 (F07, F11; Option B): check-pr-scope.mjs classifies every candidate path as planned, supporting or material
// against the ONE digest-bound `scope-contract:` line of the approved plan (no Markdown is parsed), and the F11 3b row.
// Fixtures are temp git repos under os.tmpdir() with an approved START.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, lstatSync, unlinkSync, realpathSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { planNarrativeDigest, under, validateEngineDag, sha } from './engine-dag.mjs';
import { designContract } from './engine-gates.mjs';
import * as S from './check-pr-scope.mjs';
import { WORKER_FAILURE_BOUND_MS } from './test-wait.test-helper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-pr-scope.mjs');
const CANDIDATE = join(HERE, 'candidate-id.mjs');
const B = '<!-- RUN-STATE:BEGIN -->', E = '<!-- RUN-STATE:END -->';
const TICKET = 'T-1', RUN = 'r1';
const PLAN_REL = `.specs/plans/${TICKET}.md`;
// Windows runners check markdown out as CRLF; the wording pins below match LF text.
const load = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ref = (name) => load(join(HERE, '..', 'references', name));
const flat = (s) => s.replace(/\s+/g, ' ');
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), BOM = String.fromCharCode(0xfeff), NUL = String.fromCharCode(0);
const CYR_E = String.fromCharCode(0x0435), CYR_O = String.fromCharCode(0x043e);

// ------------------------------------------------------------------ fixtures

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A temp repo: `base` files committed on main, then branch `work`. */
function repo(t, baseFiles = { 'README.md': 'base\n' }) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 's6-scope-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'builder@example.invalid']);
  git(dir, ['config', 'user.name', 'builder']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  const write = (rel, text = `${rel}\n`) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  for (const [rel, text] of Object.entries(baseFiles)) write(rel, text);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  git(dir, ['checkout', '-q', '-b', 'work']);
  return { dir, write, git: (args) => git(dir, args), rm: (rel) => rmSync(join(dir, rel), { recursive: true, force: true }) };
}

/** The canonical contract line (fixed key order v, mode, dag, planned, supporting). */
const bodyOf = ({ mode = 'manual', dag = null, planned, supporting = [] }) => JSON.stringify({ v: 1, mode, dag, planned, supporting });
/** The fenced block (opener, canonical body, closer), a blank line and the required `contract body:` line. */
const block = (body) => `\`\`\`scope-contract\n${body}\n\`\`\`\n\ncontract body: ${sha(body)}`;
const contract = (c) => block(bodyOf(c));
/** The explanatory table a real plan keeps; no script reads it. */
const TABLE = '| ID | Owner | Step (plain words) | Files touched | Depends on | Exclusive resources |\n|---|---|---|---|---|---|\n| web | worker | Build checkout | `src/checkout/page.tsx` | — | none |';

/** Plan text: narrative + RUN-STATE with an approved START over exactly that narrative (plus `events` after it). */
function planText(narrativeBody, { events = [], startOver = {} } = {}) {
  const narrative = `# Plan ${TICKET}\n\n## 2. Execution DAG\n\n${narrativeBody}\n\n`;
  const empty = `${narrative}${B}\n${E}\n`;
  const start = { run_id: RUN, event: 'START', approved_plan_digest: planNarrativeDigest(empty), approved_at: '2026-11-20T10:00:00.000Z', approved_by: 'owner', ...startOver };
  return `${narrative}${B}\n${[start, ...events].map((e) => JSON.stringify(e)).join('\n')}\n${E}\n`;
}
function writePlan(r, body, opts) { r.write(PLAN_REL, planText(body, opts)); return join(r.dir, PLAN_REL); }

const DAG = (writes) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: WORKER_FAILURE_BOUND_MS },
  nodes: writes.map((w, i) => ({ id: `n${i}`, promptFile: '/p', writes: w })) });
/** A DAG file in the git dir; returns { file, raw, digest }. */
function dagFile(r, writes, name = 'run.dag.json') {
  const raw = JSON.stringify(DAG(writes));
  const file = join(r.dir, '.git', name);
  writeFileSync(file, raw);
  return { file, raw, digest: sha(raw) };
}

function run(r, extra = [], { plan = join(r.dir, PLAN_REL), base = 'main' } = {}) {
  const args = [SCRIPT, 'check', '--repo', r.dir, '--ticket', TICKET, '--run-id', RUN, '--base', base, '--plan', plan, ...extra];
  const p = spawnSync(process.execPath, args, { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(p.stdout); } catch { /* refusals print to stderr */ }
  return { status: p.status, stdout: p.stdout, stderr: p.stderr, json };
}
const byPath = (json) => Object.fromEntries(json.files.map((f) => [f.path, f]));
const defaultOut = (r) => join(r.dir, '.git', 'ai-skills', 'ship-ticket', `${TICKET}.scope.json`);

const CHECKOUT = contract({ planned: ['src/checkout/page.tsx', 'src/checkout'], supporting: ['tests'] });
const CHECKOUT_PLAN = `${TABLE}\n\n${CHECKOUT}`;

// ------------------------------------------------------------------ class rules

test('planned exact, planned directory, supporting (independent of planned) and material (the checkout page vs the orders route)', (t) => {
  const r = repo(t);
  writePlan(r, CHECKOUT_PLAN);
  r.write('src/checkout/page.tsx');
  r.write('src/checkout/util.ts');
  r.write('tests/checkout/page.test.tsx');
  r.write('src/api/orders/route.ts');
  const out = run(r);
  assert.equal(out.status, 1, out.stderr + out.stdout);
  const f = byPath(out.json);
  assert.deepEqual(f['src/checkout/page.tsx'], { path: 'src/checkout/page.tsx', kind: 'file', class: 'planned', via: 'exact', flags: [] });
  assert.deepEqual(f['src/checkout/util.ts'], { path: 'src/checkout/util.ts', kind: 'file', class: 'planned', via: 'directory', flags: ['unlisted_under_directory_write'] });
  assert.deepEqual(f['tests/checkout/page.test.tsx'], { path: 'tests/checkout/page.test.tsx', kind: 'file', class: 'supporting', via: 'supporting', flags: [] });
  assert.deepEqual(f['src/api/orders/route.ts'], { path: 'src/api/orders/route.ts', kind: 'file', class: 'material', via: null, flags: [] });
  assert.equal(out.json.schema, S.SCHEMA);
  assert.equal(out.json.outcome, 'MATERIAL');
  assert.equal(out.json.mode, 'manual');
  assert.deepEqual(out.json.roots, ['src/checkout', 'src/checkout/page.tsx']);
  assert.deepEqual(out.json.supporting, ['tests']);
  assert.deepEqual(out.json.counts, { planned: 2, supporting: 1, material: 1, total: 4 });
  assert.equal(out.json.dag_digest, null);
  assert.equal('plan_table_drift' in out.json, false);
  assert.match(out.stderr, /src\/api\/orders\/route\.ts/);
  r.write('session-log.md');
  const again = run(r);
  assert.ok(!again.json.files.some((x) => x.path === PLAN_REL || x.path === 'session-log.md'));
  assert.equal(readFileSync(defaultOut(r), 'utf8'), again.stdout);
});

test('a candidate entirely inside the contract exits 0 CLEAN and records the candidate-id of the same base', (t) => {
  const r = repo(t);
  writePlan(r, CHECKOUT_PLAN);
  r.write('src/checkout/page.tsx');
  r.write('tests/a.test.tsx');
  const out = run(r);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(out.json.outcome, 'CLEAN');
  const cid = spawnSync(process.execPath, [CANDIDATE, '--repo', r.dir, '--base', 'main', '--exclude', PLAN_REL, '--exclude', 'session-log.md'], { encoding: 'utf8' });
  assert.equal(cid.status, 0, cid.stderr);
  const c = JSON.parse(cid.stdout);
  assert.equal(out.json.candidate_id, c.candidate_id);
  assert.equal(out.json.merge_base, c.merge_base);
  assert.deepEqual(out.json.files.map((x) => x.path), c.paths.map((p) => p.path));
  assert.equal(out.json.approved_plan_digest, planNarrativeDigest(readFileSync(join(r.dir, PLAN_REL), 'utf8')));
});

test('a rename into and out of the plan is a deleted source plus an added destination, each classified alone', (t) => {
  const r = repo(t, { 'src/legacy/x.ts': 'x\n', 'src/checkout/y.ts': 'y\n' });
  writePlan(r, CHECKOUT_PLAN);
  r.git(['mv', 'src/legacy/x.ts', 'src/checkout/x.ts']);
  r.git(['mv', 'src/checkout/y.ts', 'src/y.ts']);
  const out = run(r);
  assert.equal(out.status, 1, out.stderr);
  const f = byPath(out.json);
  assert.deepEqual([f['src/legacy/x.ts'].class, f['src/legacy/x.ts'].kind, f['src/legacy/x.ts'].flags], ['material', 'deleted', ['deleted']]);
  assert.equal(f['src/checkout/x.ts'].class, 'planned');
  assert.equal(f['src/checkout/y.ts'].class, 'planned');
  assert.ok(f['src/checkout/y.ts'].flags.includes('deleted'));
  assert.equal(f['src/y.ts'].class, 'material');
});

test('a symlink is never supporting and an outside target is flagged', (t) => {
  const r = repo(t);
  writePlan(r, CHECKOUT_PLAN);
  r.write('outside/secret.txt');
  mkdirSync(join(r.dir, 'tests/checkout'), { recursive: true });
  mkdirSync(join(r.dir, 'src/checkout'), { recursive: true });
  try {
    symlinkSync('../../outside/secret.txt', join(r.dir, 'tests/checkout/link'));
    symlinkSync('page.tsx', join(r.dir, 'src/checkout/inner'));
    symlinkSync('../../outside/secret.txt', join(r.dir, 'src/checkout/out'));
  } catch (e) { t.skip(`no symlinks here: ${e.code}`); return; }
  // Windows without symlink rights may create something else; skip on what lstat sees, not on the platform name.
  if (!lstatSync(join(r.dir, 'tests/checkout/link')).isSymbolicLink()) { t.skip('symlink not created as a link'); return; }
  const f = byPath(run(r).json);
  assert.deepEqual(f['tests/checkout/link'], { path: 'tests/checkout/link', kind: 'symlink', class: 'material', via: null, flags: ['symlink', 'symlink_target_outside_contract'] });
  assert.deepEqual(f['src/checkout/inner'].flags, ['symlink', 'unlisted_under_directory_write']);
  assert.deepEqual(f['src/checkout/out'].flags, ['symlink', 'symlink_target_outside_contract', 'unlisted_under_directory_write']);
  assert.equal(f['outside/secret.txt'].class, 'material');
});

test('a case alias of a planned entry stays material and is flagged', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/Checkout'] }));
  r.write('src/checkout/page.tsx');
  const out = run(r);
  assert.equal(out.status, 1, out.stderr);
  assert.deepEqual(byPath(out.json)['src/checkout/page.tsx'], { path: 'src/checkout/page.tsx', kind: 'file', class: 'material', via: null, flags: ['case_alias'] });
});

test('untracked files are in the path set; gitignored files are invisible, and a .gitignore edit is itself a changed path', (t) => {
  const r = repo(t, { '.gitignore': '*.log\n' });
  writePlan(r, CHECKOUT_PLAN);
  r.write('src/checkout/page.tsx');
  r.write('src/api/debug.log');
  const clean = run(r);
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  assert.ok(!clean.json.files.some((x) => x.path === 'src/api/debug.log'));
  r.write('.gitignore', '*.log\nsrc/api/\n');
  r.write('src/api/hidden.ts');
  const out = run(r);
  assert.equal(out.status, 1);
  assert.equal(byPath(out.json)['.gitignore'].class, 'material');
  assert.ok(!out.json.files.some((x) => x.path === 'src/api/hidden.ts'));
  r.write('src/new/untracked.ts');
  assert.equal(byPath(run(r).json)['src/new/untracked.ts'].class, 'material');
});

test('a deleted file outside the plan is material and flagged deleted; a deleted test is not supporting', (t) => {
  const r = repo(t, { 'docs/old.md': 'old\n', 'tests/old.test.ts': 'x\n' });
  writePlan(r, CHECKOUT_PLAN);
  r.rm('docs/old.md');
  r.rm('tests/old.test.ts');
  const f = byPath(run(r).json);
  assert.deepEqual(f['docs/old.md'], { path: 'docs/old.md', kind: 'deleted', class: 'material', via: null, flags: ['deleted'] });
  assert.equal(f['tests/old.test.ts'].class, 'material');
});

test('supporting is per file: a manifest under tests and an executable under docs are material', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/checkout'], supporting: ['tests', 'docs'] }));
  r.write('package-lock.json', '{}\n');
  r.write('tests/fixtures/app/package-lock.json', '{}\n');
  r.write('tests/fixtures/app/data.json', '{}\n');
  r.write('docs/guide.md');
  r.write('docs/tool.mjs');
  r.write('src/api/route.ts');
  const f = byPath(run(r).json);
  assert.deepEqual(f['package-lock.json'], { path: 'package-lock.json', kind: 'file', class: 'material', via: null, flags: ['dependency_manifest'] });
  assert.deepEqual(f['tests/fixtures/app/package-lock.json'], { path: 'tests/fixtures/app/package-lock.json', kind: 'file', class: 'material', via: null, flags: ['dependency_manifest'] });
  assert.equal(f['tests/fixtures/app/data.json'].class, 'supporting');
  assert.equal(f['docs/guide.md'].class, 'supporting');
  assert.deepEqual(f['docs/tool.mjs'], { path: 'docs/tool.mjs', kind: 'file', class: 'material', via: null, flags: ['docs_not_allowlisted'] });
  assert.equal(f['src/api/route.ts'].class, 'material');
});

test('supporting laundering: docs is a closed allowlist; exec mode or a shebang is material under any supporting entry', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/checkout'], supporting: ['tests', 'docs'] }));
  for (const p of ['docs/build.mts', 'docs/x.ps1', 'docs/x.html', 'docs/widget.vue', 'docs/config.json', 'docs/c.yaml', 'docs/run']) r.write(p);
  r.write('docs/deploy', '#!/bin/sh\necho hi\n');
  r.write('docs/guide.md'); r.write('docs/img.png'); r.write('docs/data.csv');
  r.write('tests/helper.ts'); r.write('tests/run.sh', 'echo\n'); r.write('tests/tool.py', '#!/usr/bin/env python3\nprint(1)\n');
  chmodSync(join(r.dir, 'tests/run.sh'), 0o755);
  const f = byPath(run(r).json);
  for (const p of ['docs/build.mts', 'docs/x.ps1', 'docs/x.html', 'docs/widget.vue', 'docs/config.json', 'docs/c.yaml', 'docs/run', 'docs/deploy']) {
    assert.equal(f[p].class, 'material', p);
    assert.ok(f[p].flags.includes('docs_not_allowlisted'), p);
  }
  assert.ok(f['docs/deploy'].flags.includes('shebang'));
  for (const p of ['docs/guide.md', 'docs/img.png', 'docs/data.csv', 'tests/helper.ts']) assert.equal(f[p].class, 'supporting', p);
  assert.deepEqual([f['tests/tool.py'].class, f['tests/tool.py'].flags], ['material', ['shebang']]);
  if (statSync(join(r.dir, 'tests/run.sh')).mode & 0o111) assert.deepEqual([f['tests/run.sh'].class, f['tests/run.sh'].flags], ['material', ['executable_mode']]);
});

test('the classifier: planned before supporting; a line terminator fails closed to material', () => {
  const files = S.classify([
    { path: 'a/b', kind: 'file' }, { path: 'tests/x', kind: 'file' }, { path: 'a/c', kind: 'submodule' },
    { path: 'a/n\nx', kind: 'file' }, { path: 'z', kind: 'file' }, { path: 'tests/l', kind: 'symlink' },
  ], { mode: 'manual', planned: ['a', 'a/b'], supporting: ['tests'], readlink: () => 'x' });
  assert.deepEqual(files.map((f) => [f.class, f.via]), [['planned', 'exact'], ['supporting', 'supporting'], ['planned', 'directory'],
    ['material', null], ['material', null], ['material', null]]);
  assert.deepEqual(files[0].flags, []);
  assert.deepEqual(files[2].flags, ['submodule', 'unlisted_under_directory_write', 'broad_planned']);
  assert.deepEqual(files[3].flags, ['line_terminator']);
});

// ------------------------------------------------------------------ engine mode

test('engine mode: planned equals the DAG writes, glob writes are classified as the engine matches them, broad entries are flagged', (t) => {
  const r = repo(t);
  const d = dagFile(r, [['apps/web', 'apps/api/src/**/*.ts'], ['src']]);
  writePlan(r, contract({ mode: 'engine', dag: d.digest, planned: ['apps/api/src/**/*.ts', 'apps/web', 'src'], supporting: ['tests'] }));
  r.write('apps/web/a.ts');
  r.write('apps/api/src/x/y.ts');
  r.write('apps/api/src/y.ts');
  r.write('apps/api/src/x/y.js');
  r.write('src/b.ts');
  r.write('tests/a.test.ts');
  const out = run(r, ['--dag', d.file]);
  assert.equal(out.status, 1, out.stderr + out.stdout);
  const f = byPath(out.json);
  assert.deepEqual(f['apps/api/src/x/y.ts'], { path: 'apps/api/src/x/y.ts', kind: 'file', class: 'planned', via: 'glob', flags: [] }); // listed by the glob itself
  assert.equal(f['apps/api/src/y.ts'].class, 'planned');
  assert.deepEqual(f['apps/api/src/x/y.js'], { path: 'apps/api/src/x/y.js', kind: 'file', class: 'material', via: null, flags: [] });
  assert.equal(f['apps/web/a.ts'].via, 'directory');
  assert.deepEqual(f['src/b.ts'].flags, ['unlisted_under_directory_write', 'broad_planned']);
  assert.equal(f['tests/a.test.ts'].class, 'supporting');
  assert.equal(out.json.mode, 'engine');
  assert.equal(out.json.dag_digest, d.digest);
  assert.deepEqual(out.json.broad_planned, ['src']);
});

test('engine mode: a DAG with no writes and an empty planned list makes every path material', (t) => {
  const r = repo(t);
  const d = dagFile(r, [[]]);
  writePlan(r, contract({ mode: 'engine', dag: d.digest, planned: [] }));
  r.write('src/a.ts');
  const out = run(r, ['--dag', d.file]);
  assert.equal(out.status, 1, out.stderr);
  assert.deepEqual(out.json.roots, []);
  assert.equal(byPath(out.json)['src/a.ts'].class, 'material');
});

test('engine binding: dag sha, exactly one matching DAG_BOUND when any exist, planned == writes, a valid DAG', (t) => {
  const r = repo(t);
  const d = dagFile(r, [['src/checkout']]);
  const body = contract({ mode: 'engine', dag: d.digest, planned: ['src/checkout'] });
  writePlan(r, body);
  r.write('src/checkout/page.tsx');
  assert.equal(run(r, ['--dag', d.file]).status, 0, 'no DAG_BOUND: the contract digest binds');
  writePlan(r, body, { events: [{ event: 'DAG_BOUND', run_id: RUN, dag_digest: d.digest }] });
  assert.equal(run(r, ['--dag', d.file]).status, 0);
  writePlan(r, body, { events: [{ event: 'DAG_BOUND', run_id: RUN, dag_digest: d.digest }, { event: 'DAG_BOUND', run_id: RUN, dag_digest: d.digest }] });
  assert.match(run(r, ['--dag', d.file]).stderr, /dag_unbound/, 'two DAG_BOUND events are not exactly one');
  writePlan(r, body, { events: [{ event: 'DAG_BOUND', run_id: RUN, dag_digest: sha('other') }] });
  assert.match(run(r, ['--dag', d.file]).stderr, /dag_unbound/, 'a DAG_BOUND naming another DAG');
  writePlan(r, body);
  const other = dagFile(r, [['src/checkout', 'src/api']], 'other.dag.json');
  rmSync(defaultOut(r), { force: true }); // the passing runs above wrote one; a refusal must not
  const unbound = run(r, ['--dag', other.file]);
  assert.equal(unbound.status, 2);
  assert.match(unbound.stderr, /dag_unbound/, 'a DAG whose sha differs from the contract');
  assert.equal(existsSync(defaultOut(r)), false);
  writePlan(r, contract({ mode: 'engine', dag: other.digest, planned: ['src/checkout'] }));
  assert.match(run(r, ['--dag', other.file]).stderr, /contract_dag_mismatch/);
  writeFileSync(other.file, JSON.stringify({ schema: 'nope' }));
  writePlan(r, contract({ mode: 'engine', dag: sha(JSON.stringify({ schema: 'nope' })), planned: ['src/checkout'] }));
  assert.match(run(r, ['--dag', other.file]).stderr, /dag_invalid/);
});

// ------------------------------------------------------------------ mode binding (no downgrade by absence of evidence)

test('mode downgrade: engine needs --dag even with no state; editing to manual is an approval mismatch; manual with engine evidence is refused', (t) => {
  const r = repo(t);
  const d = dagFile(r, [['src/a.ts']]);
  const engine = contract({ mode: 'engine', dag: d.digest, planned: ['src/a.ts'] });
  const plan = writePlan(r, engine);
  r.write('src/a.ts');
  r.write('src/b.ts');
  const noDag = run(r);
  assert.equal(noDag.status, 2);
  assert.match(noDag.stderr, /dag_required/, 'a failed engine init leaves no state, and the run is still engine');
  writeFileSync(plan, readFileSync(plan, 'utf8').replace(engine, contract({ planned: ['src'] })));
  assert.match(run(r).stderr, /approval_mismatch/);
  const manual = contract({ planned: ['src'] });
  writePlan(r, manual, { events: [{ event: 'DAG_BOUND', run_id: RUN, dag_digest: d.digest }] });
  assert.match(run(r).stderr, /manual_with_engine_evidence/);
  writePlan(r, manual);
  assert.equal(run(r).status, 0, 'manual, no engine evidence');
  assert.match(run(r, ['--dag', d.file]).stderr, /contract_mode_mismatch/);
  const base = join(r.dir, '.git', 'ai-skills', 'ship-ticket');
  mkdirSync(base, { recursive: true });
  for (const name of [`${TICKET}.state.json`, `${TICKET}.engine.jsonl`]) {
    writeFileSync(join(base, name), '{}\n');
    const out = run(r);
    assert.equal(out.status, 2, name);
    assert.match(out.stderr, /manual_with_engine_evidence/, name);
    unlinkSync(join(base, name));
  }
});

// ------------------------------------------------------------------ the three Codex findings (46f49b3) as regressions

test('Codex 1: a table cell hiding a comment inside backticks is ignored; the contract decides and src/evil.mjs is material', (t) => {
  const r = repo(t);
  const table = TABLE.replace('`src/checkout/page.tsx`', '`src<!-- -->/`');
  writePlan(r, `${table}\n\n${contract({ planned: ['src/checkout/page.tsx'] })}`);
  r.write('src/checkout/page.tsx');
  r.write('src/evil.mjs');
  const out = run(r);
  assert.equal(out.status, 1, out.stderr + out.stdout);
  assert.equal(byPath(out.json)['src/evil.mjs'].class, 'material');
});

test('Codex 3: a DAG digest on lines of its own is irrelevant to binding; the contract mode decides', (t) => {
  const r = repo(t);
  const d = dagFile(r, [['src/a.ts']]);
  writePlan(r, `DAG digest:\n${d.digest}\n\n${contract({ planned: ['src/a.ts'] })}`);
  r.write('src/a.ts');
  assert.equal(run(r).status, 0, 'manual contract, no engine evidence: the digest text binds nothing');
  assert.match(run(r, ['--dag', d.file]).stderr, /contract_mode_mismatch/);
  writePlan(r, `DAG digest:\n${d.digest}\n\n${contract({ mode: 'engine', dag: d.digest, planned: ['src/a.ts'] })}`);
  assert.match(run(r).stderr, /dag_required/);
  const other = dagFile(r, [['src/a.ts', 'src/b.ts']], 'other.dag.json');
  assert.match(run(r, ['--dag', other.file]).stderr, /dag_unbound/);
});

// ------------------------------------------------------------------ declaration refusals (exit 2, never a record)

test('overlap with an engine glob: a supporting entry matched by a planned glob or under its literal prefix is refused', () => {
  const eng = (planned, supporting) => () => S.validateContract({ v: 1, mode: 'engine', dag: sha('d'), planned, supporting });
  const overlaps = (e) => e.code === 'supporting_overlaps_planned';
  assert.throws(eng(['a*/x'], ['ab/x/tests']), overlaps, 'matched by the planned glob');
  assert.throws(eng(['apps/**/x.ts'], ['apps/tests']), overlaps, 'under the literal prefix of the planned glob');
  assert.throws(eng(['apps/web'], ['apps/web/tests']), overlaps, 'literal');
  assert.doesNotThrow(eng(['apps/api/src/**/*.ts', 'apps/web'], ['tests', 'docs']));
  // review repair corpus: segment-wise unification (Codex M3 first)
  for (const [planned, supporting] of [['a*/tests/x.ts', 'ab/tests'], ['**/x.ts', 'tests'], ['src/*/tests', 'src/a/tests'], ['apps/**', 'apps/web/tests'],
    ['**', 'docs'], ['?b/tests', 'ab/tests'], ['a*', 'ab/tests'], ['src/**/x', 'src/a/b/tests'], ['*/*/q.ts', 'a/tests']]) {
    assert.throws(eng([planned], [supporting]), overlaps, `${planned} vs ${supporting}`);
  }
  for (const [planned, supporting] of [['src/*.ts', 'tests'], ['apps/**/x.ts', 'tests'], ['a*/x', 'b/tests'], ['src/?/q', 'src/ab/tests'], ['x/**/y', 'z/tests']]) {
    assert.doesNotThrow(eng([planned], [supporting]), `${planned} vs ${supporting}`);
  }
});

test('property: glob disjointness agrees with brute-force enumeration over a small path alphabet', () => {
  const real = engineGlobRe();
  const rand = rng(99);
  const SEG = ['a', 'b', 'ab', 'tests', 'x.ts'];
  const PSEG = [...SEG, '*', 'a*', '?b', '**', '*.ts'];
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const ext = (n) => n === 0 ? [[]] : ext(n - 1).flatMap((e) => [[], ...SEG.map((x) => [...e, x])]);
  const EXT = [...new Set(ext(3).map((e) => e.join('/')))].map((e) => (e ? e.split('/') : []));
  let both = 0, neither = 0;
  for (let i = 0; i < 1500; i++) {
    const p = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(PSEG)).join('/');
    const s = [...Array.from({ length: Math.floor(rand() * 2) }, () => pick(SEG)), 'tests'].join('/');
    const match = (q) => real(p).test(q) || real(`${p}/**`).test(q);
    const brute = EXT.some((e) => match([s, ...e].join('/')));
    const unified = S.globOverlaps(p, s);
    assert.equal(unified, brute, `${p} vs ${s}`);
    if (brute) both++; else neither++;
  }
  assert.ok(both > 200 && neither > 200, `overlapping ${both}, disjoint ${neither}`);
});

test('engine breadth is advisory: a wildcard-only first segment is accepted and flagged; engine caps are wider than manual', (t) => {
  const r = repo(t);
  const d = dagFile(r, [['**/x.test.ts']]);
  writePlan(r, contract({ mode: 'engine', dag: d.digest, planned: ['**/x.test.ts'] }));
  r.write('src/a/x.test.ts');
  const out = run(r, ['--dag', d.file]);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.deepEqual(byPath(out.json)['src/a/x.test.ts'].flags, ['broad_planned']);
  assert.deepEqual(out.json.broad_planned, ['**/x.test.ts']);
  const v = (mode, planned) => () => S.validateContract({ v: 1, mode, dag: mode === 'engine' ? sha('d') : null, planned, supporting: [] });
  const many = (n) => Array.from({ length: n }, (_, i) => `src/p${i}`);
  assert.doesNotThrow(v('engine', many(256)));
  assert.throws(v('engine', many(257)), (e) => e.code === 'scope_contract_invalid');
  assert.throws(v('manual', many(65)), (e) => e.code === 'scope_contract_invalid');
  assert.doesNotThrow(v('engine', [`src/${'a'.repeat(500)}`]));
  assert.throws(v('engine', [`src/${'a'.repeat(510)}`]), (e) => e.code === 'scope_contract_invalid');
  assert.throws(v('manual', [`src/${'a'.repeat(300)}`]), (e) => e.code === 'scope_contract_invalid');
  assert.doesNotThrow(() => S.parseContract(planText(contract({ mode: 'engine', dag: sha('d'), planned: many(256).map((p) => `${p}/${'q'.repeat(40)}`) }))), 'a 64 KiB engine line');
});

test('manual mode matches brackets and braces literally; * and ? stay refused', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['app/[id]/page.tsx', 'app/{x}'] }));
  r.write('app/[id]/page.tsx');
  r.write('app/{x}/a.ts');
  r.write('app/i/page.tsx');
  const f = byPath(run(r).json);
  assert.equal(f['app/[id]/page.tsx'].via, 'exact');
  assert.equal(f['app/{x}/a.ts'].class, 'planned');
  assert.equal(f['app/i/page.tsx'].class, 'material');
  for (const g of ['src/*.ts', 'src/a?.ts']) assert.throws(() => S.validateContract({ v: 1, mode: 'manual', dag: null, planned: [g], supporting: [] }), (e) => e.code === 'scope_contract_invalid', g);
});

test('entry charset: backtick, pipe, quote and non-ASCII are refused in both modes; engine glob characters stay allowed', () => {
  for (const mode of ['manual', 'engine']) {
    for (const bad of ['src/a`b', 'src/a|b', 'src/a"b', 'src/café.ts', 'src/a b']) {
      assert.throws(() => S.validateContract({ v: 1, mode, dag: mode === 'engine' ? sha('d') : null, planned: [bad], supporting: [] }), (e) => e.code === 'scope_contract_invalid', `${mode} ${bad}`);
    }
  }
  assert.doesNotThrow(() => S.validateContract({ v: 1, mode: 'engine', dag: sha('d'), planned: ['apps/**/[id]/{a}/*.ts', 'x?y'], supporting: [] }));
});

test('case-insensitive manifests and case-consistent supporting entries', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/checkout'], supporting: ['tests'] }));
  r.write('tests/PACKAGE.JSON', '{}\n'); r.write('tests/My.CSPROJ', '<x/>\n'); r.write('tests/Requirements-dev.TXT', 'x\n');
  r.write('Tests/a.ts');
  const f = byPath(run(r).json);
  for (const p of ['tests/PACKAGE.JSON', 'tests/My.CSPROJ', 'tests/Requirements-dev.TXT']) assert.deepEqual([f[p].class, f[p].flags], ['material', ['dependency_manifest']], p);
  // On a case-insensitive file system Tests/ may alias tests/; git reports the stored case, and literal matching keeps it material.
  if (f['Tests/a.ts']) assert.equal(f['Tests/a.ts'].class, 'material');
  const v = (supporting, planned = ['src/a.ts']) => () => S.validateContract({ v: 1, mode: 'manual', dag: null, planned, supporting });
  for (const bad of ['Tests', 'DOCS', '.GITHUB/tests', 'Node_Modules/x/tests']) assert.throws(v([bad]), (e) => e.code === 'scope_contract_invalid', bad);
  assert.throws(v(['src/checkout/tests'], ['src/Checkout']), (e) => e.code === 'supporting_overlaps_planned', 'overlap compares case-insensitively');
});

test('git index mode alone: core.filemode=true, file system 0644, index 100755 is material', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/a.ts'], supporting: ['tests'] }));
  r.write('src/a.ts');
  r.write('tests/run.sh', 'echo\n');
  r.git(['add', 'tests/run.sh']);
  r.git(['update-index', '--chmod=+x', 'tests/run.sh']);
  const f = byPath(run(r).json);
  assert.deepEqual([f['tests/run.sh'].class, f['tests/run.sh'].flags], ['material', ['executable_mode']]);
});

test('git index and diff modes: an executable staged with core.filemode=false is material (candidate-id sees 0644)', (t) => {
  const r = repo(t);
  r.git(['config', 'core.filemode', 'false']);
  writePlan(r, contract({ planned: ['src/a.ts'], supporting: ['tests'] }));
  r.write('src/a.ts');
  r.write('tests/run.sh', 'echo\n');
  r.write('tests/plain.txt', 'x\n');
  r.git(['add', 'tests/run.sh', 'tests/plain.txt']);
  r.git(['update-index', '--chmod=+x', 'tests/run.sh']);
  const staged = byPath(run(r).json);
  assert.deepEqual([staged['tests/run.sh'].class, staged['tests/run.sh'].flags], ['material', ['executable_mode']]);
  assert.equal(staged['tests/plain.txt'].class, 'supporting');
  r.git(['commit', '-q', '-m', 'x']);
  const committed = byPath(run(r).json);
  assert.deepEqual([committed['tests/run.sh'].class, committed['tests/run.sh'].flags], ['material', ['executable_mode']]);
});

// ------------------------------------------------------------------ inputs and git failures

test('input refusals: --base starting with -, unsafe ticket, unknown flag, --out inside the work tree', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/a.ts'] }));
  r.write('src/a.ts');
  const dash = run(r, [], { base: '-x' });
  assert.equal(dash.status, 2);
  assert.match(dash.stderr, /refused ref/);
  const p = spawnSync(process.execPath, [SCRIPT, 'check', '--repo', r.dir, '--ticket', '../x', '--run-id', RUN, '--base', 'main', '--plan', join(r.dir, PLAN_REL)], { encoding: 'utf8' });
  assert.equal(p.status, 2);
  for (const flag of ['--exclude', '--envelope', '--planned', '--mode']) assert.equal(run(r, [flag, 'src']).status, 2, `there is no ${flag} flag on check`);
  const inside = run(r, ['--out', join(r.dir, 'scope.json')]);
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /out_in_work_tree/);
  assert.equal(existsSync(join(r.dir, 'scope.json')), false);
  const outside = join(dirname(r.dir), `s6-out-${process.pid}.json`);
  t.after(() => rmSync(outside, { force: true }));
  assert.equal(run(r, ['--out', outside]).status, 0);
  assert.equal(JSON.parse(readFileSync(outside, 'utf8')).outcome, 'CLEAN');
});

test('an approval mismatch or a START of another run exits 2 with no record', (t) => {
  const r = repo(t);
  const plan = writePlan(r, contract({ planned: ['src/a.ts'] }));
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('"src/a.ts"', '"src"'));
  r.write('src/a.ts');
  const out = run(r);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /approval_mismatch/);
  assert.equal(existsSync(defaultOut(r)), false);
  writePlan(r, contract({ planned: ['src/a.ts'] }), { startOver: { run_id: 'other' } });
  assert.match(run(r).stderr, /approval_mismatch/);
});

test('git or candidate-id failure exits 3: an unknown base and a dirty submodule', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/a.ts', 'vendor/sub'] }));
  assert.equal(run(r, [], { base: 'no-such-ref' }).status, 3);
  const sub = repo(t);
  sub.write('lib.txt');
  sub.git(['add', '-A']); sub.git(['commit', '-q', '-m', 'sub']);
  r.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'vendor/sub']);
  writeFileSync(join(r.dir, 'vendor/sub/dirty.txt'), 'dirty\n');
  const out = run(r);
  assert.equal(out.status, 3, out.stderr);
  assert.match(out.stderr, /candidate-id/);
  assert.equal(existsSync(defaultOut(r)), false);
});

test('a path strictly under an exclusion FILE entry is material (under_exclusion_file), outside the candidate-id set', (t) => {
  const r = repo(t);
  const plan = join(r.dir, '.git', 'plan-elsewhere.md');
  writeFileSync(plan, planText(contract({ planned: ['src/a.ts'] })));
  r.write('src/a.ts');
  r.write('session-log.md/evil.mjs');
  r.write(`${PLAN_REL}/x.mjs`);
  const out = run(r, [], { plan });
  assert.equal(out.status, 1, out.stdout + out.stderr);
  const f = byPath(out.json);
  assert.deepEqual(f['session-log.md/evil.mjs'], { path: 'session-log.md/evil.mjs', kind: 'file', class: 'material', via: null, flags: ['under_exclusion_file'] });
  assert.deepEqual(f[`${PLAN_REL}/x.mjs`].flags, ['under_exclusion_file']);
  r.git(['add', '-A']); r.git(['commit', '-q', '-m', 'hide']);
  assert.equal(run(r, [], { plan }).status, 1);
  const ok = repo(t);
  writePlan(ok, contract({ planned: ['src/a.ts'] }));
  ok.write('src/a.ts'); ok.write('session-log.md');
  assert.equal(run(ok).status, 0);
});

// ------------------------------------------------------------------ engine matcher parity and the no-downgrade proof

/** security-plan.mjs globRe and normPath, extracted from the real file (not copied), so the proof runs against the engine's matcher. */
function engineGlobRe() {
  const src = load(join(HERE, 'security-plan.mjs')); // LF-normalized: a CRLF checkout must not defeat the extraction
  const norm = /^const normPath = .*;$/m.exec(src)?.[0];
  const start = src.indexOf('function globRe(glob) {');
  const end = src.indexOf('\n}\n', start);
  assert.ok(norm && start > 0 && end > start, 'extracted normPath and globRe from security-plan.mjs');
  return new Function(`${norm}\n${src.slice(start, end + 2)}\nreturn globRe;`)();
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const ALPHA = ['a', 'b', 'A', '.', '*', '**', '?', '[', ']', '(', '+', '$', '\\', '-', ' ', '\n', '\r', LS, PS, 'é'];

test('local matcher parity: globRe equals the security-plan.mjs globRe on a corpus with *, **, **/, ?, dots, plus and brackets', () => {
  const real = engineGlobRe();
  const rand = rng(7);
  const seg = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ALPHA[Math.floor(rand() * ALPHA.length)]).join('');
  const rel = () => Array.from({ length: 1 + Math.floor(rand() * 4) }, seg).join('/');
  const globs = ['apps/api/src/**/*.ts', '**/x', 'a/**', 'a?b', 'v1.2+x/[a]', '**', 'a/**/b/*.mjs', './src/a', 'src/'];
  for (let i = 0; i < 400; i++) globs.push(rel());
  let n = 0;
  for (const g of globs) {
    const mine = S.globRe(g), theirs = real(g);
    assert.equal(mine.source, theirs.source, g);
    for (let j = 0; j < 10; j++) { const p = rand() < 0.5 ? rel() : `${g.replace(/\*+/g, 'q')}/${rel()}`; assert.equal(mine.test(p), theirs.test(p), `${g} ~ ${p}`); n++; }
  }
  assert.ok(n >= 4000, `compared ${n}`);
});

test('property: a planned path always matches the engine Design Contract (designContract + security-plan globRe), engine mode with globs', () => {
  const globRe = engineGlobRe();
  const rand = rng(20261122);
  const seg = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ALPHA[Math.floor(rand() * ALPHA.length)]).join('');
  const rel = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, seg).join('/');
  let checked = 0, planned = 0;
  for (let i = 0; i < 4000; i++) {
    const writes = [...new Set(Array.from({ length: Math.floor(rand() * 4) }, rel).filter((w) => S.normalRel(w)))].sort();
    const contractRes = designContract([{ writes }]).map(globRe);
    for (let j = 0; j < 6; j++) {
      const pick = writes.length && rand() < 0.7 ? writes[Math.floor(rand() * writes.length)].replace(/\*+/g, () => seg().replace(/[*/]/g, 'x')) : rel();
      const path = rand() < 0.5 ? pick : `${pick}/${rel()}`;
      const kind = ['file', 'symlink', 'deleted', 'submodule'][Math.floor(rand() * 4)];
      const [f] = S.classify([{ path, kind }], { mode: 'engine', planned: writes, supporting: [], readlink: () => '../x' });
      checked++;
      if (f.class !== 'planned') continue;
      planned++;
      assert.ok(contractRes.some((re) => re.test(path)), `planned ${JSON.stringify(path)} outside the engine contract of ${JSON.stringify(writes)}`);
    }
  }
  assert.ok(checked === 24000 && planned > 2500, `checked ${checked}, planned ${planned}`);
});

test('raw under() alone does not imply the engine contract for a path with a line terminator (why the classifier fails closed)', () => {
  const globRe = engineGlobRe();
  for (const c of ['\n', '\r', LS, PS]) {
    const p = `src/a${c}b`;
    assert.equal(under(p, ['src']), true);
    assert.equal(designContract([{ writes: ['src'] }]).map(globRe).some((re) => re.test(p)), false, JSON.stringify(c));
    for (const mode of ['manual', 'engine']) assert.equal(S.classify([{ path: p, kind: 'file' }], { mode, planned: ['src'], supporting: [], readlink: () => '' })[0].class, 'material');
  }
});

test('normalRel parity: the local copy accepts exactly the writes validateEngineDag accepts (plain, nested, glob, dotted)', () => {
  for (const w of ['src/a.ts', 'src', 'a b/c', 'apps/api/src/**/*.ts', '**/x.ts', 'a?b', 'v1.2/x.min.js', '.github/w.yml', 'src/', './src', 'src/../x', '/abs', 'a//b', 'a\\b', '.', '..', 'src/.', '', 'C:x']) {
    let engine = true;
    try { validateEngineDag(DAG([[w]]), { ticket: TICKET }); } catch { engine = false; }
    assert.equal(S.normalRel(w), engine, JSON.stringify(w));
  }
});

// ------------------------------------------------------------------ malformed-declaration property (>= 5000)

// ------------------------------------------------------------------ separation and wording pins

test('no engine, gate or ship-ready script imports check-pr-scope.mjs, and nothing reads plan_table_drift', () => {
  const runtime = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'check-pr-scope.mjs')
    .concat(readdirSync(join(HERE, 'lib')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => `lib/${f}`));
  assert.deepEqual(runtime.filter((f) => /check-pr-scope|plan_table_drift|scope-contract/.test(readFileSync(join(HERE, f), 'utf8'))), []);
  assert.equal(/plan_table_drift|parseFilesTable|visibleLines|FILES_TOUCHED_HEADER|parseEnvelope/.test(readFileSync(SCRIPT, 'utf8')), false, 'the Markdown table parser is gone');
  for (const f of ['run-engine.mjs', 'engine-gates.mjs', 'gate.mjs', 'ship-ready-check.mjs']) assert.ok(existsSync(join(HERE, f)), f);
});

// ------------------------------------------------------------------ v3: the fenced block, structure rules R0-R10 (option B)

const good = { planned: ['src/a.ts'], supporting: ['tests'] };
const C = contract(good);
const GOOD_BODY = bodyOf(good);
/** A plan file text without START (validatePlanText reads structure only): `narr`, then RUN-STATE holding `rs`. */
const doc = (narr, rs = '') => `${narr}\n\n${B}\n${rs ? `${rs}\n` : ''}${E}\n`;
const P = (x) => doc(`# Plan\n\n${x}`);
const ESC = String.fromCharCode(0x1b);
const ACCEPT = 'ACCEPT';
const STRUCTURE = [
  // R1
  ['no block', P(TABLE), 'scope_contract_missing'],
  ['a legacy bare line (never converted)', P(`scope-contract: ${GOOD_BODY}`), 'scope_contract_missing'],
  ['two blocks', P(`${C}\n\n${C}`), 'scope_contract_ambiguous'],
  ['an opener with trailing info', P(C.replace('```scope-contract', '```scope-contract x')), 'scope_contract_missing'],
  ['a tilde opener', P(C.replace('```scope-contract', '~~~scope-contract').replace(/\n```\n/, '\n~~~\n')), 'scope_contract_missing'],
  ['an indented opener', P(`  ${C}`), 'scope_contract_missing'],
  ['a wrong closer', P(C.replace(/\n```\n/, '\n````\n')), 'scope_contract_malformed'],
  // R2
  ['the key in prose', P(`${C}\n\nThe scope-contract above binds.`), 'scope_contract_ambiguous'],
  ['the key in another case in a comment', P(`<!-- Scope-Contract: x -->\n\n${C}`), 'scope_contract_ambiguous'],
  ['the key in the RUN-STATE body', doc(`# Plan\n\n${C}`, 'note: scope-contract'), 'scope_contract_ambiguous'],
  ['a planned path holding the key', P(contract({ planned: ['src/scope-contract.ts'] })), 'scope_contract_ambiguous'],
  // R3a and R3b
  ['a fence before the block', P(`\`\`\`js\nx\n\`\`\`\n\n${C}`), 'scope_contract_unsafe'],
  ['inline triple backticks before', P(`use \`\`\`x\`\`\` here\n\n${C}`), 'scope_contract_unsafe'],
  ['a tilde run before', P(`~~~ note\n\n${C}`), 'scope_contract_unsafe'],
  ['a 4-backtick fence holding 3 before', P(`\`\`\`\`\n\`\`\`\nx\n\`\`\`\`\n\n${C}`), 'scope_contract_unsafe'],
  ['a list-contained fence before', P(`- step\n  \`\`\`\n  x\n  \`\`\`\n\n${C}`), 'scope_contract_unsafe'],
  ['an alias fence after (entity)', P(`${C}\n\n\`\`\`scope&#45;contract\nX\n\`\`\``), 'scope_contract_unsafe'],
  ['an alias fence after (backslash escape)', P(`${C}\n\n\`\`\`scope\\-contract\nX\n\`\`\``), 'scope_contract_unsafe'],
  ['a tilde fence after', P(`${C}\n\n~~~\nY\n~~~`), 'scope_contract_unsafe'],
  ['a quote-prefixed fence after', P(`${C}\n\n> \`\`\`x\n> q`), 'scope_contract_unsafe'],
  ['a list-prefixed fence after', P(`${C}\n\n1. \`\`\`\n   q`), 'scope_contract_unsafe'],
  ['a fence in the RUN-STATE body', doc(`# Plan\n\n${C}`, '```'), 'scope_contract_unsafe'],
  // R4 and R5
  ['the block after BEGIN', `# Plan\n\n${B}\n${E}\n\n${C}\n`, 'scope_contract_unsafe'],
  ['no blank line before', doc(`# Plan\n${C}`), 'scope_contract_unsafe'],
  ['no blank line after', P(C.replace(/\n```\n\n/, '\n```\nafter\n\n')), 'scope_contract_unsafe'],
  ['front matter directly before', doc(`---\nt: x\n---\n${C}`), 'scope_contract_unsafe'],
  ['front matter with a div and no blank (Codex)', doc(`---\n<div>\n---\n${C}`), 'scope_contract_unsafe'],
  // R6
  ['an unterminated script before', P(`<script>\n\n${C}\n\n</script>`), 'scope_contract_unsafe'],
  ['a script with a tab before', P(`<script\t>\n\n${C}`), 'scope_contract_unsafe'],
  ['a quoted script before', P(`> <script>\n\n${C}`), 'scope_contract_unsafe'],
  ['a quote marker glued to a script', P(`><script>\n\n${C}`), 'scope_contract_unsafe'],
  ['an unterminated style before', P(`<style>\n\n${C}\n\n</style>`), 'scope_contract_unsafe'],
  ['an unterminated comment before', P(`<!-- note\n\n${C}`), 'scope_contract_unsafe'],
  ['a comment around the block (Codex)', P(`${TABLE}\n\n<!--\n\n${C}\n\n-->`), 'scope_contract_unsafe'],
  ['an unterminated CDATA', P(`<![CDATA[\n\n${C}\n\n]]>`), 'scope_contract_unsafe'],
  ['an unterminated processing instruction', P(`<?x\n\n${C}\n\n?>`), 'scope_contract_unsafe'],
  ['an unterminated declaration', P(`<!X\n\n${C}\n\n>`), 'scope_contract_unsafe'],
  ['a processing instruction hidden behind a quoted script (live-oracle survivor)', doc(`><script>\n\n<?x\n\n\\\`<style>pre{display:none}</style>\\\`\n\n${C}\n\n<script>`), 'scope_contract_unsafe'],
  // R7 and R0 front matter
  ['unclosed front matter', doc(`---\nt: x\n\n${C}`), 'scope_contract_unsafe'],
  ['front matter closed by the other token', doc(`---\nt: x\n+++\n\n${C}`), 'scope_contract_unsafe'],
  ['a ... line in front matter', doc(`---\nt: x\n...\n---\n\n${C}`), 'scope_contract_unsafe'],
  ['unclosed gray-matter front matter', doc(`---yaml\nt: x\n\n${C}`), 'scope_contract_unsafe'],
  ['BOM front matter', doc(`${BOM}---\nt: x\n---\n\n${C}`), 'scope_contract_unsafe'],
  // R8
  ['display math before', P(`$$\nx\n$$\n\n${C}`), 'scope_contract_unsafe'],
  // R0 characters
  ['a lone CR before a script (Codex)', P(`x\r<script>\n\n${C}`), 'scope_contract_unsafe'],
  ['NUL', P(`a${NUL}b\n\n${C}`), 'scope_contract_unsafe'],
  ['ESC (terminal concealment)', P(`${ESC}[8mhidden${ESC}[0m\n\n${C}`), 'scope_contract_unsafe'],
  ['ESC in the RUN-STATE body', doc(`# Plan\n\n${C}`, `${ESC}[2J`), 'scope_contract_unsafe'],
  ...[0x07, 0x0b, 0x0c, 0x1f, 0x7f, 0x85, 0x9b, 0x2028, 0x2029, 0xfeff].map((cp) => [`control U+${cp.toString(16).padStart(4, '0')}`, P(`a${String.fromCharCode(cp)}b\n\n${C}`), 'scope_contract_unsafe']),
  // R10
  ['no contract body line', P(C.replace(/\n\ncontract body: .*$/, '')), 'contract_body_digest_missing'],
  ['two contract body lines', P(`${C}\n\n${C.split('\n').at(-1)}`), 'contract_body_digest_ambiguous'],
  ['a wrong contract body digest', P(C.replace(/sha256:[0-9a-f]{64}$/, sha('x'))), 'contract_body_digest_mismatch'],
  ['a malformed contract body digest', P(C.replace(/sha256:[0-9a-f]{64}$/, 'abc')), 'contract_body_digest_mismatch'],
  ['a contract body digest only after RUN-STATE', `# Plan\n\n${C.replace(/\n\ncontract body: .*$/, '')}\n\n${B}\n${E}\n\n${C.split('\n').at(-1)}\n`, 'contract_body_digest_missing'],
  // body: canonical and field rules (unchanged from 82ec937)
  ['a space before the JSON', P(block(` ${GOOD_BODY}`)), 'scope_contract_noncanonical'],
  ['whitespace inside the JSON', P(block(GOOD_BODY.replace('"v":1', '"v": 1'))), 'scope_contract_noncanonical'],
  ['keys out of order', P(block('{"mode":"manual","v":1,"dag":null,"planned":["src/a.ts"],"supporting":[]}')), 'scope_contract_noncanonical'],
  ['an extra key', P(block('{"v":1,"mode":"manual","dag":null,"planned":["src/a.ts"],"supporting":[],"x":1}')), 'scope_contract_noncanonical'],
  ['a duplicate key', P(block('{"v":1,"v":1,"mode":"manual","dag":null,"planned":["src/a.ts"],"supporting":[]}')), 'scope_contract_noncanonical'],
  ['a unicode escape', P(block('{"v":1,"mode":"manual","dag":null,"planned":["src/\\u0061.ts"],"supporting":[]}')), 'scope_contract_noncanonical'],
  ['not JSON', P(block('{v:1}')), 'scope_contract_noncanonical'],
  ['version 2', P(block('{"v":2,"mode":"manual","dag":null,"planned":["src/a.ts"],"supporting":[]}')), 'scope_contract_invalid'],
  ['a comment open inside the JSON (Codex)', P(block('{"v":1,"mode":"manual","dag":null,"planned":["src/a.ts<!--","src","x-->"],"supporting":[]}')), 'scope_contract_invalid'],
  ['an entity inside the JSON', P(contract({ planned: ['src/&#60;!--'] })), 'scope_contract_invalid'],
  ['a dot-dot planned entry', P(contract({ planned: ['src/../api/x.ts'] })), 'scope_contract_invalid'],
  ['a glob in manual mode', P(contract({ planned: ['src/*.ts'] })), 'scope_contract_invalid'],
  ['an empty manual planned list', P(contract({ planned: [] })), 'scope_contract_invalid'],
  ['a supporting entry outside the closed class', P(contract({ planned: ['src/a.ts'], supporting: ['tests2'] })), 'scope_contract_invalid'],
  ['a supporting entry under a forbidden directory', P(contract({ planned: ['src/a.ts'], supporting: ['.github/tests'] })), 'scope_contract_invalid'],
  ['supporting inside planned', P(contract({ planned: ['src'], supporting: ['src/tests'] })), 'supporting_overlaps_planned'],
  // accepted: structure only (option B: raw HTML is no longer refused; DOM effects are excluded by the signed policy)
  ['a template wrapper (type 7, ends at the blank)', P(`<template>\n\n${C}\n\n</template>`), ACCEPT],
  ['a details wrapper', P(`<details><summary>x</summary>\n\n${C}\n\n</details>`), ACCEPT],
  ['a div hidden wrapper', P(`<div hidden>\n\n${C}\n\n</div>`), ACCEPT],
  ['a mid-line div hidden', P(`text <div hidden>\n\n${C}\n\n</div>`), ACCEPT],
  ['a multi-line img alt', P(`<img alt="\n\n${C}\n\n">`), ACCEPT],
  ['a style after the block', P(`${C}\n\n<style>pre{display:none}</style>`), ACCEPT],
  ['a script in the RUN-STATE body', doc(`# Plan\n\n${C}`, '<script>document.body.hidden=true</script>'), ACCEPT],
  ['an escaped-backtick style before (Codex)', P(`\\\`<style>pre{display:none}</style>\\\`\n\n${C}`), ACCEPT],
  ['placeholders, autolinks and closing tags', P(`Plan for <TICKET>, see <https://e.invalid> </div>\n\n${C}`), ACCEPT],
  ['a single-line script and balanced comments', P(`<script>x</script>\n<!-- a -->\n\n<!--\nmulti <x>\n-->\n\n${C}`), ACCEPT],
  ['closed front matter', doc(`---\ntitle: x\n---\n\n# Plan\n\n${C}`), ACCEPT],
  ['closed gray-matter and toml front matter', doc(`---yaml\nk: v\n---\n\n${C}`), ACCEPT],
  ['toml front matter', doc(`+++\nk = 1\n+++\n\n${C}`), ACCEPT],
  ['front matter with a div then a blank (Codex, fixed)', doc(`---\n<div>\n---\n\n${C}`), ACCEPT],
  ['display math after the block', P(`${C}\n\n$$\nx\n$$`), ACCEPT],
  ['lists and quotes before, separated by a blank', P(`- a\n  b\n\n> q\n\n1. x\n\n${C}`), ACCEPT],
  ['indented code before', P(`    <div hidden>\n    code\n\n${C}`), ACCEPT],
  ['CRLF line ends', P(C).replace(/\n/g, '\r\n'), ACCEPT],
  ['emphasis and link syntax in entries (literal in the fence)', P(contract({ planned: ['src/[safe](hidden)', 'src/_a_/__b__'], supporting: ['__tests__'] })), ACCEPT],
  ['engine globs that would render as emphasis', P(contract({ mode: 'engine', dag: sha('d'), planned: ['apps/*/src', 'lib/**/x_y_.ts'] })), ACCEPT],
];
for (const [name, text, want] of STRUCTURE) {
  test(`v3 structure: ${name} -> ${want}`, () => {
    if (want === ACCEPT) assert.doesNotThrow(() => S.validatePlanText(text), name);
    else assert.throws(() => S.validatePlanText(text), (e) => e.exit === 2 && e.code === want, `${name}: expected ${want}`);
  });
}

test('lint and check share one rule function: lint refuses every STRUCTURE refusal with the same code, and passes a draft', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 's6-lint-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lint = (text) => { writeFileSync(join(dir, 'p.md'), text); return spawnSync(process.execPath, [SCRIPT, 'lint', '--plan', join(dir, 'p.md')], { encoding: 'utf8' }); };
  let n = 0;
  for (const [name, text, want] of STRUCTURE.filter((_, i) => i % 3 === 0)) {
    const r = lint(text);
    if (want === ACCEPT) assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    else { assert.equal(r.status, 2, name); assert.match(r.stderr, new RegExp(want), name); }
    n++;
  }
  assert.ok(n > 25, `linted ${n}`);
  const draft = lint(`# Plan\n\n${C}\n`);
  assert.equal(draft.status, 0, draft.stderr);
  assert.match(draft.stderr, /draft: no RUN-STATE/);
  const out = S.contractOutput(GOOD_BODY);
  assert.equal(draft.stdout, `${out.block}\n\n${out.digestLine}\n\n${out.quote}\n`);
});

test('the record carries the block body, its SHA-256 and the approval caveat', (t) => {
  const r = repo(t);
  writePlan(r, contract(good));
  r.write('src/a.ts');
  const out = run(r);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.contract, GOOD_BODY);
  assert.equal(out.json.contract_sha256, sha(GOOD_BODY));
  assert.equal(out.json.approval_caveat, S.APPROVAL_CAVEAT);
  assert.match(S.APPROVAL_CAVEAT, /does not authorize execution/);
  assert.match(S.APPROVAL_CAVEAT, /Native ExitPlanMode approval remains mandatory/);
});

test('contract --verify-quote: byte comparison of the four-backtick quote with the plan and the record, never hashes alone', (t) => {
  const r = repo(t);
  const plan = writePlan(r, contract(good));
  r.write('src/a.ts');
  const recordFile = join(r.dir, '.git', 'rec.json');
  writeFileSync(recordFile, run(r).stdout);
  const q = (text, extra = ['--record', recordFile]) => { const f = join(r.dir, '.git', 'req.txt'); writeFileSync(f, text); return spawnSync(process.execPath, [SCRIPT, 'contract', '--verify-quote', f, '--plan', plan, ...extra], { encoding: 'utf8' }); };
  const quote = S.contractOutput(GOOD_BODY).quote;
  const pass = q(`\n\n${quote}\n\n`);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /verify-quote: PASS/);
  assert.ok(pass.stdout.includes(`CAVEAT: ${S.APPROVAL_CAVEAT}`));
  assert.ok(pass.stdout.includes(S.NOT_VERIFIED_REPORT));
  const other = bodyOf({ planned: ['src'], supporting: ['tests'] });
  const swapped = q(`${S.contractOutput(other).quote}\n`);
  assert.equal(swapped.status, 1, 'a stated matching hash with a different body must FAIL');
  assert.match(swapped.stdout, /verify-quote: FAIL: the quoted body differs from the plan block/);
  assert.equal(q(`${S.contractOutput(other).quote}\n\ncontract body: ${sha(GOOD_BODY)}\n`).status, 1, 'a stated matching hash beside a different body');
  const three = q(`\`\`\`\n${S.contractOutput(GOOD_BODY).block}\n\`\`\`\n`);
  assert.equal(three.status, 1, 'a three-backtick outer fence collides with the inner closer');
  assert.equal(q(`${quote}\n\n${quote}\n`).status, 1, 'two quoted blocks');
  assert.equal(q(`${quote.replace('````', `${ESC}[8m\`\`\`\``)}\n`).status, 1, 'a control sequence in the quote');
  const rec = JSON.parse(readFileSync(recordFile, 'utf8'));
  writeFileSync(recordFile, JSON.stringify({ ...rec, contract: other }));
  assert.match(q(`${quote}\n`).stdout, /differs from record\.contract/);
  writeFileSync(recordFile, JSON.stringify({ ...rec, contract_sha256: sha('x') }));
  assert.match(q(`${quote}\n`).stdout, /record\.contract_sha256/);
  assert.equal(q(`${quote}\n`, []).status, 0, 'plan-only verification');
});

test('verify-quote input is exactly the quote block: every other non-blank line FAILS (Codex repros, near-misses, prose)', (t) => {
  const r = repo(t);
  const plan = writePlan(r, contract(good));
  r.write('src/a.ts');
  const recordFile = join(r.dir, '.git', 'rec.json');
  writeFileSync(recordFile, run(r).stdout);
  const q = (text) => { const f = join(r.dir, '.git', 'req.txt'); writeFileSync(f, text); return spawnSync(process.execPath, [SCRIPT, 'contract', '--verify-quote', f, '--plan', plan, '--record', recordFile], { encoding: 'utf8' }); };
  const quote = S.contractOutput(GOOD_BODY).quote;
  const ZWSP = String.fromCharCode(0x200b);
  const otherQuote = S.contractOutput(GOOD_BODY.replace('"src/a.ts"', '"src"')).quote;
  assert.equal(q(`${quote}\n`).status, 0, 'the quote alone passes');
  assert.equal(q(`\n \t\n${quote}\n\n\t\n`).status, 0, 'whitespace-only lines around the quote are allowed');
  assert.equal(q(`${quote}\n`.replace(/\n/g, '\r\n')).status, 0, 'CRLF is normalized');
  const prose = q(`Request:\n\n${quote}\n`);
  assert.equal(prose.status, 1, 'prose beside the quote');
  assert.match(prose.stdout, /saved text must be only the quote; save the quote block extracted from the request, prose belongs elsewhere/);
  assert.equal(q(`${quote.replace('````\n', '````\n\n')}\n`).status, 1, 'a blank line inside the quote');
  const NBSP = String.fromCharCode(0xa0);
  for (const [name, extra] of [
    ['Codex repro: a second quote whose opener has a trailing space', otherQuote.replace(S.OPENER, `${S.OPENER} `)],
    ['a tab after the opener', otherQuote.replace(S.OPENER, `${S.OPENER}\t`)],
    ['extra info text', otherQuote.replace(S.OPENER, `${S.OPENER} x`)],
    ['a five-backtick outer fence', otherQuote.replace(/^````/, '`````').replace(/````$/, '`````')],
    ['a tilde outer fence', otherQuote.replace(/^````/, '~~~~').replace(/````$/, '~~~~')],
    ['an indented second quote', otherQuote.split('\n').map((l) => `  ${l}`).join('\n')],
    ['a CRLF second quote', otherQuote.replace(/\n/g, '\r\n')],
    ['an NBSP after the opener', otherQuote.replace(S.OPENER, `${S.OPENER}${NBSP}`)],
    ['a quote-prefixed second quote', otherQuote.split('\n').map((l) => `> ${l}`).join('\n')],
    ['a plain fence elsewhere', '```\nnote\n```'],
    ['an indented plain fence', '  ```\n  note\n  ```'],
    ['a quote-prefixed plain tilde fence', '> ~~~\n> note\n> ~~~'],
    ['a stray contract-looking JSON line', GOOD_BODY.replace('"src/a.ts"', '"src"')],
    ['the key in prose', 'see the scope-contract above'],
    ['Codex: a split, spaced second contract', '{\n"v":1,"mode":"manual","dag":null,"planned":["src"],"supporting":["tests"]}'],
    ['a zero-width-space-prefixed second fence', otherQuote.split('\n').map((l) => `${ZWSP}${l}`).join('\n')],
    ['a zero-width space inside the key', otherQuote.replace('scope-contract', `scope-${ZWSP}contract`)],
    ['a Cyrillic lookalike key line', otherQuote.replace('scope-contract', `sc${CYR_O}pe-contract`)],
    ['contract-like JSON in indented code', `    ${GOOD_BODY.replace('"src/a.ts"', '"src"')}`],
    ['a lone word', 'approved'],
  ]) {
    const res = q(`${quote}\n\n${extra}\n`);
    assert.equal(res.status, 1, `${name}: ${res.stdout}`);
    assert.match(res.stdout, /verify-quote: FAIL/, name);
    assert.equal(q(`${extra}\n\n${quote}\n`).status, 1, `${name} (before the quote)`);
  }
});

test('verify-quote: record.contract correct but record.contract_sha256 wrong is a FAIL', (t) => {
  const r = repo(t);
  const plan = writePlan(r, contract(good));
  r.write('src/a.ts');
  const rec = JSON.parse(run(r).stdout);
  const recordFile = join(r.dir, '.git', 'rec.json');
  writeFileSync(recordFile, JSON.stringify({ ...rec, contract: GOOD_BODY, contract_sha256: sha('x') }));
  const f = join(r.dir, '.git', 'req.txt');
  writeFileSync(f, `${S.contractOutput(GOOD_BODY).quote}\n`);
  const res = spawnSync(process.execPath, [SCRIPT, 'contract', '--verify-quote', f, '--plan', plan, '--record', recordFile], { encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /verify-quote: FAIL: record\.contract_sha256 is not the SHA-256 of the quoted body/);
});

// ORACLE-GENERATOR-BEGIN (the scratch generator evaluates exactly this function; changing it requires regenerating ORACLE)
function oracleDocs(hash) {
  const body = '{"v":1,"mode":"manual","dag":null,"planned":["src/a.ts"],"supporting":["tests"]}';
  const block = '```scope-contract\n' + body + '\n```\n\ncontract body: ' + hash(body);
  const PRE = ['# Title', 'para text', '---\ntitle: x\n---', '---yaml\nk: v\n---', '+++\nk = 1\n+++', '---\n<div>\n---', '<div hidden>',
    'text <div hidden>', '<details>', '<template>', '<script>\nvar x', '<script>x</script>', '<script\tsrc=x>', '> <script>', '><script>',
    '<style>pre{display:none}</style>', '<!-- c -->', '<!--\nmulti\n-->', '<!-- open', '<?x', '<![CDATA[', '<!DOCTYPE', '- item', '- item\n  more',
    '> quote', '1. item', '```\ncode\n```', '~~~\ncode\n~~~', '````\n```\nx\n````', '- ```\n  code\n  ```', '    indented', '$$', '$$\nx\n$$',
    '| a | b |\n|---|---|\n| c | d |', '**b** _e_ `c`', '\\`<style>pre{display:none}</style>\\`', '[x]: http://e.invalid', '***',
    'Setext\n===', 'Setext\n---', '<TICKET> plan', 'see <https://e.invalid>', 'use ```x``` inline', '---\nunclosed: front'];
  const POST = ['after', '```scope&#45;contract\nX\n```', '```scope\\-contract\nX\n```', '~~~\nY\n~~~', '> ```x\nq', '<style>pre{display:none}</style>',
    '<script>', '$$', '```\nexample\n```'];
  let s = 20261123 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const docs = [];
  for (let i = 0; i < 400; i++) {
    const pre = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(PRE)).join(rnd() < 0.8 ? '\n\n' : '\n');
    const post = Array.from({ length: Math.floor(rnd() * 2) }, () => pick(POST)).join('\n\n');
    const sep = rnd() < 0.85 ? '\n\n' : '\n';
    docs.push(`${pre}${pre ? sep : ''}${block}${post ? '\n\n' + post : ''}\n`);
  }
  return { body, docs };
}
// ORACLE-GENERATOR-END

/**
 * Frozen expectations from two independent parsers, generated ONCE in a scratch directory (never a dependency):
 * markdown-it 14.1.0 `markdownit({ html: true })`, fences = tokens of type `fence`, info normalized with
 * `md.utils.unescapeAll(token.info).trim()`, top level = `token.level === 0`; commonmark.js 0.31.2 `new Parser()`
 * (default options, raw HTML kept), fences = `code_block` nodes with `_isFenced`, top level = parent `document`.
 * Per document: 'A' when the WHOLE document holds exactly one fence, at top level, info `scope-contract`, content
 * `body + "\n"`; 'B' otherwise. This is REGRESSION EVIDENCE for this corpus, not a live oracle for new inputs (those rely
 * on the structural argument of the design, section 3); the optional live-oracle script in the S6 scratchpad re-runs
 * both parsers against random documents.
 */
const ORACLE = {
  sha: 'sha256:379712613404afc1b68751a67128fbbfb71164da381750b1b1c9ab11faf8b094',
  md: 'BBABBBBBAAAAAAAABBABBBBAAABBAAABABABABABBAABBBABBAABBBAAAABAAABBBBAABBAAAABBBBAABABBAABABBABBABAAAABAABBABBABAABABAAAABAAAABBAAABBBBBBBAAAAAABAAABAABAABABBAABAAABAAABBBBBBBBBAABAAAAAABAABABBBABABBAABABBBABBABAAAABABAABAAAABABAABBBAABBBAAAAAAABAABAABAAAAABABBBAABBAABBBBAABBBABAABABAABABBBBABBABAAABBBBABBABAABAAAABABBAABABBBAAABAABBABBAABBABABAABBAABABAAABABBBBBABABBAABBABBABBBAAAAABBAABAAABAAABAAAA',
  cm: 'BBABBBBBAAAAAAAABBABBBBAAABBAAABABABABABBAABBBABBAABBBAAAABAAABBBBAABBAAAABBBBAABABBAABABBABBABAAAABAABBABBABAABABAAAABAAAABBAAABBBBBBBAAAAAABAAABAABAABABBAABAAABAAABBBBBBBBBAABAAAAAABAABABBBABABBAABABBBABBABAAAABABAABAAAABABAABBBAABBBAAAAAAABAABAABAAAAABABBBAABBAABBBBAABBBABAABABAABABBBBABBABAAABBBBABBABAABAAAABABBAABABBBAAABAABBABBAABBABABAABBAABABAAABABBBBBABABBAABBABBABBBAAAAABBAABAAABAAABAAAA',
};

test('frozen two-parser corpus (regression evidence): every accepted document renders exactly one top-level scope-contract fence', () => {
  const { docs } = oracleDocs(sha);
  assert.equal(sha(docs.join(NUL)), ORACLE.sha, 'the generator changed: regenerate ORACLE with the scratch generator');
  let accepted = 0, refusedMisrendered = 0;
  docs.forEach((d, i) => {
    let ok = true;
    try { S.validatePlanText(d); } catch (e) { assert.equal(e.exit, 2, String(e.stack)); ok = false; }
    if (ok) { accepted++; assert.equal(ORACLE.md[i] + ORACLE.cm[i], 'AA', `accepted but rendered otherwise: ${JSON.stringify(d)}`); }
    else if (ORACLE.md[i] !== 'A' || ORACLE.cm[i] !== 'A') refusedMisrendered++;
  });
  assert.ok(accepted >= 40 && refusedMisrendered >= 40, `accepted ${accepted}, refused misrendered ${refusedMisrendered}`);
});

test('Codex 2: a list-contained fence cannot hide or add a declaration', (t) => {
  const r = repo(t);
  writePlan(r, `- step one\n  \`\`\`\n${TABLE.split('\n').map((l) => `  ${l}`).join('\n')}\n  \`\`\`\n`);
  r.write('src/a.ts');
  assert.match(run(r).stderr, /scope_contract_missing/);
  writePlan(r, `- step one\n  \`\`\`\n  \`\`\`scope-contract\n  ${bodyOf({ planned: ['src'] })}\n  \`\`\`\n\n${contract({ planned: ['src/a.ts'] })}`);
  assert.match(run(r).stderr, /scope_contract_ambiguous/);
});

test('Codex JSON-string example end to end: refused by the entry charset, never CLEAN', (t) => {
  const r = repo(t);
  writePlan(r, block('{"v":1,"mode":"manual","dag":null,"planned":["src/a.ts<!--","src","x-->"],"supporting":[]}'));
  r.write('src/evil.mjs');
  const out = run(r);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /scope_contract_invalid/);
});

test('the contract helper prints the block, the digest line and the four-backtick quote, which check accepts', (t) => {
  const r = repo(t);
  const d = dagFile(r, [['src/b', 'src/a']]);
  const p = spawnSync(process.execPath, [SCRIPT, 'contract', '--mode', 'engine', '--dag', d.file, '--supporting', 'tests', '--supporting', 'docs'], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const out = S.contractOutput(bodyOf({ mode: 'engine', dag: d.digest, planned: ['src/a', 'src/b'], supporting: ['docs', 'tests'] }));
  assert.equal(p.stdout, `${out.block}\n\n${out.digestLine}\n\n${out.quote}\n`);
  assert.ok(out.quote.startsWith('````\n```scope-contract\n') && out.quote.endsWith('\n```\n````'));
  const m = spawnSync(process.execPath, [SCRIPT, 'contract', '--mode', 'manual', '--planned', 'src/x', '--planned', 'src/a'], { encoding: 'utf8' });
  const mo = S.contractOutput(bodyOf({ planned: ['src/a', 'src/x'] }));
  assert.equal(m.stdout, `${mo.block}\n\n${mo.digestLine}\n\n${mo.quote}\n`);
  const bad = spawnSync(process.execPath, [SCRIPT, 'contract', '--mode', 'manual', '--planned', 'src/*.ts'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  writePlan(r, `${out.block}\n\n${out.digestLine}`);
  r.write('src/a/x.ts');
  assert.equal(run(r, ['--dag', d.file]).status, 0);
});

test('property: a mutated declaration is refused or classifies exactly as the canonical contract (never CLEAN where it says MATERIAL)', (t) => {
  const base = JSON.stringify({ v: 1, mode: 'manual', dag: null, planned: ['src/checkout/page.tsx', 'src/checkout'], supporting: ['tests', 'docs'] });
  const files = ['src/checkout/page.tsx', 'src/checkout/x.ts', 'tests/a.test.ts', 'docs/g.md', 'docs/x.mjs', 'src/api/route.ts', 'package.json', 'tests/l']
    .map((path) => ({ path, kind: path === 'tests/l' ? 'symlink' : 'file' }));
  const classes = (c) => S.classify(files, { mode: c.mode, planned: c.planned, supporting: c.supporting, readlink: () => '../x' }).map((f) => [f.path, f.class]);
  const reference = classes(S.parseContract(planText(block(base))));
  assert.ok(reference.some(([, c]) => c === 'material'));
  const BODY_M = [
    (s) => s.replace('{', ' {'), (s) => s.replace('"v":1', '"v": 1'), (s) => s.replace('{"v":1,', '{"v":1,"v":1,'),
    (s) => s.replace(/}$/, ',"x":1}'), (s) => s.replace(/,"supporting":\[[^\]]*\]/, ''), (s) => s.replace('"v":1', '"v":"1"'),
    (s) => s.replace('"dag":null', '"dag":0'), (s) => s.replace(/"planned":\[[^\]]*\]/, '"planned":"src"'),
    (s) => s.replace('{"v":1,"mode":"manual",', '{"mode":"manual","v":1,'), (s) => s.replace('tests', '\\u0074ests'),
    (s) => s.replace('tests', `t${CYR_E}sts`), (s) => s.replace('"mode"', `"m${CYR_O}de"`), (s) => s.replace('src/checkout"', 'src/../checkout"'),
    (s) => s.replace('src/checkout"', 'src/./checkout"'), (s) => s.replace('"src/checkout"', '"/src/checkout"'), (s) => s.replace('src/checkout"', 'src\\\\checkout"'),
    (s) => s.replace('src/checkout"', 'src/checkout/*"'), (s) => s.replace('src/checkout"', 'src/?heckout"'), (s) => s.replace('"src/checkout"', '""'),
    (s) => s.replace('"docs"', `"${'d'.repeat(300)}"`), (s) => s.replace(/"planned":\[/, `"planned":[${Array.from({ length: 70 }, (_, i) => `"p${i}"`).join(',')},`),
    (s) => s.replace('"tests"', '"src/checkout/tests"'), (s) => s.replace('"docs"', '"documentation"'), (s) => s.replace('"tests"', '"tests/"'),
    (s) => s.replace('"manual"', '"engine"'), (s) => s.replace('"dag":null', `"dag":"${sha('x')}"`), (s) => `${s} `, (s) => `${s}\t`,
    (s) => s.replace('"v":1', `"v":1${NUL}`), (s) => s.replace(/"planned":\[[^\]]*\]/, '"planned":[]'),
    (s) => s.replace('"src/checkout/page.tsx","src/checkout"', '"src/checkout","src/checkout/page.tsx"'), // valid: order is not semantic
    (s) => s.replace('"tests","docs"', '"docs","tests"'), (s) => s.split('"').join("'"), (s) => s.replace('{', '{\n'), (s) => s.slice(0, -1),
    (s) => s.replace('"planned"', '"Planned"'), (s) => s.replace(/"supporting":\[[^\]]*\]/, '"supporting":null'), (s) => s.replace('"v":1', '"v":1.0'),
    (s) => s.replace('page.tsx', 'page.tsx\\n'), (s) => s.replace('page.tsx', `page.tsx${LS}`), (s) => s.replace('"tests"', '"node_modules/tests"'),
    (s) => s.replace('page.tsx', 'page<!--.tsx'), (s) => s.replace('page.tsx', 'page&lt;.tsx'), (s) => s.replace('page.tsx', 'page`.tsx'),
    (s) => s.replace('page.tsx', 'scope-contract.tsx'),
  ];
  const TEXT_M = [
    (x) => x.replace('```scope-contract', ' ```scope-contract'), (x) => `${x}\n\n${x}`, (x) => `${x}\n\nsee the scope-contract above`,
    (x) => `${x}\n\n\`\`\`\nexample\n\`\`\``, (x) => `\`\`\`\nx\n\`\`\`\n\n${x}`, (x) => `${x}\n\n\`\`\`scope&#45;contract\nX\n\`\`\``,
    (x) => `${BOM}${x}`, (x) => x.replace('\n```\n', `\n\`\`\`${ESC}\n`), (x) => `x\r${x}`, (x) => x.replace(/\n\ncontract body/, '\ncontract body digest'),
    (x) => x.replace(/contract body: .*$/, `contract body: sha256:${'0'.repeat(64)}`), (x) => `<!--\n\n${x}`, (x) => `$$\n\n${x}`,
    (x) => `<script>\n\n${x}`, (x) => x.replace(/\n/g, '\r\n'), (x) => `<div hidden>\n\n${x}`, (x) => `> ${x}`, (x) => `- ${x}`,
    (x) => x.replace('\n```\n\n', '\n```\nnext\n\n'), (x) => `${x}\n\n~~~\ny\n~~~`, (x) => `${x}\n\ncontract body: ${sha('x')}`,
  ];
  const rand = rng(424242);
  let refused = 0, same = 0;
  for (let i = 0; i < 6000; i++) {
    let body = base;
    for (let j = Math.floor(rand() * 3); j > 0; j--) body = BODY_M[Math.floor(rand() * BODY_M.length)](body);
    let text = block(body);
    for (let j = Math.floor(rand() * 3); j > 0; j--) text = TEXT_M[Math.floor(rand() * TEXT_M.length)](text);
    let c;
    try { c = S.parseContract(planText(text)); } catch (e) { assert.equal(e.exit, 2, String(e.stack)); refused++; continue; }
    assert.deepEqual(classes(c), reference, JSON.stringify(text));
    same++;
  }
  t.diagnostic(`refused ${refused}, same ${same}`);
  assert.ok(refused + same >= 5000 && refused > 2500 && same > 300, `refused ${refused}, same ${same}`);
});

test('S6 and F11 wording pins', () => {
  const plan = flat(ref('plan.md')), review = flat(ref('review.md')), ship = flat(ref('ship.md'));
  assert.ok(ref('plan.md').includes('````markdown\n'), 'the template has a four-backtick outer fence');
  assert.ok(plan.includes('```scope-contract {"v":1,"mode":"<engine|manual>","dag":"<sha256 of the DAG file, or null in manual mode>","planned":[<the DAG writes, or literal paths in manual mode>],"supporting":[<test or docs directories, e.g. "tests">]} ```'));
  assert.ok(plan.includes('The Files touched column is explanation for the approver and is read by no script; the fenced `scope-contract` block is the authoritative scope.'));
  assert.ok(plan.includes('Scope approval is valid only from a native ExitPlanMode approval given on a qualified approval surface: a surface that shows the complete, untruncated plan and does not let raw HTML or Markdown extensions hide or run content. Qualified surfaces: the Claude Code terminal, Claude Desktop, and Plannotator\'s Approve action.')); // supersedes the old single-surface pin (2026-11-24)
  assert.ok(plan.includes('Browser, GitHub and editor previews are never valid approval surfaces.'));
  assert.ok(plan.includes('native ExitPlanMode approval remains mandatory'));
  assert.ok(plan.includes('Raw HTML in a plan is no longer refused by `check-pr-scope.mjs`'));
  assert.ok(!plan.includes('scope-envelope:'));
  assert.ok(plan.includes('| <old consumers · cached clients · deploy order of the changed shared contract> | <regression · data-integrity: a deployed or cached client still sends/expects the previous shape> | <`contract-consumer` test kind against the previous shape (`shared-contract` tag); Integration Contract frontend compatibility> | <PROVE> | <the contract shape or deploy order changes> | <planned> |'));
  assert.ok(plan.includes('When the change touches a shared contract (the Integration Contract is triggered, or the `shared-contract` risk label or test-trigger tag applies), section 3b has a row for old consumers, cached clients and deploy order, or lists it under `Not applicable:` with the reason.'));
  assert.ok(plan.includes('Supporting paths are outside the Design Contract'));
  assert.ok(review.includes('run `node scripts/check-pr-scope.mjs check --repo <repo> --ticket <ticket> --run-id <id> --base <base> --plan <plan> [--dag <dag>]` on the candidate'));
  assert.ok(review.includes('Exit 1 (a material path) is a Design Contract expansion: **WAIT_FOR_USER** and re-approve through `ExitPlanMode`.'));
  assert.ok(review.includes('A contract or mode change is a plan change: re-approval through `ExitPlanMode`.'));
  assert.ok(review.includes('ambiguous, noncanonical or invalid contract block)') && !review.includes('invalid contract line)'));
  assert.ok(review.includes('An engine-mode contract always needs `--dag`'));
  assert.ok(review.includes('`node scripts/check-pr-scope.mjs contract --verify-quote <saved-quote> --plan <plan> --record <scope.json>`'));
  assert.ok(review.includes('native ExitPlanMode approval remains mandatory'));
  assert.ok(review.includes('Raw HTML in the plan is no longer refused by the check'));
  assert.ok(review.includes('the orchestrator extracts ONLY the four-backtick quote block from the approval request it sent and saves that'));
  assert.ok(review.includes('This is a precise input definition, not an attempt to detect contradictory prose.'));
  assert.ok(ship.includes('the saved quote block (only the four-backtick quote, extracted from the request)'));
  assert.ok(plan.includes('the orchestrator extracts ONLY the four-backtick quote block from the approval request it sent and saves that'));
  assert.ok(ship.includes('Rerun `check-pr-scope.mjs check` on the frozen candidate: its `candidate_id` must equal the reviewed ID and its outcome must be `CLEAN`; a stored record is never trusted.'));
  assert.ok(ship.includes('Rerun `contract --verify-quote` against the saved quote block (only the four-backtick quote, extracted from the request) and the SHIP record; a FAIL blocks SHIP.'));
  assert.ok(ship.includes('`scope: {outcome, material[], record_sha}`'));
  assert.ok(ship.includes('**Exit 0 is never a commit or freeze permission.**'));
  assert.ok(ship.includes('At SHIP, exit 1 is **WAIT_FOR_USER**'));
  assert.ok(ship.includes('`CLEAN` alone does not establish this line'));
  for (const [name, t] of [['plan', plan], ['review', review], ['ship', ship]]) assert.ok(t.includes(S.NOT_VERIFIED_REPORT), `${name} carries the fail-closed report`);
  assert.ok(plan.includes('| Component / flow / dependency touched | Risk (technical · security · business · data-integrity · regression) | Check that covers it (test type, security control id, review skill or gate) | Runs when | Re-runs when | Status |'));
  for (const t of [plan, review, ship]) assert.ok(!/\bspecialists?\b/i.test(t));
});

test('the record hash: stdout bytes equal the written record', (t) => {
  const r = repo(t);
  writePlan(r, contract({ planned: ['src/a.ts'] }));
  r.write('src/a.ts');
  const out = run(r);
  assert.equal(out.status, 0, out.stderr);
  const h = (s) => createHash('sha256').update(s).digest('hex');
  assert.equal(h(readFileSync(defaultOut(r))), h(out.stdout));
  unlinkSync(defaultOut(r));
});

// STAB-410 F-3: an owner who approves "three files" plus the Recording paths line gets the 5-file commit
// (3 contract files, the plan, session-log.md) and the scope check is CLEAN: the two recording paths are the pinned
// candidate exclusions, never contract paths. Characterization of existing behavior; the wording pin is in
// stabilization-wording.test.mjs.
test('STAB-410 F-3: a plan listing 3 contract files plus a Recording paths line is CLEAN with the 5-file commit shape', (t) => {
  const r = repo(t);
  const recording = '**Recording paths:** `.specs/plans/T-1.md` (this plan) and the predeclared ticket-keyed `session-log.md` entry.';
  const three = contract({ planned: ['src/a.ts', 'src/b.ts', 'tests/a.test.ts'] });
  writePlan(r, `${TABLE}\n\n${three}\n\n${recording}`);
  r.write('src/a.ts'); r.write('src/b.ts'); r.write('tests/a.test.ts');
  r.write('session-log.md');
  const out = run(r);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(out.json.outcome, 'CLEAN');
  assert.deepEqual(out.json.counts, { planned: 3, supporting: 0, material: 0, total: 3 });
  assert.ok(existsSync(join(r.dir, PLAN_REL)) && existsSync(join(r.dir, 'session-log.md')), 'the 5 files exist in the commit shape');
  assert.deepEqual(out.json.files.map((x) => x.path).sort(), ['src/a.ts', 'src/b.ts', 'tests/a.test.ts']);
});
