/**
 * Run adoption, same base (S-13a, ASTF-7; PLAN-S13 §4). A new run adopts the still-valid `done` nodes of an archived run of the
 * same ticket and approved plan, and the archived RED evidence of those nodes, so `drive` does not re-dispatch builders whose
 * outputs are unchanged. Node built-ins only. run-engine.mjs `adopt` and `archive --retire` are thin wrappers over this module.
 *
 * Authority: none of its own. The owner's trusted START of the new run is the approval; adoption requires the archived plan
 * digest to equal it (`adopt_plan_mismatch`). ADOPTED is an engine note, never a RUN-STATE line or an authority event.
 *
 * Per node (adoptable): archived and `done` (else `node_not_archived` / `node_not_done`); definition unchanged over
 * ADOPT_NODE_FIELDS (`node_scope_changed`); for a RED-bearing node, its archived RED evidence binds the new DAG's specs and runner
 * and `redChanges` finds nothing (same spec bytes, same base), else `adopt_red_unverified` / `adopt_red_missing`, which are also
 * judgments (human-owned: `drive` stops; a RED re-run after the implementation would be `spec_not_failing`); fingerprints cover
 * exactly reads + writes and equal the work tree (`node_files_changed`). Then every dependent of a node not adopted is not adopted
 * (`dep_not_adopted`, closure: transitive invalidation). The RED check precedes the fingerprint check because the specs sit in
 * the RED node's own writes: an edited spec is a RED question, not a re-build.
 *
 * Not adopted (R5): review chain, freeze, repairs, security state, test-kinds records, unit evidence and usage rows. Runs with
 * units are refused (`adopt_units_unsupported`). Cross-plan adoption is refused. 13b (RED on a moved base) is not here.
 */
import { lstatSync, readFileSync, realpathSync, mkdirSync, renameSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import * as io from './engine-io.mjs';
import { closure, coded, judgment, note, isObj, sha } from './engine-dag.mjs';
import { runPolicy } from './engine-policy.mjs';
import { LIVE, unretired } from './engine-quiesce.mjs';
import { observeAuthority } from './engine-authority.mjs';
import { redInvalidJudgments, securityJudgments } from './engine-gates.mjs';

/**
 * The node definition fields that must be equal for a node to be adopted (AC2 "scope"; promptFile by path, R11). Omitted on
 * purpose: complexity and estimatedMemoryMb (admission and scheduling only, never what a builder produces) and unit (refused).
 */
export const ADOPT_NODE_FIELDS = Object.freeze(['id', 'deps', 'reads', 'writes', 'othersOwned', 'resources', 'redSpecs', 'evidence', 'phase', 'role', 'risk', 'modelTier', 'promptFile', 'acceptance', 'checks']);
/** The files an archive may list (run-engine.mjs archive). */
const ARCHIVE_FILES = ['state.json', 'engine.jsonl', 'usage.jsonl'];
/** Retire order: the state, the only handle a retry needs and the only thing that blocks `init`, is renamed last. */
const RETIRE_ORDER = ['engine.jsonl', 'usage.jsonl', 'state.json'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The record `archive --retire` writes into <archive>/retired/ before it renames anything: the one producer of an adoptable source. */
export const RETIRE_RECORD = 'retire.json';

/** Canonical JSON (object keys sorted at every depth), so key order is never a difference. */
const canon = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x)) ?? 'undefined';
/** Semantics flags that may differ between the archived and the adopting run (R3). */
const OWN_FLAGS = ['pinnedBase', 'repoIdentity'];
const semanticsKey = (sem) => canon(Object.fromEntries(Object.entries(sem).filter(([k]) => !OWN_FLAGS.includes(k))));
const withUnits = (S) => S.unit_checks !== undefined || Object.values(S.nodes ?? {}).some(n => n?.unit !== undefined);
const liveAttempts = (S) => [...new Set([...(S.attempts ?? []).filter(a => LIVE.includes(a?.status)), ...unretired(S)])].map(a => a?.attempt_id);

/** The archive root of a ticket: <git common dir>/ai-skills/ship-ticket/archive/<ticket>/. */
export const archiveRoot = (repoRoot, ticket) => join(io.commonGitDir(repoRoot), 'ai-skills', 'ship-ticket', 'archive', ticket);

/** A regular file's bytes; a symlink, a directory or a missing file is null (never followed). */
function regularBytes(file) {
  try { return lstatSync(file).isFile() ? readFileSync(file) : null; } catch { return null; }
}

/**
 * The archive at `from`, verified (AC3 and R6). `from` must resolve (realpath, symlinks followed) to a direct child of the
 * ticket's archive `root` (`adopt_source_outside`). Its manifest must have exactly { ticket, run_id, archived_at, files }, this
 * ticket, files a subset of the archive file names including state.json, each a regular file whose sha256 is the listed one; the
 * state must be engine state JSON of the manifest's run, which is not the adopting run (`adopt_archive_invalid`). Every digest
 * and parse uses the same bytes. Returns { dir, manifest, manifest_sha256, state }.
 */
export function readArchive(from, { root, ticket, runId }) {
  const outside = (m) => coded('adopt_source_outside', m);
  const bad = (m) => coded('adopt_archive_invalid', m);
  let top, dir;
  try { top = realpathSync(root); } catch { throw outside(`there is no archive for ${ticket} (${root})`); }
  try { dir = realpathSync(resolve(from)); } catch { throw outside(`${from} does not exist`); }
  const rel = relative(top, dir);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.includes(sep)) throw outside(`${from} is not a run archive directly under ${top}`);
  if (!lstatSync(dir).isDirectory()) throw outside(`${from} is not a directory`);
  const mbytes = regularBytes(join(dir, 'manifest.json'));
  if (mbytes === null) throw bad('manifest.json is missing or not a regular file');
  let m;
  try { m = JSON.parse(mbytes.toString('utf8')); } catch { throw bad('manifest.json is not JSON'); }
  if (!isObj(m) || Object.keys(m).sort().join() !== 'archived_at,files,run_id,ticket') throw bad('manifest keys must be exactly ticket, run_id, archived_at, files');
  if (m.ticket !== ticket) throw bad(`manifest ticket ${JSON.stringify(m.ticket)} is not ${ticket}`);
  if (typeof m.run_id !== 'string' || !SAFE_ID.test(m.run_id) || typeof m.archived_at !== 'string') throw bad('manifest run_id or archived_at is malformed');
  if (!isObj(m.files) || !Object.hasOwn(m.files, 'state.json') || Object.keys(m.files).some(f => !ARCHIVE_FILES.includes(f)))
    throw bad(`manifest files must list state.json and only ${ARCHIVE_FILES.join(', ')}`);
  const bytes = {};
  for (const name of Object.keys(m.files)) {
    const buf = regularBytes(join(dir, name));
    if (buf === null) throw bad(`${name} is missing or not a regular file`);
    if (sha(buf) !== m.files[name]) throw bad(`${name} does not match its manifest sha256`);
    bytes[name] = buf;
  }
  let state;
  try { state = JSON.parse(bytes['state.json'].toString('utf8')); } catch { throw bad('state.json is not JSON'); }
  if (!isObj(state) || state.schema !== 'ship-ticket-engine-state-v1' || state.ticket !== ticket || state.run_id !== m.run_id
    || !isObj(state.nodes) || !Array.isArray(state.attempts) || !isObj(state.config))
    throw bad(`state.json is not engine state of ${ticket} run ${m.run_id}`);
  if (state.run_id === runId) throw bad(`the archive is of the adopting run ${runId} itself`);
  return { dir, root: top, manifest: m, manifest_sha256: sha(mbytes), state };
}

/** Parsed JSON of a regular file, or null. */
const regularJson = (file) => { const b = regularBytes(file); try { return b === null ? null : JSON.parse(b.toString('utf8')); } catch { return null; } };

/**
 * Whether archive `src` (readArchive) is FINAL: written by `archive --retire true` (its retire record names this run, the archived
 * seq and state digest, and the retired state itself is there with those bytes) and the latest state of its run (no other archive
 * of the same run under the root holds a later seq). Returns { ok: true, authority_present } or { ok: false, reason }.
 */
export function archiveFinality(src) {
  const no = (reason) => ({ ok: false, reason });
  const rec = regularJson(join(src.dir, 'retired', RETIRE_RECORD)), mine = src.manifest.files['state.json'];
  const retired = regularBytes(join(src.dir, 'retired', 'state.json'));
  if (!isObj(rec) || rec.retired !== true || rec.run_id !== src.state.run_id || rec.final_seq !== src.state.seq || rec.state_sha256 !== mine
    || retired === null || sha(retired) !== mine)
    return no('is not a completed `archive --retire true` (the one producer of an adoptable source)');
  for (const d of readdirSync(src.root)) {
    if (join(src.root, d) === src.dir) continue;
    const m = regularJson(join(src.root, d, 'manifest.json')), st = m?.run_id === src.state.run_id ? regularJson(join(src.root, d, 'state.json')) : null;
    if (isObj(st) && st.run_id === src.state.run_id && Number(st.seq ?? 0) > Number(src.state.seq ?? 0)) return no(`is superseded: archive ${d} holds a later state of ${src.state.run_id}`);
  }
  return { ok: true, authority_present: rec.authority_present === true };
}

/** Every judgment a `status` of `S` would show from its own records (not binding drift): stored, failed nodes and repairs, invalid RED, security. */
export function computedJudgments(S) {
  return [...(S.judgments ?? []),
    ...Object.entries(S.nodes ?? {}).filter(([, n]) => n?.state === 'failed').map(([id, n]) => judgment('node_failed', id, n.reason ?? 'terminal failure')),
    ...(S.repairs ?? []).filter(r => r?.state === 'failed' && r.kind !== 'unit-review').map(r => judgment('repair_failed', r.id, r.reason ?? 'terminal failure')),
    ...redInvalidJudgments(S), ...securityJudgments(S)];
}

/**
 * The ONE view of an archived source every refusal derives from. A copy of the archived state is OBSERVED first against the
 * current plan (`observeAuthority`), so a line that appeared while its work could run is classified untrusted even when a crash
 * left that run's own observation unfinished. `final` is archiveFinality(src) (the caller's fs read). Returns
 * { state, final, observed, judgments, untrusted, latch, roster, live }.
 */
export function sourceState(src, { planText, isAlive, final }) {
  const S = structuredClone(src.state);
  const recorded = isObj(S.authority);
  observeAuthority(S, planText, isAlive);
  const live = liveAttempts(S);
  return { state: S, final, live, observed: recorded && final?.authority_present === true && !live.length && S.authority.through === S.attempts.length,
    judgments: computedJudgments(S), untrusted: new Set((S.authority.untrusted ?? []).map(u => u?.line)), latch: Boolean(S.security?.reapproval),
    roster: structuredClone(S.builders ?? []) };
}

/** Why the adopting run `S` is no longer adoptable (null when the window is open): adoption happens before any work (R8). */
export function windowRefusal(S) {
  if (S.attempts.length) return `the run has ${S.attempts.length} attempt(s)`;
  const started = Object.entries(S.nodes).filter(([, n]) => n.state !== 'pending').map(([id]) => id);
  if (started.length) return `node(s) ${started.join(', ')} are not pending`;
  if (Object.keys(S.gates?.red ?? {}).length || Object.keys(S.gates?.red_invalid ?? {}).length) return 'the run already has RED evidence';
  if (S.freeze || S.review_chain?.length || S.repairs?.length) return 'the run already has a review or repair';
  if (S.events.some(e => e.type === 'ADOPTED')) return 'the run already adopted';
  return null;
}

/**
 * A whole refusal of the archived source `ss` (sourceState) for the adopting run `newS` ({ code, reason }), or null. Throws
 * `policy_version_unsupported` (runPolicy) for a version this engine does not support. `engine` is ctx.policy (tests only).
 */
export function sourceRefusal(ss, newS, engine = null) {
  const oldS = ss.state;
  const oldP = runPolicy(oldS, engine), newP = runPolicy(newS, engine);
  if (!ss.final?.ok) return { code: 'adopt_source_not_final', reason: `the archive ${ss.final?.reason ?? 'is not final'}: adopt only from the last \`archive --retire true\` of the run` };
  if (ss.live.length) return { code: 'adopt_source_live', reason: `archived attempt(s) ${ss.live.join(', ')} are live or not proven quiescent: resume the old run, then archive it again` };
  if (!ss.observed) return { code: 'adopt_source_unobserved', reason: 'the archived run\'s RUN-STATE observation is not complete (no authority record before retire, or attempts beyond its observed point)' };
  if (oldS.plan_digest !== newS.plan_digest) return { code: 'adopt_plan_mismatch', reason: `archived plan digest ${oldS.plan_digest} is not this run's ${newS.plan_digest} (cross-plan adoption is refused)` };
  if (semanticsKey(oldP.semantics) !== semanticsKey(newP.semantics))
    return { code: 'adopt_policy_mismatch', reason: `archived policy_version ${oldP.version} and this run's ${newP.version} differ in semantics other than ${OWN_FLAGS.join(', ')}` };
  if (withUnits(oldS) || withUnits(newS)) return { code: 'adopt_units_unsupported', reason: 'adoption does not cover runs with units (their evidence bindings are not adopted)' };
  // the independence class: records the old run derived from its execution history that a fresh run would not re-derive
  if (ss.latch) return { code: 'adopt_reapproval_pending', reason: 'the archived run is latched on a security REAPPROVAL: re-plan and re-approve; its work is not adopted' };
  if (ss.judgments.length) return { code: 'adopt_source_judged', reason: `the archived run has outstanding judgment(s) ${ss.judgments.map(j => j?.code).join(', ')}: resolve them in the old run, then archive it again` };
  const trusted = (newS.authority?.trusted ?? []).filter(l => ss.untrusted.has(l));
  if (trusted.length) return { code: 'adopt_authority_untrusted', reason: `this run trusts RUN-STATE line(s) the archived run saw appear while its work could run: ${trusted.join(' ')}` };
  return null;
}

/** The archived RED evidence of RED-bearing node `n` when it still binds ({ ev }), else a rejection { code, ... }. */
function redCarry(id, n, oldS, newS, redChanges) {
  const ev = oldS.gates?.red?.[id];
  if (!isObj(ev)) return { code: 'adopt_red_missing', changed: [], moved: false, reason: `no archived RED evidence for ${id}` };
  // the gate's pin (engine-dag.mjs pinnedSpecs), compared canonically: the named specs, or files the node declares
  const named = n.redSpecs.filter(isObj);
  const pinned = Array.isArray(ev.specs) && ev.specs.length > 0 && (named.length ? canon(named) === canon(ev.specs) : ev.specs.every(s => n.redSpecs.includes(s?.file)));
  const files = [...new Set((ev.specs ?? []).map(s => s?.file))].sort();
  const oldRunner = oldS.config?.testCommands?.[ev.command], newRunner = newS.config?.testCommands?.[ev.command];
  // redChanges returns null for an empty digest set or a missing base_commit: such evidence never reaches it
  const binds = ev.node === id && pinned && typeof ev.base_commit === 'string' && typeof ev.baseline_candidate === 'string'
    && isObj(ev.spec_digests) && canon(Object.keys(ev.spec_digests).sort()) === canon(files) && isObj(oldRunner) && canon(oldRunner) === canon(newRunner)
    && (ev.format ?? null) === (newRunner.format ?? null);
  if (!binds) return { code: 'adopt_red_unverified', changed: [], moved: false, reason: `the archived RED evidence of ${id} does not bind this run's specs or runner` };
  const what = redChanges(ev);
  if (what && (what.changed.length || what.moved))
    return { code: 'adopt_red_unverified', changed: what.changed, moved: what.moved,
      reason: what.moved ? `the base moved since RED of ${id} (13a never re-verifies RED on a moved base)` : `spec file(s) changed since RED of ${id}: ${what.changed.join(', ')}` };
  return { ev };
}

/**
 * Per-node verdicts (one pass). `fingerprints(paths)` reads the work tree (engine-io fingerprints), `redChanges(ev)` is
 * engine-attempts.mjs redChanges bound to the adopting run (its base). Returns { adopted: ids, rejected: [{ node, code, ... }],
 * red: { id: evidence } (the archived objects, carried verbatim), judgments }.
 */
export function adoptable({ newS, oldS, fingerprints, redChanges }) {
  const verdict = {}, red = {}, judgments = [];
  for (const [id, n] of Object.entries(newS.nodes)) {
    const o = oldS.nodes[id];
    if (!isObj(o)) { verdict[id] = { code: 'node_not_archived' }; continue; }
    if (o.state !== 'done') { verdict[id] = { code: 'node_not_done' }; continue; }
    const fields = ADOPT_NODE_FIELDS.filter(f => canon(o[f]) !== canon(n[f]));
    if (fields.length) { verdict[id] = { code: 'node_scope_changed', fields }; continue; }
    if (n.redSpecs.length) {
      const r = redCarry(id, n, oldS, newS, redChanges);
      if (r.code) {
        verdict[id] = { code: r.code, changed: r.changed, moved: r.moved };
        judgments.push(judgment(r.code, id, `${r.reason}; not adopted, and RED is not re-run (the dependents' implementation is in the tree). `
          + 'No command clears this judgment in this run: start a fresh run (archive --retire, a new START, init) and adopt there after '
          + 'restoring the archived bytes, or do not adopt (WAIT_FOR_USER)'));
        continue;
      }
      red[id] = r.ev;
    }
    const paths = [...new Set([...n.reads, ...n.writes])].sort();
    if (!isObj(o.fps) || canon(Object.keys(o.fps).sort()) !== canon(paths)) { verdict[id] = { code: 'node_files_changed', changed: paths }; continue; }
    const now = fingerprints(paths);
    const changed = paths.filter(p => now[p] !== o.fps[p]);
    if (changed.length) { verdict[id] = { code: 'node_files_changed', changed }; continue; }
    verdict[id] = null;
  }
  const out = closure(newS, Object.keys(verdict).filter(id => verdict[id]));
  for (const id of out) if (!verdict[id]) verdict[id] = { code: 'dep_not_adopted' };
  const adopted = Object.keys(verdict).filter(id => !verdict[id]).sort();
  for (const id of Object.keys(red)) if (!adopted.includes(id)) delete red[id];
  const rejected = Object.keys(verdict).filter(id => verdict[id]).sort().map(id => ({ node: id, ...verdict[id] }));
  return { adopted, rejected, red, judgments };
}

/** Apply verdicts `v` from archive `src` to the adopting state `S` in memory (the caller's one commit persists it, R8). */
export function applyAdoption(S, src, v, roster = src.state.builders ?? []) {
  const from = { run_id: src.state.run_id, archive: src.dir, manifest_sha256: src.manifest_sha256 };
  for (const id of v.adopted) {
    const o = src.state.nodes[id];
    Object.assign(S.nodes[id], { state: 'done', fps: structuredClone(o.fps), attempts: o.attempts ?? 0, retries: o.retries ?? 0, adopted: { ...from } });
  }
  for (const [id, ev] of Object.entries(v.red)) S.gates.red[id] = structuredClone(ev);
  // Independence (gate.mjs reviewer_is_builder): every archived builder, adopted node or not, repairs included, stays a builder of
  // this run, so a chained adoption carries the roster on; the work tree may hold any of their bytes.
  const known = new Set((S.builders ??= []).map(b => `${b.identity}\u0000${b.node}`));
  for (const b of roster) if (isObj(b) && !known.has(`${b.identity}\u0000${b.node}`)) { known.add(`${b.identity}\u0000${b.node}`); S.builders.push(structuredClone(b)); }
  S.judgments.push(...v.judgments);
  // R10: the archived run's usage stays in its archive; the note is the join key for a cumulative cost
  note(S, 'ADOPTED', { from_run: from.run_id, archive: from.archive, manifest_sha256: from.manifest_sha256, adopted: v.adopted,
    rejected: v.rejected.map(r => ({ node: r.node, code: r.code })), red_carried: Object.keys(v.red).sort(), archived_usage_records: (src.state.usage ?? []).length });
}

/**
 * Finish the RUN-STATE observation of the raw live state `S` before it is retired (in place; the caller persists it): a crash
 * after a quiescent commit and before the final observe() of a command leaves lines unclassified. Returns whether `S` had an
 * authority record before (a state without one cannot have classified anything and is never an adoptable source).
 */
export function retireObserve(S, planText, isAlive) {
  const recorded = isObj(S.authority);
  observeAuthority(S, planText, isAlive);
  return recorded;
}

/** Why `S` (the raw live state) cannot be retired now (null when quiescent): a live, unknown or unretired attempt (OD-1). */
export function retireRefusal(S) {
  const live = liveAttempts(S);
  return live.length ? `attempt(s) ${live.join(', ')} are live or not proven quiescent: resume or wait, then retire` : null;
}

/**
 * archive --retire, after the copy (OD-1): re-hash the archived copy, refuse unless the live bytes still equal it (and no live
 * file appeared that was not archived), then RENAME (never delete) the live files into <dir>/retired/, the state last. A crash
 * in between leaves the state live (retry: a new archive of what is left) or retired, never neither. Returns the retired names.
 */
export async function retireLive({ dir, files, sources, hooks, record }) {
  await io.boundary(hooks, 'retire-check', { dir });
  for (const name of ARCHIVE_FILES) {
    const live = regularBytes(sources[name]), copy = Object.hasOwn(files, name) ? regularBytes(join(dir, name)) : null;
    if (!Object.hasOwn(files, name) ? live !== null : live === null || copy === null || sha(live) !== files[name] || sha(copy) !== files[name])
      throw coded('retire_mismatch', `${name}: the live bytes differ from the archived copy in ${dir}; nothing was retired (archive again)`);
  }
  mkdirSync(join(dir, 'retired'));
  // written before any rename: a retire record without its retired state is not final (archiveFinality), and the state stays live
  writeFileSync(join(dir, 'retired', RETIRE_RECORD), JSON.stringify({ retired: true, ...record, state_sha256: files['state.json'] }, null, 2) + '\n');
  const names = RETIRE_ORDER.filter(n => Object.hasOwn(files, n));
  for (const name of names) {
    await io.boundary(hooks, 'retire-rename', { name });
    renameSync(sources[name], join(dir, 'retired', name));
  }
  return names;
}
