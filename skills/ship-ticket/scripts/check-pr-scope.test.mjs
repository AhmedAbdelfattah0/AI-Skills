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
const contract = ({ mode = 'manual', dag = null, planned, supporting = [] }) =>
  `scope-contract: ${JSON.stringify({ v: 1, mode, dag, planned, supporting })}`;
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

test('Codex 2: a list-contained fence cannot hide or add a declaration', (t) => {
  const r = repo(t);
  const fence = `- step one\n  \`\`\`\n${TABLE.split('\n').map((l) => `  ${l}`).join('\n')}\n  \`\`\`\n`;
  writePlan(r, fence);
  r.write('src/a.ts');
  assert.match(run(r).stderr, /scope_contract_missing/);
  const fencedLine = `- step one\n  \`\`\`\n  ${contract({ planned: ['src'] })}\n  \`\`\`\n`;
  writePlan(r, `${fencedLine}\n${contract({ planned: ['src/a.ts'] })}`);
  assert.match(run(r).stderr, /scope_contract_ambiguous/);
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

const good = { planned: ['src/a.ts'], supporting: ['tests'] };
const raw = (json) => `scope-contract: ${json}`;
for (const [name, body, code] of [
  ['no contract line', TABLE, 'scope_contract_missing'],
  ['a second contract line', `${contract(good)}\n${contract(good)}`, 'scope_contract_ambiguous'],
  ['the key mentioned in prose', `${contract(good)}\nThe scope-contract above is binding.`, 'scope_contract_ambiguous'],
  ['the key in another case', `${contract(good)}\n<!-- Scope-Contract: x -->`, 'scope_contract_ambiguous'],
  ['an indented contract line only', `  ${contract(good)}`, 'scope_contract_ambiguous'],
  ['a contract in backticks only', `\`${contract(good)}\``, 'scope_contract_ambiguous'],
  ['a list item contract only', `- ${contract(good)}`, 'scope_contract_ambiguous'],
  ['a BOM before the key', `${BOM}${contract(good)}`, 'scope_contract_ambiguous'],
  ['a space after the colon', contract(good).replace('{', ' {'), 'scope_contract_noncanonical'],
  ['whitespace inside the JSON', contract(good).replace('"v":1', '"v": 1'), 'scope_contract_noncanonical'],
  ['keys out of order', raw('{"mode":"manual","v":1,"dag":null,"planned":["src/a.ts"],"supporting":[]}'), 'scope_contract_noncanonical'],
  ['an extra key', raw('{"v":1,"mode":"manual","dag":null,"planned":["src/a.ts"],"supporting":[],"x":1}'), 'scope_contract_noncanonical'],
  ['a missing key', raw('{"v":1,"mode":"manual","dag":null,"planned":["src/a.ts"]}'), 'scope_contract_noncanonical'],
  ['a duplicate key', raw('{"v":1,"v":1,"mode":"manual","dag":null,"planned":["src/a.ts"],"supporting":[]}'), 'scope_contract_noncanonical'],
  ['a unicode escape', raw('{"v":1,"mode":"manual","dag":null,"planned":["src/\\u0061.ts"],"supporting":[]}'), 'scope_contract_noncanonical'],
  ['trailing whitespace', `${contract(good)} `, 'scope_contract_noncanonical'],
  ['not JSON', raw('{v:1}'), 'scope_contract_noncanonical'],
  ['version 2', raw('{"v":2,"mode":"manual","dag":null,"planned":["src/a.ts"],"supporting":[]}'), 'scope_contract_invalid'],
  ['an unknown mode', contract({ ...good, mode: 'auto' }), 'scope_contract_invalid'],
  ['manual with a dag', contract({ ...good, dag: sha('x') }), 'scope_contract_invalid'],
  ['engine without a dag', contract({ ...good, mode: 'engine' }), 'scope_contract_invalid'],
  ['a dot-dot planned entry', contract({ planned: ['src/../api/x.ts'] }), 'scope_contract_invalid'],
  ['a dot planned entry', contract({ planned: ['./src/a.ts'] }), 'scope_contract_invalid'],
  ['an absolute planned entry', contract({ planned: ['/etc/passwd'] }), 'scope_contract_invalid'],
  ['a trailing slash', contract({ planned: ['src/'] }), 'scope_contract_invalid'],
  ['a backslash', contract({ planned: ['src\\a.ts'] }), 'scope_contract_invalid'],
  ['a glob in manual mode', contract({ planned: ['src/*.ts'] }), 'scope_contract_invalid'],
  ['an empty manual planned list', contract({ planned: [] }), 'scope_contract_invalid'],
  ['a duplicate planned entry', contract({ planned: ['src/a.ts', 'src/a.ts'] }), 'scope_contract_invalid'],
  ['a supporting entry outside the closed class', contract({ planned: ['src/a.ts'], supporting: ['tests2'] }), 'scope_contract_invalid'],
  ['a supporting entry with production code in its name', contract({ planned: ['src/a.ts'], supporting: ['src/api'] }), 'scope_contract_invalid'],
  ['a supporting entry under a forbidden directory', contract({ planned: ['src/a.ts'], supporting: ['.github/tests'] }), 'scope_contract_invalid'],
  ['a supporting entry under node_modules', contract({ planned: ['src/a.ts'], supporting: ['node_modules/x/tests'] }), 'scope_contract_invalid'],
  ['a supporting glob', contract({ planned: ['src/a.ts'], supporting: ['*/tests'] }), 'scope_contract_invalid'],
  ['supporting inside planned', contract({ planned: ['src'], supporting: ['src/tests'] }), 'supporting_overlaps_planned'],
  ['planned inside supporting', contract({ planned: ['tests/helpers.ts'], supporting: ['tests'] }), 'supporting_overlaps_planned'],
  // review repair: a contract line the rendered plan may hide (raw comment span, fence under either tracker)
  ['a contract inside a comment span (Codex)', `${TABLE}\n\n<!--\n${contract(good)}\n-->`, 'scope_contract_hidden'],
  ['a contract after an unterminated comment', `<!-- note\n\n${contract(good)}`, 'scope_contract_hidden'],
  ['a contract after a comment opened mid-line', `text <!-- hidden\n${contract(good)}\nend -->`, 'scope_contract_hidden'],
  ['a contract inside a backtick fence', `\`\`\`\n${contract(good)}\n\`\`\``, 'scope_contract_hidden'],
  ['a contract inside a tilde fence', `~~~\n${contract(good)}\n~~~`, 'scope_contract_hidden'],
  ['a 4-backtick fence closed by 3 backticks (trackers disagree)', `\`\`\`\`\n\`\`\`\n${contract(good)}\n\`\`\`\``, 'scope_contract_hidden'],
  ['a list-contained fence', `- step\n  \`\`\`\n${contract(good)}\n  \`\`\``, 'scope_contract_hidden'],
  ['a deeply indented list fence (naive tracker only)', `- step\n    - sub\n        \`\`\`\n${contract(good)}\n        \`\`\``, 'scope_contract_hidden'],
  ['an unterminated fence before the contract', `\`\`\`js\ncode\n\n${contract(good)}`, 'scope_contract_hidden'],
]) {
  test(`refused, exit 2, no record: ${name}`, (t) => {
    const r = repo(t);
    writePlan(r, body);
    r.write('src/a.ts');
    const out = run(r);
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stderr, new RegExp(code));
    assert.equal(existsSync(defaultOut(r)), false);
  });
}

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

test('benign plans stay valid: closed fences and comments elsewhere, CRLF line ends', () => {
  const body = `<!-- a note -->\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n\`\`\`\`md\n\`\`\`\ninner\n\`\`\`\n\`\`\`\`\n~~~\nt\n~~~\n\n${contract(good)}\n\n\`\`\`\nafter\n\`\`\``;
  assert.doesNotThrow(() => S.parseContract(planText(body)));
  assert.doesNotThrow(() => S.parseContract(planText(contract(good)).replace(/\n/g, '\r\n')), 'CRLF: one trailing CR before LF is stripped');
});

// ------------------------------------------------------------------ review repair 2: the hidden-contract class closed by refusal

const C = contract(good);
const hiddenCases = [
  ['script', `<script>\n\n${C}\n\n</script>`], ['style', `<style>\n\n${C}\n\n</style>`], ['template', `<template>\n\n${C}\n\n</template>`],
  ['template without blank lines', `<template>\n${C}\n</template>`], ['noscript', `<noscript>\n\n${C}\n\n</noscript>`],
  ['details', `<details>\n\n${C}\n\n</details>`], ['details with summary', `<details><summary>x</summary>\n\n${C}\n\n</details>`],
  ['div hidden', `<div hidden>\n\n${C}\n\n</div>`], ['mid-line div hidden', `text <div hidden>\n\n${C}\n\n</div>`],
  ['CDATA', `<![CDATA[\n\n${C}\n\n]]>`], ['processing instruction', `<?x\n\n${C}\n\n?>`], ['declaration', `<!X\n\n${C}\n\n>`],
  ['multi-line img alt', `<img alt="\n\n${C}\n\n">`], ['multi-line iframe srcdoc', `text <iframe srcdoc="\n\n${C}\n\n">`],
  ['a style after the line', `${C}\n\n<style>p{display:none}</style>`], ['a placeholder tag before the line', `<TICKET> placeholder\n\n${C}`],
  ['a mid-line placeholder tag', `Plan for <TICKET>\n\n${C}`], ['an unterminated tag opening', `a <unterminated\n\n${C}`],
  ['an autolink-like tag', `see <https://example.invalid>\n\n${C}`], ['a closing tag', `</div>\n\n${C}`],
  ['no blank line before', `intro\n${C}`], ['no blank line after', `${C}\nafter`],
  ['a comment open inside the JSON (Codex)', 'scope-contract: {"v":1,"mode":"manual","dag":null,"planned":["src/a.ts<!--","src","x-->"],"supporting":[]}'],
  ['an entity inside the line', contract({ planned: ['src/&#60;!--'] })], ['a named entity inside the line', contract({ planned: ['src/&lt;x'] })],
  ['a > inside the line', contract({ planned: ['src/a>b'] })],
  ['an unbalanced single-line backtick before a tag', `\` <div hidden> \`\`\n\n${C}`],
  ['a tag where the fence trackers disagree (after the line)', `${C}\n\n\`\`\`\`\n\`\`\`\n<style>p{display:none}</style>\n\`\`\`\``],
];
for (const [name, body] of hiddenCases) {
  test(`hidden-contract refusal (scope_contract_hidden): ${name}`, () => {
    assert.throws(() => S.parseContract(planText(body)), (e) => e.exit === 2 && e.code === 'scope_contract_hidden', name);
  });
}

test('entry charset: backtick, pipe, quote and non-ASCII are refused in both modes; engine glob characters stay allowed', () => {
  for (const mode of ['manual', 'engine']) {
    for (const bad of ['src/a`b', 'src/a|b', 'src/a"b', 'src/café.ts', 'src/a b']) {
      assert.throws(() => S.validateContract({ v: 1, mode, dag: mode === 'engine' ? sha('d') : null, planned: [bad], supporting: [] }), (e) => e.code === 'scope_contract_invalid', `${mode} ${bad}`);
    }
  }
  assert.doesNotThrow(() => S.validateContract({ v: 1, mode: 'engine', dag: sha('d'), planned: ['apps/**/[id]/{a}/*.ts', 'x?y'], supporting: [] }));
});

test('benign plans stay valid: balanced comments, the template metadata comment, the security-plan comment, <br> in tables, HTML in closed fences, backticked tags, entities, comparisons', () => {
  const ok = [
    `<!-- a note -->\n\n${C}`,
    `<!-- the YAML header above this body carries:\n     run_id: <opaque ID>\n     design_ref: <SHA>  -->\n\n**Shape:** BE\n\n${C}`,
    `<!-- security-plan: {"v":1} -->\n\n${C}`,
    `| a | b<br>c |\n|---|---|\n| x | y<br/>z<BR /> |\n\n${C}`,
    `\`\`\`html\n<div hidden>\n<script>x</script>\n\`\`\`\n\n${C}\n\n~~~html\n<style>p{}</style>\n~~~`,
    `Plan for \`<TICKET>\` and \`\`<a \` b>\`\`\n\n${C}`,
    `x &lt;div&gt; &amp; y\n\n${C}`,
    `x <= 5 and a < b, 3<4\n\n${C}`,
  ];
  for (const body of ok) assert.doesNotThrow(() => S.parseContract(planText(body)), body);
});

test('Codex JSON-string example end to end: the line is refused, never CLEAN', (t) => {
  const r = repo(t);
  writePlan(r, 'scope-contract: {"v":1,"mode":"manual","dag":null,"planned":["src/a.ts<!--","src","x-->"],"supporting":[]}');
  r.write('src/evil.mjs');
  const out = run(r);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /scope_contract_hidden/);
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

test('a lone CR or a NUL never produce an accepted declaration (CRLF line ends are accepted)', () => {
  const ok = planText(contract(good));
  assert.doesNotThrow(() => S.parseContract(ok));
  for (const bad of [ok.replace(contract(good), `\r${contract(good)}`), ok.replace(contract(good), `${contract(good).replace('"v":1,', '"v":1,\r')}`), ok.replace(`${contract(good)}\n`, `${contract(good)}\r\r\n`), ok.replace('"v":1', `"v":1${NUL}`)]) {
    assert.throws(() => S.parseContract(bad), (e) => e.exit === 2);
  }
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

test('the contract helper prints the canonical line that check accepts', (t) => {
  const r = repo(t);
  const d = dagFile(r, [['src/b', 'src/a']]);
  const p = spawnSync(process.execPath, [SCRIPT, 'contract', '--mode', 'engine', '--dag', d.file, '--supporting', 'tests', '--supporting', 'docs'], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, `${contract({ mode: 'engine', dag: d.digest, planned: ['src/a', 'src/b'], supporting: ['docs', 'tests'] })}\n`);
  const m = spawnSync(process.execPath, [SCRIPT, 'contract', '--mode', 'manual', '--planned', 'src/x', '--planned', 'src/a'], { encoding: 'utf8' });
  assert.equal(m.stdout, `${contract({ planned: ['src/a', 'src/x'] })}\n`);
  const bad = spawnSync(process.execPath, [SCRIPT, 'contract', '--mode', 'manual', '--planned', 'src/*.ts'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  writePlan(r, p.stdout.trim());
  r.write('src/a/x.ts');
  assert.equal(run(r, ['--dag', d.file]).status, 0);
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

test('property: a mutated declaration is refused or classifies exactly as the canonical contract (never CLEAN where it says MATERIAL)', (t) => {
  const C = { v: 1, mode: 'manual', dag: null, planned: ['src/checkout/page.tsx', 'src/checkout'], supporting: ['tests', 'docs'] };
  const line = `scope-contract: ${JSON.stringify(C)}`;
  const files = ['src/checkout/page.tsx', 'src/checkout/x.ts', 'tests/a.test.ts', 'docs/g.md', 'docs/x.mjs', 'src/api/route.ts', 'package.json', 'tests/l']
    .map((path) => ({ path, kind: path === 'tests/l' ? 'symlink' : 'file' }));
  const classes = (c) => S.classify(files, { mode: c.mode, planned: c.planned, supporting: c.supporting, readlink: () => '../x' }).map((f) => [f.path, f.class]);
  const reference = classes(S.parseContract(planText(line)));
  assert.ok(reference.some(([, c]) => c === 'material'));
  const M = [
    (s) => s.replace('{', ' {'), (s) => s.replace('"v":1', '"v": 1'), (s) => s.replace('{"v":1,', '{"v":1,"v":1,'),
    (s) => s.replace(/}$/, ',"x":1}'), (s) => s.replace(/,"supporting":\[[^\]]*\]/, ''), (s) => s.replace('"v":1', '"v":"1"'),
    (s) => s.replace('"dag":null', '"dag":0'), (s) => s.replace(/"planned":\[[^\]]*\]/, '"planned":"src"'),
    (s) => s.replace('{"v":1,"mode":"manual",', '{"mode":"manual","v":1,'), (s) => s.replace('tests', '\\u0074ests'),
    (s) => s.replace('tests', `t${CYR_E}sts`), (s) => s.replace('"mode"', `"m${CYR_O}de"`), (s) => s.replace('src/checkout"', 'src/../checkout"'),
    (s) => s.replace('src/checkout"', 'src/./checkout"'), (s) => s.replace('"src/checkout"', '"/src/checkout"'), (s) => s.replace('src/checkout"', 'src\\\\checkout"'),
    (s) => s.replace('src/checkout"', 'src/checkout/*"'), (s) => s.replace('src/checkout"', 'src/?heckout"'), (s) => s.replace('"src/checkout"', '""'),
    (s) => s.replace('"docs"', `"${'d'.repeat(300)}"`), (s) => s.replace(/"planned":\[/, `"planned":[${Array.from({ length: 70 }, (_, i) => `"p${i}"`).join(',')},`),
    (s) => s.replace('"tests"', '"src/checkout/tests"'), (s) => s.replace('"docs"', '"documentation"'), (s) => s.replace('"tests"', '"tests/"'),
    (s) => s.replace('"manual"', '"engine"'), (s) => s.replace('"dag":null', `"dag":"${sha('x')}"`),
    (s) => `${s} `, (s) => `${s}\t`, (s) => s.replace('"v":1', `"v":1${NUL}`), (s) => `${BOM}${s}`, (s) => ` ${s}`, (s) => s.replace('scope-contract:', 'Scope-contract:'),
    (s) => s.replace('scope-contract: ', 'scope-contract:'), (s) => s.replace('scope-contract: ', 'scope-contract:  '), (s) => `${s}\r`,
    (s) => `${s}\n${s}`, (s) => `${s}\nsee the scope-contract above`, (s) => `${s}\n\`\`\`\n${s}\n\`\`\``, (s) => `${s}\n<!-- ${s} -->`,
    (s) => `${s}\n- ${s}`, (s) => `${s}\n\`scope-contract\``, (s) => `\r${s}`, (s) => s.replace(/"planned":\[[^\]]*\]/, '"planned":[]'),
    (s) => s.replace('"src/checkout/page.tsx","src/checkout"', '"src/checkout","src/checkout/page.tsx"'), // valid: order is not semantic
    (s) => s.replace('"tests","docs"', '"docs","tests"'), (s) => s.split('"').join("'"), (s) => s.replace('{', '{\n'), (s) => s.slice(0, -1),
    (s) => s.replace('"planned"', '"Planned"'), (s) => s.replace(/"supporting":\[[^\]]*\]/, '"supporting":null'), (s) => s.replace('"v":1', '"v":1.0'),
    (s) => s.replace('"v":1', '"v":true'), (s) => s.replace('page.tsx', 'page.tsx\\n'), (s) => s.replace('page.tsx', `page.tsx${LS}`),
    (s) => s.replace('"src/checkout"', '"src/checkout","src/checkout"'), (s) => s.replace('"tests"', '"node_modules/tests"'),
    (s) => s.replace('"tests"', '"package.json"'), (s) => s.replace('"tests"', '"src/checkout/page.tsx/tests"'),
  ];
  const rand = rng(424242);
  let refused = 0, same = 0;
  for (let i = 0; i < 6000; i++) {
    let body = line;
    const k = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < k; j++) body = M[Math.floor(rand() * M.length)](body);
    const text = planText(rand() < 0.1 ? body.replace(/\n/g, '\r\n') : body);
    let c;
    try { c = S.parseContract(text); } catch (e) { assert.equal(e.exit, 2, String(e.stack)); refused++; continue; }
    assert.deepEqual(classes(c), reference, JSON.stringify(body));
    same++;
  }
  t.diagnostic(`refused ${refused}, same ${same}`);
  assert.ok(refused + same >= 5000 && refused > 3000 && same > 50, `refused ${refused}, same ${same}`);
});

// ------------------------------------------------------------------ separation and wording pins

test('no engine, gate or ship-ready script imports check-pr-scope.mjs, and nothing reads plan_table_drift', () => {
  const runtime = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'check-pr-scope.mjs')
    .concat(readdirSync(join(HERE, 'lib')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => `lib/${f}`));
  assert.deepEqual(runtime.filter((f) => /check-pr-scope|plan_table_drift|scope-contract/.test(readFileSync(join(HERE, f), 'utf8'))), []);
  assert.equal(/plan_table_drift|parseFilesTable|visibleLines|FILES_TOUCHED_HEADER|parseEnvelope/.test(readFileSync(SCRIPT, 'utf8')), false, 'the Markdown table parser is gone');
  for (const f of ['run-engine.mjs', 'engine-gates.mjs', 'gate.mjs', 'ship-ready-check.mjs']) assert.ok(existsSync(join(HERE, f)), f);
});

test('S6 and F11 wording pins', () => {
  const plan = flat(ref('plan.md')), review = flat(ref('review.md')), ship = flat(ref('ship.md'));
  assert.ok(plan.includes('scope-contract: {"v":1,"mode":"<engine|manual>","dag":"<sha256 of the DAG file, or null in manual mode>","planned":[<the DAG writes, or literal paths in manual mode>],"supporting":[<test or docs directories, e.g. "tests">]}'));
  assert.ok(plan.includes('The Files touched column is explanation for the approver and is read by no script; the `scope-contract:` line is the authoritative scope.'));
  assert.ok(!plan.includes('scope-envelope:'));
  assert.ok(plan.includes('| <old consumers · cached clients · deploy order of the changed shared contract> | <regression · data-integrity: a deployed or cached client still sends/expects the previous shape> | <`contract-consumer` test kind against the previous shape (`shared-contract` tag); Integration Contract frontend compatibility> | <PROVE> | <the contract shape or deploy order changes> | <planned> |'));
  assert.ok(plan.includes('When the change touches a shared contract (the Integration Contract is triggered, or the `shared-contract` risk label or test-trigger tag applies), section 3b has a row for old consumers, cached clients and deploy order, or lists it under `Not applicable:` with the reason.'));
  assert.ok(review.includes('run `node scripts/check-pr-scope.mjs check --repo <repo> --ticket <ticket> --run-id <id> --base <base> --plan <plan> [--dag <dag>]` on the candidate'));
  assert.ok(review.includes('Exit 1 (a material path) is a Design Contract expansion: **WAIT_FOR_USER** and re-approve through `ExitPlanMode`.'));
  assert.ok(review.includes('A contract or mode change is a plan change: re-approval through `ExitPlanMode`.'));
  assert.ok(review.includes('An engine-mode contract always needs `--dag`'));
  assert.ok(ship.includes('Rerun `check-pr-scope.mjs check` on the frozen candidate: its `candidate_id` must equal the reviewed ID and its outcome must be `CLEAN`; a stored record is never trusted.'));
  assert.ok(ship.includes('`scope: {outcome, material[], record_sha}`'));
  assert.ok(ship.includes('**Exit 0 is never a commit or freeze permission.**'));
  assert.ok(ship.includes('At SHIP, exit 1 is **WAIT_FOR_USER**'));
  assert.ok(ship.includes('`CLEAN` alone does not establish this line'));
  assert.ok(review.includes('the reviewer reads the raw contract line in the plan and the `contract` field the record prints'));
  assert.ok(plan.includes('Supporting paths are outside the Design Contract'));
  assert.ok(plan.includes('so the `ExitPlanMode` request restates the canonical contract line (the `contract` helper output) as plain text for the owner'));
  assert.ok(review.includes('The `ExitPlanMode` request restated the canonical contract line as plain text'));
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
