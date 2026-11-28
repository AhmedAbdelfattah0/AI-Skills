/**
 * PR-4b (STAB S3-min, P4) base and candidate succession (engine-succession.mjs), driven through the REAL engine CLI on a temp
 * repository with a bare `origin` (engine-test-fixture.mjs withOrigin). No network, no Docker. C2 SAFE DEFAULT (a): every
 * generation that follows a review gets ONE generation-authorized fresh full review; there is no assessment and no retention.
 * The §8 P4 negatives and §14.4 #7:
 *
 *   P4-1  base move after the freeze -> in-run generation (policy twin 417), RED renewed in a worktree of the new base (parser 2
 *         recorded), a generation-authorized fresh review (no RETRY written), the proof re-run, SHIP_READY; 0 restarts; the
 *         predecessor head retained by a run-private ref
 *   P4-2  the undeclared-RLS-helper falsifier: no declared path overlaps, and still a full re-review is demanded; no
 *         assessment input exists, so an empty intersection can never PASS
 *   P4-4  chmod without a record -> refused; with a kind mode record -> a recorded generation
 *   P4-5  a corrected spec after BUILD -> RED renewed on the base, no hand revert
 *   P4-6  the 348 shape (a real node assert-diff elision) earns RED inside a succession run, parser 2 named in the evidence
 *   P4-7  overlay and environment: a candidate-changed helper -> refused; a new client file -> Blocked without a designed
 *         harness; no checkout node_modules ancestor; no declared environment -> red_baseline_missing (Blocked); a declared
 *         setup prepares the base worktree (base dependencies, never the checkout's), a failing setup refuses
 *   P4-8  crash at each point of the transition: exactly one authoritative generation; --prepare retains the pre-rebase head
 *   P4-9  two unsuccessful rounds -> a further review-opening generation needs an RCA record (no review-reset loophole)
 *   P4-10 guards: a run without the flag keeps its frozen route, wording and refusals; DAG validation; the policy twin
 *   P4-11 units: two consecutive base moves rebind unit evidence; re-checks spend no ceiling and count no storm
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { POSIX, fixture, withOrigin, passReview, failReview, confirmReview } from './engine-test-fixture.mjs';
import { validateEngineDag } from './engine-dag.mjs';

const SKIP = POSIX ? false : 'POSIX process groups (Windows quiescence is unknown)';
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));
const engine = () => import('./run-engine.mjs');
const PIN = { base: 'main', pinnedBase: { remote: 'origin' } };
const SUCCESSION = { ...PIN, succession: { version: 1 }, redEnvironment: { setup: [] } };
const TAP = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/red.test.mjs'], format: 'tap' };
const PASS = { cmd: process.execPath, args: ['-e', ''] };
const digestOf = (b) => 'sha256:' + createHash('sha256').update(b).digest('hex');

/** The spec: a deepStrictEqual over 30 rows, so node's assert diff elides lines with a 4-space `...` (the 348 shape). */
const spec = (extra = '', from = '../src/impl.mjs') => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '${from}';\n${extra}`
  + "const rows = (v) => Array.from({ length: 30 }, (_, i) => ({ i, label: 'row ' + i, v: i === 29 ? v : 0 }));\n"
  + "test('fails on assertion', () => { assert.deepStrictEqual(rows(value()), rows(2)); });\n";
const IMPL_V1 = 'export const value = () => 1;\n', IMPL_V2 = 'export const value = () => 2;\n';

/**
 * A pinned run on a repo with origin: the base commit carries src/impl.mjs v1; node r writes the RED spec, node impl (after r)
 * writes v2. `config` replaces the run config (SUCCESSION by default). Returns { fx, o }.
 */
function run(t, { config = SUCCESSION, nodes, behaviour, base = { 'src/impl.mjs': IMPL_V1 }, testCommands = { unit: TAP } } = {}) {
  const fx = fixture(t, { config: { width: 1, testCommands, ...config },
    nodes: nodes ?? [{ id: 'r', writes: ['spec/red.test.mjs'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] },
      { id: 'impl', deps: ['r'], reads: ['docs/in.txt'], writes: ['src/impl.mjs'] }],
    behaviour: behaviour ?? { r: { write: { 'spec/red.test.mjs': spec() } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } } } });
  for (const [p, c] of Object.entries(base)) { mkdirSync(join(fx.repo, dirname(p)), { recursive: true }); writeFileSync(join(fx.repo, p), c); }
  const o = withOrigin(fx);
  o.feature();
  return { fx, o };
}
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, `want ${code}: ${r.stdout}${r.stderr}`); assert.equal(r.out?.code, code, r.stdout); return r; };
const durableFile = (fx) => join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'state.json');
const stateOf = (fx, durable = true) => JSON.parse(readFileSync(durable ? durableFile(fx) : fx.stateFile(), 'utf8'));
const candidate = (fx, S) => {
  const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', fx.repo, '--base', S.base.merge_base, '--exclude', '.specs/plans/T-1.md', '--exclude', 'session-log.md'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).candidate_id;
};
const succeed = (fx, input, flags = {}) => {
  if (input === undefined) return fx.cli('succeed', flags);
  const file = join(fx.root, `succeed-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(input));
  return fx.cli('succeed', { input: file, ...flags });
};
/** The registered worktrees of the fixture repo (the RED base worktree is removed on every exit path). */
const worktrees = (o) => o.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length;
/** init, drive r, RED (on the base worktree), drive impl, original PASS review, ship-ready. */
function shipped(fx, durable = true) {
  ok(fx.cli('init', { dag: fx.dagFile }), 'init');
  ok(fx.cli('drive'), 'drive r');
  ok(fx.gate('red', { node: 'r', command: 'unit' }), 'RED');
  const d = fx.cli('drive');
  ok(d, 'drive impl');
  assert.equal(d.out.outcome, 'done', JSON.stringify(d.out));
  ok(fx.gate('review', passReview('rx1', candidate(fx, stateOf(fx, durable)))), 'review');
  const s = fx.gate('ship-ready', {});
  ok(s, 'ship-ready');
  assert.equal(s.out.code, 'ship_ready', s.stdout);
  return stateOf(fx, durable);
}
/** Commit the ticket work, push `files` to origin as another developer would, fetch and rebase the ticket branch onto it. */
function baseMoves(fx, o, files, { commit = true } = {}) {
  if (commit) { o.git('add', '-A'); o.git('commit', '-q', '--allow-empty', '-m', 'ticket work'); }
  const up = join(fx.root, 'upstream');
  const git = (...a) => { const r = spawnSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@example.com', ...a], { cwd: up, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('pull', '-q', 'origin', 'main');
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(up, dirname(p)), { recursive: true }); writeFileSync(join(up, p), c); }
  git('add', '-A'); git('commit', '-q', '-m', 'predecessor merged'); git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  o.fetch();
  o.pre = o.sha('HEAD'); // the ticket tip the rebase rewrites
  o.git('rebase', '-q', 'origin/main');
  return o.sha('origin/main');
}
const RLS_HELPER = { 'supabase/migrations/0042_rls_helper.sql': 'create or replace function auth_can_read(uid uuid) returns boolean\n'
  + 'language sql security definer as $$ select false $$;\nrevoke select on public.footer from anon;\n' };

// ---------------------------------------------------------------------------

test('P4-1 base move after the freeze: in-run generation, RED renewed on the new base, generation-authorized review, proof re-run; 0 restarts', { skip: SKIP }, (t) => {
  const { fx, o } = run(t);
  const before = shipped(fx);
  assert.equal(before.policy_version, 417, 'a succession run records the succession twin of the pinned durable row (17 + 400)');
  assert.equal(before.gates.red.r.parser, 2, 'the RED evidence names the parser that read it');
  assert.equal(before.gates.red.r.base_tree.commit, before.base.merge_base, 'RED ran in a worktree of the approved base, not on the candidate');
  assert.equal(worktrees(o), 1, 'the RED base worktree is removed after RED');
  const newTip = baseMoves(fx, o, { 'upstream/f1.txt': 'merged predecessor\n' });
  refused(fx.gate('ship-ready', {}), 'candidate_mismatch'); // the candidate against the OLD pin now carries the base delta
  const p = succeed(fx, undefined, { plan: 'true' });
  ok(p, 'plan');
  assert.deepEqual([p.out.transition.kind, p.out.transition.base_moved, p.out.transition.review_required], ['base', true, true]);
  const g = succeed(fx, { kind: 'base', reason: 'predecessor merged; ticket branch rebased' });
  ok(g, 'succeed');
  assert.equal(g.out.code, 'generation_recorded');
  let S = stateOf(fx);
  assert.equal(S.run_id, 'run-1', 'same run');
  assert.equal(S.base.sha, newTip);
  assert.equal(S.base.merge_base, newTip);
  const gen = S.succession.generations[0];
  assert.deepEqual({ g: gen.g, kind: gen.kind, old: gen.old.base, new: gen.new.base }, { g: 1, kind: 'base', old: before.base.merge_base, new: newTip });
  assert.deepEqual(gen.delta.base.map(e => [e.status, e.path]), [['A', 'upstream/f1.txt']]);
  assert.equal(gen.review_required, true, 'C2 (a): a full fresh review');
  assert.equal('retention' in gen, false, 'no retention field exists');
  assert.deepEqual(gen.invalidated.red, ['r']);
  assert.notEqual(o.gitRaw('merge-base', '--is-ancestor', o.pre, 'HEAD').status, 0, 'the rebase rewrote the ticket commit');
  assert.deepEqual([gen.git.old_head, gen.git.old_head_source, gen.git.preserved], [o.pre, 'orig_head', true], 'without --prepare, the rewritten tip (ORIG_HEAD) is found');
  assert.equal(o.sha(gen.git.retained_ref), o.pre, 'the rewritten predecessor commit is retained by a run-private ref');
  assert.equal(o.gitRaw('merge-base', '--is-ancestor', before.succession.head, gen.git.retained_ref).status, 0, 'it descends from the head recorded at the freeze');
  assert.equal(gen.git.new_head, o.sha('HEAD'));
  assert.equal(S.succession.transition, undefined, 'the transition record is gone in the same commit');
  assert.equal(S.local_proof, null);
  assert.equal(S.ship_ready, undefined);
  assert.equal(S.gates.red.r, undefined, 'the predecessor RED no longer binds');
  refused(fx.gate('ship-ready', {}), 'red_renewal_pending');
  // RED renewed in-run on the NEW base (its src/impl.mjs is still v1): accepted with no hand revert of the implementation
  ok(fx.gate('red', { node: 'r', command: 'unit' }), 'RED renewal');
  S = stateOf(fx);
  assert.equal(S.gates.red.r.base_commit, newTip);
  assert.equal(S.gates.red.r.base_tree.commit, newTip);
  assert.equal(S.succession.generations[0].renewed.red.r, S.gates.red.r.attempt_id);
  assert.equal(readFileSync(join(fx.repo, 'src', 'impl.mjs'), 'utf8'), IMPL_V2, 'the work tree keeps the implementation');
  refused(fx.gate('ship-ready', {}), 'review_generation_stale');
  const cand = candidate(fx, S);
  // a fresh original without the generation still needs an owner RETRY (frozen rule); naming the generation is authorized once
  refused(fx.gate('review', passReview('rx2', cand)), 'retry_unauthorized');
  ok(fx.gate('review', passReview('rx2', cand, { generation: 1 })), 'generation-authorized review');
  refused(fx.gate('review', passReview('rx3', cand, { generation: 1 })), 'retry_unauthorized');
  const ship = fx.gate('ship-ready', {});
  ok(ship, 'ship-ready on the new base');
  assert.equal(ship.out.code, 'ship_ready');
  S = stateOf(fx);
  assert.equal(S.local_proof.base_commit, newTip, 'the proof is bound to the new base');
  assert.equal(S.local_proof.generation, 1);
  assert.equal(S.review_chain.filter(r => r.kind === 'retry').length, 0, 'no RETRY record');
  const planText = readFileSync(fx.planFile, 'utf8');
  assert.equal((planText.match(/"event":"START"/g) ?? []).length, 1, '0 restarts: still the one START');
  assert.ok(!/"event":"RETRY"/.test(planText), 'the engine wrote no RETRY');
  assert.ok(/"event":"GENERATION"/.test(planText), 'the generation is reported in RUN-STATE');
  assert.ok(/"event":"SHIP_READY","event_id":"ship-ready-[^"]+-g1"[^\n]*"generation":1/.test(planText), 'each generation has its own SHIP_READY');
});

test('P4-2 the undeclared RLS-helper falsifier: no declared path overlaps and a full in-run re-review is still demanded (no empty-intersection PASS)', { skip: SKIP }, (t) => {
  const { fx, o } = run(t);
  shipped(fx);
  baseMoves(fx, o, RLS_HELPER);
  const p = succeed(fx, undefined, { plan: 'true' });
  ok(p, 'plan');
  assert.deepEqual(p.out.transition.base_delta, [{ path: 'supabase/migrations/0042_rls_helper.sql', status: 'A' }], 'the actual delta, not a declared-path intersection');
  // there is no assessment path at all: retention cannot be asked for
  refused(succeed(fx, { kind: 'base', reason: 'rebase', assessment: { brief_digest: 'x', assessors: [] } }), 'bad_input');
  assert.equal(stateOf(fx).succession.g, 0, 'a refused record installs no generation');
  const g = succeed(fx, { kind: 'base', reason: 'rebase' });
  ok(g);
  assert.equal(g.out.generation.review_required, true);
  ok(fx.gate('red', { node: 'r', command: 'unit' }), 'RED renewed');
  refused(fx.gate('ship-ready', {}), 'review_generation_stale'); // the old PASS never carries ship across the helper change
});

test('P4-4 chmod after the freeze: no record -> refused; a mode record -> a recorded generation and a fresh review', { skip: SKIP }, (t) => {
  const { fx } = run(t);
  shipped(fx);
  chmodSync(join(fx.repo, 'src', 'impl.mjs'), 0o755);
  refused(succeed(fx, {}), 'succession_record_missing');
  refused(succeed(fx, { kind: 'correction', reason: 'chmod', paths: ['src/impl.mjs'] }), 'succession_record_mismatch');
  refused(succeed(fx, { kind: 'mode', reason: 'chmod', paths: ['src/other.mjs'] }), 'succession_record_mismatch');
  const g = succeed(fx, { kind: 'mode', reason: 'repair worker set the exec bit; recorded instead of an owner RETRY', paths: ['src/impl.mjs'] });
  ok(g);
  const gen = g.out.generation;
  assert.deepEqual(gen.delta.candidate.map(d => [d.path, d.change, d.old.mode, d.new.mode]), [['src/impl.mjs', 'mode', '100644', '100755']]);
  assert.deepEqual(gen.invalidated.red, [], 'the spec bytes are unchanged: RED stays');
  assert.equal(gen.review_required, true);
  const S = stateOf(fx);
  ok(fx.gate('review', passReview('rx2', candidate(fx, S), { generation: 1 })));
  const ship = fx.gate('ship-ready', {});
  ok(ship);
  assert.equal(ship.out.code, 'ship_ready');
});

test('P4-5 a corrected spec after BUILD: a correction generation and RED renewed on the base, with no hand revert', { skip: SKIP }, (t) => {
  const { fx } = run(t);
  shipped(fx);
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), spec('// corrected after BUILD: the expected rows are built the same way\n'));
  refused(succeed(fx, { kind: 'correction', reason: 'spec fix', paths: ['spec/red.test.mjs'], rca: 'x' }), 'bad_input');
  const g = succeed(fx, { kind: 'correction', reason: 'the spec named the wrong rows', paths: ['spec/red.test.mjs'] });
  ok(g);
  assert.deepEqual(g.out.generation.invalidated.red, ['r']);
  ok(fx.gate('red', { node: 'r', command: 'unit' }), 'RED renewed on the base worktree while the implementation stays in the work tree');
  assert.equal(readFileSync(join(fx.repo, 'src', 'impl.mjs'), 'utf8'), IMPL_V2);
  assert.equal(stateOf(fx).gates.red.r.spec_digests['spec/red.test.mjs'], digestOf(readFileSync(join(fx.repo, 'spec', 'red.test.mjs'))));
});

test('P4-6 the 348 shape inside a succession run: the elided assert diff is an assertion (parser 2, named in the evidence), RED accepted', { skip: SKIP }, (t) => {
  const { fx } = run(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }), 'RED');
  const S = stateOf(fx);
  assert.equal(S.gates.red.r.parser, 2);
  const out = readFileSync(join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'runs', 'T-1', 'attempts', `${S.gates.red.r.attempt_id}.out`), 'utf8');
  assert.ok(/\n {4}\.\.\.\n/.test(out) && /Skipped lines/.test(out), 'the runner output carries the 4-space elision line');
});

test('P4-7 overlay rules: a candidate-changed helper is refused', { skip: SKIP }, (t) => {
  const helperSpec = spec().replace("import { value } from '../src/impl.mjs';", "import { value } from '../src/impl.mjs';\nimport { rows as _r } from '../test/helpers/h.mjs';");
  const { fx } = run(t, { base: { 'src/impl.mjs': IMPL_V1, 'test/helpers/h.mjs': 'export const rows = 1;\n' },
    nodes: [{ id: 'other', writes: ['test/helpers'] }, { id: 'r', deps: ['other'], writes: ['spec/red.test.mjs'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] },
      { id: 'impl', deps: ['r'], writes: ['src/impl.mjs'] }],
    behaviour: { other: { write: { 'test/helpers/h.mjs': 'export const rows = 2;\n' } }, r: { write: { 'spec/red.test.mjs': helperSpec } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive')); ok(fx.cli('drive'));
  refused(fx.gate('red', { node: 'r', command: 'unit' }), 'red_helper_dependency');
});

test('P4-7b a spec importing a file the implementation adds: Blocked without redBaseline, accepted with a designed harness', { skip: SKIP }, (t) => {
  const clientSpec = spec().replace('../src/impl.mjs', '../src/new-client.mjs');
  for (const harness of [false, true]) {
    const { fx } = run(t, { base: {},
      nodes: [{ id: 'r', writes: ['spec'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }],
        ...(harness ? { redBaseline: [{ path: 'src/new-client.mjs', harness: 'spec/harness/new-client.baseline.mjs' }] } : {}) },
      { id: 'impl', deps: ['r'], writes: ['src/new-client.mjs'] }],
      behaviour: { r: { write: { 'spec/red.test.mjs': clientSpec, 'spec/harness/new-client.baseline.mjs': IMPL_V1 } }, impl: { write: { 'src/new-client.mjs': IMPL_V2 } } } });
    ok(fx.cli('init', { dag: fx.dagFile }));
    ok(fx.cli('drive'));
    const r = fx.gate('red', { node: 'r', command: 'unit' });
    if (!harness) { refused(r, 'red_baseline_missing'); assert.equal(r.out.judgment_point, true, 'Blocked'); }
    else {
      ok(r, 'RED with the designed baseline harness');
      assert.deepEqual(stateOf(fx).gates.red.r.base_tree.overlay.map(x => [x.path, x.from]),
        [['spec/red.test.mjs', 'spec/red.test.mjs'], ['src/new-client.mjs', 'spec/harness/new-client.baseline.mjs']]);
    }
  }
});

test('P4-7c the base worktree resolves no bare import from the checkout (no node_modules ancestor): the spec cannot load candidate dependencies', { skip: SKIP }, (t) => {
  const { fx } = run(t, { base: { '.gitignore': 'node_modules\n', 'src/impl.mjs': IMPL_V1 },
    behaviour: { r: { write: { 'spec/red.test.mjs': spec('', 'leak-pkg') } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } } } });
  mkdirSync(join(fx.repo, 'node_modules', 'leak-pkg'), { recursive: true });
  writeFileSync(join(fx.repo, 'node_modules', 'leak-pkg', 'package.json'), JSON.stringify({ name: 'leak-pkg', type: 'module', exports: './index.js' }));
  writeFileSync(join(fx.repo, 'node_modules', 'leak-pkg', 'index.js'), 'export const value = () => 1;\n'); // would make the spec fail "on the base"
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  refused(fx.gate('red', { node: 'r', command: 'unit' }), 'non_assertion_failure'); // a load failure: setup, never RED credit
});

test('P4-7d no declared RED environment -> red_baseline_missing (Blocked), never an accepted RED', { skip: SKIP }, (t) => {
  const { fx, o } = run(t, { config: { ...PIN, succession: { version: 1 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const r = refused(fx.gate('red', { node: 'r', command: 'unit' }), 'red_baseline_missing');
  assert.equal(r.out.judgment_point, true);
  assert.match(r.out.reasons[0], /no declared RED environment/);
  assert.equal(stateOf(fx).gates.red.r, undefined);
  assert.equal(worktrees(o), 1);
});

test('P4-7e a declared setup prepares the base worktree with BASE dependencies (never the checkout\'s); a failing setup refuses', { skip: SKIP }, (t) => {
  // the base vendors dep-pkg v1; the declared setup installs it into the base worktree (an `npm ci` stand-in). The checkout's own
  // node_modules carries dep-pkg v2, which would make the spec PASS: had RED linked candidate dependencies it would be refused.
  const install = { cmd: process.execPath, args: ['-e', "require('fs').cpSync('vendor/dep-pkg', 'node_modules/dep-pkg', { recursive: true })"] };
  const pkg = (v) => ({ 'package.json': JSON.stringify({ name: 'dep-pkg', type: 'module', exports: './index.js' }), 'index.js': `export const value = () => ${v};\n` });
  const base = { '.gitignore': 'node_modules\n', 'src/impl.mjs': IMPL_V1, ...Object.fromEntries(Object.entries(pkg(1)).map(([f, c]) => [`vendor/dep-pkg/${f}`, c])) };
  for (const failing of [false, true]) {
    const { fx, o } = run(t, { base, config: { ...PIN, succession: { version: 1 }, redEnvironment: { setup: failing ? [{ cmd: process.execPath, args: ['-e', 'process.exit(3)'] }] : [install] } },
      behaviour: { r: { write: { 'spec/red.test.mjs': spec('', 'dep-pkg') } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } } } });
    for (const [f, c] of Object.entries(pkg(2))) { mkdirSync(join(fx.repo, 'node_modules', 'dep-pkg'), { recursive: true }); writeFileSync(join(fx.repo, 'node_modules', 'dep-pkg', f), c); }
    ok(fx.cli('init', { dag: fx.dagFile }));
    ok(fx.cli('drive'));
    const r = fx.gate('red', { node: 'r', command: 'unit' });
    const S = stateOf(fx);
    const setups = S.attempts.filter(a => a.kind === 'gate-red' && a.setup === 0);
    assert.equal(setups.length, 1, 'the setup ran once under the runner protocol');
    assert.ok(setups[0].deadline && setups[0].status === 'exited', 'with a persisted deadline, retired');
    if (failing) { refused(r, 'red_environment_failed'); assert.equal(S.gates.red.r, undefined); }
    else {
      ok(r, 'RED on the base with the base dependency');
      assert.deepEqual(S.gates.red.r.base_tree.environment.steps.map(s => s.exit_code), [0]);
      assert.match(S.gates.red.r.base_tree.environment.digest, /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(worktrees(o), 1, 'the base worktree is removed on every path');
  }
});

test('P4-8 crash at each point of the transition: the predecessor stays authoritative; exactly one generation commits', { skip: SKIP }, async (t) => {
  const { fx, o } = run(t);
  const before = shipped(fx);
  baseMoves(fx, o, { 'upstream/f1.txt': 'x\n' });
  const { succeed: succeedCmd } = await engine();
  const input = { kind: 'base', reason: 'rebase' };
  const crashAt = (name) => ({ boundary: async (b) => { if (b === name) throw new Error(`crash at ${name}`); } });
  const ref = (S) => o.gitRaw('rev-parse', '--verify', '--quiet', S.succession.transition.retained_ref);
  // point 1: transition recorded (prepared), ref not yet created
  await assert.rejects(succeedCmd(fx.ctx({ input, hooks: crashAt('succession-prepared') })), /crash at succession-prepared/);
  let S = stateOf(fx);
  assert.deepEqual([S.succession.g, S.succession.transition.phase, S.succession.transition.g], [0, 'prepared', 1]);
  assert.equal(ref(S).status, 1, 'no retained ref yet');
  assert.ok(S.gates.red.r && S.ship_ready && S.base.merge_base === before.base.merge_base, 'the predecessor is what the gates read');
  // point 2: ref created, nothing installed
  await assert.rejects(succeedCmd(fx.ctx({ input, hooks: crashAt('succession-retained') })), /crash at succession-retained/);
  S = stateOf(fx);
  assert.equal(ref(S).stdout.trim(), o.pre);
  assert.equal(S.succession.g, 0);
  // point 3: successor built, crash just before its one commit (also a throwing beforeCommit)
  await assert.rejects(succeedCmd(fx.ctx({ input, hooks: crashAt('succession-commit') })), /crash at succession-commit/);
  await assert.rejects(succeedCmd(fx.ctx({ input, beforeSuccessionCommit: () => { throw new Error('crash before commit'); } })), /crash before commit/);
  S = stateOf(fx);
  assert.deepEqual([S.succession.g, S.succession.generations.length, S.succession.transition.phase], [0, 0, 'prepared']);
  assert.ok(S.gates.red.r && S.ship_ready, 'still the predecessor');
  const st = fx.cli('status');
  assert.equal(st.out.succession.phase, 'prepared');
  // the resumed transition commits exactly once, idempotently over the existing ref
  ok(succeed(fx, input), 'resumed');
  S = stateOf(fx);
  assert.deepEqual([S.succession.g, S.succession.generations.length, S.succession.transition], [1, 1, undefined]);
  assert.equal(o.sha(S.succession.generations[0].git.retained_ref), o.pre);
  refused(succeed(fx, input), 'succession_nothing_changed'); // a repeat never records a second generation
  assert.equal(stateOf(fx).succession.generations.length, 1);
});

test('P4-8b --prepare before a destructive rebase retains the pre-rebase head; the generation then records old and new OIDs', { skip: SKIP }, (t) => {
  const { fx, o } = run(t);
  shipped(fx);
  o.git('add', '-A'); o.git('commit', '-q', '-m', 'ticket work');
  const preRebase = o.sha('HEAD');
  const p = succeed(fx, undefined, { prepare: 'true' });
  ok(p, 'prepare');
  assert.equal(p.out.transition.old_head, preRebase);
  assert.equal(o.sha(p.out.transition.retained_ref), preRebase);
  baseMoves(fx, o, { 'upstream/f1.txt': 'x\n' }, { commit: false });
  assert.notEqual(o.gitRaw('merge-base', '--is-ancestor', preRebase, 'HEAD').status, 0, 'the rebase rewrote the ticket commit');
  const g = succeed(fx, { kind: 'base', reason: 'rebase' });
  ok(g);
  assert.deepEqual([g.out.generation.git.old_head, g.out.generation.git.old_head_source, g.out.generation.git.new_head, g.out.generation.git.preserved], [preRebase, 'prepare', o.sha('HEAD'), true]);
  assert.equal(o.sha(g.out.generation.git.retained_ref), preRebase, 'the rewritten predecessor commit stays reachable');
});

test('P4-9 real FAIL rounds across generations: a moved base never ships an unfinished review line; the third review needs an RCA', { skip: SKIP }, (t) => {
  const { fx, o } = run(t, { behaviour: { r: { write: { 'spec/red.test.mjs': spec() } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } },
    fix: { write: { 'src/impl.mjs': IMPL_V2 + '// fix 1\n' } }, fix2: { write: { 'src/impl.mjs': IMPL_V2 + '// fix 2\n' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'r', command: 'unit' })); ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx1', candidate(fx, stateOf(fx)), 'src/impl.mjs', fx.prompt('fix'))), 'round 1 FAIL');
  const repaired = fx.cli('drive');
  ok(repaired, 'repair 1');
  assert.equal(repaired.out.repairs[0].state, 'done');
  // the base moves between the repair and its confirmation: the generation opens a full review
  baseMoves(fx, o, { 'upstream/f1.txt': 'x\n' });
  const g1 = succeed(fx, { kind: 'base', reason: 'rebase mid-repair' });
  ok(g1);
  assert.equal(g1.out.generation.review_required, true, 'an unfinished review line is still a review to renew');
  ok(fx.gate('red', { node: 'r', command: 'unit' }), 'RED renewed');
  const c = candidate(fx, stateOf(fx));
  ok(fx.gate('review', confirmReview('rx1', c)), 'the old line confirms');
  refused(fx.gate('ship-ready', {}), 'review_generation_stale'); // a confirmation of the predecessor line never carries ship past the generation
  refused(fx.gate('review', failReview('rx2', c, 'src/impl.mjs', fx.prompt('fix2'))), 'retry_unauthorized'); // without generation: 1
  ok(fx.gate('review', { ...failReview('rx2', c, 'src/impl.mjs', fx.prompt('fix2')), generation: 1 }), 'round 2: the generation-authorized original FAILs');
  ok(fx.cli('drive'), 'repair 2');
  // two unsuccessful rounds: a further generation that opens a review needs an RCA; nothing reset the count
  chmodSync(join(fx.repo, 'src', 'impl.mjs'), 0o755);
  refused(succeed(fx, { kind: 'mode', reason: 'exec bit', paths: ['src/impl.mjs'] }), 'rca_required');
  const g2 = succeed(fx, { kind: 'mode', reason: 'exec bit', paths: ['src/impl.mjs'], rca: { differs: 'record the mode bit as its own generation instead of a third identical review', evidence: ['rx2 finding F1'] } });
  ok(g2);
  assert.equal(g2.out.generation.rounds_before, 2);
  assert.deepEqual(g2.out.generation.rca.evidence, ['rx2 finding F1']);
  assert.equal(stateOf(fx).review_chain.filter(r => r.outcome === 'FAIL').length, 2, 'the chain is append-only across generations');
});

test('P4-10 guards: a run without the flag keeps the frozen route, refusals and wording; DAG validation', { skip: SKIP }, (t) => {
  const simple = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/impl.mjs';\ntest('fails on assertion', () => { assert.equal(value(), 2); });\n";
  const { fx: legacy348 } = run(t, { config: PIN });
  ok(legacy348.cli('init', { dag: legacy348.dagFile }));
  assert.equal(stateOf(legacy348).policy_version, 17, 'a pinned durable run without the flag keeps its version');
  ok(legacy348.cli('drive'));
  refused(legacy348.gate('red', { node: 'r', command: 'unit' }), 'non_assertion_failure'); // the frozen parser refuses the 348 shape
  // `generation` on a run without the flag: the frozen unknown-field refusal, byte for byte
  const gen = legacy348.gate('review', { ...passReview('rx1', 'sha256:x'), generation: 1 });
  assert.equal(gen.status, 1);
  assert.equal(gen.stderr, 'run-engine: bad_input: gate review: unknown input field(s): generation (commands, formats, resources and local proof come from the bound DAG)\n');
  const { fx, o } = run(t, { config: PIN, behaviour: { r: { write: { 'spec/red.test.mjs': simple } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } } } });
  const S0 = shipped(fx);
  assert.equal(S0.succession, undefined);
  assert.equal(S0.gates.red.r.parser, undefined, 'the frozen RED evidence has no parser field');
  refused(succeed(fx, { kind: 'base', reason: 'x' }), 'succession_off');
  baseMoves(fx, o, { 'upstream/f1.txt': 'x\n' });
  refused(fx.gate('ship-ready', {}), 'candidate_mismatch'); // frozen: only an owner RETRY review or a new run continues
  const nodes = [{ id: 'a', writes: ['src/a.txt'], promptFile: 'p' }];
  const dag = (config) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 120000, ...config }, nodes });
  assert.throws(() => validateEngineDag(dag({ succession: { version: 1 } })), /succession needs config.pinnedBase, a durable run/);
  assert.throws(() => validateEngineDag(dag({ ...PIN, durableRun: false, succession: { version: 1 } })), /succession needs/);
  assert.throws(() => validateEngineDag(dag({ ...PIN, repoIdentity: true, succession: { version: 1 } })), /no config.repoIdentity/);
  assert.throws(() => validateEngineDag(dag({ ...PIN, succession: { version: 2 } })), /exactly \{ version: 1 \}/);
  assert.throws(() => validateEngineDag(dag({ ...PIN, redEnvironment: { setup: [] } })), /redEnvironment needs config.succession/);
  assert.throws(() => validateEngineDag(dag({ ...SUCCESSION, redEnvironment: { setup: [{ cmd: '' }] } })), /redEnvironment must be exactly/);
  assert.throws(() => validateEngineDag(dag({ ...SUCCESSION, redEnvironment: { setup: [], link: true } })), /redEnvironment must be exactly/);
  assert.throws(() => validateEngineDag({ ...dag(PIN), nodes: [{ ...nodes[0], redSpecs: [{ file: 's.mjs', name: 'n' }], redBaseline: [{ path: 'a', harness: 'b' }] }] }), /redBaseline needs config.succession/);
  assert.ok(validateEngineDag(dag(SUCCESSION)));
  assert.ok(validateEngineDag(dag({ ...SUCCESSION, durableRun: { version: 1 } })));
});

test('P4-10b the moved-base wording: frozen text for a run without the flag, the successor route with it', async () => {
  const { movedRoute } = await import('./engine-base-read.mjs');
  assert.equal(movedRoute({ config: {} }), 'archive the run and start a new one (it pins the new base)');
  assert.match(movedRoute({ config: { succession: { version: 1 } } }), /record a successor generation in this run \(run-engine.mjs succeed/);
  for (const f of ['./engine-identity.mjs', './engine-base-read.mjs']) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/during the run; archive the run and start a new one/.test(text), `${f}: the restart text is only movedRoute's frozen branch`);
  }
});

test('P4-10c the policy twin is derived for every flag combination (core, stage, early checks, host claims), outermost, never hand-assigned', async () => {
  const P = await import('./engine-policy.mjs');
  const table = P.POLICY_SEMANTICS, rows = Object.entries(table).map(([v, f]) => [Number(v), f]);
  const below = rows.filter(([v]) => v < P.SUCCESSION_OFFSET), above = rows.filter(([v]) => v >= P.SUCCESSION_OFFSET);
  assert.ok(below.every(([, f]) => f.succession !== true), 'no row below the offset carries succession');
  assert.deepEqual(above.map(([v]) => v), below.filter(([, f]) => P.successionEligible(f)).map(([v]) => v + P.SUCCESSION_OFFSET), 'one twin per eligible row, nothing else');
  for (const [v, f] of above) assert.deepEqual({ ...f }, { ...table[v - P.SUCCESSION_OFFSET], succession: true }, `row ${v}`);
  // every combination of the composable flags on an eligible (pinned, durable, no repoIdentity) row has a twin
  for (const testKinds of [false, true]) for (const securityObligations of [false, true]) for (const stageObligations of [false, true])
    for (const earlyChecks of [false, true]) for (const hostClaimRequired of [false, true]) {
      const want = { ...(testKinds ? { testKinds } : {}), ...(securityObligations ? { securityObligations } : {}), pinnedBase: true, durableRun: true,
        ...(stageObligations ? { stageObligations } : {}), ...(earlyChecks ? { earlyChecks } : {}), ...(hostClaimRequired ? { hostClaimRequired } : {}) };
      const hit = below.find(([, f]) => JSON.stringify(Object.keys(f).sort()) === JSON.stringify(Object.keys(want).sort()) && Object.keys(want).every(k => f[k] === true));
      assert.ok(hit, JSON.stringify(want));
      assert.equal(P.successionVersion(hit[0]), hit[0] + P.SUCCESSION_OFFSET);
    }
  assert.equal(P.successionVersion(21), null, 'repoIdentity rows have no twin (the DAG refuses the combination)');
  assert.equal(P.successionVersion(5), null, 'a legacy-placement pinned row has no twin');
  assert.equal(P.successionVersion(17, P.withHostClaimTwins(P.withEarlyChecksTwins(P.PRE_EARLY_CHECKS_SEMANTICS))), null, 'an engine without PR-4b has none');
  assert.throws(() => P.withSuccessionTwins({ 400: { pinnedBase: true, durableRun: true } }), (e) => e.code === 'policy_table_ceiling');
  assert.throws(() => P.withSuccessionTwins(table), (e) => e.code === 'policy_table_ceiling', 'applying it twice is refused');
  assert.throws(() => P.runPolicy({ policy_version: 417 }, { semantics: P.withHostClaimTwins(P.withEarlyChecksTwins(P.PRE_EARLY_CHECKS_SEMANTICS)) }), (e) => e.code === 'policy_version_unsupported');
});

test('P4-11 units: two consecutive base moves rebind unit evidence; each re-check is generation-authorized (no ceiling spend, no storm)', { skip: SKIP }, (t) => {
  const { fx, o } = run(t, { config: { ...SUCCESSION, unitRecheckCeiling: 1 }, testCommands: { unit: TAP, ok: PASS },
    nodes: [{ id: 'r', unit: 'u-r', checks: ['ok'], writes: ['spec/red.test.mjs'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] },
      { id: 'impl', deps: ['r'], unit: 'u-impl', checks: ['ok'], reads: ['docs/in.txt'], writes: ['src/impl.mjs'] },
      { id: 'side', unit: 'u-side', checks: ['ok'], writes: ['src/side.txt'] }],
    behaviour: { r: { write: { 'spec/red.test.mjs': spec() } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } }, side: { write: { 'src/side.txt': 's1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  for (let i = 0; i < 3 && Object.values(stateOf(fx).unit_checks).some(u => u.evidence?.state !== 'verified'); i++) ok(fx.cli('drive'), 'drive');
  let S = stateOf(fx);
  assert.deepEqual(Object.values(S.unit_checks).map(u => u.evidence?.state), ['verified', 'verified', 'verified']);
  ok(fx.gate('review', passReview('rx1', candidate(fx, S))), 'review');
  ok(fx.gate('ship-ready', {}));
  let rx = 1;
  for (const move of [1, 2]) {
    baseMoves(fx, o, { [`upstream/m${move}.txt`]: `move ${move}\n` });
    const g = succeed(fx, { kind: 'base', reason: `rebase ${move}` });
    ok(g, `succeed ${move}`);
    assert.deepEqual(g.out.generation.invalidated.units.sort(), ['u-impl', 'u-r', 'u-side'], 'every unit evidence bound the old base');
    const d = fx.cli('drive');
    ok(d, `drive after generation ${move}`);
    S = stateOf(fx);
    assert.deepEqual(S.judgments.map(j => j.code), [], 'no parent_ceiling, no unit_invalidation_storm');
    assert.deepEqual(Object.values(S.unit_checks).map(u => u.evidence?.state), ['verified', 'verified', 'verified'], `units re-verified on base ${move}`);
    assert.deepEqual(Object.values(S.unit_checks).map(u => u.invalidations), [0, 0, 0], 'generation invalidations are not churn');
    assert.equal(S.unit_ceiling?.used ?? 0, 0, 'no re-check slot spent');
    assert.ok(Object.values(S.unit_checks).every(u => u.evidence.binding.base_commit === S.base.merge_base), 'rebound to the new base');
    ok(fx.gate('red', { node: 'r', command: 'unit' }), `RED renewed ${move}`);
    ok(fx.gate('review', passReview(`rx${++rx}`, candidate(fx, S), { generation: move })), `review g${move}`);
    const ship = fx.gate('ship-ready', {});
    ok(ship);
    assert.equal(ship.out.code, 'ship_ready');
  }
});

test('P4-12 composition: stage obligations (PR-3) survive a generation; an early-checks (S5) pre-review prove of the old base is never accepted after it', { skip: SKIP }, async (t) => {
  const STAGE = { merge_stage: 'merge', stages: ['local', 'merge'],
    rows: [{ id: 'R1', check: 'unit + negative spec', stage: 'local' }, { id: 'R2', check: 'production RLS read-only probe', stage: 'production' }],
    deferred: [{ row: 'R2', stage: 'production', environment: 'production', subject: 'api release of this candidate', required_evidence: 'probe output after deploy', tracker_ref: 'TRK-1' }] };
  const SCAN = "const fs = require('fs'); const hit = process.argv.slice(2).some(f => /SECRET-/.test(fs.readFileSync(f, 'utf8'))); process.exit(hit ? 1 : 0);\n";
  const fx = fixture(t, { narrativeExtra: 'stage-policy-v1: ' + JSON.stringify(STAGE) + '\n\n',
    config: { width: 1, testCommands: { unit: TAP }, ...SUCCESSION, earlyChecks: { version: 1 }, stagePolicy: { version: 1 } },
    nodes: [{ id: 'r', writes: ['spec/red.test.mjs'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] },
      { id: 'impl', deps: ['r'], writes: ['src/impl.mjs'] }],
    behaviour: { r: { write: { 'spec/red.test.mjs': spec() } }, impl: { write: { 'src/impl.mjs': IMPL_V2 } } } });
  const base = { 'src/impl.mjs': IMPL_V1, 'tools/scan.cjs': SCAN,
    '.ship-ticket/t0.json': JSON.stringify({ checks: [{ name: 'secrets', kind: 'secrets', cmd: [process.execPath, 'tools/scan.cjs', '{files}'], files: true, timeout_ms: 30000 }] }) };
  for (const [p, c] of Object.entries(base)) { mkdirSync(join(fx.repo, dirname(p)), { recursive: true }); writeFileSync(join(fx.repo, p), c); }
  const o = withOrigin(fx);
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }), 'init');
  ok(fx.cli('drive')); ok(fx.gate('red', { node: 'r', command: 'unit' })); ok(fx.cli('drive'));
  ok(fx.gate('prove', {}), 'pre-review prove');
  ok(fx.gate('review', passReview('rx1', candidate(fx, stateOf(fx)))), 'review');
  const first = fx.gate('ship-ready', {});
  ok(first);
  assert.deepEqual(first.out.stage, { verified_through: 'merge', obligations_open: ['R2'] });
  const stageBefore = stateOf(fx).stage;
  baseMoves(fx, o, { 'upstream/f1.txt': 'x\n' });
  ok(succeed(fx, { kind: 'base', reason: 'rebase' }));
  let S = stateOf(fx);
  assert.deepEqual(S.stage, stageBefore, 'the outstanding obligation record is preserved, untouched');
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  const cand = candidate(fx, S);
  refused(fx.gate('review', passReview('rx2', cand, { generation: 1 })), 'prove_required'); // the old base's prove never carries over
  ok(fx.gate('prove', {}), 'prove on the new base');
  ok(fx.gate('review', passReview('rx2', cand, { generation: 1 })), 'generation review');
  const ship = fx.gate('ship-ready', {});
  ok(ship);
  assert.deepEqual(ship.out.stage, { verified_through: 'merge', obligations_open: ['R2'] }, 'the obligation stays open across the generation');
  S = stateOf(fx);
  assert.deepEqual(S.stage.obligations.map(x => [x.row, x.status]), [['R2', 'open']]);
});

test('P4-13 (342 replay shape) a rename inside the approved writes after the freeze: a correction generation plus a fresh review, no owner RETRY', { skip: SKIP }, (t) => {
  const { fx } = run(t, { nodes: [{ id: 'r', writes: ['spec/red.test.mjs'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] },
    { id: 'impl', deps: ['r'], writes: ['src'] }],
    behaviour: { r: { write: { 'spec/red.test.mjs': spec() } }, impl: { write: { 'src/impl.mjs': IMPL_V2, 'src/old-name.mjs': 'export const x = 1;\n' } } } });
  shipped(fx);
  writeFileSync(join(fx.repo, 'src', 'new-name.mjs'), readFileSync(join(fx.repo, 'src', 'old-name.mjs')));
  spawnSync('rm', [join(fx.repo, 'src', 'old-name.mjs')]);
  const p = succeed(fx, undefined, { plan: 'true' });
  ok(p);
  assert.deepEqual(p.out.transition.changes, [{ path: 'src/new-name.mjs', change: 'added' }, { path: 'src/old-name.mjs', change: 'removed' }]);
  refused(succeed(fx, { kind: 'correction', reason: 'rename', paths: ['src/new-name.mjs'] }), 'succession_record_mismatch');
  const g = succeed(fx, { kind: 'correction', reason: 'rename after the freeze, inside the approved writes', paths: ['src/new-name.mjs', 'src/old-name.mjs'] });
  ok(g);
  assert.deepEqual(g.out.generation.invalidated.red, [], 'the spec is unchanged: RED stays on the same base');
  ok(fx.gate('review', passReview('rx2', candidate(fx, stateOf(fx)), { generation: 1 })), 'fresh review, no RETRY');
  const ship = fx.gate('ship-ready', {});
  ok(ship);
  assert.equal(ship.out.code, 'ship_ready');
  assert.ok(!/"event":"RETRY"/.test(readFileSync(fx.planFile, 'utf8')));
});

test('P4-14 a base move never absorbs the candidate\'s own change: a chmod in the rebase window is recorded in the generation; an out-of-scope change is refused', { skip: SKIP }, (t) => {
  for (const outside of [false, true]) {
    const { fx, o } = run(t);
    shipped(fx);
    baseMoves(fx, o, { 'upstream/f1.txt': 'x\n' });
    chmodSync(join(fx.repo, 'src', 'impl.mjs'), 0o755);
    if (outside) writeFileSync(join(fx.repo, 'docs', 'in.txt'), 'a declared READ changed by the ticket: outside every node\'s writes\n');
    const g = succeed(fx, { kind: 'base', reason: 'rebase' });
    if (outside) { refused(g, 'succession_out_of_scope'); assert.match(g.out.reasons[0], /docs\/in\.txt/); assert.equal(stateOf(fx).succession.g, 0); continue; }
    ok(g);
    assert.deepEqual(g.out.generation.delta.candidate.map(d => [d.path, d.change]), [['src/impl.mjs', 'mode']], 'the chmod is on the record');
    assert.equal(g.out.generation.review_required, true);
  }
});

test('P4-11b unit reviews (config.unitReview): after a base move each rebound unit gets ONE fresh unit review without RETRY or ceiling spend; the final review consumes the new evidence', { skip: SKIP }, (t) => {
  const { fx, o } = run(t, { config: { ...SUCCESSION, unitReview: true, unitRecheckCeiling: 1, acceptanceIds: ['AC1'] }, testCommands: { unit: TAP, ok: PASS },
    nodes: [{ id: 'r', unit: 'u-r', checks: ['ok'], acceptance: ['AC1'], writes: ['spec/red.test.mjs'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] },
      { id: 'impl', deps: ['r'], unit: 'u-impl', checks: ['ok'], writes: ['src/impl.mjs'] }] });
  const units = () => fx.cli('status').out.units;
  const unitReview = (u, rx) => { const S = stateOf(fx), ev = units()[u].evidence;
    return { unit: u, approved_plan_digest: S.plan_digest, dag_digest: S.dag_digest, base_commit: ev.base_commit, ...passReview(rx, ev.id) }; };
  const consumed = () => Object.entries(units()).map(([unit, p]) => ({ unit, evidence_id: p.evidence.id }));
  const reviewUnits = (tag) => { for (const u of ['u-r', 'u-impl']) { const { second_opinion: _s, ...input } = unitReview(u, `urx-${u}-${tag}`); ok(fx.gate('unit-review', input), `unit review ${u} ${tag}`); } };
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  ok(fx.cli('drive'));
  if (units()['u-r'].review.state === 'unreviewed' && units()['u-impl'].state !== 'verified') ok(fx.cli('drive'));
  reviewUnits('1');
  const final = (rx, extra = {}) => ({ ...passReview(rx, candidate(fx, stateOf(fx)), extra), units_consumed: consumed() });
  ok(fx.gate('review', final('rx1')), 'final review');
  ok(fx.gate('ship-ready', {}));
  baseMoves(fx, o, { 'upstream/f1.txt': 'x\n' });
  const g = succeed(fx, { kind: 'base', reason: 'rebase' });
  ok(g);
  assert.deepEqual(g.out.generation.invalidated.units.sort(), ['u-impl', 'u-r']);
  ok(fx.cli('drive'), 'unit re-checks on the new base');
  assert.deepEqual(Object.values(units()).map(u => [u.state, u.review.state]), [['verified', 'stale'], ['verified', 'stale']]);
  reviewUnits('2'); // a stale unit review: one fresh original each, no RETRY
  const S = stateOf(fx);
  assert.equal(S.unit_ceiling?.used ?? 0, 0, 'no unit ceiling slot spent by the generation');
  assert.deepEqual(S.judgments.map(j => j.code), []);
  assert.ok(S.events.some(e => e.type === 'UNIT_REVIEW_CYCLE' && e.trigger?.cause === 'generation'), 'the free re-review is on the record');
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  ok(fx.gate('review', final('rx2', { generation: 1 })), 'final review of generation 1 consuming the new unit evidence');
  const ship = fx.gate('ship-ready', {});
  ok(ship);
  assert.equal(ship.out.code, 'ship_ready');
});
