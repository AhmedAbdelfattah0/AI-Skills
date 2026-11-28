/**
 * PR-3 (STAB S4-min, plan §7 P6 / §8 P6): stage obligations instead of waivers, and plan-feasibility preflight. Every test
 * here is one §8 P6 negative (tagged [P6-Nx]) or its positive twin, written before the mechanism and shown RED on
 * origin/main 941d15e. The mechanism is opt-in: a DAG without `config.stagePolicy` keeps the frozen semantics ([P6-OFF], [P6-H*]).
 *
 * ============================ CONTRACT (S4-min, PROVISIONAL, UNQUALIFIED) ============================
 * stage-policy-v1 line (ONE visible line of the approved narrative, so the plan digest binds it): { merge_stage, stages[],
 *   rows[{id, check, stage, pair?}], deferred[{row, stage, environment, subject, required_evidence, trigger? | tracker_ref?}],
 *   artifacts?[] (exact .specs/ paths) }.
 * obligation: a deferred row becomes an OPEN obligation {row, check, verified_through: merge_stage, deferred_stage, environment,
 *   subject, required_evidence, trigger, tracker_ref, candidate, base, generation, status: 'open', lineage[]}. It is never a
 *   waiver and the Factory NEVER marks it verified: there is no verify command, no evidence ledger. It is closed outside the
 *   Factory, through its tracker_ref follow-up ticket's own acceptance (CI, exact-head review, merge).
 * preflight (= init): rows' stages exist or are declared deferred; a deferral names an unavailable stage only, never a 3a pair
 *   nor a check this run executes; trigger or tracker required; repository-required artifacts declared; every RED/proof spec
 *   NAMED verbatim by a formatted, non-evidence runner entry; every runner command executable; path signal pre-scan of planned
 *   writes (the existing security-plan classifier, unchanged).
 * The engine never writes an authority event (no SECURITY_WAIVER, no authorized_by).
 * ================================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as SP from './security-plan.mjs';
import { POSIX, fixture, passReview, failReview, confirmReview, runStateEvents, runLogEvents } from './engine-test-fixture.mjs';
import { preflight } from './run-engine.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX only (fake CLI and executable bits)';
const J = JSON.stringify;
const REAL = SP.loadCatalog();
const LINE = 'stage-policy-v1: ';
const stageLine = (p) => LINE + J(p);
const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
const initCode = (r) => (r.status === 0 ? 'ok' : /run-engine: (\w+):/.exec(r.stderr)?.[1] ?? r.stderr);
const rejects = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; }); };
const SO = () => import('./stage-obligations.mjs');

/** The 236 shape: local proof and the merge stage exist; the production RLS row has no environment in this run. */
const POLICY_236 = () => ({
  merge_stage: 'merge', stages: ['local', 'merge'],
  rows: [{ id: 'R1', check: 'unit + negative spec', stage: 'local' }, { id: 'R2', check: 'production RLS read-only probe', stage: 'production' }],
  deferred: [{ row: 'R2', stage: 'production', environment: 'production', subject: 'api release of this candidate',
    required_evidence: 'read-only probe output against production after deploy', tracker_ref: 'TRK-1' }],
});

// ---- a legacy (pre-cutoff, no security policy) run: enough for obligations and SHIP_READY ----
function stageRun(t, { policy = POLICY_236(), flag = true, line = true, extra = {}, ...rest } = {}) {
  return fixture(t, { commit: true, narrativeExtra: line ? stageLine(policy) + '\n\n' : '',
    config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } }, ...(flag ? { stagePolicy: { version: 1 } } : {}), ...extra }, ...rest });
}

// ---- a security policy 2 run (preflight needs one), with the stage line and extras ----
function realSelection() {
  const bools = Object.keys(REAL.catalog.fact_vocabulary).filter((k) => REAL.catalog.fact_vocabulary[k].type === 'bool');
  const facts = { ...Object.fromEntries(bools.map((b) => [b, false])), session_context: true };
  const surfaces = [{ boundary_id: 'orders', kind: 'request-handler', path: 'src/orders.ts', principals: ['staff'] },
    { boundary_id: 'forms', kind: 'server-input', path: 'src/forms.ts', principals: ['staff'] }];
  const sel = SP.selectControls(REAL, { security_policy: 2, surfaces, facts, evidence: Object.fromEntries(bools.map((b) => [b, 'src/orders.ts:handler'])) });
  assert.equal(sel.ok, true, J(sel));
  return sel;
}
const SPEC = 'spec/sec.test.mjs';
const UNIT = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' };
const specText = (list) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `for (const id of ${J(list)}) test(id, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
const LOCAL_ONLY = () => ({ merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [] });
function secRun(t, { policy, flag = true, nodes = [], config = {}, implFiles = {}, startAt } = {}) {
  const sel = realSelection();
  const cov = sel.pairs.map((p) => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC, name: p.pair_id }] }));
  const pol = policy === undefined ? LOCAL_ONLY() : policy;
  const fx = fixture(t, { commit: true, ...(startAt ? { startAt } : {}), narrativeExtra: SP.renderSection3a(sel) + '\n\n' + (pol === null ? '' : stageLine(pol) + '\n\n'),
    config: { width: 1, testCommands: { unit: UNIT }, securityPolicy: 2, catalogDigest: REAL.digest, controlCoverage: cov,
      ...(flag ? { stagePolicy: { version: 1 } } : {}), ...config },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap((c) => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }, ...nodes],
    behaviour: { api: { write: { [SPEC]: specText(cov.map((c) => `${c.boundary}:${c.control}`)) } }, impl: { write: { 'src/impl.txt': 'done', ...implFiles } } } });
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: fx.repo, encoding: 'utf8' });
  g('add', '-A'); assert.equal(g('commit', '-q', '-m', 'base').status, 0);
  return Object.assign(fx, { sel, pol });
}
const pf = (fx) => preflight({ repoRoot: fx.repo, ticket: 'T-1', dagFile: fx.dagFile });

/** init + drive + a passing review + SHIP_READY on the first candidate. */
function shipped(t, opts) {
  const fx = stageRun(t, opts);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  okc(fx.cli('drive'), 'drive');
  const cand = fx.candidate();
  okc(fx.gate('review', passReview('review-1', cand)), 'review');
  const sr = fx.gate('ship-ready', {});
  okc(sr, 'ship-ready');
  return { fx, cand, sr };
}

// =============================================================================================== obligations

test('[P6-N1] a deferral with no trigger and no tracker is refused (preflight and init); with a tracker or a trigger it binds an OPEN obligation', { skip: WIN_SKIP }, async (t) => {
  const bare = POLICY_236(); delete bare.deferred[0].tracker_ref;
  const fx = stageRun(t, { policy: bare });
  assert.equal(initCode(fx.cli('init', { dag: fx.dagFile })), 'obligation_trigger_missing');
  const sec = secRun(t, { policy: { ...bare, rows: [...bare.rows] } });
  await rejects(pf(sec), 'obligation_trigger_missing');
  const good = stageRun(t);
  okc(good.cli('init', { dag: good.dagFile }), 'init with a tracker');
  const ob = good.readState().stage.obligations;
  assert.deepEqual(ob.map((o) => [o.row, o.status, o.deferred_stage, o.verified_through, o.tracker_ref, o.candidate]), [['R2', 'open', 'production', 'merge', 'TRK-1', null]]);
  const trig = POLICY_236(); delete trig.deferred[0].tracker_ref; trig.deferred[0].trigger = 'production deploy workflow run';
  const tf = stageRun(t, { policy: trig });
  okc(tf.cli('init', { dag: tf.dagFile }), 'init with a trigger');
});

test('[P6-N2] resume keeps the deferral: a fresh process (status, drive, resume) still reports the obligation open', { skip: WIN_SKIP }, async (t) => {
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  okc(fx.cli('drive'), 'drive');
  const st = fx.cli('status');
  okc(st, 'status');
  assert.deepEqual(st.out.stage.obligations.map((o) => [o.row, o.status]), [['R2', 'open']]);
  const re = fx.cli('resume');
  assert.ok(re.status === 0 || re.status === 2, re.stderr);
  assert.deepEqual(fx.readState().stage.obligations.map((o) => [o.row, o.status]), [['R2', 'open']]);
});

test('[P6-236] replay: the production row ships as an open obligation; SHIP_READY covers the merge stage only; 0 SECURITY_WAIVER; no authority field written', { skip: WIN_SKIP }, async (t) => {
  const { fx, cand, sr } = shipped(t);
  assert.equal(sr.out.code, 'ship_ready');
  assert.deepEqual(sr.out.stage, { verified_through: 'merge', obligations_open: ['R2'] });
  const events = runStateEvents(fx.planFile);
  const ready = events.filter((e) => e.event === 'SHIP_READY');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].verified_through, 'merge');
  assert.deepEqual(ready[0].obligations_open, ['R2']);
  assert.equal(events.filter((e) => e.event === 'SECURITY_WAIVER').length, 0, '0 SECURITY_WAIVER');
  const all = [...events, ...runLogEvents(fx.engineLog())];
  assert.equal(all.filter((e) => e.event !== 'START' && 'authorized_by' in e).length, 0, 'the engine writes no authority field');
  assert.equal(all.filter((e) => /VERIFIED/.test(e.event ?? '')).length, 0, 'no verification event of any kind');
  const ob = fx.readState().stage.obligations[0];
  assert.equal(ob.status, 'open', 'SHIP_READY never verifies the deferred stage');
  assert.equal(ob.candidate, cand);
});

test('[P6-N3] a changed candidate (a repair; an in-run base move is PR-4b succession, through the same shipStage seam) re-binds the obligation, keyed by row: lineage kept, still open', { skip: WIN_SKIP }, async (t) => {
  const { fx, cand: c1 } = shipped(t);
  // the candidate changes through the engine's own path: an owner RETRY review (FAIL), its repair, the confirmation
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'review-2', predecessor: 'review-1', authorized_by: 'owner', reason: 'test: second candidate', timestamp: new Date().toISOString() });
  fx.behave({ a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } });
  okc(fx.gate('review', failReview('review-2', c1, 'src/a.txt', fx.prompt('fix'))), 'review 2 FAIL');
  okc(fx.cli('drive'), 'repair');
  const c2 = fx.candidate();
  assert.notEqual(c1, c2);
  okc(fx.gate('review', confirmReview('review-2', c2)), 'confirmation');
  const sr = fx.gate('ship-ready', {});
  okc(sr, 'ship-ready 2');
  assert.deepEqual(sr.out.stage, { verified_through: 'merge', obligations_open: ['R2'] });
  const ob = fx.readState().stage.obligations;
  assert.equal(ob.length, 1, 'one obligation per row, never a duplicate per candidate');
  assert.deepEqual([ob[0].row, ob[0].candidate, ob[0].status], ['R2', c2, 'open']);
  assert.deepEqual(ob[0].lineage.map((l) => [l.from, l.to]), [[c1, c2]]);
  const ready = runStateEvents(fx.planFile).filter((e) => e.event === 'SHIP_READY');
  assert.deepEqual(ready.map((e) => [e.candidate_id, e.obligations_open]), [[c1, ['R2']], [c2, ['R2']]]);
});

test('[P6-N4] the Factory has NO verify path: no command, gate input or state edit marks the deferred stage verified', { skip: WIN_SKIP }, async (t) => {
  const { fx } = shipped(t);
  const ev = join(fx.root, 'ev.json');
  writeFileSync(ev, J({ stage: 'production', result: 'pass', ref: 'gh-run-1' }));
  // the former S4 `obligation-verify` command does not exist (usage error, nothing written)
  const before = readFileSync(fx.stateFile());
  const v = fx.cli('obligation-verify', { id: 'R2', input: ev });
  assert.equal(v.status, 1, `no verify command: ${v.stdout}${v.stderr}`);
  assert.deepEqual(readFileSync(fx.stateFile()), before, 'state bytes unchanged');
  // no gate input carries a verification or a deferral
  for (const extra of [{ verified: ['R2'] }, { obligations: [] }, { deferred: [{ row: 'R1' }] }]) assert.equal(fx.gate('ship-ready', extra).status, 1, J(extra));
  // a state edit to `verified` (or any status but open) is never resumed
  for (const status of ['verified', 'waived', 'closed']) {
    const saved = readFileSync(fx.stateFile());
    fx.editState((s) => { s.stage.obligations[0].status = status; });
    assert.match(fx.cli('status').stderr, /stage_state_invalid/, status);
    writeFileSync(fx.stateFile(), saved);
  }
  okc(fx.cli('status'), 'restored');
  assert.equal(fx.readState().stage.obligations[0].status, 'open');
});

test('[P6-N5] a failed CURRENT-stage control can never be deferred: an available stage, the merge stage, a relabelled row, an in-run check or a 3a pair', { skip: WIN_SKIP }, async (t) => {
  const cur = POLICY_236(); cur.deferred.push({ row: 'R1', stage: 'local', environment: 'local', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' });
  const cf = stageRun(t, { policy: cur });
  assert.equal(initCode(cf.cli('init', { dag: cf.dagFile })), 'stage_deferral_invalid');
  const merge = POLICY_236(); merge.rows.push({ id: 'R4', check: 'CI', stage: 'merge' });
  merge.deferred.push({ row: 'R4', stage: 'merge', environment: 'ci', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' });
  const mf = stageRun(t, { policy: merge });
  assert.equal(initCode(mf.cli('init', { dag: mf.dagFile })), 'stage_deferral_invalid');
  const relabel = POLICY_236(); relabel.deferred.push({ row: 'R1', stage: 'production', environment: 'production', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' });
  const rf = stageRun(t, { policy: relabel });
  assert.equal(initCode(rf.cli('init', { dag: rf.dagFile })), 'stage_deferral_invalid');
  // a check this run executes (a testCommands entry) is a current-stage control even if the plan names a later stage for it
  const ran = POLICY_236(); ran.rows.push({ id: 'R5', check: 'proof', stage: 'production' });
  ran.deferred.push({ row: 'R5', stage: 'production', environment: 'production', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' });
  const rr = stageRun(t, { policy: ran });
  assert.equal(initCode(rr.cli('init', { dag: rr.dagFile })), 'stage_deferral_invalid');
  // a 3a catalog pair is proven by the engine at the merge stage: never deferrable
  const sec = secRun(t);
  const pair = `${sec.sel.pairs[0].boundary_id}:${sec.sel.pairs[0].control_id}`;
  const sp = secRun(t, { policy: { ...POLICY_236(), rows: [...POLICY_236().rows, { id: 'P1', check: pair, stage: 'production', pair }],
    deferred: [...POLICY_236().deferred, { row: 'P1', stage: 'production', environment: 'production', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' }] } });
  await rejects(pf(sp), 'stage_deferral_invalid');
  // a failed current-stage control stays a refusal at SHIP_READY (the local proof fails): no obligation absorbs it
  const red = stageRun(t, { extra: { testCommands: { proof: { cmd: process.execPath, args: ['-e', 'process.exit(1)'] } } } });
  okc(red.cli('init', { dag: red.dagFile }), 'init');
  okc(red.cli('drive'), 'drive');
  okc(red.gate('review', passReview('review-1', red.candidate())), 'review');
  const sr = red.gate('ship-ready', {});
  assert.notEqual(sr.status, 0, 'a failed local proof is never shipped');
  assert.equal(runStateEvents(red.planFile).filter((e) => e.event === 'SHIP_READY').length, 0);
  assert.equal(runStateEvents(red.planFile).filter((e) => e.event === 'SECURITY_WAIVER').length, 0);
});

test('[P6-N0] a row whose stage does not exist must be declared deferred; the stage policy must be in the approved narrative', { skip: WIN_SKIP }, async (t) => {
  const undeclared = POLICY_236(); undeclared.deferred = [];
  const fx = stageRun(t, { policy: undeclared });
  assert.equal(initCode(fx.cli('init', { dag: fx.dagFile })), 'stage_unavailable');
  const missing = stageRun(t, { line: false });
  assert.equal(initCode(missing.cli('init', { dag: missing.dagFile })), 'stage_policy_missing');
  const two = fixture(t, { commit: true, narrativeExtra: `${stageLine(POLICY_236())}\n${stageLine(POLICY_236())}\n\n`, config: { testCommands: {}, stagePolicy: { version: 1 } } });
  assert.equal(initCode(two.cli('init', { dag: two.dagFile })), 'stage_policy_invalid');
  for (const extra of [{ surprise: 1 }, { no_runtime_boundary: true }]) {
    const bad = stageRun(t, { policy: { ...POLICY_236(), ...extra } });
    assert.equal(initCode(bad.cli('init', { dag: bad.dagFile })), 'stage_policy_invalid', J(extra));
  }
  const flagOnly = fixture(t, { commit: true, bind: 'dag_bound', narrativeExtra: '', config: { testCommands: {}, stagePolicy: { version: 1 } } });
  assert.equal(initCode(flagOnly.cli('init', { dag: flagOnly.dagFile })), 'stage_policy_missing');
  for (const bad of [true, { version: 2 }, { version: 1, extra: 1 }]) {
    const f = fixture(t, { commit: true, config: { testCommands: {}, stagePolicy: bad } });
    assert.equal(initCode(f.cli('init', { dag: f.dagFile })), 'dag_invalid', J(bad));
  }
});

test('[P6-W8b] residual, disclosed: a plan that omits a stage that exists can defer its row; only owner approval of the visible line controls it, and preflight echoes the stages and deferrals', { skip: WIN_SKIP }, async (t) => {
  // the run has a local stage, but the plan lists only `merge`: the engine cannot know which named stages exist
  const omit = { merge_stage: 'merge', stages: ['merge'], rows: [{ id: 'R1', check: 'manual local smoke', stage: 'local' }],
    deferred: [{ row: 'R1', stage: 'local', environment: 'dev', subject: 's', required_evidence: 'e', tracker_ref: 'TRK-8' }] };
  const r = await pf(secRun(t, { policy: omit }));
  assert.equal(r.code, 'preflight_ok', 'W8b: accepted (plan-asserted stage availability)');
  assert.deepEqual(r.stage.stages, ['merge']);
  assert.deepEqual(r.stage.deferrals, [{ row: 'R1', deferred_stage: 'local', trigger: null, tracker_ref: 'TRK-8' }]);
  // W8a stays closed: a check this run itself executes is never deferred, whatever stages the plan lists
  const own = { ...omit, rows: [{ id: 'R1', check: 'unit', stage: 'local' }] };
  await rejects(pf(secRun(t, { policy: own })), 'stage_deferral_invalid');
});

// =============================================================================================== preflight

test('[P6-N6a] 124 v1 plan: a UI run whose plan omits the parity artifact is refused BEFORE approval (preflight) and at init; declared, it passes', { skip: WIN_SKIP }, async (t) => {
  const v1 = secRun(t, { config: { riskLabels: ['ui'] } });
  await rejects(pf(v1), 'required_artifact_outside_contract');
  assert.equal(initCode(v1.cli('init', { dag: v1.dagFile })), 'required_artifact_outside_contract', 'init runs the same check (preflight is not optional)');
  const v2 = secRun(t, { policy: { ...LOCAL_ONLY(), artifacts: ['.specs/design-parity/T-1.md'] }, config: { riskLabels: ['ui'] } });
  assert.equal((await pf(v2)).code, 'preflight_ok');
  for (const a of ['src/anything.ts', '.specs/plans/T-1.md', '.specs/**', '.specs/design-parity/T-?.md', '.specs/../src/x.md'])
    await rejects(pf(secRun(t, { policy: { ...LOCAL_ONLY(), artifacts: [a] } })), 'stage_policy_invalid');
});

test('[P6-N6a2] a declared artifact is inside the Design Contract at reassess (no sticky REAPPROVAL from the parity file)', { skip: WIN_SKIP }, async (t) => {
  const fx = secRun(t, { policy: { ...LOCAL_ONLY(), artifacts: ['.specs/design-parity/T-1.md'] }, config: { riskLabels: ['ui'] } });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive');
  mkdirSync(join(fx.repo, '.specs', 'design-parity'), { recursive: true }); writeFileSync(join(fx.repo, '.specs', 'design-parity', 'T-1.md'), '# parity\n');
  const r = fx.gate('reassess', {});
  assert.equal(r.out?.code, 'reassessed', r.stdout);
});

test('[P6-N6b] 124 RED for a new client file: a RED spec no runner entry NAMES is refused before approval; directory, glob or unformatted reach is unproven; a runner that is not executable is refused', { skip: WIN_SKIP }, async (t) => {
  const SPECF = 'apps/admin/src/settings.service.spec.ts';
  const client = { id: 'client', deps: [], writes: ['apps/admin'], redSpecs: [{ file: SPECF, name: 'loads settings' }] };
  const run = (cfg) => pf(secRun(t, { nodes: [client], ...(cfg ? { config: { testCommands: { unit: UNIT, ...cfg } } } : {}) }));
  await rejects(run(), 'red_runner_missing');
  assert.equal((await run({ client: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPECF], format: 'tap' } })).code, 'preflight_ok', 'named verbatim');
  // reach that would need a selector parser (directory, glob, a prefix) is refused as unproven, never guessed
  for (const arg of ['apps/admin', 'apps/admin/**/*.spec.ts', 'apps/admin/src/settings.servic?.spec.ts', `./${SPECF}`])
    await rejects(run({ client: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', arg], format: 'tap' } }), 'red_runner_missing');
  // an unformatted entry naming the spec is not a RED runner (RED parses formatted output), nor is an evidence entry
  await rejects(run({ client: { cmd: process.execPath, args: ['--test', SPECF] } }), 'red_runner_missing');
  // a declared coverage list is not a stage-policy field (coverage is never declared)
  await rejects(pf(secRun(t, { policy: { ...LOCAL_ONLY(), runners: { unit: ['apps/admin/**'] } }, nodes: [client] })), 'stage_policy_invalid');
  // executability: a relative script that does not exist, one without the executable bit, a name on no PATH entry
  const lint = { unit: UNIT, lint: { cmd: './scripts/lint.sh', args: [] } };
  await rejects(pf(secRun(t, { config: { testCommands: lint } })), 'runner_not_executable');
  const noexec = secRun(t, { config: { testCommands: lint } });
  mkdirSync(join(noexec.repo, 'scripts'), { recursive: true }); writeFileSync(join(noexec.repo, 'scripts', 'lint.sh'), '#!/bin/sh\nexit 0\n'); chmodSync(join(noexec.repo, 'scripts', 'lint.sh'), 0o644);
  await rejects(pf(noexec), 'runner_not_executable');
  chmodSync(join(noexec.repo, 'scripts', 'lint.sh'), 0o755);
  assert.equal((await pf(noexec)).code, 'preflight_ok');
  await rejects(pf(secRun(t, { config: { testCommands: { unit: UNIT, lint: { cmd: 'no-such-binary-s4', args: [] } } } })), 'runner_not_executable');
});

test('[P6-N6d] review R1 MAJOR-1: a stage run with no test command at all is refused at preflight AND init (the local proof needs one), with or without RED specs', { skip: WIN_SKIP }, async (t) => {
  for (const testCommands of [{}, undefined]) {
    const bare = stageRun(t, { extra: { testCommands } });
    assert.equal(initCode(bare.cli('init', { dag: bare.dagFile })), 'proof_runner_missing', `init, testCommands ${J(testCommands)}`);
  }
  // a security run whose evidenced assessment selects no pair ([] controlCoverage) and has no RED spec: only PR-3 refuses it
  const bools = Object.keys(REAL.catalog.fact_vocabulary).filter((k) => REAL.catalog.fact_vocabulary[k].type === 'bool');
  const sel = SP.selectControls(REAL, { security_policy: 2, surfaces: [], facts: Object.fromEntries(bools.map((b) => [b, false])), evidence: Object.fromEntries(bools.map((b) => [b, 'README.md:none'])) });
  assert.equal(sel.ok, true, J(sel));
  const none = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(sel) + '\n\n' + stageLine(LOCAL_ONLY()) + '\n\n',
    config: { width: 1, testCommands: {}, securityPolicy: 2, catalogDigest: REAL.digest, controlCoverage: [], stagePolicy: { version: 1 } } });
  await rejects(pf(none), 'proof_runner_missing');
  assert.equal(initCode(none.cli('init', { dag: none.dagFile })), 'proof_runner_missing');
});

test('[P6-N6e] review R1 MAJOR-2: ONE eligible runner must name EVERY spec pinned to a RED node (gate red runs one runner per invocation); two runners splitting a node\'s specs are refused at preflight AND init', { skip: WIN_SKIP }, async (t) => {
  const A = 'apps/admin/a.test.mjs', B = 'apps/admin/b.test.mjs';
  const node = { id: 'client', deps: [], writes: ['apps/admin'], redSpecs: [{ file: A, name: 'a' }, { file: B, name: 'b' }] };
  const r = (files) => ({ cmd: process.execPath, args: ['--test', '--test-reporter=tap', ...files], format: 'tap' });
  const split = () => secRun(t, { nodes: [node], config: { testCommands: { unit: UNIT, redA: r([A]), redB: r([B]) } } });
  await rejects(pf(split()), 'red_runner_missing');
  const s2 = split();
  assert.equal(initCode(s2.cli('init', { dag: s2.dagFile })), 'red_runner_missing');
  assert.equal((await pf(secRun(t, { nodes: [node], config: { testCommands: { unit: UNIT, redAB: r([A, B]) } } }))).code, 'preflight_ok', 'one runner naming both');
  // a runner that names the set but is not executable is not eligible (the other entry is refused as not executable too)
  await rejects(pf(secRun(t, { nodes: [node], config: { testCommands: { unit: UNIT, redAB: { ...r([A, B]), cmd: './missing-runner' } } } })), 'red_runner_missing');
});

test('[P6-N6c] signal pre-scan of planned writes (the existing classifier): a file-shaped route write with no surface is refused before approval; the pre-scan is printed', { skip: WIN_SKIP }, async (t) => {
  await rejects(pf(secRun(t, { nodes: [{ id: 'route', deps: [], writes: ['src/routes/admin.ts'] }] })), 'surface_inventory_incomplete');
  const r = await pf(secRun(t, { nodes: [{ id: 'dep', deps: [], writes: ['package.json'] }] }));
  assert.equal(r.code, 'preflight_ok');
  assert.deepEqual(r.stage.signal_prescan, [{ path: 'package.json', kinds: ['new-dependency'] }]);
});

test('[P6-124route] 124 new-route false positive is a documented Blocked on a stage run: `this.api.get(` stays unclassified; no disposition input exists', { skip: WIN_SKIP }, async (t) => {
  const fx = secRun(t, { implFiles: { 'src/settings.service.ts': 'export class S { load() { return this.api.get(); } }\n' } });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive');
  const r = fx.gate('reassess', {});
  assert.equal(r.out?.code, 'reassess_unclassified', r.stdout);
  assert.equal(fx.gate('reassess', { dispositions: [] }).status, 1, 'no disposition field (S4 classifier work is stopped)');
});

test('[P6-OFF] without config.stagePolicy every frozen semantics holds: preflight output, init state, SHIP_READY, policy version', { skip: WIN_SKIP }, async (t) => {
  const fx = secRun(t, { flag: false, policy: null, config: { riskLabels: ['ui'] } });
  const r = await pf(fx);
  assert.equal(r.code, 'preflight_ok', 'the frozen preflight does not know the parity artifact');
  assert.equal('stage' in r, false);
  const lg = stageRun(t, { flag: false, line: true });
  okc(lg.cli('init', { dag: lg.dagFile }), 'init');
  const st = lg.readState();
  assert.equal('stage' in st, false, 'an approved line without the flag binds nothing');
  assert.ok(st.policy_version >= 1 && st.policy_version <= 24, `non-stage run keeps its core version (${st.policy_version})`);
  okc(lg.cli('drive'), 'drive');
  okc(lg.gate('review', passReview('review-1', lg.candidate())), 'review');
  const sr = lg.gate('ship-ready', {});
  okc(sr, 'ship-ready');
  assert.equal('stage' in sr.out, false);
  const ready = runStateEvents(lg.planFile).find((e) => e.event === 'SHIP_READY');
  assert.deepEqual(Object.keys(ready).sort(), ['candidate_id', 'event', 'event_id', 'run_id', 'timestamp'], 'SHIP_READY fields unchanged');
  assert.equal('stage' in lg.cli('status').out, false);
});

test('[P6-H1..H3,H5] frozen hazards stay frozen without the flag: parity artifact, runner reach, missing command, sticky REAPPROVAL', { skip: WIN_SKIP }, async (t) => {
  assert.equal((await pf(secRun(t, { flag: false, policy: null, config: { riskLabels: ['ui'] } }))).code, 'preflight_ok', 'H1');
  assert.equal((await pf(secRun(t, { flag: false, policy: null, nodes: [{ id: 'client', deps: [], writes: ['apps/admin'], redSpecs: [{ file: 'apps/admin/src/settings.service.spec.ts', name: 'loads settings' }] }] }))).code, 'preflight_ok', 'H2');
  assert.equal((await pf(secRun(t, { flag: false, policy: null, config: { testCommands: { unit: UNIT, lint: { cmd: './scripts/lint.sh', args: [] } } } }))).code, 'preflight_ok', 'H3');
  const fx = secRun(t, { flag: false, policy: null });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive');
  mkdirSync(join(fx.repo, '.specs', 'design-parity'), { recursive: true }); writeFileSync(join(fx.repo, '.specs', 'design-parity', 'T-1.md'), '# parity\n');
  assert.equal(fx.gate('reassess', {}).out?.code, 'security_reapproval', 'H5');
});

test('[P6-DOWN] downstream readers accept a shipped stage run: ship-ready-check, the accepted view, archive', { skip: WIN_SKIP }, async (t) => {
  const { checkShipReady } = await import('./ship-ready-check.mjs');
  const { readRun } = await import('./engine-accepted.mjs');
  const { fx, cand } = shipped(t);
  const chk = checkShipReady(readFileSync(fx.planFile, 'utf8'), readFileSync(fx.engineLog(), 'utf8'), { requireEvent: true, runId: 'run-1' });
  assert.equal(chk.ok, true, J(chk));
  const v = await readRun({ repoRoot: fx.repo, ticket: 'T-1', runId: 'run-1' });
  assert.equal(v.exists, true, J(v).slice(0, 2000));
  assert.equal(v.error, undefined, J(v.error));
  assert.equal(v.candidate.id, cand);
  assert.deepEqual(v.blockers, [], J(v.blockers));
  const sr = v.phases.find((p) => p.phase === 'SHIP_READY');
  assert.equal(sr.state, 'accepted', J(sr));
  const a = fx.cli('archive');
  okc(a, 'archive');
  assert.deepEqual(JSON.parse(readFileSync(join(a.out.archive, 'state.json'), 'utf8')).stage.obligations.map((o) => [o.row, o.status]), [['R2', 'open']]);
});

// =============================================================================================== state binding

test('[P6-N8] a flagged run whose state lost its stage record never resumes (no SHIP_READY without the obligations)', { skip: WIN_SKIP }, async (t) => {
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  fx.editState((s) => { delete s.stage; });
  const st = fx.cli('status');
  assert.notEqual(st.status, 0);
  assert.match(st.stderr, /stage_state_missing/);
  const sr = fx.gate('ship-ready', {});
  assert.equal(sr.out?.code ?? (/stage_state_missing/.test(sr.stderr) ? 'stage_state_missing' : sr.stdout), 'stage_state_missing');
  assert.equal(runStateEvents(fx.planFile).filter((e) => e.event === 'SHIP_READY').length, 0);
});

test('[P6-R1] the stage record is checked against the retained approved line on EVERY load: a dropped, added or edited obligation is never resumed', { skip: WIN_SKIP }, async (t) => {
  const tamper = [
    ['obligations emptied', (st) => { st.stage.obligations = []; }],
    ['obligation added', (st) => { st.stage.obligations.push({ ...st.stage.obligations[0], row: 'R9' }); }],
    ['stages widened', (st) => { st.stage.stages = [...st.stage.stages, 'production']; }],
    ['artifacts widened', (st) => { st.stage.artifacts = ['.specs/x.md']; }],
    ['required_evidence edited', (st) => { st.stage.obligations[0].required_evidence = 'nothing'; }],
    ['tracker edited', (st) => { st.stage.obligations[0].tracker_ref = 'TRK-other'; }],
    ['policy digest edited', (st) => { st.stage.policy_digest = 'sha256:' + '0'.repeat(64); }],
    ['extra field', (st) => { st.stage.verifications = []; }],
    ['lineage malformed', (st) => { st.stage.obligations[0].lineage = [{}]; }],
  ];
  for (const [what, edit] of tamper) {
    const fx = stageRun(t);
    okc(fx.cli('init', { dag: fx.dagFile }), 'init');
    fx.editState(edit);
    const st = fx.cli('status');
    assert.notEqual(st.status, 0, what);
    assert.match(st.stderr, /stage_state_invalid/, `${what}: ${st.stderr}`);
    assert.notEqual(fx.gate('ship-ready', {}).status, 0, what);
    assert.equal(runStateEvents(fx.planFile).filter((e) => e.event === 'SHIP_READY').length, 0, what);
  }
  // the mutable part stays mutable: the engine's own binding loads fine
  const { fx } = shipped(t);
  okc(fx.cli('status'), 'status after binding');
});

test('[P6-R1b] every owner command compares the retained line with the approved narrative: a consistently re-forged record (line + record) is refused at the binding', { skip: WIN_SKIP }, async (t) => {
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  const { parseStagePolicy, initialStage } = await SO(); // after the behavioural step: on an engine without PR-3, init fails first
  fx.editState((st) => { const p = POLICY_236(); p.deferred[0].tracker_ref = 'TRK-forged'; st.stage = initialStage(parseStagePolicy(stageLine(p))); });
  okc(fx.cli('status'), 'a self-consistent forged record loads (state alone cannot tell; same-user bound D1)');
  const g = fx.gate('ship-ready', {});
  assert.equal(g.out?.code, 'stage_policy_mismatch', g.stdout);
});

test('[P6-R1c] the stage binding check does not shadow the security-policy binding check (security_policy_required stays reachable)', { skip: WIN_SKIP }, async (t) => {
  // a post-cutoff stage run whose resumed state lost config.securityPolicy: the binding re-check must still refuse it
  const fx = secRun(t, { startAt: '2026-11-20T00:00:00Z' });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  fx.editState((s) => { delete s.config.securityPolicy; });
  const g = fx.gate('ship-ready', {});
  assert.equal(g.out?.code, 'security_policy_required', g.stdout + g.stderr);
});

test('[P6-R3] a stage run records a distinguishable policy version (core v+24); an engine without PR-3 refuses to resume it; early checks compose (+100)', { skip: WIN_SKIP }, async (t) => {
  const POL = await import('./engine-policy.mjs');
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  const v = fx.readState().policy_version;
  assert.ok(v >= 25 && v <= 48, `stage run version ${v}`);
  assert.deepEqual(POL.POLICY_SEMANTICS[v], { ...POL.POLICY_SEMANTICS[v - 24], stageObligations: true });
  for (let w = 1; w <= 24; w++) {
    assert.deepEqual(POL.POLICY_SEMANTICS[w + 24], { ...POL.POLICY_SEMANTICS[w], stageObligations: true }, `v${w + 24}`);
    assert.equal(POL.POLICY_SEMANTICS[w].stageObligations, undefined);
    assert.deepEqual(POL.POLICY_SEMANTICS[w + 124], { ...POL.POLICY_SEMANTICS[w], stageObligations: true, earlyChecks: true }, `v${w + 124}`);
    assert.equal(POL.earlyChecksVersion(POL.stageVersion(w)), w + 124, 'stage then early checks');
  }
  assert.equal(POL.stageVersion(25), null, 'no double stage flag');
  assert.equal(POL.stageVersion(101), null, 'stage applies to a core version only (early checks come last)');
  const before = { current: 1, semantics: POL.withEarlyChecksTwins(Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, POL.POLICY_SEMANTICS[i + 1]]))) };
  assert.throws(() => POL.runPolicy({ policy_version: v }, before), (e) => e.code === 'policy_version_unsupported');
  const { status } = await import('./run-engine.mjs');
  await rejects(status(fx.ctx({ policy: before })), 'policy_version_unsupported');
  const plain = stageRun(t, { flag: false, line: false });
  okc(plain.cli('init', { dag: plain.dagFile }), 'init plain');
  assert.ok(plain.readState().policy_version <= 24, 'a non-stage run keeps its core version');
  plain.editState((st) => { st.policy_version += 24; });
  assert.match(plain.cli('status').stderr, /stage_state_missing/, 'version and stage record come together');
});

test('[P6-R4] the approved stage line must be visible (not in an HTML comment or code fence, under either lexing order); preflight echoes the authorizing fields', { skip: WIN_SKIP }, async (t) => {
  // behavioural first: init refuses a stage line hidden in an HTML comment (an engine without PR-3 gives dag_invalid instead)
  const hidden = fixture(t, { commit: true, narrativeExtra: `<!--\n${stageLine(POLICY_236())}\n-->\n\n`, config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } }, stagePolicy: { version: 1 } } });
  assert.equal(initCode(hidden.cli('init', { dag: hidden.dagFile })), 'stage_policy_invalid');
  const { parseStagePolicy } = await SO();
  const L = stageLine(POLICY_236());
  const code = (n) => { try { parseStagePolicy(n, { ticket: 'T-1' }); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(`x\n${L}\n`), 'ok');
  for (const [what, n] of [['comment', `<!--\n${L}\n-->\n`], ['fence', `\`\`\`\n${L}\n\`\`\`\n`], ['hidden second line', `${L}\n<!--\n${L}\n-->\n`],
    ['unterminated comment', `<!-- open\n${L}\n`], ['1-space fence', ` \`\`\`\n${L}\n \`\`\`\n`], ['3-space fence', `   \`\`\`js\n${L}\n   \`\`\`\n`],
    ['4-backtick with inner ```', `\`\`\`\`\n\`\`\`\n${L}\n\`\`\`\`\n`], ['~~~~ closed only by ~~~~', `~~~~\n~~~\n${L}\n~~~~\n`], ['unterminated ````', `\`\`\`\`\n${L}\n`],
    ['a backtick fence is not closed by tildes', `\`\`\`\n~~~\n${L}\n`],
    // R2 MINOR-2: a `<!--` in a code span and its `-->` inside a fence must not erase the fence opener
    ['comment markers straddling a fence', `see \`<!--\` here\n\`\`\`\n-->\n${L}\n\`\`\`\n`]])
    assert.equal(code(`x\n${n}`), 'stage_policy_invalid', what);
  assert.equal(code(`x\n\`\`\`\`\ncode\n\`\`\`\`\`\n${L}\n`), 'ok', 'a longer closer closes');
  assert.equal(code(`x\n~~~\ncode\n~~~\n${L}\n`), 'ok');
  assert.equal(code(`x\n    \`\`\`\n${L}\n`), 'ok', 'four spaces: an indented code line, not a fence opener');
  const r = await pf(secRun(t, { policy: POLICY_236() }));
  assert.deepEqual(r.stage.stages, ['local', 'merge']);
  assert.equal(r.stage.merge_stage, 'merge');
  assert.deepEqual(r.stage.obligations, ['R2']);
  assert.deepEqual(r.stage.deferrals, [{ row: 'R2', deferred_stage: 'production', trigger: null, tracker_ref: 'TRK-1' }]);
});

test('[P6-R2d] a foreign-worktree command (the deadline sweep from main after the owning worktree is gone) never reads the caller\'s plan', { skip: WIN_SKIP }, async (t) => {
  for (const staged of [false, true]) {
    const fx = stageRun(t, { flag: staged, line: staged });
    const plan = readFileSync(fx.planFile, 'utf8');
    const wt = join(fx.root, 'feature');
    assert.equal(spawnSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: fx.repo }).status, 0);
    mkdirSync(join(wt, '.specs', 'plans'), { recursive: true }); writeFileSync(join(wt, '.specs', 'plans', 'T-1.md'), plan);
    const cli = (repo, ...a) => spawnSync(process.execPath, [fileURLToPath(new URL('./run-engine.mjs', import.meta.url)), ...a, '--repo', repo, '--ticket', 'T-1', '--run-id', 'run-1'], { encoding: 'utf8', env: fx.env, timeout: 60000 });
    const i = cli(wt, 'init', '--dag', fx.dagFile); assert.equal(i.status, 0, i.stderr);
    assert.equal(spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: fx.repo }).status, 0);
    rmSync(fx.planFile); // the ticket's plan lives on the feature branch, not in the main checkout
    const sweep = cli(fx.repo, 'reconcile', '--deadlines', 'true');
    assert.equal(sweep.status, 0, `stage=${staged}: ${sweep.stderr}`);
  }
});
