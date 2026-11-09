/**
 * AIS-HARNESS-3 Wave 4 findings from SCRUM-307.
 * Gap 2: a node whose writes/othersOwned sit under .specs/.spec was accepted at init and only
 *   refused at dispatch by the carrier (node_failed, two marks). validateEngineDag now rejects it at
 *   init (dag_invalid); the carrier rule is unchanged.
 * Gap 3: the state, engine log and usage ledger live in the work tree's own git dir, so
 *   `git worktree remove` deleted them. `run-engine.mjs archive` copies them (with a sha256
 *   manifest) to <git common dir>/ai-skills/ship-ticket/archive/<ticket>/<run-id>-<n>/, which a
 *   worktree removal does not touch. Read-only on engine state; owner-invoked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateEngineDag } from './run-engine.mjs';
import { commonGitDir } from './engine-io.mjs';
import { POSIX, fixture } from './engine-test-fixture.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups';
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const sha = (f) => 'sha256:' + createHash('sha256').update(readFileSync(f)).digest('hex');

test('gap 2: a node that writes or co-owns a plan root is dag_invalid at init, not node_failed at dispatch', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  const doc = JSON.parse(readFileSync(fx.dagFile, 'utf8'));
  validateEngineDag(doc, { ticket: 'T-1' }); // control: the fixture DAG is valid
  for (const bad of ['.specs/vapt/evidence.md', '.spec', './.SPECS/x', '.specs\\x', '.specs/plans/../vapt/x']) {
    for (const field of ['writes', 'othersOwned']) {
      const d = structuredClone(doc);
      d.nodes[0][field] = [bad];
      assert.throws(() => validateEngineDag(d, { ticket: 'T-1' }), { code: 'dag_invalid' }, `${field}: ${bad}`);
    }
  }
  const fine = structuredClone(doc);
  fine.nodes[0].writes = ['docs/.specs/x.md', 'src/specs.txt'];
  validateEngineDag(fine, { ticket: 'T-1' }); // only the repo-root .specs/.spec are plan roots
  assert.ok(true);
});

test('gap 3: archive copies state, engine log, usage and a sha256 manifest outside the work tree git dir', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, behaviour: { a: { write: { 'src/a.txt': 'a1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const before = sha(fx.stateFile());
  const r = fx.cli('archive');
  ok(r);
  assert.equal(sha(fx.stateFile()), before, 'archive does not change engine state');
  const base = join(commonGitDir(fx.repo), 'ai-skills', 'ship-ticket', 'archive', 'T-1');
  const dirs = readdirSync(base);
  assert.equal(dirs.length, 1, dirs.join());
  const dir = join(base, dirs[0]);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.ticket, 'T-1');
  assert.equal(manifest.run_id, 'run-1');
  for (const [name, src] of [['state.json', fx.stateFile()], ['engine.jsonl', fx.engineLog()], ['usage.jsonl', fx.usageFile()]]) {
    if (!existsSync(src)) { assert.equal(manifest.files[name], undefined, `${name} absent in the source, absent in the archive`); continue; }
    assert.equal(sha(join(dir, name)), sha(src), name);
    assert.equal(manifest.files[name], sha(src), name);
  }
  assert.ok(manifest.files['state.json'], 'the state file is always archived');
  assert.equal(r.out.archive, dir);
  const again = fx.cli('archive');
  ok(again);
  assert.equal(readdirSync(base).length, 2, 'a second archive never overwrites the first');
});

test('gap 3: archive refuses extra flags and a missing state', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  const none = fx.cli('archive');
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stderr, /no_state|archive_refused/);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const extra = fx.cli('archive', { node: 'a' });
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /archive_refused/);
});

test('gap 3: the archive root is the common git dir, which survives removing a linked worktree', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  const wt = resolve(fx.root, 'linked-wt');
  const g = spawnSync('git', ['worktree', 'add', '-q', '-b', 'wt-branch', wt], { cwd: fx.repo, encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  const common = commonGitDir(wt);
  assert.equal(common, commonGitDir(fx.repo), 'both work trees share one common dir');
  mkdirSync(join(common, 'ai-skills'), { recursive: true });
  writeFileSync(join(common, 'ai-skills', 'probe'), 'x');
  const rm = spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: fx.repo, encoding: 'utf8' });
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(existsSync(join(common, 'ai-skills', 'probe')), 'removing the worktree leaves the common dir intact');
});

test('gap 3 (review): archive is read-only on engine state and refuses another run id', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, behaviour: { a: { write: { 'src/a.txt': 'a1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  // An owner RETRY appended since the last command: any locked command that observes would fold it into state.authority.
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'rx-9', predecessor: 'rx-8' });
  const before = sha(fx.stateFile());
  ok(fx.cli('status')); // control: a read-only command still leaves the file alone
  assert.equal(sha(fx.stateFile()), before);
  ok(fx.cli('archive'));
  assert.equal(sha(fx.stateFile()), before, 'archive left the state file byte-identical');
  const other = fx.cli('archive', {}, { runId: 'run-2' });
  assert.equal(other.status, 1, other.stdout + other.stderr);
  assert.match(other.stderr, /run_mismatch/);
  assert.equal(readdirSync(join(commonGitDir(fx.repo), 'ai-skills', 'ship-ticket', 'archive', 'T-1')).filter(d => d.startsWith('run-2')).length, 0);
});

test('gap 2 (review): malformed writes stay dag_invalid, not an uncoded TypeError', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  const doc = JSON.parse(readFileSync(fx.dagFile, 'utf8'));
  for (const w of [{}, 5, true, 'src/a.txt']) {
    const d = structuredClone(doc);
    d.nodes[0].writes = w;
    assert.throws(() => validateEngineDag(d, { ticket: 'T-1' }), { code: 'dag_invalid' }, JSON.stringify(w));
  }
});

test('CodeRabbit 4513255380: othersOwned must be repository-relative and normalized, like writes (dag_invalid at init)', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true });
  const doc = JSON.parse(readFileSync(fx.dagFile, 'utf8'));
  for (const p of ['../.specs/x', '/abs/.specs', '/abs/other', '../outside', 'C:\\x', 'a//b', 'a/./b', '']) {
    const d = structuredClone(doc);
    d.nodes[0].othersOwned = [p];
    assert.throws(() => validateEngineDag(d, { ticket: 'T-1' }), { code: 'dag_invalid', message: /repository-relative and normalized/ }, JSON.stringify(p));
  }
  const ok2 = structuredClone(doc);
  ok2.nodes[0].othersOwned = ['docs/other.md', 'a:assets']; // a legal POSIX directory name the carrier accepts
  validateEngineDag(ok2, { ticket: 'T-1' });
});

test('CodeRabbit 4513255398: a failed archive leaves no numbered directory behind', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, behaviour: { a: { write: { 'src/a.txt': 'a1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  // A directory where usage.jsonl should be makes the copy fail midway (EISDIR), after state.json was copied.
  mkdirSync(fx.usageFile(), { recursive: true });
  const r = fx.cli('archive');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const base = join(commonGitDir(fx.repo), 'ai-skills', 'ship-ticket', 'archive', 'T-1');
  const left = existsSync(base) ? readdirSync(base) : [];
  assert.deepEqual(left, [], `no partial archive or staging directory remains: ${left}`);
});
