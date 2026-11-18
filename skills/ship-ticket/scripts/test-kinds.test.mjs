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

// ---- FAIL-CLOSED RECOGNITION (generic over TK.MARKERS). Tags [R#] are the mutation targets of test-kinds-mutation.test.mjs ----
// One plan carrying EVERY marker, all from real producers (L8): risk-floor.mjs assess (record and reassess lines, inside the
// plan.md header comment), security-plan.mjs selectControls + renderSection3a (pairs line and machine block), RUN-STATE.
const FULL_SEL = (() => {
  const cat = SP.loadCatalog();
  const facts = Object.fromEntries(Object.entries(VAPT.fact_vocabulary).filter(([, v]) => v.type === 'bool').map(([k]) => [k, false]));
  const surfaces = [{ boundary_id: 'GET /a/:id', kind: 'request-handler', path: 'src/a.ts', principals: ['anonymous'] }];
  const sel = SP.selectControls(cat, { security_policy: 2, surfaces, facts: { ...facts, boundaries: ['request-handler'], principals: ['anonymous'] },
    evidence: Object.fromEntries(Object.keys(facts).map((k) => [k, 'src/a.ts:handler'])) });
  assert.equal(sel.ok, true, JSON.stringify(sel));
  return sel;
})();
const reassessLine = () => {
  const d = RF.validateDeclaration({ version: 1, classes: [{ name: 'tenancy', floor: 'ELEVATED', globs: ['src/**'] }] });
  const r = RF.assess({ paths: ['src/x.ts'], declaration: d, claimed: 'ELEVATED', ai: 'ELEVATED', baseSha: FB, headLabel: 'worktree' });
  return `risk_reassess: ${r.record_line}`;
};
const FULL = ['# Plan: invoice route', '', '<!--', `     ${realFloor(['tenancy'])}`, `     ${reassessLine()}`, '-->', '',
  'The `risk-floor.mjs check` and `security-plan.mjs select` outputs are pasted below; this test triggers a reload and the risk floor is ELEVATED.', '',
  'test-triggers: async-state', 'lifecycle-item: L1 dismissing one banner keeps the other', 'test-waiver: L1 owner: covered by the e2e suite', '',
  '### 3a. Security risk assessment', SP.renderSection3a(FULL_SEL), '',
  '<!-- RUN-STATE:BEGIN -->', '{"event":"START"}', 'test-triggers: money', '<!-- RUN-STATE:END -->', ''].join('\n');
const lineOf = (text, pred) => { const ls = text.split('\n').filter(pred); assert.equal(ls.length, 1); return ls[0]; };
/** Per marker: the raw line in FULL that carries it, and the exact key text the near-miss corpus damages. */
const SITES = {
  'test-triggers': { line: 'test-triggers: async-state', key: 'test-triggers:' },
  'lifecycle-item': { line: 'lifecycle-item: L1 dismissing one banner keeps the other', key: 'lifecycle-item:' },
  'test-waiver': { line: 'test-waiver: L1 owner: covered by the e2e suite', key: 'test-waiver:' },
  'risk-floor': { line: lineOf(FULL, (l) => l.includes('risk_floor:')), key: 'risk_floor: risk-floor:' },
  classes: { line: lineOf(FULL, (l) => l.includes('risk_floor:')), key: 'classes=' },
  'security-plan': { line: lineOf(FULL, (l) => l.startsWith('<!-- security-plan: ')), key: '<!-- security-plan: ' },
  'security-pairs': { line: lineOf(FULL, (l) => l.startsWith('security-pairs ')), key: 'security-pairs ' },
  'run-state': { line: '<!-- RUN-STATE:BEGIN -->', key: '<!-- RUN-STATE:BEGIN -->' },
};
const BASE = req(FULL);
const swapOnce = (text, from, to) => { assert.equal(text.split(from).length, 2, `exactly one ${JSON.stringify(from.slice(0, 40))}`); return text.replace(from, () => to); };
/** The near-miss corpus for one key inside one line: separator, invisible, case, delimiter, width and decoration mutations. */
function nearMissKeys(key) {
  const out = new Set();
  for (const d of ['\u2011', '\u2010', '\u2013', '\u2212', '\uFF0D', '\u2E3A', '--', ' - ', '\u00AD-', '-\u200B', '\\-', '-\uFE0F']) out.add(key.replace(/[-_]/g, d));
  out.add(key.replace(/[-_]/g, (c) => (c === '-' ? '_' : '-')));
  for (const z of ['\u200B', '\u2060', '\u00AD', '\uFEFF', '\uFE0F', '\u034F', '\u3164']) out.add(`${key[0]}${z}${key.slice(1)}`);
  const i = key.search(/[a-z]/i); out.add(key.slice(0, i) + String.fromCharCode(key.charCodeAt(i) + 0xfee0) + key.slice(i + 1)); // fullwidth letter
  out.add(key.toUpperCase()); out.add(key.toLowerCase()); out.add(key.slice(0, i) + (key[i] === key[i].toUpperCase() ? key[i].toLowerCase() : key[i].toUpperCase()) + key.slice(i + 1));
  for (const s of ['\t', '\u00A0', '\u2003', '  ', '']) if (key.includes(' ')) out.add(key.replace(/ /g, s));
  for (const [c, alts] of [[':', ['', '::', ' :', '=', '\t:']], ['=', ['', '==', ' =', ':', '\t=']]]) if (key.includes(c)) for (const a of alts) out.add(key.replace(c, a));
  out.delete(key);
  return [...out];
}
/** Every mutant of FULL for one marker: [label, text, keyDamaged]. Key mutants appear in place AND as an extra line beside the intact one. */
function corpus(id) {
  const { line, key } = SITES[id];
  const at = line.indexOf(key); assert.ok(at >= 0, id);
  const out = [];
  for (const k of nearMissKeys(key)) {
    const bad = line.slice(0, at) + k + line.slice(at + key.length);
    out.push([`key ${JSON.stringify(k)}`, swapOnce(FULL, line, bad), k], [`extra ${JSON.stringify(k)}`, swapOnce(FULL, line, `${line}\n${bad}`), k]);
  }
  for (const [label, l] of [['bullet', `- ${line}`], ['star', `* ${line}`], ['quote', `> ${line}`], ['code span', `\`${line}\``], ['nbsp indent', `\u00A0${line}`],
    ['bom', `\uFEFF${line}`], ['trailing text', `${line} trailing`], ['trailing tab', `${line}\t`], ['crlf line', `${line}\r`], ['fenced', `\`\`\`\n${line}\n\`\`\``],
    ['duplicated', `${line}\n${line}`], ['line separator', `${line}\u2028x`]]) out.push([label, swapOnce(FULL, line, l), false]);
  out.push(['copy above everything', swapOnce(FULL, '# Plan: invoice route\n', `# Plan: invoice route\n${line}\n`), false]);
  out.push(['whole plan CRLF', FULL.replace(/\n/g, '\r\n'), false]);
  return out;
}

test('[R0] fail-closed fixture: the full plan is required, and every marker contributes (no vacuous base)', () => {
  assert.equal(BASE.status, 'required', JSON.stringify(BASE.errors));
  assert.deepEqual(BASE.kinds, ['error-twin', 'negative', 'ownership', 'real-entrypoint', 'stale-N2']); // async-state + tenancy + request-handler
  assert.deepEqual(BASE.items, ['L1']); assert.deepEqual(BASE.waiver_requested, ['L1']);
  assert.deepEqual(Object.keys(SITES).sort(), TK.MARKERS.map((m) => m.id).sort(), 'the corpus covers every row of the table');
  for (const m of TK.MARKERS) assert.ok(TK.carriers(FULL, m).length >= 1, `${m.id} is present in the fixture`);
  const without = (l) => req(swapOnce(FULL, `${l}\n`, ''));
  assert.deepEqual(without(SITES['test-triggers'].line).errors, ['plan_tags_missing']);
  assert.deepEqual(without(SITES['lifecycle-item'].line).errors, ['waiver_invalid'], 'the waiver names the item');
  assert.deepEqual(req(swapOnce(FULL, `${SITES['test-waiver'].line}\n`, '')).waiver_requested, []);
  assert.deepEqual(without(SITES['risk-floor'].line).errors, ['risk_floor_missing']);
  assert.ok(!without(SITES['security-plan'].line).kinds.length, 'without the block the plan is refused');
  assert.deepEqual(req(FULL.replace('<!-- RUN-STATE:BEGIN -->\n', '').replace('<!-- RUN-STATE:END -->\n', '')).errors, ['plan_line_invalid'], 'RUN-STATE hides a worker line');
  assert.deepEqual(req(swapOnce(FULL, SITES.classes.line, SITES.classes.line.replace('classes=tenancy', 'classes=none'))).kinds.includes('ownership'), false, 'the classes field adds ownership');
});

test('[R1] invariant: every near miss of every marker is a refusal carrying a code, or the identical parse; never a silent drop', (t) => {
  let n = 0, refusedWithCode = 0, identical = 0;
  for (const m of TK.MARKERS) {
    for (const [label, text, keyDamaged] of corpus(m.id)) {
      n++;
      assert.notEqual(text, FULL, `${m.id} ${label}: the mutant differs from the base`);
      const r = req(text);
      const why = `${m.id} / ${label}: ${r.status} ${JSON.stringify(r.errors)} ${JSON.stringify(r.kinds)}`;
      // the one key variant the producer's own grammar accepts: `risk_floor:` then [ \t]* then `risk-floor:` (risk-floor.mjs RECORD)
      const producerForm = m.id === 'risk-floor' && label.startsWith('key ') && /^risk_floor:[ \t]*risk-floor:$/.test(keyDamaged);
      if (keyDamaged && !producerForm) {
        assert.equal(r.status, 'refused', `a damaged key is never read as absent or as valid: ${why}`);
        assert.ok(r.errors.includes(m.code), `a damaged key refuses with the marker's own code: ${why}`);
      }
      if (label === 'fenced') assert.deepEqual(r, BASE, `a marker inside a code fence counts like any other line: ${why}`);
      if (r.status === 'refused') {
        assert.ok(r.errors.length > 0 && r.kinds.length === 0, why);
        refusedWithCode++;
      } else { assert.deepEqual(r, BASE, `not refused, so identical: ${why}`); identical++; }
    }
  }
  assert.ok(n >= 450 && refusedWithCode >= 400 && identical >= 40, `corpus size ${n}, refused ${refusedWithCode}, identical ${identical}`);
  t.diagnostic(`near-miss corpus: ${n} mutants over ${TK.MARKERS.length} markers; refused ${refusedWithCode}, identical ${identical}, silent drops 0`);
});

test('[R2] monotonicity: adding any near-miss marker line to a required plan yields a refusal or a superset of its kinds and items', (t) => {
  // bases: the full plan, and the full plan with optional markers removed (each still required)
  const drop = (t, ...ls) => ls.reduce((x, l) => swapOnce(x, `${l}\n`, ''), t);
  const sec = SP.renderSection3a(FULL_SEL);
  const bases = [FULL, drop(FULL, SITES['test-waiver'].line), drop(FULL, SITES['test-waiver'].line, SITES['lifecycle-item'].line), swapOnce(FULL, `${sec}\n`, '')];
  const fullLines = new Set(FULL.split('\n'));
  const nearLines = new Set(TK.MARKERS.flatMap((m) => corpus(m.id).flatMap(([, t]) => t.split(/\r?\n/).filter((l) => !fullLines.has(l)))));
  assert.ok(nearLines.size >= 150, `distinct near-miss lines ${nearLines.size}`);
  let n = 0;
  for (const base of bases) {
    const b = req(base);
    assert.equal(b.status, 'required', JSON.stringify(b.errors));
    for (const nl of nearLines) for (const at of ['# Plan: invoice route\n', '<!-- RUN-STATE:BEGIN -->']) {
      const r = req(swapOnce(base, at, at.startsWith('#') ? `${at}${nl}\n` : `${nl}\n${at}`)); n++;
      if (r.status === 'refused') { assert.ok(r.errors.length > 0); continue; }
      assert.equal(r.status, 'required', JSON.stringify(nl));
      for (const k of b.kinds) assert.ok(r.kinds.includes(k), `${JSON.stringify(nl)}: kind ${k} kept`);
      for (const i of b.items) assert.ok(r.items.includes(i), `${JSON.stringify(nl)}: item ${i} kept`);
    }
  }
  assert.ok(n >= 1200, `monotonicity cases ${n}`);
  t.diagnostic(`monotonicity: ${n} cases (${nearLines.size} near-miss lines x ${bases.length} bases x 2 positions)`);
});

test('[R3] the reported case: a tab after `security-plan:` with triggers none and classes=none refuses (CLI check never passes empty titles)', () => {
  const p = `# Plan\n\ntest-triggers: none\n${realFloor()}\n\n${SP.renderSection3a(FULL_SEL)}\n${RS}`;
  assert.deepEqual(req(p).kinds, ['negative', 'real-entrypoint']);
  for (const bad of ['<!--\tsecurity-plan: ', '<!-- security-plan:\t', '<!-- Security-Plan: ', '<!-- security_plan: ', '<!--security-plan: ', '<!-- security-plan : ']) {
    const t = swapOnce(p, '<!-- security-plan: ', bad);
    const r = req(t);
    assert.equal(r.status, 'refused', bad); assert.ok(r.errors.includes('security_block_invalid'), `${JSON.stringify(bad)} -> ${r.errors}`);
    assert.equal(TK.checkTitles(r, []).status, 'refused');
  }
  const pairsOnly = p.split('\n').filter((l) => !l.startsWith('<!-- security-plan: ')).join('\n');
  assert.deepEqual(req(pairsOnly).errors, ['security_block_invalid'], 'a pairs line without its block is a refusal, not absence');
  const r = repo(null);
  const pf = file(swapOnce(p.replace(FB, r.base.slice(0, 12)), '<!-- security-plan: ', '<!-- security-plan:\t'), 'plan.md');
  const c = cli(['check', '--repo', r.dir, '--base', r.base, '--plan', pf, '--titles', '[]']);
  assert.equal(c.status, 1); assert.equal(json(c).status, 'refused'); assert.deepEqual(json(c).errors, ['security_block_invalid']);
});

test('[R4] RUN-STATE: a duplicated or damaged marker never hides the narrative; an unopted plan stays not_declared', () => {
  const hidden = swapOnce(FULL, '# Plan: invoice route\n', '# Plan: invoice route\n<!-- RUN-STATE:BEGIN -->\n');
  assert.deepEqual(req(hidden).errors, ['run_state_invalid'], 'a BEGIN above the trigger line cannot hide it');
  assert.deepEqual(req(FULL.replace('<!-- RUN-STATE:END -->', '<!-- RUN-STATE:END -->\n<!-- RUN-STATE:END -->')).errors, ['run_state_invalid']);
  assert.deepEqual(req(FULL.replace('<!-- RUN-STATE:END -->', '<!-- run-state:end -->')).errors, ['run_state_invalid']);
  const onlyInside = `# Plan\n\n<!-- RUN-STATE:BEGIN -->\n<!-- RUN-STATE:BEGIN -->\ntest-triggers: money\n<!-- RUN-STATE:END -->\n`;
  assert.deepEqual(req(onlyInside).errors, ['run_state_invalid'], 'malformed RUN-STATE: the whole plan is scanned for opt-in');
  assert.equal(req(`# Plan\n\nnothing\n<!-- RUN-STATE:BEGIN -->\n<!-- RUN-STATE:BEGIN -->\n`).status, 'not_declared', 'no opt-in token anywhere: still not_declared');
  assert.deepEqual(req(`# Plan\n\nnothing\n<!-- RUN-STATE:BEGIN -->\n`, TK.validateDeclaration({ version: 1 })).errors, ['run_state_invalid'], 'a declaring repo opts in');
  // a real START event names the marker in its text (StoreCraft SCRUM-73: "digest_scope":"file bytes before RUN-STATE:BEGIN")
  const event = '{"event":"START","run_id":"r1","digest_scope":"file bytes before RUN-STATE:BEGIN","note":"<!-- RUN-STATE:END -->"}';
  assert.deepEqual(req(swapOnce(FULL, '{"event":"START"}', event)), BASE, 'an event record may name the markers');
  // the region is cut at whole marker LINES: the exact BEGIN text inside an earlier line hides nothing
  const inline = swapOnce(FULL, '# Plan: invoice route\n', '# Plan: invoice route\n{"note":"<!-- RUN-STATE:BEGIN -->"}\n');
  // the engine (run-engine.mjs: parsePlanSecurityBlock(plan)) cuts at that substring and loses the block: the two readings disagree, so refuse
  assert.deepEqual(req(inline).errors, ['security_block_invalid']);
});

// ---- ONE narrative interpretation (Codex F1): the recogniser and every downstream parse read planNarrative's cut; the engine's
// own substring cut of the raw plan must agree, else refusal ----
const EMPTY_SEL = (() => {
  const facts = Object.fromEntries(Object.entries(VAPT.fact_vocabulary).filter(([, v]) => v.type === 'bool').map(([k]) => [k, false]));
  const sel = SP.selectControls(SP.loadCatalog(), { security_policy: 2, surfaces: [], facts: { ...facts, boundaries: [], principals: [] },
    evidence: Object.fromEntries(Object.keys(facts).map((k) => [k, 'src/a.ts:handler'])) });
  assert.equal(sel.ok, true, JSON.stringify(sel));
  return sel;
})();
const J = (x) => `{"note":"${x}"}`;
const RS_B = '<!-- RUN-STATE:BEGIN -->', RS_E = '<!-- RUN-STATE:END -->';
/** The composed counterexample and its variants: [label, plan]. Each wraps the request-handler block in fake or doubled markers. */
const SPLIT_CORPUS = (() => {
  const head = `# Plan\n\ntest-triggers: none\n${realFloor()}\n`, rh = SP.renderSection3a(FULL_SEL), empty = SP.renderSection3a(EMPTY_SEL);
  const wrap = (open, close, tail = `\n${empty}`) => `${head}${open}\n${rh}\n${close}${tail}\n${RS}`;
  return [
    ['Codex F1: JSON-string markers around the block, an empty block after', wrap(J(RS_B), J(RS_E))],
    ['JSON-string markers around the only block', wrap(J(RS_B), J(RS_E), '')],
    ['JSON-string BEGIN only', wrap(J(RS_B), 'x', '')],
    ['code-span markers', wrap(`\`${RS_B}\``, `\`${RS_E}\``, '')],
    ['marker text inside prose', wrap(`The ${RS_B} marker starts the log.`, `The ${RS_E} marker ends it.`, '')],
    ['doubled exact markers', wrap(RS_B, RS_E, '')],
    ['nested BEGIN BEGIN END END', `${head}${RS_B}\n${RS_B}\n${rh}\n${RS_E}\n${RS_E}\n`],
    ['END before BEGIN', `${head}${RS_E}\n${rh}\n${RS_B}\n`],
    ['unbalanced: BEGIN, block, no END', `${head}${RS_B}\n${rh}\n`],
    // Opus M-1: an event record holding a literal marker moves the engine's substring cut while the line cut stays put
    ['Opus M-1: event line with a literal END inside the region, block after it', `${head}${RS_B}\n{"event":"NOTE","text":"${RS_E}"}\n${rh}\n${RS_E}\n`],
    ['event line with a literal END before BEGIN, block inside the region', `${head}{"event":"NOTE","text":"${RS_E}"}\n${RS_B}\n${rh}\n${RS_E}\n`],
    ['event line with a literal BEGIN before the block, region after', `${head}{"event":"NOTE","text":"${RS_B}"}\n${rh}\n${RS_B}\n${RS_E}\n`],
    ['event line with a literal BEGIN inside the region', `${head}${rh}\n${RS_B}\n{"event":"NOTE","text":"${RS_B}"}\n${RS_E}\n`],
    ['markers split across lines', `${head}<!-- RUN-STATE:\nBEGIN -->\n${rh}\n<!-- RUN-STATE:\nEND -->\n`],
  ];
})().flatMap(([label, p]) => [[label, p], [`${label} (CRLF)`, p.replace(/\n/g, '\r\n')]]);
const surfaceKinds = (block) => uniq2((block?.surfaces ?? []).flatMap((s) => TK.SURFACE_TAGS[s.kind] ?? []).flatMap((t) => TK.TAGS[t]));
function uniq2(xs) { return [...new Set(xs)].sort(); }

test('[R6] the composed counterexample and its variants never drop the request-handler kinds: refused, or the kinds stay', () => {
  for (const [label, p] of SPLIT_CORPUS) {
    const r = req(p);
    if (r.status === 'refused') { assert.ok(r.errors.length > 0, label); assert.equal(TK.checkTitles(r, []).status, 'refused', label); continue; }
    assert.equal(r.status, 'required', label);
    for (const k of ['negative', 'real-entrypoint']) assert.ok(r.kinds.includes(k), `${label}: ${k} kept (${r.kinds})`);
  }
  const codex = req(SPLIT_CORPUS[0][1]);
  assert.equal(codex.status, 'refused'); assert.ok(codex.errors.includes('security_block_invalid'), String(codex.errors));
  assert.notEqual(TK.checkTitles(codex, []).status, 'pass', 'empty titles never pass the composed case');
  for (const [label, p] of SPLIT_CORPUS.filter(([l]) => /literal END|Opus M-1/.test(l))) {
    const r = req(p);
    assert.equal(r.status, 'refused', label); assert.ok(r.errors.includes('security_block_invalid'), `${label}: ${r.errors}`);
  }
  // the exported option refuses uncut text instead of reading the RUN-STATE body (Opus m-1)
  const uncut = `# Plan\n\n${RS_B}\n${SP.renderSection3a(FULL_SEL)}\n${RS_E}\n`;
  assert.equal(SP.parsePlanSecurityBlock(uncut, { alreadyCut: true }), null);
  assert.equal(SP.parsePlanSecurityBlock(uncut.replace(/\n/g, '\r\n'), { alreadyCut: true }), null);
  assert.notEqual(SP.parsePlanSecurityBlock(TK.planNarrative(uncut.replace(RS_B, '').replace(RS_E, '')), { alreadyCut: true }), null, 'cut text parses');
  // DISCLOSED RESIDUAL (S-01b2, plan trust): ONE well-formed exact RUN-STATE pair wrapped around narrative hides it, and both
  // readings agree on that. Pinned so a change to it is visible, not because it is desired.
  const wrapped = `# Plan\n\ntest-triggers: none\n${realFloor()}\n${RS_B}\n${SP.renderSection3a(FULL_SEL)}\n${RS_E}\n`;
  assert.deepEqual(req(wrapped).kinds, []);
  assert.deepEqual(SP.parsePlanSecurityBlock(TK.planNarrative(wrapped), { alreadyCut: true }), SP.parsePlanSecurityBlock(wrapped));
});

test('[R7] differential: whenever a plan is required, the recogniser narrative and the engine reading parse the same block and its kinds are required', (t) => {
  const plans = [...SPLIT_CORPUS.map(([, p]) => p), FULL, ...TK.MARKERS.flatMap((m) => corpus(m.id).map(([, p]) => p))];
  let required = 0, withBlock = 0;
  for (const p of plans) {
    const r = req(p);
    if (r.status !== 'required') { assert.equal(r.status, 'refused'); continue; }
    required++;
    const pre = SP.parsePlanSecurityBlock(TK.planNarrative(p), { alreadyCut: true }), engine = SP.parsePlanSecurityBlock(p);
    assert.deepEqual(pre, engine, 'one narrative: both readings parse the same block');
    if (engine) withBlock++;
    for (const k of surfaceKinds(engine)) assert.ok(r.kinds.includes(k), `surface kind ${k} is required`);
  }
  assert.ok(required >= 50 && withBlock >= 50, `required ${required}, with a block ${withBlock}`);
  t.diagnostic(`differential: ${plans.length} plans, ${required} required, ${withBlock} with a block; every one agrees`);
});

test('[R5] benign text is not a marker: prose, script names and the reassess record line keep the plan required; prose does not opt in', () => {
  assert.equal(BASE.status, 'required'); // FULL already carries prose, `risk-floor.mjs`, `security-plan.mjs` and a real risk_reassess line
  for (const prose of ['This test triggers a reload.', 'The risk floor is ELEVATED and the security plan is attached.', 'Each lifecycle item and test waiver is listed.',
    'See risk-floor.mjs, risk_floor.mjs, risk-floor.test.mjs, security-plan.mjs and scripts/run-state.mjs.', 'Run `ship-ready-check.mjs check --run-state <plan>`.',
    'The runState, lifecycleItem and testTriggers identifiers, and the testtriggers flag, stay.',
    // real-plan prose (650 real, unopted plans scanned): bare words without their marker syntax
    '## RUN-STATE', 'The plan file excluding the RUN-STATE block; the run_state table.', '| Security-plan size (owner decision) | branch feat/x-security-plan |',
    '`bindSecurity` refuses `security_pairs_mismatch`; the security-pairs are listed.']) {
    assert.equal(req(`# Plan\n\n${prose}\n${RS}`).status, 'not_declared', prose);
    assert.deepEqual(req(swapOnce(FULL, '\n\ntest-triggers:', `\n\n${prose}\ntest-triggers:`)), BASE, prose);
  }
  for (const near of ['the test-triggers line', 'a test_triggers variable', 'RUN_STATE:BEGIN', 'run-state end', '<!- security-plan {"policy":2} -->', 'security-plan= {}', '"selection_digest": "sha256:00"', 'security_pairs: sha256:00', '<!-- security_plan -->', 'security_plan: none', 'Test triggers: money', 'lifecycle item: L2 x', 'Test Waiver : L1 x', 'test\\-triggers: money', 'test\uFE0F-triggers: money', 'risk_floor: see below', 'RISK_FLOOR: ELEVATED', 'risk\u2011floor: ELEVATED', 'a stray classes=tenancy']) {
    const r = req(swapOnce(FULL, '\n\ntest-triggers:', `\n\n${near}\ntest-triggers:`));
    assert.equal(r.status, 'refused', near); assert.ok(r.errors.length > 0);
  }
  assert.deepEqual(req(`# Plan\n\nThe test\u2011triggers line is missing.\n${RS}`).errors, ['plan_line_invalid', 'plan_tags_missing', 'risk_floor_missing'], 'a non-breaking hyphen opts in');
  // Opus M1/M2: Markdown- or HTML-formatted plan keys refuse, opted in or not
  for (const k of ['**Test triggers**: money', '_Test triggers_: money', '`Test triggers`: money', '<b>test-triggers</b>: money', '<b>Test triggers</b>: money', '<code>lifecycle item</code>: L2 x', 'test&#45;triggers: money',
    'test&#x2D;triggers: money', 'test&hyphen;triggers: money', 'lifecycle&lowbar;item: L2 x', 'test-waiver&colon; L1 x', '__Test Waiver__ : L1 x']) {
    const alone = req(`# Plan\n\n${k}\n${RS}`);
    assert.equal(alone.status, 'refused', `${k} alone: ${alone.status}`);
    const r = req(swapOnce(FULL, '\n\ntest-triggers:', `\n\n${k}\ntest-triggers:`));
    assert.equal(r.status, 'refused', k);
  }
  // Opus M4: a token starts a word, so these neither opt in nor refuse
  for (const prose of ['The latest waiver: none.', 'contest triggers: none', 'a protest-waiver was filed', 'attest-triggers', 'brisk-floor']) {
    assert.equal(req(`# Plan\n\n${prose}\n${RS}`).status, 'not_declared', prose);
    assert.deepEqual(req(swapOnce(FULL, '\n\ntest-triggers:', `\n\n${prose}\ntest-triggers:`)), BASE, prose);
  }
  // Opus M3: the plan.md template guidance prose kept in an opted-in plan does not refuse (read from the shipped template)
  const tpl = readFileSync(new URL('../references/plan.md', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('Deferred: a plan-record check'));
  assert.equal(tpl.length, 1);
  assert.deepEqual(req(swapOnce(FULL, '\n\ntest-triggers:', `\n\n${tpl[0]}\ntest-triggers:`)), BASE, 'plan.md template prose');
  const noReassess = swapOnce(FULL, `     ${reassessLine()}\n`, '');
  assert.deepEqual(req(noReassess), BASE, 'the reassess line adds and removes nothing');
  assert.deepEqual(req(swapOnce(FULL, 'risk_reassess: ', 'Risk_Reassess: ')).errors, ['risk_floor_invalid'], 'a damaged reassess key is not ignored');
});

// ---- S-01b2 P3: requirement provenance (optIn, provenance, kindsForClasses, PROTECTED_TAGS, the declaration `tests` key) ----
// None of these tests is tagged [R#]: test-kinds-mutation.test.mjs runs only the #83 tagged tests against its mutants.
/** Every plan the #83 tests build (the full fixture, every near-miss mutant, the RUN-STATE split corpus, near-miss lines added to FULL, and small plans). */
const P3_PLANS = (() => {
  const fullLines = new Set(FULL.split('\n'));
  const mutants = TK.MARKERS.flatMap((m) => corpus(m.id).map(([, p]) => p));
  const nearLines = [...new Set(mutants.flatMap((p) => p.split(/\r?\n/).filter((l) => !fullLines.has(l))))];
  return [FULL, ...mutants, ...SPLIT_CORPUS.map(([, p]) => p), ...nearLines.map((nl) => swapOnce(FULL, '# Plan: invoice route\n', `# Plan: invoice route\n${nl}\n`)),
    ...nearLines.map((nl) => `# Plan\n\n${nl}\n${RS}`), plan('x'), plan('test-triggers: none'), plan('test-triggers: async-state, ui-lifecycle', 'lifecycle-item: L1 x', 'test-waiver: race n/a', floorLine('tenancy')),
    plan('test-triggers: none', realFloor(['billing_core', 'tenancy'])), plan('test-triggers: none', realFloor([], { changed: true })), planRaw('test-triggers: none'), plan('nothing here', floorLine('tenancy'))];
})();
const P3_DECLS = [null, TK.validateDeclaration({ version: 1, tags: { 'feature-flags': ['negative', 'lifecycle-destroy'], money: ['regression'] }, classes: { billing_core: ['money', 'feature-flags'], tenancy: ['repair'] } }), TK.validateDeclaration({ version: 1 })];
const omitProvenance = ({ provenance, ...rest }) => rest;
const p3Digest = (fn) => {
  const h = createHash('sha256');
  for (const p of P3_PLANS) for (const d of P3_DECLS) for (const baseSha of [null, FB]) h.update(`${JSON.stringify(fn({ planText: p, declaration: d, baseSha }))}\n`);
  return h.digest('hex');
};

test('P3 AC5/L5 differential: requiredFor without `provenance` equals the #83 output on every corpus plan (golden captured on main 5a29114 before the change)', () => {
  assert.ok(P3_PLANS.length >= 900, `corpus plans ${P3_PLANS.length}`);
  const statuses = new Set(P3_PLANS.flatMap((p) => P3_DECLS.map((d) => TK.requiredFor({ planText: p, declaration: d }).status)));
  assert.deepEqual([...statuses].sort(), ['not_declared', 'refused', 'required'], 'the corpus reaches every status');
  assert.equal(p3Digest((a) => omitProvenance(TK.requiredFor(a))), '739efb1cfde46022671d680beddc5933c6d3d2768573913af3bb43002e40cbae');
});

test('P3 AC1: optIn equals the #83 opt-in expression and requiredFor\'s own opt-in on every corpus plan, its CRLF copy, and every declaration', () => {
  // the #83 predicate, verbatim from main 5a29114 test-kinds.mjs:189, rebuilt from its exports: the oracle optIn must equal
  const oracle = (p, d) => Boolean(d) || TK.MARKERS.some((m) => m.opt_in && TK.carriers(TK.planNarrative(p) ?? p, m).length);
  const seen = new Set();
  for (const p of P3_PLANS) for (const text of [p, p.replace(/\r?\n/g, '\r\n')]) for (const d of P3_DECLS) {
    const o = TK.optIn({ planText: text, declaration: d });
    assert.equal(typeof o, 'boolean');
    assert.equal(o, oracle(text, d), JSON.stringify(text.slice(0, 80)));
    assert.equal(o, TK.requiredFor({ planText: text, declaration: d }).status !== 'not_declared', JSON.stringify(text.slice(0, 80)));
    seen.add(o);
  }
  assert.deepEqual([...seen].sort(), [false, true], 'both outcomes occur in the corpus');
  // total: a plan that is not a string is opted in (requiredFor refuses it, never `not_declared`)
  for (const planText of [undefined, null, 1, {}, [], new String('# Plan'), Buffer.from('test-triggers: none')]) {
    assert.equal(TK.optIn({ planText }), true, String(planText)); assert.equal(TK.requiredFor({ planText }).status, 'refused');
  }
  assert.equal(TK.optIn(), true, 'no argument at all is not "nothing declared"');
  // every MARKERS opt-in carrier, valid and near miss, opts in alone; prose does not
  for (const m of TK.MARKERS.filter((x) => x.opt_in)) for (const [, p] of corpus(m.id)) assert.equal(TK.optIn({ planText: p }), true, m.id);
  assert.equal(TK.optIn({ planText: `# Plan\n\nThis test triggers a reload.\n${RS}` }), false);
});

const sourcesOk = (r, decl) => {
  const table = { ...TK.TAGS, ...Object.fromEntries(Object.entries(decl?.tags ?? {}).map(([t, ks]) => [t, uniqSorted([...(TK.TAGS[t] ?? []), ...ks])])) };
  for (const [k, srcs] of Object.entries(r.provenance)) {
    assert.ok(srcs.length > 0 && srcs.every((s) => /^(tag|class|surface):[A-Za-z0-9_-]+$/.test(s)), `${k}: ${srcs}`);
    assert.deepEqual(srcs, uniqSorted(srcs), 'sorted and unique');
    const viaTags = srcs.filter((s) => s.startsWith('tag:')).map((s) => s.slice(4));
    assert.ok(viaTags.length > 0 && viaTags.every((t) => r.tags.includes(t) && table[t].includes(k)), `${k}: every tag source is a required tag whose row has the kind`);
  }
  for (const t of r.tags) for (const k of table[t]) assert.ok(r.provenance[k].includes(`tag:${t}`), `${t} -> ${k} recorded`);
};
test('P3 AC2: provenance keys equal the kinds set on every corpus output (CRLF copy too); each source names a tag whose row requires the kind', () => {
  let required = 0;
  for (const p of P3_PLANS) for (const d of P3_DECLS) {
    const r = TK.requiredFor({ planText: p, declaration: d });
    assert.deepEqual(Object.keys(r.provenance), r.kinds, 'keys equal the kinds, in the same sorted order');
    if (r.status !== 'required') { assert.deepEqual(r.provenance, {}); continue; }
    required++; sourcesOk(r, d);
    assert.deepEqual(TK.requiredFor({ planText: p.replace(/\r?\n/g, '\r\n'), declaration: d }).provenance, r.provenance, 'CRLF copy (L10)');
  }
  assert.ok(required >= 200, `required outputs ${required}`);
  // pinned on the full fixture (async-state plan tag, tenancy floor class, request-handler surface)
  assert.deepEqual(BASE.provenance, {
    'error-twin': ['tag:async-state'], 'stale-N2': ['tag:async-state'],
    negative: ['class:tenancy', 'surface:request-handler', 'tag:async-state', 'tag:input-path', 'tag:tenancy'],
    ownership: ['class:tenancy', 'tag:tenancy'], 'real-entrypoint': ['surface:request-handler', 'tag:entrypoint'] });
  // a declared class reaches a protected tag: the kind carries both the class and the tag
  const d = P3_DECLS[1];
  const r = TK.requiredFor({ planText: plan('test-triggers: none', realFloor(['billing_core'])), declaration: d });
  assert.deepEqual(r.provenance, { 'lifecycle-destroy': ['class:billing_core', 'tag:feature-flags'], negative: ['class:billing_core', 'tag:feature-flags', 'tag:money'], race: ['class:billing_core', 'tag:money'], regression: ['class:billing_core', 'tag:money'] });
  // the CLI prints it, and a CLI-level refusal carries an empty one
  const repoDir = repo(null);
  const a = json(cli(['require', '--repo', repoDir.dir, '--base', repoDir.base, '--plan', file(plan('test-triggers: entrypoint', realFloor([], { base: repoDir.base.slice(0, 12) })), 'plan.md')]));
  assert.deepEqual(a.provenance, { 'real-entrypoint': ['tag:entrypoint'] });
  assert.deepEqual(json(cli(['require', '--repo', repoDir.dir, '--base', 'no-such-ref', '--plan', file(plan('x'), 'p.md')])), { status: 'refused', kinds: [], items: [], waiver_requested: [], tags: [], errors: ['base_invalid'], provenance: {} });
});

test('P3: PROTECTED_TAGS is frozen, names table tags, and with provenance decides protection (tag reached directly, through a class, or a surface)', () => {
  assert.deepEqual([...TK.PROTECTED_TAGS].sort(), ['auth', 'money', 'tenancy']); assert.ok(Object.isFrozen(TK.PROTECTED_TAGS));
  for (const t of TK.PROTECTED_TAGS) assert.ok(Object.hasOwn(TK.TAGS, t), t);
  const isProtected = (srcs) => srcs.some((s) => s.startsWith('surface:') || (s.startsWith('tag:') && TK.PROTECTED_TAGS.includes(s.slice(4))));
  const prot = (r) => r.kinds.filter((k) => isProtected(r.provenance[k]));
  assert.deepEqual(prot(BASE), ['negative', 'ownership', 'real-entrypoint'], 'error-twin and stale-N2 come from async-state only');
  assert.deepEqual(prot(req(plan('test-triggers: money'))), ['negative', 'race'], 'directly');
  assert.deepEqual(prot(req(plan('test-triggers: none', realFloor(['billing_core'])), P3_DECLS[1])), ['negative', 'race', 'regression'], 'through a declared class mapping');
  assert.deepEqual(prot(req(plan('test-triggers: async-state'))), []);
});

const P3_CLASS_SETS = [[], ['tenancy'], ['auth', 'money'], ['billing_core'], ['billing_core', 'tenancy'], [TK.CHANGED], [TK.CHANGED, 'concurrency'], ['constructor'], ['unmapped-x', 'tenancy']];
/** The REAL producer's record line for a class set (risk-floor.mjs writes `risk_declaration_changed` itself, from declChanged). */
const floorFor = (classes) => realFloor(classes.filter((c) => c !== TK.CHANGED), { changed: classes.includes(TK.CHANGED) });
test('P3 AC3: kindsForClasses equals requiredFor\'s class mapping (one code path) for every class set and declaration, also restored from JSON', () => {
  let ok = 0, refused = 0;
  for (const classes of P3_CLASS_SETS) for (const d of P3_DECLS) {
    const r = TK.requiredFor({ planText: plan('test-triggers: none', floorFor(classes)), declaration: d });
    assert.ok(r.status !== 'not_declared');
    for (const declaration of [d, d && JSON.parse(JSON.stringify(d))]) {
      const k = TK.kindsForClasses({ classes, declaration });
      if (r.status === 'required') { ok++; assert.deepEqual(k, { ok: true, tags: r.tags, kinds: r.kinds, provenance: r.provenance, errors: [] }, `${classes} ${JSON.stringify(d)}`); }
      else { refused++; assert.deepEqual(r.errors, ['risk_class_unmapped']); assert.deepEqual(k, { ok: false, tags: [], kinds: [], provenance: {}, errors: ['risk_class_unmapped'] }, `${classes}`); }
    }
  }
  assert.ok(ok >= 20 && refused >= 4, `ok ${ok} refused ${refused}`);
  // one code path, structurally: the class lookup exists once in the module, inside the loop both callers run
  const src = readFileSync(SCRIPT, 'utf8');
  assert.equal(src.split('Object.hasOwn(declaration.classes, c)').length, 2); assert.equal(src.split('classTags(').length, 4, 'one definition and two callers');
  // add-only over classes: a superset of classes never loses a kind (I1 for the reassessed source)
  for (const a of P3_CLASS_SETS) for (const b of P3_CLASS_SETS) {
    const x = TK.kindsForClasses({ classes: a, declaration: P3_DECLS[1] }), y = TK.kindsForClasses({ classes: [...new Set([...a, ...b])], declaration: P3_DECLS[1] });
    if (x.ok && y.ok) for (const kind of x.kinds) assert.ok(y.kinds.includes(kind), `${a} + ${b} keeps ${kind}`);
    if (!x.ok) assert.equal(y.ok, false, 'an unmapped class stays a refusal when more classes are added');
  }
});

test('P3 AC3 / L6: kindsForClasses never throws, never calls an accessor, and refuses hostile classes or declarations with a code', () => {
  let calls = 0;
  const getter = (o, k, v) => Object.defineProperty(o, k, { enumerable: true, get() { calls++; return v; } });
  const sparse = ['tenancy']; sparse.length = 3;
  const classBad = [undefined, null, 'tenancy', { 0: 'tenancy', length: 1 }, [1], ['Tenancy'], ['none'], [''], ['a b'], sparse, getter([], '0', 'tenancy'),
    new Proxy(['tenancy'], {}), Array.from({ length: 257 }, (_, i) => `c${i}`), [`x${'a'.repeat(64)}`]];
  classBad.forEach((classes, i) => assert.deepEqual(TK.kindsForClasses({ classes }), { ok: false, tags: [], kinds: [], provenance: {}, errors: ['risk_floor_invalid'] }, `classes #${i}`));
  const ok = { tags: { 'feature-flags': ['negative'] }, classes: { billing_core: ['feature-flags'] } };
  const declBad = ['x', [], new Proxy(ok, {}), getter({}, 'classes', { billing_core: ['money'] }), { classes: getter({}, 'billing_core', ['money']) }, { classes: { billing_core: 'money' } },
    { classes: { billing_core: ['telepathy'] } }, { tags: { x: ['telepathy'] } }, { tags: { x: [] } }, { classes: { 'Bad Name': ['money'] } }, { classes: { none: ['money'] } },
    { classes: null }, { classes: ['money'] }, { classes: { [Symbol('s')]: ['money'] } }, { tags: { constructor: ['negative', 'nope'] } }];
  declBad.forEach((declaration, i) => assert.deepEqual(TK.kindsForClasses({ classes: ['billing_core'], declaration }).errors, ['declaration_invalid'], `declaration #${i}`));
  assert.equal(calls, 0, 'no accessor was ever called');
  assert.deepEqual(TK.kindsForClasses().errors, ['risk_floor_invalid']);
  assert.equal(TK.kindsForClasses({ classes: ['billing_core'], declaration: ok }).ok, true);
  // a JSON-restored (normal-prototype) declaration never resolves an inherited name
  assert.deepEqual(TK.kindsForClasses({ classes: ['constructor'], declaration: JSON.parse(JSON.stringify(P3_DECLS[1])) }).errors, ['risk_class_unmapped']);
  assert.deepEqual(TK.kindsForClasses({ classes: ['constructor'] }).errors, ['risk_class_unmapped']);
  for (const c of ['__proto__', 'toString', 'hasOwnProperty']) assert.deepEqual(TK.kindsForClasses({ classes: [c] }).errors, ['risk_floor_invalid'], `${c} is not a class name`);
});

test('P3 AC4: the declaration key `tests` is validated (globs by the #72 grammar, runner modules by RUNNER_MODULE) and fails closed', () => {
  const v = TK.validateDeclaration({ version: 1, tests: { globs: ['e2e/**/*.ts', 'src/**/*.it.ts', 'e2e/**/*.ts'], runner_modules: ['uvu', '@acme/test-kit', 'node:test', 'bun:test', 'mocha/lib/interfaces'] } });
  assert.deepEqual(v.tests, { globs: ['e2e/**/*.ts', 'src/**/*.it.ts'], runner_modules: ['@acme/test-kit', 'bun:test', 'mocha/lib/interfaces', 'node:test', 'uvu'] });
  assert.deepEqual(TK.validateDeclaration({ version: 1, tests: { globs: ['t/**'] } }).tests, { globs: ['t/**'], runner_modules: [] });
  assert.deepEqual(TK.validateDeclaration({ version: 1 }).tests, { globs: [], runner_modules: [] }, 'absent: both lists empty');
  for (const m of ['node:test', 'vitest', '@jest/globals', 'bun:test', '@playwright/test']) assert.match(m, TK.RUNNER_MODULE, `the built-in runner ${m} is in the grammar`);
  let calls = 0;
  const getter = (o, k, val) => Object.defineProperty(o, k, { enumerable: true, get() { calls++; return val; } });
  const bad = [null, [], {}, 'e2e/**', { globs: [] }, { globs: 'x' }, { globs: [1] }, { globs: ['a?b'] }, { globs: ['src/**x'] }, { globs: ['[ab]'] }, { globs: ['a\\b'] }, { globs: [''] },
    { globs: Array.from({ length: 65 }, (_, i) => `t${i}/**`) }, { extra: ['x'] }, { globs: ['t/**'], extra: 1 }, { [Symbol('s')]: ['x'] }, { runner_modules: [] },
    ...['./local', '../x', '/abs', 'vitest?x', 'vitest#f', '%76itest', 'Vitest', 'vi test', 'node:', 'node:Test', '@scope', '@scope/', 'a//b', 'a/./b', 'a/../b', 'http://x', 'vitest\n', 'é', 'file:x', 'a'.repeat(65)].map((m) => ({ runner_modules: [m] })),
    { runner_modules: Array.from({ length: 17 }, (_, i) => `r${i}`) }, { runner_modules: [null] }, new Proxy({ globs: ['t/**'] }, {}), { globs: new Proxy(['t/**'], {}) }, getter({}, 'globs', ['t/**']), { globs: getter([], '0', 't/**') }];
  bad.forEach((tests, i) => assert.throws(() => TK.validateDeclaration({ version: 1, tests }), (e) => e.code === 'declaration_invalid', `tests #${i}`));
  assert.throws(() => TK.validateDeclaration(getter({ version: 1 }, 'tests', { globs: ['t/**'] })), (e) => e.code === 'declaration_invalid');
  assert.throws(() => TK.validateDeclaration(new Proxy({ version: 1 }, {})), (e) => e.code === 'declaration_invalid');
  assert.equal(calls, 0, 'no accessor was ever called');
});

test('P3 AC4: `tests` never changes a requirement: every corpus plan reads the same with and without it', () => {
  const tests = { globs: ['e2e/**/*.ts'], runner_modules: ['uvu'] };
  const pairs = [[{ version: 1 }, { version: 1, tests }], [{ version: 1, tags: { 'feature-flags': ['negative'] }, classes: { billing_core: ['money'] } }, { version: 1, tags: { 'feature-flags': ['negative'] }, classes: { billing_core: ['money'] }, tests }]];
  for (const [a, b] of pairs) {
    const da = TK.validateDeclaration(a), db = TK.validateDeclaration(b);
    for (const p of P3_PLANS) assert.deepEqual(TK.requiredFor({ planText: p, declaration: db }), TK.requiredFor({ planText: p, declaration: da }));
  }
});

test('P3 AC4: `tests` is read from BASE only: working-tree edits and a branch-added declaration are not read; malformed at base refuses', () => {
  const tests = { globs: ['e2e/**/*.ts'], runner_modules: ['uvu'] };
  const r = repo({ version: 1, tests });
  assert.deepEqual(TK.readDeclaration(r.dir, r.base).declaration.tests, tests);
  writeFileSync(join(r.dir, TK.DECLARATION_PATH), JSON.stringify({ version: 1, tests: { globs: ['**'], runner_modules: ['evil'] } }));
  assert.deepEqual(TK.readDeclaration(r.dir, r.base).declaration.tests, tests, 'working tree ignored');
  G(r.dir, 'add', '-A'); G(r.dir, 'commit', '-q', '-m', 'branch widens the evidence scope');
  assert.deepEqual(TK.readDeclaration(r.dir, r.base).declaration.tests, tests, 'a branch commit is not the base');
  const n = repo(null);
  mkdirSync(join(n.dir, '.ship-ticket'), { recursive: true }); writeFileSync(join(n.dir, TK.DECLARATION_PATH), JSON.stringify({ version: 1, tests }));
  G(n.dir, 'add', '-A'); G(n.dir, 'commit', '-q', '-m', 'branch adds a declaration');
  assert.equal(TK.readDeclaration(n.dir, n.base).declaration, null, 'a branch-added declaration is not read');
  assert.equal(json(cli(['require', '--repo', n.dir, '--base', n.base, '--plan', file(plan('x'), 'p.md')])).status, 'not_declared', 'so it does not opt the run in either');
  for (const t of [{ globs: ['a?b'] }, { runner_modules: ['./x'] }, {}]) {
    const m = repo({ version: 1, tests: t });
    assert.throws(() => TK.readDeclaration(m.dir, m.base), (e) => e.code === 'declaration_invalid');
    const pf = file(plan('test-triggers: none', realFloor([], { base: m.base.slice(0, 12) })), 'plan.md');
    const c = cli(['require', '--repo', m.dir, '--base', m.base, '--plan', pf]);
    assert.equal(c.status, 1); assert.deepEqual(json(c).errors, ['declaration_invalid']);
  }
});

test('P3 declared deltas (L5): the only #83 behaviour changes, each pinned', () => {
  // 1. every requiredFor and CLI output carries `provenance` (pinned by AC2 and the golden differential above)
  for (const p of [plan('x'), plan('test-triggers: telepathy'), plan('test-triggers: money')]) assert.ok(Object.hasOwn(req(p), 'provenance'));
  // 2. validateDeclaration returns `tests` (empty lists when absent); 3. a `tests` key was declaration_invalid in #83 and is accepted now
  assert.deepEqual(Object.keys(TK.validateDeclaration({ version: 1 })).sort(), ['classes', 'tags', 'tests']);
  // 4. an UNVALIDATED plain-object declaration no longer resolves an inherited class name (#83 threw a TypeError for `constructor`)
  const plainDecl = { tags: {}, classes: {} };
  let r4;
  assert.doesNotThrow(() => { r4 = req(plan('test-triggers: none', realFloor(['constructor'])), plainDecl); });
  assert.deepEqual(r4.errors, ['risk_class_unmapped']);
  // 5. validateDeclaration refuses a Proxy or an accessor property instead of evaluating it
  assert.throws(() => TK.validateDeclaration(Object.defineProperty({ version: 1 }, 'tags', { enumerable: true, get: () => ({}) })), (e) => e.code === 'declaration_invalid');
});
