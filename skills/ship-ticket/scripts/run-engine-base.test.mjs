/**
 * S-12 (ASTF-6) pinned remote base, driven through the REAL engine (`node run-engine.mjs` on a temp git repo with a bare
 * `origin` and a fake provider CLI). Tests tagged [B#] are the ones engine-base-mutation.test.mjs expects to fail when
 * guard B# is patched out.
 *
 * The SCRUM-202 latch replica: local `main` 26 commits behind origin, the branch made from origin/main, config.base 'main'.
 * Flag off (today's engine) the 26 upstream files enter the candidate and the first `gate reassess` latches
 * `security_reapproval` (R0, the proof that the replica bites). With config.pinnedBase the same topology gives the non-latching
 * `base_moved_local` with the expected (pinned) and observed (local) merge bases (R1): the differential pair R0/R1 is the one
 * intended difference. AC2 (an advanced remote has no effect), AC3 (a real delta still needs REAPPROVAL), the Neg cases
 * (offline, detached HEAD, no upstream, an ambiguous remote), a rewound remote, a mid-run merge base change, one accessor for
 * every base read, and in-flight compatibility (policy versions 5-8, a partial pin) follow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, withOrigin } from './engine-test-fixture.mjs';
import * as SP from './security-plan.mjs';
import { init, status, gate as gateCmd } from './run-engine.mjs';
import { POLICY_SEMANTICS } from './engine-policy.mjs';
import { pinBaseRecord, wellFormedBase } from './engine-base-read.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)';
const CATALOG = SP.loadCatalog();
assert.equal(CATALOG.ok, true, 'the installed catalog loads');
const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
/** An evidenced empty assessment over the REAL catalog: no surface, no pair; reassess still checks every changed path against the Design Contract. */
const EMPTY = (() => {
  const r = SP.selectControls(CATALOG, { security_policy: 2, surfaces: [], facts: Object.fromEntries(BOOLS.map(k => [k, false])),
    evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/impl.txt:1'])) });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
})();
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, `want ${code}: ${r.stdout}${r.stderr}`); assert.equal(r.out?.code, code, r.stdout); return r; };

/**
 * A policy-2 run on a repo with a bare origin: node `impl` writes src/ (the Design Contract). `config` extends the DAG
 * config (pinnedBase goes here). Returns the fixture and its origin helper.
 */
function baseFx(t, { config = {} } = {}) {
  const fx = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(EMPTY) + '\n\n',
    config: { width: 1, base: 'main', securityPolicy: 2, catalogDigest: CATALOG.digest, controlCoverage: [], ...config },
    nodes: [{ id: 'impl', writes: ['src'] }], behaviour: { impl: { write: { 'src/impl.txt': 'done' } } } });
  return { fx, o: withOrigin(fx) };
}

/** The SCRUM-202 topology: origin advances by 26 out-of-plan commits, local main stays, the branch is made from origin/main. */
function staleLocalMain(o) {
  const tip = o.upstream(26);
  o.fetch();
  o.git('checkout', '-q', '-b', 'feature', 'origin/main');
  assert.notEqual(o.sha('main'), tip, 'local main is behind');
  assert.equal(o.sha('HEAD'), tip, 'the branch is made from the origin tip');
  return tip;
}

test('R0 SCRUM-202 replica, flag off (today\'s engine): a local main 26 behind origin latches security_reapproval', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t);
  staleLocalMain(o);
  ok(fx.cli('init', { dag: fx.dagFile }), 'init');
  ok(fx.cli('drive'), 'drive impl');
  const r = refused(fx.gate('reassess', {}), 'security_reapproval');
  assert.ok(r.out.reapproval_basis.some(b => b.kind === 'out-of-plan-path' && /^upstream\//.test(b.path)), r.stdout);
  const S = fx.readState();
  assert.ok(S.security?.reapproval, 'the permanent latch is set');
  assert.equal(S.base, undefined, 'a flag-off run records no base');
  // the latch stops every later command
  refused(fx.gate('reassess', {}), 'security_reapproval');
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN = { pinnedBase: { remote: 'origin' } };
const noState = (fx) => assert.equal(existsSync(fx.stateFile()), false, 'a refused init writes no state');
const initFails = (r, code) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, new RegExp(`run-engine: ${code}:`), r.stderr); };

test('[B2] [B4] R1 SCRUM-202 replica, flag on: base_moved_local with both SHAs, no latch; a reset local main then reassesses', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  const oldMain = o.sha('main');
  const tip = staleLocalMain(o);
  ok(fx.cli('init', { dag: fx.dagFile }), 'init');
  let S = fx.readState();
  assert.deepEqual({ ...S.base, pinned_at_seq: undefined }, { remote: 'origin', identity: null, ref: 'main', sha: tip, merge_base: tip, pinned_at_seq: undefined });
  assert.equal(S.policy_version, 5, 'a pinned run records the pinned-base policy version');
  assert.ok(S.events.some(e => e.type === 'BASE_LOCAL_DIVERGED' && e.advisory === true && e.expected === tip && e.observed === oldMain), 'init reports the divergence, advisory');
  ok(fx.cli('drive'), 'drive impl (the run proceeds on the pinned base)');
  const st = fx.cli('status');
  assert.ok(st.out.base.advisory.some(a => a.code === 'base_moved_local' && a.expected === tip && a.observed === oldMain), st.stdout);
  assert.ok(!st.out.judgments.length, 'the status advisory is never a judgment');
  const r = refused(fx.gate('reassess', {}), 'base_moved_local');
  assert.equal(r.out.expected, tip);
  assert.equal(r.out.observed, oldMain);
  assert.equal(r.out.judgment_point, true);
  S = fx.readState();
  assert.equal(S.security?.reapproval, undefined, 'never the security_reapproval latch');
  o.git('branch', '-f', 'main', 'origin/main');
  const again = fx.gate('reassess', {});
  ok(again, 'after the local ref is reset the same run reassesses');
  assert.equal(again.out.code, 'reassessed');
  assert.equal(fx.readState().security.reapproval, undefined);
});

test('[B4] AC2 a remote that advanced after init (fetched, local main fast-forwarded) has no effect: unrelated upstream files never count', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  const pinned = o.sha('HEAD');
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const now = o.upstream(3);
  o.fetch();
  o.git('branch', '-f', 'main', 'origin/main');
  const st = fx.cli('status');
  assert.ok(st.out.base.advisory.some(a => a.code === 'base_advanced' && a.pinned === pinned && a.remote_now === now), st.stdout);
  const r = fx.gate('reassess', {});
  ok(r, 'reassess');
  assert.equal(r.out.code, 'reassessed');
  assert.equal(fx.readState().base.merge_base, pinned, 'the pin never moves');
});

test('AC2 an advanced remote whose commit was not fetched is a recoverable base_remote_unavailable, never a pass or a latch', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  o.upstream(1);
  const r = refused(fx.gate('reassess', {}), 'base_remote_unavailable');
  assert.match(r.out.reasons[0], /fetch it/);
  assert.equal(fx.readState().security?.reapproval, undefined);
  o.fetch();
  assert.equal(fx.gate('reassess', {}).out.code, 'reassessed');
});

test('AC3 a real unapproved delta still needs REAPPROVAL on a pinned run: an out-of-plan file on the branch', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  staleLocalMain(o);
  o.git('branch', '-f', 'main', 'origin/main');
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  // the out-of-plan change is made on the branch outside any node (a builder writing it would be an ownership_violation first)
  mkdirSync(join(fx.repo, 'ops'), { recursive: true });
  writeFileSync(join(fx.repo, 'ops', 'deploy.txt'), 'outside the contract');
  const r = refused(fx.gate('reassess', {}), 'security_reapproval');
  assert.deepEqual(r.out.reapproval_basis.filter(b => b.kind === 'out-of-plan-path').map(b => b.path), ['ops/deploy.txt'], 'only the branch\'s own file, no upstream one');
});

test('AC3 local-only commits on the base that the branch contains are the branch\'s delta: REAPPROVAL (config.base unset) or base_moved_local (config.base main)', { skip: WIN_SKIP }, (t) => {
  for (const base of ['HEAD', 'main']) {
    const { fx, o } = baseFx(t, { config: { ...PIN, base } });
    mkdirSync(join(fx.repo, 'ops'), { recursive: true });
    writeFileSync(join(fx.repo, 'ops', 'local.txt'), 'never pushed');
    o.git('add', 'ops/local.txt');
    o.git('commit', '-q', '-m', 'local only');
    const localTip = o.sha('main');
    o.feature();
    ok(fx.cli('init', { dag: fx.dagFile }), `init (base ${base})`);
    assert.notEqual(fx.readState().base.merge_base, localTip, 'the pin is the remote base, not the local one');
    ok(fx.cli('drive'));
    if (base === 'HEAD') {
      const r = refused(fx.gate('reassess', {}), 'security_reapproval');
      assert.ok(r.out.reapproval_basis.some(b => b.path === 'ops/local.txt'), r.stdout);
    } else {
      const r = refused(fx.gate('reassess', {}), 'base_moved_local');
      assert.equal(r.out.observed, localTip);
    }
  }
});

test('[B4] Neg1 offline: init refuses base_remote_unavailable (no state); at reassess the same code is a refusal, never a pass', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  renameSync(o.origin, o.origin + '.away');
  initFails(fx.cli('init', { dag: fx.dagFile }), 'base_remote_unavailable');
  noState(fx);
  renameSync(o.origin + '.away', o.origin);
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  renameSync(o.origin, o.origin + '.away');
  refused(fx.gate('reassess', {}), 'base_remote_unavailable');
  const st = fx.cli('status');
  assert.ok(st.out.base.advisory.some(a => a.code === 'base_remote_unavailable'), st.stdout);
  assert.equal(fx.readState().security?.reapproval, undefined);
  renameSync(o.origin + '.away', o.origin);
  assert.equal(fx.gate('reassess', {}).out.code, 'reassessed');
});

test('Neg2 a detached HEAD is refused at init (base_unverified, no state)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.git('checkout', '-q', '--detach');
  initFails(fx.cli('init', { dag: fx.dagFile }), 'base_unverified');
  noState(fx);
});

test('Neg3 no upstream: no origin remote, a remote without the branch, a remote naming no default branch: base_remote_unavailable, no state', { skip: WIN_SKIP }, (t) => {
  const a = baseFx(t, { config: PIN });
  a.o.git('remote', 'remove', 'origin');
  const ra = a.fx.cli('init', { dag: a.fx.dagFile });
  initFails(ra, 'base_unverified'); // Round 1 item 3: a remote with no configured URL is refused, never read as a path
  assert.match(ra.stderr, /no configured URL/);
  noState(a.fx);
  const b = baseFx(t, { config: { ...PIN, base: 'trunk' } });
  initFails(b.fx.cli('init', { dag: b.fx.dagFile }), 'base_remote_unavailable');
  noState(b.fx);
  const c = baseFx(t, { config: { ...PIN, base: 'HEAD' } });
  c.o.git('--git-dir', c.o.origin, 'symbolic-ref', 'HEAD', 'refs/heads/nowhere');
  const r = c.fx.cli('init', { dag: c.fx.dagFile });
  initFails(r, 'base_remote_unavailable');
  assert.match(r.stderr, /names no default branch/);
  noState(c.fx);
});

test('[B3] Neg4 a multi-valued remote.origin.url, two push URLs, or a push URL of another repository is refused (remote_ambiguous, no state, before any ls-remote)', { skip: WIN_SKIP }, (t) => {
  const a = baseFx(t, { config: PIN });
  a.o.git('config', '--add', 'remote.origin.url', a.o.origin);
  initFails(a.fx.cli('init', { dag: a.fx.dagFile }), 'remote_ambiguous');
  noState(a.fx);
  const b = baseFx(t, { config: PIN });
  b.o.git('config', 'remote.origin.url', 'https://github.com/acme/app.git');
  b.o.git('config', 'remote.origin.pushurl', 'https://github.com/evil/app.git');
  const r = b.fx.cli('init', { dag: b.fx.dagFile });
  initFails(r, 'remote_ambiguous');
  assert.match(r.stderr, /push URL of another repository/);
  noState(b.fx);
  b.o.git('config', '--unset', 'remote.origin.pushurl');
  b.o.git('config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/app.git');
  b.o.git('config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/mirror.git');
  initFails(b.fx.cli('init', { dag: b.fx.dagFile }), 'remote_ambiguous');
  noState(b.fx);
});

test('a remote rewound below the pinned commit is base_moved_remote at reassess (recoverable, no latch)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  const before = o.sha('main');
  o.upstream(2);
  o.fetch();
  o.feature();
  o.git('branch', '-f', 'main', 'origin/main');
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  o.rewind(before);
  const st = fx.cli('status');
  assert.ok(st.out.base.advisory.some(x => x.code === 'base_rewound' && x.remote_now === before), st.stdout);
  refused(fx.gate('reassess', {}), 'base_moved_remote');
  assert.equal(fx.readState().security?.reapproval, undefined);
});

test('a branch that merges the advanced base mid-run is base_moved_local (expected the pin, observed the new merge base): a new run re-pins', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  const pinned = o.sha('HEAD');
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const now = o.upstream(2);
  o.fetch();
  o.git('merge', '-q', '--ff-only', 'origin/main');
  const r = refused(fx.gate('reassess', {}), 'base_moved_local');
  assert.equal(r.out.expected, pinned);
  assert.equal(r.out.observed, now);
  assert.equal(fx.readState().base.merge_base, pinned, 'never re-pinned silently');
});

// ------------------------------------------------------------------ one accessor for every base read

const FAILING_SPEC = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails on assertion', () => { assert.equal(1, 2); });\n`;
const TAP_RUNNER = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'spec/red.test.mjs'], format: 'tap' };

test('[B1] every base read uses the pin: a local base branch that moves after RED fires no RED_INVALIDATED base_moved', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { base: 'main', ...PIN, testCommands: { unit: TAP_RUNNER } },
    nodes: [{ id: 'r', writes: ['src/r.txt'], redSpecs: [{ file: 'spec/red.test.mjs', name: 'fails on assertion' }] }, { id: 'p', deps: ['r'], writes: ['src/p.txt'] }],
    behaviour: { r: { write: { 'src/r.txt': 'r1' } }, p: { write: { 'src/p.txt': 'p1' } } } });
  mkdirSync(join(fx.repo, 'spec'), { recursive: true });
  writeFileSync(join(fx.repo, 'spec', 'red.test.mjs'), FAILING_SPEC);
  const o = withOrigin(fx);
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'r', command: 'unit' }));
  assert.equal(fx.readState().gates.red.r.base_commit, fx.readState().base.merge_base, 'RED evidence is bound to the pinned merge base');
  // the local base branch moves (a local commit on main), and so does the branch itself: neither is the pinned base
  o.git('checkout', '-q', 'main');
  o.git('commit', '-q', '--allow-empty', '-m', 'local main moves');
  o.git('checkout', '-q', 'feature');
  o.git('commit', '-q', '--allow-empty', '-m', 'branch moves');
  const r = fx.cli('drive');
  ok(r, 'drive dispatches p');
  assert.ok(!fx.readState().events.some(e => e.type === 'RED_INVALIDATED'), JSON.stringify(r.out.judgments));
  assert.equal(fx.runs('p').length, 1);
});

/**
 * A base READ: `config.base` used as a value, i.e. followed by `??`, `||`, a comparison, a ternary `?` or passed as an argument
 * (`,` or `)`); a message or label naming config.base in text is not a read.
 */
const BASE_READ = /config\??\.base\s*(\?\?|\|\||[=!]==?|\?(?![.?])|[,)])/;
test('no engine module reads config.base except through baseRef (a partial switch is a defect)', () => {
  // positive controls: the read shapes this guard exists for are hits, a message naming config.base is not
  for (const l of ["  const c = io.candidateId(root, S.config.base ?? 'HEAD', ex);", "const b = config?.base || 'HEAD';", 'io.resolveCommit(root, S.config.base);',
    "const ref = S.config.base === 'HEAD' ? x : y;", "const r = config.base ? config.base : 'HEAD';", 'git(root, [E.S.config.base, \'--\']);'])
    assert.ok(BASE_READ.test(l), `planted read is a hit: ${l}`);
  assert.ok(!BASE_READ.test("bad('config.pinnedBase needs config.base to be absent, HEAD or a branch name');"));
  assert.ok(!BASE_READ.test('`merge-base(HEAD, local ${E.S.config.base}) is`'));
  const files = readdirSync(HERE).filter(f => /^(run-engine|engine-[a-z-]+)\.mjs$/.test(f));
  assert.ok(files.length > 10 && ['engine-attempts.mjs', 'engine-unit-review.mjs', 'engine-base-read.mjs'].every(f => files.includes(f)), `scanned ${files}`);
  const hits = files.flatMap(f => readFileSync(join(HERE, f), 'utf8').replace(/\r\n/g, '\n').split('\n').map((l, i) => [f, i + 1, l]))
    .filter(([, , l]) => BASE_READ.test(l) && !/^\s*(\*|\/\/)/.test(l)).map(([f, , l]) => `${f}: ${l.trim()}`);
  const ALLOWED = ["engine-dag.mjs: export const baseRef = (S) => (pinnedBaseOn(S) ? pinnedMergeBase(S) : S?.config?.base ?? 'HEAD');",
    "run-engine.mjs: try { ({ declaration, baseSha } = pinned ? onBase(pinned, () => tk.readDeclaration(ctx.repoRoot, baseRef(pinned))) : tk.readDeclaration(ctx.repoRoot, config.base ?? 'HEAD')); }",
    "run-engine.mjs: note(E.S, 'BASE_LOCAL_DIVERGED', { advisory: true, ref: dag.config.base, expected: pin.base.merge_base, observed: pin.local });"];
  assert.deepEqual(hits.sort(), [...ALLOWED].sort(), 'every base read goes through baseRef (the accessor, the flag-off declaration read, and one event label)');
  // every candidate id and base commit is read through the base-read module, never io directly
  const direct = files.filter(f => f !== 'engine-base-read.mjs').flatMap(f => readFileSync(join(HERE, f), 'utf8').split('\n').filter(l => /io\.(candidateId|resolveCommit)\(/.test(l)).map(l => `${f}: ${l.trim()}`));
  assert.deepEqual(direct, []);
});

// ------------------------------------------------------------------ flag off, policy versions, in-flight compatibility

test('flag off: a run without config.pinnedBase records no base, no BASE_* event, no status base block, and keeps its policy version', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t);
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const st = fx.cli('status');
  const S = fx.readState();
  assert.equal(Object.hasOwn(S, 'base'), false);
  assert.equal(S.policy_version, 1);
  assert.equal(Object.hasOwn(st.out, 'base'), false);
  assert.doesNotMatch(JSON.stringify(S.events), /BASE_/);
});

test('policy: versions 5-8 are 1-4 plus pinnedBase, and an engine without S-12 refuses a pinned run (policy_version_unsupported) at init and on load', { skip: WIN_SKIP }, async (t) => {
  for (const [v, w] of [[1, 5], [2, 6], [3, 7], [4, 8]]) assert.deepEqual(POLICY_SEMANTICS[w], { ...POLICY_SEMANTICS[v], pinnedBase: true });
  const old = { current: 1, semantics: Object.fromEntries([1, 2, 3, 4].map(v => [v, POLICY_SEMANTICS[v]])) };
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  await assert.rejects(init(fx.ctx({ policy: old })), (e) => e.code === 'policy_version_unsupported');
  noState(fx);
  await init(fx.ctx());
  await assert.rejects(status(fx.ctx({ policy: old })), (e) => e.code === 'policy_version_unsupported');
  const g = await gateCmd(fx.ctx({ policy: old, gate: 'reassess', input: {} }));
  assert.equal(g.code, 'policy_version_unsupported');
});

test('[B5] a partial pin is never resumed: a pinned state without S.base, or a pin without its policy flag, is base_state_missing', { skip: WIN_SKIP }, async (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  const saved = readFileSync(fx.stateFile(), 'utf8');
  fx.editState((s) => { delete s.base; });
  await assert.rejects(status(fx.ctx()), (e) => e.code === 'base_state_missing');
  assert.equal(fx.gate('reassess', {}).out?.code, 'base_state_missing');
  writeFileSync(fx.stateFile(), saved);
  fx.editState((s) => { s.policy_version = 1; });
  await assert.rejects(status(fx.ctx()), (e) => e.code === 'base_state_missing');
});

test('DAG: config.pinnedBase is exactly { remote: <name> } and needs config.base absent, HEAD or a branch name', async () => {
  const { validateEngineDag } = await import('./engine-dag.mjs');
  const dag = (config) => ({ schema: 'ship-ticket-engine-dag-v1', config: { provider: 'claude', timeoutMs: 120000, ...config }, nodes: [{ id: 'a', promptFile: 'p.txt' }] });
  assert.deepEqual(validateEngineDag(dag(PIN)).config.pinnedBase, { remote: 'origin' });
  assert.equal(validateEngineDag(dag({})).config.pinnedBase, undefined, 'never defaulted');
  for (const bad of [true, {}, { remote: '' }, { remote: '-x' }, { remote: 'origin', ref: 'main' }, { remote: 'a b' }, { remote: 'https://github.com/a/b' }])
    assert.throws(() => validateEngineDag(dag({ pinnedBase: bad })), (e) => e.code === 'dag_invalid', JSON.stringify(bad));
  for (const base of ['main', 'HEAD', 'release/1.2']) validateEngineDag(dag({ ...PIN, base }));
  for (const base of ['main..x', '-x', 3, ''])
    assert.throws(() => validateEngineDag(dag({ ...PIN, base })), (e) => e.code === 'dag_invalid', JSON.stringify(base));
});

// ------------------------------------------------------------------ Round 1: the pin is only as strong as its weakest read


test('[B6] a replace ref on the pinned commit never hides an out-of-plan file (every base-derived read is replace-immune)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  const B = fx.readState().base.merge_base;
  ok(fx.cli('drive'));
  mkdirSync(join(fx.repo, 'ops'), { recursive: true });
  writeFileSync(join(fx.repo, 'ops', 'deploy.txt'), 'outside the contract');
  o.git('add', 'ops/deploy.txt');
  o.git('commit', '-q', '-m', 'out of plan');
  // a commit with the branch tip's tree and B's parents, put in place of B: B now "contains" ops/deploy.txt
  const fake = o.git('commit-tree', 'HEAD^{tree}', '-p', `${B}^`, '-m', 'B, rewritten');
  o.git('replace', B, fake);
  const r = refused(fx.gate('reassess', {}), 'security_reapproval');
  assert.ok(r.out.reapproval_basis.some(b => b.path === 'ops/deploy.txt'), r.stdout);
});

test('[B7] grafts never rewrite base ancestry: a remote force-pushed to a sibling grafted onto the pin is still base_moved_remote', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  const B = fx.readState().base.sha;
  ok(fx.cli('drive'));
  const sibling = o.git('commit-tree', `${B}^{tree}`, '-p', `${B}^`, '-m', 'sibling of the pin');
  o.git('push', '-q', '--force', 'origin', `${sibling}:refs/heads/main`);
  o.fetch();
  writeFileSync(join(o.gitDir(), 'info', 'grafts'), `${sibling} ${B}\n`);
  refused(fx.gate('reassess', {}), 'base_moved_remote');
});

test('[B8] an inherited GIT_DIR (or any GIT_*) never redirects the pin to another checkout', { skip: WIN_SKIP }, (t) => {
  const a = baseFx(t, { config: PIN }), b = baseFx(t, { config: PIN });
  b.o.upstream(2);
  a.o.feature();
  const want = a.o.sha('origin/main');
  const saved = { ...process.env };
  try {
    process.env.GIT_DIR = b.o.gitDir();
    process.env.GIT_WORK_TREE = b.fx.repo;
    let pin;
    try { pin = pinBaseRecord(a.fx.repo, { pinnedBase: { remote: 'origin' }, base: 'main' }); } catch (e) { assert.fail(`the pin was redirected: ${e.code}: ${e.message}`); }
    assert.equal(pin.base.sha, want, 'the pin is the remote base of the repository given, not of GIT_DIR');
    assert.equal(pin.base.merge_base, want);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('[B9] a remote with no configured URL is refused (base_unverified), never read as a local path (an in-tree `origin` worktree)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  o.git('remote', 'remove', 'origin');
  o.git('worktree', 'add', '-q', 'origin', 'main');
  const r = fx.cli('init', { dag: fx.dagFile });
  initFails(r, 'base_unverified');
  assert.match(r.stderr, /no configured URL/);
  noState(fx);
});

test('[B10] a pinned state whose S.base is malformed (null, false, 0, \'\', [], partial, bad sha) is base_state_missing, never a local-base read', { skip: WIN_SKIP }, async (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  const good = fx.readState().base;
  const { sha: _s, ...noSha } = good;
  for (const bad of [null, false, 0, '', [], {}, noSha, { ...good, merge_base: 'main' }, { ...good, sha: 'HEAD' }, { ...good, pinned_at_seq: '1' }, { ...good, extra: 1 }]) {
    fx.editState((s) => { s.base = bad; });
    await assert.rejects(status(fx.ctx()), (e) => e.code === 'base_state_missing', JSON.stringify(bad));
    assert.equal(fx.gate('reassess', {}).out?.code, 'base_state_missing', JSON.stringify(bad));
  }
});

/** F-110-2: a pin field that is not a STRICT string is base_state_missing (a regexp test coerces an array or an object to the sha it spells). */
async function strictStringField(t, field) {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  ok(fx.cli('init', { dag: fx.dagFile }));
  const good = fx.readState().base, v = good[field];
  assert.equal(wellFormedBase(good), true, 'the recorded pin is well formed (the control)');
  for (const bad of [[v], [[v]]]) { // what state.json can carry
    fx.editState((s) => { s.base = { ...good, [field]: bad }; });
    await assert.rejects(status(fx.ctx()), (e) => e.code === 'base_state_missing', JSON.stringify(bad));
    assert.equal(fx.gate('reassess', {}).out?.code, 'base_state_missing', JSON.stringify(bad));
  }
  const nullProto = Object.assign(Object.create(null), { toString: () => v });
  for (const bad of [[v], new String(v), { toString: () => v }, { valueOf: () => v, toString: () => v }, nullProto, 1, null, undefined]) // what JSON cannot carry, at the validator
    assert.equal(wellFormedBase({ ...good, [field]: bad }), false, `${field}: ${Object.prototype.toString.call(bad)}`);
  assert.equal(wellFormedBase({ ...good, [field]: v }), true, `${field}: the plain string passes`);
}
test('[B13] F-110-2 S.base sha is a STRICT string (array, String object, toString/valueOf object, number, null-prototype object: base_state_missing)', { skip: WIN_SKIP }, (t) => strictStringField(t, 'sha'));
test('[B14] F-110-2 S.base merge_base is a STRICT string (same coercible values: base_state_missing)', { skip: WIN_SKIP }, (t) => strictStringField(t, 'merge_base'));

test('[B11] Neg4 a push URL of another repository is refused even when the fetch URL names no GitHub repository (a local path)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.feature();
  o.git('config', 'remote.origin.pushurl', 'https://github.com/evil/app.git');
  const r = fx.cli('init', { dag: fx.dagFile });
  initFails(r, 'remote_ambiguous');
  assert.match(r.stderr, /push URL of another repository/);
  noState(fx);
  o.git('config', 'remote.origin.pushurl', o.origin);
  ok(fx.cli('init', { dag: fx.dagFile }), 'a push URL equal to the fetch URL is fine');
});

test('[B12] Neg3 a ticket branch with no upstream is refused at init (base_unverified, no state)', { skip: WIN_SKIP }, (t) => {
  const { fx, o } = baseFx(t, { config: PIN });
  o.git('checkout', '-q', '-b', 'feature');
  const r = fx.cli('init', { dag: fx.dagFile });
  initFails(r, 'base_unverified');
  assert.match(r.stderr, /no upstream/);
  noState(fx);
});
