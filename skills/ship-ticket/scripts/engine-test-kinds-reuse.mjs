/**
 * S-01b2 P4r: runner evidence I/O, the REUSE side (design rev 6 section 3) and the verdict (P2 input + P6 waivers).
 * The record side, the shared readers, the claim (L-ran) and the R-3 rule are in `engine-test-kinds-io.mjs`.
 *
 * A STORED RECORD NEVER VOUCHES FOR ITSELF (I1). Before any credit, a record must
 *   1. match the COMPLETE schema (`validRecord`): exact key sets at every level, typed provenance, `runner`/`claim` present,
 *      every row's outcome in the allowlist, `credited` only on `counted` rows and only creditable ids (a known kind or an
 *      ITEM_ID item, sorted and unique), `skipped` counts typed, and `counts` consistent with the rows. Otherwise `malformed`.
 *   2. pass the four section 3 conditions, in this order: identity, integrity, applicability, freshness. Applicability is
 *      RE-DERIVED from the candidate for every `counted` row: the file is in P, an lstat-regular file reached by no symlink,
 *      matching the test globs and the entry's `covers`, at most 4 MiB, and every credited id still satisfies R-3 against the
 *      candidate and base bytes now. What CANNOT be re-derived (the report is not stored): that a passed result carried the
 *      marker, and the non-passed carrier counts (`skipped`). Those two rest on the sealed report the record was built from.
 * Credits are then read ONLY from the validated copy `validRecord` returns (no getter or proxy trap of the stored record runs).
 */
import { kindsForClasses, PROTECTED_TAGS } from './test-kinds.mjs';
import { testKindsVerdict } from './engine-test-kinds.mjs';
import { testKindWaivers } from './engine-authority.mjs';
import {
  LIMITS, FILE_VOIDS, CLAIM, BUILTIN_TEST_GLOBS, RUNNER, INTEGRITY, SHA, HEX64, EVIDENCE_ID, ENTRY_NAME, MARKER_ID, creditable,
  refuse, codeOf, own, ownOr, arr, plain, exactKeys, safeRel, globList, matcher, matches,
  candidate, census, r3, applicable, readEntry, commandFor, commandDigest, configDigest,
} from './engine-test-kinds-io.mjs';

const TOP = ['evidence_id', 'base_sha', 'entry', 'dag_digest', 'command_digest', 'config_digest', 'attempt_id', 'exit_code', 'report_sha256', 'report_len', 'runner', 'claim', 'integrity', 'files', 'counts'];
const ROW = ['file', 'outcome', 'credited', 'skipped'], COUNTS = ['results', 'passed', 'marker_files', 'credited', 'unknown_markers'], RUNNER_KEYS = ['id', 'version', 'format'];
const OUTCOMES = ['counted', ...FILE_VOIDS];
const uint = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const sortedUnique = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);

/** The complete schema (I1). Returns a fresh validated copy built from primitives, or null. Throws only a Refusal on a hostile shape. */
function validRecord(R, ctx) {
  if (!exactKeys(R, TOP)) return null;
  const g = (k) => own(R, k);
  const runner = g('runner'), integ = g('integrity'), counts = g('counts');
  if (!exactKeys(runner, RUNNER_KEYS) || !exactKeys(integ, INTEGRITY) || !exactKeys(counts, COUNTS)) return null;
  const copy = {
    evidence_id: g('evidence_id'), base_sha: g('base_sha'), entry: g('entry'), dag_digest: g('dag_digest'), command_digest: g('command_digest'), config_digest: g('config_digest'),
    attempt_id: g('attempt_id'), exit_code: g('exit_code'), report_sha256: g('report_sha256'), report_len: g('report_len'), claim: g('claim'),
    runner: Object.fromEntries(RUNNER_KEYS.map((k) => [k, own(runner, k)])), integrity: Object.fromEntries(INTEGRITY.map((k) => [k, own(integ, k)])),
    counts: Object.fromEntries(COUNTS.map((k) => [k, own(counts, k)])), files: [],
  };
  const typed = typeof copy.evidence_id === 'string' && EVIDENCE_ID.test(copy.evidence_id) && typeof copy.base_sha === 'string' && SHA.test(copy.base_sha)
    && typeof copy.entry === 'string' && ENTRY_NAME.test(copy.entry) && ['dag_digest', 'command_digest', 'config_digest', 'report_sha256'].every((k) => typeof copy[k] === 'string' && HEX64.test(copy[k]))
    && str(copy.attempt_id, 80) && Number.isSafeInteger(copy.exit_code) && uint(copy.report_len, LIMITS.maxReportBytes) && str(copy.claim, 16)
    && RUNNER_KEYS.every((k) => str(copy.runner[k], 64)) && INTEGRITY.every((k) => typeof copy.integrity[k] === 'boolean')
    && COUNTS.every((k) => uint(copy.counts[k])) && copy.counts.passed <= copy.counts.results && copy.counts.results <= LIMITS.maxResults
    && copy.counts.unknown_markers <= LIMITS.maxMarkerFiles * LIMITS.maxIds;
  if (!typed) return null;
  const seen = new Set();
  let credited = 0;
  for (const f of arr(g('files'), LIMITS.maxMarkerFiles, plain, ctx)) {
    if (!exactKeys(f, ROW)) return null;
    const file = own(f, 'file'), outcome = own(f, 'outcome');
    if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return null;
    if (!(file === null ? outcome === 'result_outside_repo' : safeRel(file) && outcome !== 'result_outside_repo')) return null;
    if (file !== null && seen.has(file)) return null;
    seen.add(file);
    const ids = arr(own(f, 'credited'), LIMITS.maxIds, creditable, ctx);
    if ((outcome !== 'counted' && ids.length) || !sortedUnique(ids)) return null; // a VOID row never credits (I1)
    const sk = own(f, 'skipped');
    if (!plain(sk)) return null;
    const keys = Reflect.ownKeys(sk);
    if (keys.length > LIMITS.maxIds) return null;
    const skipped = new Map();
    for (const k of keys) { if (typeof k !== 'string' || !MARKER_ID.test(k)) return null; const n = own(sk, k); if (!uint(n) || n === 0) return null; skipped.set(k, n); }
    credited += ids.length;
    copy.files.push({ file, outcome, credited: [...ids], skipped });
  }
  if (copy.counts.marker_files !== copy.files.length || copy.counts.credited !== credited) return null;
  return copy;
}

/** The four section 3 conditions on a validated copy; `cur` carries the candidate. `{ok:true, evidence}` | `{ok:false, reason}`. */
function judge(copy, cur, ctx) {
  const { c, entry, testGlobs } = cur;
  if (copy.evidence_id !== c.evidence_id || copy.base_sha !== c.base_sha) return { ok: false, reason: 'identity' };
  if (!INTEGRITY.every((k) => copy.integrity[k] === true)) return { ok: false, reason: 'integrity' };
  const runnerOk = copy.runner.id === RUNNER.id && copy.runner.format === RUNNER.format && copy.claim === CLAIM;
  if (copy.entry !== entry.name || copy.exit_code !== 0 || !runnerOk) return { ok: false, reason: 'applicability' };
  const inP = new Set(c.paths), covers = matcher(entry.covers), counted = copy.files.filter((f) => f.outcome === 'counted');
  const skipped = new Map(copy.files.filter((f) => f.file !== null && inP.has(f.file)).map((f) => [f.file, f.skipped]));
  for (const f of counted) if (!inP.has(f.file) || applicable(c.top, f.file, testGlobs, covers, ctx) !== null) return { ok: false, reason: 'applicability' };
  const cs = counted.some((f) => f.credited.length) ? census(c) : null;
  for (const f of counted) for (const m of f.credited) if (!r3(cs, f.file, m, skipped)) return { ok: false, reason: 'applicability' };
  if (copy.dag_digest !== cur.dag_digest || copy.command_digest !== cur.command_digest || copy.config_digest !== cur.config_digest) return { ok: false, reason: 'freshness' };
  const kinds = [], items = [];
  for (const f of counted) for (const m of f.credited) (m.startsWith('kind:') ? kinds : items).push(m.slice(5));
  return { ok: true, evidence: { kinds, items, unknown_markers: copy.counts.unknown_markers } };
}
function usable(R, cur, ctx) {
  let copy;
  try { copy = validRecord(R, ctx); } catch (e) { if (codeOf(e) === 'evidence_budget_exceeded') throw e; copy = null; }
  return copy ? judge(copy, cur, ctx) : { ok: false, reason: 'malformed' };
}

/**
 * recordUsable(R, cur) -> { ok:true, evidence:{kinds, items, unknown_markers} } | { ok:false, reason, code? }
 * cur = { repo, baseSha, exclusions?, dagDigest, entry, command:{cmd, args} (what would run NOW), tests:{globs} }.
 * reason: 'malformed' | 'identity' | 'integrity' | 'applicability' | 'freshness' | 'unavailable' (with the refusal `code`). Never throws.
 */
export function recordUsable(R, cur) {
  try {
    const ctx = { work: 0, max: 5_000_000, glob: { steps: 0 } };
    const entry = readEntry(own(cur, 'entry')), cmd = own(cur, 'command'), command = commandFor(entry, own(cmd, 'cmd'), own(cmd, 'args'));
    const c = candidate(own(cur, 'repo'), own(cur, 'baseSha'), ownOr(cur, 'exclusions', []));
    const cd = configDigest(c.top, entry.config_paths);
    if (!cd.ok) refuse(cd.code);
    const testGlobs = matcher([...BUILTIN_TEST_GLOBS, ...globList(own(own(cur, 'tests'), 'globs'), ctx)]);
    return usable(R, { c, entry, testGlobs, dag_digest: own(cur, 'dagDigest'), command_digest: commandDigest(command.cmd, command.args), config_digest: cd.digest }, ctx);
  } catch (e) { return { ok: false, reason: 'unavailable', code: codeOf(e, 'test_kinds_error') }; }
}

// ---- the verdict (P2 input + P6 waivers; P4r never runs anything) ----
const refusedVerdict = (code, evidence_id = null) => ({ status: 'refused', code, codes: [code], required_kinds: [], required_items: [], protected_kinds: [], missing_kinds: [], unmapped_items: [], waived: [], counts: {}, evidence_id, claim: CLAIM, records: {}, voids: {} });
/**
 * tkVerdict(E, point) -> the P2 verdict plus { evidence_id, claim:'L-ran', records:{<entry>: 'current'|'absent'|'stale:<reason>'}, voids:{runner_uncovered:n} }.
 * E = { repo, baseSha, exclusions?, dagDigest, entries:[entry], commands:{<name>:{cmd,args}} (the CURRENT substituted commands),
 *       records:{<name>: R}, tests:{globs}, bound, declaration, reassessed:[class], S (the engine state for waivers), retryAuthorised? }.
 * P2 is called through its REAL interface (the real `kindsForClasses`); held and open repairs are 0 (inert in V0). Never throws.
 */
export function tkVerdict(E, point) {
  try { return verdict(E, point); } catch (e) { return refusedVerdict(codeOf(e, 'test_kinds_error')); }
}
function verdict(E, point) {
  const ctx = { work: 0, max: 5_000_000, glob: { steps: 0 } };
  const repo = own(E, 'repo'), baseSha = own(E, 'baseSha'), dagDigest = own(E, 'dagDigest');
  const entries = arr(own(E, 'entries'), LIMITS.maxList, plain, ctx).map(readEntry); // runner_unsupported is raised, never skipped
  const c = candidate(repo, baseSha, ownOr(E, 'exclusions', []));
  const all = new Set(c.all);
  if (entries.some((en) => en.config_paths.some((p) => all.has(p)))) refuse('runner_config_changed'); // before ANY exclusion (I6)
  const testGlobs = matcher([...BUILTIN_TEST_GLOBS, ...globList(own(own(E, 'tests'), 'globs'), ctx)]);
  const commands = own(E, 'commands'), records = own(E, 'records');
  if (!plain(commands) || !plain(records)) refuse('test_kinds_error');
  const coverSets = entries.map((en) => matcher(en.covers));
  const kinds = new Set(), items = new Set(), states = {};
  let unknown = 0;
  for (const en of entries) {
    const R = Reflect.getOwnPropertyDescriptor(records, en.name);
    if (!R) { states[en.name] = 'absent'; continue; }
    if (!('value' in R)) refuse('test_kinds_error');
    const cmd = own(commands, en.name), command = commandFor(en, own(cmd, 'cmd'), own(cmd, 'args')), cd = configDigest(c.top, en.config_paths);
    if (!cd.ok) refuse(cd.code);
    const u = usable(R.value, { c, entry: en, testGlobs, dag_digest: dagDigest, command_digest: commandDigest(command.cmd, command.args), config_digest: cd.digest }, ctx);
    states[en.name] = u.ok ? 'current' : `stale:${u.reason}`;
    if (!u.ok) continue;
    for (const k of u.evidence.kinds) kinds.add(k);
    for (const i of u.evidence.items) items.add(i);
    unknown += u.evidence.unknown_markers;
  }
  let uncovered = 0;
  for (const p of c.paths) if (matches(testGlobs, p, ctx) && !coverSets.some((cv) => matches(cv, p, ctx))) uncovered++;
  const S = own(E, 'S');
  const base = { bound: own(E, 'bound'), declaration: own(E, 'declaration'), reassessed: own(E, 'reassessed'), evidence: { kinds: [...kinds].sort(), items: [...items].sort(), unknown_markers: unknown } };
  const deps = { kindsForClasses, protectedTags: [...PROTECTED_TAGS] };
  const run = (w) => testKindsVerdict({ ...base, waivers: w, state: { point, retry_authorised: ownOr(E, 'retryAuthorised', false) === true, held: 0, open_repairs: 0 } }, deps);
  const v0 = run({ trusted: [], untrusted: [] });
  const done = (v) => ({ ...v, evidence_id: c.evidence_id, claim: CLAIM, records: states, voids: { runner_uncovered: uncovered } });
  if (['test_kinds_error', 'evidence_budget_exceeded'].includes(v0.code)) return done(v0);
  // P6 owns waiver matching and trust: it needs the REQUIRED and PROTECTED sets P2 just recomputed, and the evidence identity as the candidate
  const w = testKindWaivers(S, c.evidence_id, { required: [...v0.required_kinds.map((k) => `kind:${k}`), ...v0.required_items.map((i) => `plan:${i}`)], protected: v0.protected_kinds.map((k) => `kind:${k}`) });
  if (!w.ok) return done({ ...v0, status: 'refused', code: w.code, codes: [w.code] });
  return done(run({ trusted: w.waived, untrusted: w.unauthorized }));
}
