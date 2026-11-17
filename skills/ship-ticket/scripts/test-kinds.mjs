#!/usr/bin/env node
/**
 * Risk-triggered required test kinds (T1-S trigger table, S-01b). The kinds a builder must deliver are a TABLE LOOKUP, not a
 * model choice: the approved plan's trigger tags, its recorded risk-floor classes (risk-floor.mjs) and its verified security
 * surfaces (security-plan.mjs) select rows of the table below; each row names the required test kinds (a)-(g).
 *
 *   test-kinds.mjs require --repo <dir> --base <commit> --plan <plan.md>
 *   test-kinds.mjs check   --repo <dir> --base <commit> --plan <plan.md> (--titles <json array|file> | --report-file <final message>)
 *
 * Opt-in: nothing is required (`not_declared`, exit 0) unless the plan has a `test-triggers:` line or the repository commits
 * `.ship-ticket/test-triggers.json`, read from the BASE commit only (never the tree under check). Plan lines, all from the plan
 * narrative (RUN-STATE excluded): exactly one `test-triggers: <tag>[, <tag>...]` (or `none`); `lifecycle-item: <id> <text>`;
 * `test-waiver: <kind|item id> <reason>` (a requested owner disposition). A waiver NEVER removes a requirement here: it is only
 * reported in `waiver_requested` (not applied, needs trusted approval). Applying one needs the engine's pinned approval record
 * for the selected run (S-01b2); the plan file cannot carry that authority. The `risk_floor:` record line is TRUSTED advisory input as recorded
 * in the approved plan (its base must equal --base; it is not recomputed here; absent = `risk_floor_missing`). Tag convention for test titles:
 * `[kind:<kind id>]` and `[plan:<item id>]`, exact and case-sensitive; one title may carry several.
 * Fail closed: an unknown tag, an unmapped risk class, an unmapped or unverifiable security surface, a malformed line or
 * declaration is a refusal, never an empty required set. Output: one JSON object, enums, ids and numbers only.
 * Exit: 0 required/pass/not_declared, 1 refused/freeze_refused, 2 usage.
 * ADVISORY: no engine step enforces the result yet (freeze integration is S-01b2). Presence of a tagged title is not proof
 * that the test exercises the property (mutation is S-01c), and `check` trusts the titles it is given.
 * REUSE: util.parseArgs (native); risk-floor.mjs parseRecordedLine/decodeStrict; security-plan.mjs parsePlanSecurityBlock;
 * worker-report.mjs parseWorkerReport. The declaration validator follows risk-floor.mjs (lib/shape.mjs is not on this base).
 */
import { execFileSync } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseRecordedLine, decodeStrict, CHANGED, CLASS_NAME } from './risk-floor.mjs';
import { parsePlanSecurityBlock } from './security-plan.mjs';
import { parseWorkerReport } from './worker-report.mjs';
import { isEntrypoint } from './harness.mjs';

export { CHANGED };
export const DECLARATION_PATH = '.ship-ticket/test-triggers.json';
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_DECLARATION = 64 * 1024;
const f = (o) => Object.freeze(o);

/** The kinds, keyed by the tag a test title carries. `letter` is the E §1.4 class (a)-(g). */
export const KINDS = f({
  negative: f({ letter: 'a', definition: 'a negative or adversarial test for each new input or authority path (a rejected, ignored or forbidden case)' }),
  race: f({ letter: 'b', definition: 'a concurrency or race scenario: overlapping requests or out-of-order responses' }),
  'stale-N2': f({ letter: 'c', definition: 'stale-result handling with N >= 2 supersessions, not only one' }),
  'error-twin': f({ letter: 'c', definition: 'the error-path twin of every stale-success test: a superseded failure is ignored too' }),
  'lifecycle-destroy': f({ letter: 'd', definition: 'state lifecycle through a real destroy or teardown, not a second init call' }),
  ownership: f({ letter: 'd', definition: 'an ownership boundary: state of one visit, session, user or tenant is never served to another' }),
  'contract-producer': f({ letter: 'e', definition: 'the producer side of a changed cross-module contract' }),
  'contract-consumer': f({ letter: 'e', definition: 'the consumer side of a changed cross-module contract' }),
  'real-entrypoint': f({ letter: 'f', definition: 'integration through the real production entrypoint and wiring, not a hand-built app' }),
  regression: f({ letter: 'g', definition: 'a regression test for the fix that fails when the fix is absent' }),
});
/** Surface tag -> required kinds. Rows pinned by acceptance tests: async-state + ui-lifecycle (AC4), entrypoint and shared-contract (AC10). Others are provisional. */
export const TAGS = f({
  'async-state': f(['stale-N2', 'error-twin', 'negative']),
  'ui-lifecycle': f(['lifecycle-destroy']),
  concurrency: f(['race']),
  money: f(['negative', 'race']),
  tenancy: f(['negative', 'ownership']),
  auth: f(['negative', 'ownership']),
  'input-path': f(['negative']),
  'shared-contract': f(['contract-producer', 'contract-consumer']),
  entrypoint: f(['real-entrypoint']),
  repair: f(['regression']),
});
/** security-plan boundary kind (skills/vapt/controls.json) -> surface tags. Provisional. */
export const SURFACE_TAGS = f({
  'request-handler': f(['input-path', 'entrypoint']), 'auth-lifecycle': f(['auth']), 'external-input-operation': f(['input-path']),
  'rendering-sink': f(['input-path']), 'server-input': f(['input-path']), 'file-path': f(['input-path']), 'client-storage': f(['input-path']),
  'outbound-data': f(['input-path']), 'async-consumer': f(['concurrency', 'input-path']), 'security-config': f(['entrypoint']), 'business-invariant': f(['money']),
});

const bad = (code, message = code) => Object.assign(new Error(message), { code });
const uniq = (xs) => [...new Set(xs)].sort();

/** Validate a parsed repository declaration `{version:1, tags?:{tag:[kind]}, classes?:{riskClass:[tag]}}`; it can only ADD rows. */
export function validateDeclaration(d) {
  const inv = (m) => bad('declaration_invalid', m);
  const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isMap(d) || d.version !== 1 || Object.keys(d).some((k) => !['version', 'tags', 'classes'].includes(k))) throw inv('version must be 1; only version, tags and classes are allowed');
  const list = (v, ok, what) => { if (!Array.isArray(v) || !v.length || v.length > 16 || !v.every(ok)) throw inv(`${what} must be a non-empty list of at most 16 known names`); return uniq(v); };
  const tags = Object.create(null), classes = Object.create(null); // no inherited names (`constructor`) can resolve
  for (const [k, field, out] of [['tags', d.tags, tags], ['classes', d.classes, classes]]) {
    if (field === undefined) continue;
    if (!isMap(field) || Object.keys(field).length > 64) throw inv(`${k} must be an object of at most 64 entries`);
    for (const name of Object.keys(field)) if (!(k === 'classes' ? CLASS_NAME : NAME).test(name) || name === 'none') throw inv(`${k} name ${JSON.stringify(name)} is not a lower-case identifier (none is reserved)`);
    Object.assign(out, field);
  }
  for (const t of Object.keys(tags)) tags[t] = list(tags[t], (x) => Object.hasOwn(KINDS, x), `tags.${t}`);
  const known = (x) => Object.hasOwn(TAGS, x) || Object.hasOwn(tags, x);
  for (const c of Object.keys(classes)) classes[c] = list(classes[c], known, `classes.${c}`);
  return { tags, classes };
}

const RS_BEGIN = '<!-- RUN-STATE:BEGIN -->', RS_END = '<!-- RUN-STATE:END -->';
const narrative = (t) => { const b = t.indexOf(RS_BEGIN), e = t.indexOf(RS_END); return b < 0 || e < b ? t : t.slice(0, b) + t.slice(e + RS_END.length); };
const linesOf = (text, key) => text.split(/\r?\n/).map((l) => new RegExp(`^\\s*${key}:(.*)$`).exec(l)).filter(Boolean).map((m) => m[1].trim());
// Any line that mentions a plan key, however decorated (a bullet, bold, another case): each must be one strict line, so a near miss never reads as absent.
const LOOSE = /test-triggers|lifecycle-item|test-waiver/i;
const nearMiss = (text) => text.split(/\r?\n/).filter((l) => LOOSE.test(l)).length !== ['test-triggers', 'lifecycle-item', 'test-waiver'].reduce((n, k) => n + linesOf(text, k).length, 0);

/** The required kinds and items for a plan, under an optional validated declaration. Pure; never throws. */
export function requiredFor({ planText, declaration = null, baseSha = null }) {
  const errors = [], out = (status, o = {}) => ({ status, kinds: [], items: [], waiver_requested: [], tags: [], errors: uniq(errors), ...o });
  if (typeof planText !== 'string') return (errors.push('plan_invalid'), out('refused'));
  const text = narrative(planText);
  const trig = linesOf(text, 'test-triggers');
  if (!trig.length && !declaration && !LOOSE.test(text)) return out('not_declared');
  const table = Object.assign(Object.create(null), TAGS);
  for (const [t, ks] of Object.entries(declaration?.tags ?? {})) table[t] = uniq([...(table[t] ?? []), ...ks]);
  const tags = new Set();
  if (nearMiss(text)) errors.push('plan_line_invalid');
  if (!trig.length) errors.push('plan_tags_missing');
  else if (trig.length > 1 || !trig[0]) errors.push('plan_line_invalid');
  else if (trig[0] !== 'none') for (const t of trig[0].split(',').map((x) => x.trim())) { if (Object.hasOwn(table, t)) tags.add(t); else errors.push('unknown_tag'); }
  // risk floor classes: exactly one strict record line as risk-floor.mjs writes it (trusted as recorded in the plan, not recomputed)
  const floorLines = text.split(/\r?\n/).filter((l) => /^\s*(?:risk_floor:[ \t]*)?risk-floor:/.test(l));
  if (!floorLines.length) errors.push('risk_floor_missing');
  else {
    let classes = null; // parseRecordedLine validates the one line strictly; the classes are read from that same line
    try {
      const rec = parseRecordedLine(text);
      if (baseSha !== null && rec.base !== String(baseSha).slice(0, 12)) errors.push('risk_floor_base_mismatch');
      const raw = /; classes=([^;]*);/.exec(floorLines[0])[1];
      classes = raw === 'none' ? [] : raw.split(','); // `none` is the producer's empty-set sentinel
      if (!classes.every((c) => CLASS_NAME.test(c) && c !== 'none')) throw new Error('bad class');
    } catch { classes = null; errors.push('risk_floor_invalid'); }
    for (const c of classes ?? []) { // add-only: the built-in reading of a class and the declared mapping are UNITED
      const declared = declaration && c in declaration.classes ? declaration.classes[c] : null;
      const builtin = c in table ? [c] : c === CHANGED ? [] : null;
      if (!declared && !builtin) errors.push('risk_class_unmapped'); else [...(declared ?? []), ...(builtin ?? [])].forEach((t) => tags.add(t));
    }
  }
  // security surfaces: a verified block, or none at all
  if (/<!-- security-plan: /.test(text)) {
    const block = parsePlanSecurityBlock(planText);
    if (!block) errors.push('security_block_invalid');
    else for (const s of block.surfaces) { if (Object.hasOwn(SURFACE_TAGS, s.kind)) SURFACE_TAGS[s.kind].forEach((t) => tags.add(t)); else errors.push('surface_kind_unmapped'); }
  }
  const items = [];
  for (const l of linesOf(text, 'lifecycle-item')) { const m = /^(\S+)\s+\S/.exec(l); if (!m || !ITEM_ID.test(m[1]) || Object.hasOwn(KINDS, m[1]) || items.includes(m[1])) errors.push('plan_line_invalid'); else items.push(m[1]); }
  const waivers = new Set();
  for (const l of linesOf(text, 'test-waiver')) { const m = /^(\S+)\s+\S/.exec(l); if (!m || !(Object.hasOwn(KINDS, m[1]) || items.includes(m[1]))) errors.push('waiver_invalid'); else waivers.add(m[1]); }
  if (errors.length) return out('refused');
  const kinds = uniq([...tags].flatMap((t) => table[t]));
  // waivers are reported, never applied: the requirement stays and a missing kind is still missing
  return out('required', { tags: uniq([...tags]), kinds, items: items.sort(), waiver_requested: uniq([...waivers].filter((w) => kinds.includes(w) || items.includes(w))) });
}

/** The `[kind:..]` and `[plan:..]` markers in test titles. `unknown`: well-formed kind markers naming no kind. */
export function markers(titles) {
  const kinds = new Set(), items = new Set(), unknown = new Set();
  for (const t of titles) for (const m of String(t).matchAll(/\[(kind|plan):([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g)) {
    if (m[1] === 'plan') items.add(m[2]); else if (Object.hasOwn(KINDS, m[2])) kinds.add(m[2]); else unknown.add(`kind:${m[2]}`);
  }
  return { kinds: [...kinds].sort(), items: [...items].sort(), unknown: [...unknown].sort() };
}

/** Compare a requirement with test titles. `freeze_refused` lists `missing_test_kinds` and/or `unmapped_lifecycle_item`. */
export function checkTitles(req, titles) {
  if (req.status !== 'required') return { ...req, status: req.status, reasons: [], record_line: `test-kinds: status=${req.status}` };
  const m = markers(titles);
  const missing = req.kinds.filter((k) => !m.kinds.includes(k)), unmapped = req.items.filter((i) => !m.items.includes(i));
  const reasons = [...(missing.length ? ['missing_test_kinds'] : []), ...(unmapped.length ? ['unmapped_lifecycle_item'] : [])];
  const status = reasons.length ? 'freeze_refused' : 'pass';
  const counts = { required: req.kinds.length, present: req.kinds.length - missing.length, missing: missing.length, waiver_requested: req.waiver_requested.length, items: req.items.length, unmapped: unmapped.length, unknown_markers: m.unknown.length };
  return { status, reasons, missing_kinds: missing, unmapped_items: unmapped, unknown_markers: m.unknown, waiver_requested: req.waiver_requested, counts,
    record_line: `test-kinds: status=${status}; ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('; ')}; reasons=${reasons.join(',') || 'none'}` };
}

// ---- the declaration at BASE ----
// TEMPORARY third copy of the hardened-git helper (also in fast-checks.mjs and risk-floor.mjs): no inherited GIT_*, no replace
// objects, literal pathspecs. TODO(S-02a0b): replace with lib/git-capability.mjs (git-exec) when it lands; do not extend this copy.
const gitEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.toUpperCase().startsWith('GIT_')) delete e[k]; return { ...e, GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' }; };
const git = (cwd, args) => execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const gitText = (cwd, args) => git(cwd, args).toString('utf8').replace(/\n$/, '');
/** `{declaration|null, baseSha}` from the BASE commit. */
export function readDeclaration(repo, base) {
  if (typeof base !== 'string' || !base || base.startsWith('-')) throw bad('base_invalid');
  let top, sha;
  try { top = realpathSync.native(gitText(realpathSync.native(repo), ['rev-parse', '--show-toplevel'])); } catch { throw bad('repo_unavailable'); }
  try { sha = gitText(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`]); } catch { throw bad('base_invalid'); }
  const entry = gitText(top, ['ls-tree', '-z', sha, '--', DECLARATION_PATH]).replace(/\0$/, '');
  if (!entry) return { declaration: null, baseSha: sha };
  const m = /^(100644|100755) blob ([0-9a-f]+)\t/.exec(entry);
  if (!m || Number(gitText(top, ['cat-file', '-s', m[2]])) > MAX_DECLARATION) throw bad('declaration_invalid', 'not a regular file within the size limit');
  try { return { declaration: validateDeclaration(JSON.parse(decodeStrict(git(top, ['cat-file', 'blob', m[2]])))), baseSha: sha }; } catch (e) { throw e.code === 'declaration_invalid' ? e : bad('declaration_invalid'); }
}

// ---- CLI ----
const refusedOut = (code) => ({ status: 'refused', kinds: [], items: [], waiver_requested: [], tags: [], errors: [code] });
export function main(argv) {
  const usage = { code: 2, out: { status: 'refused', errors: ['bad_usage'], usage: 'test-kinds.mjs require|check --repo <dir> --base <commit> --plan <plan.md> [--titles <json|file> | --report-file <file>]' } };
  const [cmd, ...rest] = argv;
  let v;
  try { ({ values: v } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { repo: { type: 'string' }, base: { type: 'string' }, plan: { type: 'string' }, titles: { type: 'string' }, 'report-file': { type: 'string' } } })); } catch { return usage; }
  if (!['require', 'check'].includes(cmd) || !v.repo || !v.base || !v.plan || rest.filter((a) => a.startsWith('--')).length !== Object.keys(v).length) return usage;
  if (cmd === 'require' ? (v.titles || v['report-file']) : !v.titles === !v['report-file']) return usage;
  let r;
  try {
    const planText = decodeStrict(readFileSync(v.plan));
    const { declaration, baseSha } = readDeclaration(v.repo, v.base);
    r = requiredFor({ planText, declaration, baseSha });
  } catch (e) { r = refusedOut(e.code && /^[a-z_]+$/.test(e.code) ? e.code : 'plan_unreadable'); }
  if (cmd === 'check' && r.status === 'required') {
    let titles = null;
    if (v['report-file']) {
      let p; try { p = parseWorkerReport(readFileSync(v['report-file'], 'utf8'), { testKindsDeclared: true }); } catch { p = { failure: 'report_unreadable' }; }
      if (p.status === 'structured') titles = p.report.test_titles; else r = refusedOut(/^[a-z_]+$/.test(p.failure) ? p.failure : 'report_unstructured');
    } else {
      try { titles = JSON.parse(v.titles.trim().startsWith('[') ? v.titles : readFileSync(v.titles, 'utf8')); } catch { titles = null; }
      if (!Array.isArray(titles) || !titles.every((t) => typeof t === 'string')) { titles = null; r = refusedOut('titles_invalid'); }
    }
    if (titles) r = checkTitles(r, titles);
  } else if (cmd === 'check') r = checkTitles(r, []);
  return { code: ['refused', 'freeze_refused'].includes(r.status) ? 1 : 0, out: r };
}
if (isEntrypoint(import.meta.url)) { const { code, out } = main(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(out)}\n`); process.exitCode = code; }
