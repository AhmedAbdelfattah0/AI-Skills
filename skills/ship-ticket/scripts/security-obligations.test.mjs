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
 *   the catalog (plan_block_invalid when a lowering does not follow); a signalling path (test-named or not) inside the Design
 *   Contract with no surface is surface_inventory_incomplete.
 * obligationMatrix / verifyMatrix: every surface x control cell has exactly one disposition of DISPOSITIONS.
 * engine: a format-3 run records policy_version 3 (4 with test kinds); review needs one row per dropped pair
 *   (NOT_APPLICABLE citing it, or FAIL to dispute; PASS is security_row_escape); a dispute blocks confirmation and
 *   ship-ready (security_na_disputed) until an addendum makes the pair effective; ship-ready prints the matrix;
 *   `run-engine.mjs preflight` runs init's plan checks before approval, writing nothing.
 * C5: format 3 detects exactly like format 2 (plus additive route lines): no filename or folder rule removes a signal,
 *   so a test-named file that registers a route or sits on an auth path needs a surface like any other file.
 * =========================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as SP from './security-plan.mjs';
import * as OB from './security-obligations.test-helper.mjs';
import { POSIX, fixture, passReview, failReview, confirmReview, primaryReview, secondOpinion } from './engine-test-fixture.mjs';
import { legacyPlacement } from './engine-test-fixture.mjs';
// S1: this file pins frozen bytes (goldens, policy version numbers, origin/main differentials): its runs use the
// documented legacy escape hatch (config.durableRun: false). The durable default is covered by run-engine-substrate.test.mjs.
legacyPlacement();
import * as DAG from './engine-dag.mjs';
import { preflight } from './run-engine.mjs';
import { securityRowsRefusal, disputedRefusal } from './engine-gates.mjs';
import * as G from './engine-gates.mjs';
import * as POL from './engine-policy.mjs';
import * as AUTH from './engine-authority.mjs';

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
  const rh = (facts) => ({ boundary_id: 'r', kind: 'request-handler', path: 'src/r.ts', principals: ['staff'], facts, evidence: Object.fromEntries(Object.keys(facts).map((f) => [f, 'src/r.ts:handler'])) });
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
  // derived-OR alone (every control keeps an effective pair, so the B2 zero-pair rule does not fire): real catalog,
  // persistent_write lowered on both surfaces; VAPT-API-04 stays effective on security-config (kind-universal there).
  const V = REAL.catalog.fact_vocabulary, bools = Object.keys(V).filter((k) => V[k].type === 'bool');
  const low = (id, kind, fs) => ({ boundary_id: id, kind, path: `src/${id}.ts`, principals: ['staff'], facts: Object.fromEntries(fs.map((f) => [f, false])), evidence: Object.fromEntries(fs.map((f) => [f, `src/${id}.ts:${f}`])) });
  const r = SP.selectControls(REAL, { security_policy: 2, surfaces: [low('r', 'request-handler', ['persistent_write']), low('c', 'security-config', ['persistent_write', 'sensitive_field_write'])],
    facts: { ...Object.fromEntries(bools.map((b) => [b, false])), persistent_write: true, sensitive_field_write: true }, evidence: Object.fromEntries(bools.map((b) => [b, 'src/x.ts:fn'])) });
  refused(r, 'surface_fact_reinflates');
  assert.ok(r.reasons.some((x) => x.startsWith('every surface lowers persistent_write')), 'refused by the derived-OR rule itself');
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
// C5 applies to block format 3 only (c5: true); a format-2 run keeps origin/main's detector ([S59] pins it).
const routeSignal = (path, added = []) => SP.reassessSignals({ paths: [{ path, added }], c5: true }).some((s) => s.kind === 'new-route');
const ROUTES = ['src/routes/orders.ts', 'apps/api/src/routes/admin-shipments.ts', 'pages/api/orders.ts', 'app/api/orders/route.ts', 'app/test/route.ts',
  'src/routes/+server.ts', 'server/api/orders.ts', 'api/orders.ts', 'src/api/orders.ts', 'apps/api/src/api/orders.ts', 'app/controllers/orders_controller.rb',
  'internal/handlers/orders.go', 'src/webhooks/stripe.ts', 'src/endpoints/x.py', 'packages/api/routes.ts', 'src/routes/fixtures/index.ts', 'src/routes/ab-test.ts',
  'src/routes/test.ts', 'src/routes/latest.ts', 'src/lib/api.ts',
  // serve-everything router roots: a test-named file there may be a deployed route
  'pages/api/orders.test.ts', 'pages/api/__tests__/x.ts', 'server/api/orders.spec.ts', 'api/orders.test.ts',
  // R1 (owner B1b): a test-named file under any router root still fires
  'apps/api/src/routes/admin-shipments.spec.ts', 'src/routes/orders.test.ts', 'src/routes/__mocks__/orders.ts', 'internal/handlers/orders_test.go', 'app/routes/admin.test.tsx'];

test('[S47] [S48] C5: real route and handler files (repo fixtures and framework conventions) still raise new-route', () => {
  for (const p of ROUTES) assert.equal(routeSignal(p), true, p);
  // every route path in the vapt selection fixtures still fires
  const scenarios = JSON.parse(readFileSync(new URL('../../vapt/fixtures/scenarios.json', import.meta.url), 'utf8'));
  const paths = [...J(scenarios).matchAll(/"path":"([^"]+)"/g)].map((m) => m[1]).filter((p) => /(^|\/)(routes?|api|controllers?|handlers?|endpoints?|webhooks?)(\/|\.)/.test(p));
  assert.ok(paths.length > 0);
  for (const p of paths) assert.equal(routeSignal(p), true, p);
  // added route lines fire in any file
  assert.equal(routeSignal('apps/api/src/index.ts', ["app.get('/health', h)"]), true);
});

test('[S47] [S48] C5 (format 3): test-named files signal exactly as format 2 (no exemption); workspace apps/api/ modules are never narrowed', () => {
  for (const p of ['apps/api/src/services/shipment.service.ts', 'apps/api/src/index.ts', 'packages/api/src/config.ts', 'services/api/src/db.ts', 'libs/api/src/client.ts']) {
    assert.deepEqual(SP.reassessSignals({ paths: [p], c5: true }).map((s) => s.kind), ['new-route'], `${p}: format 3 keeps format 2's signal`);
    assert.deepEqual(SP.inventoryGaps({ files: [p] }), [{ path: p, kinds: ['new-route'] }], `${p}: a plan-time inventory gap too`);
  }
  // a production file named ab-test with a route line signals
  assert.equal(routeSignal('src/lib/ab-test.ts', ["app.get('/x', h)"]), true);
  // S1 review repair (Option 2): a test-named file with a route line raises new-route like any file (it was exempted by name before)
  for (const p of ['src/__tests__/lib/x.ts', 'test/e2e/app.e2e-spec.ts', 'spec/requests/orders_spec.rb', 'tests/test_routes.py', 'src/lib/util.test.ts']) {
    const f = [{ path: p, added: ['router.post("/x")'] }];
    assert.deepEqual(SP.reassessSignals({ paths: f, c5: true }).filter((s) => SP.SURFACE_SIGNALS.includes(s.kind)).map((s) => s.kind), ['new-route'], p);
    assert.deepEqual(SP.reassessSignals({ paths: f, c5: true }).map((s) => s.id), SP.reassessSignals({ paths: f }).map((s) => s.id), `${p}: = format 2`);
  }
  assert.deepEqual(SP.reassessSignals({ paths: ['src/lib/auth.spec.ts'], c5: true }).map((x) => x.kind), ['auth-or-middleware-change'], 'an auth path signals, test-named or not');
  assert.deepEqual(SP.reassessSignals({ paths: ['src/middleware/auth.spec.ts'], c5: true }).map((x) => x.kind), ['auth-or-middleware-change']);
  assert.equal(SP.reassessSignals({ paths: ['src/middleware/auth.spec.ts'] }).length > 0, true, 'format 2 (legacy): unchanged, it still signals');
  // non-surface signals still fire in a test file
  assert.ok(SP.reassessSignals({ paths: [{ path: 'src/mail.test.ts', added: ['sendMail(x)'] }] }).some((s) => s.kind === 'mail-or-notification-send'));
});

test('[S49] C5 inventory completeness: a signalling path written by the plan (test-named or not) with no surface is surface_inventory_incomplete (format 3)', () => {
  assert.deepEqual(SP.inventoryGaps({ files: ['src/routes/new.ts', 'src/lib/new.test.ts', 'src/a.ts', 'README.md'], surfacePaths: ['src/a.ts'] }),
    [{ path: 'src/routes/new.ts', kinds: ['new-route'] }]);
  assert.deepEqual(SP.inventoryGaps({ files: ['src/routes/new.test.ts'], surfacePaths: [] }), [{ path: 'src/routes/new.test.ts', kinds: ['new-route'] }], 'a test name is no exemption');
  refused(SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/routes/new.ts' }] })), 'surface_inventory_incomplete');
  refused(SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/lib/x.ts', added: ["router.post('/x', h)"] }] })), 'surface_inventory_incomplete');
  const listed = SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/routes/new.ts' }], inventory: [OB.surf('N', 'request-handler', 'src/routes/new.ts')] }));
  assert.equal(listed.ok, true, J(listed)); assert.equal(listed.outcome, 'ADD_CONTROLS');
  // S1 review repair (Option 2): a spec that registers a route is a gap too (it passed by name before)
  refused(SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/lib/new.spec.ts', added: ["app.get('/x', h)"] }] })), 'surface_inventory_incomplete');
  ok(SP.reassess(OB.reIn3(GC, { files: [{ path: 'src/lib/new.spec.ts', added: ["it('x', () => expect(1).toBe(1))"] }] })));
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

test('security-plan.mjs obligations CLI prints the matrix (manual flow, no engine module)', () => {
  const dir = dirname(OB.GATED_PATH);
  const plan = join(dir, 'plan.md');
  writeFileSync(plan, OB.planOf(OB.approved3(GC)));
  const repo = gitRepo(); // X1: the lowering surface src/a.ts must be a repository file too
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./security-plan.mjs', import.meta.url)), 'obligations', '--plan', plan, '--catalog', OB.GATED_PATH, '--repo', repo], { encoding: 'utf8' });
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
  assert.equal(securityRowsRefusal(prim({ subject_id: 'A:VAPT-API-04', outcome: 'NOT_APPLICABLE', evidence: 'lib/src/a.tsx agrees' }), sec())?.code, 'incomplete_contract', 'the cited path must appear as a whole token');
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

test('(c) a SECURITY_WAIVER of a dropped pair waives nothing and is never "unauthorized" noise; waivers of effective pairs behave as before', () => {
  const pair = { boundary: 'K', control: 'VAPT-API-04', node: 'api', specs: [{ file: 'spec/k.test.mjs', name: 'k' }] };
  const w = (boundary, control) => J({ run_id: 'run-1', event: 'SECURITY_WAIVER', boundary, control, candidate: 'c1', policy_version: 2, authorized_by: 'owner', reason: 'r' });
  const S = (trusted, untrusted = []) => ({ run_id: 'run-1', config: { securityPolicy: 2, controlCoverage: [pair] }, nodes: { api: { id: 'api', writes: ['spec'] } },
    authority: { through: 0, trusted, untrusted: untrusted.map((line) => ({ line, seq: 1 })) } });
  const st = (x) => AUTH.waiverState(x, AUTH.securityEvents(x), 'c1');
  assert.deepEqual(st(S([w('A', 'VAPT-API-04')])), { waived: [], unauthorized: [] }, 'a trusted waiver of a dropped pair waives nothing');
  assert.deepEqual(st(S([], [w('A', 'VAPT-API-04')])), { waived: [], unauthorized: [] });
  assert.deepEqual(st(S([], [w('K', 'VAPT-API-04')])), { waived: [], unauthorized: ['K:VAPT-API-04'] }, 'a late waiver of an effective pair is still unauthorized');
  assert.deepEqual(st(S([w('K', 'VAPT-API-04')])), { waived: ['K:VAPT-API-04'], unauthorized: [] });
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
function realSelection(cite = 'src/orders.ts:bearerOnly') {
  const bools = Object.keys(REAL.catalog.fact_vocabulary).filter((k) => REAL.catalog.fact_vocabulary[k].type === 'bool');
  const facts = { ...Object.fromEntries(bools.map((b) => [b, false])), session_context: true };
  const surfaces = [{ boundary_id: 'orders', kind: 'request-handler', path: 'src/orders.ts', principals: ['staff'], facts: { session_context: false }, evidence: { session_context: cite } },
    { boundary_id: 'forms', kind: 'server-input', path: 'src/forms.ts', principals: ['staff'] }];
  return ok(SP.selectControls(REAL, { security_policy: 2, surfaces, facts, evidence: Object.fromEntries(bools.map((b) => [b, 'src/orders.ts:handler'])) }));
}
const SPEC = 'spec/sec.test.mjs';
const specText = (list) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n`
  + `for (const id of ${J(list)}) test(id, () => { assert.ok(fs.existsSync('src/impl.txt'), 'not implemented'); });\n`;
function obFx(t, { sel = realSelection(), coverage = (c) => c, narrative = (s) => SP.renderSection3a(s), nodes = [], startAt, implFiles = { 'src/orders.ts': 'export const bearerOnly = true;\n' }, fixFiles, fixRemove } = {}) {
  const cov = coverage(sel.pairs.map((p) => ({ boundary: p.boundary_id, control: p.control_id, node: 'api', specs: [{ file: SPEC, name: p.pair_id }] })));
  const fx = fixture(t, { commit: true, ...(startAt ? { startAt } : {}), narrativeExtra: narrative(sel) + '\n\n',
    config: { width: 1, testCommands: { unit: { cmd: process.execPath, args: ['--test', '--test-reporter=tap', SPEC], format: 'tap' } }, securityPolicy: 2, catalogDigest: REAL.digest, controlCoverage: cov },
    nodes: [{ id: 'api', writes: ['spec'], redSpecs: cov.flatMap((c) => c.specs) }, { id: 'impl', deps: ['api'], writes: ['src'] }, ...nodes],
    behaviour: { api: { write: { [SPEC]: specText(cov.map((c) => `${c.boundary}:${c.control}`)) } }, impl: { write: { 'src/impl.txt': 'done', ...implFiles } }, fix: { write: fixFiles ?? { 'src/impl.txt': 'fixed' }, ...(fixRemove ? { remove: fixRemove } : {}) } } });
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
  // (d) a surface fact or citation changed after approval: the narrative no longer matches the START (never silently accepted)
  const text = readFileSync(fx.planFile, 'utf8');
  writeFileSync(fx.planFile, text.replaceAll('src/orders.ts:bearerOnly', 'src/orders.ts:bearerOnlyV2'));
  const moved = fx.gate('reassess', {});
  assert.equal(moved.out?.code, 'approval_mismatch', moved.stdout);
  writeFileSync(fx.planFile, text);
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
  assert.equal('c5_exempted' in pf, false, 'no exemption record exists');
  // S1 review repair (Option 2): a test-named DAG write on an auth path is an inventory gap like any other file
  const ax = obFx(t, { nodes: [{ id: 'web', deps: ['impl'], writes: ['lib/auth.spec.ts'] }] });
  await assert.rejects(() => preflight({ repoRoot: ax.repo, ticket: 'T-1', dagFile: ax.dagFile }), (e) => e.code === 'surface_inventory_incomplete' && e.message.includes('lib/auth.spec.ts'));
  assert.equal(existsSync(fx.stateFile()), false, 'preflight wrote no state');
  // without a RUN-STATE block or START (a plan still in Plan Mode)
  const draft = join(fx.root, 'draft.md');
  writeFileSync(draft, readFileSync(fx.planFile, 'utf8').split(DAG.BEGIN)[0]);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./run-engine.mjs', import.meta.url)), 'preflight', '--repo', fx.repo, '--ticket', 'T-1', '--dag', fx.dagFile, '--plan', draft], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).code, 'preflight_ok');
  // a dropped pair still in the DAG: the same refusal init gives
  const bad = obFx(t, { coverage: (c) => [...c, { boundary: 'orders', control: fx.sel.na_pairs[0].control_id, node: 'api', specs: [{ file: SPEC, name: 'dropped' }] }] });
  await assert.rejects(() => preflight({ repoRoot: bad.repo, ticket: 'T-1', dagFile: bad.dagFile }), (e) => e.code === 'security_pairs_mismatch');
  // a DAG that writes an unlisted route file: surface_inventory_incomplete (format 3)
  const gap = obFx(t, { nodes: [{ id: 'web', deps: ['impl'], writes: ['lib/routes/admin.ts'] }] });
  await assert.rejects(() => preflight({ repoRoot: gap.repo, ticket: 'T-1', dagFile: gap.dagFile }), (e) => e.code === 'surface_inventory_incomplete');
});

test('[STAB-410 F-9] preflight on a complete format-3 plan: a read a dependent writes is refused (dag_read_write_dependency); independent and read-after-predecessor DAGs pass; init keeps binding the legacy shape', { skip: WIN_SKIP }, async (t) => {
  const pf = (fx) => preflight({ repoRoot: fx.repo, ticket: 'T-1', dagFile: fx.dagFile });
  // TICKET-C: the tests node reads the source file its dependent fix node rewrites
  const bad = obFx(t, { nodes: [{ id: 'tests', deps: ['impl'], reads: ['src/orders.ts'] }, { id: 'patch', deps: ['tests'], writes: ['src/orders.ts'] }] });
  await assert.rejects(() => pf(bad), (e) => e.code === 'dag_read_write_dependency' && e.message.includes('tests') && e.message.includes('patch') && e.message.includes('src/orders.ts'));
  const dir = obFx(t, { nodes: [{ id: 'tests', deps: ['impl'], reads: ['src'] }, { id: 'patch', deps: ['tests'], writes: ['src/orders.ts'] }] });
  await assert.rejects(() => pf(dir), (e) => e.code === 'dag_read_write_dependency', 'a directory read and a write inside it');
  const glob = obFx(t, { nodes: [{ id: 'tests', deps: ['impl'], reads: ['src/**/*.ts'] }, { id: 'patch', deps: ['tests'], writes: ['src/orders.ts'] }] });
  await assert.rejects(() => pf(glob), (e) => e.code === 'dag_read_write_dependency', 'a glob by its literal prefix');
  assert.equal((await pf(obFx(t, { nodes: [{ id: 'tests', deps: ['impl'], reads: ['src/orders.ts'] }] }))).code, 'preflight_ok', 'read after write by a predecessor');
  assert.equal((await pf(obFx(t, { nodes: [{ id: 'tests', reads: ['src/orders.ts'] }] }))).code, 'preflight_ok', 'an independent reader');
  assert.equal(initCode(bad.cli('init', { dag: bad.dagFile })), 'ok', 'init never runs the plan-time check (in-flight and legacy runs untouched)');
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

test('ship-ready of a format-3 run prints its obligation matrix; no exemption record exists anywhere (reassess output, recorded reassessment, ship-ready)', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t, { implFiles: { 'src/orders.ts': 'export const bearerOnly = true;\n', 'src/lib/util.test.ts': "describe('util', () => { it('adds', () => { expect(1).toBe(1); }); });\n" } });
  const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'drive api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'drive impl');
  const re = fx.gate('reassess', {});
  okc(re, 'reassess');
  assert.equal('c5_exempted' in re.out, false, 'reassess output');
  assert.equal('c5_exempted' in fx.readState().security.reassessed, false, 'recorded reassessment');
  const cand = fx.candidate();
  const rows = [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
    ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: 'NOT_APPLICABLE', evidence: 'src/orders.ts:bearerOnly reads a bearer token only' }))];
  okc(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: rows }) })), 'review');
  let r = fx.gate('ship-ready', {});
  for (let i = 0; i < 3 && r.out?.code !== 'ship_ready'; i++) r = fx.gate('ship-ready', {});
  assert.equal(r.out?.code, 'ship_ready', r.stdout);
  assert.equal(r.out.obligations.counts['dropped-by-fact'], fx.sel.na_pairs.length);
  assert.equal(r.out.obligations.matrix.length, 2 * REAL.catalog.controls.length);
  assert.equal('c5_exempted' in r.out.obligations, false, 'ship-ready obligations print');
});

test('config_fragment spreads into a DAG config that validates (no securityControls key)', () => {
  const s = ok(OB.sel3(GC, [A_PW, KEEP]));
  const cfg = { provider: 'claude', timeoutMs: 600000, testCommands: { unit: { cmd: 'node', args: [], format: 'tap' } }, ...s.config_fragment,
    controlCoverage: s.config_fragment.controlCoverage.map((c, i) => ({ ...c, node: 'api', specs: [{ file: 'spec/a.test.mjs', name: `t${i}` }] })) };
  const doc = { schema: DAG.DAG_SCHEMA, config: cfg, nodes: [{ id: 'api', promptFile: 'p', writes: ['spec'], redSpecs: cfg.controlCoverage.flatMap((c) => c.specs) }] };
  assert.doesNotThrow(() => DAG.validateEngineDag(doc));
  assert.throws(() => DAG.validateEngineDag({ ...doc, config: { ...cfg, securityControls: [] } }), (e) => e.code === 'dag_invalid');
});

// ====================================================================================================================
// Repair R1 (review of 5dbeffd: Opus B1-B3, Fable F1-F5). Written before the fixes; each was red on 5dbeffd.
// ====================================================================================================================
const LEGACY = JSON.parse(readFileSync(new URL('./security-plan-legacy.golden.json', import.meta.url), 'utf8'));

test('[S59] B1(a) legacy (format 2) select AND reassess are byte-identical to the committed origin/main golden (C5 never touches a format-2 run)', async () => {
  const { captureLegacy } = await import('./security-plan-legacy.capture.test-helper.mjs');
  const got = await captureLegacy(fileURLToPath(new URL('./security-plan.mjs', import.meta.url)));
  assert.equal(LEGACY.select.length, got.select.length);
  assert.deepEqual(got.select, LEGACY.select);
  assert.deepEqual(got.reassess, LEGACY.reassess);
  assert.ok(LEGACY.reassess.filter((r) => !r.path.split('/').some((x) => x === '.' || x === '..')).every((r) => r.code === 'classification_missing'), 'every probe file still opens a signal on a legacy run');
});

const r3 = (files) => SP.reassess(OB.reIn3(GC, { files, contract: ['**'] }));
test('[S60] B1(b) format 3: a migration-like path always raises migration-or-rls-change, test-named or not', () => {
  for (const path of ['db/migrations/0001_rls.test.sql', 'supabase/migrations/20261119120000_orders_rls.spec.sql', 'db/migrate/20261119_add_rls_spec.rb', 'drizzle/0003_rls.test.sql']) {
    const r = refused(r3([{ path, added: ['create policy p on t using (true);'] }]), 'surface_inventory_incomplete');
    assert.ok(r.reasons.some((x) => x.includes(path) && x.includes('migration-or-rls-change')), path);
  }
});

test('[S61] B1(b) format 3: a test-named file under a router root still raises new-route', () => {
  for (const [path, added] of [['apps/web/app/routes/admin.test.tsx', ['export async function action() {}']], ['app/routes/api.users.spec.ts', []], ['src/routes/__mocks__/handler.ts', []],
    ['src/routes/__tests__/+server.ts', ['export async function GET() {}']], ['src/routes/export.spec.ts', []], ['pages/api/x.test.ts', []], ['apps/web/api/orders.test.ts', []],
    ['apps/api/src/routes/orders.spec.ts', []], ['server/api/orders.spec.ts', []]]) {
    const r = refused(r3([{ path, added }]), 'surface_inventory_incomplete');
    assert.ok(r.reasons.some((x) => x.includes(path) && x.includes('new-route')), path);
  }
});

test('[S65] B1(c)(d) format 3: a test-named route registration is an inventory gap (no exemption, no record); fastify and tRPC routes in a workspace api/ still signal', () => {
  const r = refused(SP.reassess(OB.reIn3(GC, { contract: ['**'], files: [{ path: 'src/lib/util.test.ts', added: ["app.get('/x', h)"] }] })), 'surface_inventory_incomplete');
  assert.ok(r.reasons.some((x) => x.includes('src/lib/util.test.ts') && x.includes('new-route')), J(r.reasons));
  for (const [path, line] of [['apps/api/src/plugins/users.ts', "fastify.get('/users', async () => db.all())"], ['apps/api/src/trpc/router.ts', 'deleteUser: protectedProcedure.mutation(() => 1),']]) {
    refused(r3([{ path, added: [line] }]), 'surface_inventory_incomplete');
  }
  // the inventory helper uses the same detector
  assert.deepEqual(SP.inventoryGaps({ files: [{ path: 'src/lib/util.test.ts', added: ["app.get('/x', h)"] }, 'src/routes/a.ts'], surfacePaths: [] }),
    [{ path: 'src/lib/util.test.ts', kinds: ['new-route'] }, { path: 'src/routes/a.ts', kinds: ['new-route'] }]);
});

test('[S62] B2 a selected control can never end with zero effective pairs because of a surface fact (a keeper whose kind cannot pair it is no keeper)', () => {
  refused(OB.sel3(GC, [A_PW, OB.surf('K', 'outbound-data', 'src/k.ts')]), 'surface_fact_reinflates');
  refused(OB.sel3(GC, [A_PW, OB.surf('B', 'request-handler', 'src/b.ts', ['persistent_write']), OB.surf('R', 'outbound-data', 'src/r.ts')]), 'surface_fact_reinflates');
  ok(OB.sel3(GC, [A_PW, KEEP]));
  ok(OB.sel3(GC, [A_PW, OB.surf('R', 'rendering-sink', 'src/r.ts')]));
});

test('[S63] B3 a cited path must exist (and contain its :symbol) in the tree checked; a file the plan will write is pending at plan time; an unreadable root fails closed', () => {
  const root = gitRepo(); // X1: the lowering surface src/a.ts must be a repository file too
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC)));
  ok(SP.verifyCitations(block, { root }));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const other = 1;\n');
  refused(SP.verifyCitations(block, { root }), 'citation_missing');
  refused(SP.verifyCitations(block, { root: join(root, 'nope') }), 'citation_missing');
  const empty = dirname(OB.writeCatalog({}));
  refused(SP.verifyCitations(block, { root: empty }), 'citation_missing');
  ok(SP.verifyCitations(block, { root: empty, pending: ['src'] }));
  for (const c of ['app/api/orders/[id]/route.ts:GET', 'app/routes/orders.$id.tsx:loader', 'src/routes/(app)/orders/+page.server.ts:load']) assert.equal(SP.citationProblem(c), null, c);
});

test('B3 the obligations CLI checks citations against --repo (required): missing file refused, present file accepted', () => {
  const dir = dirname(OB.GATED_PATH);
  const plan = join(dir, 'plan-r1.md');
  writeFileSync(plan, OB.planOf(OB.approved3(GC)));
  const run = (repo) => spawnSync(process.execPath, [fileURLToPath(new URL('./security-plan.mjs', import.meta.url)), 'obligations', '--plan', plan, '--catalog', OB.GATED_PATH, ...(repo ? ['--repo', repo] : [])], { encoding: 'utf8' });
  assert.equal(run(null).status, 1, 'no --repo is a usage error');
  const repo = gitRepo(); // X1: the lowering surface src/a.ts must be a repository file too
  assert.equal(JSON.parse(run(repo).stdout).code, 'citation_missing');
  writeFileSync(join(repo, 'src', 'a.ts'), 'persistent_writeFree');
  assert.equal(JSON.parse(run(repo).stdout).code, 'obligations');
});

test('[S64] F3 a second-opinion finding naming a dropped pair records a dispute like a primary FAIL row', () => {
  const input = { primary: prim({ subject_id: 'A:VAPT-API-04', outcome: 'NOT_APPLICABLE', evidence: 'src/a.ts:saveNothing' }), second_opinion: { findings: [{ id: 'S1', subject_id: 'A:VAPT-API-04', severity: 'major' }] } };
  assert.deepEqual(G.naDisputes(input, sec()), ['A:VAPT-API-04']);
  assert.deepEqual(G.naDisputes({ ...input, second_opinion: { findings: [{ id: 'S1', severity: 'minor' }] } }, sec()), []);
});

test('F5 a malformed na_pairs entry is a null parse (typed refusal), never a TypeError', () => {
  const plan = OB.planOf(OB.approved3(GC));
  const line = plan.split('\n').find((l) => l.startsWith('<!-- security-plan: '));
  const raw = JSON.parse(line.slice('<!-- security-plan: '.length, -' -->'.length));
  for (const bad of [[null], [1], ['A:VAPT-API-04']]) {
    const x = { ...raw, na_pairs: bad };
    assert.equal(SP.parsePlanSecurityBlock(plan.replace(line, `<!-- security-plan: ${SP.canon(x)} -->`)), null, J(bad));
  }
});

test('[S54] formatMismatch: a format-3 block under a run without obligations semantics (or the reverse) is refused at every security gate', () => {
  const base = { catalog: { ok: true }, events: { conflicts: [], outside: [], forged: { addenda: [] }, addenda: [] }, unauthorized: [] };
  assert.equal(G.securityRefusal({ ...base, formatMismatch: true })?.code, 'security_pairs_mismatch');
  assert.equal(G.securityRefusal({ ...base, formatMismatch: false }), null);
});

test('[S55] ship-ready refuses a format-3 run whose obligation matrix does not verify', () => {
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC)));
  const s = { sp: SP, catalog: GC, block, events: { addenda: [] }, waived: [] };
  assert.equal(G.shipObligations(s).refusal, null);
  assert.equal(G.shipObligations({ ...s, block: { ...block, catalog_digest: 'sha256:' + '0'.repeat(64) } }).refusal?.code, 'catalog_invalid');
  assert.equal(G.shipObligations({ ...s, block: { ...block, policy: 2 } }).obligations, null, 'format 2: no matrix at ship-ready');
});

test('[S56] the dispute list is add-only: a later review (a RETRY) never removes an earlier dispute', () => {
  const S = { security: { disputed_na: ['A:VAPT-API-04'] }, seq: 0, events: [] };
  G.recordDisputes(S, ['B:VAPT-CFG-04'], 'rx-2');
  assert.deepEqual(S.security.disputed_na, ['A:VAPT-API-04', 'B:VAPT-CFG-04']);
  G.recordDisputes(S, [], 'rx-3');
  assert.deepEqual(S.security.disputed_na, ['A:VAPT-API-04', 'B:VAPT-CFG-04']);
});

test('[S57] a dropped pair an addendum made effective leaves the pending dropped set (it needs a proof, not a NOT_APPLICABLE row)', () => {
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC)));
  assert.deepEqual(G.pendingNa(block, { pairs: [] }).map((n) => n.pair_id), ['A:VAPT-API-04']);
  assert.deepEqual(G.pendingNa(block, { pairs: [{ boundary: 'A', control: 'VAPT-API-04' }] }), []);
  assert.deepEqual(G.pendingNa({ ...block, policy: 2 }, { pairs: [] }), []);
});

test('[S58] the obligation matrix refuses a block selected against another catalog', () => {
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC)));
  refused(SP.obligationMatrix(GC, { ...block, catalog_digest: 'sha256:' + '1'.repeat(64) }), 'catalog_invalid');
});

test('B3 end to end: the review gate refuses a dropped pair whose citation symbol is missing from the candidate (citation_missing)', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t, { implFiles: { 'src/orders.ts': 'export const cookieSession = true;\n' } });
  const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init (the cited file is a pending write)'); okc(fx.cli('drive'), 'api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'impl');
  okc(fx.gate('reassess', {}), 'reassess');
  const cand = fx.candidate();
  const rows = [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
    ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: 'NOT_APPLICABLE', evidence: 'src/orders.ts:bearerOnly reads a bearer token only' }))];
  const r = fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: rows }) }));
  assert.equal(r.out?.code, 'citation_missing', r.stdout);
});

// ====================================================================================================================
// Repair R2 (review of 9c8bc16: Opus R1/N0-N4, Fable N1-N4). Written before the fixes; red on d39a0fc.
// ====================================================================================================================
const WORKSPACE_FORMS = [
  ['apps/api/src/trpc/user.ts', ['deleteUser: protectedProcedure', '  .input(z.string())', '  .mutation(({ input }) => db.user.delete(input)),']],
  ['apps/api/src/modules/users/users.router.ts', ["usersRouter.post('/', h)"]],
  ['apps/api/src/app.ts', ["users.post('/x', h)"]],
  ['apps/api/src/server.ts', ["export const api = new Elysia().post('/x', h)"]],
  ['apps/api/src/plugins/users.ts', ["f.get('/users', h)"]],
  ['apps/api/src/users/users.resolver.ts', ['@Mutation(() => User)']],
];

test('[S69] R3 format 3: a workspace api/ module raises new-route exactly as format 2 does, at reassess AND at plan time (no workspace narrowing anywhere)', () => {
  for (const [path, added] of WORKSPACE_FORMS) {
    const r = refused(r3([{ path, added }]), 'surface_inventory_incomplete');
    assert.ok(r.reasons.some((x) => x.includes(path) && x.includes('new-route')), path);
    // plan time (init, preflight: DAG writes, path only): an inventory gap like any route file
    assert.deepEqual(SP.inventoryGaps({ files: [path], surfacePaths: [] }), [{ path, kinds: ['new-route'] }], path);
    // format 2 (legacy): unchanged, the path-only new-route signal opens as on origin/main
    const approved = SP.selectControls(GC, { security_policy: 2, surfaces: [OB.surf('H', 'request-handler', 'src/h.ts')], facts: OB.TRUE3, evidence: OB.cite3(OB.TRUE3) });
    const legacy = SP.reassess({ plan: OB.planOf(approved), catalog: GC, inventory: { surfaces: [] }, changed: { contract_paths: ['**'], files: [{ path, added }] }, classifications: [] });
    refused(legacy, 'classification_missing');
    assert.ok(legacy.unclassified.includes(`new-route@${path}`), path);
  }
});

test('[S68] R2.2 format 3: a test-named file on an auth path raises auth-or-middleware-change wherever it sits (no exemption)', () => {
  for (const path of ['server/middleware/auth.test.ts', 'server/middleware/__mocks__/session.ts', 'server/middleware/__tests__/00.bypass.ts', 'plugins/auth.test.js',
    'src/middleware/auth.spec.ts', 'app/routes/auth.test.tsx', 'internal/auth/session_spec.go', 'lib/my_app/auth/session_spec.ex', 'src/lib/auth.spec.ts']) {
    const r = refused(r3([{ path, added: [] }]), 'surface_inventory_incomplete');
    assert.ok(r.reasons.some((x) => x.includes(path) && x.includes('auth-or-middleware-change')), path);
  }
});

test('[S70] R2.4 citations: .git paths, docs-only files, symbols shorter than 3 and a case-variant path are refused', () => {
  for (const c of ['.git/HEAD:ref', 'sub/.git/config', 'README.md', 'docs/README.md:install', 'CLAUDE.md:rules', 'AGENTS.md', 'src/a.ts:fn', 'src/a.ts:e']) assert.notEqual(SP.citationProblem(c), null, c);
  for (const c of ['src/a.ts:saveOrder', 'docs/schema.sql:orders', 'src/a.ts']) assert.equal(SP.citationProblem(c), null, c);
  const root = dirname(OB.writeCatalog({}));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'A.ts'), 'export const persistent_writeFree = 1;\n');
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC))); // cites src/a.ts:persistent_writeFree
  refused(SP.verifyCitations(block, { root }), 'citation_missing'); // only src/A.ts exists: case-exact on every OS
});

test('[S67] R2.4 ship-ready re-verifies citations on the candidate (a repair that deleted the cited symbol does not ship)', () => {
  const root = gitRepo(); // X1: the lowering surface src/a.ts must be a repository file too
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC)));
  const s = { sp: SP, block, root };
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  assert.equal(G.citationRefusal(s), null);
  writeFileSync(join(root, 'src', 'a.ts'), 'export const cookieSession = 1;\n');
  assert.equal(G.citationRefusal(s)?.code, 'citation_missing');
  assert.equal(G.citationRefusal({ ...s, block: { ...block, policy: 2 } }), null, 'format 2: nothing to check');
});

test('R2.4 a NOT_APPLICABLE row may end its sentence with the cited path; a longer file name is still not a citation', () => {
  assert.equal(securityRowsRefusal(prim({ subject_id: 'A:VAPT-API-04', outcome: 'NOT_APPLICABLE', evidence: 'nothing is written, see src/a.ts.' }), sec()), null);
  assert.equal(securityRowsRefusal(prim({ subject_id: 'A:VAPT-API-04', outcome: 'NOT_APPLICABLE', evidence: 'see src/a.ts.bak' }), sec())?.code, 'incomplete_contract');
});

test('[S66] R2.4 init and preflight refuse a citation outside every DAG write that does not exist at base (not deferred); present at base it binds', { skip: WIN_SKIP }, async (t) => {
  const sel = (cite) => {
    const bools = Object.keys(REAL.catalog.fact_vocabulary).filter((k) => REAL.catalog.fact_vocabulary[k].type === 'bool');
    const facts = { ...Object.fromEntries(bools.map((b) => [b, false])), session_context: true };
    return ok(SP.selectControls(REAL, { security_policy: 2, facts, evidence: Object.fromEntries(bools.map((b) => [b, 'src/orders.ts:handler'])),
      surfaces: [{ boundary_id: 'orders', kind: 'request-handler', path: 'src/orders.ts', principals: ['staff'], facts: { session_context: false }, evidence: { session_context: cite } },
        { boundary_id: 'forms', kind: 'server-input', path: 'src/forms.ts', principals: ['staff'] }] }));
  };
  const missing = obFx(t, { sel: sel('config/auth.ts:bearerOnly') });
  await assert.rejects(() => preflight({ repoRoot: missing.repo, ticket: 'T-1', dagFile: missing.dagFile }), (e) => e.code === 'citation_missing');
  assert.equal(initCode(missing.cli('init', { dag: missing.dagFile })), 'citation_missing');
  const present = obFx(t, { sel: sel('docs/in.txt:input') }); // the fixture's base has docs/in.txt = 'input v1'
  assert.equal((await preflight({ repoRoot: present.repo, ticket: 'T-1', dagFile: present.dagFile })).code, 'preflight_ok');
});

test('R2 N3: the legacy golden names the catalog it was captured under; a catalog change fails with how to regenerate', () => {
  assert.equal(LEGACY.catalog_digest, REAL.digest, 'security-plan-legacy.golden.json was captured under another controls.json: regenerate it from the pre-change catalog commit (see security-plan-legacy.capture.test-helper.mjs)');
});

test('[S78] R2 supplement: node_modules, .git and gitignored files are never citations', () => {
  for (const c of ['node_modules/pkg/index.js:bearerOnly', 'apps/web/node_modules/x/a.js']) assert.notEqual(SP.citationProblem(c), null, c);
  const root = dirname(OB.writeCatalog({}));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  assert.equal(g('init', '-q').status, 0);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC)));
  ok(SP.verifyCitations(block, { root }));
  writeFileSync(join(root, '.gitignore'), 'src/a.ts\n');
  const r = refused(SP.verifyCitations(block, { root }), 'citation_missing');
  assert.ok(r.reasons.some((x) => x.startsWith('src/a.ts:') && x.includes('is gitignored')), J(r.reasons)); // the evidence reason (X1 also refuses the surface)
});

test('[S77] R2 supplement: confirmation re-verifies citations: a repair that removed the cited symbol is refused (citation_missing)', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t, { fixFiles: { 'src/orders.ts': 'export const cookieSession = true; // now sets a session cookie\n' } });
  const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'impl');
  okc(fx.gate('reassess', {}), 'reassess');
  const cand = fx.candidate();
  const review = failReview('rx-1', cand, 'src/orders.ts', fx.prompt('fix'));
  review.primary = { ...review.primary, rule_rows: [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
    ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: 'NOT_APPLICABLE', evidence: 'src/orders.ts:bearerOnly reads a bearer token only' }))] };
  okc(fx.gate('review', review), 'original FAIL');
  okc(fx.cli('drive'), 'repair');
  okc(fx.gate('reassess', {}), 'reassess after repair');
  const c = fx.gate('review', confirmReview('rx-1', fx.candidate()));
  assert.equal(c.out?.code, 'citation_missing', c.stdout);
});

test('[S72] R2 supplement: the reviewGate call site passes the second opinion to the dispute check (a counterpart finding naming a drop is recorded end to end)', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t);
  const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'impl');
  okc(fx.gate('reassess', {}), 'reassess');
  const cand = fx.candidate(), naId = fx.sel.na_pairs[0].pair_id;
  const rows = [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
    ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: 'NOT_APPLICABLE', evidence: 'src/orders.ts:bearerOnly reads a bearer token only' }))];
  const so = { ...secondOpinion(cand), outcome: 'FAIL', findings: [{ id: 'S1', severity: 'major', subject_id: naId }] };
  okc(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: rows }), second_opinion: so,
    reconciliation: { dispositions: [{ finding_id: 'S1', source: so.route, disposition: 'reject' }] } })), 'original (counterpart dispute rejected in reconciliation)');
  assert.deepEqual(fx.readState().security.disputed_na, [naId]);
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'security_na_disputed');
});

test('[S67] R2 end to end: ship-ready re-verifies citations on the candidate (a cited file that left the candidate after the review is refused)', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t);
  const okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
  okc(fx.cli('init', { dag: fx.dagFile }), 'init'); okc(fx.cli('drive'), 'api'); okc(fx.gate('red', { node: 'api' }), 'red'); okc(fx.cli('drive'), 'impl');
  okc(fx.gate('reassess', {}), 'reassess');
  const cand = fx.candidate();
  const rows = [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
    ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: 'NOT_APPLICABLE', evidence: 'src/orders.ts:bearerOnly reads a bearer token only' }))];
  okc(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: rows }) })), 'review');
  // an edit of a node's output is post_freeze_drift; a file that leaves the candidate (now excluded, work tree unchanged) is not
  writeFileSync(join(fx.repo, '.git', 'info', 'exclude'), 'src/orders.ts\n');
  okc(fx.gate('reassess', {}), 'reassess on the changed candidate');
  assert.equal(fx.gate('ship-ready', {}).out?.code, 'citation_missing');
});

// ====================================================================================================================
// Repair R3 (strategy change, review of 55784b9): format 3 closes signals EXACTLY as format 2 does. Since the S1 review
// repair (Option 2) the only format-2 vs format-3 difference is format 3's additive route lines, which only ever ADD
// signals. Property-tested over a random corpus ([S79] [S103] below).
// ====================================================================================================================
function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const DIRS = ['apps/api/src', 'packages/api/src', 'apps/api/src/trpc', 'apps/web/app/routes', 'src', 'src/lib', 'src/routes', 'src/services', 'server/middleware',
  'server/middleware/__mocks__', 'middleware', 'plugins', 'src/__tests__', 'db/migrations', 'supabase/migrations', 'pages/api', 'internal/auth', 'lib/auth', 'tests', 'app/api/orders'];
const BASES = ['index.ts', 'users.ts', 'user.ts', 'auth.ts', 'session.ts', 'router.ts', 'x.test.ts', 'x.spec.ts', 'auth.spec.ts', 'auth.test.ts', 'session_spec.go', 'x_test.go',
  '0001_rls.sql', '0002_rls.test.sql', 'route.ts', '+server.ts', 'mailer.ts', 'handler.ts', 'users.resolver.ts', 'service.ts'];
const LINES = [[], ["app.get('/x', h)"], ["usersRouter.post('/', h)"], ["fastify.get('/users', h)"], ['deleteUser: protectedProcedure', '  .mutation(({ input }) => 1),'],
  ['@Mutation(() => User)'], ['create policy p on t using (true);'], ['await sendMail(x)'], ['const k = process.env.KEY'], ['export async function GET() {}'], ['const a = 1;']];
const legacyPlan = () => OB.planOf(ok(SP.selectControls(GC, { security_policy: 2, surfaces: [OB.surf('A', 'request-handler', 'src/a.ts'), KEEP], facts: OB.TRUE3, evidence: OB.cite3(OB.TRUE3) })));
const reasonAll = (sigs) => sigs.filter((s) => s.class === null).map((s) => ({ signal_id: s.id, reason: 'reason-only dismissal (property probe)' }));
/** reassess with a reason-only classification of every signal it raises (the strongest reason-only attempt). */
function reasonOnly(plan, files) {
  const base = { plan, catalog: GC, inventory: { surfaces: [] }, changed: { contract_paths: ['**'], files } };
  const first = SP.reassess({ ...base, classifications: [] });
  const sigs = first.signals ?? [];
  return { first, final: SP.reassess({ ...base, classifications: reasonAll(sigs) }) };
}

test('[S79] R3 fixed examples: the six workspace route forms and server/middleware test files are never closed by a reason in format 3', () => {
  const p3 = OB.planOf(OB.approved3(GC));
  for (const files of [...WORKSPACE_FORMS.map(([path, added]) => [{ path, added }]), [{ path: 'server/middleware/__mocks__/session.ts', added: [] }]]) {
    const { first, final } = reasonOnly(p3, files);
    assert.equal(final.ok, false, `${files[0].path}: ${final.code}`);
    assert.ok(['surface_inventory_incomplete', 'classification_missing'].includes(first.code), first.code);
    if (files[0].path.startsWith('server/')) continue; // auth signals are not mechanical in this test catalog (no ABUSE-08)
    // a surface at the path closes it the way format 2 does: ADD_CONTROLS, then an owner addendum
    const listed = ok(SP.reassess({ plan: p3, catalog: GC, inventory: { surfaces: [OB.surf('N', 'request-handler', files[0].path)] }, changed: { contract_paths: ['**'], files }, classifications: [] }));
    assert.equal(listed.outcome, 'ADD_CONTROLS', files[0].path);
  }
});

test('[S84] [S85] [S86] R3 citations: the :symbol matches a whole identifier; a symlink leaving the repo, docs/** markdown and an unanswerable git check-ignore are refused', () => {
  const root = gitRepo(); // X1: the lowering surface src/a.ts must be a repository file too
  const block = SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC))); // cites src/a.ts:persistent_writeFree
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFreeAndMore = 1;\n');
  refused(SP.verifyCitations(block, { root }), 'citation_missing'); // a longer identifier is not the symbol
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  ok(SP.verifyCitations(block, { root }));
  const nogit = refused(SP.verifyCitations(block, { root, gitBin: join(root, 'no-such-git') }), 'citation_missing'); // check-ignore cannot answer: fail closed
  assert.ok(nogit.reasons.some((x) => x.startsWith('src/a.ts:') && x.includes('cannot be checked against .gitignore')), J(nogit.reasons)); // the evidence reason
  const outside = dirname(OB.writeCatalog({}));
  writeFileSync(join(outside, 'a.ts'), 'export const persistent_writeFree = 1;\n');
  rmSync(join(root, 'src', 'a.ts'));
  symlinkSync(join(outside, 'a.ts'), join(root, 'src', 'a.ts'));
  const out1 = refused(SP.verifyCitations(block, { root }), 'citation_missing'); // resolves outside the repository
  assert.ok(out1.reasons.some((x) => x.includes('resolves outside the repository')), J(out1.reasons));
  for (const c of ['docs/api.md:auth', 'docs/guide/security.mdx:session', 'packages/x/docs/notes.md:auth']) assert.notEqual(SP.citationProblem(c), null, c);
  assert.equal(SP.citationProblem('docs/schema.sql:orders'), null);
});

// ====================================================================================================================
// Repair R4 (review of edcadf4, citation class only; C5 untouched). Written before the fixes; red on edcadf4.
// ====================================================================================================================
const CITE_BLOCK = () => SP.parsePlanSecurityBlock(OB.planOf(OB.approved3(GC))); // cites src/a.ts:persistent_writeFree
const gitRepo = () => {
  const root = realpathSync(dirname(OB.writeCatalog({})));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
};
const withEnv = (k, v, fn) => { const old = process.env[k]; process.env[k] = v; try { return fn(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; } };

test('[S87] R4 F1: inside a repository, a git that cannot answer (exit 128) fails closed; outside any repository no ignore rule applies', () => {
  const root = gitRepo();
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'src/a.ts\n');
  refused(SP.verifyCitations(CITE_BLOCK(), { root }), 'citation_missing'); // control: gitignored
  // git exits 128 inside a repository (here a .git file naming a missing gitdir; in the field a dubious-ownership refusal):
  // unanswerable, so refused even though nothing says the file is ignored. (An inherited GIT_DIR is stripped: [S92].)
  rmSync(join(root, '.gitignore'));
  rmSync(join(root, '.git'), { recursive: true, force: true });
  writeFileSync(join(root, '.git'), 'gitdir: /nonexistent/gitdir\n');
  const broken = refused(SP.verifyCitations(CITE_BLOCK(), { root }), 'citation_missing');
  assert.ok(broken.reasons.some((x) => x.includes('cannot be checked against .gitignore')), J(broken.reasons));
  const plain = realpathSync(dirname(OB.writeCatalog({})));
  mkdirSync(join(plain, 'src'), { recursive: true });
  writeFileSync(join(plain, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  writeFileSync(join(plain, 'src', 'policy.ts'), 'export const persistent_writeFree = 1;\n');
  // no .git at or above it: an evidence citation is taken as it is (as documented), while X1 refuses the existing lowering
  // surface file (it cannot be checked against git); a deferred surface leaves only the evidence check
  ok(SP.verifyCitations(x1Block('src/orders.ts'), { root: plain, pending: ['src/orders.ts'] }));
  const noRepo = refused(SP.verifyCitations(CITE_BLOCK(), { root: plain }), 'citation_missing');
  assert.ok(noRepo.reasons.every((x) => x.startsWith('surface A path src/a.ts: ') && x.includes('cannot be checked against git')), J(noRepo.reasons));
});

test('[S88] R4 F2: the :symbol leading boundary is pinned (a longer identifier ending in the symbol does not verify it)', () => {
  const root = gitRepo(); // X1: the lowering surface src/a.ts must be a repository file too
  writeFileSync(join(root, 'src', 'a.ts'), 'export const xpersistent_writeFree = 1;\n');
  refused(SP.verifyCitations(CITE_BLOCK(), { root }), 'citation_missing');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const x = persistent_writeFree;\n');
  ok(SP.verifyCitations(CITE_BLOCK(), { root }));
});

test('[S89] R4 F3: an in-repo symlink is judged by what it resolves to (gitignored, node_modules, docs-only, .git targets refused)', () => {
  for (const [target, setup] of [['build/gen.ts', (r) => writeFileSync(join(r, '.gitignore'), 'build/\n')], ['node_modules/x/i.js', () => {}], ['README.md', () => {}], ['.git/description', () => {}]]) {
    const root = gitRepo();
    setup(root);
    mkdirSync(dirname(join(root, target)), { recursive: true });
    writeFileSync(join(root, target), 'export const persistent_writeFree = 1;\n');
    symlinkSync(join(root, target), join(root, 'src', 'a.ts'));
    const r = refused(SP.verifyCitations(CITE_BLOCK(), { root }), 'citation_missing');
    assert.ok(r.reasons.some((x) => x.startsWith('src/a.ts:') && x.includes(`resolves to ${target}`)), J(r.reasons)); // the evidence reason (X1 also refuses the symlinked surface)
  }
  // a cited symlink to an ordinary file inside the repo is fine (the lowering surface itself is a separate regular file: X1)
  const root = gitRepo();
  writeFileSync(join(root, 'src', 'impl.ts'), 'export const persistent_writeFree = 1;\n');
  writeFileSync(join(root, 'src', 'orders.ts'), 'export const orders = 1;\n');
  symlinkSync(join(root, 'src', 'impl.ts'), join(root, 'src', 'a.ts'));
  ok(SP.verifyCitations(SP.parsePlanSecurityBlock(OB.planOf(ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/orders.ts', ['persistent_write'], () => 'src/a.ts:persistent_writeFree'), KEEP])))), { root }));
});

test('[S90] R4 N3: the symlink guard compares path-segment boundaries (a sibling directory sharing the prefix is outside)', () => {
  const base = realpathSync(dirname(OB.writeCatalog({})));
  const root = join(base, 'repo'), evil = join(base, 'repo-evil');
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, 'a.ts'), 'export const persistent_writeFree = 1;\n');
  symlinkSync(join(evil, 'a.ts'), join(root, 'src', 'a.ts'));
  const out2 = refused(SP.verifyCitations(CITE_BLOCK(), { root }), 'citation_missing');
  assert.ok(out2.reasons.some((x) => x.includes('resolves outside the repository')), J(out2.reasons));
});

test('[S91] [S94] R4 N1 / R5 L2: in format 3 a changed or surface path with a "." or ".." segment is refused (bad_input); format 2 keeps be63aea behaviour', () => {
  refused(SP.reassess(OB.reIn3(GC, { contract: ['**'], files: [{ path: 'src/__tests__/../auth/session.ts' }] })), 'bad_input');
  refused(SP.reassess(OB.reIn3(GC, { contract: ['**'], files: [{ path: 'src/./auth/session.ts' }] })), 'bad_input');
  refused(SP.reassess(OB.reIn3(GC, { contract: ['**'], files: [{ path: 'src/a.ts' }], inventory: [OB.surf('N', 'request-handler', 'src/x/../n.ts')] })), 'bad_input');
  refused(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/x/../a.ts', ['persistent_write']), KEEP]), 'bad_input');
  assert.throws(() => SP.reassessSignals({ paths: ['src/../a.ts'], c5: true }), TypeError);
  // format 2 (no surface fact, a legacy block): accepted verbatim, as be63aea did ([S59] pins the exact outputs)
  ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/x/../a.ts'), KEEP]));
  const legacy = SP.reassess({ plan: legacyPlan(), catalog: GC, inventory: { surfaces: [] }, changed: { contract_paths: ['**'], files: [{ path: 'src/../a.ts' }] }, classifications: [] });
  assert.notEqual(legacy.code, 'bad_input');
  assert.ok(SP.reassessSignals({ paths: ['src/./routes/x.ts'] }).some((x) => x.kind === 'new-route'));
  ok(SP.reassess(OB.reIn3(GC, { contract: ['**'], files: [{ path: './src/a.ts' }] }))); // a leading ./ is normalized, as before
});

test('[S92] R5 L1: the ignore check runs git with GIT_* stripped (an inherited GIT_DIR/GIT_WORK_TREE cannot answer for another repository)', () => {
  const root = gitRepo(), other = gitRepo();
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'src/a.ts\n');
  const out = withEnv('GIT_DIR', join(other, '.git'), () => withEnv('GIT_WORK_TREE', other, () => SP.verifyCitations(CITE_BLOCK(), { root })));
  refused(out, 'citation_missing');
  assert.ok(out.reasons.some((x) => x.includes('gitignored')), J(out.reasons));
});

test('[S93] R5 I1: a dangling .git symlink still marks a repository (lstat, not exists): an unanswerable ignore check fails closed', () => {
  const root = realpathSync(dirname(OB.writeCatalog({})));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  symlinkSync(join(root, 'no-such-gitdir'), join(root, '.git'));
  const out = refused(SP.verifyCitations(CITE_BLOCK(), { root }), 'citation_missing');
  assert.ok(out.reasons.some((x) => x.includes('cannot be checked against .gitignore')), J(out.reasons));
});

// ====================================================================================================================
// Repair R6 (review of ad09947): a forged format-3 block whose surface path has a '.'/'..' segment. Red on ad09947.
// ====================================================================================================================
/** A digest-consistent format-3 plan whose surface A sits at `src/tmp/../lib/orders.ts` (as a hostile planner forges it). */
function forgedDotPlan() {
  // selected at a clean path, then the LOWERING surface A is moved to a dot-segment spelling of a path that raises no
  // signal: no name borrows an exemption. Since X1 the lowering-path rule refuses it as well, so the test pins the
  // dot-segment reason itself
  const base = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/lib/orders.ts', ['session_context'], () => 'src/orders.ts:bearerOnly'), KEEP]));
  const surfaces = base.surfaces.map((s) => (s.boundary_id === 'A' ? { ...s, path: 'src/tmp/../lib/orders.ts' } : s));
  const v3 = { surfaces, pairs: ids(base.pairs), na_pairs: base.na_pairs.map((n) => ({ pair_id: n.pair_id, facts: n.facts, evidence: n.evidence })) };
  const selection_digest = sha(SP.canon({ policy: 3, catalog_digest: base.catalog_digest, facts_digest: base.facts_digest, controls: base.controls.map((c) => c.control_id), ...v3 }));
  return OB.planOf({ ...base, surfaces, selection_digest });
}

test('[S95] [S96] R6 L4: a forged format-3 block with a dot-segment surface path is refused by the plan-block parse, obligationMatrix (replay) and the obligations CLI', () => {
  const plan = forgedDotPlan();
  assert.equal(SP.parsePlanSecurityBlock(plan), null, 'the parse refuses it (plan_block_invalid at every consumer)');
  // obligationMatrix on the block object itself (a caller that bypasses the parse): the replay refuses it
  const line = plan.split('\n').find((l) => l.startsWith('<!-- security-plan: '));
  const raw = JSON.parse(line.slice('<!-- security-plan: '.length, -' -->'.length));
  const replayed = refused(SP.obligationMatrix(GC, raw), 'plan_block_invalid');
  assert.ok(replayed.reasons.some((x) => x.includes("has a '.' or '..' segment")), J(replayed.reasons)); // the R6 refusal, not only X1's path rule
  // the CLI (manual flow)
  const dir = dirname(OB.writeCatalog({}));
  writeFileSync(join(dir, 'forged.md'), plan);
  mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src', 'orders.ts'), 'export const bearerOnly = 1;\n');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./security-plan.mjs', import.meta.url)), 'obligations', '--plan', join(dir, 'forged.md'), '--catalog', OB.GATED_PATH, '--repo', dir], { encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).code, 'plan_block_invalid', r.stdout);
  // reassess (and so the gate and init's bindSecurity reassess) refuses it too
  refused(SP.reassess(OB.reIn3(GC, { plan, files: [{ path: 'src/a.ts' }], contract: ['**'] })), 'plan_block_invalid');
});

test('[S97] R6 I6: a lone inherited GIT_WORK_TREE is dropped too (the root repository answers for its own ignore rules)', () => {
  const root = gitRepo(), other = gitRepo();
  writeFileSync(join(root, 'src', 'a.ts'), 'export const persistent_writeFree = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'src/a.ts\n');
  mkdirSync(join(other, 'src'), { recursive: true });
  const out = withEnv('GIT_WORK_TREE', other, () => SP.verifyCitations(CITE_BLOCK(), { root }));
  refused(out, 'citation_missing');
  assert.ok(out.reasons.some((x) => x.includes('gitignored')), J(out.reasons));
});

// ====================================================================================================================
// S1 review repair (Option 2, owner decision): NO filename-based exemption. Format 3 uses format 2's detector for
// every path and line signal (plus the additive ROUTE_LINE_V3 route lines), so it never suppresses an obligation
// format 2 requires, in every consumer: reassess signals, inventory gaps, the own-path lowering guard and the reopen
// keep set. Written before the fix.
// ====================================================================================================================
const REPORTED = [
  ['app/routers/test_results.py', ['from fastapi import APIRouter', 'router = APIRouter()', '@router.get("/test-results/{id}")', 'def detail(id: str):'], 'new-route'],
  ['edge-functions/auth.test.ts', ['export default async (request, context) => new Response("ok");'], 'auth-or-middleware-change'],
  ['src/orders.test.ts', ["import { app } from './server';", "app.post('/orders', (req, res) => res.json({ ok: true }));"], 'new-route'],
  ['public/login.test.php', ['<?php $_SESSION["user"] = $u;'], 'auth-or-middleware-change'],
  ['src/auth.test.ts', [], 'auth-or-middleware-change'],
  ['src/lib/util.test.ts', ["app.get('/x', h)"], 'new-route'],
  ['src/__tests__/lib/x.ts', ['router.post("/x")'], 'new-route'],
  ['tests/test_routes.py', ['router.post("/x")'], 'new-route'],
  ['spec/requests/orders_spec.rb', ['router.post("/x")'], 'new-route'],
];
const DESCRIBE_ONLY = [
  ['src/orders.test.ts', ["describe('orders', () => {", "  it('totals', () => { expect(1 + 1).toBe(2); });", '});']],
  ['src/lib/util.spec.ts', ["import { describe, it, expect } from 'vitest';", "describe('util', () => { it('adds', () => { expect(1).toBe(1); }); });"]],
  ['test/e2e/app.e2e-spec.ts', ["describe('app', () => { it('boots', () => { expect(true).toBe(true); }); });"]],
];
const surfaceKinds = (path, added, c5) => SP.reassessSignals({ paths: [{ path, added }], ...(c5 ? { c5: true } : {}) }).filter((s) => SP.SURFACE_SIGNALS.includes(s.kind)).map((s) => s.kind);

test('[S106] format 3: the reported test-named files raise their signals and inventory gaps exactly as format 2 does; a describe/it/expect-only file raises nothing', () => {
  for (const [path, added, kind] of REPORTED) {
    assert.ok(surfaceKinds(path, added, true).includes(kind), `${path}: format 3 raises ${kind}`);
    assert.deepEqual(surfaceKinds(path, added, true), surfaceKinds(path, added, false), `${path}: format 3 = format 2`);
    const r = refused(r3([{ path, added }]), 'surface_inventory_incomplete');
    assert.ok(r.reasons.some((x) => x.includes(path) && x.includes(kind)), `${path}: ${J(r.reasons)}`);
    assert.ok(SP.inventoryGaps({ files: [{ path, added }], surfacePaths: [] }).some((g) => g.path === path && g.kinds.includes(kind)), `${path}: plan-time gap`);
    assert.deepEqual(SP.inventoryGaps({ files: [{ path, added }], surfacePaths: [path] }), [], `${path}: listing it as a surface clears the gap`);
  }
  // the remedy terminates: a route file listed in the inventory closes like any route file (ADD_CONTROLS, then an addendum)
  const listed = ok(SP.reassess(OB.reIn3(GC, { contract: ['**'], files: [{ path: 'src/orders.test.ts', added: REPORTED[2][1] }], inventory: [OB.surf('T', 'request-handler', 'src/orders.test.ts')] })));
  assert.equal(listed.outcome, 'ADD_CONTROLS');
  for (const [path, added] of DESCRIBE_ONLY) {
    assert.deepEqual(surfaceKinds(path, added, true), [], `${path}: a test with no route or auth signal raises nothing`);
    assert.equal(ok(r3([{ path, added }])).outcome, 'UNCHANGED', path);
  }
});

test('[S104] format 3: a test-named surface whose own path raises an auth signal cannot lower session_context, exactly like src/auth.ts', () => {
  for (const path of ['src/auth.ts', 'src/auth.test.ts', 'src/session.spec.ts', 'src/__tests__/auth.ts', 'public/login.test.php']) {
    const r = refused(OB.sel3(GC, [OB.surf('A', 'request-handler', path, ['session_context']), KEEP]), 'surface_fact_not_lowerable');
    assert.ok(r.reasons.some((x) => x.includes('auth-or-middleware-change') && x.includes('VAPT-CFG-04')), `${path}: ${J(r.reasons)}`);
  }
  ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/orders.test.ts', ['session_context']), KEEP]));
});

/** The gated catalog with VAPT-API-02 also gated by persistent_write (so a new-route signal's class can name a dropped pair). */
const GC_API02 = (() => { const c = JSON.parse(J(OB.GATED)); const api04 = c.controls.find((x) => x.id === 'VAPT-API-04'), api02 = c.controls.find((x) => x.id === 'VAPT-API-02');
  api02.applies_when = api04.applies_when; api02.not_applicable = { ...api04.not_applicable }; return SP.loadCatalog({ catalogPath: OB.writeCatalog(c) }); })();

test('[S105] format 3 reopen: a route line on a test-named approved surface reopens the dropped pairs its class names; an approval the name guard let through no longer replays', () => {
  ok(GC_API02);
  const s = ok(OB.sel3(GC_API02, [OB.surf('T', 'request-handler', 'src/orders.test.ts', ['persistent_write']), KEEP]));
  assert.deepEqual(ids(s.na_pairs), ['T:VAPT-API-02', 'T:VAPT-API-04']);
  const plan = OB.planOf(s);
  const base = { plan, catalog: GC_API02, inventory: { surfaces: [] }, changed: { contract_paths: ['src/**'], files: [{ path: 'src/orders.test.ts', added: ["app.post('/orders', h)"] }] }, addenda: [] };
  const r = SP.reassess({ ...base, classifications: [{ signal_id: 'new-route@src/orders.test.ts', reason: 'reason-only attempt' }] });
  assert.equal(r.ok, true, J(r));
  assert.equal(r.outcome, 'ADD_CONTROLS', J(r));
  assert.ok(r.reopened_pairs.includes('T:VAPT-API-02'), J(r.reopened_pairs));
  // Fable's example: src/auth.test.ts lowering session_context, a block the old name guard accepted (forged here with a
  // valid digest), is refused when replayed: later session code there can never reassess UNCHANGED.
  const good = ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/a.ts', ['session_context']), KEEP]));
  assert.deepEqual(ids(good.na_pairs), ['A:VAPT-CFG-04']);
  const P = 'src/auth.test.ts', mv = (x) => (x.boundary_id === 'A' ? { ...x, path: P, evidence: { session_context: `${P}:session_contextFree` } } : x);
  const surfaces = good.surfaces.map(mv);
  const na_pairs = good.na_pairs.map((n) => ({ pair_id: n.pair_id, facts: n.facts, evidence: { session_context: `${P}:session_contextFree` } }));
  const v3 = { surfaces, pairs: ids(good.pairs), na_pairs };
  const selection_digest = sha(SP.canon({ policy: 3, catalog_digest: good.catalog_digest, facts_digest: good.facts_digest, controls: good.controls.map((c) => c.control_id), ...v3 }));
  const forged = { ...good, surfaces, na_pairs: good.na_pairs.map((n) => ({ ...n, evidence: na_pairs[0].evidence })), selection_digest };
  const fplan = OB.planOf(forged);
  assert.ok(SP.parsePlanSecurityBlock(fplan), 'the forged block is well-formed');
  refused(SP.reassess(OB.reIn3(GC, { plan: fplan, files: [{ path: P, added: ["res.cookie('sid', token)"] }] })), 'plan_block_invalid');
});

test('[S79] [S103] property (S79 corpus, >= 4000 inputs, with lines and path-only): format-3 signals are a superset of format-2 signals for every kind; the only extras are new-route route lines', () => {
  const rnd = prng(20261120), pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const random = Array.from({ length: 4200 }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ path: `${pick(DIRS)}/${pick(BASES)}`, added: pick(LINES) })));
  const fixed = [...REPORTED, ...DESCRIBE_ONLY].map(([path, added]) => [{ path, added }]);
  const all = (sigs) => new Set(sigs.map((s) => `${s.path}|${s.kind}`));
  const p2 = legacyPlan(), p3 = OB.planOf(OB.approved3(GC));
  let checked = 0, extras = 0, testNamed = 0, refusedBoth = 0;
  for (const files of [...fixed, ...random]) {
    const uniq = [...new Map(files.map((f) => [f.path, f])).values()];
    for (const fs of [uniq, uniq.map((f) => f.path)]) {
      const f2 = all(SP.reassessSignals({ paths: fs })), f3 = all(SP.reassessSignals({ paths: fs, c5: true }));
      assert.deepEqual([...f2].filter((k) => !f3.has(k)), [], `format 3 omits a format-2 signal: ${J(fs)}`);
      for (const k of [...f3].filter((x) => !f2.has(x))) { assert.ok(k.endsWith('|new-route'), `${k} ${J(fs)}`); extras++; }
      if (typeof fs[0] === 'string') assert.deepEqual([...f3].sort(), [...f2].sort(), `path-only signals are format 2's exactly: ${J(fs)}`);
      const g3 = new Set(SP.inventoryGaps({ files: fs, surfacePaths: [] }).flatMap((g) => g.kinds.map((k) => `${g.path}|${k}`)));
      assert.deepEqual([...f2].filter((k) => SP.SURFACE_SIGNALS.includes(k.split('|')[1]) && !g3.has(k)), [], `inventory omits a format-2 surface signal: ${J(fs)}`);
    }
    if (uniq.some((f) => /\.(test|spec)\.|_test\.|_spec\.|__tests__|__mocks__|(^|\/)test_/.test(f.path))) testNamed++;
    // end to end: if format 2 cannot reach `reassessed` with reason-only classifications because of a surface signal, format 3 cannot either
    const s2 = SP.reassessSignals({ paths: uniq });
    const r2 = reasonOnly(p2, uniq).final;
    if ((r2.unclassified ?? []).some((id) => SP.SURFACE_SIGNALS.includes(s2.find((x) => x.id === id)?.kind))) {
      const r3x = reasonOnly(p3, uniq).final;
      assert.equal(r3x.ok, false, `format 3 reached ${r3x.code} with reason-only classifications: ${J(uniq)}`); refusedBoth++;
    }
    checked++;
  }
  assert.ok(checked >= 4000 && extras > 100 && testNamed > 1000 && refusedBoth > 1000, J({ checked, extras, testNamed, refusedBoth }));
});

// ====================================================================================================================
// X1 (closes S1 known limitation L1): the path of a surface that LOWERS a fact (block format 3) must be one exact
// repository file. Syntactic rule in lowerings() (select, replay, reassess, obligationMatrix): surface_fact_not_lowerable.
// Filesystem and git rule in verifyCitations (init, preflight, original and confirmation reviews, ship-ready, the
// obligations CLI): citation_missing. Written before the fix; red on 3977b81. Each block below cites its evidence in a
// separate clean file (src/policy.ts), so only the surface-path rule can refuse it.
// ====================================================================================================================
const X1_CITE = 'src/policy.ts:persistent_writeFree';
const X1_SYM = POSIX ? false : 'symlinks need privileges on Windows';
/** The selection with lowering surface A (persistent_write) at `path` and the keeper K (non-lowering, at a path that never exists). */
const x1Sel = (path, keeper = KEEP) => OB.sel3(GC, [OB.surf('A', 'request-handler', path, ['persistent_write'], () => X1_CITE), keeper]);
const x1Block = (path) => SP.parsePlanSecurityBlock(OB.planOf(ok(x1Sel(path))));
/** A git repository holding the cited src/policy.ts and `files`; `add` stages them all (tracked), else they stay untracked. */
const x1Repo = (files = { 'src/orders.ts': 'export const orders = 1;\n' }, { add = true } = {}) => {
  const root = gitRepo();
  writeFileSync(join(root, 'src', 'policy.ts'), 'export const persistent_writeFree = 1;\n');
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  if (add) assert.equal(spawnSync('git', ['add', '-A'], { cwd: root }).status, 0);
  return root;
};
/** A citation_missing refusal naming surface A's path with `what`; the evidence citation (src/policy.ts) is not among the reasons. */
const surfaceRefused = (r, path, what) => {
  refused(r, 'citation_missing');
  assert.ok(r.reasons.some((x) => x.startsWith(`surface A path ${path}: `) && x.includes(what)), `want "surface A path ${path}: ...${what}...": ${J(r.reasons)}`);
  return r;
};
const evidenceClean = (r) => assert.ok(!r.reasons.some((x) => x.startsWith('src/policy.ts')), `the evidence citation verifies: ${J(r.reasons)}`);

test('[S107] X1 syntactic rule: a lowering surface path that is not one file path (trailing slash, directory, path:symbol, glob, whitespace, placeholder, docs-only, .git, node_modules) is surface_fact_not_lowerable', () => {
  for (const path of ['src/', 'src', 'src/orders.ts/', 'src/orders.ts:handler', 'src/orders.ts:bearerOnly', 'src/*.ts', 'src/**', 'src/?.ts', 'src/orders .ts',
    'src/TODO', 'src/tbd.ts', 'README.md', 'docs/orders.md', 'node_modules/x/orders.ts', '.git/config']) {
    const r = refused(x1Sel(path), 'surface_fact_not_lowerable');
    assert.ok(r.reasons.some((x) => x.startsWith('surface A: its path') && x.includes(J(path))), `${path}: ${J(r.reasons)}`);
  }
  // controls: an exact file path (a leading ./ normalized as before; brackets, parentheses and $ are file-name characters)
  for (const path of ['src/orders.ts', './src/orders.ts', 'app/api/orders/[id]/route.ts', 'src/routes/(app)/orders/+page.server.ts', 'app/routes/orders.$id.tsx']) ok(x1Sel(path));
  // a NON-lowering surface is never checked, and format 2 is untouched
  ok(x1Sel('src/orders.ts', OB.surf('K', 'request-handler', 'src/')));
  ok(OB.sel3(GC, [OB.surf('A', 'request-handler', 'src/*.ts'), OB.surf('K', 'request-handler', 'src/orders.ts:handler')]));
});

/** A digest-consistent format-3 plan whose LOWERING surface A was moved to `path` after selection (a hand-edited block). */
function x1ForgedPlan(path) {
  const base = ok(x1Sel('src/orders.ts'));
  const surfaces = base.surfaces.map((s) => (s.boundary_id === 'A' ? { ...s, path } : s));
  const v3 = { surfaces, pairs: ids(base.pairs), na_pairs: base.na_pairs.map((n) => ({ pair_id: n.pair_id, facts: n.facts, evidence: n.evidence })) };
  const selection_digest = sha(SP.canon({ policy: 3, catalog_digest: base.catalog_digest, facts_digest: base.facts_digest, controls: base.controls.map((c) => c.control_id), ...v3 }));
  return OB.planOf({ ...base, surfaces, selection_digest });
}

test('[S107] X1 syntactic rule at replay: a hand-edited block whose lowering surface names a path:symbol or a directory is plan_block_invalid (reassess, obligationMatrix, the obligations CLI)', () => {
  for (const path of ['src/orders.ts:handler', 'src/', 'src/*.ts']) {
    const plan = x1ForgedPlan(path);
    const block = SP.parsePlanSecurityBlock(plan);
    assert.ok(block, `${path}: the forged block is well-formed`);
    const re = refused(SP.reassess(OB.reIn3(GC, { plan, files: [{ path: 'src/k.ts' }], contract: ['**'] })), 'plan_block_invalid');
    assert.ok(re.reasons.some((x) => x.includes('surface_fact_not_lowerable')), `${path}: ${J(re.reasons)}`);
    refused(SP.obligationMatrix(GC, block), 'plan_block_invalid');
  }
  const dir = x1Repo();
  writeFileSync(join(dir, 'forged.md'), x1ForgedPlan('src/orders.ts:handler'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./security-plan.mjs', import.meta.url)), 'obligations', '--plan', join(dir, 'forged.md'), '--catalog', OB.GATED_PATH, '--repo', dir], { encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).code, 'plan_block_invalid', r.stdout);
});

test('X1 controls: an exact tracked file and an untracked, not ignored file verify; the non-lowering keeper (a path that does not exist) is never checked; format 2 has nothing to check', () => {
  const block = x1Block('src/orders.ts');
  ok(SP.verifyCitations(block, { root: x1Repo() }));
  ok(SP.verifyCitations(block, { root: x1Repo(undefined, { add: false }) }));
  assert.equal(SP.verifyCitations({ ...block, policy: 2 }, { root: join(tmpRoot(), 'nope') }).ok, true);
});
const tmpRoot = () => realpathSync(dirname(OB.writeCatalog({})));

test('[S108] X1 exact case: a lowering surface path that differs only in letter case from the tracked file is refused on every OS (a case alias)', () => {
  const root = x1Repo();
  for (const path of ['src/Orders.ts', 'Src/orders.ts', 'src/orders.TS']) {
    const r = surfaceRefused(SP.verifyCitations(x1Block(path), { root }), path, 'case alias');
    evidenceClean(r);
  }
});

test('[S115] X1 untracked is what git lists as untracked: a file inside a nested repository, or (case-insensitive file systems) a file the index spells otherwise, is refused', () => {
  const nested = x1Repo({});
  mkdirSync(join(nested, 'src', 'vendor'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: join(nested, 'src', 'vendor') }).status, 0);
  writeFileSync(join(nested, 'src', 'vendor', 'orders.ts'), 'export const orders = 1;\n');
  evidenceClean(surfaceRefused(SP.verifyCitations(x1Block('src/vendor/orders.ts'), { root: nested }), 'src/vendor/orders.ts', 'listed by git neither as tracked nor as untracked'));
  const split = x1Repo({ 'src/Orders.ts': 'export const orders = 1;\n' }); // staged as src/Orders.ts ...
  rmSync(join(split, 'src', 'Orders.ts'));
  writeFileSync(join(split, 'src', 'orders.ts'), 'export const orders = 1;\n'); // ... and spelled src/orders.ts on disk
  const insensitive = existsSync(join(split, 'src', 'ORDERS.ts'));
  const r = SP.verifyCitations(x1Block('src/orders.ts'), { root: split });
  if (insensitive) evidenceClean(surfaceRefused(r, 'src/orders.ts', 'the index spells it otherwise'));
  else ok(r); // case-sensitive: src/orders.ts is a new untracked file and src/Orders.ts a deleted one, as git reports them
});

test('[S109] X1 regular file: a lowering surface path that is a directory, or sits below a file, is refused', () => {
  const root = x1Repo({ 'src/orders/index.ts': 'export const x = 1;\n', 'src/orders.ts': 'export const y = 1;\n' });
  evidenceClean(surfaceRefused(SP.verifyCitations(x1Block('src/orders'), { root }), 'src/orders', 'is not a regular file'));
  evidenceClean(surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts/index.ts'), { root }), 'src/orders.ts/index.ts', 'src/orders.ts is not a directory'));
});

test('[S110] X1 no symlink anywhere: a symlinked leaf, a symlinked parent directory, a link leaving the repository and a dangling link are refused (also at confirmation and ship-ready)', { skip: X1_SYM }, () => {
  const leaf = x1Repo({ 'src/real.ts': 'export const y = 1;\n' });
  symlinkSync(join(leaf, 'src', 'real.ts'), join(leaf, 'src', 'orders.ts'));
  spawnSync('git', ['add', '-A'], { cwd: leaf });
  evidenceClean(surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts'), { root: leaf }), 'src/orders.ts', 'src/orders.ts is a symlink'));
  // ...at confirmation and ship-ready too: both re-run the same check on the candidate (engine-gates citationRefusal)
  assert.equal(G.citationRefusal({ sp: SP, block: x1Block('src/orders.ts'), root: leaf })?.code, 'citation_missing');
  const parent = x1Repo({ 'lib/orders.ts': 'export const y = 1;\n' });
  symlinkSync(join(parent, 'lib'), join(parent, 'src', 'lib'));
  evidenceClean(surfaceRefused(SP.verifyCitations(x1Block('src/lib/orders.ts'), { root: parent }), 'src/lib/orders.ts', 'src/lib is a symlink'));
  const away = x1Repo({}), outside = tmpRoot();
  writeFileSync(join(outside, 'orders.ts'), 'export const y = 1;\n');
  symlinkSync(join(outside, 'orders.ts'), join(away, 'src', 'orders.ts'));
  evidenceClean(surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts'), { root: away }), 'src/orders.ts', 'src/orders.ts is a symlink'));
  const dangling = x1Repo({});
  symlinkSync(join(dangling, 'src', 'gone.ts'), join(dangling, 'src', 'orders.ts'));
  // a dangling link is an entry, never "missing": not even a pending write defers it
  evidenceClean(surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts'), { root: dangling, pending: ['src'] }), 'src/orders.ts', 'src/orders.ts is a symlink'));
});

test('[S111] X1 tracked or not ignored: an untracked gitignored lowering surface file is refused; tracked or untracked-not-ignored verifies', () => {
  const root = x1Repo(undefined, { add: false });
  writeFileSync(join(root, '.gitignore'), 'src/orders.ts\n');
  const r = surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts'), { root }), 'src/orders.ts', 'is ignored by git');
  evidenceClean(r);
  assert.ok(!r.reasons.some((x) => x.includes('gitignored')), 'the surface reason never reads like the evidence ignore reason');
  rmSync(join(root, '.gitignore'));
  ok(SP.verifyCitations(x1Block('src/orders.ts'), { root }));
});

test('[S112] X1 deferral is plan-time only: a missing lowering surface file under a DAG write is deferred; at the gates (no pending) or outside every write it is refused; an existing directory is never deferred', () => {
  const root = x1Repo({});
  const block = x1Block('src/orders.ts');
  ok(SP.verifyCitations(block, { root, pending: ['src'] }));
  ok(SP.verifyCitations(block, { root, pending: ['src/orders.ts'] }));
  evidenceClean(surfaceRefused(SP.verifyCitations(block, { root }), 'src/orders.ts', 'does not exist'));
  surfaceRefused(SP.verifyCitations(block, { root, pending: ['lib'] }), 'src/orders.ts', 'does not exist');
  mkdirSync(join(root, 'src', 'orders.ts'));
  writeFileSync(join(root, 'src', 'orders.ts', 'x.ts'), 'export const x = 1;\n');
  surfaceRefused(SP.verifyCitations(block, { root, pending: ['src'] }), 'src/orders.ts', 'is not a regular file');
});

test('[S113] X1 fail closed: no repository at or above the root, or no git binary, refuses the lowering surface (cannot be checked against git)', () => {
  const plain = tmpRoot();
  mkdirSync(join(plain, 'src'), { recursive: true });
  writeFileSync(join(plain, 'src', 'orders.ts'), 'export const orders = 1;\n');
  writeFileSync(join(plain, 'src', 'policy.ts'), 'export const persistent_writeFree = 1;\n');
  const r = surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts'), { root: plain }), 'src/orders.ts', 'cannot be checked against git');
  evidenceClean(r); // an evidence citation outside any repository is still taken as it is ([S87])
  const root = x1Repo();
  surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts'), { root, gitBin: join(root, 'no-such-git') }), 'src/orders.ts', 'cannot be checked against git');
  // a broken .git (git exits 128 inside a repository) fails closed too
  rmSync(join(root, '.git'), { recursive: true, force: true });
  writeFileSync(join(root, '.git'), 'gitdir: /nonexistent/gitdir\n');
  surfaceRefused(SP.verifyCitations(x1Block('src/orders.ts'), { root }), 'src/orders.ts', 'cannot be checked against git');
});

test('[S114] X1 GIT_* dropped: an inherited GIT_DIR / GIT_WORK_TREE naming a repository that tracks the path cannot vouch for a root that has none', () => {
  const other = x1Repo(); // tracks src/orders.ts
  const plain = tmpRoot();
  mkdirSync(join(plain, 'src'), { recursive: true });
  writeFileSync(join(plain, 'src', 'orders.ts'), 'export const orders = 1;\n');
  writeFileSync(join(plain, 'src', 'policy.ts'), 'export const persistent_writeFree = 1;\n');
  const block = x1Block('src/orders.ts');
  surfaceRefused(withEnv('GIT_DIR', join(other, '.git'), () => SP.verifyCitations(block, { root: plain })), 'src/orders.ts', 'cannot be checked against git');
  surfaceRefused(withEnv('GIT_DIR', join(other, '.git'), () => withEnv('GIT_WORK_TREE', plain, () => SP.verifyCitations(block, { root: plain }))), 'src/orders.ts', 'cannot be checked against git');
});

/** The engine rows of a review over obFx: PASS per effective pair, NOT_APPLICABLE per dropped pair citing its own evidence. */
const x1Rows = (fx) => [{ subject_id: 'no-catch-all', outcome: 'PASS', evidence: 'src/a.txt:1' }, ...fx.ids.map((id) => ({ subject_id: id, outcome: 'PASS', evidence: SPEC })),
  ...fx.sel.na_pairs.map((n) => ({ subject_id: n.pair_id, outcome: 'NOT_APPLICABLE', evidence: `${Object.values(n.evidence)[0]} reads a bearer token only` }))];
const X1_POLICY = { 'src/policy.ts': 'export const bearerOnly = true;\n' };
const x1Okc = (r, m) => assert.equal(r.status, 0, `${m}: ${r.stdout}${r.stderr}`);
const x1ToReview = (fx) => { x1Okc(fx.cli('init', { dag: fx.dagFile }), 'init (src/orders.ts is a pending write: deferred)'); x1Okc(fx.cli('drive'), 'api'); x1Okc(fx.gate('red', { node: 'api' }), 'red'); x1Okc(fx.cli('drive'), 'impl'); x1Okc(fx.gate('reassess', {}), 'reassess'); return fx.candidate(); };
const surfaceGateRefused = (r, what) => {
  assert.equal(r.out?.code, 'citation_missing', r.stdout);
  assert.ok((r.out.reasons ?? []).some((x) => x.includes('surface orders path src/orders.ts: ') && x.includes(what)), r.stdout);
};

test('[S112] X1 end to end: a lowering surface file deferred at init that is still missing (or became a directory) at the original review is refused there', { skip: WIN_SKIP }, (t) => {
  for (const [implFiles, what] of [[X1_POLICY, 'does not exist'], [{ ...X1_POLICY, 'src/orders.ts/index.ts': 'export const x = 1;\n' }, 'is not a regular file']]) {
    const fx = obFx(t, { sel: realSelection('src/policy.ts:bearerOnly'), implFiles });
    const cand = x1ToReview(fx);
    surfaceGateRefused(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: x1Rows(fx) }) })), what);
  }
});

test('X1 end to end: a confirmation after a repair that deletes the lowering surface file is refused (citation_missing)', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t, { sel: realSelection('src/policy.ts:bearerOnly'), implFiles: { ...X1_POLICY, 'src/orders.ts': 'export const orders = 1;\n' }, fixFiles: {}, fixRemove: ['src/orders.ts'] });
  const cand = x1ToReview(fx);
  const review = failReview('rx-1', cand, 'src/orders.ts', fx.prompt('fix'));
  review.primary = { ...review.primary, rule_rows: x1Rows(fx) };
  x1Okc(fx.gate('review', review), 'original FAIL');
  x1Okc(fx.cli('drive'), 'repair (deletes src/orders.ts)');
  x1Okc(fx.gate('reassess', {}), 'reassess after repair');
  surfaceGateRefused(fx.gate('review', confirmReview('rx-1', fx.candidate())), 'does not exist');
});

test('X1 end to end: ship-ready refuses when the lowering surface file left the candidate after the review (now ignored)', { skip: WIN_SKIP }, (t) => {
  const fx = obFx(t, { sel: realSelection('src/policy.ts:bearerOnly'), implFiles: { ...X1_POLICY, 'src/orders.ts': 'export const orders = 1;\n' } });
  const cand = x1ToReview(fx);
  x1Okc(fx.gate('review', passReview('rx-1', cand, { primary: primaryReview(cand, { rule_rows: x1Rows(fx) }) })), 'review');
  writeFileSync(join(fx.repo, '.git', 'info', 'exclude'), 'src/orders.ts\n');
  x1Okc(fx.gate('reassess', {}), 'reassess on the changed candidate');
  surfaceGateRefused(fx.gate('ship-ready', {}), 'is ignored by git');
});

// ---- X1 differential against S1 (3977b81): the corpus of [S103] extended with lowering surfaces at exact and broken paths.
/** Broken spellings of a valid path: each breaks the documented rule (a ':' or a citationProblem). */
const X1_BAD = [(p) => `${p}/`, (p) => p.slice(0, p.lastIndexOf('/') + 1), (p) => p.split('/')[0], (p) => `${p}:handler`, (p) => `${p.slice(0, p.lastIndexOf('/'))}/*.ts`,
  (p) => `${p.slice(0, p.lastIndexOf('/'))}/?.ts`, (p) => `${p.slice(0, p.lastIndexOf('/'))}/README.md`, (p) => `node_modules/${p}`, (p) => `${p.slice(0, p.lastIndexOf('/'))}/TODO`,
  (p) => `${p} x`, (p) => `docs/${p.split('/').pop().replace(/\.[^.]+$/, '')}.md`, (p) => `${p.slice(0, p.lastIndexOf('/'))}/.git/HEAD`];
const X1_FACTS = Object.keys(OB.TRUE3);
function x1Corpus(n, seed) {
  const rnd = prng(seed), pick = (xs) => xs[Math.floor(rnd() * xs.length)], file = () => `${pick(DIRS)}/${pick(BASES)}`;
  const lowering = (id) => {
    const valid = file(), r = rnd();
    const path = r < 0.35 ? pick(X1_BAD)(valid) : r < 0.45 ? `./${valid}` : valid;
    const low = X1_FACTS.filter(() => rnd() < 0.5);
    return OB.surf(id, pick(['request-handler', 'rendering-sink']), path, low.length ? low : [pick(X1_FACTS)], (f) => `${file()}:${f}Free`);
  };
  return Array.from({ length: n }, () => ({ files: [{ path: file(), added: pick(LINES) }],
    surfaces: [lowering('A'), ...(rnd() < 0.3 ? [lowering('B')] : []), OB.surf('K', pick(['request-handler', 'rendering-sink', 'outbound-data']), file())] }));
}
/** The documented rule, independently of lowerings(): one repository file path, no ':symbol'. */
const x1RuleHolds = (path) => !String(path).replace(/^(\.\/)+/, '').includes(':') && SP.citationProblem(String(path).replace(/^(\.\/)+/, '')) === null;
const x1Sum = (r) => (r.ok ? sha(SP.canon(r)) : SP.canon([r.code, r.reasons]));
/** Every output of one corpus input: format-3 select, its format-2 twin, and for an accepted format-3 block its reassessment (reason-only) and obligation matrix. */
function x1Outputs(sp, catalog, x) {
  const sel = (surfaces) => sp.selectControls(catalog, { security_policy: 2, surfaces, facts: OB.TRUE3, evidence: OB.cite3(OB.TRUE3) });
  const f3 = sel(x.surfaces), f2 = sel(x.surfaces.map(({ facts, evidence, ...s }) => s));
  const out = { f3, f2: x1Sum(f2), f3sum: x1Sum(f3) };
  if (f3.ok) {
    const plan = OB.planOf(f3), base = { plan, catalog, inventory: { surfaces: [] }, changed: { contract_paths: ['**'], files: x.files } };
    const first = sp.reassess({ ...base, classifications: [] });
    const final = sp.reassess({ ...base, classifications: (first.signals ?? []).filter((s) => s.class === null).map((s) => ({ signal_id: s.id, reason: 'reason-only dismissal (X1 differential)' })) });
    out.rest = [x1Sum(first), x1Sum(final), x1Sum(sp.obligationMatrix(catalog, sp.parsePlanSecurityBlock(plan)))];
  }
  return out;
}
/** S1 (3977b81) outputs over x1Corpus(4000, 20261122), captured with X1_CAPTURE=1 on that commit's security-plan.mjs. */
const X1_S1 = { n: 4000, keep: 'sha256:737006b48fc5eef67a8d5a462002b3255c558e0d301692f0db22b7791a0c7a82',
  f2: 'sha256:7831307e5cf2e25d40059236d6e67b333c1ae552921decc6b385ae1d5e8e1902', keptAccepted: 1219, brokenAcceptedByS1: 936 };

test('X1 differential (S1 3977b81, >= 4000 inputs): X1 accepts a subset of S1; every input that keeps the rule has S1\'s exact outputs (select, reassess, matrix); every broken lowering path is refused; format 2 is identical on every input', () => {
  const corpus = x1Corpus(X1_S1.n, 20261122);
  const keep = [], f2 = [];
  let keptAccepted = 0, broken = 0, brokenAccepted = 0;
  for (const [i, x] of corpus.entries()) {
    const o = x1Outputs(SP, GC, x);
    f2.push(o.f2);
    if (x.surfaces.every((s) => !s.facts || x1RuleHolds(s.path))) { keep.push([i, o.f3sum, ...(o.rest ?? [])]); if (o.f3.ok) keptAccepted++; continue; }
    broken++;
    if (o.f3.ok) brokenAccepted++;
    if (!process.env.X1_CAPTURE) assert.equal(o.f3.ok, false, `a broken lowering path is accepted: ${J(x.surfaces)}`);
  }
  const got = { n: corpus.length, keep: sha(SP.canon(keep)), f2: sha(SP.canon(f2)), keptAccepted, brokenAcceptedByS1: brokenAccepted };
  // capture (on 3977b81's security-plan.mjs, to re-pin X1_S1): always a failure, so it can never pass for the real test
  if (process.env.X1_CAPTURE) assert.fail(`X1_CAPTURE ${J(got)} broken=${broken}`);
  assert.deepEqual({ ...got, brokenAcceptedByS1: X1_S1.brokenAcceptedByS1 }, X1_S1, 'X1 outputs differ from S1 on inputs that keep the documented rule (or on format 2)');
  assert.ok(keptAccepted >= 1000 && broken >= 1000 && X1_S1.brokenAcceptedByS1 >= 500, J({ keptAccepted, broken, s1: X1_S1.brokenAcceptedByS1 }));
});
