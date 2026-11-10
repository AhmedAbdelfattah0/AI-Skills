/**
 * AIS-HARNESS-4 Wave B: the engine half of security policy 2, driven through the REAL engine
 * (`node run-engine.mjs` on a temp git repo with a fake provider CLI), or the exported commands when a
 * test needs the ctx.catalogFile seam. Assertions are on codes (C12). Tests tagged [S#] are the ones
 * engine-security-mutation.test.mjs expects to fail when guard S# is patched out.
 *
 * ============================ CONTRACT ADDITIONS (Wave B) ============================
 * init: no config.securityPolicy -> only a trusted START approved before SECURITY_POLICY_CUTOFF
 *   (security_policy_required). Policy 2 -> the installed catalog loads and equals config.catalogDigest
 *   (catalog_unavailable), every control is in it (dag_invalid), the narrative carries the
 *   security-pairs line of exactly the DAG's pairs and a verified §3a block with them (security_pairs_mismatch).
 * verifyBinding: a legacy config under a non-legacy trusted START -> judgment security_policy_required;
 *   a recorded REAPPROVAL -> judgment security_reapproval (drive and every gate stop).
 * gate reassess { classifications } (policy 2 only, else bad_input): security-plan.mjs reassess over the
 *   candidate's changed files and the Design Contract (DAG writes). UNCHANGED records the freshness tuple
 *   (candidate_id, plan_digest, catalog_digest, addendum_set) and SECURITY_REASSESSED; an unclassified
 *   signal -> reassess_unclassified; uncovered ADD_CONTROLS -> addendum_required; REAPPROVAL -> security_reapproval.
 * gate review (policy 2): the recorded reassessment must be of the current tuple (reassess_stale); an
 *   original needs exactly one rule_row per effective pair (incomplete_contract), NOT_APPLICABLE only for a
 *   waived pair (security_row_escape), never NOT_TRIGGERED with unwaived pairs (security_outcome_escape);
 *   the accepted original records security_coverage { catalog_digest, addendum_set }.
 * gate ship-ready (policy 2): reassess_stale, then security_review_stale when the authorizing original's
 *   coverage is not the current one, then the legacy verdict, then control_unproven per unwaived pair whose
 *   RED (node or addendum slot) is missing or no longer binds or whose spec is not 'pass' in this proof.
 * Events: SECURITY_ADDENDUM / SECURITY_WAIVER are owner authority (trusted only when observed quiescent).
 * Legacy runs: no new key, event or output (C3).
 * ======================================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, passReview, failReview, confirmReview, primaryReview, runStateEvents, runLogEvents, codes } from './engine-test-fixture.mjs';
import * as DAG from './engine-dag.mjs';
// The one cutoff constant (never a copy of its value here: it is finalized at merge).
const SECURITY_POLICY_CUTOFF = DAG.SECURITY_POLICY_CUTOFF;
const ENGINE_SECURITY_CODES = DAG.ENGINE_SECURITY_CODES ?? [];
import { init, gate as gateCmd } from './run-engine.mjs';
import { securityRefusal, reassessRefusal, coverageRefusal, securityRowsRefusal } from './engine-gates.mjs';
import * as AUTH from './engine-authority.mjs';
import { gateShipReady } from './gate.mjs';
import * as SP from './security-plan.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment (known limit N7)';
const J = JSON.stringify;
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const refused = (r, code) => { assert.equal(r.status, 2, `want ${code}: ${r.stdout}${r.stderr}`); assert.equal(r.out?.code, code, r.stdout); return r; };
const initFails = (r, code) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, new RegExp(`run-engine: ${code}:`)); };
const CUT = Date.parse(SECURITY_POLICY_CUTOFF);
const iso = (ms) => new Date(ms).toISOString();

// ------------------------------------------------------------------ policy-2 fixture

const CATALOG = SP.loadCatalog();
assert.equal(CATALOG.ok, true, 'the installed catalog loads');
const BOOLS = Object.entries(CATALOG.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
/** A selection over the REAL catalog: one server-input surface (12 pairs) or none (an evidenced empty assessment). */
function selection({ surfaces = true } = {}) {
  const r = SP.selectControls(CATALOG, { security_policy: 2,
    surfaces: surfaces ? [{ boundary_id: 'orders-api', kind: 'server-input', path: 'src/orders.ts', principals: ['service'] }] : [],
    facts: Object.fromEntries(BOOLS.map(k => [k, false])), evidence: Object.fromEntries(BOOLS.map(k => [k, 'src/orders.ts:handler'])) });
  assert.equal(r.ok, true, J(r));
  return r;
}
const SPEC_FILE = 'spec/sec.test.mjs';
/** One test per pair: fails until src/impl.txt exists; the pair named in src/skip.txt is skipped. */
const specText = (ids) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `const skip = fs.existsSync('src/skip.txt') ? fs.readFileSync('src/skip.txt', 'utf8').trim() : '';\n`
  + `for (const id of ${J(ids)}) test(id, { skip: id === skip }, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
const UNIT = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC_FILE], format: 'tap' };

/**
 * A policy-2 run: node `api` writes the pair specs (its named redSpecs), node `impl` (after api's RED)
 * writes src/impl.txt. `coverage(pairs)` and `narrative(sel)` let a row bend the DAG or the plan.
 */
function secFx(t, { surfaces = true, coverage = (c) => c, narrative, catalogDigest = CATALOG.digest, startAt, implWrites = {}, extraNodes = [],
  testCommands = { unit: UNIT }, extraEvents = () => [], behaviour = {} } = {}) {
  const sel = selection({ surfaces });
  const ids = sel.pairs.map(p => p.pair_id);
  const cov = coverage(sel.pairs.map(p => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC_FILE, name: p.pair_id }] })));
  const fx = fixture(t, { commit: true, startAt, extraEvents,
    narrativeExtra: (narrative ? narrative(sel) : SP.renderSection3a(sel)) + '\n\n',
    config: { width: 1, testCommands, securityPolicy: 2, catalogDigest, controlCoverage: cov },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap(c => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }, ...extraNodes],
    behaviour: { api: { write: { [SPEC_FILE]: specText(ids) } }, impl: { write: { 'src/impl.txt': 'done', ...implWrites } }, ...behaviour } });
  // The base holds everything the fixture wrote, so the candidate is exactly what the nodes change.
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: fx.repo, encoding: 'utf8' });
  g('add', '-A'); assert.equal(g('commit', '-q', '-m', 'base').status, 0);
  return Object.assign(fx, { sel, ids: cov.map(c => `${c.boundary}:${c.control}`), cov });
}
const rows = (ids, over = {}) => ids.map(id => ({ subject_id: id, outcome: 'PASS', evidence: SPEC_FILE, ...(over[id] ?? {}) }));
const secReview = (fx, rx, { ids = fx.ids, over = {}, primary = {} } = {}) => {
  const cand = fx.candidate();
  return passReview(rx, cand, { primary: primaryReview(cand, { rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...rows(ids, over)], ...primary }) });
};
/** init, build api, RED, build impl, reassess: ready for review. */
function built(fx) {
  ok(fx.cli('init', { dag: fx.dagFile }), 'init');
  ok(fx.cli('drive'), 'drive api');
  ok(fx.gate('red', { node: 'api' }), 'RED');
  ok(fx.cli('drive'), 'drive impl');
  ok(fx.gate('reassess', {}), 'reassess');
  return fx;
}
const proofRuns = (fx) => fx.readState().attempts.filter(a => a.kind === 'proof').length;
const waiver = (fx, id, over = {}) => { const [b, c] = [id.slice(0, id.lastIndexOf(':')), id.slice(id.lastIndexOf(':') + 1)];
  return { run_id: 'run-1', event: 'SECURITY_WAIVER', boundary: b, control: c, candidate: fx.candidate(), policy_version: 2, authorized_by: 'owner', reason: 'accepted risk', ...over }; };

// ------------------------------------------------------------------ C3 legacy parity

test('[S12] C3 a legacy (grandfathered) run carries no security key, event or output', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { width: 1, testCommands: { proof: { cmd: process.execPath, args: ['-e', ''] } } },
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, fix: { write: { 'src/a.txt': 'fixed' } } } });
  const outs = [];
  const step = (r) => { outs.push(r.out); return r; };
  ok(step(fx.cli('init', { dag: fx.dagFile })));
  ok(step(fx.cli('drive')));
  ok(step(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix')))));
  ok(step(fx.cli('drive')));
  ok(step(fx.gate('review', confirmReview('rx-1', fx.candidate()))));
  ok(step(fx.gate('ship-ready', {})));
  ok(step(fx.cli('status')));
  const S = fx.readState();
  const text = J({ outs, S, log: runLogEvents(fx.engineLog()), rs: runStateEvents(fx.planFile) });
  assert.doesNotMatch(text, /securit|SECURITY_|control|catalog|reassess|addendum|waiver|spec_results|red_addendum/i);
  assert.equal(S.local_proof.spec_results, undefined);
  assert.equal(fx.gate('reassess', {}).status, 1, 'gate reassess is a usage error without policy 2');
  assert.equal(fx.gate('red', { node: 'a', addendum: 'add-1' }).status, 1, 'an addendum RED is a usage error without policy 2');
});

// ------------------------------------------------------------------ grandfathering

test('[S2] grandfathering: a legacy DAG is refused at init once START is at/after the cutoff, admitted just before it', { skip: WIN_SKIP }, (t) => {
  const at = fixture(t, { startAt: iso(CUT) });
  initFails(at.cli('init', { dag: at.dagFile }), 'security_policy_required');
  const late = fixture(t, { startAt: iso(CUT + 86400000) });
  initFails(late.cli('init', { dag: late.dagFile }), 'security_policy_required');
  const early = fixture(t, { startAt: iso(CUT - 1000) });
  ok(early.cli('init', { dag: early.dagFile }));
  const none = fixture(t, { startAt: undefined });
  ok(none.cli('init', { dag: none.dagFile }), 'the default fixture START (2026-11-05) stays grandfathered');
});

test('[S2] grandfathering: a legacy state that later sees a trusted post-cutoff START gets a judgment; a policy-2 DAG is admitted after the cutoff', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true });
  ok(fx.cli('init', { dag: fx.dagFile }));
  const start = runStateEvents(fx.planFile).find(e => e.event === 'START');
  fx.appendRunState({ ...start, timestamp: iso(CUT + 1000) });
  const r = fx.cli('drive');
  assert.equal(r.status, 2);
  assert.ok(codes(r.out).includes('security_policy_required'), r.stdout);
  const p2 = secFx(t, { startAt: iso(CUT + 86400000) });
  ok(p2.cli('init', { dag: p2.dagFile }), 'policy 2 needs no grandfathering');
});

// ------------------------------------------------------------------ C9 narrative vs DAG

test('[S13] C9 init binds the narrative pairs line and §3a block to the DAG both ways; an exact match (also []) is admitted', { skip: WIN_SKIP }, (t) => {
  const initOf = (fx) => fx.cli('init', { dag: fx.dagFile });
  ok(initOf(secFx(t)), 'exact match');
  ok(initOf(secFx(t, { surfaces: false })), 'an evidenced empty assessment []');
  initFails(initOf(secFx(t, { coverage: (c) => c.slice(1) })), 'security_pairs_mismatch'); // DAG a subset of the plan
  initFails(initOf(secFx(t, { surfaces: false, coverage: () => [{ boundary: 'orders-api', control: 'VAPT-API-01', node: 'api', specs: [{ file: SPEC_FILE, name: 'x' }] }] })),
    'security_pairs_mismatch'); // DAG a superset of the plan
  initFails(initOf(secFx(t, { narrative: () => '' })), 'security_pairs_mismatch'); // no line, no block
  initFails(initOf(secFx(t, { narrative: (sel) => SP.renderSection3a(sel).replace(/<!-- security-plan: .* -->/, '') })), 'security_pairs_mismatch'); // line, no block
  initFails(initOf(secFx(t, { narrative: (sel) => SP.pairsLine({ catalogDigest: 'sha256:' + '0'.repeat(64), pairs: sel.pairs }) })), 'security_pairs_mismatch');
  initFails(initOf(secFx(t, { catalogDigest: 'sha256:' + '0'.repeat(64) })), 'catalog_unavailable'); // DAG digest is not the installed catalog
  initFails(initOf(secFx(t, { coverage: (c) => c.map((p, i) => (i ? p : { ...p, control: 'VAPT-API-99' })) })), 'dag_invalid'); // control not in the catalog
});

test('[S13] init: a missing catalog is catalog_unavailable (in-process seam); the installed catalog digest is computed from the file', { skip: WIN_SKIP }, async (t) => {
  const fx = secFx(t);
  await assert.rejects(init(fx.ctx({ catalogFile: join(fx.root, 'no-catalog.json') })), (e) => e.code === 'catalog_unavailable');
  const bytes = readFileSync(new URL('../../vapt/controls.json', import.meta.url));
  assert.equal(CATALOG.digest, SP.catalogDigest(bytes));
  await init(fx.ctx());
});

// ------------------------------------------------------------------ happy path, C8, C10, C11

test('[S6] [S7] policy 2 end to end: RED, reassess, review rows, first ship-ready runs the proof and ships', { skip: WIN_SKIP }, (t) => {
  const fx = built(secFx(t));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  const rec = fx.readState().review_chain.at(-1);
  assert.deepEqual(rec.security_coverage, { catalog_digest: CATALOG.digest, addendum_set: [] });
  const r = fx.gate('ship-ready', {});
  ok(r, 'the first call runs the proof and every pair spec passes');
  const S = fx.readState();
  assert.equal(S.local_proof.spec_results.length, fx.ids.length);
  assert.ok(S.local_proof.spec_results.every(x => x.status === 'pass'));
  assert.ok(runStateEvents(fx.planFile).some(e => e.event === 'SECURITY_REASSESSED'));
  assert.ok(runStateEvents(fx.planFile).some(e => e.event === 'SHIP_READY'));
});

test('[S7] [S6] C8/C10 a skipped pair spec: the first ship-ready runs the proof then refuses naming only that pair; no proof loop', { skip: WIN_SKIP }, (t) => {
  const fx0 = secFx(t);
  const skipped = fx0.ids[3];
  const fx = built(secFx(t, { implWrites: { 'src/skip.txt': skipped } }));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  const first = refused(fx.gate('ship-ready', {}), 'control_unproven');
  assert.deepEqual(first.out.missing, [`${skipped}-spec`]);
  assert.equal(proofRuns(fx), 1, 'the proof ran on the first call');
  assert.equal(fx.readState().local_proof.spec_results.find(x => x.name === skipped).status, 'skip');
  refused(fx.gate('ship-ready', {}), 'control_unproven');
  assert.equal(proofRuns(fx), 1, 'a proven-by-exit-code candidate is not re-run');
});

test('[S11] C11 a pair spec whose bytes changed since RED never proves the pair', { skip: WIN_SKIP }, async (t) => {
  const fx = built(secFx(t));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  fx.editState((S) => { S.gates.red.api.spec_digests[SPEC_FILE] = 'sha256:' + 'f'.repeat(64); }); // RED was taken on other bytes
  const r = refused(fx.gate('ship-ready', {}), 'control_unproven');
  assert.equal(r.out.missing.length, fx.ids.length);
});

test('C11 (CLI) rewriting the spec file after RED is refused', { skip: WIN_SKIP }, (t) => {
  const fx = built(secFx(t));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  writeFileSync(join(fx.repo, SPEC_FILE), specText(fx.ids).replace("'not implemented'", "'placeholder'"));
  const r = fx.gate('ship-ready', {});
  assert.equal(r.status, 2, r.stdout);
  assert.ok(['post_freeze_drift', 'control_unproven', 'candidate_mismatch'].includes(r.out.code), r.stdout);
});

test('[S19] a pair spec suppressed at import (process.exit(0)) behind a same-named passing decoy never proves its pair: control_unproven', { skip: WIN_SKIP }, (t) => {
  const ids = selection().pairs.map(p => p.pair_id);
  const DECOY = 'spec/decoy.test.mjs';
  // The spec imports src/hook.mjs when it exists; the implementation makes that module exit 0 at load, so no spec test runs.
  const spec = `try { await import('../src/hook.mjs'); } catch {}\n${specText(ids)}`;
  const decoy = `import test from 'node:test';\nfor (const id of ${J(ids)}) test(id, () => {});\n`;
  const both = { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC_FILE, DECOY], format: 'tap' };
  const fx = built(secFx(t, { testCommands: { unit: both }, implWrites: { 'src/hook.mjs': 'process.exit(0);\n' },
    behaviour: { api: { write: { [SPEC_FILE]: spec, [DECOY]: decoy } } } }));
  assert.deepEqual(Object.keys(fx.readState().gates.red), ['api'], 'RED was accepted on the spec\'s located assertion failures');
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  const r = refused(fx.gate('ship-ready', {}), 'control_unproven');
  assert.deepEqual([...r.out.missing].sort(), fx.ids.map(id => `${id}-spec`).sort());
  const S = fx.readState();
  assert.ok(S.local_proof.commands.every(c => c.result === 'pass'), 'the proof command itself exits 0');
  assert.ok(S.local_proof.spec_results.every(x => x.status === 'missing'), J(S.local_proof.spec_results));
});

test('[S21] a formatted proof whose output was truncated proves no pair spec (unparsed): control_unproven', { skip: WIN_SKIP }, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pad-reporter-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reporter = join(dir, 'pad.mjs');
  // node's TAP, then 32 MiB + 4 KiB of comment past the launcher's cap: every pair spec's `ok` line is in the kept prefix.
  writeFileSync(reporter, `import { tap } from 'node:test/reporters';\nexport default async function* pad(source) { for await (const l of tap(source)) yield l; `
    + `yield '# ' + 'p'.repeat(${32 * 1024 * 1024 + 4096}) + '\\n'; }\n`);
  const loud = { cmd: process.execPath, args: ['--test', `--test-reporter=${reporter}`, SPEC_FILE], format: 'tap' };
  const fx = secFx(t, { testCommands: { unit: UNIT, loud } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api', command: 'unit' })); ok(fx.cli('drive')); ok(fx.gate('reassess', {}));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  const r = refused(fx.gate('ship-ready', {}), 'control_unproven');
  assert.equal(r.out.missing.length, fx.ids.length);
  const S = fx.readState();
  assert.ok(S.attempts.some(a => a.kind === 'proof' && a.node === 'loud' && a.envelope?.truncated === true), 'the loud proof was truncated');
  assert.ok(S.local_proof.commands.every(c => c.result === 'pass'), 'every proof command exits 0');
  assert.ok(S.local_proof.spec_results.every(x => x.status === 'unparsed'), J(S.local_proof.spec_results));
});

test('[S28] a proof command that moves config.base (an empty commit, candidate unchanged) leaves every pair unproven: control_unproven', { skip: WIN_SKIP }, (t) => {
  // The proof's last command commits nothing on HEAD (config.base): the work tree, so the candidate, is unchanged.
  const move = { cmd: process.execPath, args: ['-e', "require('child_process').execFileSync('git',"
    + "['-c','user.name=t','-c','user.email=t@example.com','commit','-q','--allow-empty','-m','moved'])"] };
  const fx = built(secFx(t, { testCommands: { unit: UNIT, move } }));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  const head = () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).stdout.trim();
  const [before, cand] = [head(), fx.candidate()];
  assert.equal(fx.readState().gates.red.api.base_commit, before, 'RED was accepted against the current base');
  const r = refused(fx.gate('ship-ready', {}), 'control_unproven');
  assert.notEqual(head(), before, 'the proof moved the base');
  assert.equal(fx.candidate(), cand, 'the candidate is unchanged');
  const S = fx.readState();
  assert.equal(S.local_proof.candidate_id, cand, 'the proof is bound to the candidate');
  assert.ok(S.local_proof.spec_results.every(x => x.status === 'pass'), 'every pair spec passed: only the RED binding is unproven');
  assert.deepEqual([...r.out.missing].sort(), fx.ids.map(id => `${id}-spec`).sort());
  assert.equal(S.ship_ready, undefined);
});

test('[S20] [S25] [S26] reassess: a new route is never dismissed by a reason alone; `surfaces` makes it ADD_CONTROLS (addendum_required); a trusted covering addendum makes it fresh', { skip: WIN_SKIP }, (t) => {
  const ROUTE = 'src/routes/admin.ts';
  const fx = secFx(t, { implWrites: { [ROUTE]: "app.get('/admin', (req, res) => res.send('ok'));\n" },
    extraNodes: [{ id: 'extra', writes: ['spec2'] }], behaviour: { extra: { write: { 'spec2/admin.test.mjs': '// route specs\n' } } } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' })); ok(fx.cli('drive'));
  const sig = `new-route@${ROUTE}`;
  assert.deepEqual(refused(fx.gate('reassess', {}), 'reassess_unclassified').out.unclassified, [sig]);
  assert.deepEqual(refused(fx.gate('reassess', { classifications: [{ signal_id: sig, reason: 'internal only' }] }), 'reassess_unclassified').out.unclassified, [sig],
    'a reason alone does not dismiss a new route off every approved surface');
  const NEW = { boundary_id: 'admin-api', kind: 'server-input', path: ROUTE, principals: ['service'] };
  const add = refused(fx.gate('reassess', { surfaces: [NEW] }), 'addendum_required');
  assert.equal(add.out.judgment_point, true);
  assert.equal(add.out.outcome, 'ADD_CONTROLS');
  for (const c of ['VAPT-API-01', 'VAPT-API-02', 'VAPT-API-03']) assert.ok(add.out.delta_pairs.includes(`admin-api:${c}`), c);
  assert.deepEqual(add.out.addendum.pairs, add.out.delta_pairs, 'the suggested addendum');
  assert.equal(fx.readState().security?.reassessed, undefined, 'ADD_CONTROLS records no fresh reassessment');
  // The owner appends the covering addendum (one spec per pair under node extra's writes).
  fx.appendRunState({ run_id: 'run-1', event: 'SECURITY_ADDENDUM', addendum_id: 'add-route', authorized_by: 'owner', reason: 'reassess ADD_CONTROLS for the admin route',
    pairs: add.out.delta_pairs.map(id => ({ boundary: id.slice(0, id.lastIndexOf(':')), control: id.slice(id.lastIndexOf(':') + 1), node: 'extra',
      specs: [{ file: 'spec2/admin.test.mjs', name: id }] })) });
  const fresh = fx.gate('reassess', { surfaces: [NEW] });
  ok(fresh, 'covered by a trusted addendum');
  assert.equal(fresh.out.outcome, 'UNCHANGED');
  assert.deepEqual(fx.readState().security.reassessed.addendum_set, ['add-route']);
  refused(fx.gate('reassess', {}), 'reassess_unclassified'); // surfaces are not stored: omitted, the signal reopens (fail closed)
  // An approved boundary id redefined by an input surface is refused; the identical definition is the same surface.
  const approved = fx.sel.surfaces[0];
  assert.equal(fx.gate('reassess', { surfaces: [NEW, { ...approved }] }).out.code, 'reassessed');
  const redefined = fx.gate('reassess', { surfaces: [NEW, { ...approved, path: 'src/other.ts' }] });
  assert.equal(redefined.status, 2, redefined.stdout);
  assert.equal(redefined.out.code, 'bad_input');
  // An input surface outside the Design Contract is REAPPROVAL.
  refused(fx.gate('reassess', { surfaces: [NEW, { ...NEW, boundary_id: 'lib-admin', path: 'lib/admin.ts' }] }), 'security_reapproval');
});

test('[S27] reassess: a cited fact (no-op or raised) never dismisses a new route off every approved surface; the same input with `surfaces` is addendum_required', { skip: WIN_SKIP }, (t) => {
  const ROUTE = 'src/routes/admin.ts';
  const fx = secFx(t, { implWrites: { [ROUTE]: "app.get('/admin', (req, res) => res.send('ok'));\n" } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' })); ok(fx.cli('drive'));
  const sig = `new-route@${ROUTE}`;
  const cited = (value) => ({ classifications: [{ signal_id: sig, facts: { [BOOLS[0]]: value }, evidence: { [BOOLS[0]]: `${ROUTE}:1` } }] });
  for (const value of [false, true]) {
    assert.deepEqual(refused(fx.gate('reassess', cited(value)), 'reassess_unclassified').out.unclassified, [sig], `fact ${value}`);
    assert.equal(fx.readState().security?.reassessed, undefined, `fact ${value}: no reassessment is recorded`);
  }
  // Twin, one field (`surfaces`): the surface at the route's path closes the signal and its pairs need an addendum.
  const add = refused(fx.gate('reassess', { ...cited(false), surfaces: [{ boundary_id: 'admin-api', kind: 'server-input', path: ROUTE, principals: ['service'] }] }), 'addendum_required');
  assert.equal(add.out.outcome, 'ADD_CONTROLS');
  for (const c of ['VAPT-API-01', 'VAPT-API-02', 'VAPT-API-03']) assert.ok(add.out.delta_pairs.includes(`admin-api:${c}`), c);
});

// ------------------------------------------------------------------ doc/code field parity

const SHIP_MD = new URL('../references/ship.md', import.meta.url);
/** Envelope keys every delivered event carries; the table row is named by the event. */
const ENVELOPE = ['event', 'event_id'];
/** The backticked field names of an event's row in ship.md's event table (read at test time). */
const documented = (event) => {
  const row = readFileSync(SHIP_MD, 'utf8').split('\n').find(l => l.startsWith(`| **${event}** |`));
  assert.ok(row, `ship.md has a ${event} row`);
  return [...new Set([...row.split('|')[2].matchAll(/`([a-z_]+)`/g)].map(m => m[1]))].filter(k => !ENVELOPE.includes(k)).sort();
};
/** The fields of `event` the code requires: each one whose removal makes `honoured` false (the full event must be honoured). */
const required = (event, honoured) => {
  assert.equal(honoured(event), true, `the probe event is honoured: ${J(event)}`);
  return Object.keys(event).filter(k => !ENVELOPE.includes(k)).filter(k => { const { [k]: _gone, ...rest } = event; return !honoured(rest); }).sort();
};

test('C13 doc/code parity: ship.md documents exactly the fields the code requires (SECURITY_ADDENDUM, SECURITY_WAIVER) or emits (SECURITY_REASSESSED)', { skip: WIN_SKIP }, (t) => {
  const pair = { boundary: 'b', control: 'VAPT-API-01', node: 'api', specs: [{ file: 'spec/x.test.mjs', name: 'n' }] };
  const stateWith = (e, coverage = []) => ({ run_id: 'run-1', config: { securityPolicy: 2, controlCoverage: coverage }, nodes: { api: { id: 'api', writes: ['spec'] } },
    authority: { through: 0, trusted: [J(e)], untrusted: [] } });
  const addendum = { run_id: 'run-1', event: 'SECURITY_ADDENDUM', addendum_id: 'a1', authorized_by: 'owner', reason: 'r', pairs: [pair] };
  const addHonoured = (e) => AUTH.securityEvents(stateWith(e)).pairs.length === 1;
  assert.deepEqual(documented('SECURITY_ADDENDUM'), required(addendum, addHonoured), 'SECURITY_ADDENDUM');
  const waiverEv = { run_id: 'run-1', event: 'SECURITY_WAIVER', boundary: 'b', control: 'VAPT-API-01', candidate: 'c1', policy_version: 2, authorized_by: 'owner', reason: 'r' };
  const waiverHonoured = (e) => { const S = stateWith(e, [pair]); return AUTH.waiverState(S, AUTH.securityEvents(S), 'c1').waived.length === 1; };
  assert.deepEqual(documented('SECURITY_WAIVER'), required(waiverEv, waiverHonoured), 'SECURITY_WAIVER');
  const fx = secFx(t, { surfaces: false });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('reassess', {}));
  const emitted = runStateEvents(fx.planFile).find(e => e.event === 'SECURITY_REASSESSED');
  assert.ok(emitted, 'the engine delivered a SECURITY_REASSESSED event');
  assert.deepEqual(documented('SECURITY_REASSESSED'), Object.keys(emitted).filter(k => !ENVELOPE.includes(k)).sort(), 'SECURITY_REASSESSED');
});

// ------------------------------------------------------------------ review rows

test('[S14] review: a missing pair row, an unwaived NOT_APPLICABLE row and NOT_TRIGGERED are refused; a waiver admits NOT_APPLICABLE', { skip: WIN_SKIP }, (t) => {
  const fx = built(secFx(t));
  const id = fx.ids[0];
  refused(fx.gate('review', secReview(fx, 'rx-1', { ids: fx.ids.slice(1) })), 'incomplete_contract');
  refused(fx.gate('review', secReview(fx, 'rx-1', { ids: [...fx.ids, id] })), 'incomplete_contract');
  refused(fx.gate('review', secReview(fx, 'rx-1', { over: { [id]: { outcome: 'NOT_APPLICABLE' } } })), 'security_row_escape');
  refused(fx.gate('review', secReview(fx, 'rx-1', { primary: { security_outcome: 'NOT_TRIGGERED' } })), 'security_outcome_escape');
  fx.appendRunState(waiver(fx, id));
  ok(fx.gate('review', secReview(fx, 'rx-1', { over: { [id]: { outcome: 'NOT_APPLICABLE' } } })), 'a trusted waiver for this candidate');
  const r = fx.gate('ship-ready', {});
  ok(r, 'the waived pair needs no proof');
});

test('[S15] review and ship-ready need a reassessment of the current tuple (reassess_stale); an empty assessment still reassesses', { skip: WIN_SKIP }, (t) => {
  const fx = secFx(t, { surfaces: false });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  refused(fx.gate('review', secReview(fx, 'rx-1')), 'reassess_stale');
  ok(fx.gate('reassess', {}));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  ok(fx.gate('ship-ready', {}));
});

test('[S18] a repair touching a pair spec file needs the second-opinion confirmation', { skip: WIN_SKIP }, (t) => {
  const fx0 = secFx(t);
  const fx = built(secFx(t, { behaviour: { fix: { write: { [SPEC_FILE]: specText(fx0.ids) + '// reviewed\n' } } } }));
  const cand = fx.candidate();
  const review = secReview(fx, 'rx-1', { primary: { outcome: 'FAIL', findings: [{ id: 'F1', severity: 'major', path: SPEC_FILE }] } });
  ok(fx.gate('review', { ...review, reconciliation: { dispositions: [{ finding_id: 'F1', source: 'primary', disposition: 'fix' }] },
    repair_prompt_file: fx.prompt('fix') }), `FAIL accepted on ${cand}`);
  ok(fx.cli('drive'), 'the repair runs');
  ok(fx.gate('reassess', {}), 'reassess the repaired candidate');
  const repaired = fx.candidate();
  refused(fx.gate('review', confirmReview('rx-1', repaired)), 'missing_second_opinion');
  ok(fx.gate('review', { ...confirmReview('rx-1', repaired), second_opinion: { route: 'codex', reviewer_identity: 'codex:gpt', candidate_id: repaired,
    checked_findings: ['F1'], outcome: 'PASS', evidence: 'F1 fixed' } }), 'with the second-opinion confirmation');
});

// ------------------------------------------------------------------ C6 freshness tuple

test('[S15] C6 each freshness part alone makes the reassessment stale; all unchanged is fresh', { skip: WIN_SKIP }, async (t) => {
  const fx = built(secFx(t));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  const base = fx.readState();
  const ship = async (extra = {}) => (await gateCmd({ ...fx.ctx(extra), gate: 'ship-ready', input: {} }));
  const restore = () => writeFileSync(fx.stateFile(), J(base));
  for (const part of ['candidate_id', 'plan_digest', 'catalog_digest']) {
    fx.editState((S) => { S.security.reassessed[part] = 'other'; });
    assert.equal((await ship()).code, 'reassess_stale', part);
    restore();
  }
  fx.editState((S) => { S.security.reassessed.addendum_set = ['add-0']; });
  assert.equal((await ship()).code, 'reassess_stale', 'addendum_set');
  restore();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-copy-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moved = join(dir, 'controls.json');
  copyFileSync(new URL('../../vapt/controls.json', import.meta.url), moved);
  writeFileSync(moved, readFileSync(moved, 'utf8') + '\n');
  assert.equal((await ship({ catalogFile: moved })).code, 'reassess_stale', 'the installed catalog moved');
  writeFileSync(join(fx.repo, 'docs', 'in.txt'), 'changed'); // in the candidate, outside every node's fingerprints
  refused(fx.gate('ship-ready', {}), 'reassess_stale');
  writeFileSync(join(fx.repo, 'docs', 'in.txt'), 'input v1');
  ok(fx.gate('ship-ready', {}), 'all four parts unchanged');
});

// ------------------------------------------------------------------ reassess outcomes

test('[S16] reassess: an unclassified signal refuses; its classification admits; an out-of-contract path is REAPPROVAL and stops drive', { skip: WIN_SKIP }, (t) => {
  const fx = secFx(t, { implWrites: { 'src/mailer.ts': 'export const go = (m) => transporter.sendMail(m);\n' } });
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' })); ok(fx.cli('drive'));
  const r = refused(fx.gate('reassess', {}), 'reassess_unclassified');
  assert.deepEqual(r.out.unclassified, ['mail-or-notification-send@src/mailer.ts']);
  ok(fx.gate('reassess', { classifications: [{ signal_id: 'mail-or-notification-send@src/mailer.ts', reason: 'test double, never sends' }] }));
  writeFileSync(join(fx.repo, 'docs', 'outside.md'), 'not in the Design Contract');
  const re = refused(fx.gate('reassess', {}), 'security_reapproval');
  assert.equal(re.out.judgment_point, true);
  const d = fx.cli('drive');
  assert.equal(d.status, 2);
  assert.ok(codes(d.out).includes('security_reapproval'), d.stdout);
  refused(fx.gate('review', secReview(fx, 'rx-1')), 'security_reapproval');
});

// ------------------------------------------------------------------ addenda

const ADD_SPEC = { file: 'spec2/add.test.mjs', name: 'payments:VAPT-ABUSE-04' };
const addSpecText = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `test(${J(ADD_SPEC.name)}, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
const ADDENDUM = { run_id: 'run-1', event: 'SECURITY_ADDENDUM', addendum_id: 'add-1', authorized_by: 'owner', reason: 'reassess ADD_CONTROLS',
  pairs: [{ boundary: 'payments', control: 'VAPT-ABUSE-04', node: 'extra', specs: [ADD_SPEC] }] };
const addFx = (t) => secFx(t, { extraNodes: [{ id: 'extra', writes: ['spec2'] }], behaviour: { extra: { write: { [ADD_SPEC.file]: addSpecText } } },
  testCommands: { unit: UNIT, unit2: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', ADD_SPEC.file], format: 'tap' } } });

test('[S8] [S5] a trusted addendum adds a pair that needs its own addendum RED, a row and a passing spec', { skip: WIN_SKIP }, (t) => {
  const fx = addFx(t);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  fx.appendRunState(ADDENDUM);
  ok(fx.gate('red', { node: 'api', command: 'unit' }));
  ok(fx.cli('drive'));
  ok(fx.gate('reassess', {}));
  refused(fx.gate('review', secReview(fx, 'rx-1')), 'incomplete_contract'); // no row for the addendum pair
  ok(fx.gate('review', secReview(fx, 'rx-1', { ids: [...fx.ids, 'payments:VAPT-ABUSE-04'] })));
  const r = refused(fx.gate('ship-ready', {}), 'control_unproven');
  assert.deepEqual(r.out.missing, ['payments:VAPT-ABUSE-04-spec'], 'no addendum RED yet');
  assert.ok(fx.readState().local_proof.spec_results.some(x => x.name === ADD_SPEC.name && x.status === 'pass'));
});

test('[S5] the addendum RED is taken against its own spec before the implementation and lands in its own slot', { skip: WIN_SKIP }, (t) => {
  const fx = addFx(t);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  fx.appendRunState(ADDENDUM);
  ok(fx.gate('red', { node: 'api', command: 'unit' }));
  refused(fx.gate('red', { node: 'extra', command: 'unit2', addendum: 'add-0' }), 'spec_unpinned');
  ok(fx.gate('red', { node: 'extra', command: 'unit2', addendum: 'add-1' }));
  assert.deepEqual(fx.readState().gates.red_addendum['add-1/extra'].specs, [ADD_SPEC]);
  assert.equal(fx.readState().gates.red.extra, undefined);
  ok(fx.cli('drive'));
  ok(fx.gate('reassess', {}));
  ok(fx.gate('review', secReview(fx, 'rx-1', { ids: [...fx.ids, 'payments:VAPT-ABUSE-04'] })));
  ok(fx.gate('ship-ready', {}));
});

test('[S17] an addendum appended after the review makes the review stale for ship-ready (security_review_stale)', { skip: WIN_SKIP }, (t) => {
  const fx = addFx(t);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  ok(fx.gate('red', { node: 'api', command: 'unit' })); ok(fx.cli('drive')); ok(fx.gate('reassess', {}));
  ok(fx.gate('review', secReview(fx, 'rx-1')));
  fx.appendRunState(ADDENDUM);
  refused(fx.gate('ship-ready', {}), 'reassess_stale');
  ok(fx.gate('reassess', {}));
  refused(fx.gate('ship-ready', {}), 'security_review_stale');
});

test('[S9] an addendum outside the contract or in conflict is a judgment', { skip: WIN_SKIP }, (t) => {
  const fx = addFx(t);
  ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive'));
  fx.appendRunState({ ...ADDENDUM, pairs: [{ ...ADDENDUM.pairs[0], node: 'api' }] }); // spec2/ is not under api's writes
  assert.equal(refused(fx.gate('reassess', {}), 'addendum_outside_contract').out.judgment_point, true);
  assert.ok(codes(fx.cli('status').out).includes('addendum_outside_contract'));
  const fx2 = addFx(t);
  ok(fx2.cli('init', { dag: fx2.dagFile })); ok(fx2.cli('drive'));
  fx2.appendRunState({ ...ADDENDUM, pairs: [{ boundary: fx2.cov[0].boundary, control: fx2.cov[0].control, node: 'extra', specs: [ADD_SPEC] }] });
  refused(fx2.gate('reassess', {}), 'addendum_conflict'); // a pair already effective
  assert.ok(codes(fx2.cli('status').out).includes('addendum_conflict'));
  const fx3 = addFx(t);
  ok(fx3.cli('init', { dag: fx3.dagFile })); ok(fx3.cli('drive'));
  fx3.appendRunState(ADDENDUM);
  ok(fx3.gate('red', { node: 'api', command: 'unit' })); ok(fx3.cli('drive'));
  ok(fx3.gate('reassess', {}), 'a valid addendum: no judgment');
  fx3.appendRunState({ ...ADDENDUM, reason: 'other bytes, same addendum_id' });
  refused(fx3.gate('reassess', {}), 'addendum_conflict');
});

// ------------------------------------------------------------------ C5 authority per event

const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));
/**
 * A proof command that appends `ev` to RUN-STATE once, while its proof attempt is live; '__CAND__'
 * in `ev` becomes the work tree's candidate id (so a waiver names the candidate it would waive).
 */
const appendingProof = (ev) => ({ cmd: process.execPath, args: ['-e', `const fs=require('fs');if(!fs.existsSync('../appended')){fs.writeFileSync('../appended','');`
  + `const c=JSON.parse(require('child_process').execFileSync(process.execPath,[${J(CANDIDATE_CLI)},'--repo','.','--base','HEAD','--exclude','.specs/plans/T-1.md','--exclude','session-log.md'],{encoding:'utf8'})).candidate_id;`
  + `const P='.specs/plans/T-1.md';fs.writeFileSync(P,fs.readFileSync(P,'utf8').replace('<!-- RUN-STATE:END -->',${J(J(ev))}.replace('__CAND__',c)+'\\n<!-- RUN-STATE:END -->'));}`] });
const extraNode = { extraNodes: [{ id: 'extra', writes: ['spec2'] }], behaviour: { extra: { write: { [ADD_SPEC.file]: addSpecText } } } };
const naOver = (id) => ({ over: { [id]: { outcome: 'NOT_APPLICABLE' } } });

for (const kind of ['SECURITY_WAIVER', 'SECURITY_ADDENDUM']) {
  const code = kind === 'SECURITY_WAIVER' ? 'waiver_unauthorized' : 'addendum_required';
  test(`[S10] C5 ${kind} appended while a proof runs is untrusted: ${code} (judgment); a distinct owner re-append is honoured`, { skip: WIN_SKIP }, (t) => {
    const ev = kind === 'SECURITY_WAIVER' ? { run_id: 'run-1', event: kind, boundary: 'orders-api', control: 'VAPT-API-01', candidate: '__CAND__',
      policy_version: 2, authorized_by: 'owner', reason: 'accepted risk' } : ADDENDUM;
    const fx = built(secFx(t, { ...extraNode, testCommands: { unit: UNIT, proof: appendingProof(ev) } }));
    ok(fx.gate('review', secReview(fx, 'rx-1')));
    fx.gate('ship-ready', {}); // the proof appends the event while its attempt is live
    assert.ok(fx.readState().authority.untrusted.some(u => JSON.parse(u.line).event === kind), J(fx.readState().authority));
    const r = refused(fx.gate('ship-ready', {}), code);
    assert.equal(r.out.judgment_point, true);
    const planted = runStateEvents(fx.planFile).find(e => e.event === kind);
    fx.appendRunState({ ...planted, reason: `${planted.reason} (re-appended once nothing was live)` });
    const after = fx.gate('ship-ready', {});
    assert.notEqual(after.out.code, code, after.stdout);
    if (kind === 'SECURITY_WAIVER') ok(after, 'the waiver is now trusted');
    else assert.equal(after.out.code, 'reassess_stale', 'the trusted addendum moved the addendum set');
  });

  test(`[S10] C5 ${kind} first seen in a rewritten RUN-STATE block is untrusted: ${code}`, { skip: WIN_SKIP }, (t) => {
    const fx = built(secFx(t, { ...extraNode, extraEvents: () => [{ event: 'NOTE', note: 'x' }] }));
    const id = fx.ids[0];
    const ev = kind === 'SECURITY_WAIVER' ? waiver(fx, id) : ADDENDUM;
    const text = readFileSync(fx.planFile, 'utf8');
    writeFileSync(fx.planFile, text.replace('"note":"x"', '"note":"y"').replace('<!-- RUN-STATE:END -->', J(ev) + '\n<!-- RUN-STATE:END -->'));
    const r = refused(fx.gate('review', secReview(fx, 'rx-1', kind === 'SECURITY_WAIVER' ? naOver(id) : {})), code);
    assert.equal(r.out.judgment_point, true);
    if (kind === 'SECURITY_WAIVER') {
      fx.appendRunState(waiver(fx, id, { reason: 'accepted risk (re-appended)' }));
      ok(fx.gate('review', secReview(fx, 'rx-1', naOver(id))), 'the distinct owner re-append is trusted');
    }
  });
}

test('[S10] C5 a worker that appends SECURITY_WAIVER or SECURITY_ADDENDUM is an ownership violation and never honoured', { skip: WIN_SKIP }, (t) => {
  for (const kind of ['SECURITY_WAIVER', 'SECURITY_ADDENDUM']) {
    const ev = kind === 'SECURITY_WAIVER' ? { run_id: 'run-1', event: kind, boundary: 'orders-api', control: 'VAPT-API-01', candidate: 'x', policy_version: 2,
      authorized_by: 'owner', reason: 'r' } : ADDENDUM;
    const fx = secFx(t, { ...extraNode, behaviour: { ...extraNode.behaviour, impl: { write: { 'src/impl.txt': 'done' }, appendEvent: ev } } });
    ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' }));
    const d = fx.cli('drive');
    assert.equal(d.status, 2, d.stdout);
    assert.ok(codes(d.out).some(c => /ownership|node_failed/.test(c)), d.stdout);
    assert.ok(runStateEvents(fx.planFile).some(e => e.event === kind));
    assert.ok(!fx.readState().authority.trusted.some(l => JSON.parse(l).event === kind), `${kind} never trusted`);
  }
});

// ------------------------------------------------------------------ C1 meta (executed)

/** A policy-2 decision context built from pure state (what securityContext derives), for the pure refusal rows. */
const PSPEC = { file: 'spec/sec.test.mjs', name: 'p' }, PSPEC2 = { file: 'spec/sec.test.mjs', name: 'q' };
const P1 = { boundary: 'GET /a/:id', control: 'VAPT-API-01', node: 'api', specs: [PSPEC] };
const pureS = ({ trusted = [], untrusted = [], reassessed, chain = [] } = {}) => ({ run_id: 'run-1', plan_digest: 'sha256:p',
  config: { securityPolicy: 2, controlCoverage: [P1] }, nodes: { api: { id: 'api', writes: ['spec'] }, web: { id: 'web', writes: ['web'] } },
  authority: { through: 0, trusted: trusted.map(e => J(e)), untrusted: untrusted.map(e => ({ line: J(e), seq: 1 })) },
  security: reassessed ? { reassessed } : undefined, review_chain: chain });
const pureSec = (S, { catalogOk = true, candidate = 'c1' } = {}) => {
  const events = AUTH.securityEvents(S), w = AUTH.waiverState(S, events, candidate);
  return { catalog: catalogOk ? { ok: true, digest: 'sha256:cat' } : { ok: false, code: 'catalog_missing', reasons: [] }, events, ...w,
    tuple: { candidate_id: candidate, plan_digest: S.plan_digest, catalog_digest: 'sha256:cat', addendum_set: events.addenda.map(a => a.addendum_id).sort() } };
};
const PADD = (over = {}) => ({ run_id: 'run-1', event: 'SECURITY_ADDENDUM', addendum_id: 'add-1', authorized_by: 'owner', reason: 'r',
  pairs: [{ boundary: 'POST /b', control: 'VAPT-API-02', node: 'api', specs: [PSPEC2] }], ...over });
const PWAIVE = { run_id: 'run-1', event: 'SECURITY_WAIVER', boundary: 'GET /a/:id', control: 'VAPT-API-01', candidate: 'c1', policy_version: 2, authorized_by: 'owner', reason: 'r' };
const TUPLE = { candidate_id: 'c1', plan_digest: 'sha256:p', catalog_digest: 'sha256:cat', addendum_set: [] };
const codeOf = (r) => r?.code ?? (r?.ok === true ? 'ok' : null);
const rowsPrimary = (over = {}) => ({ rule_rows: [{ subject_id: 'GET /a/:id:VAPT-API-01', outcome: 'PASS', evidence: 'e' }], security_outcome: 'PASS', ...over });
const PASSREC = (cov) => [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', ...(cov ? { security_coverage: cov } : {}) }];

/** code -> [refusing case, accepting twin]: each a function returning a gate-like verdict (or null when nothing refuses). */
const C1_ROWS = {
  control_unproven: [() => gateShipReady({ state: shipS(), current: shipC(false) }), () => gateShipReady({ state: shipS(), current: shipC(true) })],
  catalog_unavailable: [() => securityRefusal(pureSec(pureS(), { catalogOk: false })), () => securityRefusal(pureSec(pureS()))],
  addendum_conflict: [() => securityRefusal(pureSec(pureS({ trusted: [PADD({ pairs: [{ ...PADD().pairs[0], boundary: 'GET /a/:id', control: 'VAPT-API-01' }] })] }))),
    () => securityRefusal(pureSec(pureS({ trusted: [PADD()] })))],
  addendum_outside_contract: [() => securityRefusal(pureSec(pureS({ trusted: [PADD({ pairs: [{ ...PADD().pairs[0], node: 'web' }] })] }))),
    () => securityRefusal(pureSec(pureS({ trusted: [PADD()] })))],
  addendum_required: [() => securityRefusal(pureSec(pureS({ untrusted: [PADD()] }))), () => securityRefusal(pureSec(pureS({ trusted: [PADD()] })))],
  waiver_unauthorized: [() => securityRefusal(pureSec(pureS({ untrusted: [PWAIVE] }))), () => securityRefusal(pureSec(pureS({ trusted: [PWAIVE] })))],
  reassess_stale: [() => reassessRefusal(pureS({ reassessed: { ...TUPLE, candidate_id: 'c0' } }), pureSec(pureS())),
    () => reassessRefusal(pureS({ reassessed: TUPLE }), pureSec(pureS()))],
  security_review_stale: [() => coverageRefusal(pureS({ chain: PASSREC({ catalog_digest: 'sha256:old', addendum_set: [] }) }), pureSec(pureS())),
    () => coverageRefusal(pureS({ chain: PASSREC({ catalog_digest: 'sha256:cat', addendum_set: [] }) }), pureSec(pureS()))],
  security_row_escape: [() => securityRowsRefusal(rowsPrimary({ rule_rows: [{ subject_id: 'GET /a/:id:VAPT-API-01', outcome: 'NOT_APPLICABLE', evidence: 'e' }] }), pureSec(pureS())),
    () => securityRowsRefusal(rowsPrimary({ rule_rows: [{ subject_id: 'GET /a/:id:VAPT-API-01', outcome: 'NOT_APPLICABLE', evidence: 'e' }] }), pureSec(pureS({ trusted: [PWAIVE] })))],
  security_outcome_escape: [() => securityRowsRefusal(rowsPrimary({ security_outcome: 'NOT_TRIGGERED' }), pureSec(pureS())),
    () => securityRowsRefusal(rowsPrimary({ security_outcome: 'PASS' }), pureSec(pureS()))],
};
const shipS = () => ({ ticket: 'AIS-1', pinned_exclusions: ['.specs/plans/AIS-1.md', 'session-log.md'], review_chain: [{ review_execution: 'rx-1', kind: 'original', outcome: 'PASS', candidate_id: 'c1' }],
  local_proof: { candidate_id: 'c1', commands: [{ cmd: 'node', result: 'pass' }] } });
const shipC = (proven) => ({ candidate_id: 'c1', exclusions: ['.specs/plans/AIS-1.md', 'session-log.md'], artifact_digests: {}, control_pairs: [{ boundary: 'GET /a/:id', control: 'VAPT-API-01', proven }] });
/** Codes reachable only through the engine CLI: [code, async (t) => [refusing result code, accepting twin result code]]. */
const C1_CLI = {
  security_policy_required: (t) => { // one field: the START timestamp
    const late = fixture(t, { startAt: iso(CUT) }), early = fixture(t, { startAt: iso(CUT - 1000) });
    const a = late.cli('init', { dag: late.dagFile }), b = early.cli('init', { dag: early.dagFile });
    return [/run-engine: (\w+):/.exec(a.stderr)?.[1], b.status === 0 ? 'ok' : b.stderr];
  },
  security_pairs_mismatch: (t) => { // one field: the narrative pairs line
    const bad = secFx(t, { surfaces: false, narrative: (sel) => SP.renderSection3a(sel).replace(/security-pairs sha256:[0-9a-f]{64}/, 'security-pairs sha256:' + '0'.repeat(64)) });
    const good = secFx(t, { surfaces: false });
    const a = bad.cli('init', { dag: bad.dagFile }), b = good.cli('init', { dag: good.dagFile });
    return [/run-engine: (\w+):/.exec(a.stderr)?.[1], b.status === 0 ? 'ok' : b.stderr];
  },
  reassess_unclassified: (t) => { // one shared fixture, one field: classifications
    const fx = secFx(t, { implWrites: { 'src/mailer.ts': 'export const go = (m) => transporter.sendMail(m);\n' } });
    ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' })); ok(fx.cli('drive'));
    const cls = { classifications: [{ signal_id: 'mail-or-notification-send@src/mailer.ts', reason: 'test double' }] };
    const a = fx.gate('reassess', {}), b = fx.gate('reassess', cls);
    return [a.out?.code, b.out?.code === 'reassessed' ? 'ok' : b.stdout];
  },
  security_reapproval: (t) => { // the same fixture, one field: a changed path outside the Design Contract
    const fx = secFx(t);
    ok(fx.cli('init', { dag: fx.dagFile })); ok(fx.cli('drive')); ok(fx.gate('red', { node: 'api' })); ok(fx.cli('drive'));
    const b = fx.gate('reassess', {});
    writeFileSync(join(fx.repo, 'docs', 'outside.md'), 'x');
    const a = fx.gate('reassess', {});
    return [a.out?.code, b.out?.code === 'reassessed' ? 'ok' : b.stdout];
  },
};

test('C1 meta: every ENGINE_SECURITY_CODES code executes a refusing case and an accepting twin differing in one field', { skip: WIN_SKIP }, async (t) => {
  assert.deepEqual([...Object.keys(C1_ROWS), ...Object.keys(C1_CLI)].sort(), [...ENGINE_SECURITY_CODES].sort(), 'the table is keyed by exactly the codes');
  for (const [code, [refuse, accept]] of Object.entries(C1_ROWS)) {
    assert.equal(codeOf(refuse()), code, `${code}: the refusing case`);
    const twin = accept();
    assert.ok(twin === null || twin.ok === true || codeOf(twin) !== code, `${code}: the accepting twin is not refused with it (${J(twin)})`);
  }
  for (const [code, run] of Object.entries(C1_CLI)) {
    const [refusedCode, accepted] = await run(t);
    assert.equal(refusedCode, code, `${code}: the refusing case (CLI)`);
    assert.equal(accepted, 'ok', `${code}: the accepting twin (CLI)`);
  }
});
