#!/usr/bin/env node
/**
 * Wave model for ship-ticket (W-1; PLAN-WAVE-FR4-approval-package Part A + addenda 2026-11-23d/e). READ-ONLY.
 *
 * A wave is N independent single-ticket engine runs. This module is the PURE model of one wave: the manifest shape and
 * validator, the approval binding check, the per-ticket state derivation from the engine's `status`, and ONE generic
 * readiness/admission core over a node DAG `{ id, deps[], state, owner_required, class, priority, owns[] }` (the wave's ticket
 * DAG is its first instance; a later roadmap graph reuses it). It writes nothing, takes no lock, launches nothing (W-2/W-3/W-4
 * are later units), and imports no engine/gate/carrier module: the CLI reads state only through `run-engine.mjs status`.
 *
 * MANIFEST `.specs/plans/<WAVE-ID>.wave.json`, schema `ship-ticket-wave-v1`, closed keys:
 *   { schema, wave_id, endpoint:'SHIP_READY', release_mode?:'manual', heavy_slots:1|2, merge_strategy?, width_reason?,
 *     tickets:[{ key, plan, run_id, worktree, branch, deps[], dep_mode:'ship_ready'|'merged', resources[],
 *                priority?:uint (higher first, default 0), owns?:[repo-relative path], owner_required?:boolean }] }
 * `release_mode` is RESERVED (addendum 2026-11-23e): absent means `manual`; only `manual` is accepted in v1.
 * PR-5 adds two optional keys: `merge_strategy` ('owner' | 'automatic', absent = owner) and `width_reason` (one line).
 * DIGEST = sha256 of the manifest FILE BYTES (LF only; CRLF refused). It holds no plan digest (that would be circular).
 * BINDING: each ticket plan's narrative (outside the RUN-STATE block) carries exactly one line `wave: <WAVE-ID> sha256:<digest>`;
 * the ticket's START already binds the narrative (brief.mjs planDigest/startCheck), so no new authority event or START field.
 *
 * READINESS (WA-13/14/15/17), pure and stateless: `evaluateReadiness` recomputes everything from its input on every call
 * (nothing cached). A node is `ready` only when it is `pending`, every dep is satisfied (dep_mode 'ship_ready': ship_ready or
 * merged; 'merged': merged only) and it is not owner_required without `owner_approved`. `prepared` (stacked) is a distinct
 * state and never satisfies a dep. `planAdmissions` orders ready nodes by priority with a STARVATION BOUND: a node passed over
 * for STARVATION_BOUND admission rounds is promoted ahead of every priority.
 *
 * CLI (exit 0 ok, 2 refused/not ok, 1 usage): wave.mjs verify|status --wave <manifest> [--skills-dir <dir>]
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './lib/shape.mjs';
import { isEntrypoint } from './harness.mjs';
import { BEGIN, END, parseRunState } from './run-state.mjs';
import { planDigest, startCheck } from './brief.mjs';
import { checkShipReady } from './ship-ready-check.mjs';
import { enginePaths } from './lib/run-placement.mjs';

export const WAVE_SCHEMA = 'ship-ticket-wave-v1';
export const ENDPOINT = 'SHIP_READY';
export const RELEASE_MODES = Object.freeze(['manual']); // the ONLY accepted value in v1 (addendum 2026-11-23e)
export const DEFAULT_RELEASE_MODE = 'manual';
/**
 * PR-5 (S7a, §7.2/C3): the run-start merge strategy, persisted with the manifest digest and enforced by the supervisor for the
 * whole wave. Optional (absent = 'owner'), so every manifest approved before it keeps its bytes and digest. `automatic` is
 * accepted and persisted, but no merge executor exists yet (PR-6b): the supervisor never merges under either value.
 */
export const MERGE_STRATEGIES = Object.freeze(['owner', 'automatic']);
export const DEFAULT_MERGE_STRATEGY = 'owner';
/** `width_reason` (optional): why the wave runs at its heavy_slots width; one line of at most 500 characters. */
export const WIDTH_REASON_MAX = 500;
export const DEP_MODES = Object.freeze(['ship_ready', 'merged']);
export const HEAVY_SLOTS_MAX = 2;
/** PINNED: an eligible node passed over for this many admission rounds is promoted ahead of every priority (WA-15). */
export const STARVATION_BOUND = 4;
export const RESOURCE_PREFIXES = Object.freeze(['port:', 'db:', 'cache:', 'docker:', 'fixture:', 'generator:', 'lock:']);
export const NODE_STATES = Object.freeze(['pending', 'running', 'waiting_owner', 'failed', 'ship_ready', 'merged', 'prepared', 'corrupt']);
export const DECISION_STATES = Object.freeze(['blocked_dep', 'ready', 'running', 'waiting_owner', 'failed', 'ship_ready', 'merged', 'prepared', 'corrupt']);
export const STATUS_SCHEMA = 'ship-ticket-engine-status-v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_WAVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const WAVE_LINE = /^wave: (\S+) (sha256:[0-9a-f]{64})$/;

const TICKET_SCHEMA = { object: {
  key: 'string', plan: 'string', run_id: 'string', worktree: 'string', branch: 'string', deps: { arrayOf: 'string' },
  dep_mode: { enum: DEP_MODES }, resources: { arrayOf: 'string' },
  priority: '?uint', owns: { arrayOf: 'string', optional: true }, owner_required: '?boolean' } };
export const MANIFEST_SCHEMA = { object: {
  schema: { enum: [WAVE_SCHEMA] }, wave_id: 'string', endpoint: { enum: [ENDPOINT] }, release_mode: '?string',
  heavy_slots: 'posint', merge_strategy: '?string', width_reason: '?string', tickets: { arrayOf: TICKET_SCHEMA } } };

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hasDots = (p) => p.split('/').some((s) => s === '' || s === '.' || s === '..');
const unsafeText = (p) => typeof p !== 'string' || p.length === 0 || p.length > 512 || p.includes('\0') || p.includes('\\') || /[\r\n]/.test(p);
/** A repo-relative path: no absolute, no `.`/`..`/empty segment, no leading dash, no NUL, backslash or line break. */
export const safeRelPath = (p) => !unsafeText(p) && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.startsWith('-') && !hasDots(p);
/** Platform-independent: a POSIX root or a drive root (`C:\\` / `C:/`), then non-empty segments with no `.`/`..`, no trailing separator. Never path.normalize (it rewrites `/` on win32). */
const safeWorktree = (p) => {
  if (typeof p !== 'string' || p.length > 512 || p.includes('\0') || /[\r\n]/.test(p)) return false;
  const m = /^(?:\/|[A-Za-z]:[\\/])(.*)$/.exec(p);
  if (!m || m[1] === '') return false;
  return m[1].split(/[\\/]/).every((s) => s !== '' && s !== '.' && s !== '..');
};
const safeBranch = (b) => typeof b === 'string' && BRANCH.test(b) && !b.includes('..') && !b.includes('//') && !b.endsWith('/') && !b.endsWith('.') && !b.endsWith('.lock');
const safeReason = (r) => typeof r === 'string' && r.length > 0 && r.length <= WIDTH_REASON_MAX && !/[\r\n\0]/.test(r);
/** The manifest's merge strategy (absent = owner). */
export const mergeStrategyOf = (m) => m?.merge_strategy ?? DEFAULT_MERGE_STRATEGY;
const safeResource = (r) => typeof r === 'string' && RESOURCE_PREFIXES.some((p) => r.startsWith(p) && /^[A-Za-z0-9._/-]{1,100}$/.test(r.slice(p.length)));

// ---- manifest ---------------------------------------------------------------------------------------------------
/** Digest of the manifest file text: `sha256:<hex>` over the bytes. Throws `wave_manifest_crlf` on a CR (no normalisation: the bytes are what was approved). */
export function manifestDigest(text) {
  if (typeof text !== 'string') throw Object.assign(new Error('manifest text must be a string'), { code: 'wave_manifest_unreadable' });
  if (text.includes('\r')) throw Object.assign(new Error('wave manifest must use LF line ends only'), { code: 'wave_manifest_crlf' });
  return `sha256:${sha256(text)}`;
}

/** Parse manifest text: { ok, manifest, digest, problems }. Never throws. */
export function parseManifest(text) {
  let digest;
  try { digest = manifestDigest(text); } catch (e) { return { ok: false, manifest: null, digest: null, problems: [{ code: e.code ?? 'wave_manifest_unreadable', detail: e.message }] }; }
  let manifest;
  try { manifest = JSON.parse(text); } catch { return { ok: false, manifest: null, digest, problems: [{ code: 'wave_manifest_unreadable', detail: 'not valid JSON' }] }; }
  const v = validateManifest(manifest);
  return { ok: v.ok, manifest, digest, problems: v.problems };
}

/** Closed-schema + semantic validation. Returns { ok, problems: [{ code, ticket?, detail }] }; codes in MANIFEST_CODES. */
export function validateManifest(m) {
  const problems = [];
  const add = (code, detail, ticket) => problems.push({ code, ...(ticket ? { ticket } : {}), detail });
  const shaped = validate(m, MANIFEST_SCHEMA);
  if (!shaped.ok) {
    for (const p of shaped.problems) add('wave_schema_invalid', `${p.code} at ${p.path === '' ? '(root)' : p.path}`);
    return { ok: false, problems };
  }
  if (!SAFE_WAVE_ID.test(m.wave_id)) add('wave_id_invalid', 'wave_id must be a safe id');
  if (m.release_mode !== undefined && !RELEASE_MODES.includes(m.release_mode)) add('release_mode_unsupported', `release_mode ${JSON.stringify(m.release_mode)} is reserved; only ${RELEASE_MODES.join(', ')} is accepted in v1`);
  if (m.merge_strategy !== undefined && !MERGE_STRATEGIES.includes(m.merge_strategy)) add('wave_merge_strategy_invalid', `merge_strategy must be one of ${MERGE_STRATEGIES.join(', ')}`);
  if (m.width_reason !== undefined && !safeReason(m.width_reason)) add('wave_width_reason_invalid', `width_reason must be one line of 1..${WIDTH_REASON_MAX} characters`);
  if (m.heavy_slots > HEAVY_SLOTS_MAX) add('wave_heavy_slots_invalid', `heavy_slots must be 1..${HEAVY_SLOTS_MAX}`);
  if (m.tickets.length === 0) add('wave_empty', 'a wave needs at least one ticket');
  const keys = new Set(), dupKeys = new Set();
  for (const t of m.tickets) { if (keys.has(t.key)) dupKeys.add(t.key); keys.add(t.key); }
  for (const k of dupKeys) add('wave_ticket_duplicate', `ticket ${k} is listed twice`, k);
  const seen = { worktree: new Map(), branch: new Map() };
  for (const t of m.tickets) {
    const tk = t.key;
    if (!SAFE_ID.test(tk)) add('wave_key_invalid', 'ticket key must be a safe id', String(tk));
    if (!SAFE_ID.test(t.run_id)) add('wave_run_id_invalid', 'run_id must be a safe id', tk);
    if (!safeRelPath(t.plan) || !t.plan.endsWith('.md')) add('wave_path_unsafe', `plan ${JSON.stringify(t.plan)} must be a safe repo-relative .md path`, tk);
    if (!safeWorktree(t.worktree)) add('wave_path_unsafe', `worktree ${JSON.stringify(t.worktree)} must be an absolute POSIX or drive path with no empty, . or .. segment`, tk);
    if (!safeBranch(t.branch)) add('wave_branch_invalid', `branch ${JSON.stringify(t.branch)} is not a safe branch name`, tk);
    for (const o of t.owns ?? []) if (!safeRelPath(o)) add('wave_path_unsafe', `owns ${JSON.stringify(o)} must be a safe repo-relative path`, tk);
    for (const r of t.resources) if (!safeResource(r)) add('wave_resource_invalid', `resource ${JSON.stringify(r)} must be <prefix>:<name> with a prefix of ${RESOURCE_PREFIXES.join(' ')}`, tk);
    if (new Set(t.deps).size !== t.deps.length) add('wave_dep_duplicate', 'a dependency is listed twice', tk);
    for (const d of t.deps) {
      if (d === tk) add('wave_cycle', `${tk} depends on itself`, tk);
      else if (!keys.has(d)) add('wave_dep_unknown', `dependency ${JSON.stringify(d)} is not a ticket of this wave`, tk);
    }
    // sharing a branch or worktree is the sibling-stack shape: not supported in an autonomous wave (OD-P3)
    for (const f of ['worktree', 'branch']) {
      const prior = seen[f].get(t[f]);
      if (prior !== undefined) add('wave_stack_unsupported', `${tk} and ${prior} share ${f} ${JSON.stringify(t[f])}`, tk); else seen[f].set(t[f], tk);
    }
  }
  const cycle = findCycle(m.tickets.map((t) => ({ id: t.key, deps: t.deps.filter((d) => keys.has(d) && d !== t.key) })));
  if (cycle) add('wave_cycle', `dependency cycle: ${cycle.join(' -> ')}`);
  return { ok: problems.length === 0, problems };
}
export const MANIFEST_CODES = Object.freeze(['wave_manifest_crlf', 'wave_manifest_unreadable', 'wave_schema_invalid', 'wave_id_invalid', 'release_mode_unsupported', 'wave_heavy_slots_invalid',
  'wave_empty', 'wave_ticket_duplicate', 'wave_key_invalid', 'wave_run_id_invalid', 'wave_path_unsafe', 'wave_branch_invalid', 'wave_resource_invalid', 'wave_dep_duplicate',
  'wave_cycle', 'wave_dep_unknown', 'wave_stack_unsupported', 'wave_merge_strategy_invalid', 'wave_width_reason_invalid']);

/** The first dependency cycle of `{id, deps}` nodes as an id path ending where it started, or null. Iterative; unknown deps are ignored. */
export function findCycle(nodes) {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const colour = new Map(); // 1 = on stack, 2 = done
  for (const root of nodes) {
    if (colour.get(root.id)) continue;
    const stack = [{ id: root.id, i: 0 }];
    colour.set(root.id, 1);
    while (stack.length) {
      const top = stack.at(-1), deps = by.get(top.id).deps;
      if (top.i >= deps.length) { colour.set(top.id, 2); stack.pop(); continue; }
      const d = deps[top.i++];
      if (!by.has(d)) continue;
      if (colour.get(d) === 1) { const at = stack.findIndex((s) => s.id === d); return [...stack.slice(at).map((s) => s.id), d]; }
      if (!colour.get(d)) { colour.set(d, 1); stack.push({ id: d, i: 0 }); }
    }
  }
  return null;
}

// ---- binding (A2) -------------------------------------------------------------------------------------------------
/** The plan narrative: the text with everything between the RUN-STATE markers removed (markers kept), or the text itself without a block. */
export function narrativeOf(planText) {
  const b = planText.indexOf(BEGIN), e = planText.indexOf(END);
  return b >= 0 && e > b ? planText.slice(0, b + BEGIN.length) + planText.slice(e) : planText;
}

/** The `wave:` lines of a plan narrative: [{ wave_id, digest }] for every well-formed one, plus the count of malformed `wave:` lines. */
export function waveLines(planText) {
  const out = []; let malformed = 0;
  for (const line of narrativeOf(planText).split('\n')) {
    if (!/^wave:/.test(line)) continue;
    const m = WAVE_LINE.exec(line);
    if (m) out.push({ wave_id: m[1], digest: m[2] }); else malformed += 1;
  }
  return { lines: out, malformed };
}

/**
 * Binding of ONE ticket plan to the approved manifest: exactly one `wave: <ID> sha256:<digest>` line equal to the manifest, and the
 * ticket's own START verified by the existing brief.mjs check. { ok, reason } with reason one of wave_line_missing, wave_line_duplicate,
 * wave_line_malformed, wave_id_mismatch, wave_digest_mismatch, start_check_failed:<codes>, plan_invalid.
 */
export function checkPlanBinding(planText, { waveId, digest, runId, now }) {
  const { lines, malformed } = waveLines(planText);
  if (malformed) return { ok: false, reason: 'wave_line_malformed' };
  if (lines.length === 0) return { ok: false, reason: 'wave_line_missing' };
  if (lines.length > 1) return { ok: false, reason: 'wave_line_duplicate' };
  if (lines[0].wave_id !== waveId) return { ok: false, reason: 'wave_id_mismatch' };
  if (lines[0].digest !== digest) return { ok: false, reason: 'wave_digest_mismatch' };
  let sc;
  try { sc = startCheck(planText, { runId, ...(now === undefined ? {} : { now }) }); } catch (e) { return { ok: false, reason: String(e.message).startsWith('plan_invalid') ? 'plan_invalid' : 'start_check_failed:' + e.message }; }
  if (!sc.ok) return { ok: false, reason: 'start_check_failed:' + sc.errors.map((x) => x.code).join(',') };
  return { ok: true, reason: null, plan_digest: sc.digest };
}

/**
 * Whole-wave binding: `plans` maps ticket key -> plan text (null/undefined = unreadable), `unlisted` is the text of other plans found
 * next to the wave (a plan claiming this wave that the manifest does not list is refused). Returns { ok, code: null|'wave_unapproved', tickets: {key: {ok, reason}}, unlisted: [name...] }.
 */
export function checkBinding(manifest, digest, plans, { unlisted = {}, now } = {}) {
  const tickets = {};
  for (const t of manifest.tickets) {
    const text = plans[t.key];
    tickets[t.key] = typeof text === 'string' ? checkPlanBinding(text, { waveId: manifest.wave_id, digest, runId: t.run_id, now }) : { ok: false, reason: 'plan_unreadable' };
  }
  const claimed = Object.entries(unlisted).filter(([, text]) => typeof text === 'string' && waveLines(text).lines.some((l) => l.wave_id === manifest.wave_id)).map(([name]) => name);
  const ok = Object.values(tickets).every((x) => x.ok) && claimed.length === 0;
  return { ok, code: ok ? null : 'wave_unapproved', tickets, unlisted: claimed };
}

// ---- per-ticket state from the engine status (read-only) ----------------------------------------------------------------
const FAILED_CODES = new Set(['node_failed', 'repair_failed']);
const RUNNING_NODE = new Set(['running', 'launching', 'launched']);

/**
 * Per-ticket state from ONE engine `status` view, no lock, no state file read. `ctx`: { status: parsed status | null, statusError: null|'no_state'|<code>,
 * shipReady: null|'verified'|'unverified' (a RUN-STATE SHIP_READY event; verified = matched by an engine GATE ship-ready line), runId, workspace: null|[problem codes] }.
 * Returns { state: NODE_STATES, reason }. Order is fail-closed: a defect is `corrupt` before anything else.
 * (S-14a `next_action` is honoured only for owner === 'human' until that schema is pinned.)
 */
export function deriveTicketState({ status = null, statusError = null, shipReady = null, runId = null, workspace = null } = {}) {
  if (statusError === 'no_state') return workspace?.length ? { state: 'corrupt', reason: workspace[0] } : { state: 'pending', reason: 'not_started' };
  if (statusError) return { state: 'corrupt', reason: `status_${statusError}` };
  if (status === null || typeof status !== 'object' || Array.isArray(status)) return { state: 'corrupt', reason: 'status_unreadable' };
  if (status.schema !== STATUS_SCHEMA) return { state: 'corrupt', reason: 'status_schema_unknown' };
  if (runId !== null && status.run_id !== runId) return { state: 'corrupt', reason: 'status_run_id_mismatch' };
  if (!Array.isArray(status.judgments) || typeof status.nodes !== 'object' || status.nodes === null || !Array.isArray(status.repairs)) return { state: 'corrupt', reason: 'status_shape_invalid' };
  const codes = status.judgments.map((j) => j?.code).filter((c) => typeof c === 'string');
  const failed = codes.find((c) => FAILED_CODES.has(c));
  if (failed) return { state: 'failed', reason: failed };
  if (codes.length) return { state: 'waiting_owner', reason: codes[0] };
  if (status.next_action?.owner === 'human') return { state: 'waiting_owner', reason: String(status.next_action.code ?? 'owner_action') };
  if (Array.isArray(status.authority_untrusted) && status.authority_untrusted.length) return { state: 'waiting_owner', reason: 'authority_untrusted' };
  if (shipReady === 'unverified') return { state: 'corrupt', reason: 'ship_ready_unverified' };
  if (shipReady === 'verified') return { state: 'ship_ready', reason: 'ship_ready' };
  if (Object.values(status.nodes).some((n) => RUNNING_NODE.has(n?.state)) || status.repairs.some((r) => r?.state === 'running')) return { state: 'running', reason: 'work_live' };
  return { state: 'pending', reason: 'resumable' };
}

// ---- generic readiness core (WA-13/14/15/17) ---------------------------------------------------------------------------
const bad = (message) => Object.assign(new TypeError(message), { code: 'readiness_input_invalid' });
function normaliseNodes(nodes) {
  if (!Array.isArray(nodes)) throw bad('nodes must be an array');
  const ids = new Set();
  return nodes.map((n, order) => {
    if (n === null || typeof n !== 'object' || typeof n.id !== 'string' || !n.id) throw bad(`node ${order} has no id`);
    if (ids.has(n.id)) throw bad(`duplicate node id ${n.id}`);
    ids.add(n.id);
    if (!NODE_STATES.includes(n.state)) throw bad(`node ${n.id} has unknown state ${JSON.stringify(n.state)}`);
    if (!Array.isArray(n.deps) || n.deps.some((d) => typeof d !== 'string')) throw bad(`node ${n.id} deps must be an array of ids`);
    const priority = n.priority ?? 0;
    if (!Number.isSafeInteger(priority)) throw bad(`node ${n.id} priority must be an integer`);
    return { id: n.id, deps: n.deps, state: n.state, dep_mode: n.dep_mode === 'merged' ? 'merged' : 'ship_ready', owner_required: n.owner_required === true, owner_approved: n.owner_approved === true,
      class: n.class === 'light' ? 'light' : 'heavy', priority, owns: Array.isArray(n.owns) ? n.owns : [], order };
  });
}

/**
 * Pure readiness over a node DAG. Returns { decisions: { id: { state, reason, blockers[] } }, ready: [id...] } with `ready` unordered by priority
 * (see `planAdmissions`). Reads ONLY its argument; every call recomputes (WA-14). States: blocked_dep | ready | running | waiting_owner | failed |
 * ship_ready | merged | prepared | corrupt. A node is `ready` only when pending, every dep satisfied for ITS dep_mode, and not owner-gated (WA-17).
 */
export function evaluateReadiness(rawNodes) {
  const nodes = normaliseNodes(rawNodes), by = new Map(nodes.map((n) => [n.id, n]));
  const decisions = {}, ready = [];
  for (const n of nodes) {
    if (n.state !== 'pending') { decisions[n.id] = { state: n.state, reason: n.state, blockers: [] }; continue; }
    const blockers = [];
    for (const d of n.deps) {
      const dep = by.get(d);
      const ok = dep && (n.dep_mode === 'merged' ? dep.state === 'merged' : dep.state === 'ship_ready' || dep.state === 'merged');
      if (!ok) blockers.push({ id: d, state: dep ? dep.state : 'unknown' });
    }
    if (blockers.length) decisions[n.id] = { state: 'blocked_dep', reason: blockers.some((b) => b.state === 'unknown') ? 'dep_unknown' : 'dep_not_satisfied', blockers };
    else if (n.owner_required && !n.owner_approved) decisions[n.id] = { state: 'waiting_owner', reason: 'owner_required', blockers: [] };
    else { decisions[n.id] = { state: 'ready', reason: 'eligible', blockers: [] }; ready.push(n.id); }
  }
  return { decisions, ready };
}

/** Admission order: aged (passed over >= STARVATION_BOUND rounds) first by age, then priority (higher first), then input order. */
export function admissionOrder(rawNodes, readyIds, skips = {}) {
  const nodes = normaliseNodes(rawNodes), by = new Map(nodes.map((n) => [n.id, n]));
  const skipOf = (id) => (Number.isSafeInteger(skips[id]) && skips[id] > 0 ? skips[id] : 0);
  return [...readyIds].sort((a, b) => {
    const na = by.get(a), nb = by.get(b), aa = skipOf(a) >= STARVATION_BOUND, ab = skipOf(b) >= STARVATION_BOUND;
    if (aa !== ab) return aa ? -1 : 1;
    if (aa && skipOf(a) !== skipOf(b)) return skipOf(b) - skipOf(a);
    return nb.priority - na.priority || na.order - nb.order;
  });
}

/**
 * One admission round: { admit: [id...] (in order), held: [{ id, reason }], skips } where reason is held_pressure (`hold` given: nothing is admitted),
 * held_heavy (no free heavy slot) or held_reservation (its `owns` overlaps a running or already admitted node). `capacity`: { heavy: total heavy slots, hold?: reason|null }.
 * `skips` in -> `skips` out: a ready node passed over in a round that admitted someone else gains one; an admitted or no-longer-ready node is dropped. Light nodes need no slot.
 */
export function planAdmissions(rawNodes, { capacity, skips = {} } = {}) {
  const nodes = normaliseNodes(rawNodes), by = new Map(nodes.map((n) => [n.id, n]));
  const { ready } = evaluateReadiness(rawNodes);
  const slots = Number.isSafeInteger(capacity?.heavy) ? capacity.heavy : 0;
  const held = [], admit = [];
  const order = admissionOrder(rawNodes, ready, skips);
  if (capacity?.hold) return { admit, held: order.map((id) => ({ id, reason: 'held_pressure', hold: capacity.hold })), skips: { ...pick(skips, new Set(order)) } };
  let heavyBusy = nodes.filter((n) => n.state === 'running' && n.class === 'heavy').length;
  const owned = new Set(nodes.filter((n) => n.state === 'running').flatMap((n) => n.owns));
  for (const id of order) {
    const n = by.get(id);
    if (n.owns.some((o) => owned.has(o))) { held.push({ id, reason: 'held_reservation' }); continue; }
    if (n.class === 'heavy' && heavyBusy >= slots) { held.push({ id, reason: 'held_heavy' }); continue; }
    if (n.class === 'heavy') heavyBusy += 1;
    for (const o of n.owns) owned.add(o);
    admit.push(id);
  }
  const next = {};
  for (const h of held) next[h.id] = (skips[h.id] > 0 ? skips[h.id] : 0) + (admit.length ? 1 : 0);
  return { admit, held, skips: next };
}
const pick = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep.has(k)));

/** Wave verdict (WA-11 input): COMPLETE only when every ticket is ship_ready/merged; prepared, failed and abandoned never count. */
export function waveVerdict(decisions) {
  const states = Object.values(decisions).map((d) => d.state);
  if (states.length > 0 && states.every((s) => s === 'ship_ready' || s === 'merged')) return 'COMPLETE';
  return 'INCOMPLETE';
}

// ---- IO (read-only) ----------------------------------------------------------------------------------------------------
const git = (cwd, args) => spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', timeout: 20000 });

/** Worktree precondition for a ticket with no engine state yet: exists, on `branch`, clean. Returns problem codes ([] = ok). */
export function worktreeProblems(t) {
  if (!existsSync(t.worktree) || !statSync(t.worktree).isDirectory()) return ['worktree_missing'];
  const head = git(t.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.status !== 0) return ['worktree_not_a_repo'];
  if (head.stdout.trim() !== t.branch) return ['worktree_wrong_branch'];
  const st = git(t.worktree, ['status', '--porcelain']);
  if (st.status !== 0) return ['worktree_status_failed'];
  return st.stdout.trim() === '' ? [] : ['worktree_dirty'];
}

/**
 * S1: the ticket's engine file through the one placement resolver (lib/run-placement.mjs); null when unresolvable. State in
 * both placements is NOT "not started" (m1): it returns { ambiguous: true }, which readTicket reports as corrupt.
 */
function enginePath(worktree, key, ext) {
  try { const P = enginePaths(worktree, key, { prefer: 'durable' }); return ext === 'state.json' ? P.state : P.log; }
  catch (e) { return e?.code === 'state_placement_ambiguous' ? { ambiguous: true } : null; }
}

/** Read one ticket's state through the engine CLI `status` (no lock) and the plan's RUN-STATE; never writes. */
export function readTicket(t, { engineCli = join(dirname(fileURLToPath(import.meta.url)), 'run-engine.mjs') } = {}) {
  const plan = join(t.worktree, t.plan);
  const statePath = existsSync(t.worktree) ? enginePath(t.worktree, t.key, 'state.json') : null;
  if (statePath?.ambiguous) return { ...deriveTicketState({ statusError: 'state_placement_ambiguous' }), plan_text: readText(plan) };
  if (!statePath || !existsSync(statePath)) return { ...deriveTicketState({ statusError: 'no_state', workspace: worktreeProblems(t) }), plan_text: readText(plan) };
  const r = spawnSync(process.execPath, [engineCli, 'status', '--repo', t.worktree, '--ticket', t.key, '--run-id', t.run_id], { encoding: 'utf8', timeout: 60000 });
  let status = null, statusError = null;
  if (r.status !== 0) statusError = 'engine_status_failed';
  else { try { status = JSON.parse(r.stdout); } catch { statusError = 'unreadable'; } }
  const planText = readText(plan);
  let shipReady = null;
  if (planText !== null && status && !statusError) {
    const R = parseRunState(planText);
    if (R && R.events.some((e) => e.event === 'SHIP_READY' && e.run_id === t.run_id)) {
      const logPath = enginePath(t.worktree, t.key, 'engine.jsonl');
      const logText = logPath && existsSync(logPath) ? readText(logPath) : null;
      shipReady = logText !== null && checkShipReady(planText, logText, { runId: t.run_id }).ok ? 'verified' : 'unverified';
    }
  }
  return { ...deriveTicketState({ status, statusError, shipReady, runId: t.run_id }), plan_text: planText };
}
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

/** Full read-only verification of a manifest file: parse + validate + digest + binding + unlisted-plan scan. */
export function verifyWave(manifestPath) {
  const text = readText(manifestPath);
  if (text === null) return { ok: false, code: 'wave_manifest_unreadable', problems: [{ code: 'wave_manifest_unreadable', detail: manifestPath }] };
  const parsed = parseManifest(text);
  if (!parsed.ok) return { ok: false, code: parsed.problems[0].code, problems: parsed.problems, digest: parsed.digest };
  const { manifest, digest } = parsed;
  if (basename(manifestPath) !== `${manifest.wave_id}.wave.json`) return { ok: false, code: 'wave_id_invalid', problems: [{ code: 'wave_id_invalid', detail: `file name must be ${manifest.wave_id}.wave.json` }], digest };
  const plans = {}, listed = new Set();
  for (const t of manifest.tickets) { plans[t.key] = readText(join(t.worktree, t.plan)); listed.add(resolve(t.worktree, t.plan)); }
  const unlisted = {};
  for (const dir of new Set([dirname(resolve(manifestPath)), ...manifest.tickets.map((t) => dirname(resolve(t.worktree, t.plan)))])) {
    let names = []; try { names = readdirSync(dir); } catch { /* an absent plans dir has no plans to claim the wave */ }
    for (const n of names) if (n.endsWith('.md') && !listed.has(join(dir, n))) unlisted[join(dir, n)] = readText(join(dir, n));
  }
  const b = checkBinding(manifest, digest, plans, { unlisted });
  return { ok: b.ok, code: b.code, digest, wave_id: manifest.wave_id, release_mode: manifest.release_mode ?? DEFAULT_RELEASE_MODE, tickets: b.tickets, unlisted: b.unlisted, problems: [] };
}

/** `wave status`: verify, then per-ticket state + readiness. Launches nothing. */
export function waveStatus(manifestPath, opts = {}) {
  const v = verifyWave(manifestPath);
  if (!v.ok) return { ...v, states: {}, decisions: {}, ready: [], verdict: 'INCOMPLETE', release: 'manual, pending owner' };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const states = {};
  for (const t of manifest.tickets) { const { plan_text: _p, ...s } = readTicket(t, opts); states[t.key] = s; }
  const nodes = manifest.tickets.map((t) => ({ id: t.key, deps: t.deps, dep_mode: t.dep_mode, state: states[t.key].state, owner_required: t.owner_required === true,
    class: 'heavy', priority: t.priority ?? 0, owns: t.owns ?? [] }));
  const { decisions, ready } = evaluateReadiness(nodes);
  return { ok: true, code: null, wave_id: manifest.wave_id, digest: v.digest, release_mode: v.release_mode, release: 'manual, pending owner', states, decisions,
    ready: admissionOrder(nodes, ready), verdict: waveVerdict(decisions) };
}

export function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) { if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) throw Object.assign(new Error('usage'), { usage: true }); flags[rest[i].slice(2)] = rest[i + 1]; }
  if (!['verify', 'status'].includes(cmd) || !flags.wave || Object.keys(flags).some((k) => k !== 'wave')) throw Object.assign(new Error('Usage: wave.mjs verify|status --wave <manifest>'), { usage: true });
  const out = cmd === 'verify' ? verifyWave(resolve(flags.wave)) : waveStatus(resolve(flags.wave));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return out.ok ? 0 : 2;
}

if (isEntrypoint(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`wave: ${e.message}\n`); process.exitCode = e.usage ? 1 : 2; }
}
