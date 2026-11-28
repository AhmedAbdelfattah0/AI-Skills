/**
 * STAB S4 (P6): stage obligations, plan-feasibility preflight and the classifier "no runtime boundary" disposition.
 * Every test here is one §8 P6 negative (tagged [P6-Nx]) or its positive twin, written before the mechanism and
 * shown RED on the frozen tree (83c731a). The mechanism is opt-in: a DAG without `config.stagePolicy` keeps the
 * frozen semantics byte for byte ([P6-OFF]).
 *
 * ============================ CONTRACT (S4, PROVISIONAL, UNQUALIFIED) ============================
 * stage-policy-v1 line (approved narrative, so the plan digest binds it): { merge_stage, stages[], rows[{id, check,
 *   stage, pair?}], deferred[{row, stage, environment, subject, required_evidence, trigger? | tracker_ref?}],
 *   artifacts?[] (exact .specs/ paths), no_runtime_boundary? }. RED/pair spec coverage is derived from the runner COMMAND
 *   (an argument naming the spec, a directory holding it or a glob matching it), never declared.
 * obligation: a deferred row becomes an OPEN obligation {row, verified_through: merge_stage, deferred_stage, environment,
 *   subject, required_evidence, trigger, tracker_ref, candidate, base, generation, status, lineage[]}: never a waiver,
 *   never verified by SHIP_READY. SHIP_READY covers the merge stage only and lists the open obligations.
 * preflight (= init): rows' stages exist or are declared deferred; a deferral names an unavailable stage only and
 *   never a 3a pair; trigger or tracker required; repository-required artifacts declared; RED specs covered by a
 *   formatted runner; every runner command executable; path signal pre-scan of planned writes.
 * disposition: closes a line-raised new-route signal only (never path-raised, never auth/migration), only when every
 *   route-shaped match is a client member call `<x>.api.<verb>(` with no handler-shaped argument, bound to the
 *   engine-issued brief digest over (signal, path, candidate, matched lines) and carrying an independent reviewer.
 * The engine never writes an authority event (no SECURITY_WAIVER, no authorized_by).
 * Factory recording does NOT enforce deployment: nothing here stops a deploy until the deploy boundary consumes it.
 * ================================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as SP from './security-plan.mjs';
import * as OB from './security-obligations.test-helper.mjs';
import { POSIX, fixture, passReview, failReview, confirmReview, runStateEvents, runLogEvents } from './engine-test-fixture.mjs';
import { preflight } from './run-engine.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX only (fake CLI and executable bits)';
const J = JSON.stringify;
const REAL = SP.loadCatalog();
const GC = OB.gated();
const LINE = 'stage-policy-v1: ';
const stageLine = (p) => LINE + J(p);
const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
const initCode = (r) => (r.status === 0 ? 'ok' : /run-engine: (\w+):/.exec(r.stderr)?.[1] ?? r.stderr);
const rejects = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; }); };

/** The 236 shape: local proof and the merge stage exist; the production RLS row has no environment in this run. */
const POLICY_236 = () => ({
  merge_stage: 'merge', stages: ['local', 'merge'],
  rows: [{ id: 'R1', check: 'unit + negative spec', stage: 'local' }, { id: 'R2', check: 'production RLS read-only probe', stage: 'production' }],
  deferred: [{ row: 'R2', stage: 'production', environment: 'production', subject: 'api release of this candidate',
    required_evidence: 'read-only probe output against production after deploy', tracker_ref: 'TRK-1' }],
});

// ---- a legacy (pre-cutoff, no security policy) run: enough for obligations and SHIP_READY ----
function stageRun(t, { policy = POLICY_236(), flag = true, line = true, extra = {} } = {}) {
  const fx = fixture(t, { commit: true, narrativeExtra: line ? stageLine(policy) + '\n\n' : '',
    config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } }, ...(flag ? { stagePolicy: { version: 1 } } : {}), ...extra } });
  return fx;
}

// ---- a security policy 2 run (preflight needs one): the F12a obFx shape, with the stage line and extras ----
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
const specText = (list) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `for (const id of ${J(list)}) test(id, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
function secRun(t, { policy, flag = true, nodes = [], config = {}, implFiles = {} } = {}) {
  const sel = realSelection();
  const cov = sel.pairs.map((p) => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC, name: p.pair_id }] }));
  const pol = policy ?? { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [] };
  const fx = fixture(t, { commit: true, narrativeExtra: SP.renderSection3a(sel) + '\n\n' + (pol === null ? '' : stageLine(pol) + '\n\n'),
    config: { width: 1, testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' } },
      securityPolicy: 2, catalogDigest: REAL.digest, controlCoverage: cov, ...(flag ? { stagePolicy: { version: 1 } } : {}), ...config },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap((c) => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }, ...nodes],
    behaviour: { api: { write: { [SPEC]: specText(cov.map((c) => `${c.boundary}:${c.control}`)) } }, impl: { write: { 'src/impl.txt': 'done', ...implFiles } } } });
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: fx.repo, encoding: 'utf8' });
  g('add', '-A'); assert.equal(g('commit', '-q', '-m', 'base').status, 0);
  return Object.assign(fx, { sel, pol });
}
const pf = (fx) => preflight({ repoRoot: fx.repo, ticket: 'T-1', dagFile: fx.dagFile });

// =============================================================================================== obligations

test('[P6-N1] a deferral with no trigger and no tracker is refused (preflight and init); with a tracker it binds an OPEN obligation', { skip: WIN_SKIP }, async (t) => {
  const bare = POLICY_236(); delete bare.deferred[0].tracker_ref;
  const fx = stageRun(t, { policy: bare });
  assert.equal(initCode(fx.cli('init', { dag: fx.dagFile })), 'obligation_trigger_missing');
  const sec = secRun(t, { policy: { ...bare } });
  await rejects(pf(sec), 'obligation_trigger_missing');
  // positive twins: a tracker or a trigger
  const good = stageRun(t);
  okc(good.cli('init', { dag: good.dagFile }), 'init with a tracker');
  const ob = good.readState().stage.obligations;
  assert.deepEqual(ob.map((o) => [o.row, o.status, o.deferred_stage, o.verified_through, o.tracker_ref]), [['R2', 'open', 'production', 'merge', 'TRK-1']]);
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
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  okc(fx.cli('drive'), 'drive');
  const cand = fx.candidate();
  okc(fx.gate('review', passReview('review-1', cand)), 'review');
  const sr = fx.gate('ship-ready', {});
  okc(sr, 'ship-ready');
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
  const ob = fx.readState().stage.obligations[0];
  assert.equal(ob.status, 'open', 'SHIP_READY never verifies the deferred stage');
  assert.equal(ob.candidate, cand);
});

test('[P6-N3] a rebased or changed candidate re-binds the obligation (lineage kept, still open); a verified obligation reopens for the new candidate', { skip: WIN_SKIP }, async (t) => {
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  okc(fx.cli('drive'), 'drive');
  const c1 = fx.candidate();
  okc(fx.gate('review', passReview('review-1', c1)), 'review 1');
  okc(fx.gate('ship-ready', {}), 'ship-ready 1');
  const ev = join(fx.root, 'ev.json');
  writeFileSync(ev, J({ stage: 'production', environment: 'production', subject: 'api release of this candidate', candidate_id: c1,
    required_evidence: 'read-only probe output against production after deploy', result: 'pass', ref: 'gh-run-1', summary: 'probe passed' }));
  okc(fx.cli('obligation-verify', { id: 'R2', input: ev }), 'verify on c1');
  assert.equal(fx.readState().stage.obligations[0].status, 'verified');
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
  const ob = fx.readState().stage.obligations[0];
  assert.equal(ob.candidate, c2);
  assert.equal(ob.status, 'open', 'evidence for c1 never verifies c2');
  assert.deepEqual(ob.lineage.map((l) => [l.from, l.to]), [[c1, c2]]);
  assert.equal(ob.lineage[0].reopened, true);
});

test('[P6-N4] the deferred stage cannot be marked verified without new evidence for the bound candidate', { skip: WIN_SKIP }, async (t) => {
  const two = POLICY_236();
  two.rows.push({ id: 'R3', check: 'production email DKIM check', stage: 'production' });
  two.deferred.push({ row: 'R3', stage: 'production', environment: 'production', subject: 'api release of this candidate', required_evidence: 'DKIM lookup output', tracker_ref: 'TRK-2' });
  const fx = stageRun(t, { policy: two });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  const ev = join(fx.root, 'ev.json');
  const verify = (id, e) => { writeFileSync(ev, J(e)); return fx.cli('obligation-verify', { id, input: ev }); };
  const good = (c) => ({ stage: 'production', environment: 'production', subject: 'api release of this candidate', candidate_id: c,
    required_evidence: 'read-only probe output against production after deploy', result: 'pass', ref: 'gh-run-7', summary: 'probe passed' });
  // unbound: no SHIP_READY yet, so there is no candidate the evidence could be for
  assert.equal(verify('R2', good('x'.repeat(64))).out?.code, 'obligation_unbound');
  okc(fx.cli('drive'), 'drive');
  const cand = fx.candidate();
  okc(fx.gate('review', passReview('review-1', cand)), 'review');
  okc(fx.gate('ship-ready', {}), 'ship-ready');
  const code = (r) => r.out?.code;
  assert.equal(code(verify('R2', {})), 'obligation_evidence_missing');
  assert.equal(code(verify('R2', { ...good(cand), ref: '' })), 'obligation_evidence_missing');
  assert.equal(code(verify('R2', { ...good(cand), stage: 'merge' })), 'obligation_evidence_mismatch', 'merge-stage evidence is not production evidence');
  assert.equal(code(verify('R2', { ...good(cand), environment: 'staging' })), 'obligation_evidence_mismatch');
  assert.equal(code(verify('R2', { ...good(cand), candidate_id: 'f'.repeat(64) })), 'obligation_evidence_mismatch');
  assert.equal(code(verify('R2', { ...good(cand), required_evidence: 'a screenshot' })), 'obligation_evidence_mismatch', 'evidence of another kind than the obligation requires');
  assert.equal(code(verify('R2', { ...good(cand), result: 'fail', summary: 'probe FAILED: rls off' })), 'obligation_evidence_failed', 'a reported failure never verifies');
  assert.equal(code(verify('R2', { ...good(cand), result: 'passed' })), 'obligation_evidence_missing', 'result is exactly pass or fail');
  assert.equal(code(verify('R9', good(cand))), 'obligation_unknown', 'no runtime path creates an obligation');
  for (const r of ['R2']) assert.equal(fx.readState().stage.obligations.find((o) => o.row === r).status, 'open');
  okc(verify('R2', good(cand)), 'new evidence verifies');
  assert.equal(fx.readState().stage.obligations.find((o) => o.row === 'R2').status, 'verified');
  // the same evidence (identical record) cannot verify a second obligation
  assert.equal(code(verify('R3', good(cand))), 'obligation_evidence_mismatch', 'R3 requires other evidence');
  assert.equal(code(verify('R3', { ...good(cand), required_evidence: 'DKIM lookup output' })), 'obligation_evidence_reused');
  assert.equal(code(verify('R3', { ...good(cand), required_evidence: 'DKIM lookup output', summary: 'a different text, same run' })), 'obligation_evidence_reused', 'identity is the evidence ref, not its free text');
  assert.equal(fx.readState().stage.obligations.find((o) => o.row === 'R3').status, 'open');
  assert.equal(code(verify('R2', good(cand))), 'obligation_already_verified');
  const ids = runStateEvents(fx.planFile).filter((e) => e.event === 'OBLIGATION_VERIFIED');
  assert.equal(ids.length, 1);
  assert.equal('authorized_by' in ids[0], false, 'evidence, not authority');
});

test('[P6-N5] a failed CURRENT-stage control can never be deferred: an available stage, the merge stage or a 3a pair cannot be deferred, and no gate input adds a deferral', { skip: WIN_SKIP }, async (t) => {
  const cur = POLICY_236(); cur.rows[0] = { id: 'R1', check: 'unit + negative spec', stage: 'local' };
  cur.deferred.push({ row: 'R1', stage: 'local', environment: 'local', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' });
  const cf = stageRun(t, { policy: cur });
  assert.equal(initCode(cf.cli('init', { dag: cf.dagFile })), 'stage_deferral_invalid');
  const merge = POLICY_236(); merge.rows.push({ id: 'R4', check: 'CI', stage: 'merge' });
  merge.deferred.push({ row: 'R4', stage: 'merge', environment: 'ci', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' });
  const mf = stageRun(t, { policy: merge });
  assert.equal(initCode(mf.cli('init', { dag: mf.dagFile })), 'stage_deferral_invalid');
  // a deferral whose stage differs from its row's stage (a local row relabelled production) is refused too
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
  // runtime: gate inputs carry no deferral
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  assert.equal(fx.gate('ship-ready', { deferred: [{ row: 'R1' }] }).status, 1, 'unknown gate input field: usage error');
  assert.deepEqual(fx.readState().stage.obligations.map((o) => o.row), ['R2']);
});

test('[P6-N0] a row whose stage does not exist must be declared deferred; the stage policy must be in the approved narrative', { skip: WIN_SKIP }, async (t) => {
  const undeclared = POLICY_236(); undeclared.deferred = [];
  const fx = stageRun(t, { policy: undeclared });
  assert.equal(initCode(fx.cli('init', { dag: fx.dagFile })), 'stage_unavailable');
  const missing = stageRun(t, { line: false });
  assert.equal(initCode(missing.cli('init', { dag: missing.dagFile })), 'stage_policy_missing');
  const two = fixture(t, { commit: true, narrativeExtra: `${stageLine(POLICY_236())}\n${stageLine(POLICY_236())}\n\n`,
    config: { testCommands: {}, stagePolicy: { version: 1 } } });
  assert.equal(initCode(two.cli('init', { dag: two.dagFile })), 'stage_policy_invalid');
  const bad = stageRun(t, { policy: { ...POLICY_236(), surprise: 1 } });
  assert.equal(initCode(bad.cli('init', { dag: bad.dagFile })), 'stage_policy_invalid');
  // dag_bound: the DAG is bound after approval by an event, but the stage line is still the narrative's (no DAG field carries deferrals)
  const flagOnly = fixture(t, { commit: true, bind: 'dag_bound', narrativeExtra: '', config: { testCommands: {}, stagePolicy: { version: 1 } } });
  assert.equal(initCode(flagOnly.cli('init', { dag: flagOnly.dagFile })), 'stage_policy_missing');
});

// =============================================================================================== preflight

test('[P6-N6a] 124 v1 plan: a UI run whose plan omits the parity artifact is refused BEFORE approval (preflight) and at init; declared, it passes', { skip: WIN_SKIP }, async (t) => {
  const pol = { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [] };
  const v1 = secRun(t, { policy: pol, config: { riskLabels: ['ui'] } });
  await rejects(pf(v1), 'required_artifact_outside_contract');
  assert.equal(initCode(v1.cli('init', { dag: v1.dagFile })), 'required_artifact_outside_contract', 'init runs the same check (preflight is not optional)');
  const v2 = secRun(t, { policy: { ...pol, artifacts: ['.specs/design-parity/T-1.md'] }, config: { riskLabels: ['ui'] } });
  assert.equal((await pf(v2)).code, 'preflight_ok');
  // an artifact may never widen the contract to source: only plan-artifact paths, never the plan itself
  const wide = secRun(t, { policy: { ...pol, artifacts: ['src/anything.ts'] } });
  await rejects(pf(wide), 'stage_policy_invalid');
  const self = secRun(t, { policy: { ...pol, artifacts: ['.specs/plans/T-1.md'] } });
  await rejects(pf(self), 'stage_policy_invalid');
});

test('[P6-N6b] 124 RED for a new client file: a RED spec the runner COMMAND cannot reach is refused before approval; a declared coverage list is not accepted; a runner command that is not executable is refused', { skip: WIN_SKIP }, async (t) => {
  const client = { id: 'client', deps: [], writes: ['apps/admin'], redSpecs: [{ file: 'apps/admin/src/settings.service.spec.ts', name: 'loads settings' }] };
  const pol = { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [] };
  const v1 = secRun(t, { policy: pol, nodes: [client] });
  await rejects(pf(v1), 'red_runner_missing');
  // a declared coverage list (the former `runners` field) is refused: coverage is never invented by declaration
  const declared = secRun(t, { policy: { ...pol, runners: { unit: ['spec/**', 'apps/admin/**/*.spec.ts'] } }, nodes: [client] });
  await rejects(pf(declared), 'stage_policy_invalid');
  // a runner whose command really reaches the spec: by file, by directory, by glob
  const UNIT = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' };
  for (const arg of ['apps/admin/src/settings.service.spec.ts', 'apps/admin', 'apps/admin/**/*.spec.ts']) {
    const v2 = secRun(t, { policy: pol, nodes: [client], config: { testCommands: { unit: UNIT, client: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', arg], format: 'tap' } } } });
    assert.equal((await pf(v2)).code, 'preflight_ok', arg);
  }
  // an unformatted entry naming the spec is not a RED runner (RED parses formatted output)
  const raw = secRun(t, { policy: pol, nodes: [client], config: { testCommands: { unit: UNIT, client: { cmd: process.execPath, args: ['--test', 'apps/admin'] } } } });
  await rejects(pf(raw), 'red_runner_missing');
  // executability: a relative script that does not exist, and one without the executable bit
  const missing = secRun(t, { policy: pol, config: { testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' }, lint: { cmd: './scripts/lint.sh', args: [] } } } });
  await rejects(pf(missing), 'runner_not_executable');
  const noexec = secRun(t, { policy: pol, config: { testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' }, lint: { cmd: './scripts/lint.sh', args: [] } } } });
  mkdirSync(join(noexec.repo, 'scripts'), { recursive: true }); writeFileSync(join(noexec.repo, 'scripts', 'lint.sh'), '#!/bin/sh\nexit 0\n'); chmodSync(join(noexec.repo, 'scripts', 'lint.sh'), 0o644);
  await rejects(pf(noexec), 'runner_not_executable');
  chmodSync(join(noexec.repo, 'scripts', 'lint.sh'), 0o755);
  assert.equal((await pf(noexec)).code, 'preflight_ok');
  const onPath = secRun(t, { policy: pol, config: { testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' }, lint: { cmd: 'no-such-binary-s4', args: [] } } } });
  await rejects(pf(onPath), 'runner_not_executable');
});

test('[P6-N6c] signal pre-scan of planned writes: a file-shaped route write with no surface is refused before approval for any block format; the pre-scan is printed', { skip: WIN_SKIP }, async (t) => {
  const route = { id: 'route', deps: [], writes: ['src/routes/admin.ts'] };
  const fx = secRun(t, { nodes: [route] });
  await rejects(pf(fx), 'surface_inventory_incomplete');
  const ok = secRun(t, { nodes: [{ id: 'dep', deps: [], writes: ['package.json'] }] });
  const r = await pf(ok);
  assert.equal(r.code, 'preflight_ok');
  assert.deepEqual(r.stage.signal_prescan, [{ path: 'package.json', kinds: ['new-dependency'] }]);
});

test('[P6-OFF] without config.stagePolicy every frozen semantics holds: preflight output, init state, SHIP_READY, the reassess contract', { skip: WIN_SKIP }, async (t) => {
  const fx = secRun(t, { flag: false, policy: null, config: { riskLabels: ['ui'] } });
  const r = await pf(fx);
  assert.equal(r.code, 'preflight_ok', 'the frozen preflight does not know the parity artifact');
  assert.equal('stage' in r, false);
  const lg = stageRun(t, { flag: false, line: true });
  okc(lg.cli('init', { dag: lg.dagFile }), 'init');
  assert.equal('stage' in lg.readState(), false, 'an approved line without the flag binds nothing');
  // a flag on an engine that lacks it: an unknown config field (frozen engines fail closed)
  okc(lg.cli('drive'), 'drive');
  okc(lg.gate('review', passReview('review-1', lg.candidate())), 'review');
  const sr = lg.gate('ship-ready', {});
  okc(sr, 'ship-ready');
  assert.equal('stage' in sr.out, false);
  assert.equal('verified_through' in runStateEvents(lg.planFile).find((e) => e.event === 'SHIP_READY'), false);
  // dispositions are refused on a run without the flag (a usage error, as an unknown field was)
  okc(fx.cli('init', { dag: fx.dagFile }), 'init sec');
  assert.equal(fx.gate('reassess', { dispositions: [] }).status, 1);
});

// =============================================================================================== classifier (S)

/** Format-2 plan over the gated catalog with one approved request-handler surface; the client file is new. */
const f2 = () => SP.selectControls(GC, { security_policy: 2, surfaces: [OB.surf('H', 'request-handler', 'src/h.ts')], facts: OB.TRUE3, evidence: OB.cite3(OB.TRUE3) });
const CLIENT = 'apps/admin/src/app/features/settings/settings.service.ts'; // the shape of the replayed client file
const CLIENT_LINE = '      const settings = await this.api.get();';
const CAND = 'c'.repeat(64);
const rea = (files, { dispositions, allow = true, plan, candidate = CAND, format = 2, classifications = [] } = {}) => format === 3
  ? SP.reassess({ ...OB.reIn3(GC, { files, contract: ['**'] }), candidate_id: candidate, ...(allow ? { allowDispositions: true } : {}), ...(dispositions ? { dispositions } : {}), classifications })
  : SP.reassess({ plan: plan ?? OB.planOf(f2()), catalog: GC, inventory: { candidate_id: candidate, surfaces: [] }, changed: { contract_paths: ['**'], files },
    classifications, ...(allow ? { allowDispositions: true } : {}), ...(dispositions ? { dispositions } : {}) });
const briefOf = (r, id) => r.disposition_briefs.find((b) => b.signal_id === id);
const dispose = (b, over = {}) => ({ signal_id: b.signal_id, disposition: 'no-runtime-boundary', brief_digest: b.brief_digest,
  reviewer: 'codex:independent', basis: 'this.api is the injected ApiClient (HTTP client); the file registers no handler', ...over });

test('[P6-N7a] 124: `this.api.get(` in a client/test file is dismissible with an engine-issued, candidate-bound, independently reviewed disposition (format 2 and 3)', () => {
  for (const format of [2, 3]) {
    for (const path of [CLIENT, 'apps/admin/src/app/features/settings/settings-api.service.spec.ts']) {
      const files = [{ path, added: ['import { inject } from "@angular/core";', CLIENT_LINE, "    expect(this.api.get).toHaveBeenCalled();",
        "    this.api.get(`/settings/${id}`, { params: { a: '1, 2' } });"] }];
      const id = `new-route@${path}`;
      const first = rea(files, { format });
      assert.equal(first.ok, false);
      assert.equal(first.code, format === 3 ? 'surface_inventory_incomplete' : 'classification_missing', J(first));
      const b = briefOf(first, id);
      assert.ok(b && b.admissible === true, J(first.disposition_briefs));
      assert.deepEqual(b.lines, [CLIENT_LINE, files[0].added[3]]);
      const done = rea(files, { format, dispositions: [dispose(b)] });
      assert.equal(done.ok, true, J(done));
      assert.equal(done.outcome, 'UNCHANGED');
      assert.deepEqual(done.dispositions_used.map((d) => [d.signal_id, d.reviewer]), [[id, 'codex:independent']]);
      // the signal is still reported (detection not weakened), only closed
      assert.ok(done.signals.some((s) => s.id === id));
    }
  }
});

// R2 (RCA-S4-ROUND2 step 1): the classifier is an ALLOW-list. Every probe line of both round-2 reviewers, verbatim
// (scratchpad probe.mjs / probe3.mjs / probe4.mjs), plus chained calls, decorators and plain-name first arguments.
const R2_ADMISSIBLE = [
  "const r = x.api.get(`/u/${id}`)",
  "this.api.get('/users')",
  "this.api.get('/users', { params: { a: 1 } })",
  "x.api.get('/u', { a: 1 } )",
  "x.api.get('/u', {'a': '1', b: {c: true}})",
  "return this.api.post(`/s/${id}`, { a: 1, b: 'x' });",
  "await this.api.delete('/s');",
];
const R2_INADMISSIBLE = [
  "@deps.api.post('/users', status_code=201)",
  "@routers.api.get(\"/users\")",
  "ctx.api.get('/users').get(c => c.json(users))",
  "ctx.api.get('/users').post(createUser)",
  "srv.api.get(listUsers)",
  "x.api.get('/u') # app.get(h)",
  "x.api.get('/u')\t.use(h)",
  "x.api.get('/u', **{})",
  "x.api.get('/u', handler=h)",
  "x.api.get('/u', { a: 1 }) /",
  "x.api.get('/u', { a: 1 }) // app.get('/x', h)",
  "x.api.get('/u', { a: 1 }) ? 1 : 2",
  "x.api.get('/u', { a: 1 }).then(r => r.json())",
  "x.api.get('/u', { a: 1 }, h)",
  "x.api.get('/u', { a: 1 },)",
  "x.api.get('/u', { a: 1 }['x'])",
  "x.api.get('/u', { a: `${h}` })",
  "x.api.get('/u', { handler: h }.handler)",
  "x.api.get('/u', { onSuccess: h })",
  "x.api.get('/u', {a: 1}) + app2(h)",
  "x.api.get('/u', {a:1} /* c */)",
  "x.api.get('/u', {a:1}); x.handlers.push(h)",
  "x.api.get('/u',\"a\")",
  "x.api.get(['/a','/b'])",
  "x.api.get(`${h}`)",
  "x.api.get(`/u/${f(h)}`)",
  "x.api.get(h, {})",
  "x.api.get(h.handler)",
  "x.api.get({ handler: h }.handler)",
  "x.api.post('/u', { a: 1 }); export default h",
  "ctx.api.get('/users').get(handler);",
  "    @routers.api.get(\"/users\")",
  "this.api.get('/x').subscribe((r) => done(r));",
  "this.api.get(url);",
  "this.api.get('/x', opts);",
  "this.api.get('/x', { a: 1 }, extra);",
  "this.api.get('/x' /* c */);",
  "const f = () => this.api.get('/x');",
];
test('[P6-R2a] allow-list classifier: only the whole statement `[const x =|return|await] <ident-chain>.api.<verb>(<literal path>[, <plain literal object>])[;]` is admissible', () => {
  for (const format of [2, 3]) {
    for (const line of R2_ADMISSIBLE) {
      const b = briefOf(rea([{ path: CLIENT, added: [line] }], { format }), `new-route@${CLIENT}`);
      assert.ok(b, line); assert.equal(b.admissible, true, `${line}: ${b.why}`);
    }
    for (const line of R2_INADMISSIBLE) {
      const files = [{ path: 'src/server/settings.ts', added: [line] }];
      const first = rea(files, { format });
      const b = briefOf(first, 'new-route@src/server/settings.ts');
      if (!b) { assert.equal(first.ok, false, `${line}: not even a new-route signal, and not closed`); continue; }
      assert.equal(b.admissible, false, line);
      assert.equal(rea(files, { format, dispositions: [dispose(b)] }).code, 'disposition_inadmissible', line);
    }
  }
});

test('[P6-N7b] a seeded server route can NEVER close by the disposition: bare, member, mixed, path-raised, handler-shaped, V3, decorator and export forms', () => {
  const seeds = [
    ['src/server/settings.ts', ["router.get('/settings', h);"]],
    ['src/server/settings.ts', ["this.router.get('/settings', h);"]],
    ['src/server/settings.ts', ["this.app.get('/settings', h);"]],
    ['src/server/settings.ts', [CLIENT_LINE, "router.get('/settings', h);"]], // mixed: one client call and one real route
    ['src/server/settings.ts', ["this.api.get('/settings', (req, res) => res.json(x));"]], // handler-shaped argument
    ['src/server/settings.ts', ["this.api.get('/settings', async function (req) {"]],
    ['src/server/settings.ts', ['this.api.get(']], // a call that does not close on its line cannot be verified
    ['src/server/settings.ts', ["this.api.get('/settings', this.handle);"]], // a non-literal second argument could be a handler
    ['src/server/settings.ts', ["this.api.post('/settings', handler)"]],
    ['src/server/settings.ts', ["this.api.route('/settings').get(handler);"]], // route() chains register handlers
    ['src/server/settings.ts', ["this.api.route({ method: 'GET', url: '/x', handler: h });"]],
    ['src/server/settings.ts', ["this.api.all('/x');"]],
    ['src/server/settings.ts', ["this.api.get('/settings', { handler: handleSettings }.handler);"]], // an object expression, not a plain literal
    ['src/server/settings.ts', ["this.api.get('/settings' /* ) */, handleSettings);"]], // a comment hides the real argument list
    ['src/server/settings.ts', ["this.api.get('/x' /* ' */, this.handle /* ' */);"]],
    ['src/server/settings.ts', ["this.api.get(/'/, h, /'/);"]], // regex literals
    ['src/server/settings.ts', ["this.api.get('/x'); // , handler"]],
    ['src/server/settings.ts', ["this.api.get('/x', { params: h });"]], // an identifier value could be anything
    ['src/server/settings.ts', ["this.api.get(`/x/${mount(h)}`);"]], // a template with a call inside
    ['src/server/settings.ts', ["this.api.get(makeUrl(h));"]],
    ['src/server/settings.ts', ["this.api.get('/x'); fastify.get('/y', h);"]],
    ['src/server/settings.ts', ['@Get(":id")', CLIENT_LINE]],
    ['src/server/settings.ts', ['export async function GET(req) {', CLIENT_LINE]],
    ['src/api/settings.client.ts', [CLIENT_LINE]], // path-raised: an api/ directory
    ['src/routes/settings.ts', [CLIENT_LINE]],
  ];
  for (const format of [2, 3]) {
    for (const [path, added] of seeds) {
      const files = [{ path, added }];
      const id = `new-route@${path}`;
      const first = rea(files, { format });
      assert.equal(first.ok, false, `${path} ${J(added)}`);
      const b = briefOf(first, id);
      assert.ok(b, `${J(added)}: a brief is issued for every open new-route signal`);
      assert.equal(b.admissible, false, `${path} ${J(added)}`);
      const r = rea(files, { format, dispositions: [dispose(b)] });
      assert.equal(r.ok, false, `${path} ${J(added)} closed by a disposition`);
      assert.equal(r.code, 'disposition_inadmissible', `${path} ${J(added)}`);
    }
    // never an auth or migration signal
    for (const [path, added, kind] of [['src/middleware/session.ts', [CLIENT_LINE], 'auth-or-middleware-change'], ['db/migrations/1.sql', ['create policy p on t'], 'migration-or-rls-change']]) {
      const first = rea([{ path, added }], { format });
      const fake = { signal_id: `${kind}@${path}`, brief_digest: 'sha256:' + '0'.repeat(64) };
      const r = rea([{ path, added }], { format, dispositions: [dispose(fake)] });
      assert.equal(first.ok, false);
      assert.equal(r.code, 'disposition_inadmissible', kind);
    }
  }
});

test('[P6-N7c] the disposition is bound to the candidate and the matched lines: an edited file, another candidate or a forged digest is stale; a reason alone still closes nothing', () => {
  const files = [{ path: CLIENT, added: [CLIENT_LINE] }];
  const id = `new-route@${CLIENT}`;
  const b = briefOf(rea(files), id);
  const edited = [{ path: CLIENT, added: [CLIENT_LINE, '      const more = await this.api.get();'] }];
  assert.equal(rea(edited, { dispositions: [dispose(b)] }).code, 'disposition_stale', 'a line added after the disposition');
  assert.equal(rea(files, { candidate: 'd'.repeat(64), dispositions: [dispose(b)] }).code, 'disposition_stale', 'another candidate');
  assert.equal(rea(files, { dispositions: [dispose(b, { brief_digest: 'sha256:' + 'e'.repeat(64) })] }).code, 'disposition_stale');
  assert.equal(rea(files, { candidate: null, dispositions: [dispose(b)] }).code, 'disposition_unbound');
  assert.equal(rea(files, { dispositions: [dispose(b, { reviewer: '' })] }).code, 'bad_input', 'an independent reviewer is required');
  assert.equal(rea(files, { dispositions: [dispose(b, { basis: '' })] }).code, 'bad_input');
  assert.equal(rea(files, { dispositions: [dispose(b, { disposition: 'waived' })] }).code, 'bad_input');
  assert.equal(rea(files, { allow: false, dispositions: [dispose(b)] }).code, 'bad_input', 'not enabled: refused, never ignored');
  // frozen rule intact: a classification (reason or fact) never dismisses it
  const reason = rea(files, { classifications: [{ signal_id: id, reason: 'client call' }] });
  assert.equal(reason.code, 'classification_missing');
  // without allowDispositions the reassess output is the frozen one (no briefs)
  assert.equal('disposition_briefs' in rea(files, { allow: false }), false);
});

test('[P6-N7d] engine: gate reassess honours a disposition only on an approved no_runtime_boundary stage policy; sticky REAPPROVAL is never cleared by one', { skip: WIN_SKIP }, async (t) => {
  const pol = { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [],
    no_runtime_boundary: true, artifacts: ['.specs/design-parity/T-1.md'] };
  const client = 'src/settings.service.ts';
  const fx = secRun(t, { policy: pol, implFiles: { [client]: `export class S {\n  async load() {\n${CLIENT_LINE}\n  }\n}\n` } });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive impl');
  // the orchestrator writes the parity artifact: declared, it is inside the contract (no out-of-plan REAPPROVAL)
  mkdirSync(join(fx.repo, '.specs', 'design-parity'), { recursive: true }); writeFileSync(join(fx.repo, '.specs', 'design-parity', 'T-1.md'), '# parity\n');
  const first = fx.gate('reassess', {});
  assert.equal(first.out?.code, 'reassess_unclassified', first.stdout);
  const b = first.out.disposition_briefs.find((x) => x.signal_id === `new-route@${client}`);
  assert.equal(b.admissible, true);
  const done = fx.gate('reassess', { dispositions: [dispose(b)] });
  okc(done, 'reassess with disposition');
  assert.deepEqual(fx.readState().security.reassessed.dispositions.map((d) => d.signal_id), [`new-route@${client}`]);
  // a seeded route in the same file: inadmissible
  writeFileSync(join(fx.repo, client), `import { Router } from 'express';\nconst router = Router();\nrouter.get('/settings', h);\n${CLIENT_LINE}\n`);
  const seeded = fx.gate('reassess', {});
  const b2 = seeded.out.disposition_briefs.find((x) => x.signal_id === `new-route@${client}`);
  assert.equal(b2.admissible, false);
  assert.equal(fx.gate('reassess', { dispositions: [dispose(b2)] }).out?.code, 'disposition_inadmissible');
  // sticky REAPPROVAL: an undeclared out-of-plan file; afterwards no disposition (or anything) clears it
  writeFileSync(join(fx.repo, client), `export class S {\n  async load() {\n${CLIENT_LINE}\n  }\n}\n`);
  writeFileSync(join(fx.repo, 'outside.txt'), 'x');
  assert.equal(fx.gate('reassess', {}).out?.code, 'security_reapproval');
  rmOutside(fx);
  const after = fx.gate('reassess', { dispositions: [dispose(b)] });
  assert.equal(after.out?.code, 'security_reapproval', after.stdout);
  assert.ok(fx.readState().security.reapproval, 'still recorded');
});
function rmOutside(fx) { spawnSync('rm', ['-f', join(fx.repo, 'outside.txt')]); }

test('[P6-N7e] engine: without the approved no_runtime_boundary field a disposition is refused (the DAG flag alone never loosens the classifier)', { skip: WIN_SKIP }, async (t) => {
  const client = 'src/settings.service.ts';
  const fx = secRun(t, { implFiles: { [client]: `${CLIENT_LINE}\n` } });
  okc(fx.cli('init', { dag: fx.dagFile })); okc(fx.cli('drive')); okc(fx.gate('red', { node: 'api' })); okc(fx.cli('drive'));
  const first = fx.gate('reassess', {});
  assert.equal(first.out?.code, 'reassess_unclassified');
  assert.equal('disposition_briefs' in first.out, false);
  const r = fx.gate('reassess', { dispositions: [{ signal_id: `new-route@${client}`, disposition: 'no-runtime-boundary', brief_digest: 'sha256:' + '0'.repeat(64), reviewer: 'x', basis: 'y' }] });
  assert.equal(r.out?.code, 'disposition_not_approved', r.stdout);
});

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

test('[P6-R1] the stage record is checked against the approved policy on EVERY load: a dropped obligation, a flipped no_runtime_boundary or an edited immutable field is never resumed', { skip: WIN_SKIP }, async (t) => {
  const tamper = [
    ['obligations emptied', (st) => { st.stage.obligations = []; }],
    ['obligation added', (st) => { st.stage.obligations.push({ ...st.stage.obligations[0], row: 'R9' }); }],
    ['no_runtime_boundary flipped', (st) => { st.stage.no_runtime_boundary = true; }],
    ['stages widened', (st) => { st.stage.stages = [...st.stage.stages, 'production']; }],
    ['artifacts widened', (st) => { st.stage.artifacts = ['.specs/x.md']; }],
    ['required_evidence edited', (st) => { st.stage.obligations[0].required_evidence = 'nothing'; }],
    ['policy digest edited', (st) => { st.stage.policy_digest = 'sha256:' + '0'.repeat(64); }],
    ['status forged verified without evidence', (st) => { st.stage.obligations[0].status = 'verified'; }],
    ['unknown status', (st) => { st.stage.obligations[0].status = 'waived'; }],
  ];
  for (const [what, edit] of tamper) {
    const fx = stageRun(t);
    okc(fx.cli('init', { dag: fx.dagFile }), 'init');
    fx.editState(edit);
    const st = fx.cli('status');
    assert.notEqual(st.status, 0, what);
    assert.match(st.stderr, /stage_state_invalid/, `${what}: ${st.stderr}`);
    const sr = fx.gate('ship-ready', {});
    assert.notEqual(sr.status, 0, what);
    assert.equal(runStateEvents(fx.planFile).filter((e) => e.event === 'SHIP_READY').length, 0, what);
  }
  // the mutable part stays mutable: the engine's own binding loads fine
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive');
  okc(fx.gate('review', passReview('review-1', fx.candidate())), 'review'); okc(fx.gate('ship-ready', {}), 'ship-ready');
  okc(fx.cli('status'), 'status after binding');
});

test('[P6-R1b] gate reassess and every gate use the RETAINED approved line; a consistently re-forged record (line + record) or a verification missing from RUN-STATE is refused at the binding', { skip: WIN_SKIP }, async (t) => {
  const { parseStagePolicy, initialStage, retainedStagePolicy } = await import('./stage-obligations.mjs');
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  assert.equal(retainedStagePolicy(fx.readState()).no_runtime_boundary, false);
  // forge both the retained line (no_runtime_boundary: true) and a record derived from it: load passes, the binding does not
  fx.editState((st) => { const line = stageLine({ ...POLICY_236(), no_runtime_boundary: true }); st.stage = initialStage(parseStagePolicy(line)); });
  okc(fx.cli('status'), 'a self-consistent forged record loads (state alone cannot tell)');
  const g = fx.gate('ship-ready', {});
  assert.equal(g.out?.code, 'stage_policy_mismatch', g.stdout);
  // a retained verification that never reached RUN-STATE (written into state only)
  const { fx: f2, cand, verify } = await shipped(t);
  okc(verify('R2', EVIDENCE(cand)), 'verify');
  const text = readFileSync(f2.planFile, 'utf8');
  writeFileSync(f2.planFile, text.split('\n').filter((l) => !l.includes('"OBLIGATION_VERIFIED"')).join('\n'));
  assert.equal(f2.gate('ship-ready', {}).out?.code, 'stage_policy_mismatch');
});

test('[P6-R3] a stage run records a distinguishable policy version: an engine without S4 (the main policy table, 1-24) refuses to resume it', { skip: WIN_SKIP }, async (t) => {
  const POL = await import('./engine-policy.mjs');
  const fx = stageRun(t);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  const v = fx.readState().policy_version;
  assert.ok(v >= 25 && v <= 48, `stage run version ${v}`);
  assert.deepEqual(POL.POLICY_SEMANTICS[v], { ...POL.POLICY_SEMANTICS[v - 24], stageObligations: true });
  const main = { current: 1, semantics: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, POL.POLICY_SEMANTICS[i + 1]])) };
  assert.throws(() => POL.runPolicy({ policy_version: v }, main), (e) => e.code === 'policy_version_unsupported');
  const { status } = await import('./run-engine.mjs');
  await rejects(status(fx.ctx({ policy: main })), 'policy_version_unsupported');
  const plain = stageRun(t, { flag: false, line: false });
  okc(plain.cli('init', { dag: plain.dagFile }), 'init plain');
  assert.ok(plain.readState().policy_version <= 24, 'a non-stage run keeps its S1 version');
  plain.editState((st) => { st.policy_version += 24; });
  assert.match(plain.cli('status').stderr, /stage_state_missing/, 'version and stage record come together');
});

test('[P6-R4] the approved stage line must be visible (not in an HTML comment or code fence); artifacts are exact paths; preflight echoes the authorizing fields', { skip: WIN_SKIP }, async (t) => {
  const { parseStagePolicy } = await import('./stage-obligations.mjs');
  const code = (n) => { try { parseStagePolicy(n, { ticket: 'T-1' }); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(`x\n${stageLine(POLICY_236())}\n`), 'ok');
  assert.equal(code(`x\n<!--\n${stageLine(POLICY_236())}\n-->\n`), 'stage_policy_invalid');
  assert.equal(code(`x\n\`\`\`\n${stageLine(POLICY_236())}\n\`\`\`\n`), 'stage_policy_invalid');
  assert.equal(code(`x\n${stageLine(POLICY_236())}\n<!--\n${stageLine(POLICY_236())}\n-->\n`), 'stage_policy_invalid', 'a hidden second line');
  assert.equal(code(`x\n<!-- unterminated\n${stageLine(POLICY_236())}\n`), 'stage_policy_invalid');
  for (const a of ['.specs/**', '.specs/plans/*.md', '.specs/design-parity/T-?.md', '.specs/[ab].md', '.specs/{a,b}.md'])
    assert.equal(code(`${stageLine({ ...POLICY_236(), artifacts: [a] })}\n`), 'stage_policy_invalid', a);
  const fx = secRun(t, { policy: { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }, { id: 'R2', check: 'prod probe', stage: 'production' }],
    deferred: [{ row: 'R2', stage: 'production', environment: 'production', subject: 's', required_evidence: 'e', tracker_ref: 'TRK-1' }], no_runtime_boundary: true } });
  const r = await pf(fx);
  assert.deepEqual(r.stage.stages, ['local', 'merge']);
  assert.equal(r.stage.no_runtime_boundary, true);
  assert.deepEqual(r.stage.deferrals, [{ row: 'R2', deferred_stage: 'production', trigger: null, tracker_ref: 'TRK-1' }]);
});

// Frozen-behaviour pins of the real hazards (NIT-2): each held on 83c731a and still holds today WITHOUT config.stagePolicy.
test('[P6-H1..H5] frozen hazards stay frozen without the flag: parity artifact, runner reach, missing command, `this.api.get(`, sticky REAPPROVAL', { skip: WIN_SKIP }, async (t) => {
  assert.equal((await pf(secRun(t, { flag: false, policy: null, config: { riskLabels: ['ui'] } }))).code, 'preflight_ok', 'H1');
  assert.equal((await pf(secRun(t, { flag: false, policy: null, nodes: [{ id: 'client', deps: [], writes: ['apps/admin'], redSpecs: [{ file: 'apps/admin/src/settings.service.spec.ts', name: 'loads settings' }] }] }))).code, 'preflight_ok', 'H2');
  assert.equal((await pf(secRun(t, { flag: false, policy: null, config: { testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' }, lint: { cmd: './scripts/lint.sh', args: [] } } } }))).code, 'preflight_ok', 'H3');
  const id = `new-route@${CLIENT}`;
  for (const c of [[], [{ signal_id: id, reason: 'HTTP client call' }]]) assert.equal(rea([{ path: CLIENT, added: [CLIENT_LINE] }], { allow: false, classifications: c }).code, 'classification_missing', 'H4');
  const fx = secRun(t, { flag: false, policy: null });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive');
  mkdirSync(join(fx.repo, '.specs', 'design-parity'), { recursive: true }); writeFileSync(join(fx.repo, '.specs', 'design-parity', 'T-1.md'), '# parity\n');
  assert.equal(fx.gate('reassess', {}).out?.code, 'security_reapproval', 'H5');
});

// ---- R2 (RCA-S4-ROUND2 steps 2-4) ------------------------------------------------------------------------------
const EVIDENCE = (c, over = {}) => ({ stage: 'production', environment: 'production', subject: 'api release of this candidate', candidate_id: c,
  required_evidence: 'read-only probe output against production after deploy', result: 'pass', ref: 'gh-run-9', summary: 'probe passed', ...over });
async function shipped(t, policy) {
  const fx = stageRun(t, policy ? { policy } : {});
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive');
  const cand = fx.candidate();
  okc(fx.gate('review', passReview('review-1', cand)), 'review'); okc(fx.gate('ship-ready', {}), 'ship-ready');
  const ev = join(fx.root, 'ev.json');
  const verify = (id, e) => { writeFileSync(ev, J(e)); return fx.cli('obligation-verify', { id, input: ev }); };
  return { fx, cand, verify };
}

test('[P6-R2b] a stored `verified` status is authoritative only through a retained OBLIGATION_VERIFIED record: every forge is refused on load', { skip: WIN_SKIP }, async (t) => {
  const forges = [
    ['the round-2 4-field stub (Codex/Opus forge.test.mjs)', (st, c) => { const o = st.stage.obligations[0]; o.status = 'verified'; o.evidence = { candidate_id: c, result: 'pass', ref_id: 'forged', digest: 'x' }; }],
    ['a full, self-consistent evidence copy with no retained record', (st, c) => { const o = st.stage.obligations[0]; o.status = 'verified';
      o.evidence = { ...EVIDENCE(c), digest: 'sha256:' + '1'.repeat(64), ref_id: 'gh-run-9', seq: 1 }; }],
  ];
  for (const [what, edit] of forges) {
    const { fx, cand } = await shipped(t);
    fx.editState((st) => edit(st, cand));
    const st = fx.cli('status');
    assert.notEqual(st.status, 0, what); assert.match(st.stderr, /stage_state_invalid/, `${what}: ${st.stderr}`);
  }
  // a real verification, then forges of its retained record
  const tamper = [
    ['record digest edited', (st) => { st.stage.verifications[0].evidence_digest = 'sha256:' + '2'.repeat(64); }],
    ['record evidence edited (result)', (st) => { st.stage.verifications[0].evidence.result = 'fail'; }],
    ['record bound to another row', (st) => { st.stage.verifications[0].row = 'R9'; }],
    ['record deleted, status kept', (st) => { st.stage.verifications = []; }],
    ['status flipped back to open with the record kept', (st) => { st.stage.obligations[0].status = 'open'; st.stage.obligations[0].evidence = null; }],
    ['record duplicated (ref twice)', (st) => { st.stage.verifications.push({ ...st.stage.verifications[0] }); }],
  ];
  for (const [what, edit] of tamper) {
    const { fx, cand, verify } = await shipped(t);
    okc(verify('R2', EVIDENCE(cand)), 'verify');
    okc(fx.cli('status'), `${what}: the untampered twin loads`);
    fx.editState(edit);
    const st = fx.cli('status');
    assert.notEqual(st.status, 0, what); assert.match(st.stderr, /stage_state_invalid/, `${what}: ${st.stderr}`);
  }
  // the retained record carries the full evidence schema and the recomputable digest
  const { fx, cand, verify } = await shipped(t);
  okc(verify('R2', EVIDENCE(cand)), 'verify');
  const rec = fx.readState().stage.verifications[0];
  assert.deepEqual(Object.keys(rec.evidence).sort(), Object.keys(EVIDENCE(cand)).sort());
  assert.equal(rec.row, 'R2'); assert.equal(rec.candidate_id, cand); assert.equal(rec.ref_id, 'gh-run-9');
  assert.ok(runStateEvents(fx.planFile).some((e) => e.event === 'OBLIGATION_VERIFIED' && e.evidence_digest === rec.evidence_digest));
});

test('[P6-R2c] a consumed evidence ref stays consumed run-wide, also after the obligation reopens on a new candidate', { skip: WIN_SKIP }, async (t) => {
  const { fx, cand: c1, verify } = await shipped(t);
  okc(verify('R2', EVIDENCE(c1, { ref: 'ci-run-123' })), 'verify c1');
  fx.appendRunState({ run_id: 'run-1', event: 'RETRY', review_execution: 'review-2', predecessor: 'review-1', authorized_by: 'owner', reason: 'test: second candidate', timestamp: new Date().toISOString() });
  fx.behave({ a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } });
  okc(fx.gate('review', failReview('review-2', c1, 'src/a.txt', fx.prompt('fix'))), 'review 2 FAIL');
  okc(fx.cli('drive'), 'repair');
  const c2 = fx.candidate();
  okc(fx.gate('review', confirmReview('review-2', c2)), 'confirmation');
  okc(fx.gate('ship-ready', {}), 'ship-ready c2');
  assert.equal(fx.readState().stage.obligations[0].status, 'open');
  assert.equal(verify('R2', EVIDENCE(c2, { ref: 'ci-run-123' })).out?.code, 'obligation_evidence_reused', 'the c1 ref cannot verify c2');
  okc(verify('R2', EVIDENCE(c2, { ref: 'ci-run-124' })), 'a new ref verifies c2');
  assert.equal(fx.readState().stage.verifications.length, 2, 'both records retained');
  okc(fx.cli('status'), 'loads');
});

test('[P6-R2d] a foreign-worktree command (the deadline sweep from main after the owning worktree is gone) never reads the caller\'s plan', { skip: WIN_SKIP }, async (t) => {
  for (const staged of [false, true]) {
    const fx = fixture(t, { commit: true, narrativeExtra: staged ? stageLine(POLICY_236()) + '\n\n' : '',
      config: { testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } }, ...(staged ? { stagePolicy: { version: 1 } } : {}) } });
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

test('[P6-R2e] CommonMark fences hide the stage line: indented (1-3 spaces), longer backtick and tilde fences, an inner shorter fence, unterminated', async () => {
  const { parseStagePolicy } = await import('./stage-obligations.mjs');
  const L = stageLine(POLICY_236());
  const code = (n) => { try { parseStagePolicy(n, { ticket: 'T-1' }); return 'ok'; } catch (e) { return e.code; } };
  for (const [what, n] of [['1-space fence', ` \`\`\`\n${L}\n \`\`\`\n`], ['3-space fence', `   \`\`\`js\n${L}\n   \`\`\`\n`], ['4-backtick with inner ```', `\`\`\`\`\n\`\`\`\n${L}\n\`\`\`\`\n`],
    ['~~~~ closed only by ~~~~', `~~~~\n~~~\n${L}\n~~~~\n`], ['unterminated ````', `\`\`\`\`\n${L}\n`], ['a backtick fence is not closed by tildes', `\`\`\`\n~~~\n${L}\n`]])
    assert.equal(code(`x\n${n}`), 'stage_policy_invalid', what);
  // a closed fence BEFORE the visible line does not hide it; 4 spaces is not a fence (an indented line, and the stage line is at column 1)
  assert.equal(code(`x\n\`\`\`\`\ncode\n\`\`\`\`\`\n${L}\n`), 'ok', 'a longer closer closes');
  assert.equal(code(`x\n~~~\ncode\n~~~\n${L}\n`), 'ok');
  assert.equal(code(`x\n    \`\`\`\n${L}\n`), 'ok', 'four spaces: an indented code line, not a fence opener');
});

test('[P6-R2f] runner reach counts only understood selectors: option values, -e argv, unknown commands and evidence entries reach nothing', { skip: WIN_SKIP }, async (t) => {
  const client = { id: 'client', deps: [], writes: ['apps/admin'], redSpecs: [{ file: 'apps/admin/src/settings.service.spec.ts', name: 'loads settings' }] };
  const pol = { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [] };
  const UNIT = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' };
  const run = (client2) => pf(secRun(t, { policy: pol, nodes: [client], config: { testCommands: { unit: UNIT, client: client2 } } }));
  const SPECF = 'apps/admin/src/settings.service.spec.ts';
  for (const args of [['--test', '--test-name-pattern', SPECF], ['--test', '--test-reporter', 'apps/admin'], ['-e', 'process.exit(0)', SPECF], ['--eval', 'x', SPECF], [SPECF], ['--test', '--import', 'apps/admin']])
    await rejects(run({ cmd: process.execPath, args, format: 'tap' }), 'red_runner_missing');
  await rejects(run({ cmd: 'npx', args: ['vitest', 'run', SPECF], format: 'tap' }), 'red_runner_missing'); // an unknown runner: reach unproven
  assert.equal((await run({ cmd: process.execPath, args: ['--test', '--test-reporter=tap', 'apps/admin/src/settings.servic?.spec.ts'], format: 'tap' })).code, 'preflight_ok', '? is a one-character glob');
  assert.equal((await run({ cmd: process.execPath, args: ['--test', '--test-concurrency=1', '--test-reporter=tap', 'apps/admin'], format: 'tap' })).code, 'preflight_ok');
});
