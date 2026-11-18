/**
 * S-01b2 P4r: runner evidence I/O, the REUSE side (design rev 6 section 3) and the verdict: P2 input and P6 waiver policy
 * integration (owner amendment 2026-11-18: base = pure primitives, io = record construction and the shared rules, reuse = this).
 * The shared rules (current context, record schema, R-3), the claim (L-ran) and the record side are in `engine-test-kinds-io.mjs`;
 * this module adds no rule of its own beyond the four section 3 conditions, and calls the SAME functions buildRecord calls (I-A).
 *
 * WHAT A STORED RECORD IS TRUSTED FOR, AND WHAT IT IS NOT. Before any credit, a record must
 *   1. pass `validRecord`: the complete schema, per-row invariants, and stored totals EQUAL to the totals of its rows (nothing
 *      is stored that its rows cannot be checked against). Otherwise `malformed`.
 *   2. pass the four section 3 conditions, in this order: identity, integrity, applicability, freshness. Applicability is
 *      RE-DERIVED from the candidate for every `counted` row: the file is in P, an lstat-regular file reached by no symlink,
 *      matching the test globs and the entry's `covers`, at most 4 MiB, and every credited id still satisfies R-3 against the
 *      candidate and base bytes now, with the stored `skipped` counts subtracted, and every WITHHELD id still has its stated reason.
 * What CANNOT be re-derived, because the report is not stored: that a passed result really carried each credited marker, how
 * many results passed, and how many non-passed carriers there were. A record is state the ENGINE wrote from a sealed report;
 * whoever can rewrite that state can claim a passing test that failed, or delete a `skipped` count, consistently enough to pass
 * every check above. The checks catch a record that contradicts itself or the candidate, not a consistent forgery; the
 * integrity of engine state is FX/P5r's to protect. Credits are read ONLY from the validated copy (no getter or trap runs).
 */
import { kindsForClasses, PROTECTED_TAGS } from './test-kinds.mjs';
import { testKindsVerdict } from './engine-test-kinds.mjs';
import { testKindWaivers } from './engine-authority.mjs';
import { CLAIM, RUNNER, INTEGRITY, refuse, codeOf, refusalOf, own, ownOr, plain, matches, census, r3Inputs, r3Rule, applicable, currentContext, validRecord } from './engine-test-kinds-io.mjs';

/** The four section 3 conditions on a validated copy; `cur` carries the candidate. `{ok:true, evidence}` | `{ok:false, reason}`. */
function judge(copy, cur, ctx) {
  const { c, entry, covers, testGlobs } = cur;
  if (copy.evidence_id !== c.evidence_id || copy.base_sha !== c.base_sha) return { ok: false, reason: 'identity' };
  if (!INTEGRITY.every((k) => copy.integrity[k] === true)) return { ok: false, reason: 'integrity' };
  const runnerOk = copy.runner.id === RUNNER.id && copy.runner.format === RUNNER.format && copy.claim === CLAIM;
  if (copy.entry !== entry.name || copy.exit_code !== 0 || !runnerOk) return { ok: false, reason: 'applicability' };
  const counted = copy.files.filter((f) => f.outcome === 'counted');
  for (const f of counted) if (c.inP(f.file) === null || applicable(c.top, f.file, testGlobs, covers, ctx) !== null) return { ok: false, reason: 'applicability' };
  if (counted.some((f) => f.credited.length || f.withheld.size)) {
    const rule = r3Rule(census(c), r3Inputs(copy.files, c.inP), ctx);
    for (const f of counted) {
      for (const m of f.credited) if (rule(f.file, m) !== 'credit') return { ok: false, reason: 'applicability' };
      for (const [m, why] of f.withheld) if (rule(f.file, m) !== why) return { ok: false, reason: 'applicability' };
    }
  }
  if (copy.dag_digest !== cur.dag_digest || copy.command_digest !== cur.command_digest || copy.config_digest !== cur.config_digest) return { ok: false, reason: 'freshness' };
  const kinds = [], items = [], withheld = {};
  for (const f of counted) for (const m of f.credited) (m.startsWith('kind:') ? kinds : items).push(m.slice(5));
  for (const f of counted) for (const [m, why] of f.withheld) if (withheld[m] !== 'r3_offset') withheld[m] = why;
  return { ok: true, evidence: { kinds, items, unknown_markers: copy.counts.unknown_markers, withheld } };
}
function usable(R, cur, ctx) {
  let copy;
  try { copy = validRecord(R, ctx); } catch (e) { if (codeOf(e) === 'evidence_budget_exceeded') throw e; copy = null; }
  return copy ? judge(copy, cur, ctx) : { ok: false, reason: 'malformed' };
}
const per = (ctxt, name, dagDigest) => { const p = ctxt.per.get(name); return { c: ctxt.c, testGlobs: ctxt.testGlobs, entry: p.entry, covers: p.covers, dag_digest: dagDigest, command_digest: p.command_digest, config_digest: p.config_digest }; };

/**
 * recordUsable(R, cur) -> { ok:true, evidence:{kinds, items, unknown_markers, withheld:{id: reason}} } | { ok:false, reason, code?, detail? }
 * cur = { repo, baseSha, exclusions?, dagDigest, entry, command:{cmd, args} (what would run NOW), tests:{globs} }.
 * reason: 'malformed' | 'identity' | 'integrity' | 'applicability' | 'freshness' | 'unavailable' (with the refusal `code`:
 * the same code tkVerdict refuses with on the same candidate, from the same `currentContext`). Never throws.
 */
export function recordUsable(R, cur) {
  try {
    const ctx = { work: 0, max: 5_000_000, glob: { steps: 0 } };
    const ctxt = currentContext({ repo: own(cur, 'repo'), baseSha: own(cur, 'baseSha'), exclusions: ownOr(cur, 'exclusions', []), entries: [own(cur, 'entry')],
      commandOf: () => own(cur, 'command'), needCommand: () => true, globs: own(own(cur, 'tests'), 'globs') }, ctx);
    const [name] = ctxt.per.keys();
    return usable(R, per(ctxt, name, own(cur, 'dagDigest')), ctx);
  } catch (e) { return { ok: false, reason: 'unavailable', ...refusalOf(e, 'test_kinds_error') }; }
}

// ---- the verdict (P2 input + P6 waivers; P4r never runs anything) ----
const refusedVerdict = ({ code, detail }) => ({ status: 'refused', code, ...(detail ? { detail } : {}), codes: [code], required_kinds: [], required_items: [], protected_kinds: [], missing_kinds: [], unmapped_items: [], waived: [], counts: {}, evidence_id: null, claim: CLAIM, records: {}, voids: {}, withheld: {} });
/**
 * tkVerdict(E, point) -> the P2 verdict plus { evidence_id, claim:'L-ran', records:{<entry>: 'current'|'absent'|'stale:<reason>'}, voids:{runner_uncovered:n},
 *   withheld:{<id>: 'r3_unchanged'|'r3_offset'} (a passed marker R-3 did not credit, and why; an id credited by any record is not listed) }.
 * A refusal carries `detail` when one cause is worth naming (`submodule_unsupported_v0`, `path_alias`).
 * E = { repo, baseSha, exclusions?, dagDigest, entries:[entry], commands:{<name>:{cmd,args}} (the CURRENT substituted commands;
 *       a name may be missing only when its record is), records:{<name>: R}, tests:{globs}, bound, declaration, reassessed:[class],
 *       S (the engine state for waivers), retryAuthorised? }.
 * P2 is called through its REAL interface (the real `kindsForClasses`); held and open repairs are 0 (inert in V0). Never throws.
 */
export function tkVerdict(E, point) {
  try { return verdict(E, point); } catch (e) { return refusedVerdict(refusalOf(e, 'test_kinds_error')); }
}
function verdict(E, point) {
  const ctx = { work: 0, max: 5_000_000, glob: { steps: 0 } };
  const commands = own(E, 'commands'), records = own(E, 'records');
  if (!plain(commands) || !plain(records)) refuse('test_kinds_error');
  const has = (o, name) => Reflect.getOwnPropertyDescriptor(o, name) !== undefined;
  const ctxt = currentContext({ repo: own(E, 'repo'), baseSha: own(E, 'baseSha'), exclusions: ownOr(E, 'exclusions', []), entries: own(E, 'entries'),
    commandOf: (en) => (has(commands, en.name) ? own(commands, en.name) : undefined), needCommand: (en) => has(records, en.name), globs: own(own(E, 'tests'), 'globs') }, ctx);
  const { c, testGlobs } = ctxt, dagDigest = own(E, 'dagDigest');
  const kinds = new Set(), items = new Set(), states = {}, withheld = {};
  let unknown = 0;
  for (const [name] of ctxt.per) {
    if (!has(records, name)) { states[name] = 'absent'; continue; }
    const u = usable(own(records, name), per(ctxt, name, dagDigest), ctx);
    states[name] = u.ok ? 'current' : `stale:${u.reason}`;
    if (!u.ok) continue;
    for (const k of u.evidence.kinds) kinds.add(k);
    for (const i of u.evidence.items) items.add(i);
    unknown += u.evidence.unknown_markers;
    for (const [m, why] of Object.entries(u.evidence.withheld)) if (withheld[m] !== 'r3_offset') withheld[m] = why;
  }
  for (const m of Object.keys(withheld)) if ((m.startsWith('kind:') ? kinds : items).has(m.slice(5))) delete withheld[m]; // credited elsewhere
  let uncovered = 0;
  const coverSets = [...ctxt.per.values()].map((p) => p.covers);
  for (const p of c.paths) if (matches(testGlobs, p, ctx) && !coverSets.some((cv) => matches(cv, p, ctx))) uncovered++;
  const S = own(E, 'S');
  const base = { bound: own(E, 'bound'), declaration: own(E, 'declaration'), reassessed: own(E, 'reassessed'), evidence: { kinds: [...kinds].sort(), items: [...items].sort(), unknown_markers: unknown } };
  const deps = { kindsForClasses, protectedTags: [...PROTECTED_TAGS] };
  const run = (w) => testKindsVerdict({ ...base, waivers: w, state: { point, retry_authorised: ownOr(E, 'retryAuthorised', false) === true, held: 0, open_repairs: 0 } }, deps);
  const v0 = run({ trusted: [], untrusted: [] });
  const done = (v) => ({ ...v, evidence_id: c.evidence_id, claim: CLAIM, records: states, voids: { runner_uncovered: uncovered }, withheld: Object.fromEntries(Object.entries(withheld).sort()) });
  if (['test_kinds_error', 'evidence_budget_exceeded'].includes(v0.code)) return done(v0);
  // P6 owns waiver matching and trust: it needs the REQUIRED and PROTECTED sets P2 just recomputed, and the evidence identity as the candidate
  const w = testKindWaivers(S, c.evidence_id, { required: [...v0.required_kinds.map((k) => `kind:${k}`), ...v0.required_items.map((i) => `plan:${i}`)], protected: v0.protected_kinds.map((k) => `kind:${k}`) });
  if (!w.ok) return done({ ...v0, status: 'refused', code: w.code, codes: [w.code] });
  return done(run({ trusted: w.waived, untrusted: w.unauthorized }));
}
