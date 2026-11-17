// Tests for test-kinds.mjs, the risk-triggered required test kinds (T1-S trigger table, S-01b). Assertions are on codes,
// enums and kind ids, not message text. Repositories are built in temp directories with the local git binary (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as TK from './test-kinds.mjs';
import * as SP from './security-plan.mjs';
import * as RF from './risk-floor.mjs';
import { planNarrativeDigest } from './engine-dag.mjs'; // only to forge an approval in the waiver test
import { buildBrief, lintBrief } from './brief.mjs';
import { parseWorkerReport } from './worker-report.mjs';

const SCRIPT = fileURLToPath(new URL('./test-kinds.mjs', import.meta.url));
const BRIEF = fileURLToPath(new URL('./brief.mjs', import.meta.url));
const VAPT = JSON.parse(readFileSync(new URL('../../vapt/controls.json', import.meta.url), 'utf8'));
const G = (dir, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const tmp = (p) => realpathSync.native(mkdtempSync(join(tmpdir(), p)));
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const RS = '\n<!-- RUN-STATE:BEGIN -->\n{"event":"START"}\n<!-- RUN-STATE:END -->\n';
const FB = '0123456789ab';
/** The REAL producer's record line (risk-floor.mjs assess), never a hand-built one: classless is `classes=none`. */
function realFloor(classes = [], { base = FB, changed = false } = {}) {
  const declaration = classes.length ? RF.validateDeclaration({ version: 1, classes: classes.map((name) => ({ name, floor: 'ELEVATED', globs: ['src/**'] })) }) : null;
  const r = RF.assess({ paths: ['src/x.ts'], declaration, declChanged: changed, claimed: 'ELEVATED', ai: 'ELEVATED', planned: true, baseSha: base, headLabel: 'planned' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return `risk_floor: ${r.record_line}`;
}
const planRaw = (...lines) => `# Plan\n\n${lines.join('\n')}\n${RS}`;
// Every plan carries a risk-floor record as plan.md requires; a classless one by default.
const plan = (...lines) => planRaw(...lines, ...(lines.some((l) => l.includes('risk-floor:')) ? [] : [realFloor()]));
const req = (planText, declaration = null, extra = {}) => TK.requiredFor({ planText, declaration, ...extra });
const title = (t, ...kinds) => `${t}${kinds.map((k) => ` [kind:${k}]`).join('')}`;
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const uniqSorted = (xs) => [...new Set(xs)].sort();

// ---- invariants over the whole table (generic: every row, every tag, every kind) ----
test('invariant: every tag row resolves to defined kinds, and every kind a-g is reachable from some tag', () => {
  const kindIds = Object.keys(TK.KINDS);
  for (const [tag, kinds] of Object.entries(TK.TAGS)) {
    assert.match(tag, TK.NAME, `tag ${tag} is a well-formed name`);
    assert.ok(kinds.length > 0, `tag ${tag} requires at least one kind`);
    for (const k of kinds) assert.ok(kindIds.includes(k), `tag ${tag} -> ${k} resolves`);
  }
  const reachable = new Set(Object.values(TK.TAGS).flat());
  for (const k of kindIds) assert.ok(reachable.has(k), `kind ${k} is required by some tag`);
  assert.deepEqual([...new Set(kindIds.map((k) => TK.KINDS[k].letter))].sort(), LETTERS, 'the kinds cover exactly E §1.4 (a)-(g)');
  for (const k of kindIds) assert.ok(TK.KINDS[k].definition.length > 20, `kind ${k} has a definition`);
});

test('invariant: every security-plan boundary kind in the vapt vocabulary maps to defined tags', () => {
  const kinds = VAPT.fact_vocabulary.boundaries.values;
  assert.ok(kinds.length >= 5);
  for (const k of kinds) {
    assert.ok(Object.hasOwn(TK.SURFACE_TAGS, k), `boundary kind ${k} is mapped`);
    for (const t of TK.SURFACE_TAGS[k]) assert.ok(Object.hasOwn(TK.TAGS, t), `${k} -> ${t} resolves`);
  }
  for (const k of Object.keys(TK.SURFACE_TAGS)) assert.ok(kinds.includes(k), `mapped kind ${k} exists in the vocabulary`);
});

test('invariant: the tag convention round-trips every kind and every item id, and nothing else counts', () => {
  for (const k of Object.keys(TK.KINDS)) assert.deepEqual(TK.markers([`does a thing [kind:${k}]`]).kinds, [k]);
  assert.deepEqual(TK.markers(['x [plan:L1] [plan:checkout-2]']).items, ['L1', 'checkout-2']);
  const near = ['rejects a non-negative total', 'negative', '[kind: negative]', '[KIND:negative]', '[kind:negative-path]', '[kind:Negative]', 'kind:negative', '[kind:stale-n2]'];
  const m = TK.markers(near);
  assert.deepEqual(m.kinds, [], 'only an exact delimited marker counts');
  assert.deepEqual(m.unknown.sort(), ['kind:Negative', 'kind:negative-path', 'kind:stale-n2'].sort(), 'well-formed but unknown markers are reported');
});

// ---- AC4: async-state + UI-lifecycle plan (D2/D10/D11/D14 replica) ----
const ASYNC_UI = plan('test-triggers: async-state, ui-lifecycle');
const AC4 = ['stale-N2', 'error-twin', 'lifecycle-destroy', 'negative'];
test('AC4: an async-state + ui-lifecycle plan requires stale-N2, error-twin, lifecycle-destroy and negative; freeze refused until all exist', () => {
  const r = req(ASYNC_UI);
  assert.equal(r.status, 'required', JSON.stringify(r.errors));
  assert.deepEqual([...r.kinds].sort(), [...AC4].sort());
  const all = AC4.map((k, i) => title(`test ${i}`, k));
  const pass = TK.checkTitles(r, all);
  assert.equal(pass.status, 'pass'); assert.deepEqual(pass.reasons, []); assert.equal(pass.counts.missing, 0);
  for (const k of AC4) {
    const c = TK.checkTitles(r, all.filter((t) => !t.endsWith(`[kind:${k}]`)));
    assert.equal(c.status, 'freeze_refused'); assert.deepEqual(c.reasons, ['missing_test_kinds']); assert.deepEqual(c.missing_kinds, [k], `removing ${k} reports exactly ${k}`);
  }
  assert.deepEqual(TK.checkTitles(r, []).missing_kinds, [...AC4].sort());
  assert.deepEqual(TK.checkTitles(r, [title('one test proves all', ...AC4)]).status, 'pass', 'one title may carry several markers');
});

test('AC4 on a plan shaped like the plan.md template (header, DAG table, real risk-floor record, START event)', () => {
  const p = ['# Plan: checkout price and stock banners', '', '## Context', 'The cart adopts a re-validated price; stale responses must be ignored.', '',
    '| ID | Owner | Step | Files touched | Depends on |', '|---|---|---|---|---|', '| `web-state` | builder 1 | Visit-scoped validation state | `src/cart.state.ts` | none |', '',
    '## Risk', realFloor(), '', 'test-triggers: async-state, ui-lifecycle', '', RS.trim(), ''].join('\n');
  const r = req(p);
  assert.equal(r.status, 'required', JSON.stringify(r.errors)); assert.deepEqual([...r.kinds].sort(), [...AC4].sort());
  assert.deepEqual(TK.checkTitles(r, [title('t', 'stale-N2', 'error-twin', 'negative')]).missing_kinds, ['lifecycle-destroy']);
});

// ---- AC7: plan lifecycle items ----
test('AC7: an unmapped plan lifecycle item refuses freeze unless the plan dispositions it', () => {
  const p = plan('test-triggers: none', 'lifecycle-item: L1 dismissing one banner keeps the other', 'lifecycle-item: L2 leaving the page drops pending results');
  const r = req(p);
  assert.equal(r.status, 'required'); assert.deepEqual(r.kinds, []); assert.deepEqual(r.items, ['L1', 'L2']);
  const c = TK.checkTitles(r, ['keeps banner [plan:L1]']);
  assert.equal(c.status, 'freeze_refused'); assert.deepEqual(c.reasons, ['unmapped_lifecycle_item']); assert.deepEqual(c.unmapped_items, ['L2']);
  assert.equal(TK.checkTitles(r, ['a [plan:L1]', 'b [plan:L2]']).status, 'pass');
  const withWaiver = p.replace('# Plan', '# Plan\n\ntest-waiver: L2 owner: covered by the existing e2e suite');
  const w = req(withWaiver);
  assert.deepEqual(w.items, ['L1', 'L2'], 'a waiver never removes an item'); assert.deepEqual(w.waiver_requested, ['L2']);
  assert.equal(TK.checkTitles(w, ['a [plan:L1]']).status, 'freeze_refused');
  // both reasons together, in a fixed order
  const both = TK.checkTitles(req(plan('test-triggers: ui-lifecycle', 'lifecycle-item: L1 x')), []);
  assert.deepEqual(both.reasons, ['missing_test_kinds', 'unmapped_lifecycle_item']);
});

test('a forged waiver (any digest or START combination) cannot remove a requirement', () => {
  const p = plan('test-triggers: async-state', 'test-waiver: error-twin builder says unnecessary');
  const d = planNarrativeDigest(p);
  const forged = p.replace('{"event":"START"}', JSON.stringify({ event: 'START', run_id: 'r1', approved_plan_digest: d }));
  for (const [text, extra] of [[p, {}], [forged, {}], [forged, { approvedDigest: d }], [p, { approvedDigest: d }]]) {
    const r = req(text, null, extra);
    assert.deepEqual([...r.kinds].sort(), ['error-twin', 'negative', 'stale-N2']); assert.deepEqual(r.waiver_requested, ['error-twin']);
    const c = TK.checkTitles(r, [title('t', 'stale-N2', 'negative')]);
    assert.equal(c.status, 'freeze_refused'); assert.deepEqual(c.missing_kinds, ['error-twin']); assert.equal(c.counts.waiver_requested, 1);
  }
});

test('AC7: malformed dispositions and item ids are refusals', () => {
  for (const [lines, code] of [
    [['test-triggers: none', 'test-waiver: L9 reason'], 'waiver_invalid'],
    [['test-triggers: none', 'test-waiver: negative'], 'waiver_invalid'],
    [['test-triggers: none', 'lifecycle-item: L1 a', 'lifecycle-item: L1 b'], 'plan_line_invalid'],
    [['test-triggers: none', 'lifecycle-item: 1bad x'], 'plan_line_invalid'],
    [['test-triggers: none', 'lifecycle-item: L1'], 'plan_line_invalid'],
    [['test-triggers: none', 'lifecycle-item: negative x'], 'plan_line_invalid'],
  ]) { const x = req(plan(...lines)); assert.equal(x.status, 'refused'); assert.ok(x.errors.includes(code), `${lines.join(' | ')} -> ${code}: ${x.errors}`); }
});

// ---- AC10: production entrypoint and cross-module contract fixtures ----
test('AC10: production-entrypoint fixture (D5 replica): a hand-built app test does not satisfy real-entrypoint', () => {
  const r = req(plan('test-triggers: entrypoint'));
  assert.deepEqual(r.kinds, ['real-entrypoint']);
  const handBuilt = TK.checkTitles(r, [title('headers are set on a hand-built app', 'negative')]);
  assert.equal(handBuilt.status, 'freeze_refused'); assert.deepEqual(handBuilt.missing_kinds, ['real-entrypoint']);
  assert.equal(TK.checkTitles(r, [title('headers are set through the production worker entry', 'real-entrypoint')]).status, 'pass');
});

test('AC10: cross-module contract fixture: a changed producer without a consumer-side test is refused', () => {
  const r = req(plan('test-triggers: shared-contract'));
  assert.deepEqual([...r.kinds].sort(), ['contract-consumer', 'contract-producer']);
  const producerOnly = TK.checkTitles(r, [title('producer emits v2 shape', 'contract-producer')]);
  assert.equal(producerOnly.status, 'freeze_refused'); assert.deepEqual(producerOnly.missing_kinds, ['contract-consumer']);
  assert.equal(TK.checkTitles(r, [title('producer emits v2', 'contract-producer'), title('consumer reads v2', 'contract-consumer')]).status, 'pass');
});

// ---- trigger sources: plan tags, risk floor classes, security surfaces; fail closed ----
const floorLine = (classes) => (classes === TK.CHANGED ? realFloor([], { changed: true }) : realFloor(classes.split(',')));
test('risk floor classes: a class named like a tag maps to it; a repo declaration maps others; an unmapped class is a refusal', () => {
  assert.deepEqual(req(plan('test-triggers: none', floorLine('tenancy'))).kinds.sort(), [...TK.TAGS.tenancy].sort());
  assert.deepEqual(req(plan('test-triggers: none', floorLine(TK.CHANGED))).kinds, [], 'a declaration change adds no surface');
  const un = req(plan('test-triggers: none', floorLine('billing-core')));
  assert.equal(un.status, 'refused'); assert.deepEqual(un.errors, ['risk_class_unmapped']);
  const decl = TK.validateDeclaration({ version: 1, classes: { 'billing-core': ['money', 'repair'] } });
  assert.deepEqual(req(plan('test-triggers: none', floorLine('billing-core')), decl).kinds.sort(), [...new Set([...TK.TAGS.money, ...TK.TAGS.repair])].sort());
  assert.deepEqual(req(plan('test-triggers: none', realFloor().replace('classes=none', 'classes=bad; classes=x'))).errors, ['risk_floor_invalid']);
  assert.deepEqual(req(plan('test-triggers: none', floorLine('tenancy'), floorLine('tenancy'))).errors, ['risk_floor_invalid'], 'exactly one record line');
  assert.deepEqual(req(planRaw('test-triggers: none'), decl).errors, ['risk_floor_missing'], 'no floor record: unavailable, not zero');
  assert.deepEqual(req(planRaw('test-triggers: async-state')).errors, ['risk_floor_missing'], 'an opted-in plan always needs the record');
});

test('risk floor from the REAL producer: classless (none), single, multi-class, underscore and declaration-changed records', () => {
  assert.match(realFloor(), /; classes=none;/);
  assert.deepEqual(req(plan('test-triggers: async-state', realFloor())).kinds.sort(), [...TK.TAGS['async-state']].sort(), 'none is the empty set');
  assert.deepEqual(req(plan('test-triggers: none', realFloor(['tenancy']))).kinds.sort(), [...TK.TAGS.tenancy].sort());
  assert.doesNotThrow(() => TK.validateDeclaration({ version: 1, classes: { billing_core: ['money'] } }), 'the producer grammar allows underscores');
  const d = TK.validateDeclaration({ version: 1, classes: { billing_core: ['money'] } });
  assert.deepEqual(req(plan('test-triggers: none', realFloor(['billing_core', 'tenancy'])), d).kinds.sort(), uniqSorted([...TK.TAGS.money, ...TK.TAGS.tenancy]));
  assert.deepEqual(req(plan('test-triggers: none', realFloor(['billing_core']))).errors, ['risk_class_unmapped']);
  assert.deepEqual(req(plan('test-triggers: none', realFloor([], { changed: true }))).kinds, []);
  assert.throws(() => RF.validateDeclaration({ version: 1, classes: [{ name: 'none', floor: 'ELEVATED', globs: ['a/**'] }] }), (e) => e.code === 'declaration_invalid', 'none is the empty-set sentinel, never a class');
  for (const odd of ['tenancy,,auth', 'tenancy,none', ',tenancy']) assert.deepEqual(req(plan('test-triggers: none', realFloor().replace('classes=none', `classes=${odd}`))).errors, ['risk_floor_invalid'], odd);
  assert.deepEqual(req(plan('test-triggers: none', realFloor(['tenancy'])), null, { baseSha: 'fedcba9876543210' }).errors, ['risk_floor_base_mismatch']);
  assert.equal(req(plan('test-triggers: none', realFloor(['tenancy'])), null, { baseSha: `${FB}aaaa` }).status, 'required');
});

test('add-only: a declared class mapping is united with the built-in reading, never replacing it', () => {
  const d = TK.validateDeclaration({ version: 1, classes: { tenancy: ['repair'] } });
  assert.deepEqual(req(plan('test-triggers: none', realFloor(['tenancy'])), d).kinds.sort(), uniqSorted([...TK.TAGS.tenancy, ...TK.TAGS.repair]));
});

test('security-plan surfaces: a verified block adds the mapped tags; a present but unverifiable block is a refusal', () => {
  const cat = SP.loadCatalog();
  assert.equal(cat.ok !== false, true, 'the real catalog loads');
  const facts = Object.fromEntries(Object.entries(VAPT.fact_vocabulary).filter(([k, v]) => v.type === 'bool').map(([k]) => [k, false]));
  const surfaces = [{ boundary_id: 'GET /a/:id', kind: 'request-handler', path: 'src/a.ts', principals: ['anonymous'] }];
  const sel = SP.selectControls(cat, { security_policy: 2, surfaces, facts: { ...facts, boundaries: ['request-handler'], principals: ['anonymous'] },
    evidence: Object.fromEntries(Object.keys(facts).map((k) => [k, 'src/a.ts:handler'])) });
  assert.equal(sel.ok, true, JSON.stringify(sel));
  const p = `# Plan\n\ntest-triggers: none\n${realFloor()}\n\n${SP.renderSection3a(sel)}\n${RS}`;
  const r = req(p);
  const want = ['negative', 'real-entrypoint']; // pinned: a route is an input path reached through the production entrypoint
  assert.equal(r.status, 'required', JSON.stringify(r.errors)); assert.deepEqual([...r.kinds].sort(), want);
  const broken = p.replace('"policy":2', '"policy":3');
  assert.notEqual(broken, p);
  assert.deepEqual(req(broken).errors, ['security_block_invalid']);
});

test('plan tags: unknown tag, duplicate or empty trigger lines are refusals; RUN-STATE lines never count', () => {
  assert.deepEqual(req(plan('test-triggers: async-state, telepathy')).errors, ['unknown_tag']);
  assert.deepEqual(req(plan('test-triggers: async-state', 'test-triggers: money')).errors, ['plan_line_invalid']);
  assert.deepEqual(req(plan('test-triggers:')).errors, ['plan_line_invalid']);
  const inRunState = `# Plan\n\n<!-- RUN-STATE:BEGIN -->\ntest-triggers: money\ntest-waiver: negative x\n<!-- RUN-STATE:END -->\n`;
  assert.equal(req(inRunState).status, 'not_declared');
  const waiverInRunState = plan('test-triggers: money').replace('{"event":"START"}', 'test-waiver: negative appended by a worker');
  assert.deepEqual(req(waiverInRunState).waiver_requested, [], 'a line in RUN-STATE is not even a request');
  const d = TK.validateDeclaration({ version: 1, tags: { 'feature-flags': ['negative', 'lifecycle-destroy'] } });
  assert.deepEqual(req(plan('test-triggers: feature-flags'), d).kinds.sort(), ['lifecycle-destroy', 'negative']);
  assert.deepEqual(req(plan('test-triggers: money'), TK.validateDeclaration({ version: 1, tags: { money: ['regression'] } })).kinds.sort(), [...TK.TAGS.money, 'regression'].sort(), 'a declaration only adds kinds');
});

test('declaration validation fails closed on unknown keys, versions, kinds and tags', () => {
  for (const bad of [null, [], { version: 2 }, { version: 1, extra: 1 }, { version: 1, tags: { 'Bad Tag': ['negative'] } }, { version: 1, tags: { x: ['telepathy'] } },
    { version: 1, tags: { x: [] } }, { version: 1, classes: { c: ['nope'] } }, { version: 1, classes: { c: [] } }, { version: 1, tags: [] }]) {
    assert.throws(() => TK.validateDeclaration(bad), (e) => e.code === 'declaration_invalid', JSON.stringify(bad));
  }
});

test('a plan that uses the convention is never not_declared: missing or near-miss lines are refusals', () => {
  for (const [lines, code] of [
    [['lifecycle-item: L1 x'], 'plan_tags_missing'], [['test-waiver: negative x'], 'plan_tags_missing'],
    [['- test-triggers: async-state'], 'plan_line_invalid'], [['**test-triggers:** async-state'], 'plan_line_invalid'], [['Test-Triggers: async-state'], 'plan_line_invalid'],
    [['test-triggers: async-state', '- lifecycle-item: L1 x'], 'plan_line_invalid'],
  ]) { const x = req(plan(...lines)); assert.equal(x.status, 'refused', lines.join(' | ')); assert.ok(x.errors.includes(code), `${lines.join(' | ')} -> ${x.errors}`); }
});

test('inherited names never resolve; none is reserved; CRLF plans read the same as LF', () => {
  const p = plan('test-triggers: constructor');
  assert.deepEqual(req(p).errors, ['unknown_tag']);
  assert.deepEqual(req(plan('test-triggers: none', floorLine('constructor'))).errors, ['risk_class_unmapped']);
  assert.deepEqual(req(plan('test-triggers: none', floorLine('constructor')), TK.validateDeclaration({ version: 1, tags: { x: ['negative'] } })).errors, ['risk_class_unmapped']);
  for (const d of [{ version: 1, tags: { none: ['negative'] } }, { version: 1, classes: { c: ['constructor'] } }]) assert.throws(() => TK.validateDeclaration(d), (e) => e.code === 'declaration_invalid');
  const lf = plan('test-triggers: async-state, ui-lifecycle', 'lifecycle-item: L1 x', 'test-waiver: race n/a', floorLine('tenancy'));
  assert.deepEqual(req(lf.replace(/\n/g, '\r\n')), req(lf));
});

test('not declared: no plan trigger line and no repo declaration is not_declared, even with a risk floor or security block', () => {
  assert.equal(req(plan('nothing here', floorLine('tenancy'))).status, 'not_declared');
  assert.equal(TK.checkTitles(req(plan('x')), []).status, 'not_declared');
  assert.deepEqual(req(plan('x'), TK.validateDeclaration({ version: 1 })).errors, ['plan_tags_missing'], 'a repo that declares requires the plan line');
});

// ---- CLI against a real repo: the declaration is read from BASE ----
function repo(decl) {
  const dir = tmp('tkrepo-');
  G(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  if (decl) { mkdirSync(join(dir, '.ship-ticket'), { recursive: true }); writeFileSync(join(dir, TK.DECLARATION_PATH), JSON.stringify(decl)); }
  G(dir, 'add', '-A'); G(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: G(dir, 'rev-parse', 'HEAD') };
}
const file = (text, name = 'f.txt') => { const p = join(tmp('tkf-'), name); writeFileSync(p, text); return p; };
const json = (r) => JSON.parse(r.stdout);

test('CLI: the declaration comes from BASE; working-tree edits and branch-only declarations do not change it', () => {
  const r = repo({ version: 1, classes: { 'billing-core': ['money'] } });
  const pf = (x) => file(plan('test-triggers: none', realFloor(['billing-core'], { base: x.base.slice(0, 12) })), 'plan.md');
  const p = pf(r);
  const a = cli(['require', '--repo', r.dir, '--base', r.base, '--plan', p]);
  assert.equal(a.status, 0, a.stderr); assert.deepEqual(json(a).kinds.sort(), [...TK.TAGS.money].sort());
  writeFileSync(join(r.dir, TK.DECLARATION_PATH), JSON.stringify({ version: 1, classes: { 'billing-core': ['repair'] } }));
  assert.deepEqual(json(cli(['require', '--repo', r.dir, '--base', r.base, '--plan', p])).kinds.sort(), [...TK.TAGS.money].sort(), 'working tree ignored');
  const n = repo(null);
  mkdirSync(join(n.dir, '.ship-ticket'), { recursive: true }); writeFileSync(join(n.dir, TK.DECLARATION_PATH), JSON.stringify({ version: 1, classes: { 'billing-core': ['money'] } }));
  G(n.dir, 'add', '-A'); G(n.dir, 'commit', '-q', '-m', 'branch adds a declaration');
  const b = cli(['require', '--repo', n.dir, '--base', n.base, '--plan', pf(n)]);
  assert.equal(b.status, 1); assert.deepEqual(json(b).errors, ['risk_class_unmapped'], 'branch-only declaration is not read');
  const inv = repo({ version: 1, tags: { x: ['telepathy'] } });
  assert.deepEqual(json(cli(['require', '--repo', inv.dir, '--base', inv.base, '--plan', pf(inv)])).errors, ['declaration_invalid']);
  const other = repo(null);
  assert.deepEqual(json(cli(['require', '--repo', other.dir, '--base', other.base, '--plan', p])).errors.includes('risk_floor_base_mismatch'), true, 'the record base must equal --base');
  assert.deepEqual(json(cli(['require', '--repo', r.dir, '--base=-x', '--plan', p])).errors, ['base_invalid']);
});

test('CLI check: worker report titles, record line with numbers and enums only, exit codes', () => {
  const r = repo(null);
  const p = file(plan('test-triggers: async-state, ui-lifecycle', realFloor([], { base: r.base.slice(0, 12) })), 'plan.md');
  const msg = (titles) => file(`done\n\n\`\`\`ship-ticket-report\n${JSON.stringify({ tests: [], red_seen: [], blockers: [], needs_outside_ownership: [], test_titles: titles })}\n\`\`\`\n`);
  const bad = cli(['check', '--repo', r.dir, '--base', r.base, '--plan', p, '--report-file', msg([title('a', 'negative')])]);
  assert.equal(bad.status, 1); const o = json(bad);
  assert.equal(o.status, 'freeze_refused'); assert.deepEqual(o.reasons, ['missing_test_kinds']);
  assert.equal(o.record_line, 'test-kinds: status=freeze_refused; required=4; present=1; missing=3; waiver_requested=0; items=0; unmapped=0; unknown_markers=0; reasons=missing_test_kinds');
  const good = cli(['check', '--repo', r.dir, '--base', r.base, '--plan', p, '--titles', JSON.stringify([title('a', ...AC4)])]);
  assert.equal(good.status, 0, good.stdout); assert.equal(json(good).status, 'pass');
  const noKey = cli(['check', '--repo', r.dir, '--base', r.base, '--plan', p, '--report-file', file('```ship-ticket-report\n{"tests":[],"red_seen":[],"blockers":[],"needs_outside_ownership":[]}\n```\n')]);
  assert.equal(noKey.status, 1); assert.deepEqual(json(noKey).errors, ['test_titles_missing']);
  const nd = cli(['check', '--repo', r.dir, '--base', r.base, '--plan', file(plan('x'), 'p.md'), '--titles', '[]']);
  const withW = file(plan('test-triggers: async-state, ui-lifecycle', 'test-waiver: negative owner: n/a', realFloor([], { base: r.base.slice(0, 12) })), 'w.md');
  const unb = cli(['check', '--repo', r.dir, '--base', r.base, '--plan', withW, '--titles', JSON.stringify([title('a', 'stale-N2', 'error-twin', 'lifecycle-destroy')])]);
  assert.equal(unb.status, 1); assert.deepEqual(json(unb).waiver_requested, ['negative']); assert.deepEqual(json(unb).missing_kinds, ['negative']);
  assert.equal(cli(['check', '--repo', r.dir, '--base', r.base, '--plan', withW, '--approved-digest', 'sha256:x', '--titles', '[]']).status, 2, 'no approval flag exists');
  assert.equal(nd.status, 0); assert.equal(json(nd).status, 'not_declared');
  assert.equal(cli(['check', '--plan', p]).status, 2, 'usage');
  assert.equal(cli(['require', '--repo', r.dir, '--base', r.base, '--plan', p, '--plan', p]).status, 2, 'repeated flag');
});

// ---- AC8 and wiring: brief and worker report ----
const BPLAN = ['# Plan', '', '| ID | Owner | Step | Files touched | Depends on |', '|---|---|---|---|---|', '| `api` | builder 1 | Add the invoice route and its tests | `src/api.js` | none |', '', '<!-- RUN-STATE:BEGIN -->', '<!-- RUN-STATE:END -->', ''].join('\n');
const BDAG = { nodes: [{ id: 'api', deps: [], writes: ['src/api.js'], risk: ['auth', 'concurrency'], redSpecs: [{ file: 'src/api.test.js', name: 'x' }], acceptance: ['AC1'] }] };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const brief = (o = {}) => buildBrief({ dag: BDAG, nodeId: 'api', planText: BPLAN, ...o });
test('AC8: with nothing declared the brief is byte-identical to the pre-S-01b output (goldens captured before the change)', () => {
  assert.equal(sha(brief()), '3458c15c783ad5468d01ff8efeb8b0268c65773eba58394f9397e7cf81a1b374');
  assert.equal(sha(brief({ t0: { checks: [{ name: 'lint' }] } })), '87b4498f487d1bc330ededad897541d1cb3f8a6f1c680d28280425be67a0e475');
  assert.equal(brief({ testKinds: req(plan('x')) }), brief(), 'a not_declared requirement adds nothing');
  assert.equal(brief({ testKinds: null }), brief());
});

test('brief lists the required kinds, items and the report key; a refused or malformed requirement refuses the brief', () => {
  const r = req(plan('test-triggers: async-state, ui-lifecycle', 'lifecycle-item: L1 x'));
  const b = brief({ testKinds: r });
  for (const k of AC4) assert.ok(b.includes(`\`[kind:${k}]\``), k);
  assert.ok(b.includes('`[plan:L1]`'));
  assert.ok(b.includes('"test_titles"'));
  assert.ok(b.includes('ADVISORY') && b.includes('exit 1 is never a freeze permission'), 'the brief does not claim engine enforcement');
  const both = brief({ testKinds: r, t0: { checks: [{ name: 'lint' }] } });
  const lastExample = both.split('```ship-ticket-report\n').pop().split('\n')[0];
  assert.equal(parseWorkerReport(`\`\`\`ship-ticket-report\n${lastExample}\n\`\`\``, { t0Declared: true, testKindsDeclared: true }).status, 'structured', 'the last example satisfies both');
  assert.equal(lintBrief(b).ok, true); assert.equal(lintBrief(both).ok, true);
  for (const bad of [req(plan('test-triggers: telepathy')), { status: 'required', kinds: ['telepathy'], items: [] }, { status: 'required', kinds: [], items: ['bad id'] }, { status: 'other' }, []]) {
    assert.throws(() => brief({ testKinds: bad }), (e) => e.briefError === true, JSON.stringify(bad));
  }
  const out = join(tmp('tkb-'), 'brief.md');
  const dag = file(JSON.stringify(BDAG), 'dag.json'); const pl = file(BPLAN, 'plan.md'); const tk = file(JSON.stringify(r), 'tk.json');
  const c = spawnSync(process.execPath, [BRIEF, 'build', '--dag', dag, '--node', 'api', '--plan', pl, '--test-kinds', tk, '--out', out], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr); assert.equal(readFileSync(out, 'utf8'), b);
});

test('worker report: 4- and 5-key reports are unchanged; test_titles is validated by shape; declared means required', () => {
  const block = (o) => `\`\`\`ship-ticket-report\n${JSON.stringify(o)}\n\`\`\``;
  const base = { tests: [], red_seen: [], blockers: [], needs_outside_ownership: [] };
  assert.deepEqual(parseWorkerReport(block(base)), { status: 'structured', report: base });
  assert.deepEqual(parseWorkerReport(block({ ...base, t0: { result: 'pass', checks: [] } })).status, 'structured');
  assert.deepEqual(parseWorkerReport(block({ ...base, x: 1 })), { status: 'unstructured', failure: 'report keys: missing [] unexpected [x]' });
  assert.equal(parseWorkerReport(block({ ...base, test_titles: ['a [kind:negative]'] })).status, 'structured');
  assert.equal(parseWorkerReport(block({ ...base, t0: { result: 'pass', checks: [] }, test_titles: [] })).status, 'structured');
  for (const bad of ['x', [1], [''], {}]) assert.equal(parseWorkerReport(block({ ...base, test_titles: bad })).failure, 'test_titles_invalid', JSON.stringify(bad));
  assert.equal(parseWorkerReport(block(base), { testKindsDeclared: true }).failure, 'test_titles_missing');
  assert.equal(parseWorkerReport(block(base), { t0Declared: true }).failure, 'fast_check_missing');
});

test('invariant: the table in references/prove.md equals TAGS row for row', () => {
  const md = readFileSync(new URL('../references/prove.md', import.meta.url), 'utf8');
  const sec = md.slice(md.indexOf('## Risk-triggered test kinds (T1-S)'));
  const doc = {};
  for (const m of sec.matchAll(/^\| (`[^|]+`) \| (`[^|]+`) \|$/gm)) {
    const tags = [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]); const kinds = [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]).sort();
    for (const t of tags) doc[t] = kinds;
  }
  assert.deepEqual(doc, Object.fromEntries(Object.entries(TK.TAGS).map(([t, k]) => [t, [...k].sort()])));
});
