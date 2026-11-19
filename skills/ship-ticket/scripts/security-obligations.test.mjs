/**
 * F12a security obligations (block format 3): surface-level facts that drop a (boundary, control) pair as not
 * applicable, with fail-closed accountability. Regression scenarios (a)-(j) of the S1 unit; tests tagged [S41]..[S52]
 * are the ones engine-security-mutation.test.mjs expects to FAIL when that guard is patched out.
 *
 * ============================ CONTRACT (F12a) ============================
 * select: a surface may carry `facts` (+ `evidence`): only BOOLEAN facts lowered true -> false, only facts a catalog
 *   `not_applicable` gate for its kind names, never an unknown or false change fact, never on a surface of kind
 *   unknown (surface_fact_not_lowerable), never on every surface (surface_fact_reinflates), each with a
 *   machine-checkable path[:symbol] citation (fact_uncited), each dropping at least one pair and never a pair its own
 *   path's signal class names (surface_fact_ungated / surface_fact_not_lowerable). A pair is dropped only when its own
 *   control's gate names the lowered fact(s) and the evaluator, re-run with them false, deselects it. Dropped pairs go
 *   to `na_pairs` (never `pairs`); effective + dropped = the pairs the same facts select without surface facts.
 * block format 3: `policy: 3`, `na_pairs`, a selection digest over surfaces (facts, citations), pairs and na_pairs;
 *   the pairs line covers the effective pairs only. A block without surface facts is format 2, byte for byte.
 * reassess: a dropped pair reopens (delta pair) when a signal at an approved surface's path names its control
 *   (whatever any classification says) or a used classification raises its fact; a format-3 block is replayed under
 *   the catalog (plan_block_invalid when a lowering does not follow); a signalling non-test path inside the Design
 *   Contract with no surface is surface_inventory_incomplete.
 * obligationMatrix / verifyMatrix: every surface x control cell has exactly one disposition of DISPOSITIONS.
 * engine: a format-3 run records policy_version 3 (4 with test kinds); review needs one row per dropped pair
 *   (NOT_APPLICABLE citing it, or FAIL to dispute; PASS is security_row_escape); a dispute blocks confirmation and
 *   ship-ready (security_na_disputed) until an addendum makes the pair effective; ship-ready prints the matrix;
 *   `run-engine.mjs preflight` runs init's plan checks before approval, writing nothing.
 * C5: a test file raises no surface signal; a workspace `apps/api/` folder is not a route directory.
 * =========================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as SP from './security-plan.mjs';
import * as OB from './security-obligations.test-helper.mjs';
import { POSIX, fixture, passReview, failReview, confirmReview, primaryReview } from './engine-test-fixture.mjs';
import * as DAG from './engine-dag.mjs';
import { preflight } from './run-engine.mjs';
import { securityRowsRefusal, disputedRefusal } from './engine-gates.mjs';
import * as POL from './engine-policy.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown (known limit N7)';
const J = JSON.stringify;
const GC = OB.gated();
const REAL = SP.loadCatalog();
const ok = (r) => { assert.equal(r.ok, true, J({ code: r.code, reasons: r.reasons })); return r; };
const refused = (r, code) => { assert.equal(r.ok, false, `expected ${code}, got ok`); assert.equal(r.code, code, J(r.reasons)); return r; };
const ids = (xs) => xs.map((p) => p.pair_id);
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const KEEP = OB.surf('K', 'request-handler', 'src/k.ts');
const A_PW = OB.surf('A', 'request-handler', 'src/a.ts', ['persistent_write']);

test('catalog: the not_applicable grammar is parsed and validated at load (absent is valid; a malformed, non-bool or false gate is catalog_invalid)', () => {
  ok(GC);
  ok(REAL);
  const bad = (mut) => { const c = JSON.parse(J(OB.GATED)); mut(c); return SP.loadCatalog({ catalogPath: OB.writeCatalog(c) }); };
  refused(bad((c) => { c.controls[1].not_applicable['request-handler'] = 'gated by persistent_write and session_context: x y z'; }), 'catalog_invalid');
  refused(bad((c) => { c.controls[1].not_applicable['request-handler'] = 'gated by principals: request-handler cannot do it at all'; }), 'catalog_invalid');
  refused(bad((c) => { c.controls[1].not_applicable['request-handler'] = 'gated by outbound_message: request-handler cannot do it at all'; }), 'catalog_invalid');
  refused(bad((c) => { c.controls[0].not_applicable['request-handler'] = 'gated by persistent_write: request-handler alone selects it'; }), 'catalog_invalid');
  refused(bad((c) => { c.controls[1].not_applicable = 'nope'; }), 'catalog_invalid');
  ok(bad((c) => { for (const x of c.controls) delete x.not_applicable; }));
});

test('(j) a cited surface fact drops exactly the pairs its own control gates name; the rest stay effective', () => {
  const s = ok(OB.sel3(GC, [A_PW, KEEP]));
  assert.equal(s.block_format, 3);
  assert.deepEqual(ids(s.na_pairs), ['A:VAPT-API-04']);
  assert.deepEqual(s.na_pairs[0].facts, ['persistent_write']);
  assert.equal(s.na_pairs[0].evidence.persistent_write, 'src/a.ts:persistent_writeFree');
  assert.ok(ids(s.pairs).includes('K:VAPT-API-04') && ids(s.pairs).includes('A:VAPT-CFG-04') && ids(s.pairs).includes('A:VAPT-API-01'));
  const legacy = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts'), KEEP]));
  assert.deepEqual([...ids(s.pairs), ...ids(s.na_pairs)].sort(), ids(legacy.pairs), 'effective + dropped = the pairs without surface facts');
  assert.deepEqual(s.config_fragment.controlCoverage.map((c) => `${c.boundary}:${c.control}`), ids(s.pairs), 'controlCoverage = effective pairs only');
  // per (surface, control): lowering session_context never drops API-04 (its gate names persistent_write only)
  const sc = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts', ['session_context']), KEEP]));
  assert.deepEqual(ids(sc.na_pairs), ['A:VAPT-CFG-04']);
  assert.ok(ids(sc.pairs).includes('A:VAPT-API-04'));
});

test('[S43] (e) an unknown (or false) change fact is never lowered; a non-false surface value, a non-bool fact and a surface of kind unknown are refused', () => {
  refused(OB.sel3(GC, [A_PW, KEEP], { ...OB.TRUE3, persistent_write: 'unknown' }), 'surface_fact_not_lowerable');
  refused(OB.sel3(GC, [A_PW, KEEP], { ...OB.TRUE3, persistent_write: false }), 'surface_fact_not_lowerable');
  refused(OB.sel3(GC, [{ ...A_PW, facts: { persistent_write: true } }, KEEP]), 'surface_fact_not_lowerable');
  refused(OB.sel3(GC, [{ ...A_PW, facts: { persistent_write: 'unknown' } }, KEEP]), 'surface_fact_not_lowerable');
  refused(OB.sel3(GC, [OB.surf('U', 'unknown', 'src/u.ts', ['persistent_write']), KEEP]), 'surface_fact_not_lowerable');
  refused(OB.sel3(GC, [{ ...A_PW, facts: { boundaries: false }, evidence: { boundaries: 'src/a.ts:x' } }, KEEP]), 'surface_fact_not_lowerable');
  refused(OB.sel3(GC, [{ ...A_PW, facts: { nope: false }, evidence: { nope: 'src/a.ts:x' } }, KEEP]), 'fact_out_of_vocabulary');
  ok(OB.sel3(GC, [A_PW, KEEP]));
});

test('(a) an applicable control wrongly marked N/A is refused or stays effective: ungated fact, wrong control, drop-nothing, own-path signal', () => {
  // outbound-data has no gate naming persistent_write
  refused(OB.sel3(GC, [OB.surf('O', 'outbound-data', 'src/o.ts', ['persistent_write']), KEEP]), 'surface_fact_ungated');
  // a fact gated for other controls keeps a kind-universal control effective (API-01 on request-handler never drops)
  const s = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts', ['persistent_write', 'session_context', 'outbound_message']), KEEP]));
  assert.ok(ids(s.pairs).includes('A:VAPT-API-01'));
  // "gated by a or b": lowering only one while the other holds drops nothing -> refused (real catalog)
  const bools = Object.keys(REAL.catalog.fact_vocabulary).filter((k) => REAL.catalog.fact_vocabulary[k].type === 'bool');
  const t = Object.fromEntries(bools.map((b) => [b, true]));
  const ev = Object.fromEntries(bools.map((b) => [b, 'src/x.ts:fn']));
  const rh = (facts) => ({ boundary_id: 'r', kind: 'request-handler', path: 'src/r.ts', principals: ['staff'], facts, evidence: Object.fromEntries(Object.keys(facts).map((f) => [f, 'src/r.ts:fn'])) });
  const keeper = { boundary_id: 'k', kind: 'business-invariant', path: 'src/k.ts', principals: ['staff'] };
  refused(SP.selectControls(REAL, { security_policy: 2, surfaces: [rh({ spends_or_reserves_value: false }), keeper], facts: t, evidence: ev }), 'surface_fact_ungated');
  // the surface's own path raises a mail signal whose class names the dropped ABUSE-02: every reassessment would reopen it
  refused(OB.sel3(GC, [OB.surf('M', 'request-handler', 'src/lib/mailer.ts', ['outbound_message']), KEEP]), 'surface_fact_not_lowerable');
  ok(OB.sel3(GC, [OB.surf('M', 'request-handler', 'src/lib/orders.ts', ['outbound_message']), KEEP]));
});

test('(b) a surface fact needs a machine-checkable path[:symbol] citation (fact_uncited)', () => {
  for (const c of ['', 'TBD', 'n/a', 'unknown: not checked', '/abs/a.ts', '../a.ts', 'src/../a.ts', 'src/a.ts:TODO', 'src', 'a b.ts', 'src\\a.ts', 'src/TBD.ts', 'src/a.ts:']) {
    refused(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts', ['persistent_write'], () => c), KEEP]), 'fact_uncited');
  }
  refused(OB.sel3(GC, [{ ...A_PW, evidence: {} }, KEEP]), 'fact_uncited');
  for (const c of ['src/a.ts', 'src/a.ts:saveOrder', 'apps/api/src/routes/x.ts:Router.get', 'migrations/0001_init.sql']) {
    ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts', ['persistent_write'], () => c), KEEP]));
  }
});

test('[S51] (f) a fact lowered on EVERY surface is refused (the change fact is the OR of its surfaces), and a drop never re-inflates through paired_by change', () => {
  refused(OB.sel3(GC, [A_PW, OB.surf('K', 'request-handler', 'src/k.ts', ['persistent_write'])]), 'surface_fact_reinflates');
  refused(OB.sel3(GC, [A_PW]), 'surface_fact_reinflates');
  // rendering-sink keeps persistent_write: API-04 stays paired by surface on R only; no change-level fallback pair appears
  const s = ok(OB.sel3(GC, [A_PW, OB.surf('R', 'rendering-sink', 'src/r.ts')]));
  assert.ok(s.pairs.every((p) => p.paired_by === 'surface'));
  assert.ok(!ids(s.pairs).includes('A:VAPT-API-04') && ids(s.pairs).includes('R:VAPT-API-04'));
});

test('large generic shape over the REAL catalog: many surfaces and kinds, a large share dropped, every drop gated and cited; init-ready coverage', () => {
  const input = OB.largeShape(REAL.catalog);
  const s = ok(SP.selectControls(REAL, input));
  const legacy = ok(SP.selectControls(REAL, { ...input, surfaces: input.surfaces.map(({ facts, evidence, ...x }) => x) }));
  assert.ok(s.na_pairs.length > 0 && s.pairs.length > 0);
  assert.ok(s.na_pairs.length * 4 >= legacy.pairs.length, 'a substantial share of the pairs is dropped');
  assert.deepEqual([...ids(s.pairs), ...ids(s.na_pairs)].sort(), ids(legacy.pairs));
  for (const n of s.na_pairs) {
    const c = REAL.catalog.controls.find((x) => x.id === n.control_id);
    const g = SP.GATED_CLAUSE.exec(c.not_applicable[n.kind]);
    assert.ok(g && n.facts.every((f) => g[1].split(' or ').includes(f)), `${n.pair_id} is dropped only by its own gate`);
    assert.ok(n.facts.every((f) => SP.citationProblem(n.evidence[f]) === null));
  }
  const block = SP.parsePlanSecurityBlock(OB.planOf(s));
  assert.equal(block.policy, 3);
  const m = ok(SP.obligationMatrix(REAL, block));
  assert.equal(m.matrix.length, input.surfaces.length * REAL.catalog.controls.length);
  assert.equal(m.counts['dropped-by-fact'], s.na_pairs.length);
  assert.equal(m.counts.proven, s.pairs.length);
});

test('[S42] (g) block format 3 round-trips; its digest covers every surface (facts, citations, path, principals) and the dropped pairs', () => {
  const s = ok(OB.sel3(GC, [A_PW, KEEP]));
  const plan = OB.planOf(s);
  const b = SP.parsePlanSecurityBlock(plan);
  assert.equal(b.policy, 3);
  assert.deepEqual(b.na_pairs.map((n) => n.pair_id), ['A:VAPT-API-04']);
  assert.deepEqual(b.pairs, ids(s.pairs));
  assert.ok(plan.includes(SP.pairsLine({ catalogDigest: s.catalog_digest, pairs: s.pairs })), 'the pairs line covers the effective pairs only');
  const line = plan.split('\n').find((l) => l.startsWith('<!-- security-plan: '));
  const raw = JSON.parse(line.slice('<!-- security-plan: '.length, -' -->'.length));
  const tamper = (fn) => { const x = JSON.parse(J(raw)); fn(x); return plan.replace(line, `<!-- security-plan: ${SP.canon(x).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`); };
  assert.equal(SP.parsePlanSecurityBlock(tamper((x) => { x.surfaces[0].principals = ['anonymous']; })), null, 'principals');
  assert.equal(SP.parsePlanSecurityBlock(tamper((x) => { x.surfaces[0].path = 'src/other.ts'; })), null, 'path');
  assert.equal(SP.parsePlanSecurityBlock(tamper((x) => { x.surfaces[0].evidence.persistent_write = 'src/z.ts'; x.na_pairs[0].evidence.persistent_write = 'src/z.ts'; })), null, 'citation');
  assert.equal(SP.parsePlanSecurityBlock(tamper((x) => { x.na_pairs = []; })), null, 'dropped pairs');
  assert.equal(SP.parsePlanSecurityBlock(tamper((x) => { x.extra = 1; })), null, 'unknown key');
  assert.equal(SP.parsePlanSecurityBlock(tamper((x) => { x.pairs.push('A:VAPT-API-04'); x.pairs.sort(); })), null, 'a pair both effective and dropped');
});

test('(g) legacy: a selection without surface facts is format 2 exactly as before (no new key, policy-2 digest formula, policy-2 block)', () => {
  const s = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts'), KEEP]));
  assert.equal('na_pairs' in s, false); assert.equal('block_format' in s, false);
  assert.equal(s.selection_digest, sha(SP.canon({ policy: 2, catalog_digest: s.catalog_digest, facts_digest: s.facts_digest, controls: s.controls.map((c) => c.control_id) })));
  const b = SP.parsePlanSecurityBlock(OB.planOf(s));
  assert.deepEqual(Object.keys(b).sort(), ['catalog_digest', 'controls', 'facts', 'pairs', 'policy', 'selection_digest', 'surfaces']);
  assert.equal(b.policy, 2);
  assert.ok(!s.rows_md.includes('Dropped by a cited surface fact'));
  const m = ok(SP.obligationMatrix(GC, b));
  assert.equal(m.counts['dropped-by-fact'], 0);
});

test('[S52] (d) a hand-edited format-3 block whose lowering does not follow (unknown change fact) is plan_block_invalid at reassess and in the matrix', () => {
  const s = ok(OB.sel3(GC, [A_PW, KEEP]));
  const facts = { ...s.facts, persistent_write: 'unknown' };
  const facts_digest = sha(SP.canon(facts));
  const v3 = { surfaces: s.surfaces, pairs: ids(s.pairs), na_pairs: s.na_pairs.map((n) => ({ pair_id: n.pair_id, facts: n.facts, evidence: n.evidence })) };
  const selection_digest = sha(SP.canon({ policy: 3, catalog_digest: s.catalog_digest, facts_digest, controls: s.controls.map((c) => c.control_id), ...v3 }));
  const forged = { ...s, facts, facts_digest, selection_digest };
  const plan = OB.planOf(forged);
  assert.ok(SP.parsePlanSecurityBlock(plan), 'the forged block is well-formed (only the catalog can refuse it)');
  refused(SP.reassess(OB.reIn3(GC, { plan, files: [{ path: 'src/a.ts' }] })), 'plan_block_invalid');
  refused(SP.obligationMatrix(GC, SP.parsePlanSecurityBlock(plan)), 'plan_block_invalid');
});

test('[S44] (d) a signal at an approved surface path that names a dropped control REOPENS it, whatever any classification says', () => {
  const s = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts', ['outbound_message']), KEEP]));
  assert.deepEqual(ids(s.na_pairs), ['A:VAPT-ABUSE-02']);
  const plan = OB.planOf(s);
  const quiet = ok(SP.reassess(OB.reIn3(GC, { plan, files: [{ path: 'src/a.ts', added: ['const total = 1;'] }] })));
  assert.equal(quiet.outcome, 'UNCHANGED'); assert.deepEqual(quiet.reopened_pairs, []);
  const mail = { path: 'src/a.ts', added: ['await sendMail(order.email)'] };
  // this catalog lacks ABUSE-03, so the mail signal is not mechanical: it must be classified first (as today)
  refused(SP.reassess(OB.reIn3(GC, { plan, files: [mail] })), 'classification_missing');
  const cited = ok(SP.reassess(OB.reIn3(GC, { plan, files: [mail], classifications: [{ signal_id: 'mail-or-notification-send@src/a.ts', facts: { outbound_message: true }, evidence: { outbound_message: 'src/a.ts:notify' } }] })));
  assert.equal(cited.outcome, 'ADD_CONTROLS');
  assert.deepEqual(cited.reopened_pairs, ['A:VAPT-ABUSE-02']);
  const dismissed = ok(SP.reassess(OB.reIn3(GC, { plan, files: [mail], classifications: [{ signal_id: 'mail-or-notification-send@src/a.ts', reason: 'a log line, not a send' }] })));
  assert.equal(dismissed.outcome, 'ADD_CONTROLS', 'a reason-only dismissal never suppresses the reopen');
  assert.ok(dismissed.delta_pairs.includes('A:VAPT-ABUSE-02'));
});

test('[S45] (d) a used classification that raises a lowered fact (true or unknown) reopens every pair it dropped', () => {
  const plan = OB.planOf(OB.approved3(GC));
  const dep = { path: 'package.json' };
  const base = { plan, catalog: GC, inventory: { surfaces: [] }, changed: { contract_paths: ['src/**', 'package.json'], files: [dep] }, addenda: [] };
  const plain = ok(SP.reassess({ ...base, classifications: [{ signal_id: 'new-dependency@package.json', reason: 'patch bump' }] }));
  assert.equal(plain.outcome, 'UNCHANGED');
  for (const v of [true, 'unknown']) {
    const raised = ok(SP.reassess({ ...base, classifications: [{ signal_id: 'new-dependency@package.json', facts: { persistent_write: v },
      evidence: { persistent_write: v === true ? 'package.json:dependencies' : 'unknown: the new client may persist' } }] }));
    assert.equal(raised.outcome, 'ADD_CONTROLS', J(v));
    assert.deepEqual(raised.reopened_pairs, ['A:VAPT-API-04']);
  }
});

test('(d) reassess inventory surfaces cannot carry facts: the orchestrator cannot lower a fact after approval', () => {
  refused(SP.reassess(OB.reIn3(GC, { inventory: [OB.surf('N', 'request-handler', 'src/n.ts', ['persistent_write'])] })), 'bad_input');
  assert.throws(() => DAG.gateInput('reassess', { surfaces: [OB.surf('N', 'request-handler', 'src/n.ts', ['persistent_write'])] }), (e) => e.code === 'bad_input');
});

// ------------------------------------------------------------------ C5
const routeSignal = (path, added = []) => SP.reassessSignals({ paths: [{ path, added }] }).some((s) => s.kind === 'new-route');
const ROUTES = ['src/routes/orders.ts', 'apps/api/src/routes/admin-shipments.ts', 'pages/api/orders.ts', 'app/api/orders/route.ts', 'app/test/route.ts',
  'src/routes/+server.ts', 'server/api/orders.ts', 'api/orders.ts', 'src/api/orders.ts', 'apps/api/src/api/orders.ts', 'app/controllers/orders_controller.rb',
  'internal/handlers/orders.go', 'src/webhooks/stripe.ts', 'src/endpoints/x.py', 'packages/api/routes.ts', 'src/routes/fixtures/index.ts', 'src/routes/ab-test.ts',
  'src/routes/test.ts', 'src/routes/latest.ts', 'src/lib/api.ts'];

test('[S47] [S48] C5: real route and handler files (repo fixtures and framework conventions) still raise new-route', () => {
  for (const p of ROUTES) assert.equal(routeSignal(p), true, p);
  // every route path in the vapt selection fixtures still fires
  const scenarios = JSON.parse(readFileSync(new URL('../../vapt/fixtures/scenarios.json', import.meta.url), 'utf8'));
  const paths = [...J(scenarios).matchAll(/"path":"([^"]+)"/g)].map((m) => m[1]).filter((p) => /(^|\/)(routes?|api|controllers?|handlers?|endpoints?|webhooks?)(\/|\.)/.test(p));
  assert.ok(paths.length > 0);
  for (const p of paths) assert.equal(routeSignal(p), true, p);
  // added route lines fire in any non-test file
  assert.equal(routeSignal('apps/api/src/index.ts', ["app.get('/health', h)"]), true);
});

test('[S47] [S48] C5: test, spec and mock files and workspace apps/api/ non-route modules no longer raise new-route (or any surface signal)', () => {
  for (const p of ['apps/api/src/services/shipment.service.ts', 'apps/api/src/index.ts', 'packages/api/src/config.ts', 'services/api/src/db.ts', 'libs/api/src/client.ts']) assert.equal(routeSignal(p), false, p);
  for (const p of ['apps/api/src/routes/admin-shipments.spec.ts', 'src/routes/orders.test.ts', 'src/__tests__/routes/x.ts', 'src/routes/__mocks__/orders.ts',
    'test/e2e/app.e2e-spec.ts', 'internal/handlers/orders_test.go', 'spec/requests/orders_spec.rb', 'tests/test_routes.py']) {
    assert.equal(routeSignal(p, ["app.get('/x', h)"]), false, p);
    assert.deepEqual(SP.reassessSignals({ paths: [{ path: p, added: ['router.post("/x")'] }] }).filter((s) => SP.SURFACE_SIGNALS.includes(s.kind)), [], p);
  }
  assert.equal(SP.isTestPath('src/middleware/auth.spec.ts'), true);
  assert.deepEqual(SP.reassessSignals({ paths: ['src/middleware/auth.spec.ts'] }), []);
  // a test file is still an out-of-plan path when outside the contract (reassess), and non-surface signals still fire
  assert.ok(SP.reassessSignals({ paths: [{ path: 'src/mail.test.ts', added: ['sendMail(x)'] }] }).some((s) => s.kind === 'mail-or-notification-send'));
});

test('[S49] C5 inventory completeness: a signalling non-test path written by the plan with no surface is surface_inventory_incomplete (format 3)', () => {
  assert.deepEqual(SP.inventoryGaps({ files: ['src/routes/new.ts', 'src/routes/new.test.ts', 'src/a.ts', 'README.md'], surfacePaths: ['src/a.ts'] }),
    [{ path: 'src/routes/new.ts', kinds: ['new-route'] }]);
  refused(SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/routes/new.ts' }] })), 'surface_inventory_incomplete');
  refused(SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/lib/x.ts', added: ["router.post('/x', h)"] }] })), 'surface_inventory_incomplete');
  const listed = SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/routes/new.ts' }], inventory: [OB.surf('N', 'request-handler', 'src/routes/new.ts')] }));
  assert.equal(listed.ok, true, J(listed)); assert.equal(listed.outcome, 'ADD_CONTROLS');
  ok(SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/routes/new.spec.ts' }] })));
});

// ------------------------------------------------------------------ accountability
test('[S41] accountability: the matrix has one disposition per surface x control; a dropped pair is never proven, an effective one never dropped', () => {
  const s = ok(OB.sel3(GC, [A_PW, KEEP, OB.surf('R', 'rendering-sink', 'src/r.ts')]));
  const b = SP.parsePlanSecurityBlock(OB.planOf(s));
  const m = ok(SP.obligationMatrix(GC, b));
  const cell = (k) => m.matrix.find((c) => `${c.boundary_id}:${c.control_id}` === k);
  assert.equal(cell('A:VAPT-API-04').disposition, 'dropped-by-fact');
  assert.deepEqual(cell('A:VAPT-API-04').facts, ['persistent_write']);
  assert.equal(cell('K:VAPT-API-04').disposition, 'proven');
  assert.equal(cell('A:VAPT-WEB-01').disposition, 'dropped-by-kind');
  assert.equal(m.matrix.length, 3 * GC.catalog.controls.length);
  const w = ok(SP.obligationMatrix(GC, b, { waived: ['K:VAPT-API-04', 'A:VAPT-API-04'] }));
  assert.equal(w.matrix.find((c) => `${c.boundary_id}:${c.control_id}` === 'K:VAPT-API-04').disposition, 'waived');
  assert.equal(w.matrix.find((c) => `${c.boundary_id}:${c.control_id}` === 'A:VAPT-API-04').disposition, 'dropped-by-fact', 'a waiver of a dropped pair is ignored (waivers only accept effective pairs)');
  const re = ok(SP.obligationMatrix(GC, b, { addenda: ['A:VAPT-API-04'] }));
  assert.equal(re.matrix.find((c) => `${c.boundary_id}:${c.control_id}` === 'A:VAPT-API-04').disposition, 'proven', 'an addendum reopens it as an effective pair');
  // excluded-by-change-fact: a control the change facts never select
  const lo = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts')], { persistent_write: false, session_context: false, outbound_message: false }));
  const lm = ok(SP.obligationMatrix(GC, SP.parsePlanSecurityBlock(OB.planOf(lo))));
  assert.equal(lm.matrix.find((c) => c.control_id === 'VAPT-API-04').disposition, 'excluded-by-change-fact');
  // fail closed: a block whose obligated cell is neither paired nor dropped
  refused(SP.obligationMatrix(GC, { ...b, pairs: b.pairs.filter((p) => p !== 'K:VAPT-API-04') }), 'plan_block_invalid'); // format 3 is replayed first
  const lb = SP.parsePlanSecurityBlock(OB.planOf(ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts'), KEEP]))));
  refused(SP.obligationMatrix(GC, { ...lb, pairs: lb.pairs.filter((p) => p !== 'K:VAPT-API-04') }), 'disposition_missing');
  refused(SP.obligationMatrix(GC, { ...b, na_pairs: [...b.na_pairs, { pair_id: 'A:VAPT-WEB-01', facts: ['persistent_write'], evidence: { persistent_write: 'src/a.ts:x' } }] }), 'plan_block_invalid');
});

test('accountability over the REAL catalog: every legacy selection (format 2) verifies with no cell missing', () => {
  const bools = Object.keys(REAL.catalog.fact_vocabulary).filter((k) => REAL.catalog.fact_vocabulary[k].type === 'bool');
  for (const v of [false, true, 'unknown']) {
    const facts = Object.fromEntries(bools.map((b) => [b, v]));
    const surfaces = REAL.catalog.fact_vocabulary.boundaries.values.map((k, i) => ({ boundary_id: `b${i}`, kind: k, path: `src/b${i}.ts`, principals: ['staff'] }));
    const s = ok(SP.selectControls(REAL, { security_policy: 2, surfaces, facts, evidence: Object.fromEntries(bools.map((b) => [b, v === 'unknown' ? 'unknown: open' : 'src/x.ts'])) }));
    ok(SP.obligationMatrix(REAL, SP.parsePlanSecurityBlock(OB.planOf(s))));
  }
});

test('security-plan.mjs verify CLI prints the matrix (manual flow, no engine module)', () => {
  const dir = dirname(OB.GATED_PATH);
  const plan = join(dir, 'plan.md');
  writeFileSync(plan, OB.planOf(OB.approved3(GC)));
  const r = spawnSync(process.execPath, [new URL('./security-plan.mjs', import.meta.url).pathname, 'verify', '--plan', plan, '--catalog', OB.GATED_PATH], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.code, 'obligations');
  assert.equal(out.counts['dropped-by-fact'], 1);
});

// ------------------------------------------------------------------ engine: rows and the disputed-N/A hard stop (unit)
const NA = [{ pair_id: 'A:VAPT-API-04', facts: ['persistent_write'], evidence: { persistent_write: 'src/a.ts:saveNothing' } }];
const sec = (over = {}) => ({ events: { pairs: [{ boundary: 'K', control: 'VAPT-API-04' }] }, waived: [], na: NA, ...over });
const prim = (naRow, over = {}) => ({ rule_rows: [{ subject_id: 'K:VAPT-API-04', outcome: 'PASS', evidence: 'spec/k.test.mjs' }, ...(naRow ? [naRow] : [])], security_outcome: 'PASS', ...over });

test('[S50] (h) review rows: a dropped pair needs exactly one row; NOT_APPLICABLE must cite its evidence; PASS is security_row_escape; NOT_TRIGGERED never with a dispute', () => {
  assert.equal(securityRowsRefusal(prim(null), sec())?.code, 'incomplete_contract');
  assert.equal(securityRowsRefusal(prim({ subject_id: 'A:VAPT-API-04', outcome: 'PASS', evidence: 'src/a.ts' }), sec())?.code, 'security_row_escape');
  assert.equal(securityRowsRefusal(prim({ subject_id: 'A:VAPT-API-04', outcome: 'NOT_APPLICABLE', evidence: 'agreed' }), sec())?.code, 'incomplete_contract');
  assert.equal(securityRowsRefusal(prim({ subject_id: 'A:VAPT-API-04', outcome: 'NOT_APPLICABLE', evidence: 'src/a.ts:saveNothing writes nothing' }), sec()), null);
  assert.equal(securityRowsRefusal(prim({ subject_id: 'A:VAPT-API-04', outcome: 'FAIL', evidence: 'src/a.ts:42 writes the order' }), sec()), null, 'a dispute is a valid row');
  // all pairs dropped: NOT_TRIGGERED is accepted while nobody disputes, refused once a row disputes
  const allNa = sec({ events: { pairs: [] } });
  assert.equal(securityRowsRefusal({ rule_rows: [{ subject_id: 'A:VAPT-API-04', outcome: 'NOT_APPLICABLE', evidence: 'src/a.ts' }], security_outcome: 'NOT_TRIGGERED' }, allNa), null);
  assert.equal(securityRowsRefusal({ rule_rows: [{ subject_id: 'A:VAPT-API-04', outcome: 'FAIL', evidence: 'src/a.ts' }], security_outcome: 'NOT_TRIGGERED' }, allNa)?.code, 'security_outcome_escape');
});

test('[S46] (h) a disputed dropped pair blocks until it is effective again (an addendum); a waiver alone never clears it', () => {
  const S = { security: { disputed_na: ['A:VAPT-API-04'] } };
  assert.equal(disputedRefusal(S, sec())?.code, 'security_na_disputed');
  assert.equal(disputedRefusal(S, sec({ waived: ['A:VAPT-API-04'] }))?.code, 'security_na_disputed');
  assert.equal(disputedRefusal(S, sec({ events: { pairs: [{ boundary: 'K', control: 'VAPT-API-04' }, { boundary: 'A', control: 'VAPT-API-04' }] } })), null);
  assert.equal(disputedRefusal({}, sec()), null);
});

test('policy version: a format-3 run records 3 (4 with test kinds); every other run keeps 1 or 2', () => {
  assert.equal(POL.recordedVersion({}), 1);
  assert.equal(POL.recordedVersion({ testKinds: true }), 2);
  assert.equal(POL.recordedVersion({ obligations: true }), 3);
  assert.equal(POL.recordedVersion({ testKinds: true, obligations: true }), 4);
  assert.equal(POL.policySemantics(4).testKinds, true);
});

// ------------------------------------------------------------------ engine end to end (real catalog)
/** A format-3 selection over the REAL catalog: request-handler `orders` lowers session_context (bearer auth), keeper `forms` keeps it. */
function realSelection() {
  const bools = Object.keys(REAL.catalog.fact_vocabulary).filter((k) => REAL.catalog.fact_vocabulary[k].type === 'bool');
  const facts = { ...Object.fromEntries(bools.map((b) => [b, false])), session_context: true };
  const surfaces = [{ boundary_id: 'orders', kind: 'request-handler', path: 'src/orders.ts', principals: ['staff'], facts: { session_context: false }, evidence: { session_context: 'src/orders.ts:bearerOnly' } },
    { boundary_id: 'forms', kind: 'server-input', path: 'src/forms.ts', principals: ['staff'] }];
  return ok(SP.selectControls(REAL, { security_policy: 2, surfaces, facts, evidence: Object.fromEntries(bools.map((b) => [b, 'src/orders.ts:handler'])) }));
}
const SPEC = 'spec/sec.test.mjs';
const specText = (list) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `for (const id of ${J(list)}) test(id, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
function obFx(t, { sel = realSelection(), coverage = (c) => c, narrative = (s) => SP.renderSection3a(s), nodes = [], startAt } = {}) {
  const cov = coverage(sel.pairs.map((p) => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC, name: p.pair_id }] })));
  const fx = fixture(t, { commit: true, ...(startAt ? { startAt } : {}), narrativeExtra: narrative(sel) + '\n\n',
    config: { width: 1, testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' } }, securityPolicy: 2, catalogDigest: REAL.digest, controlCoverage: cov },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap((c) => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }, ...nodes],
    behaviour: { api: { write: { [SPEC]: specText(cov.map((c) => `${c.boundary}:${c.control}`)) } }, impl: { write: { 'src/impl.txt': 'done' } }, fix: { write: { 'src/impl.txt': 'fixed' } } } });
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: fx.repo, encoding: 'utf8' });
  g('add', '-A'); assert.equal(g('commit', '-q', '-m', 'base').status, 0);
  return Object.assign(fx, { sel, ids: cov.map((c) => `${c.boundary}:${c.control}`) });
}
const initCode = (r) => (r.status === 0 ? 'ok' : /run-engine: (\w+):/.exec(r.stderr)?.[1] ?? r.stderr);

test('[S53] (j) init binds a format-3 plan with controlCoverage = the effective pairs only and records policy_version 3; the legacy shape of the same change needs every pair', { skip: WIN_SKIP }, (t) => {
  const sel = realSelection();
  assert.ok(sel.na_pairs.length > 0);
  const fx = obFx(t, { sel });
  assert.equal(initCode(fx.cli('init', { dag: fx.dagFile })), 'ok');
  assert.equal(fx.readState().policy_version, 3);
  // the legacy (format 2) selection of the same change: binding only the pairs format 3 keeps effective is refused
  const legacy = ok(SP.selectControls(REAL, { security_policy: 2, surfaces: sel.surfaces.map(({ facts, evidence, ...s }) => s), facts: sel.facts,
    evidence: Object.fromEntries(Object.keys(sel.facts).filter((k) => !['boundaries', 'principals'].includes(k)).map((k) => [k, 'src/orders.ts:handler'])) }));
  const keepIds = new Set(ids(sel.pairs));
  const old = obFx(t, { sel: legacy, coverage: (c) => c.filter((p) => keepIds.has(`${p.boundary}:${p.control}`)) });
  assert.equal(initCode(old.cli('init', { dag: old.dagFile })), 'security_pairs_mismatch');
  // and a format-3 plan whose DAG still lists a dropped pair is refused too (the dropped pair is not in the pairs line)
  const extra = obFx(t, { sel, coverage: (c) => [...c, { boundary: 'orders', control: sel.na_pairs[0].control_id, node: 'api', specs: [{ file: SPEC, name: 'dropped' }] }] });
  assert.equal(initCode(extra.cli('init', { dag: extra.dagFile })), 'security_pairs_mismatch');
});

test('init: an engine whose semantics lack version 3 refuses a format-3 run (policy_version_unsupported); preflight checks the plan with no START and writes nothing', { skip: WIN_SKIP }, async (t) => {
  const fx = obFx(t);
  await assert.rejects(async () => (await import('./run-engine.mjs')).init(fx.ctx({ policy: { current: 1, semantics: { 1: {}, 2: { testKinds: true } } } })), (e) => e.code === 'policy_version_unsupported');
  const pf = await preflight({ repoRoot: fx.repo, ticket: 'T-1', dagFile: fx.dagFile });
  assert.equal(pf.code, 'preflight_ok'); assert.equal(pf.block_format, 3); assert.equal(pf.dropped_pairs, fx.sel.na_pairs.length);
  assert.equal(existsSync(fx.stateFile()), false, 'preflight wrote no state');
  // without a RUN-STATE block or START (a plan still in Plan Mode)
  const draft = join(fx.root, 'draft.md');
  writeFileSync(draft, readFileSync(fx.planFile, 'utf8').split(DAG.BEGIN)[0]);
  const cli = spawnSync(process.execPath, [new URL('./run-engine.mjs', import.meta.url).pathname, 'preflight', '--repo', fx.repo, '--ticket', 'T-1', '--dag', fx.dagFile, '--plan', draft], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).code, 'preflight_ok');
  // a dropped pair still in the DAG: the same refusal init gives
  const bad = obFx(t, { coverage: (c) => [...c, { boundary: 'orders', control: fx.sel.na_pairs[0].control_id, node: 'api', specs: [{ file: SPEC, name: 'dropped' }] }] });
  await assert.rejects(() => preflight({ repoRoot: bad.repo, ticket: 'T-1', dagFile: bad.dagFile }), (e) => e.code === 'security_pairs_mismatch');
  // a DAG that writes an unlisted route file: surface_inventory_incomplete (format 3)
  const gap = obFx(t, { nodes: [{ id: 'web', deps: ['impl'], writes: ['lib/routes/admin.ts'] }] });
  await assert.rejects(() => preflight({ repoRoot: gap.repo, ticket: 'T-1', dagFile: gap.dagFile }), (e) => e.code === 'surface_inventory_incomplete');
});

test('[S46] (h) end to end: a reviewer FAIL on a dropped pair cannot be cleared by repair + confirmation; ship-ready refuses too', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t);
  const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive impl');
  okc(fx.gate('reassess', {}), 'reassess');
  const cand = fx.candidate();
  const naId = fx.sel.na_pairs[0].pair_id;
  const rows = [...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
    ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: n.pair_id === naId ? 'FAIL' : 'NOT_APPLICABLE', evidence: 'src/orders.ts:bearerOnly sets a cookie after all' }))];
  const review = failReview('rx-1', cand, 'src/impl.txt', fx.prompt('fix'));
  review.primary = { ...review.primary, rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...rows], security_outcome: 'FAIL' };
  const r1 = fx.gate('review', review);
  okc(r1, 'original FAIL accepted');
  assert.deepEqual(fx.readState().security.disputed_na, [naId]);
  okc(fx.cli('drive'), 'repair');
  okc(fx.gate('reassess', {}), 'reassess after repair');
  const c = fx.gate('review', confirmReview('rx-1', fx.candidate()));
  assert.equal(c.out?.code, 'security_na_disputed', c.stdout);
  const s = fx.gate('ship-ready', {});
  assert.equal(s.out?.code, 'security_na_disputed', s.stdout);
});

test('ship-ready of a format-3 run reaches the matrix: a passing run prints its obligation matrix', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t);
  const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive impl');
  okc(fx.gate('reassess', {}), 'reassess');
  const cand = fx.candidate();
  const rows = [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
    ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: 'NOT_APPLICABLE', evidence: 'src/orders.ts:bearerOnly reads a bearer token only' }))];
  okc(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: rows }) })), 'review');
  let r = fx.gate('ship-ready', {});
  for (let i = 0; i < 3 && r.out?.code !== 'ship_ready'; i++) r = fx.gate('ship-ready', {});
  assert.equal(r.out?.code, 'ship_ready', r.stdout);
  assert.equal(r.out.obligations.counts['dropped-by-fact'], fx.sel.na_pairs.length);
  assert.equal(r.out.obligations.matrix.length, 2 * REAL.catalog.controls.length);
});

test('config_fragment spreads into a DAG config that validates (no securityControls key)', () => {
  const s = ok(OB.sel3(REAL.ok ? GC : GC, [A_PW, KEEP]));
  const cfg = { provider: 'claude', timeoutMs: 1000, testCommands: { unit: { cmd: 'node', args: [], format: 'tap' } }, ...s.config_fragment,
    controlCoverage: s.config_fragment.controlCoverage.map((c, i) => ({ ...c, node: 'api', specs: [{ file: 'spec/a.test.mjs', name: `t${i}` }] })) };
  const doc = { schema: DAG.DAG_SCHEMA, config: cfg, nodes: [{ id: 'api', promptFile: 'p', writes: ['spec'], redSpecs: cfg.controlCoverage.flatMap((c) => c.specs) }] };
  assert.doesNotThrow(() => DAG.validateEngineDag(doc));
  assert.throws(() => DAG.validateEngineDag({ ...doc, config: { ...cfg, securityControls: [] } }), (e) => e.code === 'dag_invalid');
});
