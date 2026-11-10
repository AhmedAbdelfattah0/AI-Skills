// Drift and shape test for skills/vapt/controls.json.
// The SKILL.md rule tables and the machine catalog must agree (both directions).
// Run: node --test skills/vapt/controls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFacts, holds } from './controls.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const FAMILIES = ['API', 'WEB', 'CFG', 'ABUSE'];
const TIERS = ['[NN]', '[D]'];
const VERIFY_TYPES = ['static', 'runtime', 'both'];
const ENVS = ['request-harness', 'browser-runner', 'boot-and-inspect', 'repo-scan', 'datastore-fixture'];
const SOURCE_KINDS = ['vapt', 'audit', 'owasp'];
const FACT_TYPES = ['enum', 'bool'];
const REQUIRED_FACTS = [
  'boundaries', 'principals', 'persistent_write', 'outbound_message', 'recipient_unproven',
  'identity_claim_unproven', 'spends_or_reserves_value', 'shared_resource', 'caller_triggered_debit',
  'state_transitions', 'plan_gated_feature', 'link_or_token_in_message', 'session_context',
  'attempt_limit', 'sensitive_field_write',
];
const UNKNOWN_PHRASE = 'an unknown fact value matches';
// An out-of-vocabulary value (a typo, "yes" for a bool, an unknown boundary kind) must never fail open.
export const OOV_PHRASE = 'an out-of-vocabulary fact value is rejected';
// A not_applicable reason must be an intrinsic impossibility of the changed code, never a deferral to
// another boundary kind or control (that other component may be unchanged). Mechanical part of the rule.
const DEFERRAL = /\bselect(?:s|ed|ing)?\b|\bcovered (?:by|elsewhere)\b|\bdecided (?:by|where|in)\b|\bbelongs to\b|\blives in\b|\bhandled (?:by|in)\b|\bchecked there\b/i;
const ABUSE_LABELS = [['Principals', /Principals:/], ['Request', /Request:/], ['Assert', /\bassert\b/i], ['Positive control', /Positive control/i]];
const STOP_WORDS = new Set(['every', 'under', 'with', 'from', 'that', 'this', 'into', 'their']);
// Structured ABUSE pattern: the four labelled parts in order, each with >= 20 chars, and an Assert clause
// that names the control's subject (a primary_facts or title word), so 'Assert: true is true' cannot pass.
export function abuseStructure(pattern, control) {
  const errs = [];
  const pat = String(pattern ?? '');
  const at = [];
  let from = 0;
  for (const [name, re] of ABUSE_LABELS) {
    const m = re.exec(pat.slice(from));
    if (!m) { errs.push(`missing '${name}' label (in order Principals:, Request:, Assert, Positive control)`); return errs; }
    at.push({ name, start: from + m.index, end: from + m.index + m[0].length });
    from = from + m.index + m[0].length;
  }
  const seg = {};
  at.forEach((l, i) => { seg[l.name] = pat.slice(l.end, i + 1 < at.length ? at[i + 1].start : pat.length).replace(/^[\s:]+/, '').trim(); });
  for (const [name, text] of Object.entries(seg)) if (text.length < 20) errs.push(`'${name}' part has under 20 characters: '${text}'`);
  const words = [...(control?.primary_facts ?? []).flatMap((f) => String(f).split('_')), ...String(control?.title ?? '').split(/[^A-Za-z]+/)]
    .map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  if (!words.some((w) => seg.Assert.toLowerCase().includes(w))) errs.push(`Assert part names none of the control's subject words (${words.join(', ')}): a tautology`);
  return errs;
}
const refusalWord = /(refus|invariant|unchanged|never|released|capped|bounded|inert|ignored|reject|exclude|engages)/i;
const REQUIRED_FIELDS = [
  'id', 'family', 'title', 'tier', 'attack', 'applies_when', 'not_applicable', 'prevent', 'verify', 'env',
  'evidence', 'static_mirror', 'sources', 'validated',
];
// [NN] obligation phrases (must not / must never / must use only / must be enforced) that must survive in `prevent`.
export const PREVENT_PINS = {
  'VAPT-ABUSE-01': ['must not spend', 'must not inherit authority', 'must not depend on victim data'],
  'VAPT-ABUSE-02': ['must not carry the free text', 'must not keep sending'],
  'VAPT-ABUSE-03': ['must use only a verified host or origin', 'must never place a token under an unverified host'],
  'VAPT-ABUSE-05': ['must not debit another party'],
  'VAPT-ABUSE-07': ['must be enforced server-side at field level'],
};
const GATED = /^gated by ([a-z_]+(?: or [a-z_]+)*): /;

// Attack-text normalisation (documented in SKILL.md "The machine catalog"):
// 1. remove every backtick, 2. remove every `**`, 3. collapse whitespace runs to one space, 4. trim.
export const normalizeAttack = (s) => String(s ?? '').replace(/`/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

const boolFactsOf = (vocab) => Object.entries(vocab).filter(([, d]) => d?.type === 'bool').map(([k]) => k);
// Known-negative world: only `kinds` are boundaries, every bool fact false, principals known.
export const negWorld = (vocab, kinds, extra = {}) => ({
  ...Object.fromEntries(boolFactsOf(vocab).map((k) => [k, false])), boundaries: kinds, principals: ['service'], ...extra,
});
// Known-positive world: only `kinds` are boundaries, every bool fact true.
const posWorld = (vocab, kinds) => ({
  ...Object.fromEntries(boolFactsOf(vocab).map((k) => [k, true])), boundaries: kinds, principals: ['service'],
});

// ---- the validator under test (pure; takes the catalog and the doc context) ----
// Returns a list of { check, msg }. An empty list means the catalog is sound.
export function validateCatalog(cat, ctx) {
  const errs = [];
  const bad = (check, msg) => errs.push({ check, msg });
  if (!cat || typeof cat !== 'object' || Array.isArray(cat)) {
    bad('shape', 'catalog is not an object');
    return errs;
  }
  if (cat.catalog_version !== 1) bad('version', `catalog_version must be 1, got ${cat.catalog_version}`);
  if (typeof cat.semantics !== 'string' || !cat.semantics.includes(UNKNOWN_PHRASE)
    || !/absent/.test(cat.semantics) || !/null/.test(cat.semantics) || !cat.semantics.includes('"unknown"')) {
    bad('semantics', `top-level 'semantics' must contain the exact phrase '${UNKNOWN_PHRASE}' and define unknown as key absent, null or the string "unknown"`);
  }
  if (typeof cat.semantics !== 'string' || !cat.semantics.includes(OOV_PHRASE)) {
    bad('semantics', `top-level 'semantics' must contain the exact phrase '${OOV_PHRASE}' (an out-of-vocabulary value never fails open)`);
  }
  const vocab = cat.fact_vocabulary && typeof cat.fact_vocabulary === 'object' ? cat.fact_vocabulary : {};
  for (const f of REQUIRED_FACTS) if (!vocab[f]) bad('vocabulary', `fact_vocabulary missing '${f}'`);
  for (const [name, def] of Object.entries(vocab)) {
    if (!FACT_TYPES.includes(def?.type)) bad('vocabulary', `fact '${name}' has invalid type ${def?.type}`);
    if (!Array.isArray(def?.values) || def.values.length === 0) bad('vocabulary', `fact '${name}' has no values`);
    if (typeof def?.definition !== 'string' || def.definition.trim().length < 30) bad('vocabulary', `fact '${name}' needs a 'definition' of at least 30 characters`);
    for (const k of ['positive', 'negative']) {
      if (typeof def?.examples?.[k] !== 'string' || def.examples[k].trim().length < 10) bad('vocabulary', `fact '${name}' needs examples.${k} (a tempting negative is required)`);
    }
  }
  if (vocab.boundaries && JSON.stringify([...vocab.boundaries.values].sort()) !== JSON.stringify([...ctx.boundaryKinds].sort())) {
    bad('vocabulary', `boundaries values must equal the STEP 2 kinds in SKILL.md: ${ctx.boundaryKinds.join(',')}`);
  }
  if (vocab.principals && JSON.stringify([...vocab.principals.values].sort()) !== JSON.stringify(['anonymous', 'authenticated', 'service', 'staff'])) {
    bad('vocabulary', 'principals must be anonymous, authenticated, staff, service');
  }

  const kinds = Array.isArray(vocab.boundaries?.values) ? vocab.boundaries.values : [];
  const controls = Array.isArray(cat.controls) ? cat.controls : [];
  const ids = controls.map((c) => c?.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) bad('unique', `duplicate control id ${[...new Set(dup)].join(',')}`);

  for (const id of ctx.skillTiers.keys()) {
    if (!ids.includes(id)) bad('drift', `missing control ${id} (present in SKILL.md)`);
  }
  for (const id of ids) {
    if (!ctx.skillTiers.has(id)) bad('drift', `control ${id} has no row in SKILL.md tables`);
  }

  const leafOk = (leaf, where) => {
    const keys = Object.keys(leaf).sort().join(',');
    if (keys !== 'fact,op,value') return bad('grammar', `${where}: leaf must have exactly fact,op,value`);
    const def = vocab[leaf.fact];
    if (!def) return bad('grammar', `${where}: unknown fact '${leaf.fact}'`);
    if (!['includes', 'is'].includes(leaf.op)) return bad('grammar', `${where}: op '${leaf.op}' not allowed`);
    if (leaf.op === 'includes' && def.type !== 'enum') return bad('grammar', `${where}: 'includes' needs an enum fact`);
    if (!def.values?.includes(leaf.value)) return bad('grammar', `${where}: value '${leaf.value}' not in vocabulary of '${leaf.fact}'`);
  };
  const walk = (node, where) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return bad('grammar', `${where}: node must be an object`);
    const keys = Object.keys(node);
    if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
      const kids = node[keys[0]];
      if (!Array.isArray(kids) || kids.length === 0) return bad('grammar', `${where}: '${keys[0]}' needs a non-empty array`);
      kids.forEach((k, i) => walk(k, `${where}.${keys[0]}[${i}]`));
      return;
    }
    leafOk(node, where);
  };

  for (const c of controls) {
    const id = c?.id ?? '(no id)';
    for (const f of REQUIRED_FIELDS) if (!(f in (c ?? {}))) bad('fields', `${id}: missing field '${f}'`);
    if (!FAMILIES.includes(c.family)) bad('fields', `${id}: family '${c.family}' not allowed`);
    if (typeof c.id === 'string' && c.family && !c.id.startsWith(`VAPT-${c.family}-`)) bad('fields', `${id}: id does not match family ${c.family}`);
    if (!TIERS.includes(c.tier)) bad('fields', `${id}: tier '${c.tier}' not allowed`);
    if (ctx.skillTiers.has(c.id) && ctx.skillTiers.get(c.id) !== c.tier) {
      bad('drift', `${id}: tier ${c.tier} disagrees with SKILL.md ${ctx.skillTiers.get(c.id)}`);
    }
    for (const f of ['title', 'attack', 'prevent', 'evidence', 'validated']) {
      if (typeof c[f] !== 'string' || c[f].trim() === '') bad('fields', `${id}: '${f}' must be a non-empty string`);
    }
    if (!ENVS.includes(c.env)) bad('fields', `${id}: env '${c.env}' not allowed`);
    if (!VERIFY_TYPES.includes(c.verify?.type)) bad('fields', `${id}: verify.type '${c.verify?.type}' not allowed`);
    if (typeof c.verify?.pattern !== 'string' || c.verify.pattern.trim() === '') {
      bad('pattern', `${id}: every control needs a non-empty verify.pattern`);
      if (c.family === 'ABUSE') bad('abuse-pattern', `${id}: ABUSE control needs a non-empty verify.pattern`);
    }
    if (c.family === 'ABUSE' && !(Array.isArray(c.static_mirror) && c.static_mirror.length === 0)) bad('abuse-mirror', `${id}: ABUSE controls have no BE-* mirror (static_mirror must be [])`);
    if (!Array.isArray(c.static_mirror)) bad('mirror', `${id}: static_mirror must be an explicit array ([] = deliberately none)`);
    for (const be of Array.isArray(c.static_mirror) ? c.static_mirror : []) {
      if (!ctx.beIds.has(be)) bad('mirror', `${id}: static_mirror '${be}' not found in backend-code-quality`);
    }
    if (Array.isArray(c.static_mirror) && ctx.skillMirror) {
      const want = [...(ctx.skillMirror.get(c.id) ?? [])].sort().join(',');
      const have = [...c.static_mirror].sort().join(',');
      if (want !== have) bad('mirror-drift', `${id}: static_mirror [${have}] disagrees with the SKILL.md mapping table [${want}]`);
    }
    if (ctx.skillTitles?.has(c.id) && ctx.skillTitles.get(c.id) !== c.title) {
      bad('drift', `${id}: title '${c.title}' disagrees with SKILL.md '${ctx.skillTitles.get(c.id)}'`);
    }
    if (ctx.skillRows?.has(c.id) && normalizeAttack(c.attack) !== normalizeAttack(ctx.skillRows.get(c.id))) {
      bad('attack', `${id}: attack '${normalizeAttack(c.attack)}' is not the SKILL.md row '${normalizeAttack(ctx.skillRows.get(c.id))}'`);
    }
    for (const pin of PREVENT_PINS[c.id] ?? []) {
      if (typeof c.prevent !== 'string' || !c.prevent.toLowerCase().includes(pin)) bad('prevent-pin', `${id}: prevent lost the [NN] phrase '${pin}'`);
    }

    // selection accounting: the kinds a known-negative world does not select are exactly the not_applicable keys
    const na = c.not_applicable;
    if (!na || typeof na !== 'object' || Array.isArray(na)) {
      bad('accounting', `${id}: not_applicable must be an object ({} = applies to every boundary kind)`);
    } else if (c.applies_when && kinds.length) {
      for (const [k, reason] of Object.entries(na)) {
        if (!kinds.includes(k)) { bad('accounting', `${id}: not_applicable key '${k}' is not a boundary kind`); continue; }
        if (typeof reason !== 'string' || reason.trim().length < 30) { bad('accounting', `${id}: not_applicable.${k} needs a reason of at least 30 characters`); continue; }
        if (!reason.includes(k)) bad('accounting', `${id}: not_applicable.${k} reason must name the surface '${k}' it excuses`);
        for (const other of kinds) {
          if (other !== k && reason.includes(other)) bad('deferral', `${id}: not_applicable.${k} names another boundary kind '${other}'; a reason must be an intrinsic impossibility of ${k}, not a deferral (that other component may be unchanged)`);
        }
        const dm = reason.match(DEFERRAL);
        if (dm) bad('deferral', `${id}: not_applicable.${k} uses deferral wording '${dm[0]}'; state why ${k} itself cannot exhibit the attack`);
        if (/VAPT-[A-Z]+-\d\d/.test(reason)) bad('deferral', `${id}: not_applicable.${k} defers to another control id`);
        const g = reason.match(GATED);
        if (g) {
          for (const f of g[1].split(' or ')) {
            if (vocab[f]?.type !== 'bool') bad('accounting', `${id}: not_applicable.${k} is gated by '${f}', which is not a bool fact`);
            else if (!holds(c.applies_when, negWorld(vocab, [k], { [f]: true }))) bad('accounting', `${id}: not_applicable.${k} claims a gate on ${f}, but ${k} + ${f}=true still does not select it`);
          }
        } else if (holds(c.applies_when, posWorld(vocab, [k]))) {
          bad('accounting', `${id}: not_applicable.${k} is a surface reason, but ${k} with every bool fact true selects it (use 'gated by <fact>: ...')`);
        }
      }
      for (const k of kinds) {
        const neg = holds(c.applies_when, negWorld(vocab, [k]));
        if (neg && !holds(c.applies_when, posWorld(vocab, [k]))) bad('accounting', `${id}: ${k} selects with bools false but not true (predicates must be monotone)`);
        if (!neg && !(k in na)) bad('accounting', `${id}: '${k}' alone (other facts known-false) does not select it and not_applicable gives no reason`);
        if (neg && k in na) bad('accounting', `${id}: '${k}' alone selects it, so not_applicable.${k} is stale`);
      }
    }
    // primary facts: an ABUSE control names the facts that alone (no boundary, other bools false) must select it
    if (c.family === 'ABUSE') {
      if (!Array.isArray(c.primary_facts) || c.primary_facts.length === 0) bad('primary-facts', `${id}: ABUSE control needs a non-empty primary_facts array`);
      for (const f of Array.isArray(c.primary_facts) ? c.primary_facts : []) {
        if (vocab[f]?.type !== 'bool') bad('primary-facts', `${id}: primary fact '${f}' is not a bool fact`);
        else if (!c.applies_when || !holds(c.applies_when, negWorld(vocab, [], { [f]: true }))) bad('primary-facts', `${id}: ${f}=true alone does not select it`);
      }
    } else if (c.primary_facts !== undefined) bad('primary-facts', `${id}: primary_facts is only for ABUSE controls`);
    {
      const pat = c.verify?.pattern ?? '';
      if (pat.trim().length < 40 || !/assert/i.test(pat)) bad('verify-pattern', `${id}: verify.pattern must be >= 40 chars and state an assertion`);
      if (c.family === 'ABUSE' && (!/positive control/i.test(pat) || !refusalWord.test(pat))) {
        bad('verify-pattern', `${id}: ABUSE verify.pattern needs a refusal/invariant word and a positive control`);
      }
      if (c.family === 'ABUSE') for (const e of abuseStructure(pat, c)) bad('abuse-structure', `${id}: verify.pattern ${e}`);
    }
    if (c.env_also !== undefined && (!Array.isArray(c.env_also) || c.env_also.some((e) => !ENVS.includes(e)))) bad('fields', `${id}: env_also must be an array of allowed envs`);
    if (c.verify?.type === 'both' && c.env !== 'browser-runner' && !(c.env_also ?? []).includes('browser-runner')) {
      bad('fields', `${id}: verify.type 'both' needs browser-runner as env or env_also`);
    }
    if (c.family === 'ABUSE' && typeof c.validated === 'string' && !/not run against (a )?fixed (code|implementation)/i.test(c.validated)) {
      bad('validated', `${id}: ABUSE note must say it was reasoned from evidence and not run against fixed code`);
    }
    if (typeof c.validated === 'string') {
      const cited = new Set(c.validated.match(/F(0[1-9]|1\d|2[0-4])\b/g) ?? []);
      const srcs = new Set((c.sources ?? []).map((s) => (s?.ref ?? '').split(':')[1]).filter(Boolean));
      for (const f of cited) if (!srcs.has(f)) bad('validated', `${id}: note claims ${f} but it is not in sources`);
    }
    if (c.applies_when) walk(c.applies_when, `${id}.applies_when`); else bad('grammar', `${id}: applies_when missing`);
    if (!Array.isArray(c.sources) || c.sources.length === 0) bad('sources', `${id}: sources must be non-empty`);
    const srcKeys = (Array.isArray(c.sources) ? c.sources : []).map((s) => `${s?.kind}|${s?.ref}`);
    for (const d of new Set(srcKeys.filter((s, i) => srcKeys.indexOf(s) !== i))) bad('sources', `${id}: duplicate source ${d}`);
    for (const s of Array.isArray(c.sources) ? c.sources : []) {
      if (!SOURCE_KINDS.includes(s?.kind)) bad('sources', `${id}: source kind '${s?.kind}' not allowed`);
      if (typeof s?.ref !== 'string' || !s.ref) bad('sources', `${id}: source ref missing`);
      if (s?.kind === 'audit' && !/^storecraft-run-1:F(0[1-9]|1\d|2[0-4])$/.test(s.ref ?? '')) {
        bad('sources', `${id}: audit source must cite 'storecraft-run-1:F01..F24', got '${s.ref}'`);
      }
    }
    if (/NV\d\d/.test(JSON.stringify(c))) bad('leads', `${id}: control text cites an NV lead; leads are not controls`);
    if (/skills\/security-audit/.test(JSON.stringify(c))) bad('vendored', `${id}: references vendored skills/security-audit`);
  }

  // coverage: every boundary kind and every fact (and enum value) is used by a predicate or deliberately unused
  const used = new Map();
  const collect = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.all || n.any) return (n.all ?? n.any).forEach(collect);
    if (!used.has(n.fact)) used.set(n.fact, new Set());
    used.get(n.fact).add(n.value);
  };
  controls.forEach((c) => collect(c?.applies_when));
  const unusedOk = Array.isArray(cat.unused_ok) ? cat.unused_ok : [];
  for (const u of unusedOk) {
    if (!vocab[u?.fact] || typeof u.reason !== 'string' || u.reason.trim().length < 20) bad('coverage', `unused_ok entry ${JSON.stringify(u)} needs a known fact and a reason`);
    else if (u.value === undefined ? used.has(u.fact) : used.get(u.fact)?.has(u.value)) bad('coverage', `unused_ok entry ${u.fact}${u.value === undefined ? '' : '=' + u.value} is actually used by a predicate`);
  }
  const waived = (f, v) => unusedOk.some((u) => u.fact === f && (u.value === undefined || u.value === v));
  for (const [name, def] of Object.entries(vocab)) {
    if (def?.type === 'enum') {
      for (const v of def.values ?? []) if (!used.get(name)?.has(v) && !waived(name, v)) bad('coverage', `${name}='${v}' is used by no control and not listed in unused_ok`);
    } else if (!used.has(name) && !waived(name)) bad('coverage', `fact '${name}' is used by no control and not listed in unused_ok`);
  }

  // every bool fact has a named owner: alone it must select at least one ABUSE control that lists it
  for (const f of boolFactsOf(vocab)) {
    if (!controls.some((c) => c?.family === 'ABUSE' && Array.isArray(c.primary_facts) && c.primary_facts.includes(f))) {
      bad('primary-facts', `bool fact '${f}' is in no ABUSE control's primary_facts`);
    }
  }

  const leads = Array.isArray(cat.leads) ? cat.leads : [];
  const leadRefs = leads.map((l) => l?.ref);
  for (const l of leads) {
    if (typeof l?.ref !== 'string' || typeof l?.note !== 'string' || !l.note) bad('leads', 'each lead needs ref and note');
    if (ids.includes(l?.ref)) bad('leads', `lead '${l.ref}' shares an id with a control`);
  }
  if (new Set(leadRefs).size !== leadRefs.length) bad('leads', 'duplicate lead ref');
  if (/skills\/security-audit/.test(JSON.stringify(cat))) bad('vendored', 'catalog references vendored skills/security-audit');
  return errs;
}

// ---- real inputs ----
const skillMd = read('skills/vapt/SKILL.md');
const skillTiers = new Map();
for (const m of skillMd.matchAll(/^\| `(VAPT-[A-Z]+-\d\d)` \| `(\[(?:NN|D)\])` \|/gm)) skillTiers.set(m[1], m[2]);
const boundaryKinds = [...skillMd.slice(skillMd.indexOf('## STEP 2'), skillMd.indexOf('## STEP 3'))
  .matchAll(/^\| `([a-z-]+)` \| /gm)].map((m) => m[1]);
const skillTitles = new Map();
const skillRows = new Map();
for (const m of skillMd.matchAll(/^\| `(VAPT-[A-Z]+-\d\d)` \| `\[(?:NN|D)\]` \| (.*) \|$/gm)) {
  skillRows.set(m[1], m[2]);
  const t = m[2].match(/^\*\*(.+?)\*\*/);
  if (t) skillTitles.set(m[1], t[1].replace(/\.$/, ''));
}
const skillMirror = new Map();
{
  const sec = skillMd.slice(skillMd.indexOf('### How this maps onto the static rules'), skillMd.indexOf('## STEP 5'));
  for (const line of sec.split('\n').filter((l) => l.startsWith('| `BE-'))) {
    const [, left, right] = line.split('|');
    const bes = [];
    for (const m of left.matchAll(/BE-[A-Z]+-(\d\d(?:\/\d\d)*)/g)) {
      const prefix = m[0].slice(0, m[0].length - m[1].length);
      for (const n of m[1].split('/')) bes.push(prefix + n);
    }
    for (const v of right.match(/VAPT-[A-Z]+-\d\d/g) ?? []) skillMirror.set(v, new Set([...(skillMirror.get(v) ?? []), ...bes]));
  }
}
const beIds = new Set(read('skills/backend-code-quality/SKILL.md').match(/BE-[A-Z]+-\d\d/g));
const ctx = { skillTiers, boundaryKinds, beIds, skillTitles, skillRows, skillMirror };
const catalog = JSON.parse(read('skills/vapt/controls.json'));
const real = validateCatalog(catalog, ctx);

const expectClean = (check) => {
  const msgs = real.filter((e) => e.check === check).map((e) => e.msg);
  assert.deepEqual(msgs, [], msgs.join('\n'));
};

test('fixture sanity: SKILL.md tables expose 25 rules, 11 boundary kinds, titles and a mirror table', () => {
  assert.equal(skillTiers.size, 25, `parsed ${skillTiers.size} rule rows`);
  assert.equal(boundaryKinds.length, 11, `parsed ${boundaryKinds.length} boundary kinds`);
  assert.equal(skillTitles.size, 25, `parsed ${skillTitles.size} titles`);
  assert.ok(skillMirror.size >= 8, `parsed ${skillMirror.size} mirrored controls`);
  assert.ok(beIds.has('BE-SEC-09'));
});
test('catalog is version 1', () => expectClean('version'));
test('semantics documents unknown-value matching', () => expectClean('semantics'));
test('fact vocabulary is complete and tied to SKILL.md', () => expectClean('vocabulary'));
test('control ids are unique', () => expectClean('unique'));
test('catalog and SKILL.md tables agree on ids and tiers', () => expectClean('drift'));
test('every control has all fields with allowed values', () => expectClean('fields'));
test('every control has a non-empty verify.pattern', () => expectClean('pattern'));
test('every ABUSE control has a deterministic verify.pattern', () => expectClean('abuse-pattern'));
test('ABUSE controls declare no BE-* mirror', () => expectClean('abuse-mirror'));
test('static_mirror is an explicit array and its ids exist in backend-code-quality', () => expectClean('mirror'));
test('static_mirror agrees with the SKILL.md mapping table in both directions', () => expectClean('mirror-drift'));
test('verify.pattern is substantive (assertion, refusal word, positive control for ABUSE)', () => expectClean('verify-pattern'));
test('validated notes are honest and cite only sourced findings', () => expectClean('validated'));
test('every boundary kind and fact is used by a predicate or deliberately unused', () => expectClean('coverage'));
test('applies_when uses only the closed grammar and vocabulary', () => expectClean('grammar'));
test('sources are non-empty and audit sources cite only run id and F-id', () => expectClean('sources'));
test('no control cites an NV lead; leads never collide with control ids', () => expectClean('leads'));
test('vendored security-audit is never referenced', () => expectClean('vendored'));
test('attack text equals the SKILL.md row exactly after normalisation', () => expectClean('attack'));
test('[NN] negation phrases are pinned in ABUSE prevent text', () => expectClean('prevent-pin'));
test('selection accounting: unselected boundary kinds equal not_applicable keys, each with a checked reason', () => expectClean('accounting'));
test('primary_facts: each named fact alone selects its ABUSE control, and every bool fact has an owner', () => expectClean('primary-facts'));
test('the custom-domain tenant binding lead is recorded as a lead', () => {
  assert.ok((catalog.leads ?? []).some((l) => /custom-domain/i.test(l.ref + l.note)), 'no custom-domain lead');
});

// ---- negative tests: a deliberately broken catalog must be rejected ----
const clone = (o) => JSON.parse(JSON.stringify(o));
const sample = () => {
  const c = clone(catalog);
  return c;
};
const rejects = (mutate, check) => {
  const c = sample();
  mutate(c);
  const errs = validateCatalog(c, ctx);
  assert.ok(errs.some((e) => e.check === check), `expected a '${check}' rejection, got ${JSON.stringify(errs.map((e) => e.check))}`);
};

test('validator rejects a tier that disagrees with SKILL.md', () => {
  rejects((c) => { c.controls[0].tier = c.controls[0].tier === '[NN]' ? '[D]' : '[NN]'; }, 'drift');
});
test('validator rejects a dropped control', () => {
  rejects((c) => { c.controls.pop(); }, 'drift');
});
test('validator rejects an ABUSE control without a pattern', () => {
  rejects((c) => { c.controls.find((x) => x.family === 'ABUSE').verify.pattern = ''; }, 'abuse-pattern');
});
test('validator rejects a non-ABUSE control with a missing, empty or null verify.pattern', () => {
  rejects((c) => { delete c.controls.find((x) => x.id === 'VAPT-API-01').verify.pattern; }, 'pattern');
  rejects((c) => { c.controls.find((x) => x.id === 'VAPT-API-01').verify.pattern = ''; }, 'pattern');
  rejects((c) => { c.controls.find((x) => x.id === 'VAPT-CFG-02').verify.pattern = null; }, 'pattern');
  rejects((c) => { delete c.controls.find((x) => x.id === 'VAPT-CFG-02').verify; }, 'pattern');
});
test('validator rejects a vacuous verify.pattern on a non-ABUSE control', () => {
  rejects((c) => { c.controls.find((x) => x.id === 'VAPT-API-01').verify.pattern = 'check it'; }, 'verify-pattern');
});
test('validator rejects an applies_when fact outside the vocabulary', () => {
  rejects((c) => { c.controls[0].applies_when = { fact: 'nonsense', op: 'is', value: true }; }, 'grammar');
});
test('validator rejects an NV lead cited inside a control', () => {
  rejects((c) => { c.controls[0].validated += ' see NV07'; }, 'leads');
});
test('validator rejects an audit source that copies anything but the F-id', () => {
  rejects((c) => {
    c.controls.find((x) => x.family === 'ABUSE').sources.push({ kind: 'audit', ref: 'storecraft-run-1:F03 fix the thing' });
  }, 'sources');
});
test('validator rejects a static_mirror that does not exist', () => {
  rejects((c) => { c.controls[0].static_mirror = ['BE-SEC-99']; }, 'mirror');
});

// ---- selection simulation over the real catalog ----
const select = (facts) => {
  assertFacts(facts, catalog.fact_vocabulary);
  return catalog.controls.filter((c) => holds(c.applies_when, facts)).map((c) => c.id);
};
const boolFacts = Object.entries(catalog.fact_vocabulary).filter(([, d]) => d.type === 'bool').map(([k]) => k);
const allFalse = () => Object.fromEntries(boolFacts.map((k) => [k, false]));

test('unknown encodings (absent, null, "unknown") all match', () => {
  const leaf = { fact: 'persistent_write', op: 'is', value: true };
  assert.ok(holds(leaf, {}) && holds(leaf, { persistent_write: null }) && holds(leaf, { persistent_write: 'unknown' }));
  assert.ok(!holds(leaf, { persistent_write: false }));
});
test('each boundary kind alone, every other fact known-negative, selects at least one control', () => {
  for (const b of catalog.fact_vocabulary.boundaries.values) {
    const ids = select({ ...allFalse(), boundaries: [b], principals: ['service'] });
    assert.ok(ids.length > 0, `boundary '${b}' alone selects no control`);
  }
});
test('each boundary kind alone, every other fact unknown, selects at least one control', () => {
  for (const b of catalog.fact_vocabulary.boundaries.values) assert.ok(select({ boundaries: [b] }).length > 0, b);
});
test('no boundary and every fact known-negative selects nothing (predicates are not trivially true)', () => {
  assert.deepEqual(select({ ...allFalse(), boundaries: [], principals: ['service'] }), []);
});
const has = (ids, ...want) => want.forEach((w) => assert.ok(ids.includes(w), `${w} missing from ${ids.join(',')}`));
test('scenario F10: anonymous order tracking by id selects VAPT-API-01', () => {
  has(select({ ...allFalse(), boundaries: ['request-handler'], principals: ['anonymous'] }), 'VAPT-API-01', 'VAPT-API-03');
});
test('scenario F11: staff-only route selects VAPT-API-03 and VAPT-API-01', () => {
  has(select({ ...allFalse(), boundaries: ['request-handler'], principals: ['staff'] }), 'VAPT-API-03', 'VAPT-API-01');
});
test('scenario: webhook receiver (async-consumer only) selects API-02, 04, 05, 07, 08', () => {
  has(select({ ...allFalse(), persistent_write: true, boundaries: ['async-consumer'], principals: ['service'] }),
    'VAPT-API-02', 'VAPT-API-04', 'VAPT-API-05', 'VAPT-API-07', 'VAPT-API-08');
});
test('scenario: outbound-data alone selects VAPT-API-06 and VAPT-CFG-03', () => {
  has(select({ ...allFalse(), boundaries: ['outbound-data'] }), 'VAPT-API-06', 'VAPT-CFG-03');
});
test('scenario: a business-invariant-only change (RPC/migration) selects ABUSE-05, 06, 07', () => {
  has(select({ ...allFalse(), boundaries: ['business-invariant'] }), 'VAPT-ABUSE-05', 'VAPT-ABUSE-06', 'VAPT-ABUSE-07');
});
test('scenario F14/F17/F19: wide ABUSE predicates', () => {
  has(select({ ...allFalse(), boundaries: ['async-consumer'], plan_gated_feature: true }), 'VAPT-ABUSE-07');
  has(select({ ...allFalse(), boundaries: ['request-handler'], attempt_limit: true }), 'VAPT-ABUSE-04');
  has(select({ ...allFalse(), boundaries: ['async-consumer'], outbound_message: true }), 'VAPT-ABUSE-02');
});
test('content pins: findings are mapped to the control that actually covers them', () => {
  const by = (id) => catalog.controls.find((c) => c.id === id);
  assert.ok(!by('VAPT-ABUSE-05').sources.some((s) => /F22$/.test(s.ref)), 'ABUSE-05 must not claim F22');
  assert.ok(by('VAPT-ABUSE-06').sources.some((s) => /F22$/.test(s.ref)), 'ABUSE-06 must claim F22');
  assert.match(by('VAPT-ABUSE-06').verify.pattern, /refuses new orders or charges the owed fee/);
  assert.match(by('VAPT-ABUSE-01').verify.pattern, /pre-claim/i);
  assert.match(by('VAPT-ABUSE-01').verify.pattern, /identical externally observable/i);
  assert.match(by('VAPT-ABUSE-07').verify.pattern, /derives|derived/i);
  assert.match(by('VAPT-ABUSE-07').verify.pattern, /pickup/);
  assert.match(by('VAPT-ABUSE-08').verify.pattern, /session/i);
  assert.equal(by('VAPT-ABUSE-08').env_also?.includes('browser-runner'), true);
  assert.doesNotMatch(JSON.stringify(by('VAPT-ABUSE-08')), /Worker/);
  assert.match(by('VAPT-WEB-04').verify.pattern, /SameSite/);
  assert.equal(by('VAPT-WEB-04').verify.type, 'both');
});

// Wave B residual pins. Reflected and stored XSS are both rendering-sink attacks; Set-Cookie is issued by more
// than login; attempt_limit is true for any route that checks a guessable value, capped or not.
const wavePinErrors = (c) => {
  const by = (id) => c.controls.find((x) => x.id === id);
  const e = [];
  const need = (text, re, what) => { if (!re.test(String(text ?? ''))) e.push(`${what} must match ${re}`); };
  for (const re of [/reflected/i, /stored/i]) need(by('VAPT-WEB-01')?.verify?.pattern, re, 'VAPT-WEB-01 verify.pattern');
  for (const re of [/callback/, /impersonat/, /tenant switch/, /SameSite/]) need(by('VAPT-CFG-04')?.verify?.pattern, re, 'VAPT-CFG-04 verify.pattern');
  for (const re of [/whether or not/, /route/]) need(c.fact_vocabulary?.attempt_limit?.definition, re, 'attempt_limit.definition');
  if (/still counts/.test(c.fact_vocabulary?.attempt_limit?.examples?.negative ?? '')) e.push('attempt_limit negative example must be a genuine negative');
  return e;
};
test('Wave B pins: WEB-01 covers reflected and stored, CFG-04 covers every Set-Cookie issuer, attempt_limit covers uncapped guess routes', () => {
  assert.deepEqual(wavePinErrors(catalog), []);
});
test('Wave B pins bite: dropping a pinned word is detected', () => {
  const mut = (fn) => { const c = clone(catalog); fn(c); return wavePinErrors(c); };
  const sub = (c, id, re, to) => { const x = c.controls.find((y) => y.id === id); x.verify.pattern = x.verify.pattern.replace(re, to); };
  assert.ok(mut((c) => sub(c, 'VAPT-WEB-01', /reflected/gi, 'echoed')).some((m) => /reflected/.test(m)));
  assert.ok(mut((c) => sub(c, 'VAPT-WEB-01', /stored/gi, 'saved')).some((m) => /stored/.test(m)));
  assert.ok(mut((c) => sub(c, 'VAPT-CFG-04', /callback/g, 'return')).some((m) => /callback/.test(m)));
  assert.ok(mut((c) => sub(c, 'VAPT-CFG-04', /impersonat/g, 'switch')).some((m) => /impersonat/.test(m)));
  assert.ok(mut((c) => sub(c, 'VAPT-CFG-04', /tenant switch/g, 'tenant move')).some((m) => /tenant switch/.test(m)));
  assert.ok(mut((c) => sub(c, 'VAPT-CFG-04', /SameSite/g, 'Lax')).some((m) => /SameSite/.test(m)));
  assert.ok(mut((c) => { c.fact_vocabulary.attempt_limit.definition = c.fact_vocabulary.attempt_limit.definition.replace(/whether or not/g, 'if'); }).some((m) => /whether or not/.test(m)));
  assert.ok(mut((c) => { c.fact_vocabulary.attempt_limit.definition = c.fact_vocabulary.attempt_limit.definition.replace(/route/g, 'path'); }).some((m) => /route/.test(m)));
  assert.ok(mut((c) => { c.fact_vocabulary.attempt_limit.examples.negative += ' It still counts.'; }).length > 0);
});

// ---- more negative tests ----
test('validator rejects an ABUSE control given a BE mirror', () => {
  rejects((c) => { c.controls.find((x) => x.family === 'ABUSE').static_mirror = ['BE-SEC-09']; }, 'abuse-mirror');
});
test('validator rejects a null static_mirror', () => {
  rejects((c) => { c.controls[0].static_mirror = null; }, 'mirror');
});
test('validator rejects a mirror that disagrees with the SKILL.md table', () => {
  rejects((c) => { c.controls.find((x) => x.id === 'VAPT-API-06').static_mirror = ['BE-SEC-02', 'BE-SEC-08']; }, 'mirror-drift');
  rejects((c) => { c.controls.find((x) => x.id === 'VAPT-API-06').static_mirror = []; }, 'mirror-drift');
});
test('validator rejects an extra control with no SKILL.md row', () => {
  rejects((c) => { const x = clone(c.controls[0]); x.id = 'VAPT-API-99'; c.controls.push(x); }, 'drift');
});
test('validator rejects boundary-vocabulary drift', () => {
  rejects((c) => { c.fact_vocabulary.boundaries.values.pop(); }, 'vocabulary');
  rejects((c) => { c.fact_vocabulary.boundaries.values.push('made-up'); }, 'vocabulary');
});
test('validator rejects includes used on a bool fact', () => {
  rejects((c) => { c.controls[0].applies_when = { fact: 'persistent_write', op: 'includes', value: true }; }, 'grammar');
});
test('validator rejects a vacuous verify.pattern', () => {
  rejects((c) => { c.controls.find((x) => x.family === 'ABUSE').verify.pattern = 'check it'; }, 'verify-pattern');
  rejects((c) => { c.controls.find((x) => x.family === 'ABUSE').verify.pattern = 'Assert that the thing behaves correctly under many different circumstances of use.'; }, 'verify-pattern');
});
test('validator rejects a title mutation', () => {
  rejects((c) => { c.controls[0].title = 'Something else'; }, 'drift');
});
const byId = (c, id) => c.controls.find((x) => x.id === id);
test("validator rejects a reversed 'must not' in attack text", () => {
  rejects((c) => { const x = byId(c, 'VAPT-ABUSE-01'); x.attack = String(x.attack).replace('must not', 'must'); }, 'attack');
  rejects((c) => { byId(c, 'VAPT-API-01').attack += ' Extra.'; }, 'attack');
});
test("validator rejects a reversed 'must not' in a pinned prevent phrase", () => {
  rejects((c) => { const x = byId(c, 'VAPT-ABUSE-01'); x.prevent = x.prevent.replaceAll('must not', 'must'); }, 'prevent-pin');
  rejects((c) => { const x = byId(c, 'VAPT-ABUSE-05'); x.prevent = x.prevent.replace('must not debit', 'may debit'); }, 'prevent-pin');
});
test('attack normalisation strips backticks and bold and collapses whitespace only', () => {
  assert.equal(normalizeAttack('**A.** `x`  y\n z '), 'A. x y z');
  assert.notEqual(normalizeAttack('must not'), normalizeAttack('must'));
});
test('validator rejects a missing, malformed or stale not_applicable', () => {
  rejects((c) => { delete byId(c, 'VAPT-API-01').not_applicable; }, 'fields');
  rejects((c) => { byId(c, 'VAPT-API-01').not_applicable = []; }, 'accounting');
  rejects((c) => { byId(c, 'VAPT-CFG-03').not_applicable['made-up'] = 'made-up is not a kind but has a long reason'; }, 'accounting');
  rejects((c) => { byId(c, 'VAPT-CFG-03').not_applicable['request-handler'] = 'request-handler is excused although the control selects it'; }, 'accounting');
});
test('validator rejects a narrowed predicate with no matching not_applicable reason (the hole class)', () => {
  rejects((c) => { const x = byId(c, 'VAPT-CFG-03'); x.applies_when = { any: x.applies_when.any.filter((l) => l.value !== 'auth-lifecycle') }; }, 'accounting');
  rejects((c) => { const x = byId(c, 'VAPT-API-01'); x.applies_when = { any: x.applies_when.any.filter((l) => l.value !== 'business-invariant') }; }, 'accounting');
});
test('validator rejects short, unnamed, false-gate and hidden-gate reasons', () => {
  // API-04 keeps gated entries after the class-rule widening, so these mutations hit a real key
  const firstNa = (x) => { const k = Object.keys(x.not_applicable)[0]; assert.ok(k, `${x.id} has no not_applicable key to mutate`); return k; };
  rejects((c) => { const x = byId(c, 'VAPT-API-04'); x.not_applicable[firstNa(x)] = 'n/a'; }, 'accounting');
  rejects((c) => { const x = byId(c, 'VAPT-API-04'); x.not_applicable[firstNa(x)] = 'this surface cannot exhibit the attack at all, trust me'; }, 'accounting');
  // a gate on a fact that does not actually select the control for that kind
  rejects((c) => { const x = byId(c, 'VAPT-API-04'); const k = firstNa(x); x.not_applicable[k] = `gated by session_context: ${k} is fine and long enough`; }, 'accounting');
  // a surface reason on a kind that a true fact would select: the exclusion is really a fact gate
  rejects((c) => { const x = byId(c, 'VAPT-API-04'); x.not_applicable['request-handler'] = 'request-handler never persists a privileged field in this design'; }, 'accounting');
});
test('validator rejects missing, wrong or non-selecting primary_facts', () => {
  rejects((c) => { delete byId(c, 'VAPT-ABUSE-03').primary_facts; }, 'primary-facts');
  rejects((c) => { byId(c, 'VAPT-ABUSE-03').primary_facts = ['nonsense']; }, 'primary-facts');
  rejects((c) => { byId(c, 'VAPT-ABUSE-03').primary_facts = ['session_context']; }, 'primary-facts');
  rejects((c) => { byId(c, 'VAPT-API-01').primary_facts = ['persistent_write']; }, 'primary-facts');
});
test('validator rejects a duplicate source and an invalid env_also', () => {
  rejects((c) => { const x = byId(c, 'VAPT-ABUSE-06'); x.sources.push(clone(x.sources[1])); }, 'sources');
  rejects((c) => { byId(c, 'VAPT-ABUSE-08').env_also = ['made-up-runner']; }, 'fields');
  rejects((c) => { byId(c, 'VAPT-ABUSE-08').env_also = 'browser-runner'; }, 'fields');
});

// ---- scenario tests for the specific review findings ----
const neg = (kinds, extra) => negWorld(catalog.fact_vocabulary, kinds, extra);
test('N1: VAPT-CFG-03 applies to every boundary kind (auth-lifecycle, file-path, business-invariant included)', () => {
  for (const b of catalog.fact_vocabulary.boundaries.values) has(select(neg([b])), 'VAPT-CFG-03');
  assert.deepEqual(byId(catalog, 'VAPT-CFG-03').not_applicable, {});
});
test('N2: CSRF covers login/logout and send-only POSTs, and stays off a read-only handler', () => {
  has(select(neg(['auth-lifecycle'])), 'VAPT-WEB-04');
  has(select(neg(['request-handler'], { outbound_message: true })), 'VAPT-WEB-04');
  has(select(neg(['request-handler'], { session_context: true })), 'VAPT-WEB-04');
  assert.ok(!select(neg(['request-handler'])).includes('VAPT-WEB-04'), 'a read-only handler with every state-change fact known-false needs no CSRF test');
});
test('N3: a client-callable payment RPC tagged business-invariant + request-handler selects the API and ABUSE controls', () => {
  has(select(neg(['business-invariant', 'request-handler'], { spends_or_reserves_value: true })),
    'VAPT-API-01', 'VAPT-API-02', 'VAPT-API-03', 'VAPT-API-05', 'VAPT-ABUSE-05', 'VAPT-ABUSE-06', 'VAPT-ABUSE-07');
  has(select(neg(['business-invariant'])), 'VAPT-API-01', 'VAPT-API-02', 'VAPT-API-03', 'VAPT-API-05', 'VAPT-API-07');
  has(select(neg(['business-invariant'], { persistent_write: true })), 'VAPT-API-04');
  const rpc = /client-callable RPC[^.]*\**also\** tagged `?request-handler/i;
  assert.match(catalog.fact_vocabulary.boundaries.value_definitions['business-invariant'], rpc);
  assert.match(skillMd.slice(skillMd.indexOf('## STEP 2'), skillMd.indexOf('## STEP 3')), rpc);
});
test('N4: widened API-05, WEB-01, WEB-02 and API-08 predicates', () => {
  has(select(neg(['rendering-sink'])), 'VAPT-API-05');
  has(select(neg(['request-handler'])), 'VAPT-WEB-01');
  has(select(neg(['auth-lifecycle'])), 'VAPT-WEB-02');
  has(select(neg(['external-input-operation'])), 'VAPT-API-08');
  has(select(neg(['server-input'])), 'VAPT-API-08');
});
test('N5: a link or token in a message selects VAPT-ABUSE-03 with no outbound conjunct', () => {
  has(select(neg([], { link_or_token_in_message: true })), 'VAPT-ABUSE-03');
});
test('N7: the machine-catalog paragraph names every new field and the exact agreement list', () => {
  const para = skillMd.slice(skillMd.indexOf('### The machine catalog'), skillMd.indexOf('### How this maps onto the static rules'));
  for (const w of ['`env_also`', '`not_applicable`', '`primary_facts`', '`attack`']) assert.ok(para.includes(w), `paragraph does not mention ${w}`);
  assert.match(para, /remove every backtick/);
});
test('predicates are monotone: no leaf tests a bool fact for false', () => {
  const leaves = [];
  const walk = (n) => (n.all || n.any) ? (n.all ?? n.any).forEach(walk) : leaves.push(n);
  catalog.controls.forEach((c) => walk(c.applies_when));
  assert.deepEqual(leaves.filter((l) => l.value === false), []);
});
test('validator rejects a fact without definition/examples and a weak semantics phrase', () => {
  rejects((c) => { delete c.fact_vocabulary.persistent_write.definition; }, 'vocabulary');
  rejects((c) => { delete c.fact_vocabulary.persistent_write.examples; }, 'vocabulary');
  rejects((c) => { c.semantics = 'unknown values are handled somehow'; }, 'semantics');
});
test('validator rejects an unused vocabulary entry that is not waived, and a stale waiver', () => {
  rejects((c) => { c.fact_vocabulary.boundaries.values.push('x'); }, 'coverage');
  rejects((c) => { c.controls.forEach((x) => { x.applies_when = { fact: 'session_context', op: 'is', value: true }; }); }, 'coverage');
  rejects((c) => { (c.unused_ok ??= []).push({ fact: 'session_context', reason: 'this is actually used by ABUSE-08 so stale' }); }, 'coverage');
});
test('validator rejects an ABUSE note that overclaims, and a note citing an unsourced finding', () => {
  rejects((c) => { c.controls.find((x) => x.family === 'ABUSE').validated = 'Validated and passes.'; }, 'validated');
  rejects((c) => { const x = c.controls.find((y) => y.id === 'VAPT-ABUSE-05'); x.validated += ' Also F22, not run against fixed code.'; }, 'validated');
});
// ---- review ais4a-review-2: class rule, deferral, out-of-vocabulary, structured ABUSE patterns ----
test('class rule: no not_applicable reason defers to another boundary kind, control, or selection elsewhere', () => expectClean('deferral'));
test('validator rejects a deferral reason (kind name, deferral wording, control id), each isolated from accounting', () => {
  const k = 'request-handler';
  const valid = `gated by persistent_write: a ${k} change that stores nothing in any system cannot persist a submitted field.`;
  // the unmutated gated reason is accepted, so each rejection below is the deferral rule alone
  { const c = sample(); byId(c, 'VAPT-API-04').not_applicable[k] = valid; assert.deepEqual(validateCatalog(c, ctx).filter((e) => /VAPT-API-04/.test(e.msg)), []); }
  const only = (reason) => {
    const c = sample(); byId(c, 'VAPT-API-04').not_applicable[k] = reason;
    const errs = validateCatalog(c, ctx).filter((e) => /VAPT-API-04/.test(e.msg));
    assert.ok(errs.length > 0 && errs.every((e) => e.check === 'deferral'), `expected only deferral, got ${JSON.stringify(errs)}`);
  };
  only(`${valid} The async-consumer that stores it is tested instead.`);
  only(`${valid} The entry point which selects this rule carries the check.`);
  only(`${valid} Anything else is covered by the entry point.`);
  only(`${valid} Stored fields are VAPT-API-01's concern.`);
});
test('M4: an out-of-vocabulary fact value throws instead of failing open', () => {
  assert.throws(() => select({ ...allFalse(), identity_claim_unproven: 'yes', boundaries: ['request-handler'] }), /out-of-vocabulary/);
  assert.throws(() => select({ ...allFalse(), boundaries: ['request_handler'] }), /out-of-vocabulary/, 'typo in a boundary kind');
  assert.throws(() => select({ ...allFalse(), boundaries: 'request-handler' }), /out-of-vocabulary/, 'enum given as a string');
  assert.throws(() => select({ ...allFalse(), boundaries: [], principals: ['admin'] }), /out-of-vocabulary/);
  assert.throws(() => select({ ...allFalse(), persistant_write: true, boundaries: [] }), /out-of-vocabulary/, 'typo in a fact name');
  assert.throws(() => holds({ fact: 'persistent_write', op: 'is', value: true }, { persistent_write: 1 }, catalog.fact_vocabulary), /out-of-vocabulary/);
  assert.doesNotThrow(() => select({ boundaries: ['unknown', 'file-path'], persistent_write: null, session_context: 'unknown' }));
  rejects((c) => { c.semantics = c.semantics.replace(OOV_PHRASE, 'an odd value is ignored'); }, 'semantics');
  assert.ok(catalog.semantics.includes(OOV_PHRASE), 'semantics must pin the out-of-vocabulary rule');
});
test('Codex 4: every ABUSE verify.pattern is structured and its Assert part is not a tautology', () => expectClean('abuse-structure'));
test('Codex 4: validator rejects a tautological or unlabelled ABUSE pattern', () => {
  const base = 'Principals: an attacker and a tenant owner with domains. Request: trigger the outbound message as the attacker. ';
  const pc = ' Positive control: the verified domain host is used and the message is refused otherwise.';
  rejects((c) => { byId(c, 'VAPT-ABUSE-03').verify.pattern = `${base}Assert: true is true.${pc}`; }, 'abuse-structure');
  rejects((c) => { byId(c, 'VAPT-ABUSE-03').verify.pattern = `${base}Assert: the outcome equals the expected outcome exactly as written in the table.${pc}`; }, 'abuse-structure');
  rejects((c) => { byId(c, 'VAPT-ABUSE-03').verify.pattern = `Trigger the outbound message as the attacker. Assert every link host is verified and refused otherwise.${pc}`; }, 'abuse-structure');
  assert.deepEqual(abuseStructure(`${base}Assert: every link host in the captured message is in the verified set.${pc}`, byId(catalog, 'VAPT-ABUSE-03')), []);
});
test('B1: CFG-04 selects a request-handler that sets a session (OAuth callback, impersonation, tenant switch)', () => {
  has(select(neg(['request-handler'], { session_context: true })), 'VAPT-CFG-04');
  assert.ok(!select(neg(['request-handler'])).includes('VAPT-CFG-04'), 'a handler touching no session sets no session cookie');
  assert.match(byId(catalog, 'VAPT-CFG-04').not_applicable['request-handler'], /^gated by session_context: /);
});
test('B2: persistent_write is state in any system; provider calls select WEB-04 and API-04 without a local write', () => {
  const pw = catalog.fact_vocabulary.persistent_write;
  for (const w of [/identity provider/, /payment provider/, /connected store/]) assert.match(pw.definition, w);
  assert.match(pw.examples.negative, /read/);
  assert.match(pw.examples.negative, /cache/);
  // provider-delete POST: the handler deletes the user at the identity provider, writes nothing locally
  has(select(neg(['request-handler', 'outbound-data'])), 'VAPT-WEB-04');
  // auth.admin.updateUserById(id, { ...req.body }): caller body spread into a provider update, no local write
  has(select(neg(['request-handler', 'outbound-data'])), 'VAPT-API-04');
  has(select(neg(['outbound-data'])), 'VAPT-API-04');
  const inner = JSON.stringify(byId(catalog, 'VAPT-WEB-04').applies_when.any.find((n) => n.all).all[1]);
  assert.match(inner, /"value":"outbound-data"/, 'WEB-04 state-change ANY must include an outbound-data boundary');
});
test('M3: WEB-05 selects redirect allowlists (security-config) and signed-URL redirects (file-path)', () => {
  has(select(neg(['security-config'])), 'VAPT-WEB-05');
  has(select(neg(['file-path'])), 'VAPT-WEB-05');
});
test('M5: ABUSE-03 covers any link or token whatever its host source, and auth-lifecycle sending a message', () => {
  const d = catalog.fact_vocabulary.link_or_token_in_message;
  assert.match(d.definition, /whatever|regardless/i);
  assert.match(d.examples.positive, /Host/);
  has(select(neg(['auth-lifecycle'], { outbound_message: true })), 'VAPT-ABUSE-03');
});
test('M6: ABUSE-06 has the F21 row (a new trigger after a terminal state still takes effect)', () => {
  const p = byId(catalog, 'VAPT-ABUSE-06').verify.pattern;
  assert.match(p, /F21/);
  assert.match(p, /different content/);
});
test('M7: ABUSE-01 has the identifier-rotation row with a positive control', () => {
  const p = byId(catalog, 'VAPT-ABUSE-01').verify.pattern;
  assert.match(p, /Rotation row/);
  assert.match(p, /normalised identifiers/);
  assert.match(p, /Positive control[^.]*different (phone|device)/i);
});
test('M8 + Codex 1-3: single-kind changes where the check lives in that changed code', () => {
  has(select(neg(['outbound-data'])), 'VAPT-API-01'); // webhook sender looks up the tenant's object by a caller-supplied id
  has(select(neg(['outbound-data'], { persistent_write: true })), 'VAPT-API-01', 'VAPT-API-04'); // SDK call with caller-supplied object id
  has(select(neg(['external-input-operation'])), 'VAPT-API-03'); // role predicate lives in the query
  has(select(neg(['external-input-operation'], { persistent_write: true })), 'VAPT-WEB-01'); // stored XSS through an unchanged renderer
  has(select(neg(['business-invariant'], { persistent_write: true })), 'VAPT-WEB-01');
  has(select(neg(['external-input-operation'])), 'VAPT-API-02', 'VAPT-API-01', 'VAPT-WEB-02');
  has(select(neg(['async-consumer'])), 'VAPT-WEB-05', 'VAPT-WEB-03'); // postMessage listener, service worker
});
test('Codex 5: CORS pattern sends a credentialed simple request as well as a preflight', () => {
  const p = byId(catalog, 'VAPT-CFG-01').verify.pattern;
  assert.match(p, /preflight/i);
  assert.match(p, /simple \(non-preflight\)/);
  assert.match(p, /Access-Control-Allow-Credentials/);
  assert.match(p, /does not reflect/);
});
test('m9: no reason carries the backwards "writes, transitions, spends ... is a read" sentence', () => {
  for (const c of catalog.controls) {
    for (const [k, r] of Object.entries(c.not_applicable)) assert.doesNotMatch(r, /writes, transitions, spends/, `${c.id}.${k}`);
  }
  assert.match(byId(catalog, 'VAPT-WEB-04').not_applicable['request-handler'], /writes nothing, transitions nothing, spends nothing/);
});
test('m10: AGENTS.md and SKILL.md say the reason is test-checked and its truth is a review item; pins described accurately', () => {
  const agents = read('AGENTS.md');
  const para = skillMd.slice(skillMd.indexOf('### The machine catalog'), skillMd.indexOf('### How this maps onto the static rules'));
  for (const doc of [agents, para]) assert.match(doc, /written, test-checked reason; the reason's truth is a review item/);
  assert.doesNotMatch(para, /"must not" phrases/);
  for (const w of ['must use only', 'must never', 'must be enforced']) assert.ok(para.includes(w), `pin description omits '${w}'`);
});
test('owner eyeball: the surviving surface (non-gated) exclusions are exactly this table', () => {
  const surface = {};
  for (const c of catalog.controls) {
    const ks = Object.entries(c.not_applicable).filter(([, r]) => !/^gated by /.test(r)).map(([k]) => k).sort();
    if (ks.length) surface[c.id] = ks;
  }
  assert.deepEqual(surface, {
    'VAPT-API-04': ['rendering-sink'],
    'VAPT-API-08': ['client-storage'],
    'VAPT-CFG-01': ['client-storage', 'outbound-data', 'rendering-sink', 'server-input'],
    'VAPT-CFG-02': ['business-invariant', 'client-storage', 'outbound-data', 'server-input'],
  });
});
test("validator rejects verify.type 'both' without a browser-runner", () => {
  rejects((c) => { const x = c.controls.find((y) => y.id === 'VAPT-WEB-01'); x.env = 'request-harness'; }, 'fields');
});
