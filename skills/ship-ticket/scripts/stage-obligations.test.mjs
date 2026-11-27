/**
 * STAB S4 (P6): stage obligations, plan-feasibility preflight and the classifier "no runtime boundary" disposition.
 * Every test here is one §8 P6 negative (tagged [P6-Nx]) or its positive twin, written before the mechanism and
 * shown RED on the frozen tree (83c731a). The mechanism is opt-in: a DAG without `config.stagePolicy` keeps the
 * frozen semantics byte for byte ([P6-OFF]).
 *
 * ============================ CONTRACT (S4, PROVISIONAL, UNQUALIFIED) ============================
 * stage-policy-v1 line (approved narrative, so the plan digest binds it): { merge_stage, stages[], rows[{id, check,
 *   stage, pair?}], deferred[{row, stage, environment, subject, required_evidence, trigger? | tracker_ref?}],
 *   artifacts?[], runners?{entry: [globs]}, no_runtime_boundary? }.
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
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
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
    required_evidence: 'read-only probe output against production after deploy', tracker_ref: 'SCRUM-430' }],
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
  const pol = policy ?? { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [], runners: { unit: ['spec/**'] } };
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
  const sec = secRun(t, { policy: { ...bare, runners: { unit: ['spec/**'] } } });
  await rejects(pf(sec), 'obligation_trigger_missing');
  // positive twins: a tracker or a trigger
  const good = stageRun(t);
  okc(good.cli('init', { dag: good.dagFile }), 'init with a tracker');
  const ob = good.readState().stage.obligations;
  assert.deepEqual(ob.map((o) => [o.row, o.status, o.deferred_stage, o.verified_through, o.tracker_ref]), [['R2', 'open', 'production', 'merge', 'SCRUM-430']]);
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
  writeFileSync(ev, J({ stage: 'production', environment: 'production', subject: 'api release of this candidate', candidate_id: c1, ref: 'gh-run-1', summary: 'probe passed' }));
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
  two.deferred.push({ row: 'R3', stage: 'production', environment: 'production', subject: 'api release of this candidate', required_evidence: 'DKIM lookup output', tracker_ref: 'SCRUM-431' });
  const fx = stageRun(t, { policy: two });
  okc(fx.cli('init', { dag: fx.dagFile }), 'init');
  const ev = join(fx.root, 'ev.json');
  const verify = (id, e) => { writeFileSync(ev, J(e)); return fx.cli('obligation-verify', { id, input: ev }); };
  const good = (c) => ({ stage: 'production', environment: 'production', subject: 'api release of this candidate', candidate_id: c, ref: 'gh-run-7', summary: 'probe passed' });
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
  assert.equal(code(verify('R9', good(cand))), 'obligation_unknown', 'no runtime path creates an obligation');
  for (const r of ['R2']) assert.equal(fx.readState().stage.obligations.find((o) => o.row === r).status, 'open');
  okc(verify('R2', good(cand)), 'new evidence verifies');
  assert.equal(fx.readState().stage.obligations.find((o) => o.row === 'R2').status, 'verified');
  // the same evidence (identical record) cannot verify a second obligation
  assert.equal(code(verify('R3', good(cand))), 'obligation_evidence_reused');
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
    deferred: [...POLICY_236().deferred, { row: 'P1', stage: 'production', environment: 'production', subject: 'x', required_evidence: 'y', tracker_ref: 'T-9' }], runners: { unit: ['spec/**'] } } });
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
  const pol = { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [], runners: { unit: ['spec/**'] } };
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

test('[P6-N6b] 124 RED for a new client file: a RED spec no formatted runner covers is refused before approval; a runner command that is not executable is refused', { skip: WIN_SKIP }, async (t) => {
  const client = { id: 'client', deps: [], writes: ['apps/admin'], redSpecs: [{ file: 'apps/admin/src/settings.service.spec.ts', name: 'loads settings' }] };
  const pol = { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [], runners: { unit: ['spec/**'] } };
  const v1 = secRun(t, { policy: pol, nodes: [client] });
  await rejects(pf(v1), 'red_runner_missing');
  const v2 = secRun(t, { policy: { ...pol, runners: { unit: ['spec/**', 'apps/admin/**/*.spec.ts'] } }, nodes: [client] });
  assert.equal((await pf(v2)).code, 'preflight_ok');
  // a runner entry named in `runners` that is not a formatted testCommands entry is invalid
  const ghost = secRun(t, { policy: { ...pol, runners: { unit: ['spec/**'], karma: ['apps/**'] } } });
  await rejects(pf(ghost), 'stage_policy_invalid');
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
const CLIENT = 'apps/superadmin/src/app/features/settings/settings.service.ts'; // the 124 file (StoreCraft SCRUM-124 tree)
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
    for (const path of [CLIENT, 'apps/superadmin/src/app/features/settings/settings-api.service.spec.ts']) {
      const files = [{ path, added: ['import { inject } from "@angular/core";', CLIENT_LINE, "    expect(this.api.get).toHaveBeenCalled();",
        "    this.api.get(`/settings/${id}`, { params: { a: '1, 2' } }).subscribe((r) => done(r));"] }];
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
  const pol = { merge_stage: 'merge', stages: ['local', 'merge'], rows: [{ id: 'R1', check: 'pair specs', stage: 'local' }], deferred: [], runners: { unit: ['spec/**'] },
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
