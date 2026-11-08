/**
 * Specs for AIS-HARNESS-3 Wave 2a (opt-in units). Threat model: accidental or buggy workers;
 * deliberately hostile dispatched code is out of scope. Rows drive the REAL engine through the
 * `node run-engine.mjs` CLI on a temp git repo with a fake provider CLI. Two rows use the exported
 * commands with an injected `groupAlive`, only to obtain a runner whose quiescence is unknown (no
 * POSIX process survives SIGKILL).
 *
 * ============================ CONTRACT ADDITIONS (Wave 2a) ============================
 * Golden: a v1 DAG without `unit`, `acceptance`, `checks` or `config.acceptanceIds` produces the
 *   same state, engine events, RUN-STATE events and command outputs as before Wave 2a
 *   (run-engine-units.golden.json, recorded on the pre-Wave-2a engine; volatile values normalized).
 * DAG: node `unit` (safe id), `acceptance` (AC ids), `checks` (config.testCommands names, needs
 *   `unit`); config `acceptanceIds`. Unknown check names, a check without a unit, an acceptance id
 *   outside config.acceptanceIds, an id of config.acceptanceIds mapped to no node (once any node
 *   has `acceptance`), acceptance without config.acceptanceIds, and a cycle between units are
 *   `dag_invalid` at init.
 * Checks: once every node of a unit is done, at a quiescent point (no attempt live) the engine
 *   runs the union of its nodes' `checks` under the runner protocol (attempt kind 'unit-check',
 *   the unit's resources as durable locks, retire()). A unit is `verified` only when every check
 *   exits 0. A node of another unit (or a unit-less node) waits until its dependency's unit is
 *   verified. A failing check marks the unit's nodes failed (node_failed) and reports
 *   `unit_check_failed`; `mark failed->pending` of one node re-runs that node (its retry), the
 *   other nodes failed only by the check return to done, and the checks run again.
 * Evidence: bound to the current fingerprints of the unit's reads and writes, the resolved
 *   config.base commit, every node's attempt count, every dependency unit's evidence and every
 *   transitive dependency node outside the unit (unit-less included: stale or failed = unverified),
 *   taken after the checks; a check changing any unit's declared files fails. Each unit is checked
 *   at most once per command, and every re-check counts as an invalidation first; the
 *   candidate id is recorded. Any change makes it stale (UNIT_INVALIDATED with a cause) together
 *   with the units of its dependent closure only, and the checks are re-run (a fingerprint refresh
 *   is never renewed evidence). A unit whose verified evidence is invalidated more than 2 times in
 *   one run raises `unit_invalidation_storm` instead of re-running.
 * Projection: `status.units` (only when the DAG has units) lists per unit its nodes, dependencies,
 *   acceptance ids, checks, current fingerprints and the evidence state verified|stale|failed|pending
 *   with its candidate id and invalidation causes. `gate review` and `gate ship-ready` refuse
 *   `units_unverified` while a unit is not verified.
 * =========================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, passReview, failReview, confirmReview, runStateEvents, runLogEvents } from './engine-test-fixture.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)';
const J = JSON.stringify;
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const GOLDEN = fileURLToPath(new URL('./run-engine-units.golden.json', import.meta.url));

// ------------------------------------------------------------------ golden no-change

/**
 * Replace values that differ between runs (temp root, timestamps, uuids, digests, commit hashes,
 * pids, process start times, launcher measurements) by stable placeholders, keeping the structure,
 * key order and equality pattern (the same digest maps to the same placeholder).
 */
function normalizer(root) {
  const maps = { sha: new Map(), hex: new Map(), uuid: new Map() };
  const tag = (kind, v) => { const m = maps[kind]; if (!m.has(v)) m.set(v, `<${kind}#${m.size + 1}>`); return m.get(v); };
  const str = (s) => s.split(root).join('<root>')
    .replace(/sha256[:-][0-9a-f]{64}/g, (m) => tag('sha', m.slice(7)))
    .replace(/\b[0-9a-f]{64}\b/g, (m) => tag('sha', m))
    .replace(/\b[0-9a-f]{40}\b/g, (m) => tag('hex', m))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => tag('uuid', m))
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<ts>');
  const VOLATILE = new Set(['pid', 'pgid', 'leader_start', 'nonce', 'process_start_time']);
  const walk = (v, key) => {
    if (VOLATILE.has(key) && v !== null && v !== undefined) return `<${key}>`;
    if (key === 'envelope' && v && typeof v === 'object') return Object.keys(v).sort(); // launcher measurements vary
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return (v) => walk(v);
}

/** A fixed v1 run with no unit fields: build, stale rebuild, FAIL review, repair, confirmation, ship-ready, resume. */
function goldenRun(t) {
  const fx = fixture(t, { commit: true,
    config: { width: 1, testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } },
    nodes: [{ id: 'a', reads: ['docs/in.txt'], writes: ['src/a.txt'] }, { id: 'b', deps: ['a'], reads: ['src/a.txt'], writes: ['src/b.txt'] },
      { id: 'c', writes: ['src/c.txt'] }],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } }, c: { write: { 'src/c.txt': 'c1' } },
      fix: { write: { 'src/a.txt': 'fixed' } } } });
  const outs = [];
  const step = (name, r) => { outs.push({ name, status: r.status, out: r.out }); return r; };
  step('init', fx.cli('init', { dag: fx.dagFile }));
  step('drive-1', fx.cli('drive'));
  step('status-1', fx.cli('status'));
  writeFileSync(`${fx.repo}/docs/in.txt`, 'input v2');
  step('drive-stale', fx.cli('drive'));
  step('review-fail', fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  step('drive-repair', fx.cli('drive'));
  step('confirm', fx.gate('review', confirmReview('rx-1', fx.candidate())));
  step('ship-ready', fx.gate('ship-ready', {}));
  step('resume', fx.cli('resume'));
  step('status-2', fx.cli('status'));
  return { fx, record: { outputs: outs, state: fx.readState(), engine_log: runLogEvents(fx.engineLog()), run_state: runStateEvents(fx.planFile) } };
}

test('golden: a v1 DAG without unit fields yields the pre-Wave-2a state, events and outputs', { skip: WIN_SKIP }, (t) => {
  const { fx, record } = goldenRun(t);
  const got = normalizer(fx.root)(record);
  assert.equal(got.outputs.find(o => o.name === 'ship-ready').status, 0, J(got.outputs.at(-3)));
  if (process.env.UPDATE_GOLDEN === '1') { writeFileSync(GOLDEN, J(got, null, 1) + '\n'); return; }
  assert.ok(existsSync(GOLDEN), 'golden file present');
  const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assert.equal(J(got, null, 1), J(want, null, 1), 'byte-identical after normalization');
  assert.equal(J(got).includes('unit'), false, 'no unit vocabulary leaks into a unit-less run');
});

// ------------------------------------------------------------------ helpers

const PASS = { cmd: process.execPath, args: ['-e', ''] };
/** A check that passes only when src/<file> holds `want`. */
const holds = (file, want) => ({ cmd: process.execPath, args: ['-e', `process.exit(require('fs').readFileSync('src/${file}','utf8')===${J(want)}?0:1)`] });
/** A check that waits until ../<flag> exists (outside the repo), writing its pid first. */
const waits = (flag) => ({ cmd: process.execPath, args: ['-e', `const fs=require('fs');fs.writeFileSync('../${flag}.pid',String(process.pid));`
  + `const t=setInterval(()=>{if(fs.existsSync('../${flag}')){clearInterval(t)}},50)`] });
const checkRuns = (fx, unit) => fx.readState().attempts.filter(a => a.kind === 'unit-check' && a.node === unit);
const unitEvents = (fx, type) => fx.readState().events.filter(e => e.type === type);
const node = (id, extra = {}) => ({ id, writes: [`src/${id}.txt`], ...extra });
const groupGone = (pgid) => { try { process.kill(-pgid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };

// ------------------------------------------------------------------ DAG validation

import { validateEngineDag } from './engine-dag.mjs';
import { schedule } from './harness.mjs';
import { resume } from './run-engine.mjs';
import { evaluateRun } from './eval.mjs';
import { buildRun } from './run-summary.mjs';
import { waitUntil } from './engine-test-fixture.mjs';

const dagOf = (nodes, config = {}) => ({ schema: 'ship-ticket-engine-dag-v1',
  config: { provider: 'claude', timeoutMs: 1000, testCommands: { ok: PASS }, ...config },
  nodes: nodes.map(n => ({ promptFile: '/p', ...n })) });
const invalid = (doc, re) => assert.throws(() => validateEngineDag(doc, { ticket: 'T-1' }), (e) => e.code === 'dag_invalid' && re.test(e.message));

test('DAG: unit fields are optional, validated, and never defaulted into nodes', () => {
  const plain = validateEngineDag(dagOf([{ id: 'a' }]), { ticket: 'T-1' });
  for (const k of ['unit', 'acceptance', 'checks']) assert.equal(k in plain.nodes[0], false, k);
  assert.equal('acceptanceIds' in plain.config, false);
  const v = validateEngineDag(dagOf([{ id: 'a', unit: 'api', checks: ['ok'], acceptance: ['AC1'] }, { id: 'b', deps: ['a'], unit: 'web', acceptance: ['AC2'] }],
    { acceptanceIds: ['AC1', 'AC2'] }), { ticket: 'T-1' });
  assert.deepEqual(v.nodes.map(n => n.unit), ['api', 'web']);
  invalid(dagOf([{ id: 'a', unit: 'api', checks: ['nope'] }]), /unknown check\(s\) nope/);
  invalid(dagOf([{ id: 'a', checks: ['ok'] }]), /checks need a unit/);
  invalid(dagOf([{ id: 'a', unit: '../x' }]), /unit must be a safe id/);
  invalid(dagOf([{ id: 'a', unit: 'a' }]), /collides/);
  invalid(dagOf([{ id: 'a', unit: 'ok' }]), /collides/);
  invalid(dagOf([{ id: 'a', acceptance: ['AC1'] }]), /needs config.acceptanceIds/);
  invalid(dagOf([{ id: 'a', acceptance: ['AC9'] }], { acceptanceIds: ['AC1', 'AC9'] }), /mapped to no node: AC1/);
  invalid(dagOf([{ id: 'a', acceptance: ['AC7'] }], { acceptanceIds: ['AC1'] }), /AC7 are not in config.acceptanceIds/);
  invalid(dagOf([{ id: 'a' }], { acceptanceIds: ['AC1'] }), /mapped to no node: AC1/);
  invalid(dagOf([{ id: 'a' }], { acceptanceIds: ['AC1', 'AC1'] }), /unique/);
  invalid(dagOf([{ id: 'a', unit: 'u1' }, { id: 'f', deps: ['a'] }, { id: 'b', deps: ['f'], unit: 'u1' }]), /units form a cycle/);
  invalid(dagOf([{ id: 'a', unit: 'u1' }, { id: 'b', deps: ['a'], unit: 'u2' }, { id: 'c', deps: ['b'], unit: 'u1' }]), /units form a cycle/);
});

test('init (CLI): an acceptance criterion of the plan mapped to no node is dag_invalid', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { acceptanceIds: ['AC1', 'AC2'], testCommands: { ok: PASS } },
    nodes: [node('a', { unit: 'api', acceptance: ['AC1'], checks: ['ok'] })] });
  const r = fx.cli('init', { dag: fx.dagFile });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /dag_invalid: acceptance criteria mapped to no node: AC2/);
  assert.equal(existsSync(fx.stateFile()), false, 'nothing is initialized');
});

// ------------------------------------------------------------------ checks gate done

test('checks: a failing unit check blocks done and every dependent; one mark re-runs one node and the checks', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { good: holds('a.txt', 'good'), ok: PASS } },
    nodes: [node('a', { unit: 'api', checks: ['good'] }), node('a2', { unit: 'api' }), node('b', { deps: ['a'], unit: 'web', checks: ['ok'] })],
    behaviour: { a: { write: { 'src/a.txt': 'bad' } }, a2: { write: { 'src/a2.txt': 'x' } }, b: { write: { 'src/b.txt': 'b' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.out.outcome, 'judgment');
  assert.deepEqual([r.out.nodes.a.state, r.out.nodes.a2.state, r.out.nodes.b.state], ['failed', 'failed', 'pending']);
  assert.ok(r.out.judgments.some(j => j.code === 'unit_check_failed' && j.node === 'api' && /good \(exit 1\)/.test(j.reason)), J(r.out.judgments));
  assert.ok(r.out.judgments.some(j => j.code === 'node_failed' && j.node === 'a'));
  assert.equal(r.out.units.api.state, 'failed');
  assert.equal(r.out.units.web.state, 'pending');
  assert.equal(fx.runs('b').length, 0, 'a dependent of an unverified unit never dispatches');
  const g = fx.gate('review', passReview('rx-1', fx.candidate()));
  assert.equal(g.out?.code, 'units_unverified', g.stdout);
  assert.equal(fx.cli('drive').status, 2, 'a failed check is never re-run on its own');
  assert.equal(checkRuns(fx, 'api').length, 1);
  fx.behave({ a: { write: { 'src/a.txt': 'good' } }, b: { write: { 'src/b.txt': 'b' } } });
  ok(fx.cli('mark', { node: 'a', transition: 'failed->pending', reason: 'retry after failed unit check' }));
  const st = fx.readState();
  assert.deepEqual([st.nodes.a.state, st.nodes.a2.state, st.nodes.a2.retries], ['pending', 'done', 0], 'only the marked node spends a retry');
  const d = fx.cli('drive');
  ok(d);
  assert.equal(d.out.outcome, 'done');
  assert.deepEqual([fx.runs('a').length, fx.runs('a2').length, fx.runs('b').length], [2, 1, 1]);
  assert.deepEqual(Object.values(d.out.units).map(u => u.state), ['verified', 'verified']);
  assert.equal(checkRuns(fx, 'api').length, 2, 'the node re-run made the evidence stale, so the checks ran again');
});

test('checks: a runner that cannot start is retried once (UNIT_CHECK_RETRY), then the unit fails; nothing more', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { missing: { cmd: 'definitely-not-a-command-ais3', args: [] } } },
    nodes: [node('a', { unit: 'api', checks: ['missing'] })] });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(checkRuns(fx, 'api').length, 2);
  assert.equal(unitEvents(fx, 'UNIT_CHECK_RETRY').length, 1);
  assert.equal(r.out.units.api.state, 'failed');
  assert.ok(checkRuns(fx, 'api').every(a => a.status === 'exited' && a.quiesced === true));
});

// ------------------------------------------------------------------ invalidation closure, projection, eval

function threeUnits(t) {
  return fixture(t, { commit: true, config: { testCommands: { ok: PASS }, acceptanceIds: ['AC1', 'AC2', 'AC3'] },
    nodes: [node('api', { unit: 'u-api', reads: ['docs/in.txt'], checks: ['ok'], acceptance: ['AC1'] }),
      node('web', { deps: ['api'], unit: 'u-web', reads: ['src/api.txt'], checks: ['ok'], acceptance: ['AC2'] }),
      node('other', { unit: 'u-other', checks: ['ok'], acceptance: ['AC3'] })],
    behaviour: { api: { write: { 'src/api.txt': 'api' } }, web: { write: { 'src/web.txt': 'web' } }, other: { write: { 'src/other.txt': 'o' } } } });
}

test('evidence: editing the contract a unit reads re-checks that unit and its dependents only; status and eval project each unit', { skip: WIN_SKIP }, (t) => {
  const fx = threeUnits(t);
  ok(fx.cli('init', { dag: fx.dagFile }));
  const first = fx.cli('drive');
  ok(first);
  assert.equal(first.out.outcome, 'done');
  const before = fx.cli('status').out.units;
  assert.deepEqual(Object.keys(before).sort(), ['u-api', 'u-other', 'u-web']);
  for (const u of Object.values(before)) assert.equal(u.state, 'verified');
  assert.deepEqual(before['u-web'].deps, ['u-api']);
  assert.deepEqual(before['u-web'].nodes, ['web']);
  assert.deepEqual(before['u-api'].acceptance, ['AC1']);
  assert.equal(before['u-api'].evidence.candidate_id.length, 64);
  assert.ok(before['u-api'].fingerprints['docs/in.txt'].startsWith('f:'));
  writeFileSync(`${fx.repo}/docs/in.txt`, 'contract v2');
  const stale = fx.cli('status').out.units;
  assert.deepEqual([stale['u-api'].state, stale['u-web'].state, stale['u-other'].state], ['stale', 'stale', 'verified']);
  assert.deepEqual(stale['u-api'].stale_cause.changed, ['docs/in.txt']);
  const second = fx.cli('drive');
  ok(second);
  assert.equal(second.out.outcome, 'done');
  assert.deepEqual(['u-api', 'u-web', 'u-other'].map(u => checkRuns(fx, u).length), [2, 2, 1]);
  assert.deepEqual(['api', 'web', 'other'].map(id => fx.runs(id).length), [2, 2, 1]);
  const inv = unitEvents(fx, 'UNIT_INVALIDATED');
  assert.deepEqual(inv.map(e => [e.unit, e.cause]), [['u-api', { changed: ['docs/in.txt'], rerun: ['api'] }], ['u-web', { dependency: 'u-api' }]]);
  const after = second.out.units;
  assert.ok(Object.values(after).every(u => u.state === 'verified'));
  assert.equal(after['u-other'].invalidations, 0);
  assert.equal(after['u-other'].evidence.id, before['u-other'].evidence.id, 'an unrelated unit keeps its evidence');
  assert.notEqual(after['u-web'].evidence.id, before['u-web'].evidence.id);
  const m = evaluateRun(buildRun('T-1', 'run-1', []), { state: fx.readState(), repoRoot: fx.repo });
  assert.deepEqual(Object.fromEntries(Object.entries(m.units).map(([u, x]) => [u, [x.state, x.invalidations]])),
    { 'u-api': ['verified', 1], 'u-other': ['verified', 0], 'u-web': ['verified', 1] });
  assert.equal('units' in evaluateRun(buildRun('T-1', 'run-1', []), { state: { ...fx.readState(), unit_checks: undefined } }), false);
  ok(fx.gate('review', passReview('rx-1', fx.candidate())), 'every unit verified: the review is accepted');
});

test('evidence: a review repair is re-checked (a fingerprint refresh is never renewed evidence)', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { good: holds('a.txt', 'a1'), ok: PASS } },
    nodes: [node('a', { unit: 'api', checks: ['good'] }), node('c', { unit: 'cli', checks: ['ok'] })],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, c: { write: { 'src/c.txt': 'c' } }, fix: { write: { 'src/a.txt': 'broken by repair' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(checkRuns(fx, 'api').length, 2, 'the repaired unit is re-checked');
  assert.equal(checkRuns(fx, 'cli').length, 1, 'an untouched unit is not');
  assert.equal(r.out.units.api.state, 'failed');
  assert.ok(r.out.judgments.some(j => j.code === 'unit_check_failed' && j.node === 'api'));
  assert.equal(r.out.nodes.a.state, 'done', 'after the freeze the nodes stay done; the judgment goes to the owner');
  assert.equal(fx.gate('review', confirmReview('rx-1', fx.candidate())).out?.code, 'units_unverified');
});

// ------------------------------------------------------------------ storm guard

test('storm: a unit invalidated a third time raises unit_invalidation_storm instead of re-running', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS } },
    nodes: [node('n', { unit: 'u', reads: ['docs/in.txt'], checks: ['ok'] }), node('o', { unit: 'v', checks: ['ok'] })],
    behaviour: { n: { write: { 'src/n.txt': 'n' } }, o: { write: { 'src/o.txt': 'o' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  for (const v of ['v2', 'v3']) { writeFileSync(`${fx.repo}/docs/in.txt`, v); ok(fx.cli('drive'), v); }
  assert.equal(checkRuns(fx, 'u').length, 3);
  writeFileSync(`${fx.repo}/docs/in.txt`, 'v4');
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const j = r.out.judgments.find(x => x.code === 'unit_invalidation_storm');
  assert.ok(j && j.node === 'u' && /3 times/.test(j.reason), J(r.out.judgments));
  assert.equal(checkRuns(fx, 'u').length, 3, 'no further check run');
  assert.equal(fx.runs('n').length, 3, 'no further rebuild');
  assert.equal(checkRuns(fx, 'v').length, 1);
  assert.deepEqual(unitEvents(fx, 'UNIT_INVALIDATED').map(e => [e.unit, e.invalidations, e.cause.changed?.[0]]),
    [['u', 1, 'docs/in.txt'], ['u', 2, 'docs/in.txt'], ['u', 3, 'docs/in.txt']]);
  assert.equal(r.out.units.u.causes.length, 3);
});

// ------------------------------------------------------------------ crash and resume

test('resume: after 3 of 5 units verified and the engine killed, only the rest is built and checked', { skip: WIN_SKIP }, async (t) => {
  const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const fx = fixture(t, { commit: true, config: { width: 1, testCommands: { ok: PASS } },
    nodes: ids.map(id => node(id, { unit: `u${id.slice(1)}`, checks: ['ok'] })),
    behaviour: Object.fromEntries(ids.map(id => [id, { write: { [`src/${id}.txt`]: id }, ...(id === 'n4' ? { waitFor: '../go-n4' } : {}) }])) });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const engine = fx.spawnCli('drive');
  const verified = () => Object.values(fx.readState().unit_checks).filter(r => r.evidence?.state === 'verified').length;
  assert.ok(await waitUntil(() => fx.runs('n4').length === 1 && verified() === 3, 20000), 'n4 started after three verified units');
  engine.kill('SIGKILL');
  await new Promise(r => engine.on('exit', r));
  writeFileSync(join(fx.root, 'go-n4'), '');
  const n4 = fx.readState().attempts.find(a => a.node === 'n4');
  assert.ok(await waitUntil(() => existsSync(n4.envelope_file), 10000), 'the surviving worker completed');
  ok(fx.cli('resume'));
  assert.equal(fx.readState().nodes.n4.state, 'done', 'resume recorded the surviving attempt');
  const d = fx.cli('drive');
  ok(d);
  assert.equal(d.out.outcome, 'done');
  assert.deepEqual(ids.map(id => fx.runs(id).length), [1, 1, 1, 1, 1]);
  assert.deepEqual(['u1', 'u2', 'u3', 'u4', 'u5'].map(u => checkRuns(fx, u).length), [1, 1, 1, 1, 1]);
  assert.ok(Object.values(d.out.units).every(u => u.state === 'verified'));
});

test('resume: an engine killed mid-check leaves a runner of unknown quiescence; once gone, resume clears it and drive re-checks', { skip: WIN_SKIP }, async (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { slow: waits('go-check') } },
    nodes: [node('a', { unit: 'api', checks: ['slow'] })] });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const engine = fx.spawnCli('drive');
  assert.ok(await waitUntil(() => checkRuns(fx, 'api').some(a => a.status === 'running') && existsSync(join(fx.root, 'go-check.pid')), 20000));
  engine.kill('SIGKILL');
  await new Promise(r => engine.on('exit', r));
  const unknown = await resume(fx.ctx({ groupAlive: () => null }));
  assert.ok(unknown.judgments.some(j => j.code === 'quiescence_unknown' && j.node === 'api'), J(unknown.judgments));
  assert.equal(unknown.units.api.state, 'pending', 'no evidence from a runner without proven quiescence');
  const live = fx.cli('drive');
  assert.notEqual(live.out?.outcome, 'done');
  const runner = checkRuns(fx, 'api')[0];
  writeFileSync(join(fx.root, 'go-check'), '');
  assert.ok(await waitUntil(() => groupGone(runner.pgid), 10000), 'the check runner exited');
  const res = fx.cli('resume');
  ok(res);
  assert.deepEqual(unitEvents(fx, 'RESUME').at(-1).cleared_judgments, [{ code: 'quiescence_unknown', node: 'api' }]);
  assert.equal(checkRuns(fx, 'api')[0].status, 'abandoned');
  const d = fx.cli('drive');
  ok(d);
  assert.equal(d.out.outcome, 'done');
  assert.equal(checkRuns(fx, 'api').length, 2);
  assert.equal(d.out.units.api.state, 'verified');
});

// ------------------------------------------------------------------ shared files across units

test('ownership: a node writing into another unit\'s file is an ownership_violation and stales only that unit', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS } },
    nodes: [node('y', { unit: 'u-y', checks: ['ok'] }), node('x', { deps: ['y'], unit: 'u-x', checks: ['ok'] }), node('z', { unit: 'u-z', checks: ['ok'] })],
    behaviour: { y: { write: { 'src/y.txt': 'y' } }, z: { write: { 'src/z.txt': 'z' } }, x: { write: { 'src/x.txt': 'x', 'src/y.txt': 'clobbered' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.judgments.some(j => j.code === 'ownership_violation' && j.node === 'x' && /src\/y.txt/.test(j.reason)));
  assert.deepEqual([r.out.units['u-y'].state, r.out.units['u-x'].state, r.out.units['u-z'].state], ['stale', 'pending', 'verified']);
  assert.deepEqual(r.out.units['u-y'].stale_cause, { changed: ['src/y.txt'] });
  const again = fx.cli('drive');
  assert.equal(again.status, 2);
  assert.deepEqual(unitEvents(fx, 'UNIT_INVALIDATED').map(e => [e.unit, e.cause]), [['u-y', { changed: ['src/y.txt'] }]]);
  assert.equal(checkRuns(fx, 'u-y').length, 1, 'no check re-run while the judgment stands');
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'units_unverified');
});

test('conflicts: nodes of different units with overlapping writes are never scheduled together', () => {
  const plain = (id, writes) => ({ id, deps: [], reads: [], writes, resources: [], risk: [], complexity: 'low', model: 'inherit', estimatedMemoryMb: 0 });
  const s = schedule({ phase: 'BUILD', nodes: [plain('x', ['src/shared.txt']), plain('y', ['src/shared.txt'])], maxConcurrency: 2, memoryBudgetMb: null });
  assert.deepEqual(s.waves.map(w => w.nodes.map(n => n.id ?? n)), [['x'], ['y']]);
});

// ------------------------------------------------------------------ Wave 2a repair (review findings)

/** A check that rewrites src/<file> with fresh bytes (only once ../<flag> exists, when given). */
const clobbers = (file, flag) => ({ cmd: process.execPath, args: ['-e', `const fs=require('fs');`
  + `if(${flag ? `fs.existsSync('../${flag}')` : 'true'})fs.writeFileSync('src/${file}','clobbered '+process.hrtime.bigint())`] });

test('repair: a check that writes another unit\'s file fails with the cause and the drive terminates (no re-check loop)', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS, clobber: clobbers('ua.txt') } },
    nodes: [node('ua', { unit: 'u-a', checks: ['ok'] }), node('ub', { deps: ['ua'], unit: 'u-b', checks: ['clobber'] })],
    behaviour: { ua: { write: { 'src/ua.txt': 'a' } }, ub: { write: { 'src/ub.txt': 'b' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const r = fx.cli('drive', {}, { timeout: 30000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const j = r.out.judgments.find(x => x.code === 'unit_check_failed' && x.node === 'u-b');
  assert.ok(j && /src\/ua.txt/.test(j.reason), J(r.out.judgments));
  assert.equal(checkRuns(fx, 'u-b').length, 1);
  assert.ok(checkRuns(fx, 'u-a').length <= 1, 'each unit is checked at most once per command');
});

test('repair: after the freeze a check that rewrites its own unit\'s files fails once and the drive terminates', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { self: clobbers('a.txt', 'flag') } },
    nodes: [node('a', { unit: 'api', checks: ['self'] })],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  writeFileSync(join(fx.root, 'flag'), '');
  const r = fx.cli('drive', {}, { timeout: 30000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.out.judgments.some(x => x.code === 'unit_check_failed' && /changed/.test(x.reason)), J(r.out.judgments));
  assert.equal(checkRuns(fx, 'api').length, 2);
  const again = fx.cli('drive', {}, { timeout: 30000 });
  assert.equal(again.status, 2);
  assert.equal(checkRuns(fx, 'api').length, 2, 'failed evidence bound to the post-check bytes is not re-run');
});

test('repair: a stale or failed unit-less dependency leaves the dependent unit unverified', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS } },
    nodes: [node('gen', { reads: ['docs/in.txt'] }), node('b', { deps: ['gen'], unit: 'u-b', checks: ['ok'] })],
    behaviour: { gen: { write: { 'src/gen.txt': 'g' } }, b: { write: { 'src/b.txt': 'b' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const first = fx.cli('drive');
  ok(first);
  assert.equal(first.out.units['u-b'].state, 'verified');
  writeFileSync(`${fx.repo}/docs/in.txt`, 'contract v2');
  assert.equal(fx.cli('status').out.units['u-b'].state, 'stale', 'an upstream input change is seen before any rebuild');
  ok(fx.cli('resume'));
  const st = fx.cli('status').out.units['u-b'];
  assert.equal(st.state, 'stale');
  assert.ok(st.stale_cause.upstream?.includes('gen'), J(st.stale_cause));
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).out?.code, 'units_unverified');
  fx.behave({ gen: { exit: 1 }, b: { write: { 'src/b.txt': 'b' } } });
  const failed = fx.cli('drive');
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.equal(failed.out.nodes.gen.state, 'failed');
  assert.notEqual(failed.out.units['u-b'].state, 'verified');
  assert.equal(fx.gate('review', passReview('rx-1', fx.candidate())).out?.code, 'units_unverified');
});

test('repair: unit ids such as constructor and toString work through init, drive and status; __proto__ is refused', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { testCommands: { ok: PASS } },
    nodes: [node('a', { unit: 'constructor', checks: ['ok'] }), node('b', { deps: ['a'], unit: 'toString', checks: ['ok'] })],
    behaviour: { a: { write: { 'src/a.txt': 'a' } }, b: { write: { 'src/b.txt': 'b' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const d = fx.cli('drive');
  ok(d);
  assert.equal(d.out.outcome, 'done');
  const s = fx.cli('status');
  ok(s);
  assert.deepEqual(Object.keys(s.out.units).sort(), ['constructor', 'toString']);
  assert.deepEqual(s.out.units.toString.deps, ['constructor']);
  assert.ok(Object.values(s.out.units).every(u => u.state === 'verified'));
  invalid(dagOf([{ id: 'a', unit: '__proto__' }]), /unit/);
});
