// Tests for security-plan.mjs: catalog-driven control selection, the plan §3a machine block, and reassessment.
// Rule tests use a tiny synthetic catalog; fixture scoring and the CLI use the real skills/vapt catalog.
// Every assertion is on codes and shapes, never on message text. Subprocesses use process.execPath (no shell).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as SP from './security-plan.mjs';
import * as EVAL from '../../vapt/controls.mjs';
import { planNarrativeDigest } from './engine-dag.mjs'; // test-only parity check; the module itself imports no engine file
import { scoreSelector } from '../../vapt/fixtures/selector.mjs';

const SCRIPT = fileURLToPath(new URL('./security-plan.mjs', import.meta.url));
const VAPT = new URL('../../vapt/', import.meta.url);
const REAL_PATH = fileURLToPath(new URL('controls.json', VAPT));
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, VAPT), 'utf8'));
const scenarios = readJson('fixtures/scenarios.json');
const labels = readJson('fixtures/labels.json');
const ledger = readJson('fixtures/disagreements.json');
const manifest = readJson('fixtures/manifest.json');
const tmp = () => mkdtempSync(join(tmpdir(), 'secplan-'));
const unknownish = (v) => v === undefined || v === null || v === 'unknown';

// ---- synthetic catalog ----
const leaf = (fact, value, op = 'is') => ({ fact, op, value });
const B = (v) => leaf('boundaries', v, 'includes');
const ctl = (id, tier, applies_when) => ({ id, family: id.split('-')[1], title: id, tier, applies_when,
  verify: { type: 'runtime', pattern: 'p' }, env: 'request-harness' });
const SYN = {
  catalog_version: 1,
  fact_vocabulary: {
    boundaries: { type: 'enum', values: ['request-handler', 'rendering-sink', 'outbound-data'] },
    principals: { type: 'enum', values: ['anonymous', 'authenticated', 'staff', 'service'] },
    persistent_write: { type: 'bool', values: [true, false] },
    session_context: { type: 'bool', values: [true, false] },
    outbound_message: { type: 'bool', values: [true, false] },
  },
  controls: [
    ctl('VAPT-API-01', '[NN]', { any: [B('request-handler'), B('rendering-sink')] }),
    ctl('VAPT-WEB-01', '[NN]', { any: [B('rendering-sink')] }),
    ctl('VAPT-CFG-04', '[NN]', { all: [B('request-handler'), leaf('session_context', true)] }),
    ctl('VAPT-ABUSE-07', '[NN]', { any: [leaf('persistent_write', true)] }),
    ctl('VAPT-ABUSE-02', '[D]', { any: [leaf('outbound_message', true), B('outbound-data')] }),
    ctl('VAPT-WEB-02', '[NN]', { all: [B('rendering-sink'), B('outbound-data')] }), // spans two kinds: no single surface selects it
  ],
};
const writeCatalog = (obj, suffix = '') => { const p = join(tmp(), 'controls.json'); writeFileSync(p, JSON.stringify(obj, null, 2) + suffix); return p; };
const SYN_PATH = writeCatalog(SYN);
const safe = (f) => { try { return f(); } catch (e) { return { ok: false, code: 'threw', reasons: [String(e?.message ?? e)] }; } };
const syn = safe(() => SP.loadCatalog({ catalogPath: SYN_PATH }));
const real = safe(() => SP.loadCatalog({ catalogPath: REAL_PATH }));

const FALSE3 = { persistent_write: false, session_context: false, outbound_message: false };
const surf = (boundary_id, kind, path = `src/${boundary_id}.ts`) => ({ boundary_id, kind, path, principals: ['authenticated'] });
const cite = (facts, keys = ['persistent_write', 'session_context', 'outbound_message']) =>
  Object.fromEntries(keys.map((k) => [k, unknownish(facts[k]) ? 'unknown: not determined from the diff' : 'src/x.ts:handler']));
const input = (surfaces, facts = FALSE3, extra = {}) => ({ security_policy: 2, surfaces, facts, evidence: cite(facts), ...extra });
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify({ code: r.code, reasons: r.reasons })); return r; };
const refused = (r, code) => { assert.equal(r.ok, false, `expected ${code}, got ok`); assert.equal(r.code, code, JSON.stringify(r.reasons)); return r; };
const pairIds = (sel) => sel.pairs.map((p) => p.pair_id);
const planWith = (sel) => `# Plan\n\n## 3a\n\n${SP.renderSection3a(sel)}\n\n<!-- RUN-STATE:BEGIN -->\n{"event":"START"}\n<!-- RUN-STATE:END -->\n`;

const cli = (args, stdin) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin ?? '', encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* asserted by the caller */ }
  return { status: r.status, out, stderr: r.stderr };
};
const jsonFile = (obj) => { const p = join(tmp(), 'in.json'); writeFileSync(p, JSON.stringify(obj)); return p; };

// ---- real-catalog fixture helpers ----
const VOCAB = real.ok ? Object.keys(real.catalog.fact_vocabulary) : [];
const toSurfaces = (changed, facts) => {
  const out = new Map();
  for (const c of changed) for (const k of c.boundaries) out.set(`${c.path}#${k}`, { boundary_id: `${c.path}#${k}`, kind: k, path: c.path, principals: facts.principals ?? ['unknown'] });
  return [...out.values()];
};
const fixtureEvidence = (facts, id) => Object.fromEntries(VOCAB.filter((k) => k !== 'boundaries' && k !== 'principals')
  .map((k) => [k, unknownish(facts[k]) ? 'unknown: the scenario leaves it open' : `skills/vapt/fixtures/scenarios.json:${id}`]));
const fixtureInput = (facts, changed, id) => {
  const f = { ...facts }; delete f.principals;
  return { security_policy: 2, surfaces: toSurfaces(changed, facts), facts: f, evidence: fixtureEvidence(facts, id) };
};
const mine = (s) => ok(SP.selectControls(real, fixtureInput(s.facts, s.changed_surfaces, s.id))).controls.map((c) => c.control_id);

// =====================================================================================================
test('pairId / parsePairId round-trip, including route ids that contain colons', () => {
  for (const [b, c] of [['GET /a/:id', 'VAPT-API-01'], ['src/x.ts#request-handler', 'VAPT-ABUSE-07'], ['x:VAPT-API-01', 'VAPT-API-02']]) {
    const id = SP.pairId(b, c);
    assert.equal(id, `${b}:${c}`);
    assert.deepEqual(SP.parsePairId(id), { boundary_id: b, control_id: c });
  }
  assert.deepEqual(SP.parsePairId('GET /a/:id:VAPT-API-01'), { boundary_id: 'GET /a/:id', control_id: 'VAPT-API-01' });
  for (const bad of ['nocolon', 'a:VAPT-api-01', ':VAPT-API-01', 'a:VAPT-API-1', 'a:VAPT-API-01 ', 42, null]) assert.equal(SP.parsePairId(bad), null, String(bad));
  assert.throws(() => SP.pairId('a', 'API-01'), TypeError);
  assert.throws(() => SP.pairId('', 'VAPT-API-01'), TypeError);
});

test('loadCatalog: missing file and missing evaluator refuse catalog_missing; bad JSON or shape refuse catalog_invalid', () => {
  const miss = refused(SP.loadCatalog({ catalogPath: join(tmp(), 'nope.json') }), 'catalog_missing');
  assert.ok(!('catalog' in miss) && !('controls' in miss));
  refused(SP.loadCatalog({ catalogPath: SYN_PATH, evaluator: null }), 'catalog_missing');
  const badJson = join(tmp(), 'c.json'); writeFileSync(badJson, '{ not json');
  refused(SP.loadCatalog({ catalogPath: badJson }), 'catalog_invalid');
  refused(SP.loadCatalog({ catalogPath: writeCatalog({ ...SYN, controls: [] }) }), 'catalog_invalid');
  refused(SP.loadCatalog({ catalogPath: writeCatalog({ ...SYN, fact_vocabulary: undefined }) }), 'catalog_invalid');
  refused(SP.loadCatalog({ catalogPath: writeCatalog({ ...SYN, controls: [{ ...SYN.controls[0], id: 'API-01' }] }) }), 'catalog_invalid');
  const good = ok(SP.loadCatalog({ catalogPath: SYN_PATH }));
  assert.equal(good.digest, 'sha256:' + createHash('sha256').update(readFileSync(SYN_PATH)).digest('hex'));
  assert.equal(SP.catalogDigest(readFileSync(SYN_PATH)), good.digest);
  ok(real);
});

test('select pairs each surface with the controls its own kind selects', () => {
  const sel = ok(SP.selectControls(syn, input([surf('A', 'request-handler'), surf('B', 'rendering-sink')])));
  assert.deepEqual(pairIds(sel), ['A:VAPT-API-01', 'B:VAPT-API-01', 'B:VAPT-WEB-01']);
  assert.ok(sel.pairs.every((p) => p.paired_by === 'surface'));
  assert.deepEqual(sel.controls.map((c) => c.control_id), ['VAPT-API-01', 'VAPT-WEB-01']);
  assert.deepEqual(sel.controls.find((c) => c.control_id === 'VAPT-WEB-01').boundary_ids, ['B']);
  const ex = sel.excluded.map((e) => e.control_id).sort();
  assert.deepEqual(ex, ['VAPT-ABUSE-02', 'VAPT-ABUSE-07', 'VAPT-CFG-04', 'VAPT-WEB-02']);
  assert.ok(sel.excluded.every((e) => typeof e.why === 'string' && e.why.length > 0));
  // CFG-04 both directions: session_context true pairs it with the handler only
  const s2 = ok(SP.selectControls(syn, input([surf('A', 'request-handler'), surf('B', 'rendering-sink')], { ...FALSE3, session_context: true })));
  assert.ok(pairIds(s2).includes('A:VAPT-CFG-04') && !pairIds(s2).includes('B:VAPT-CFG-04'));
});

test('a control selected at change level but by no single surface pairs with EVERY surface (paired_by change)', () => {
  const two = [surf('B', 'rendering-sink'), surf('C', 'outbound-data'), surf('A', 'request-handler')];
  const on = ok(SP.selectControls(syn, input(two)));
  const w = on.pairs.filter((p) => p.control_id === 'VAPT-WEB-02');
  assert.deepEqual(w.map((p) => p.boundary_id), ['A', 'B', 'C'], 'every surface, including the one whose kind is not in the predicate');
  assert.ok(w.every((p) => p.paired_by === 'change'));
  const one = ok(SP.selectControls(syn, input([surf('B', 'rendering-sink'), surf('A', 'request-handler')])));
  assert.ok(!one.pairs.some((p) => p.control_id === 'VAPT-WEB-02'));
  // a fact-gated control is selected by every single surface, so it pairs with each of them per surface
  const pw = ok(SP.selectControls(syn, input([surf('A', 'request-handler'), surf('B', 'rendering-sink')], { ...FALSE3, persistent_write: true })));
  const ab = pw.pairs.filter((p) => p.control_id === 'VAPT-ABUSE-07');
  assert.deepEqual(ab.map((p) => p.boundary_id), ['A', 'B']);
  assert.ok(ab.every((p) => p.paired_by === 'surface'));
  assert.ok(!ok(SP.selectControls(syn, input([surf('A', 'request-handler'), surf('B', 'rendering-sink')]))).pairs.some((p) => p.control_id === 'VAPT-ABUSE-07'));
});

test('an unknown fact keeps its controls selected and is listed', () => {
  const r = ok(SP.selectControls(syn, input([surf('A', 'request-handler')], { ...FALSE3, persistent_write: 'unknown' })));
  assert.ok(pairIds(r).includes('A:VAPT-ABUSE-07'));
  assert.deepEqual(r.unknown_facts, ['persistent_write']);
  const absent = { session_context: false, outbound_message: false };
  const r2 = ok(SP.selectControls(syn, { security_policy: 2, surfaces: [surf('A', 'request-handler')], facts: absent, evidence: cite(absent) }));
  assert.ok(pairIds(r2).includes('A:VAPT-ABUSE-07'), 'an absent fact is unknown');
  assert.deepEqual(r2.unknown_facts, ['persistent_write']);
});

test('a surface of kind unknown selects every control some boundary kind selects, plus multi-kind predicates (real catalog: 24 of the 25 controls, all but VAPT-ABUSE-03); a concrete kind does not', () => {
  const u = ok(SP.selectControls(syn, input([surf('U', 'unknown')])));
  const kinds = SYN.fact_vocabulary.boundaries.values;
  for (const k of kinds) {
    const one = ok(SP.selectControls(syn, input([surf('K', k)])));
    for (const p of one.pairs) assert.ok(pairIds(u).includes(`U:${p.control_id}`), `${k}: ${p.control_id}`);
  }
  assert.deepEqual(pairIds(u), ['U:VAPT-ABUSE-02', 'U:VAPT-API-01', 'U:VAPT-WEB-01', 'U:VAPT-WEB-02']);
  assert.ok(!pairIds(ok(SP.selectControls(syn, input([surf('R', 'rendering-sink')])))).includes('R:VAPT-ABUSE-02'));
  // The real catalog, every bool fact false: kind unknown selects exactly what all boundary kinds together select.
  const bools = Object.entries(real.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
  const neg = Object.fromEntries(bools.map((k) => [k, false]));
  const one = (kind) => ok(SP.selectControls(real, { security_policy: 2, surfaces: [{ boundary_id: 'U', kind, path: 'src/u.ts', principals: ['service'] }],
    facts: neg, evidence: Object.fromEntries(bools.map((k) => [k, 'src/u.ts:1'])) })).controls.map((c) => c.control_id);
  const unk = one('unknown');
  assert.deepEqual(unk, [...new Set(real.catalog.fact_vocabulary.boundaries.values.flatMap(one))].sort());
  assert.equal(real.catalog.controls.length, 25);
  assert.equal(unk.length, 24);
  assert.deepEqual(real.catalog.controls.map((c) => c.id).filter((c) => !unk.includes(c)), ['VAPT-ABUSE-03']);
});

test('facts.boundaries / principals are derived from surfaces; a disagreeing value is refused', () => {
  const s = [surf('A', 'request-handler'), surf('B', 'rendering-sink')];
  ok(SP.selectControls(syn, input(s, { ...FALSE3, boundaries: ['rendering-sink', 'request-handler'] })));
  refused(SP.selectControls(syn, input(s, { ...FALSE3, boundaries: ['request-handler'] })), 'surface_facts_mismatch');
  refused(SP.selectControls(syn, input(s, { ...FALSE3, principals: ['anonymous'] })), 'surface_facts_mismatch');
  ok(SP.selectControls(syn, input(s, { ...FALSE3, principals: ['authenticated'] })));
});

test('citations: a known fact needs a path, an unknown fact needs "unknown: why"', () => {
  const s = [surf('A', 'request-handler')];
  const base = input(s);
  ok(SP.selectControls(syn, base));
  refused(SP.selectControls(syn, { ...base, evidence: { ...base.evidence, persistent_write: undefined } }), 'fact_uncited');
  refused(SP.selectControls(syn, { ...base, evidence: { ...base.evidence, persistent_write: '' } }), 'fact_uncited');
  refused(SP.selectControls(syn, { ...base, evidence: { ...base.evidence, persistent_write: 'unknown: not looked' } }), 'fact_uncited');
  const unk = input(s, { ...FALSE3, persistent_write: 'unknown' });
  ok(SP.selectControls(syn, unk));
  refused(SP.selectControls(syn, { ...unk, evidence: { ...unk.evidence, persistent_write: undefined } }), 'fact_uncited');
  refused(SP.selectControls(syn, { ...unk, evidence: { ...unk.evidence, persistent_write: 'unknown:' } }), 'fact_uncited');
  refused(SP.selectControls(syn, { ...unk, evidence: { ...unk.evidence, persistent_write: 'src/x.ts:save' } }), 'fact_uncited', 'an unknown value with a path citation');
});

test('out-of-vocabulary facts and kinds refuse fact_out_of_vocabulary; malformed input refuses bad_input', () => {
  const s = [surf('A', 'request-handler')];
  refused(SP.selectControls(syn, input(s, { ...FALSE3, persistent_write: 'yes' })), 'fact_out_of_vocabulary');
  refused(SP.selectControls(syn, input(s, { ...FALSE3, persistant_write: true })), 'fact_out_of_vocabulary');
  refused(SP.selectControls(syn, input([surf('A', 'request_handler')])), 'fact_out_of_vocabulary');
  refused(SP.selectControls(syn, input([{ ...surf('A', 'request-handler'), principals: ['admin'] }])), 'fact_out_of_vocabulary');
  refused(SP.selectControls(syn, { ...input(s), evidence: { ...input(s).evidence, persistant_write: 'x.ts' } }), 'fact_out_of_vocabulary');
  refused(SP.selectControls(syn, { ...input(s), security_policy: 1 }), 'bad_input');
  refused(SP.selectControls(syn, input([surf('A', 'request-handler'), surf('A', 'rendering-sink')])), 'bad_input');
  refused(SP.selectControls(syn, input([{ boundary_id: 'A', kind: 'request-handler', principals: ['service'] }])), 'bad_input');
  refused(SP.selectControls(syn, { ...input(s), extra: 1 }), 'bad_input');
  refused(SP.selectControls(syn, null), 'bad_input');
});

test('a selected control with no surface to pair with is refused; an evidenced empty assessment is valid', () => {
  refused(SP.selectControls(syn, input([], { ...FALSE3, persistent_write: true })), 'control_unpaired');
  const empty = ok(SP.selectControls(syn, input([])));
  assert.deepEqual(empty.controls, []);
  assert.deepEqual(empty.pairs, []);
  assert.match(empty.rows_md, /security-plan:/);
});

test('selection_digest ignores paths, summary and citation text; flipping one fact changes it', () => {
  const a = ok(SP.selectControls(syn, input([surf('A', 'request-handler', 'src/a.ts')], FALSE3, { summary: 'first wording' })));
  const bIn = input([surf('A', 'request-handler', 'lib/elsewhere.ts')], FALSE3, { summary: 'other wording' });
  bIn.evidence.persistent_write = 'lib/elsewhere.ts:save';
  const b = ok(SP.selectControls(syn, bIn));
  assert.equal(a.selection_digest, b.selection_digest);
  assert.equal(a.facts_digest, b.facts_digest);
  assert.match(a.selection_digest, /^sha256:[0-9a-f]{64}$/);
  const flipped = ok(SP.selectControls(syn, input([surf('A', 'request-handler', 'src/a.ts')], { ...FALSE3, session_context: true })));
  assert.notEqual(flipped.selection_digest, a.selection_digest);
  assert.notEqual(flipped.facts_digest, a.facts_digest);
  // a flip that selects nothing new still changes the facts digest and the selection digest
  const quiet = ok(SP.selectControls(syn, input([surf('A', 'request-handler', 'src/a.ts')], { ...FALSE3, persistent_write: false, outbound_message: 'unknown' })));
  assert.notEqual(quiet.selection_digest, a.selection_digest);
});

test('selection shape and config fragment', () => {
  const sel = ok(SP.selectControls(syn, input([surf('A', 'request-handler'), surf('B', 'rendering-sink')], { ...FALSE3, persistent_write: true })));
  for (const k of ['tool', 'v', 'security_policy', 'catalog_version', 'catalog_digest', 'facts_digest', 'selection_digest', 'controls', 'pairs', 'excluded', 'unknown_facts', 'config_fragment', 'rows_md']) assert.ok(k in sel, k);
  assert.equal(sel.tool, 'security-plan'); assert.equal(sel.v, 1); assert.equal(sel.security_policy, 2);
  assert.equal(sel.catalog_digest, syn.digest);
  const c = sel.controls[0];
  for (const k of ['control_id', 'tier', 'verify_type', 'env', 'why', 'boundary_ids']) assert.ok(k in c, k);
  for (const k of ['pair_id', 'boundary_id', 'kind', 'control_id', 'tier']) assert.ok(k in sel.pairs[0], k);
  const f = sel.config_fragment;
  assert.equal(f.securityPolicy, 2);
  assert.equal(f.catalogDigest, syn.digest);
  assert.deepEqual(f.securityControls, ['VAPT-ABUSE-07', 'VAPT-API-01', 'VAPT-WEB-01']);
  assert.deepEqual(f.controlCoverage.map((x) => `${x.boundary}:${x.control}`), pairIds(sel));
  assert.ok(f.controlCoverage.every((x) => x.node === null && Array.isArray(x.specs) && x.specs.length === 0));
  assert.deepEqual(pairIds(sel), [...pairIds(sel)].sort(), 'pairs sorted by pair id');
});

test('pairsLine is canonical: order-independent, changes when a pair or the catalog digest changes', () => {
  const d = 'sha256:' + 'a'.repeat(64);
  const l1 = SP.pairsLine({ catalogDigest: d, pairs: ['B:VAPT-API-01', 'A:VAPT-API-01'] });
  assert.match(l1, /^security-pairs sha256:[0-9a-f]{64}$/);
  assert.equal(l1, SP.pairsLine({ catalogDigest: d, pairs: ['A:VAPT-API-01', 'B:VAPT-API-01'] }));
  const hex = createHash('sha256').update(JSON.stringify({ catalog_digest: d, pairs: ['A:VAPT-API-01', 'B:VAPT-API-01'], policy: 2 })).digest('hex');
  assert.equal(l1, `security-pairs sha256:${hex}`, 'canonical JSON: sorted keys, sorted pairs, no whitespace');
  assert.notEqual(l1, SP.pairsLine({ catalogDigest: d, pairs: ['A:VAPT-API-01'] }));
  assert.notEqual(l1, SP.pairsLine({ catalogDigest: 'sha256:' + 'b'.repeat(64), pairs: ['A:VAPT-API-01', 'B:VAPT-API-01'] }));
  assert.equal(l1, SP.pairsLine({ catalogDigest: d, pairs: [{ pair_id: 'A:VAPT-API-01' }, { pair_id: 'B:VAPT-API-01' }] }));
  assert.throws(() => SP.pairsLine({ catalogDigest: d, pairs: ['bad'] }), TypeError);
});

test('renderSection3a -> parsePlanSecurityBlock round-trip; tampered, missing or duplicated blocks parse to null', () => {
  const sel = ok(SP.selectControls(syn, input([surf('GET /a/:id', 'request-handler', 'src/a.ts'), surf('B', 'rendering-sink')], { ...FALSE3, persistent_write: true })));
  const md = SP.renderSection3a(sel);
  assert.equal(md, sel.rows_md);
  // The non-empty form is pinned byte for byte (the compact empty form must not change it).
  assert.equal(sel.catalog_digest, 'sha256:a7c05119844180f0ba7c2882a07692a8cf23db6c69ff914e2f59d18395e40bd0', 'the synthetic catalog bytes the pin was taken on');
  assert.equal(createHash('sha256').update(md).digest('hex'), 'c71a360d25416ec553f958bdc61c2579973fa99ba99887d2cf560ea973033af6');
  assert.ok(md.includes(SP.pairsLine({ catalogDigest: sel.catalog_digest, pairs: pairIds(sel) })));
  const blk = SP.parsePlanSecurityBlock(planWith(sel));
  assert.equal(blk.policy, 2);
  assert.equal(blk.catalog_digest, sel.catalog_digest);
  assert.equal(blk.selection_digest, sel.selection_digest);
  assert.deepEqual(blk.pairs, pairIds(sel));
  assert.deepEqual(blk.controls, sel.controls.map((c) => c.control_id));
  assert.equal(blk.facts.persistent_write, true);
  assert.deepEqual(blk.surfaces.map((s) => s.path), ['src/B.ts', 'src/a.ts'], 'sorted by boundary_id, code-unit order');
  assert.equal(SP.parsePlanSecurityBlock('# plan without a block'), null);
  assert.equal(SP.parsePlanSecurityBlock(planWith(sel) + '\n' + md), null, 'two blocks are ambiguous');
  const line = md.split('\n').find((l) => l.startsWith('<!-- security-plan: '));
  const tampered = planWith(sel).replace(line, line.replace('"B:VAPT-API-01",', ''));
  assert.notEqual(tampered, planWith(sel));
  assert.equal(SP.parsePlanSecurityBlock(tampered), null, 'pairs edited without the digest');
  const wrongLine = planWith(sel).replace(/security-pairs sha256:[0-9a-f]{64}/, 'security-pairs sha256:' + '0'.repeat(64));
  assert.equal(SP.parsePlanSecurityBlock(wrongLine), null, 'narrative pairs line disagrees with the block');
  assert.equal(SP.parsePlanSecurityBlock(planWith(sel).replace(line, '<!-- security-plan: {not json} -->')), null);
  const withEvents = planWith(sel).replace('{"event":"START"}', `{"event":"START"}\n{"event":"X","note":"security-pairs sha256:${'0'.repeat(64)}"}\n${line}`);
  assert.deepEqual(SP.parsePlanSecurityBlock(withEvents)?.pairs, pairIds(sel), 'RUN-STATE events cannot add or break a block or pairs line');
});

test('an empty selection renders the compact form: one evidence line, the pairs line and the machine block, nothing else; it round-trips', () => {
  const empty = ok(SP.selectControls(syn, input([], { ...FALSE3, session_context: 'unknown' })));
  assert.deepEqual(empty.pairs, []);
  const lines = empty.rows_md.split('\n');
  assert.equal(lines.length, 3, empty.rows_md);
  assert.match(lines[0], /^No security-relevant surface: \S/);
  assert.ok(lines[0].includes(empty.catalog_digest) && lines[0].includes(empty.selection_digest) && lines[0].includes('session_context'), 'the evidence names the catalog, the selection and the unknown facts');
  assert.equal(lines[1], SP.pairsLine({ catalogDigest: empty.catalog_digest, pairs: [] }));
  assert.match(lines[2], /^<!-- security-plan: \{.*\} -->$/);
  assert.equal(SP.renderSection3a(empty), empty.rows_md);
  const blk = SP.parsePlanSecurityBlock(planWith(empty));
  assert.ok(blk, 'the compact form parses');
  assert.deepEqual([blk.pairs, blk.controls, blk.surfaces], [[], [], []]);
  assert.equal(blk.selection_digest, empty.selection_digest);
  assert.equal(blk.facts.session_context, 'unknown');
  // Reassess accepts a compact-form plan: a no-signal change with no surface stays UNCHANGED.
  const r = ok(SP.reassess({ plan: planWith(empty), catalog: syn, inventory: [], changed: { contract_paths: ['docs/**'], files: [{ path: 'docs/a.md' }] } }));
  assert.equal(r.outcome, 'UNCHANGED');
});

test('effectiveSet is an add-only union of approved pairs and addenda', () => {
  const blk = { pairs: ['A:VAPT-API-01', 'B:VAPT-WEB-01'] };
  assert.deepEqual(SP.effectiveSet(blk, []), ['A:VAPT-API-01', 'B:VAPT-WEB-01']);
  assert.deepEqual(SP.effectiveSet(blk, [{ pairs: ['C:VAPT-API-01', 'A:VAPT-API-01'] }, { pairs: [] }]), ['A:VAPT-API-01', 'B:VAPT-WEB-01', 'C:VAPT-API-01']);
  assert.throws(() => SP.effectiveSet(blk, [{ pairs: ['garbage'] }]), TypeError);
  assert.throws(() => SP.effectiveSet(blk, [{}]), TypeError);
});

test('reassessSignals: mechanical path and added-line patterns; a benign path gives none', () => {
  const sig = (files) => SP.reassessSignals({ paths: files, approvedPairs: [], approvedSurfaces: [], catalog: real.catalog });
  const kinds = (files) => [...new Set(sig(files).map((s) => s.kind))].sort();
  assert.deepEqual(kinds(['package.json']), ['new-dependency']);
  assert.deepEqual(kinds(['pnpm-lock.yaml']), ['new-dependency']);
  assert.deepEqual(kinds(['supabase/migrations/001_init.sql']), ['migration-or-rls-change']);
  assert.deepEqual(kinds(['.github/workflows/ci.yml']), ['infra-or-ci-config']);
  assert.deepEqual(kinds(['.env.example']), ['env-or-secret-reference']);
  assert.deepEqual(kinds([{ path: 'src/lib/a.ts', added: ['const k = process.env.API_KEY;'] }]), ['env-or-secret-reference']);
  assert.deepEqual(kinds([{ path: 'src/lib/a.ts', added: ['await transporter.sendMail(msg);'] }]), ['mail-or-notification-send']);
  assert.deepEqual(kinds([{ path: 'src/lib/a.ts', added: ['await stripe.refunds.create({ charge });'] }]), ['payment-or-stock-or-wallet-call']);
  assert.deepEqual(kinds([{ path: 'src/lib/a.ts', added: ["alter table orders enable row level security;"] }]), ['migration-or-rls-change']);
  assert.deepEqual(kinds([{ path: 'src/lib/a.ts', added: ["router.post('/x', h);"] }]), ['new-route']);
  assert.deepEqual(kinds(['src/middleware/auth.ts']), ['auth-or-middleware-change']);
  assert.deepEqual(kinds([{ path: 'src/lib/format-date.ts', added: ['return d.toISOString();'] }]), []);
  const s = sig([{ path: 'src/lib/a.ts', added: ['sendMail(x)'] }])[0];
  assert.deepEqual(Object.keys(s).sort(), ['class', 'id', 'kind', 'path']);
  assert.equal(s.class, null);
});

test('reassessSignals: a signal is mechanically covered only when the approved surface at that path carries its control class', () => {
  const surfaces = [{ boundary_id: 'mail', kind: 'outbound-data', path: 'src/mailer.ts', principals: ['service'] }];
  const files = [{ path: 'src/mailer.ts', added: ['await sendMail(m)'] }];
  const covered = SP.reassessSignals({ paths: files, approvedPairs: ['mail:VAPT-ABUSE-02', 'mail:VAPT-ABUSE-03'], approvedSurfaces: surfaces, catalog: real.catalog });
  assert.ok(covered.length === 1 && covered[0].class !== null);
  const partial = SP.reassessSignals({ paths: files, approvedPairs: ['mail:VAPT-ABUSE-02'], approvedSurfaces: surfaces, catalog: real.catalog });
  assert.equal(partial[0].class, null);
  const elsewhere = SP.reassessSignals({ paths: [{ path: 'src/other.ts', added: ['sendMail(m)'] }], approvedPairs: ['mail:VAPT-ABUSE-02', 'mail:VAPT-ABUSE-03'], approvedSurfaces: surfaces, catalog: real.catalog });
  assert.equal(elsewhere[0].class, null);
  const dep = SP.reassessSignals({ paths: ['package.json'], approvedPairs: [], approvedSurfaces: [{ boundary_id: 'p', kind: 'security-config', path: 'package.json', principals: ['service'] }], catalog: real.catalog });
  assert.equal(dep[0].class, null, 'a dependency change is never mechanically covered');
});

// ---- reassess, synthetic catalog ----
const approvedSyn = (facts = FALSE3, surfaces = [surf('A', 'request-handler', 'src/a.ts')]) => ok(SP.selectControls(syn, input(surfaces, facts)));
const rea = (sel, over = {}) => SP.reassess({ plan: planWith(sel), catalog: syn,
  inventory: { candidate_id: 'cand-1', surfaces: [surf('A', 'request-handler', 'src/a.ts')] },
  changed: { contract_paths: ['src/a.ts', 'web/**', 'package.json'], files: [{ path: 'src/a.ts', added: ['const x = 1;'] }] },
  classifications: [], addenda: [], ...over });

test('reassess: a no-signal change is UNCHANGED with signals []', () => {
  const r = ok(rea(approvedSyn()));
  assert.equal(r.outcome, 'UNCHANGED');
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.delta_pairs, []);
  for (const k of ['outcome', 'signals', 'classifications_used', 'delta_pairs', 'candidate_id', 'approved_plan_digest', 'catalog_digest', 'effective_addendum_digest']) assert.ok(k in r, k);
  assert.equal(r.candidate_id, 'cand-1');
  assert.equal(r.approved_plan_digest, planNarrativeDigest(planWith(approvedSyn())));
});

test('reassess: a new in-contract surface is ADD_CONTROLS with an addendum; that addendum makes it UNCHANGED (add-only across resume)', () => {
  const sel = approvedSyn();
  const inventory = { candidate_id: 'cand-2', surfaces: [surf('A', 'request-handler', 'src/a.ts'), surf('B', 'rendering-sink', 'web/b.ts')] };
  const changed = { contract_paths: ['src/a.ts', 'web/**'], files: [{ path: 'web/b.ts', added: ['render(view)'] }] };
  const r = ok(rea(sel, { inventory, changed }));
  assert.equal(r.outcome, 'ADD_CONTROLS');
  assert.deepEqual(r.delta_pairs, ['B:VAPT-API-01', 'B:VAPT-WEB-01']);
  const a = r.addendum;
  assert.deepEqual(a.pairs, r.delta_pairs);
  assert.deepEqual(a.controls, ['VAPT-API-01', 'VAPT-WEB-01']);
  assert.equal(a.catalog_digest, syn.digest);
  assert.equal(a.candidate_id, 'cand-2');
  assert.match(a.basis_signals_digest, /^sha256:[0-9a-f]{64}$/);
  const again = ok(rea(sel, { inventory, changed, addenda: [a] }));
  assert.equal(again.outcome, 'UNCHANGED');
  assert.notEqual(again.effective_addendum_digest, r.effective_addendum_digest);
});

test('reassess: an out-of-contract path forces REAPPROVAL; the same path inside the contract does not', () => {
  const sel = approvedSyn();
  const files = [{ path: 'src/a.ts' }, { path: 'src/other.ts' }];
  const r = ok(rea(sel, { changed: { contract_paths: ['src/a.ts'], files } }));
  assert.equal(r.outcome, 'REAPPROVAL');
  assert.deepEqual(r.reapproval_basis, [{ kind: 'out-of-plan-path', path: 'src/other.ts' }]);
  assert.ok(r.signals.some((s) => s.kind === 'out-of-plan-path' && s.path === 'src/other.ts'));
  assert.equal(ok(rea(sel, { changed: { contract_paths: ['src/*.ts'], files } })).outcome, 'UNCHANGED');
  assert.equal(ok(rea(sel, { changed: { contract_paths: ['src/*.ts'], files: [{ path: 'src/x/a.ts' }] } })).outcome, 'REAPPROVAL', '* stays in one segment');
  const inv = { surfaces: [surf('A', 'request-handler', 'src/a.ts'), surf('Z', 'rendering-sink', 'lib/z.ts')] };
  assert.equal(ok(rea(sel, { inventory: inv })).outcome, 'REAPPROVAL', 'an inventory surface outside the contract');
});

test('reassess: a catalog digest change forces REAPPROVAL', () => {
  const sel = approvedSyn();
  const other = ok(SP.loadCatalog({ catalogPath: writeCatalog(SYN, '\n') }));
  assert.notEqual(other.digest, syn.digest);
  const r = ok(rea(sel, { catalog: other }));
  assert.equal(r.outcome, 'REAPPROVAL');
  assert.deepEqual(r.reapproval_basis, [{ kind: 'catalog_digest_changed' }]);
  assert.equal(r.catalog_digest, other.digest);
});

test('reassess: an unclassified, uncovered signal refuses classification_missing; a classification resolves it', () => {
  const sel = approvedSyn();
  const changed = { contract_paths: ['src/a.ts', 'package.json'], files: [{ path: 'package.json' }] };
  const r = refused(rea(sel, { changed }), 'classification_missing');
  assert.deepEqual(r.unclassified, ['new-dependency@package.json']);
  const done = ok(rea(sel, { changed, classifications: [{ signal_id: 'new-dependency@package.json', reason: 'patch bump of a date library' }] }));
  assert.equal(done.outcome, 'UNCHANGED');
  assert.deepEqual(done.classifications_used, ['new-dependency@package.json']);
  refused(rea(sel, { changed, classifications: [{ signal_id: 'new-dependency@package.json' }] }), 'bad_input');
  refused(rea(sel, { changed, classifications: [{ signal_id: 'new-dependency@package.json', facts: { persistent_write: true } }] }), 'fact_uncited');
  refused(rea(sel, { changed, classifications: [{ signal_id: 'new-dependency@package.json', facts: { persistent_write: 'maybe' }, evidence: { persistent_write: 'x.ts' } }] }), 'fact_out_of_vocabulary');
});

test('reassess: a classification setting a fact false never removes an approved pair; setting it true adds pairs', () => {
  const approved = approvedSyn({ ...FALSE3, persistent_write: true });
  assert.ok(pairIds(approved).includes('A:VAPT-ABUSE-07'));
  const changed = { contract_paths: ['src/a.ts'], files: [{ path: 'src/a.ts', added: ['await stripe.charges.create(c)'] }] };
  const id = 'payment-or-stock-or-wallet-call@src/a.ts';
  const off = ok(rea(approved, { changed, classifications: [{ signal_id: id, facts: { persistent_write: false }, evidence: { persistent_write: 'src/a.ts:charge' } }] }));
  assert.equal(off.outcome, 'UNCHANGED');
  assert.deepEqual(off.delta_pairs, []);
  assert.equal(off.merged_facts.persistent_write, true);
  assert.ok(SP.effectiveSet(SP.parsePlanSecurityBlock(planWith(approved)), []).includes('A:VAPT-ABUSE-07'));
  const base = approvedSyn();
  const on = ok(rea(base, { changed, classifications: [{ signal_id: id, facts: { persistent_write: true }, evidence: { persistent_write: 'src/a.ts:charge' } }] }));
  assert.equal(on.outcome, 'ADD_CONTROLS');
  assert.deepEqual(on.delta_pairs, ['A:VAPT-ABUSE-07']);
  const unk = ok(rea(base, { changed, classifications: [{ signal_id: id, facts: { persistent_write: 'unknown' }, evidence: { persistent_write: 'unknown: provider writes not traced' } }] }));
  assert.deepEqual(unk.delta_pairs, ['A:VAPT-ABUSE-07'], 'unknown beats false');
});

test('reassess: a surface-introducing signal off every approved surface is never dismissed by a classification (a reason or a cited fact); an inventory surface at its path makes it ADD_CONTROLS', () => {
  const bools = Object.entries(real.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
  const facts = Object.fromEntries(bools.map((k) => [k, false]));
  const approved = ok(SP.selectControls(real, { security_policy: 2, facts, evidence: Object.fromEntries(bools.map((k) => [k, 'src/orders.ts:handler'])),
    surfaces: [{ boundary_id: 'orders-api', kind: 'server-input', path: 'src/orders.ts', principals: ['service'] },
      { boundary_id: 'login', kind: 'server-input', path: 'src/auth/login.ts', principals: ['service'] }] }));
  const NEW = { boundary_id: 'admin-api', kind: 'server-input', path: 'src/routes/admin.ts', principals: ['service'] };
  const run = (files, { surfaces = [], classifications = [], addenda = [] } = {}) => SP.reassess({ plan: planWith(approved), catalog: real,
    inventory: { candidate_id: 'cand-r', surfaces: [...approved.surfaces, ...surfaces] }, changed: { contract_paths: ['src/**', 'package.json'], files }, classifications, addenda });
  const cases = [
    ['new-route', { path: 'src/routes/admin.ts', added: ["app.get('/admin', h)"] }],
    ['auth-or-middleware-change', { path: 'src/middleware/admin.ts', added: [] }],
    ['migration-or-rls-change', { path: 'src/migrations/001_admin.sql', added: ['create policy p on t'] }],
  ];
  for (const [kind, file] of cases) {
    const sig = `${kind}@${file.path}`;
    assert.deepEqual(refused(run([file]), 'classification_missing').unclassified, [sig], kind);
    const reasonOnly = refused(run([file], { classifications: [{ signal_id: sig, reason: 'internal only, no new boundary' }] }), 'classification_missing');
    assert.deepEqual(reasonOnly.unclassified, [sig], `${kind}: a reason alone does not dismiss it`);
    const withFacts = refused(run([file], { classifications: [{ signal_id: sig, facts: { [bools[0]]: false }, evidence: { [bools[0]]: `${file.path}:1` } }] }), 'classification_missing');
    assert.deepEqual(withFacts.unclassified, [sig], `${kind}: a cited fact does not dismiss it either (facts never add a boundary)`);
  }
  // A surface at the new route's path closes the signal and selects its pairs: ADD_CONTROLS with a suggested addendum.
  const route = cases[0][1];
  const add = ok(run([route], { surfaces: [NEW] }));
  assert.equal(add.outcome, 'ADD_CONTROLS');
  assert.equal(add.signals.find((s) => s.id === 'new-route@src/routes/admin.ts').class, 'inventory-surface');
  for (const c of ['VAPT-API-01', 'VAPT-API-02', 'VAPT-API-03']) assert.ok(add.delta_pairs.includes(`admin-api:${c}`), c);
  assert.deepEqual(add.addendum.pairs, add.delta_pairs);
  const covered = ok(run([route], { surfaces: [NEW], addenda: [add.addendum] }));
  assert.equal(covered.outcome, 'UNCHANGED', 'the covering addendum');
  assert.equal(covered.signals.find((s) => s.id === 'new-route@src/routes/admin.ts').class, 'approved-pairs');
  refused(run([route], { addenda: [add.addendum] }), 'classification_missing'); // the surface is not stored: without it the signal reopens
  // A reason alone still classifies a signal on an approved surface's path (S-SEA-20/21-style coverage unchanged).
  const onApproved = ok(run([{ path: 'src/auth/login.ts', added: [] }], { classifications: [{ signal_id: 'auth-or-middleware-change@src/auth/login.ts', reason: 'comment only' }] }));
  assert.equal(onApproved.outcome, 'UNCHANGED');
  // A reason alone still classifies a signal that introduces no surface (a dependency bump).
  assert.equal(ok(run([{ path: 'package.json' }], { classifications: [{ signal_id: 'new-dependency@package.json', reason: 'patch bump' }] })).outcome, 'UNCHANGED');
  // An inventory surface outside the contract is REAPPROVAL, never ADD_CONTROLS.
  assert.equal(ok(run([route], { surfaces: [{ ...NEW, path: 'lib/admin.ts' }] })).outcome, 'REAPPROVAL');
});

// ---- the surface rule, both directions, over the real catalog ----
const REAL_BOOLS = real.ok ? Object.entries(real.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k) : [];
const svc = (boundary_id, kind, path) => ({ boundary_id, kind, path, principals: ['service'] });
const APPROVED_REAL = [svc('orders-api', 'server-input', 'src/orders.ts'), svc('login', 'server-input', 'src/auth/login.ts')];
/** A plan approved over the real catalog with every bool fact false; returns reassess over it (inventory: its surfaces plus `surfaces`). */
const realPlan = (surfaces = APPROVED_REAL) => {
  const approved = ok(SP.selectControls(real, { security_policy: 2, surfaces, facts: Object.fromEntries(REAL_BOOLS.map((k) => [k, false])),
    evidence: Object.fromEntries(REAL_BOOLS.map((k) => [k, 'src/orders.ts:handler'])) }));
  return (files, { surfaces: extra = [], classifications = [] } = {}) => SP.reassess({ plan: planWith(approved), catalog: real,
    inventory: { candidate_id: 'cand-s', surfaces: [...approved.surfaces, ...extra] }, changed: { contract_paths: ['src/**'], files }, classifications, addenda: [] });
};
/**
 * [signal kind, changed file, the signal's control class, a boundary kind that selects that whole class with every
 * fact false, the signal's class when a server-input surface at its path is approved (null: it needs a classification)].
 */
const SURFACE_ROWS = [
  ['new-route', { path: 'src/routes/admin.ts', added: ["app.get('/admin', h)"] }, ['VAPT-API-01', 'VAPT-API-02', 'VAPT-API-03'], 'server-input', 'approved-pairs'],
  ['auth-or-middleware-change', { path: 'src/middleware/admin.ts', added: [] }, ['VAPT-API-02', 'VAPT-API-03', 'VAPT-CFG-04', 'VAPT-ABUSE-08'], 'auth-lifecycle', null],
  ['migration-or-rls-change', { path: 'src/migrations/001_admin.sql', added: ['create policy p on t'] }, ['VAPT-API-01', 'VAPT-ABUSE-07'], 'business-invariant', null],
];
/** [label, the classification's fields (one fact each), the outcome where it is accepted (on an approved surface's path)]. */
const CLASSIFICATION_SHAPES = (path) => [
  ['a no-op fact', { facts: { persistent_write: false }, evidence: { persistent_write: `${path}:1` } }, 'UNCHANGED'],
  ['a fact raised to true', { facts: { persistent_write: true }, evidence: { persistent_write: `${path}:1` } }, 'ADD_CONTROLS'],
  ['a fact raised to unknown', { facts: { session_context: 'unknown' }, evidence: { session_context: 'unknown: the session use is not traced' } }, 'ADD_CONTROLS'],
  ['a reason with a fact', { reason: 'internal only, no new boundary', facts: { persistent_write: false }, evidence: { persistent_write: `${path}:1` } }, 'UNCHANGED'],
];

test('reassess: no classification of any shape closes a new-route, auth-or-middleware-change or migration-or-rls-change signal off every approved surface; a surface at its path does; the same classification is accepted on an approved surface path', () => {
  assert.deepEqual(SURFACE_ROWS.map(([kind]) => kind).sort(), [...SP.SURFACE_SIGNALS].sort(), 'one row per surface-introducing kind');
  const run = realPlan();
  for (const [kind, file, cls, closingKind, classOnApproved] of SURFACE_ROWS) {
    const sig = `${kind}@${file.path}`;
    const onApproved = realPlan([...APPROVED_REAL, svc('at-path', 'server-input', file.path)]);
    for (const [label, fields, acceptedOutcome] of CLASSIFICATION_SHAPES(file.path)) {
      const why = `${kind}, ${label}`;
      const classifications = [{ signal_id: sig, ...fields }];
      const [[fact, value]] = Object.entries(fields.facts);
      // Off every approved surface: refused, whatever the classification carries.
      assert.deepEqual(refused(run([file], { classifications }), 'classification_missing').unclassified, [sig], why);
      // Twin, one field (the inventory gains a surface at that path): the surface closes it and its pairs are the delta.
      const closed = ok(run([file], { classifications, surfaces: [svc('new-boundary', closingKind, file.path)] }));
      assert.equal(closed.outcome, 'ADD_CONTROLS', why);
      assert.equal(closed.signals.find((s) => s.id === sig).class, 'inventory-surface', why);
      for (const c of cls) assert.ok(closed.delta_pairs.includes(`new-boundary:${c}`), `${why}: ${c}`);
      assert.deepEqual(closed.classifications_used, [sig], `${why}: used beside the closing surface`);
      assert.equal(closed.merged_facts[fact], value, `${why}: its fact is merged (it can only raise)`);
      // Twin, one field (the approved plan has a surface at that path): the same classification is accepted.
      const accepted = ok(onApproved([file], { classifications }));
      assert.equal(accepted.outcome, acceptedOutcome, why);
      assert.equal(accepted.signals.find((s) => s.id === sig).class, classOnApproved, why);
      assert.deepEqual(accepted.classifications_used, [sig], why);
    }
  }
  // A surface at the path that does not select the signal's whole class does not close it, and no classification makes up the difference.
  const [, mw] = SURFACE_ROWS[1];
  const mwSig = `auth-or-middleware-change@${mw.path}`;
  const noop = { signal_id: mwSig, facts: { persistent_write: false }, evidence: { persistent_write: `${mw.path}:1` } };
  const partial = [svc('new-boundary', 'server-input', mw.path)];
  assert.deepEqual(refused(run([mw], { surfaces: partial }), 'classification_missing').unclassified, [mwSig]);
  assert.deepEqual(refused(run([mw], { surfaces: partial, classifications: [noop] }), 'classification_missing').unclassified, [mwSig]);
  // Twin, one field (the signal's kind): a signal that introduces no surface keeps its rule off every approved surface.
  const mail = { path: 'src/lib/a.ts', added: ['await transporter.sendMail(msg);'] };
  const mailSig = `mail-or-notification-send@${mail.path}`;
  assert.deepEqual(refused(run([mail]), 'classification_missing').unclassified, [mailSig]);
  assert.equal(ok(run([mail], { classifications: [{ ...noop, signal_id: mailSig }] })).outcome, 'UNCHANGED');
});

test('[S30] an approved surface counts only at exactly the signal\'s path: a prefix or a suffix of it is not an approved path', () => {
  const bools = REAL_BOOLS;
  const plan = (path) => ok(SP.selectControls(real, { security_policy: 2, facts: Object.fromEntries(bools.map((k) => [k, false])),
    evidence: Object.fromEntries(bools.map((k) => [k, `${path}:1`])), surfaces: [svc('mw', 'server-input', path)] }));
  const run = (approvedPath, signalPath) => {
    const sig = `auth-or-middleware-change@${signalPath}`;
    return [sig, SP.reassess({ plan: planWith(plan(approvedPath)), catalog: real, inventory: [], changed: { contract_paths: ['src/**', 'auth/**'], files: [{ path: signalPath }] },
      classifications: [{ signal_id: sig, reason: 'comment only' }] })];
  };
  // [approved surface path, signal path]: the approved path is a prefix, then a suffix, of the signal's path
  for (const [approvedPath, signalPath] of [['src/auth/a.ts', 'src/auth/a.ts.bak'], ['auth/a.ts', 'src/auth/a.ts'], ['src/auth/a', 'src/auth/a.ts']]) {
    const [sig, r] = run(approvedPath, signalPath);
    assert.deepEqual(refused(r, 'classification_missing').unclassified, [sig], `${approvedPath} vs ${signalPath}`);
    assert.equal(r.signals.find((s) => s.id === sig).class, null);
    // twin: the same classification at exactly the approved path is accepted
    const [sig2, same] = run(approvedPath, approvedPath);
    assert.equal(ok(same).outcome, 'UNCHANGED', approvedPath);
    assert.deepEqual(same.classifications_used, [sig2]);
  }
});

test('[S31] a classification closes only the signal it names: with two open signals and one classified, exactly the other stays open and is named', () => {
  const sel = approvedSyn();
  const changed = { contract_paths: ['src/a.ts', 'package.json', 'go.mod'], files: [{ path: 'package.json' }, { path: 'go.mod' }] };
  assert.deepEqual(refused(rea(sel, { changed }), 'classification_missing').unclassified, ['new-dependency@go.mod', 'new-dependency@package.json']);
  for (const [done, left] of [['new-dependency@go.mod', 'new-dependency@package.json'], ['new-dependency@package.json', 'new-dependency@go.mod']]) {
    const r = refused(rea(sel, { changed, classifications: [{ signal_id: done, reason: 'patch bump' }] }), 'classification_missing');
    assert.deepEqual(r.unclassified, [left], done);
    assert.equal(r.reasons.length, 1);
  }
  assert.equal(ok(rea(sel, { changed, classifications: ['new-dependency@go.mod', 'new-dependency@package.json'].map((signal_id) => ({ signal_id, reason: 'patch bump' })) })).outcome, 'UNCHANGED');
});

test('the evaluator\'s unknownish is the one used (no local copy); an evaluator without it is catalog_missing', () => {
  const { unknownish: _drop, ...noUnknownish } = EVAL;
  refused(SP.loadCatalog({ catalogPath: SYN_PATH, evaluator: noUnknownish }), 'catalog_missing');
  // An evaluator that also treats false as unknown: a false fact cited by path is then uncited, and is listed as unknown.
  const loose = ok(SP.loadCatalog({ catalogPath: SYN_PATH, evaluator: { ...EVAL, unknownish: (v) => EVAL.unknownish(v) || v === false } }));
  const s = [surf('A', 'request-handler')];
  ok(SP.selectControls(syn, input(s)));
  refused(SP.selectControls(loose, input(s)), 'fact_uncited');
  const why = { persistent_write: 'unknown: treated as unknown', session_context: 'unknown: treated as unknown', outbound_message: 'unknown: treated as unknown' };
  const r = ok(SP.selectControls(loose, { security_policy: 2, surfaces: s, facts: FALSE3, evidence: why }));
  assert.deepEqual(r.unknown_facts, ['outbound_message', 'persistent_write', 'session_context']);
  assert.ok(pairIds(r).includes('A:VAPT-ABUSE-07'), 'the evaluator\'s unknown keeps its control selected');
});

test('reassess: a newly selected control with no surface (approved or inventory) refuses control_unpaired; the approved surfaces always count', () => {
  const changed = { contract_paths: ['src/a.ts', 'docs/**'], files: [{ path: 'docs/x.md', added: ['await stripe.charges.create(c)'] }] };
  const id = 'payment-or-stock-or-wallet-call@docs/x.md';
  const cls = (v) => [{ signal_id: id, facts: { persistent_write: v }, evidence: { persistent_write: 'docs/x.md' } }];
  // An approved plan with no surface and an empty inventory: the raised fact has nothing to pair with.
  refused(rea(approvedSyn(FALSE3, []), { inventory: [], changed, classifications: cls(true) }), 'control_unpaired');
  assert.equal(ok(rea(approvedSyn(FALSE3, []), { inventory: [], changed, classifications: cls(false) })).outcome, 'UNCHANGED');
  // An inventory that leaves the approved surface out still pairs with it (reassess unites them).
  const r = ok(rea(approvedSyn(), { inventory: [], changed, classifications: cls(true) }));
  assert.equal(r.outcome, 'ADD_CONTROLS');
  assert.deepEqual(r.delta_pairs, ['A:VAPT-ABUSE-07']);
  assert.equal(ok(rea(approvedSyn({ ...FALSE3, persistent_write: true }), { inventory: [], changed, classifications: cls(true) })).outcome, 'UNCHANGED');
});

test('[S29] reassess unites the approved surfaces with the inventory itself: a redefined approved boundary id is bad_input; leaving the approved surfaces out changes nothing', () => {
  const sel = approvedSyn();
  const A = surf('A', 'request-handler', 'src/a.ts');
  // (a) an inventory surface that reuses an approved boundary id with another path, kind or principals is refused
  for (const [label, redefined] of [['path', { ...A, path: 'src/b.ts' }], ['kind', { ...A, kind: 'rendering-sink' }], ['principals', { ...A, principals: ['anonymous'] }]]) {
    refused(rea(sel, { inventory: { surfaces: [redefined] }, changed: { contract_paths: ['src/**'], files: [{ path: 'src/a.ts' }] } }), 'bad_input', label);
  }
  // an identical copy is the approved surface, in any spelling of the same principals set
  ok(rea(sel, { inventory: { surfaces: [{ ...A, path: './src/a.ts', principals: ['authenticated', 'authenticated'] }] } }));
  // (b) with or without the approved surfaces in the inventory, the result is the same object
  const without = (over) => rea(sel, { ...over, inventory: { candidate_id: 'cand-1', surfaces: (over.inventory?.surfaces ?? []).filter((s) => s.boundary_id !== 'A') } });
  const cases = [
    {},
    { inventory: { surfaces: [A, surf('B', 'rendering-sink', 'web/b.ts')] }, changed: { contract_paths: ['src/a.ts', 'web/**'], files: [{ path: 'web/b.ts', added: ['render(view)'] }] } },
  ];
  for (const over of cases) {
    const withA = rea(sel, { ...over, inventory: { candidate_id: 'cand-1', surfaces: over.inventory?.surfaces ?? [A] } });
    assert.deepEqual(without(over), withA, JSON.stringify(over));
  }
  // a control spanning two kinds (WEB-02): the approved rendering-sink plus a new outbound-data surface selects it
  const rs = approvedSyn(FALSE3, [surf('B', 'rendering-sink', 'web/b.ts')]);
  const C = surf('C', 'outbound-data', 'web/c.ts');
  const changed = { contract_paths: ['web/**'], files: [{ path: 'web/c.ts' }] };
  const omit = ok(rea(rs, { inventory: { surfaces: [C] }, changed }));
  assert.deepEqual(omit, ok(rea(rs, { inventory: { surfaces: [rs.surfaces[0], C] }, changed })));
  assert.ok(omit.delta_pairs.includes('B:VAPT-WEB-02') && omit.delta_pairs.includes('C:VAPT-WEB-02'), JSON.stringify(omit.delta_pairs));
  // (c) the standalone new-route case: an approved boundary id re-pathed onto a new route is never UNCHANGED
  const bools = Object.entries(real.catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
  const approved = ok(SP.selectControls(real, { security_policy: 2, facts: Object.fromEntries(bools.map((k) => [k, false])),
    evidence: Object.fromEntries(bools.map((k) => [k, 'src/orders.ts:handler'])), surfaces: [{ boundary_id: 'orders-api', kind: 'server-input', path: 'src/orders.ts', principals: ['service'] }] }));
  const route = { path: 'src/routes/admin.ts', added: ["app.get('/admin', h)"] };
  const moved = SP.reassess({ plan: planWith(approved), catalog: real, inventory: { surfaces: [{ ...approved.surfaces[0], path: route.path }] },
    changed: { contract_paths: ['src/**'], files: [route] } });
  assert.notEqual(moved.outcome, 'UNCHANGED');
  refused(moved, 'bad_input');
});

test('[S36] a surface path or changed path with a backslash is refused bad_input (select, reassess inventory, reassess changed files, reassessSignals)', () => {
  const bs = 'src\\a.ts';
  refused(SP.selectControls(syn, input([surf('A', 'request-handler', bs)])), 'bad_input');
  ok(SP.selectControls(syn, input([surf('A', 'request-handler', 'src/a.ts')])));
  const sel = approvedSyn();
  for (const files of [[{ path: bs }], [bs], [{ path: 'src/a.ts', added: [] }, { path: 'web\\b.ts' }]]) {
    refused(rea(sel, { changed: { contract_paths: ['src/a.ts', 'web/**'], files } }), 'bad_input');
  }
  assert.equal(ok(rea(sel, { changed: { contract_paths: ['src/a.ts'], files: [{ path: 'src/a.ts' }] } })).outcome, 'UNCHANGED');
  refused(rea(sel, { inventory: { surfaces: [surf('A', 'request-handler', 'src/a.ts'), surf('B', 'rendering-sink', 'web\\b.ts')] },
    changed: { contract_paths: ['src/a.ts', 'web/**'], files: [{ path: 'src/a.ts' }] } }), 'bad_input');
  assert.throws(() => SP.reassessSignals({ paths: [{ path: 'src\\lib\\format-date.ts', added: [] }], catalog: real.catalog }), TypeError);
});

test('reassess: plan without a block or with a tampered block refuses; a missing contract is bad input', () => {
  const sel = approvedSyn();
  refused(SP.reassess({ plan: '# plan', catalog: syn, inventory: [], changed: { contract_paths: ['x'], files: [] } }), 'plan_block_missing');
  const md = planWith(sel).replace(/"selection_digest":"sha256:[0-9a-f]{64}"/, `"selection_digest":"sha256:${'0'.repeat(64)}"`);
  refused(SP.reassess({ plan: md, catalog: syn, inventory: [], changed: { contract_paths: ['x'], files: [] } }), 'plan_block_invalid');
  refused(rea(sel, { changed: { files: [] } }), 'bad_input');
  refused(rea(sel, { catalog: SP.loadCatalog({ catalogPath: join(tmp(), 'gone.json') }) }), 'catalog_missing');
});

// ---- fixtures ----
test('fixture scoring: catalog-faithful baseline, per-scenario must_select, and the scorer bites', () => {
  ok(real);
  const base = manifest.preregistered_baselines;
  const total = labels.reduce((n, l) => n + (l.must_select ?? []).length, 0);
  assert.equal(total, base.must_select_total);
  for (const s of scenarios) {
    const got = mine(s);
    const l = labels.find((x) => x.scenario_id === s.id);
    for (const c of l?.must_select ?? []) assert.ok(got.includes(c), `${s.id} misses ${c}`);
  }
  const faithful = scoreSelector(scenarios, labels, ledger.entries, mine);
  assert.equal(faithful.recalled, total);
  assert.equal(`${faithful.recalled}/${total}`, base.baselines.catalog_faithful.recall);
  assert.equal(faithful.inapplicable_violations, base.baselines.catalog_faithful.inapplicable_violations);
  assert.equal(faithful.inapplicable_violations, ledger.entries.length);
  assert.equal(faithful.net_hard_defects, 0);
  assert.equal(faithful.net_hard_defects, base.baselines.catalog_faithful.net_hard_defects);
  // unknown treated as false must lose recall
  const asFalse = (facts) => Object.fromEntries(Object.entries(facts).map(([k, v]) => [k,
    Array.isArray(v) ? v.filter((x) => x !== 'unknown') : unknownish(v) ? false : v]));
  const unkFalse = scoreSelector(scenarios, labels, ledger.entries, (s) => mine({ ...s, facts: asFalse(s.facts) }));
  assert.ok(unkFalse.recalled < total, `unknown-as-false recalled ${unkFalse.recalled}`);
  // all controls when any boundary: the preregistered net hard defects
  const all = real.catalog.controls.map((c) => c.id);
  const allC = scoreSelector(scenarios, labels, ledger.entries, (s) => (s.facts.boundaries.length ? all : []));
  assert.equal(allC.net_hard_defects, base.baselines.all_controls_when_any_boundary.net_hard_defects);
  assert.ok(allC.net_hard_defects > 0);
  // boundary-universal, computed through select: one surface per kind, every bool fact false
  const vocab = real.catalog.fact_vocabulary;
  const neg = Object.fromEntries(Object.entries(vocab).filter(([, d]) => d.type === 'bool').map(([k]) => [k, false]));
  let universal = null;
  for (const k of vocab.boundaries.values) {
    const got = ok(SP.selectControls(real, { security_policy: 2, surfaces: [{ boundary_id: 'x', kind: k, path: 'x', principals: ['service'] }],
      facts: neg, evidence: fixtureEvidence(neg, 'neg') })).controls.map((c) => c.control_id);
    universal = universal ? universal.filter((c) => got.includes(c)) : got;
  }
  assert.equal(universal.length, base.boundary_universal_controls);
  const uni = scoreSelector(scenarios, labels, ledger.entries, (s) => (s.facts.boundaries.length ? universal : []));
  assert.equal(`${uni.recalled}/${total}`, base.baselines.boundary_universal_when_any_boundary.recall);
  assert.ok(uni.recalled < total);
});

const scope = scenarios.filter((s) => s.category === 'scope-exceeds-plan');
const fixtureReassess = (s, { swap = false, allInContract = false } = {}) => {
  const [aFacts, aSurf, xFacts, xSurf] = swap ? [s.facts, s.changed_surfaces, s.planned_facts, s.planned_surfaces]
    : [s.planned_facts, s.planned_surfaces, s.facts, s.changed_surfaces];
  const sel = ok(SP.selectControls(real, fixtureInput(aFacts, aSurf, s.id)));
  const contract = allInContract ? [...new Set([...aSurf, ...xSurf].map((c) => c.path))] : aSurf.map((c) => c.path);
  const run = (classifications) => SP.reassess({ plan: planWith(sel), catalog: real,
    inventory: { candidate_id: `cand-${s.id}`, surfaces: toSurfaces(xSurf, xFacts) },
    changed: { contract_paths: contract, files: xSurf.map((c) => ({ path: c.path })) }, classifications });
  const first = run([]);
  const open = (first.signals ?? []).filter((x) => x.class === null && x.kind !== 'out-of-plan-path');
  const facts = { ...xFacts }; delete facts.boundaries; delete facts.principals;
  const classifications = open.map((x) => ({ signal_id: x.id, facts, evidence: fixtureEvidence(xFacts, s.id) }));
  return { first, r: ok(run(classifications)), approved: sel };
};

test('fixture reassess: the scope-exceeds-plan verdicts and delta ⊇ added_in_delta', () => {
  assert.equal(scope.length, 4);
  for (const s of scope) {
    const l = labels.find((x) => x.scenario_id === s.id);
    const want = ledger.reassess.find((x) => x.scenario === s.id);
    const { r } = fixtureReassess(s);
    assert.equal(r.outcome, l.expected_reassess, s.id);
    const deltaControls = [...new Set(r.delta_pairs.map((p) => SP.parsePairId(p).control_id))];
    for (const c of want.added_in_delta) assert.ok(deltaControls.includes(c), `${s.id} delta misses ${c}`);
  }
  // S-SEA-20/21: route paths already on an approved surface are mechanically covered, no classification needed
  for (const id of ['S-SEA-20', 'S-SEA-21']) {
    const { first } = fixtureReassess(scope.find((s) => s.id === id));
    assert.equal(first.ok, true, id);
    assert.equal(first.outcome, 'UNCHANGED', id);
  }
});

test('fixture reassess: facts alone never give REAPPROVAL (swapped, or every path inside the contract)', () => {
  for (const s of scope) {
    const swapped = fixtureReassess(s, { swap: true }).r;
    assert.notEqual(swapped.outcome, 'REAPPROVAL', `${s.id} swapped`);
    assert.deepEqual(swapped.delta_pairs, [], `${s.id} swapped: add-only, nothing new`);
    const inContract = fixtureReassess(s, { allInContract: true }).r;
    assert.notEqual(inContract.outcome, 'REAPPROVAL', `${s.id} in contract`);
  }
  for (const id of ['S-SEA-15', 'S-SEA-16']) assert.equal(fixtureReassess(scope.find((s) => s.id === id), { allInContract: true }).r.outcome, 'ADD_CONTROLS', id);
});

// ---- CLI ----
const synInput = input([surf('A', 'request-handler')]);
test('CLI select: file and stdin give exit 0; refusals carry code and reasons with the right exit', () => {
  const a = cli(['select', '--facts', jsonFile(synInput), '--catalog', SYN_PATH]);
  assert.equal(a.status, 0, a.stderr); assert.equal(a.out.code, 'selected'); assert.ok(Array.isArray(a.out.reasons));
  const b = cli(['select', '--facts', '-', '--catalog', SYN_PATH], JSON.stringify(synInput));
  assert.equal(b.status, 0, b.stderr); assert.equal(b.out.selection_digest, a.out.selection_digest);
  const miss = cli(['select', '--facts', jsonFile(synInput), '--catalog', join(tmp(), 'missing.json')]);
  assert.equal(miss.status, 2); assert.equal(miss.out.code, 'catalog_missing'); assert.ok(!('controls' in miss.out));
  assert.ok(Array.isArray(miss.out.reasons) && miss.out.reasons.length > 0);
  const oov = cli(['select', '--facts', jsonFile(input([surf('A', 'request-handler')], { ...FALSE3, persistent_write: 'yes' })), '--catalog', SYN_PATH]);
  assert.equal(oov.status, 1); assert.equal(oov.out.code, 'fact_out_of_vocabulary');
  const unc = cli(['select', '--facts', jsonFile({ ...synInput, evidence: {} }), '--catalog', SYN_PATH]);
  assert.equal(unc.status, 2); assert.equal(unc.out.code, 'fact_uncited');
  const bad = cli(['select', '--nope', 'x']);
  assert.equal(bad.status, 1); assert.equal(bad.out.code, 'bad_input');
  const noFile = cli(['select', '--facts', join(tmp(), 'absent.json'), '--catalog', SYN_PATH]);
  assert.equal(noFile.status, 1); assert.equal(noFile.out.code, 'bad_input');
  const realRun = cli(['select', '--facts', jsonFile(fixtureInput(scenarios[0].facts, scenarios[0].changed_surfaces, scenarios[0].id))]);
  assert.equal(realRun.status, 0, realRun.stderr); assert.equal(realRun.out.catalog_digest, real.digest, 'default catalog is ../../vapt/controls.json');
});

test('CLI select from a standalone install without vapt refuses catalog_missing, never an empty selection', () => {
  const dir = join(tmp(), 'ship-ticket', 'scripts'); mkdirSync(dir, { recursive: true });
  const copy = join(dir, 'security-plan.mjs'); copyFileSync(SCRIPT, copy);
  for (const args of [['select', '--facts', jsonFile(synInput)], ['select', '--facts', jsonFile(synInput), '--catalog', SYN_PATH]]) {
    const r = spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, 'catalog_missing'); assert.ok(!('controls' in out));
  }
});

test('CLI reassess: UNCHANGED exit 0, ADD_CONTROLS exit 0, REAPPROVAL exit 2, classification_missing exit 2', () => {
  const sel = approvedSyn();
  const planPath = join(tmp(), 'plan.md'); writeFileSync(planPath, planWith(sel));
  const inv = jsonFile({ candidate_id: 'c', surfaces: [surf('A', 'request-handler', 'src/a.ts')] });
  const go = (changed, extra = []) => cli(['reassess', '--plan', planPath, '--inventory', inv, '--changed', jsonFile(changed), '--catalog', SYN_PATH, ...extra]);
  const u = go({ contract_paths: ['src/a.ts'], files: [{ path: 'src/a.ts' }] });
  assert.equal(u.status, 0, u.stderr); assert.equal(u.out.outcome, 'UNCHANGED'); assert.equal(u.out.code, 'reassessed');
  const inv2 = jsonFile({ candidate_id: 'c', surfaces: [surf('A', 'request-handler', 'src/a.ts'), surf('B', 'rendering-sink', 'src/b.ts')] });
  const add = cli(['reassess', '--plan', planPath, '--inventory', inv2, '--changed', jsonFile({ contract_paths: ['src/*.ts'], files: [{ path: 'src/b.ts' }] }), '--catalog', SYN_PATH]);
  assert.equal(add.status, 0, add.stderr); assert.equal(add.out.outcome, 'ADD_CONTROLS');
  const re = go({ contract_paths: ['src/a.ts'], files: [{ path: 'src/zzz.ts' }] });
  assert.equal(re.status, 2); assert.equal(re.out.outcome, 'REAPPROVAL');
  const cm = go({ contract_paths: ['src/a.ts', 'package.json'], files: [{ path: 'package.json' }] });
  assert.equal(cm.status, 2); assert.equal(cm.out.code, 'classification_missing');
  const cls = jsonFile([{ signal_id: 'new-dependency@package.json', reason: 'patch bump' }]);
  const ok2 = go({ contract_paths: ['src/a.ts', 'package.json'], files: [{ path: 'package.json' }] }, ['--classifications', cls]);
  assert.equal(ok2.status, 0, ok2.stderr); assert.equal(ok2.out.outcome, 'UNCHANGED');
});

test('approved_plan_digest matches the engine narrative digest; the module imports no engine file', () => {
  const text = '# p\n<!-- RUN-STATE:BEGIN -->\n{"event":"START"}\n<!-- RUN-STATE:END -->\ntail\n';
  assert.equal(SP.planDigest(text), planNarrativeDigest(text));
  const src = readFileSync(SCRIPT, 'utf8');
  const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  assert.ok(specs.every((s) => s.startsWith('node:')), `static imports: ${specs.join(', ')}`);
  assert.ok(!/\.\/(engine|run-|harness|gate|carrier)/.test(src), 'no engine module referenced');
});

// ---- meta: every refusal code has a refusing row and an accepting twin differing in one field ----
test('meta: SECURITY_CODES equals the codes with a refusing case, each with an accepting twin', () => {
  const sel = approvedSyn();
  const plan = planWith(sel);
  const reIn = (over = {}) => ({ plan, catalog: syn, inventory: { surfaces: [surf('A', 'request-handler', 'src/a.ts')] },
    changed: { contract_paths: ['src/a.ts', 'package.json'], files: [{ path: 'src/a.ts' }] }, classifications: [], ...over });
  const s = [surf('A', 'request-handler')];
  const rows = {
    catalog_missing: [() => SP.loadCatalog({ catalogPath: join(tmp(), 'x.json') }), () => SP.loadCatalog({ catalogPath: SYN_PATH })],
    catalog_invalid: [() => SP.loadCatalog({ catalogPath: writeCatalog({ ...SYN, controls: [] }) }), () => SP.loadCatalog({ catalogPath: writeCatalog(SYN) })],
    bad_input: [() => SP.selectControls(syn, { ...input(s), security_policy: 1 }), () => SP.selectControls(syn, { ...input(s), security_policy: 2 })],
    fact_out_of_vocabulary: [() => SP.selectControls(syn, input(s, { ...FALSE3, session_context: 'yes' })), () => SP.selectControls(syn, input(s, { ...FALSE3, session_context: true }))],
    surface_facts_mismatch: [() => SP.selectControls(syn, input(s, { ...FALSE3, boundaries: ['rendering-sink'] })), () => SP.selectControls(syn, input(s, { ...FALSE3, boundaries: ['request-handler'] }))],
    fact_uncited: [() => SP.selectControls(syn, { ...input(s), evidence: { ...input(s).evidence, session_context: undefined } }), () => SP.selectControls(syn, input(s))],
    control_unpaired: [() => SP.selectControls(syn, input([], { ...FALSE3, persistent_write: true })), () => SP.selectControls(syn, input([], FALSE3))],
    classification_missing: [() => SP.reassess(reIn({ changed: { contract_paths: ['src/a.ts', 'package.json'], files: [{ path: 'package.json' }] } })),
      () => SP.reassess(reIn({ changed: { contract_paths: ['src/a.ts', 'package.json'], files: [{ path: 'package.json' }] }, classifications: [{ signal_id: 'new-dependency@package.json', reason: 'bump' }] }))],
    plan_block_missing: [() => SP.reassess(reIn({ plan: '# none' })), () => SP.reassess(reIn())],
    plan_block_invalid: [() => SP.reassess(reIn({ plan: plan.replace('"policy":2', '"policy":3') })), () => SP.reassess(reIn({ plan }))],
  };
  assert.deepEqual([...SP.SECURITY_CODES].sort(), Object.keys(rows).sort());
  for (const [code, [refuse, accept]] of Object.entries(rows)) {
    refused(refuse(), code);
    const a = accept();
    assert.equal(a.ok, true, `${code} twin: ${a.code} ${JSON.stringify(a.reasons)}`);
  }
});
