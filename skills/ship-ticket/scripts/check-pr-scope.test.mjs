// S6 (F07, F11): check-pr-scope.mjs classifies every candidate path as planned, supporting or material against the
// approved plan, and the F11 3b old-consumers row. Fixtures are temp git repos under os.tmpdir() with an approved START.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync, lstatSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { planNarrativeDigest, under, validateEngineDag, sha } from './engine-dag.mjs';
import { designContract } from './engine-gates.mjs';
import { SCHEMA, normalRel, parseFilesTable, parseEnvelope, classify } from './check-pr-scope.mjs';

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

// ------------------------------------------------------------------ fixtures

function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A temp repo: `base` files committed on main, then branch `work`. Returns helpers. */
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

const TABLE_HEAD = '| ID | Owner | Step (plain words) | Files touched | Depends on | Exclusive resources |\n|---|---|---|---|---|---|';
const row = (cell, id = 'web') => `| ${id} | worker | Build the checkout page | ${cell} | — | none |`;
const table = (...cells) => [TABLE_HEAD, ...cells.map((c, i) => row(c, `n${i}`))].join('\n');

/** Plan text: narrative + RUN-STATE with an approved START over exactly that narrative (plus `events` after it). */
function planText(narrativeBody, { events = [], startOver = {} } = {}) {
  const narrative = `# Plan ${TICKET}\n\n## 2. Execution DAG\n\n${narrativeBody}\n\n`;
  const empty = `${narrative}${B}\n${E}\n`;
  const start = { run_id: RUN, event: 'START', approved_plan_digest: planNarrativeDigest(empty), approved_at: '2026-11-20T10:00:00.000Z', approved_by: 'owner', ...startOver };
  return `${narrative}${B}\n${[start, ...events].map((e) => JSON.stringify(e)).join('\n')}\n${E}\n`;
}

function writePlan(r, body, opts) { r.write(PLAN_REL, planText(body, opts)); return join(r.dir, PLAN_REL); }

const DAG = (writes) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 1000 },
  nodes: writes.map((w, i) => ({ id: `n${i}`, promptFile: '/p', writes: w })) });

function run(r, extra = [], { plan = join(r.dir, PLAN_REL), base = 'main' } = {}) {
  const args = [SCRIPT, 'check', '--repo', r.dir, '--ticket', TICKET, '--run-id', RUN, '--base', base, '--plan', plan, ...extra];
  const p = spawnSync(process.execPath, args, { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(p.stdout); } catch { /* refusals print to stderr */ }
  return { status: p.status, stdout: p.stdout, stderr: p.stderr, json };
}
const byPath = (json) => Object.fromEntries(json.files.map((f) => [f.path, f]));
const defaultOut = (r) => join(r.dir, '.git', 'ai-skills', 'ship-ticket', `${TICKET}.scope.json`);

/** The common checkout-page fixture: plan says the checkout page, its directory, and a tests envelope. */
const CHECKOUT_PLAN = `${table('`src/checkout/page.tsx`', '`src/checkout/`, `tests/checkout/`')}\n\nscope-envelope: tests/checkout/`;

// ------------------------------------------------------------------ class rules

test('planned exact, planned directory, supporting envelope and material (the checkout page vs the orders route)', (t) => {
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
  assert.deepEqual(f['tests/checkout/page.test.tsx'], { path: 'tests/checkout/page.test.tsx', kind: 'file', class: 'supporting', via: 'envelope', flags: [] });
  assert.deepEqual(f['src/api/orders/route.ts'], { path: 'src/api/orders/route.ts', kind: 'file', class: 'material', via: null, flags: [] });
  assert.equal(out.json.schema, SCHEMA);
  assert.equal(out.json.outcome, 'MATERIAL');
  assert.equal(out.json.source, 'plan-table');
  assert.deepEqual(out.json.roots, ['src/checkout', 'src/checkout/page.tsx', 'tests/checkout']);
  assert.deepEqual(out.json.envelope, ['tests/checkout']);
  assert.deepEqual(out.json.counts, { planned: 2, supporting: 1, material: 1, total: 4 });
  assert.equal(out.json.dag_digest, null);
  assert.equal(out.json.ticket, TICKET);
  assert.equal(out.json.run_id, RUN);
  assert.match(out.stdout, /src\/api\/orders\/route\.ts/);
  // the plan file and session-log.md are the pinned exclusions; never in the path set
  r.write('session-log.md');
  const again = run(r);
  assert.ok(!again.json.files.some((x) => x.path === PLAN_REL || x.path === 'session-log.md'));
  // the record on disk is the stdout bytes, in the git dir
  assert.equal(readFileSync(defaultOut(r), 'utf8'), again.stdout);
});

test('a candidate entirely inside the plan exits 0 CLEAN and records the candidate-id of the same base', (t) => {
  const r = repo(t);
  writePlan(r, CHECKOUT_PLAN);
  r.write('src/checkout/page.tsx');
  r.write('tests/checkout/a.test.tsx');
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
  assert.equal(f['src/legacy/x.ts'].class, 'material');
  assert.deepEqual(f['src/legacy/x.ts'].flags, ['deleted']);
  assert.equal(f['src/legacy/x.ts'].kind, 'deleted');
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
  try {
    symlinkSync('../../outside/secret.txt', join(r.dir, 'tests/checkout/link'));
    symlinkSync('page.tsx', join(r.dir, 'tests/checkout/inner'));
  } catch (e) { t.skip(`no symlinks here: ${e.code}`); return; }
  // Windows without symlink rights may create something else; skip on what lstat sees, not on the platform name.
  if (!lstatSync(join(r.dir, 'tests/checkout/link')).isSymbolicLink()) { t.skip('symlink not created as a link'); return; }
  const out = run(r);
  const f = byPath(out.json);
  assert.equal(f['tests/checkout/link'].kind, 'symlink');
  assert.notEqual(f['tests/checkout/link'].class, 'supporting');
  assert.equal(f['tests/checkout/link'].class, 'planned');
  assert.deepEqual(f['tests/checkout/link'].flags, ['symlink', 'symlink_target_outside_contract', 'unlisted_under_directory_write']);
  assert.deepEqual(f['tests/checkout/inner'].flags, ['symlink', 'unlisted_under_directory_write']);
  assert.equal(f['outside/secret.txt'].class, 'material');
});

test('a case alias of a root stays material and is flagged', (t) => {
  const r = repo(t);
  writePlan(r, table('`src/Checkout/`'));
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

test('a deleted file outside the plan is material and flagged deleted', (t) => {
  const r = repo(t, { 'docs/old.md': 'old\n' });
  writePlan(r, CHECKOUT_PLAN);
  r.rm('docs/old.md');
  const out = run(r);
  assert.equal(out.status, 1);
  assert.deepEqual(byPath(out.json)['docs/old.md'], { path: 'docs/old.md', kind: 'deleted', class: 'material', via: null, flags: ['deleted'] });
});

test('a lockfile is never supporting: material at the root, planned with a flag under a fixtures directory write', (t) => {
  const r = repo(t);
  writePlan(r, `${table('`tests/`')}\n\nscope-envelope: tests/fixtures/`);
  r.write('package-lock.json', '{}\n');
  r.write('tests/fixtures/app/package-lock.json', '{}\n');
  r.write('tests/fixtures/app/data.json', '{}\n');
  const f = byPath(run(r).json);
  assert.deepEqual(f['package-lock.json'], { path: 'package-lock.json', kind: 'file', class: 'material', via: null, flags: ['dependency_manifest'] });
  assert.deepEqual(f['tests/fixtures/app/package-lock.json'], { path: 'tests/fixtures/app/package-lock.json', kind: 'file', class: 'planned', via: 'directory', flags: ['dependency_manifest', 'unlisted_under_directory_write'] });
  assert.equal(f['tests/fixtures/app/data.json'].class, 'supporting');
});

test('the classifier: exact before envelope before directory; a line terminator fails closed to material', () => {
  const files = classify([
    { path: 'a/b', kind: 'file' }, { path: 'a/env/x', kind: 'file' }, { path: 'a/env/x', kind: 'submodule' },
    { path: 'a/c', kind: 'file' }, { path: 'a/n\nx', kind: 'file' }, { path: 'z', kind: 'file' },
  ], { roots: ['a', 'a/b'], envelope: ['a/env'], readlink: () => 'x' });
  assert.deepEqual(files.map((f) => [f.class, f.via]), [['planned', 'exact'], ['supporting', 'envelope'], ['planned', 'directory'],
    ['planned', 'directory'], ['material', null], ['material', null]]);
  assert.deepEqual(files[2].flags, ['submodule', 'unlisted_under_directory_write']);
  assert.deepEqual(files[4].flags, ['line_terminator']);
});

// ------------------------------------------------------------------ DAG source

test('with a DAG listed in the plan: roots are the node writes, a zero-writes node adds nothing, and drift is advisory', (t) => {
  const r = repo(t);
  const dag = DAG([['src/checkout', 'tests/checkout'], []]);
  const raw = JSON.stringify(dag);
  const dagFile = join(r.dir, '.git', 'listed.dag.json');
  writeFileSync(dagFile, raw);
  writePlan(r, `${CHECKOUT_PLAN}\n\nDAG digest: ${sha(raw)}`);
  r.write('src/checkout/page.tsx');
  const out = run(r, ['--dag', dagFile]);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.equal(out.json.source, 'dag');
  assert.equal(out.json.dag_digest, sha(raw));
  assert.deepEqual(out.json.roots, ['src/checkout', 'tests/checkout']);
  assert.deepEqual(out.json.plan_table_drift, { only_in_dag: [], only_in_table: ['src/checkout/page.tsx'] });
});

test('a DAG with no writes at all makes every path material', (t) => {
  const r = repo(t);
  const raw = JSON.stringify(DAG([[]]));
  const dagFile = join(r.dir, '.git', 'zero.dag.json');
  writeFileSync(dagFile, raw);
  writePlan(r, `${table('`src/a.ts`')}\n\nDAG ${sha(raw)}`);
  r.write('src/a.ts');
  const out = run(r, ['--dag', dagFile]);
  assert.equal(out.status, 1, out.stderr);
  assert.deepEqual(out.json.roots, []);
  assert.equal(byPath(out.json)['src/a.ts'].class, 'material');
});

test('a DAG bound by exactly one DAG_BOUND of this run passes; an unlisted, unbound DAG exits 2 dag_unbound', (t) => {
  const r = repo(t);
  const raw = JSON.stringify(DAG([['src/checkout', 'tests/checkout']]));
  const dagFile = join(r.dir, '.git', 'bound.dag.json');
  writeFileSync(dagFile, raw);
  writePlan(r, CHECKOUT_PLAN);
  r.write('src/checkout/page.tsx');
  const unbound = run(r, ['--dag', dagFile]);
  assert.equal(unbound.status, 2);
  assert.match(unbound.stderr, /dag_unbound/);
  assert.equal(existsSync(defaultOut(r)), false);
  writePlan(r, CHECKOUT_PLAN, { events: [{ event: 'DAG_BOUND', run_id: RUN, dag_digest: sha(raw) }] });
  const ok = run(r, ['--dag', dagFile]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.plan_table_drift.only_in_table[0], 'src/checkout/page.tsx');
  writeFileSync(dagFile, JSON.stringify(DAG([['src/checkout']])));
  assert.match(run(r, ['--dag', dagFile]).stderr, /dag_unbound/, 'a different DAG is not the bound one');
  writeFileSync(dagFile, raw);
  writePlan(r, CHECKOUT_PLAN, { events: [{ event: 'DAG_BOUND', run_id: 'other', dag_digest: sha(raw) }] });
  assert.match(run(r, ['--dag', dagFile]).stderr, /dag_unbound/, 'a DAG_BOUND of another run does not bind this one');
  writePlan(r, CHECKOUT_PLAN, { events: [{ event: 'DAG_BOUND', run_id: RUN, dag_digest: sha(raw) }, { event: 'DAG_BOUND', run_id: RUN, dag_digest: sha(raw) }] });
  assert.equal(run(r, ['--dag', dagFile]).status, 2, 'two DAG_BOUND events are not exactly one');
  writeFileSync(dagFile, JSON.stringify({ schema: 'nope' }));
  const bad = run(r, ['--dag', dagFile]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /dag_invalid/);
});

// ------------------------------------------------------------------ refusals (exit 2), never a record

/** Codex counterexample: a four-backtick fence whose content holds a three-backtick line and an example table. */
const CODEX_FENCE = ['````md', '```', TABLE_HEAD, row('`src/`', 'example'), '````', '', table('`src/checkout/page.tsx`')].join('\n');

for (const [name, body, code] of [
  ['a placeholder cell', table('<real paths>'), 'plan_list_unparsable'],
  ['a backticked placeholder', table('`<real path>`'), 'plan_list_unparsable'],
  ['bare prose in a cell', table('the checkout page'), 'plan_list_unparsable'],
  ['two Files touched tables', `${table('`src/a.ts`')}\n\n${table('`src/b.ts`')}`, 'plan_list_unparsable'],
  ['no Files touched header', '| ID | Owner | Step |\n|---|---|---|\n| a | w | `src/a.ts` |', 'plan_list_unparsable'],
  ['zero paths', table('—', 'none'), 'plan_list_unparsable'],
  ['a dot-dot cell', table('`src/../api/x.ts`'), 'plan_list_unparsable'],
  ['a dot cell', table('`./src/a.ts`'), 'plan_list_unparsable'],
  ['an absolute cell', table('`/etc/passwd`'), 'plan_list_unparsable'],
  ['an envelope outside the contract', `${table('`src/a.ts`')}\n\nscope-envelope: tests/`, 'envelope_outside_contract'],
  ['a dot-dot envelope', `${table('`tests/`')}\n\nscope-envelope: tests/../src`, 'envelope_outside_contract'],
  ['a placeholder envelope', `${table('`tests/`')}\n\nscope-envelope: <dirs>`, 'envelope_outside_contract'],
  ['a second envelope line', `${table('`tests/`')}\n\nscope-envelope: tests/a/\nscope-envelope: tests/b/`, 'envelope_duplicate'],
  // review repair: m4, Codex-2, M2 (fences and comments)
  ['a mixed prose cell', table('`src/a.ts` plus the orders API'), 'plan_list_unparsable'],
  ['adjacent backticks (one code span, two tokens)', table('`src/``other`'), 'plan_list_unparsable'],
  ['two tokens with no separator', table('`src/a.ts``src/b.ts`'), 'plan_list_unparsable'],
  ['an unmatched backtick', table('`src/a.ts` `src/b.ts'), 'plan_list_unparsable'],
  ['a four-backtick fence holding a three-backtick line', CODEX_FENCE, 'plan_list_unparsable'],
  ['the only Files touched table inside an HTML comment', `<!--\n${table('`src/`')}\n-->`, 'plan_list_unparsable'],
  ['a commented Files touched table beside the real one', `<!-- ${TABLE_HEAD.split('\n')[0]} -->\n\n${table('`src/a.ts`')}`, 'plan_list_unparsable'],
  ['an unterminated HTML comment', `${table('`src/a.ts`')}\n\n<!-- note`, 'plan_list_unparsable'],
  ['an unterminated fence', `${table('`src/a.ts`')}\n\n\`\`\`\ncode`, 'plan_list_unparsable'],
  ['an indented (code block) Files touched table', table('`src/`').split('\n').map((l) => `    ${l}`).join('\n'), 'plan_list_unparsable'],
]) {
  test(`refused, exit 2, no record: ${name}`, (t) => {
    const r = repo(t);
    writePlan(r, body);
    r.write('src/a.ts');
    const out = run(r);
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stderr, new RegExp(code));
    assert.equal(existsSync(defaultOut(r)), false);
    assert.equal(out.json?.outcome, undefined);
  });
}

test('a Files touched table inside a fenced block or the RUN-STATE block is not read', () => {
  // a fenced or commented block without a Files touched header is invisible; one WITH a header fails closed (refusal list)
  const fenced = '````markdown\n```\n| a | b |\n```\n````\n<!-- a comment\nspanning lines -->\n~~~\n| x |\n~~~~\n' + table('`src/a.ts`');
  assert.deepEqual(parseFilesTable(planText(fenced)), ['src/a.ts']);
  assert.deepEqual(parseFilesTable(planText(table('`src/a.ts`,`src/b/`<br>`src/c.ts` `src/d.ts`'))), ['src/a.ts', 'src/b', 'src/c.ts', 'src/d.ts']);
  // a shorter fence line inside a longer fence does not close it (only the same character, at least as long)
  assert.deepEqual(parseEnvelope(planText('````md\n```\nscope-envelope: src/x/\n```\n````\n~~~~\n~~~\nscope-envelope: src/y/\n~~~\n~~~~')), []);
  assert.deepEqual(parseEnvelope(planText(`scope-envelope: src/\n\`\`\`\nscope-envelope: x/\n\`\`\``)), ['src']);
  assert.deepEqual(parseEnvelope(planText('no envelope here')), []);
});

test('an envelope edited after START is an approval mismatch (exit 2, no record)', (t) => {
  const r = repo(t);
  const plan = writePlan(r, `${table('`tests/`', '`src/a.ts`')}\n\nscope-envelope: tests/a/`);
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('scope-envelope: tests/a/', 'scope-envelope: tests/'));
  r.write('src/a.ts');
  const out = run(r);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /approval_mismatch/);
  assert.equal(existsSync(defaultOut(r)), false);
  // a START of another run does not approve this one
  writePlan(r, table('`src/a.ts`'), { startOver: { run_id: 'other' } });
  assert.match(run(r).stderr, /approval_mismatch/);
});

test('input refusals: --base starting with -, unsafe ticket, unknown flag, --out inside the work tree', (t) => {
  const r = repo(t);
  writePlan(r, table('`src/a.ts`'));
  r.write('src/a.ts');
  const dash = run(r, [], { base: '-x' });
  assert.equal(dash.status, 2);
  assert.match(dash.stderr, /refused ref/);
  const p = spawnSync(process.execPath, [SCRIPT, 'check', '--repo', r.dir, '--ticket', '../x', '--run-id', RUN, '--base', 'main', '--plan', join(r.dir, PLAN_REL)], { encoding: 'utf8' });
  assert.equal(p.status, 2);
  assert.equal(run(r, ['--exclude', 'src/a.ts']).status, 2, 'there is no --exclude flag');
  assert.equal(run(r, ['--envelope', 'src/']).status, 2, 'there is no --envelope flag');
  const inside = run(r, ['--out', join(r.dir, 'scope.json')]);
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /out_in_work_tree/);
  assert.equal(existsSync(join(r.dir, 'scope.json')), false);
  const outside = join(dirname(r.dir), `s6-out-${process.pid}.json`);
  t.after(() => rmSync(outside, { force: true }));
  assert.equal(run(r, ['--out', outside]).status, 0);
  assert.equal(JSON.parse(readFileSync(outside, 'utf8')).outcome, 'CLEAN');
});

test('git or candidate-id failure exits 3: an unknown base and a dirty submodule', (t) => {
  const r = repo(t);
  writePlan(r, table('`src/a.ts`', '`vendor/sub`'));
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

// ------------------------------------------------------------------ no-downgrade proof (exit 0 implies the engine contract)

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

test('property: a non-material path always matches the engine Design Contract (designContract + security-plan globRe)', () => {
  const globRe = engineGlobRe();
  const rand = rng(20261122);
  const ALPHA = ['a', 'b', 'A', '.', '*', '?', '[', ']', '(', '$', '\\', '-', ' ', '\n', '\r', '\u2028', '\u2029', 'é'];
  const seg = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ALPHA[Math.floor(rand() * ALPHA.length)]).join('');
  const rel = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, seg).join('/');
  let checked = 0, nonMaterial = 0;
  for (let i = 0; i < 4000; i++) {
    const writes = Array.from({ length: Math.floor(rand() * 4) }, rel).filter((w) => normalRel(w));
    const roots = [...new Set(writes)].sort();
    // nested in a root, or anywhere (classify must stay sound even for an envelope the CLI would refuse)
    const envelope = (roots.length && rand() < 0.5 ? [roots[0] + (rand() < 0.5 ? '' : '/' + seg())] : rand() < 0.5 ? [rel()] : []).filter((e) => normalRel(e));
    const contract = designContract([{ writes }]).map(globRe);
    for (let j = 0; j < 6; j++) {
      const pick = roots.length && rand() < 0.7 ? roots[Math.floor(rand() * roots.length)] : rel();
      const path = rand() < 0.5 ? pick : `${pick}/${rel()}`;
      const kind = ['file', 'symlink', 'deleted', 'submodule'][Math.floor(rand() * 4)];
      const [f] = classify([{ path, kind }], { roots, envelope, readlink: () => '../x' });
      checked++;
      if (f.class === 'material') continue;
      nonMaterial++;
      assert.ok(contract.some((re) => re.test(path)), `non-material ${JSON.stringify(path)} outside the engine contract of ${JSON.stringify(writes)}`);
    }
  }
  assert.ok(checked === 24000 && nonMaterial > 2500, `checked ${checked}, non-material ${nonMaterial}`);
});

test('raw under() alone does not imply the engine contract for a path with a line terminator (why the classifier fails closed)', () => {
  const globRe = engineGlobRe();
  for (const c of ['\n', '\r', '\u2028', '\u2029']) {
    const p = `src/a${c}b`;
    assert.equal(under(p, ['src']), true);
    assert.equal(designContract([{ writes: ['src'] }]).map(globRe).some((re) => re.test(p)), false, JSON.stringify(c));
    assert.equal(classify([{ path: p, kind: 'file' }], { roots: ['src'], envelope: [], readlink: () => '' })[0].class, 'material');
  }
});

test('normalRel parity: the local copy accepts exactly the writes validateEngineDag accepts', () => {
  for (const w of ['src/a.ts', 'src', 'a b/c', 'src/', './src', 'src/../x', '/abs', 'a//b', 'a\\b', '.', '..', 'src/.', '']) {
    let engine = true;
    try { validateEngineDag(DAG([[w]]), { ticket: TICKET }); } catch { engine = false; }
    assert.equal(normalRel(w), engine, JSON.stringify(w));
  }
});

test('no engine, gate or ship-ready script imports check-pr-scope.mjs', () => {
  const hits = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'check-pr-scope.mjs')
    .concat(readdirSync(join(HERE, 'lib')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => `lib/${f}`))
    .filter((f) => /check-pr-scope/.test(readFileSync(join(HERE, f), 'utf8')));
  assert.deepEqual(hits, []);
  for (const f of ['run-engine.mjs', 'engine-gates.mjs', 'gate.mjs', 'ship-ready-check.mjs']) assert.ok(existsSync(join(HERE, f)), f);
});

// ------------------------------------------------------------------ wording pins (S6, F11): sentences added, none reworded

test('S6 and F11 wording pins', () => {
  const plan = flat(ref('plan.md')), review = flat(ref('review.md')), ship = flat(ref('ship.md'));
  assert.ok(plan.includes('scope-envelope: <optional: comma-separated directories under a Files touched directory'));
  assert.ok(plan.includes('| <old consumers · cached clients · deploy order of the changed shared contract> | <regression · data-integrity: a deployed or cached client still sends/expects the previous shape> | <`contract-consumer` test kind against the previous shape (`shared-contract` tag); Integration Contract frontend compatibility> | <PROVE> | <the contract shape or deploy order changes> | <planned> |'));
  assert.ok(plan.includes('When the change touches a shared contract (the Integration Contract is triggered, or the `shared-contract` risk label or test-trigger tag applies), section 3b has a row for old consumers, cached clients and deploy order, or lists it under `Not applicable:` with the reason.'));
  assert.ok(review.includes('run `node scripts/check-pr-scope.mjs check --repo <repo> --ticket <ticket> --run-id <id> --base <base> --plan <plan> [--dag <dag>]` on the candidate'));
  assert.ok(review.includes('Exit 1 (a material path) is a Design Contract expansion: **WAIT_FOR_USER** and re-approve through `ExitPlanMode`.'));
  assert.ok(review.includes('An engine run must pass `--dag`'));
  assert.ok(review.includes('the remedy is re-approval through `ExitPlanMode`, since an edited plan changes the digest and gives `approval_mismatch`'));
  assert.ok(ship.includes('Use the run\'s base as `--base` and, on an engine run, the bound DAG as `--dag`.'));
  assert.ok(ship.includes('At SHIP, exit 1 is **WAIT_FOR_USER**'));
  assert.ok(plan.includes('| contract | orchestrator | Materialize the approved contract artifact | `<real path>` |'));
  assert.ok(plan.includes('e.g. scope-envelope: tests/checkout/, docs/checkout/ (no backticks)'));
  assert.ok(plan.includes('<Files touched cells: backticked repository paths only'));
  assert.ok(ship.includes('Rerun `check-pr-scope.mjs check` on the frozen candidate: its `candidate_id` must equal the reviewed ID and its outcome must be `CLEAN`; a stored record is never trusted.'));
  assert.ok(ship.includes('`scope: {outcome, material[], record_sha}`'));
  assert.ok(ship.includes('**Exit 0 is never a commit or freeze permission.**'));
  // the pinned 3b header row stays as it was
  assert.ok(plan.includes('| Component / flow / dependency touched | Risk (technical · security · business · data-integrity · regression) | Check that covers it (test type, security control id, review skill or gate) | Runs when | Re-runs when | Status |'));
  for (const t of [plan, review, ship]) assert.ok(!/\bspecialists?\b/i.test(t));
});

test('the record hash: stdout bytes equal the written record', (t) => {
  const r = repo(t);
  writePlan(r, table('`src/a.ts`'));
  r.write('src/a.ts');
  const out = run(r);
  assert.equal(out.status, 0, out.stderr);
  const h = (s) => createHash('sha256').update(s).digest('hex');
  assert.equal(h(readFileSync(defaultOut(r))), h(out.stdout));
  unlinkSync(defaultOut(r));
});

// ------------------------------------------------------------------ review repair: dag_required (M1), under-exclusion paths (M3)

test('a run bound to a DAG cannot be checked against the plan table alone: dag_required (exit 2)', (t) => {
  const r = repo(t);
  const raw = JSON.stringify(DAG([['src/a.ts']]));
  const dagFile = join(r.dir, '.git', 'm1.dag.json');
  writeFileSync(dagFile, raw);
  writePlan(r, table('`src/`'), { events: [{ event: 'DAG_BOUND', run_id: RUN, dag_digest: sha(raw) }] });
  r.write('src/a.ts');
  r.write('src/b.ts');
  const without = run(r);
  assert.equal(without.status, 2, without.stdout + without.stderr);
  assert.match(without.stderr, /dag_required/);
  assert.equal(existsSync(defaultOut(r)), false);
  const withDag = run(r, ['--dag', dagFile]);
  assert.equal(withDag.status, 1, withDag.stderr);
  assert.equal(byPath(withDag.json)['src/b.ts'].class, 'material');
  // a DAG digest listed in the narrative also requires --dag
  writePlan(r, `${table('`src/`')}\n\nDAG digest: ${sha(raw)}`);
  assert.match(run(r).stderr, /dag_required/);
  // so does an engine state file for the ticket
  writePlan(r, table('`src/`'));
  assert.equal(run(r).status, 0, 'manual flow: no DAG_BOUND, no listed DAG, no engine state');
  mkdirSync(dirname(join(r.dir, '.git', 'ai-skills', 'ship-ticket', `${TICKET}.state.json`)), { recursive: true });
  writeFileSync(join(r.dir, '.git', 'ai-skills', 'ship-ticket', `${TICKET}.state.json`), '{}\n');
  assert.match(run(r).stderr, /dag_required/);
});

test('a path strictly under an exclusion FILE entry is material (under_exclusion_file), outside the candidate-id set', (t) => {
  const r = repo(t);
  const plan = join(r.dir, '.git', 'plan-elsewhere.md');
  writeFileSync(plan, planText(table('`src/a.ts`')));
  r.write('src/a.ts');
  r.write('session-log.md/evil.mjs');
  r.write(`${PLAN_REL}/x.mjs`);
  const out = run(r, [], { plan });
  assert.equal(out.status, 1, out.stdout + out.stderr);
  const f = byPath(out.json);
  assert.deepEqual(f['session-log.md/evil.mjs'], { path: 'session-log.md/evil.mjs', kind: 'file', class: 'material', via: null, flags: ['under_exclusion_file'] });
  assert.equal(f[`${PLAN_REL}/x.mjs`].class, 'material');
  assert.deepEqual(f[`${PLAN_REL}/x.mjs`].flags, ['under_exclusion_file']);
  // committed on the branch too, not only untracked
  r.git(['add', '-A']); r.git(['commit', '-q', '-m', 'hide']);
  assert.equal(run(r, [], { plan }).status, 1);
  // the exact exclusion files themselves stay excluded
  const ok = repo(t);
  writePlan(ok, table('`src/a.ts`'));
  ok.write('src/a.ts'); ok.write('session-log.md');
  assert.equal(run(ok).status, 0);
});

