#!/usr/bin/env node
/**
 * Worker brief builder and linter (AIS-BENCH-1 Wave 2). An orchestrator tool: it reads the approved
 * DAG, the plan and optional recon answers, and writes the prompt file a builder receives, so every
 * brief carries ownership, forbidden paths, required tests and the report block. Nothing in the
 * engine calls it and it changes no engine behavior.
 *
 * Adapted from strategy/coordination/handoff-templates.md at commit 8ae6164 of
 * msitarzewski/agency-agents, MIT, Copyright (c) 2025 AgentLand Contributors.
 *
 * CLI:
 *   brief.mjs build --dag <dag.json> --node <id> --plan <plan.md> [--recon <json>] [--notes <file>] --out <file>
 *   brief.mjs lint <brief>
 *   brief.mjs plan-digest --plan <plan.md>            prints `sha256:<64 hex>`, the narrative digest START binds
 *   brief.mjs start-check --plan <plan.md> --run-id <id> [--repo <dir>]   read-only START validation, typed JSON on stdout
 *   brief.mjs debate-check --plan <plan.md> --bundle <dir> --repo <dir>   read-only Planning Debate check before ExitPlanMode (S4)
 *   brief.mjs debate-serialize --attestation <json>      prints the plan-resident attestation line and its sha256
 *   brief.mjs debate-serialize --dispositions <json>     prints the narrative `debate-dispositions-v1:` line
 *   brief.mjs debate-retain --plan <plan.md> --bundle <dir> --repo <dir>   copies the debate bundle to the retained locator
 *   brief.mjs debate-probe --relay <relay.mjs> --repo <dir> --out-dir <dir> [--carrier codex|claude] [--cli <bin>] [--busy-timeout <dur>] [--probe-timeout <dur>]
 *                                                     PLAN carrier probe: dispatch, fresh_result, resume, cancellation, coverage
 * Output is deterministic for build and plan-digest: no randomness, no absolute path (start-check reads the clock only for the
 * approved_at skew test). The last line is
 * `brief-digest sha256:<hex>`, the digest of everything above it after CRLF became LF. Dependency-free Node >= 18; its repository imports are the read-only
 * RISK_EVIDENCE table of harness.mjs, the T0 declaration validator of fast-checks.mjs, the test-kind table of test-kinds.mjs and
 * the RUN-STATE parser of run-state.mjs.
 *
 * Exit codes: 0 success, 1 a failed lint or any other refused input (unknown node, plan without a
 * RUN-STATE block, unreadable file, invalid JSON, a refused --out), 2 a usage error or a DAG or recon
 * field that contains a newline, control character or backtick.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync, statSync, realpathSync, copyFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync, openSync, fstatSync, readSync, closeSync, constants as fsConstants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RISK_EVIDENCE, isEntrypoint } from './harness.mjs';
import { validateDeclaration } from './fast-checks.mjs';
import { KINDS, ITEM_ID } from './test-kinds.mjs';
import { parseRunState, malformedReason, splitLines, eventLine } from './run-state.mjs';

export const SECTIONS = [
  'Task', 'Approved plan and digest', 'Ownership', 'Forbidden paths', 'Dependencies and reads',
  'Exclusive resources', 'Required tests', 'Reuse inventory', 'Acceptance ids', 'Notes', 'Worker rules', 'Report block',
];
/** Sections whose absence or emptiness makes `lint` fail. */
export const REQUIRED_SECTIONS = ['Ownership', 'Forbidden paths', 'Required tests', 'Reuse inventory', 'Report block'];

const RUN_STATE_BEGIN = '<!-- RUN-STATE:BEGIN -->';
const RUN_STATE_END = '<!-- RUN-STATE:END -->';
const DIGEST_LINE = /^brief-digest sha256:([0-9a-f]{64})$/;

const fail = (message) => Object.assign(new Error(message), { briefError: true });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** Line ends only: CRLF and lone CR become LF. Backslashes in text are never rewritten. */
const normalise = (text) => String(text).replace(/\r\n?/g, '\n');
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
const bullets = (list, none) => (list.length ? list.map((x) => `- ${x}`) : [`- ${none}`]);
const code = (x) => `\`${x}\``;
const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * Exactly the engine's planNarrativeDigest (engine-dag.mjs): sha256 of the raw plan text with everything
 * strictly between the RUN-STATE markers removed, markers kept. No line-end normalisation, so a CRLF plan
 * has a different digest than its LF twin, as in the engine. A plan without the markers is refused.
 */
export function planDigest(planText) {
  const b = planText.indexOf(RUN_STATE_BEGIN);
  const e = planText.indexOf(RUN_STATE_END);
  if (b < 0 || e < b) throw fail('plan_invalid: plan has no RUN-STATE block');
  return `sha256:${sha256(planText.slice(0, b + RUN_STATE_BEGIN.length) + planText.slice(e))}`;
}

// ---- plan-digest and start-check (S3a-1) -------------------------------------------------------------
const DIGEST_FORMAT = /^sha256:[0-9a-f]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const SKEW_MS = 5 * 60 * 1000;
/** True when the ISO-8601 string is a real calendar instant (rejects 2026-02-30 and hour 25). */
function realInstant(at) {
  const m = ISO_8601.exec(at);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return false;
  if (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
  return !Number.isNaN(Date.parse(at));
}

/** Whole-file hashes a hand-computed digest could be: the file as it stands, and the file before any START line was appended. */
function wholeFileHashes(planText) {
  const lines = planText.split(/(?<=\n)/);
  const withoutStart = lines.filter((l) => { try { return JSON.parse(l)?.event !== 'START'; } catch { return true; } }).join('');
  return new Set([`sha256:${sha256(planText)}`, `sha256:${sha256(withoutStart)}`]);
}

/**
 * Validate the START event of one run in a plan's RUN-STATE block. Read-only. Returns { ok, errors, warnings, run_id, digest }
 * where each error is { code, message }. `runId` is required (the engine always filters START on run_id).
 * Semantics follow the engine: a plan without a well-formed block is `plan_invalid` (thrown, never a fallback hash),
 * a block the engine calls malformed is `run_state_malformed`, CRLF is not normalised (a CRLF plan and its LF twin differ).
 * `ok` is NECESSARY, NOT SUFFICIENT: the engine also applies its trusted-START (quiescence) rule, which this check cannot see.
 */
export function startCheck(planText, { runId, now = Date.now(), bundleDir = null, repo = null } = {}) {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) throw Object.assign(new Error('start-check needs a safe --run-id'), { usage: true });
  const digest = planDigest(planText); // throws plan_invalid
  const errors = [], warnings = [];
  const add = (code, message) => errors.push({ code, message });
  const R = parseRunState(planText);
  const malformed = malformedReason(R);
  if (malformed) {
    add('run_state_malformed', malformed);
    return { ok: false, errors, warnings, run_id: runId, digest };
  }
  const allStarts = R.events.filter((e) => e.event === 'START');
  const start = allStarts.filter((e) => e.run_id === runId).at(-1);
  if (!start) {
    const noId = allStarts.some((e) => typeof e.run_id !== 'string' || !SAFE_RUN_ID.test(e.run_id));
    if (noId) add('start_run_id_missing', 'a START has no safe run_id; the engine ignores it');
    else add('start_missing', `no START event for run_id ${runId}`);
    return { ok: false, errors, warnings, run_id: runId, digest };
  }
  // digest
  const d = start.approved_plan_digest;
  if (typeof d !== 'string' || !d) add('start_digest_missing', 'START has no approved_plan_digest');
  else {
    let canon = d;
    if (/^sha256-[0-9a-f]{64}$/.test(d)) { canon = d.replace(/^sha256-/, 'sha256:'); warnings.push({ code: 'start_digest_legacy', message: 'approved_plan_digest uses the legacy sha256- prefix; write sha256:<hex>' }); }
    if (/^(sha256[:-])?[0-9a-f]{8,63}$/.test(d)) add('start_digest_truncated', 'approved_plan_digest is truncated (shasum | cut); use `brief.mjs plan-digest`');
    else if (!DIGEST_FORMAT.test(canon)) add('start_digest_format', 'approved_plan_digest must match ^sha256:[0-9a-f]{64}$ (use `brief.mjs plan-digest`, not shasum)');
    else if (canon !== digest) {
      if (wholeFileHashes(planText).has(canon)) add('start_digest_whole_file', 'approved_plan_digest hashes the whole file; the START binds the narrative digest (RUN-STATE body removed): use `brief.mjs plan-digest`');
      else add('start_digest_stale', `approved_plan_digest does not equal the current narrative digest ${digest}; the narrative changed after hashing or the digest was computed another way`);
    }
  }
  // approval time: approved_at; a timestamp-only START is read by the engine, so it passes with a warning
  let at = start.approved_at;
  if ((at === undefined || at === null || at === '') && typeof start.timestamp === 'string' && start.timestamp) {
    at = start.timestamp;
    warnings.push({ code: 'start_timestamp_legacy', message: 'START has no approved_at; the engine reads timestamp, but new runs must write approved_at' });
  }
  if (at === undefined || at === null || at === '') {
    add(start.at !== undefined ? 'start_at_not_approved_at' : 'start_approved_at_missing',
      start.at !== undefined ? 'START uses `at`; the field is `approved_at`' : 'START has no approved_at');
  } else if (typeof at !== 'string' || !realInstant(at)) add('start_approved_at_invalid', 'approved_at must be a real ISO-8601 timestamp with a time zone');
  else if (Date.parse(at) > now + SKEW_MS) add('start_approved_at_future', 'approved_at is in the future (more than 5 minutes of clock skew)');
  // approved_by: descriptive metadata, presence-checked only. Its content is never inspected and never evidence of
  // authorization; authority is native Plan Mode approval plus the approved-plan digest binding (checked above).
  const by = start.approved_by;
  if (typeof by !== 'string' || !by.trim()) add('start_approver_missing', 'START has no approved_by (descriptive metadata: who approved the plan)');
  // S4 debate fields: checked only on a valid approval time, so an invalid START keeps its one exact code.
  if (!errors.some((e) => /^start_(approved_at|at_not)/.test(e.code))) debateStartCheck(planText, start, { bundleDir, repo, digest, add });
  return { ok: errors.length === 0, errors, warnings, run_id: runId, digest };
}

// ---- the reciprocal Planning Debate (S4) ------------------------------------------------------------------------------
/**
 * A START approved before this instant on a plan WITHOUT `debate_policy` is legacy: no debate field is checked. The one
 * place the S4 cutoff lives. It must be >= the merge instant of the S4 PR and is FINALIZED BY THE OWNER AT MERGE, with the
 * same discipline as SECURITY_POLICY_CUTOFF in engine-dag.mjs: a plan approved after the cutoff by a skill without S4 (so
 * without `debate_policy: 2`) would otherwise be refused as debate_policy_missing. A plan that carries `debate_policy: 2`
 * is checked whatever its approval date. Pinned in brief-debate.test.mjs.
 */
export const DEBATE_POLICY_CUTOFF = '2026-11-23T00:00:00.000Z';
/** Whether a START is legacy for the debate: approved_at (else timestamp) strictly before the cutoff; missing or unparseable fails closed. */
export function debateLegacyApproval(start) {
  const at = start?.approved_at ?? start?.timestamp;
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(t) && t < Date.parse(DEBATE_POLICY_CUTOFF);
}
/** LIMIT_REACHED is RESERVED and unsupported (D-A11): no authenticated telemetry source exists yet (follow-up F-105-1). */
export const DEBATE_OUTCOMES = Object.freeze(['CONVERGED', 'UNRESOLVED', 'SKIPPED']);
/** Every refusal code `debate-check` and the START debate fields can return. */
export const DEBATE_CODES = Object.freeze(['debate_policy_missing', 'debate_attestation_missing', 'debate_attestation_invalid', 'debate_attestation_changed',
  'debate_evidence_missing', 'debate_evidence_mismatch', 'debate_digest_mismatch', 'debate_request_mismatch', 'debate_response_invalid', 'debate_carrier_invalid',
  'debate_degradation_unacknowledged', 'debate_open_finding', 'debate_outcome_invalid', 'debate_limit_unsupported', 'debate_exception_missing',
  'debate_disposition_pending', 'debate_reconfirm_required', 'debate_workdir_unbound', 'debate_narrative_hidden_markup']);
/** The frozen acknowledgement sentences of the `debate-dispositions-v1` line (exact text). */
export const DEGRADED_ACK = 'The owner accepts this degraded debate carrier for this ticket: it is a transport label, not cross-model agreement; it does not by itself resolve or waive any finding, and the same convergence checks apply.';
export const SKIP_ACK = 'The owner approves skipping the Planning Debate for this ticket only.';
export const WAIVE_ACK = 'The owner waives the listed debate findings for this ticket only.';
const ATTEST_HEAD = '<!-- debate-attestation-v1 ';
const ATTEST_TAIL = ' -->';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEBATE_ID_FORMAT = /^debate-[A-Za-z0-9][A-Za-z0-9._-]{0,100}-\d{8}T\d{4}Z$/;
const CARRIER_KINDS = { codex: ['codex_relay'], claude: ['claude_relay', 'native_session'], fable: ['native_session', 'claude_relay'] };
const PAIRED = { claude: 'codex', codex: 'claude' };
const ROUND_STATUS = ['completed', 'failed', 'timeout', 'aborted', 'unavailable'];
const SEVERITIES = ['blocker', 'major', 'minor'];
const CONCRETE = new Set(['accept_risk', 'decided', 'waived']);
const BRIEF_LINE = /^(request_id|plan_version|plan_digest): (\S+)$/;
const sha256Of = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * Whether `v` holds `<...>` markup: a `<` with a `>` anywhere after it. Exactly what /<[^>]*>/ matched (the first `>` after
 * a `<` ends a match), in linear time: two indexOf scans, no backtracking quantifier over untrusted text (MAJOR-1a).
 */
const angleMarkup = (v) => { const lt = v.indexOf('<'); return lt >= 0 && v.indexOf('>', lt + 1) > lt; };
const placeholder = (v) => !nonEmpty(v) || /^(none|tbd|todo|pending|n\/a|-)$/i.test(v.trim()) || angleMarkup(v);

/** The structural bounds of every untrusted JSON value the debate checks read. */
export const JSON_BOUNDS = Object.freeze({ depth: 64, nodes: 100000, array: 1024, string: 1000000 });
/**
 * The ONE structural bounds gate (D-A11), applied once to every untrusted JSON value before any processing: the
 * attestation, every response object, the dispositions line and every retained relay result.json. Iterative (no
 * recursion over untrusted depth); it refuses more than JSON_BOUNDS.nodes nodes, nesting deeper than JSON_BOUNDS.depth,
 * an array longer than JSON_BOUNDS.array, a string or key longer than JSON_BOUNDS.string, and a non-finite number.
 * Returns why, or null.
 */
export function jsonBoundsProblem(root) {
  const stack = [[root, 0]];
  let nodes = 0;
  while (stack.length) {
    const [v, d] = stack.pop();
    nodes += 1;
    if (nodes > JSON_BOUNDS.nodes) return `more than ${JSON_BOUNDS.nodes} JSON nodes`;
    if (d > JSON_BOUNDS.depth) return `nested deeper than ${JSON_BOUNDS.depth} levels`;
    if (typeof v === 'string') { if (v.length > JSON_BOUNDS.string) return `a string longer than ${JSON_BOUNDS.string} characters`; }
    else if (typeof v === 'number') { if (!Number.isFinite(v)) return 'a non-finite number'; }
    else if (Array.isArray(v)) {
      if (v.length > JSON_BOUNDS.array) return `an array longer than ${JSON_BOUNDS.array} elements`;
      for (const x of v) stack.push([x, d + 1]);
    } else if (isObject(v)) {
      for (const k of Object.keys(v)) {
        if (k.length > JSON_BOUNDS.string) return `a key longer than ${JSON_BOUNDS.string} characters`;
        stack.push([v[k], d + 1]);
      }
    }
  }
  return null;
}
/** Keys sorted at every depth; arrays keep their order. Callers pass the bounds gate first. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  if (typeof v === 'number' && !Number.isFinite(v)) throw fail('debate_attestation_invalid: a number in the attestation is not finite');
  return v;
}

/**
 * The plan-resident attestation line: `<!-- debate-attestation-v1 <canonical single-line JSON> -->`. Deterministic and
 * comment-safe: keys sorted, the hidden line breaks JSON.stringify leaves raw (U+0085, U+2028, U+2029) escaped by the one
 * RUN-STATE serializer (eventLine), then every C1 control, `<` and `>` escaped, so neither RUN-STATE marker text nor `-->`
 * can appear inside it. It never starts with `{`, so the RUN-STATE reader never sees it as an event. The bytes hashed
 * (`debate_attestation_sha256`) are exactly this line in UTF-8, without its line end.
 */
export function serializeAttestation(att) {
  if (!isObject(att)) throw fail('debate_attestation_invalid: the attestation must be a JSON object');
  const json = eventLine(canonical(att)).replace(/[\u007f-\u009f<>]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${ATTEST_HEAD}${json}${ATTEST_TAIL}`;
}

/** The narrative: the plan with the RUN-STATE body removed (what the digest covers). */
function narrativeOf(planText) {
  const b = planText.indexOf(RUN_STATE_BEGIN);
  const e = planText.indexOf(RUN_STATE_END);
  return b < 0 || e < b ? planText : planText.slice(0, b) + planText.slice(e);
}

/** `{ ok, line, sha256, attestation }` or `{ ok: false, error: { code, message } }` for the one attestation line of the RUN-STATE body. */
export function readAttestation(planText) {
  const bad = (code, message) => ({ ok: false, error: { code, message } });
  const R = parseRunState(planText);
  if (!R) return bad('debate_attestation_missing', 'the plan has no RUN-STATE block, so no debate attestation');
  if (R.events.some((e) => Object.hasOwn(e, 'debate-attestation-v1') || Object.hasOwn(e, 'debate_id'))) {
    return bad('debate_attestation_invalid', 'a RUN-STATE line starting with { carries debate attestation data: the engine reads such a line as an event. Write the comment line `brief.mjs debate-serialize` prints instead');
  }
  const found = splitLines(R.block).filter((l) => l.includes('debate-attestation-v1'));
  if (!found.length) return bad('debate_attestation_missing', 'the RUN-STATE body holds no `<!-- debate-attestation-v1 ... -->` line');
  if (found.length > 1) return bad('debate_attestation_invalid', `the RUN-STATE body holds ${found.length} debate attestation lines; exactly one is allowed`);
  const line = found[0];
  if (!line.startsWith(ATTEST_HEAD) || !line.endsWith(ATTEST_TAIL)) return bad('debate_attestation_invalid', 'the attestation line must be exactly `<!-- debate-attestation-v1 <json> -->` from column 1, with nothing after it');
  let att;
  try { att = JSON.parse(line.slice(ATTEST_HEAD.length, line.length - ATTEST_TAIL.length)); } catch (err) { return bad('debate_attestation_invalid', `the attestation JSON does not parse: ${err.message}`); }
  if (!isObject(att)) return bad('debate_attestation_invalid', 'the attestation is not a JSON object');
  const bounds = jsonBoundsProblem(att);
  if (bounds) return bad('debate_attestation_invalid', `the attestation JSON is out of bounds: ${bounds}`);
  let again;
  try { again = serializeAttestation(att); } catch (err) { return bad('debate_attestation_invalid', err.message); }
  if (again !== line) return bad('debate_attestation_invalid', 'the attestation line is not in canonical form (use `brief.mjs debate-serialize`; never hand-edit it)');
  return { ok: true, line, sha256: sha256Of(Buffer.from(line, 'utf8')), attestation: att };
}

/**
 * The `debate_policy:` header of the narrative: { value, count }. Linear (MAJOR-1c): one pass over the lines (LF after
 * CRLF/CR normalisation, U+2028 and U+2029, the line ends the old multiline regex used), no regex over the text. `count` is
 * every line that starts, after whitespace, with `debate_policy:`; `value` is its single token when exactly one such line
 * exists and the rest of it is one token. Compared with the old /^\s*debate_policy:\s*(\S*)\s*$/gm reader, it can only
 * refuse more, never newly route a plan to legacy (count 0) or newly accept one: a value on the NEXT line, or a second
 * token on the line, no longer reads as a header value (pinned by a differential in brief-debate.test.mjs).
 */
export function debatePolicy(narr) {
  let count = 0, value = null;
  for (const line of normalise(narr).split(/[\n\u2028\u2029]/)) {
    const s = line.trimStart();
    if (!s.startsWith('debate_policy:')) continue;
    count += 1;
    const rest = s.slice('debate_policy:'.length).trim();
    value = /\s/.test(rest) ? null : rest;
  }
  return { value: count === 1 ? value : null, count };
}

// ---- the frozen dispositions line (approved amendment 2026-11-23, B1 closed structurally) -----------------------------
/**
 * Markdown never carries authority. The owner-approved machine content of section 7 (outcome, degraded-carrier
 * acknowledgement, exception, dispositions) is ONE visible narrative line `debate-dispositions-v1: <canonical JSON>` at
 * column 1: inside the narrative, so the approved digest binds it; visible in the ExitPlanMode presentation; serialized
 * by the same comment-safe canonical serializer as the attestation; exactly one occurrence of the token in the narrative.
 * Code fences, indentation and the human-readable section 7 Markdown are never read for authority.
 */
const DISPO_HEAD = 'debate-dispositions-v1: ';
const DISPO_TOKEN = 'debate-dispositions-v1';
const DISPO_KEYS = ['carrier_degraded', 'debate_id', 'degradation_ack', 'dispositions', 'exception', 'outcome', 'v'];
const EXCEPTION_KEYS = ['ack', 'kind', 'reason', 'scope'];
const DISPOSITION_KEYS = ['design_change', 'id', 'kind', 'resolution'];
const sameKeys = (o, keys) => isObject(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
/** The comment-safe canonical JSON of the attestation and the dispositions line (keys sorted, hidden breaks, C1, `<`, `>` escaped). */
const commentSafeJson = (o) => eventLine(canonical(o)).replace(/[\u007f-\u009f<>]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** The one narrative line carrying the owner-approved debate dispositions. */
export function serializeDispositions(d) {
  if (!isObject(d)) throw fail('debate_attestation_invalid: the dispositions must be a JSON object');
  return `${DISPO_HEAD}${commentSafeJson(d)}`;
}
/**
 * `{ d }` or `{ error }` for the narrative's dispositions line. Schema: {v: 1, debate_id, outcome, carrier_degraded:
 * bool, degradation_ack: string|null, exception: null|{kind: SKIPPED|WAIVED, reason, scope, ack}, dispositions:
 * [{id, kind: accept_risk|decided|waived, resolution, design_change: bool}]}, no other key; a pending finding has no row.
 */
function readDispositions(narr) {
  const text = normalise(narr);
  const count = text.split(DISPO_TOKEN).length - 1;
  if (count !== 1) return { error: `the narrative must hold exactly one ${DISPO_TOKEN} line (found ${count} occurrences of the token)` };
  const line = text.split('\n').find((l) => l.includes(DISPO_TOKEN));
  let d;
  try { d = JSON.parse(line.slice(DISPO_HEAD.length)); } catch (err) { return { error: `the ${DISPO_TOKEN} JSON does not parse: ${err.message}` }; }
  if (!sameKeys(d, DISPO_KEYS)) return { error: `the ${DISPO_TOKEN} object must hold exactly ${DISPO_KEYS.join(', ')}` };
  const bounds = jsonBoundsProblem(d);
  if (bounds) return { error: `the ${DISPO_TOKEN} JSON is out of bounds: ${bounds}` };
  if (serializeDispositions(d) !== line) return { error: `the ${DISPO_TOKEN} line is not exactly \`${DISPO_HEAD}<canonical JSON>\` from column 1 (use \`brief.mjs debate-serialize --dispositions\`)` };
  if (d.v !== 1 || typeof d.debate_id !== 'string' || !DEBATE_OUTCOMES.includes(d.outcome) || typeof d.carrier_degraded !== 'boolean'
    || !(d.degradation_ack === null || typeof d.degradation_ack === 'string')) return { error: `${DISPO_TOKEN}: v 1, debate_id, outcome, carrier_degraded and degradation_ack have the wrong type or value` };
  if (d.exception !== null && !(sameKeys(d.exception, EXCEPTION_KEYS) && ['SKIPPED', 'WAIVED'].includes(d.exception.kind)
    && EXCEPTION_KEYS.every((k) => typeof d.exception[k] === 'string'))) return { error: `${DISPO_TOKEN}: exception is null or {kind: SKIPPED|WAIVED, reason, scope, ack}` };
  if (!Array.isArray(d.dispositions)) return { error: `${DISPO_TOKEN}: dispositions must be an array` };
  const ids = new Set();
  for (const row of d.dispositions) {
    if (!sameKeys(row, DISPOSITION_KEYS) || typeof row.id !== 'string' || !CONCRETE.has(row.kind) || typeof row.resolution !== 'string' || typeof row.design_change !== 'boolean') {
      return { error: `${DISPO_TOKEN}: each disposition is {id, kind: accept_risk|decided|waived, resolution, design_change: true|false}` };
    }
    if (ids.has(row.id)) return { error: `${DISPO_TOKEN}: ${row.id} has two dispositions` };
    ids.add(row.id);
  }
  return { d };
}

/**
 * D-A9 (2026-11-23): why the narrative of a debate_policy 2 plan could hide a line, or null. Raw substrings only, no
 * Markdown context: every exact `<!--` outside the RUN-STATE body (the two markers excluded) must be followed by `-->`
 * later on the SAME line, so no comment can span, and hide, another line. `<!-->` and `<!--->` have no later `-->` and
 * are refused (fail closed); a single-line comment such as the mandated `<!-- security-plan: ... -->` line is allowed.
 * Only the exact substring `<!--` opens a comment (HTML recognises no other opener). Other hiding techniques in a
 * rendered view are not scanned: the verbatim quote of the dispositions line in the ExitPlanMode text is the control.
 */
function hiddenMarkup(narr) {
  const lines = normalise(narr.replace(RUN_STATE_BEGIN, '').replace(RUN_STATE_END, '')).split('\n');
  for (let n = 0; n < lines.length; n += 1) {
    // Linear (MAJOR-1c): every `<!--` has a later `-->` (at least 4 characters on) exactly when the LAST one does.
    const open = lines[n].lastIndexOf('<!--');
    if (open >= 0 && lines[n].lastIndexOf('-->') < open + 4) return `narrative line ${n + 1} opens an HTML comment that does not close on the same line: only single-line comments are allowed in a debate_policy 2 narrative`;
  }
  return null;
}

/** Whether the dispositions line carries the owner exception of `kind` (SKIPPED or WAIVED): reason, scope this ticket and the exact acknowledgement. */
function exceptionOk(D, kind) {
  const e = D?.exception;
  return isObject(e) && e.kind === kind && !placeholder(e.reason) && e.scope === 'this ticket' && e.ack === (kind === 'SKIPPED' ? SKIP_ACK : WAIVE_ACK);
}

// ---- the counterpart response v1 (approved amendment 2026-11-23) ------------------------------------------------------
export const RESPONSE_MAX_BYTES = 16384;
const RESPONSE_KEYS = ['v', 'request_id', 'plan_version', 'plan_digest', 'verdict', 'findings'];
const FINDING_KEYS = ['id', 'status', 'severity', 'note'];
const RESPONSE_STATUS = ['conceded', 'confirmed', 'maintained', 'new'];
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The disposition id of an incomplete review (MINOR-2): reserved, never a counterpart finding id, so one row settles one obligation. */
const LIMIT_ID = 'LIMIT';
const PLAN_VERSION = /^v[0-9]{1,4}$/;

/**
 * Validate one counterpart response: the ENTIRE text must be one counterpart-response-v1 object, UTF-8, at most 16 KiB,
 * nothing before or after it (JSON.parse refuses prose, fences and a BOM), every schema field with a valid type and enum
 * (a missing field fails its own check), and bytes equal to its schema-ordered compact serialization: that one rebuild
 * is the key-tracking guard, refusing whitespace, key order, duplicate and extra keys at every level. Contradictions are refused (AGREE with
 * a maintained finding or a new blocker or major; CHANGES_REQUESTED with nothing maintained or new). With `expect`, the
 * request_id, plan_version and plan_digest are bound to it. `note` is never read. No free-text fallback exists.
 * Returns `{ ok: true, obj }` or `{ ok: false, code, why }`.
 */
export function parseResponse(text, expect = null) {
  const bad = (why, code = 'debate_response_invalid') => ({ ok: false, code, why });
  if (typeof text !== 'string') return bad('the response is not text');
  if (Buffer.byteLength(text, 'utf8') > RESPONSE_MAX_BYTES) return bad(`the response is larger than ${RESPONSE_MAX_BYTES} bytes`);
  let o;
  try { o = JSON.parse(text); } catch { return bad('the response is not exactly one JSON object (text, a fence or a BOM around it, or invalid JSON)'); }
  // Kept although the 16 KiB cap already bounds the work: the ONE gate runs at every untrusted JSON entry (D-A11).
  const bounds = jsonBoundsProblem(o);
  if (bounds) return bad(`the response JSON is out of bounds: ${bounds}`);
  if (!isObject(o)) return bad('the response is not a JSON object');
  if (o.v !== 1) return bad('v must be the integer 1');
  if (typeof o.request_id !== 'string' || !SAFE_SEGMENT.test(o.request_id)) return bad('request_id must be a safe identifier');
  if (typeof o.plan_version !== 'string' || !PLAN_VERSION.test(o.plan_version)) return bad('plan_version must match v<1-4 digits>');
  if (typeof o.plan_digest !== 'string' || !DIGEST_FORMAT.test(o.plan_digest)) return bad('plan_digest must be sha256:<64 hex>');
  if (o.verdict !== 'AGREE' && o.verdict !== 'CHANGES_REQUESTED') return bad('verdict must be AGREE or CHANGES_REQUESTED');
  if (!Array.isArray(o.findings) || o.findings.length > 12) return bad('findings must be an array of at most 12 objects');
  const ids = new Set();
  for (const f of o.findings) {
    if (!isObject(f)) return bad('a finding is not an object');
    if (typeof f.id !== 'string' || !FINDING_ID.test(f.id)) return bad('a finding id must be a safe identifier');
    if (f.id === LIMIT_ID) return bad(`finding id ${LIMIT_ID} is reserved for the owner's disposition of an incomplete review`);
    if (ids.has(f.id)) return bad(`finding ${f.id} appears twice`);
    ids.add(f.id);
    if (!RESPONSE_STATUS.includes(f.status)) return bad(`finding ${f.id}: status must be conceded, confirmed, maintained or new`);
    if (Object.hasOwn(f, 'severity') ? !SEVERITIES.includes(f.severity) : f.status === 'new') return bad(`finding ${f.id}: severity is blocker, major or minor, and required for a new finding`);
    if (Object.hasOwn(f, 'note') && !(typeof f.note === 'string' && f.note.length <= 2000)) return bad(`finding ${f.id}: note must be a string of at most 2000 characters`);
  }
  const ordered = { v: o.v, request_id: o.request_id, plan_version: o.plan_version, plan_digest: o.plan_digest, verdict: o.verdict,
    findings: o.findings.map((f) => Object.fromEntries(FINDING_KEYS.filter((k) => Object.hasOwn(f, k)).map((k) => [k, f[k]]))) };
  if (JSON.stringify(ordered) !== text) return bad('the response bytes are not its canonical serialization (schema key order, no whitespace, no duplicate key)');
  if (o.verdict === 'AGREE' && o.findings.some((f) => f.status === 'maintained' || (f.status === 'new' && f.severity !== 'minor'))) return bad('AGREE contradicts a maintained finding or a new blocker or major');
  if (o.verdict === 'CHANGES_REQUESTED' && !o.findings.some((f) => f.status === 'maintained' || f.status === 'new')) return bad('CHANGES_REQUESTED with no maintained or new finding');
  if (expect) {
    if (o.request_id !== expect.request_id) return bad(`the response answers request_id ${o.request_id}, not ${expect.request_id} (a stale or foreign response)`, 'debate_request_mismatch');
    if (o.plan_version !== expect.plan_version) return bad(`the response names plan_version ${o.plan_version}, not ${expect.plan_version}`, 'debate_request_mismatch');
    if (o.plan_digest !== expect.plan_digest) return bad(`the response names plan_digest ${o.plan_digest}, not ${expect.plan_digest}`, 'debate_digest_mismatch');
  }
  return { ok: true, obj: o };
}

/** {@link parseResponse} over raw bytes: decoded as strict UTF-8 (invalid bytes refused; a BOM is kept, so it is refused). */
export function parseResponseBytes(bytes, expect = null) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return { ok: false, code: 'debate_response_invalid', why: 'the response bytes are not valid UTF-8' }; }
  return parseResponse(text, expect);
}

/** The first `request_id:`, `plan_version:` and `plan_digest:` lines of the brief that was sent. */
function briefFields(text) {
  const out = {};
  for (const l of normalise(text).split('\n')) {
    const m = BRIEF_LINE.exec(l.trimEnd());
    if (m && !Object.hasOwn(out, m[1])) out[m[1]] = m[2];
  }
  return out;
}

/** A bundle-relative evidence path: relative, forward slashes, no empty, `.` or `..` segment. */
const relativeEvidence = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.includes('\\')
  && p.split('/').every((s) => s && s !== '.' && s !== '..');

/**
 * `{ path }` of a bundle-relative evidence file, or `{ code, why }`: no component (the root included) may be a symbolic
 * link, the file must be a regular file and its real path must lie inside the root's real path. This keeps a retained
 * bundle self-contained: a link back into the original scratch directory is refused, not followed.
 */
function containedFile(root, rel) {
  let p = root;
  try {
    if (lstatSync(root).isSymbolicLink()) return { code: 'debate_evidence_mismatch', why: 'the bundle root is a symbolic link' };
    for (const part of rel.split('/')) {
      p = join(p, part);
      if (lstatSync(p).isSymbolicLink()) return { code: 'debate_evidence_mismatch', why: `${rel} passes through a symbolic link` };
    }
    const st = lstatSync(p);
    if (!st.isFile()) return { code: 'debate_evidence_mismatch', why: `${rel} is not a regular file` };
    if (!realpathSync(p).startsWith(realpathSync(root) + sep)) return { code: 'debate_evidence_mismatch', why: `${rel} resolves outside the bundle` };
    return { path: p, size: st.size };
  } catch (err) { return { code: 'debate_evidence_missing', why: `${rel} is not readable in the bundle (${err.code ?? err.message})` }; }
}

/** The evidence file names a round may reference (MAJOR-1b); any other `files` key is refused, never read. */
export const EVIDENCE_NAMES = Object.freeze(['brief', 'result', 'events', 'message']);
/**
 * Evidence size caps (MAJOR-1b), checked from the file sizes BEFORE any read. A real relay round is kilobytes (the retained
 * fixtures are under 2 KiB, a response at most 16 KiB); 16 MiB per file and 64 MiB per debate leave a long event stream
 * ample room while bounding the hashing work, and stay far below the 2 GiB Node read limit and the maximum string length.
 */
export const EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
export const EVIDENCE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
/**
 * `{ bytes }` of the regular file at `path`, read through one descriptor whose size is checked first (at most `max`
 * bytes), or `{ code, why }`: a read failure is a typed refusal, never an exception.
 */
function readBounded(path, max, label) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > max) return { code: 'debate_evidence_mismatch', why: `${label} is ${size} bytes; an evidence file is at most ${max} bytes` };
    const bytes = Buffer.alloc(size);
    let at = 0;
    while (at < size) { const n = readSync(fd, bytes, at, size - at, at); if (n === 0) break; at += n; }
    return at === size ? { bytes } : { code: 'debate_evidence_mismatch', why: `${label} changed while it was read` };
  } catch (err) {
    return { code: 'debate_evidence_missing', why: `${label} is not readable (${err.code ?? err.message})` };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}
/** `{ bytes }` of a bundle-relative evidence file (contained, at most `max` bytes), or `{ code, why }`. */
function evidenceBytes(root, rel, max = EVIDENCE_MAX_BYTES) {
  const c = containedFile(root, rel);
  return c.path ? readBounded(c.path, max, rel) : c;
}
/**
 * Why the DISTINCT evidence files the rounds reference exceed the caps, or null. Sizes only (lstat), no file is read, so
 * an oversized or sparse multi-gigabyte file costs nothing. Unknown names and bad paths are left to verifyRound.
 */
function evidenceSizeProblem(rounds, bundleDir) {
  if (!bundleDir) return null;
  const sizes = new Map();
  for (const r of rounds) {
    if (!isObject(r) || !isObject(r.files)) continue;
    for (const name of EVIDENCE_NAMES) {
      const rel = Object.hasOwn(r.files, name) ? r.files[name] : undefined;
      if (!relativeEvidence(rel) || sizes.has(rel)) continue;
      const c = containedFile(bundleDir, rel);
      if (c.path) sizes.set(rel, c.size);
    }
  }
  let total = 0;
  for (const [rel, size] of sizes) {
    if (size > EVIDENCE_MAX_BYTES) return `${rel} is ${size} bytes; an evidence file is at most ${EVIDENCE_MAX_BYTES} bytes`;
    total += size;
  }
  return total > EVIDENCE_TOTAL_MAX_BYTES ? `the ${sizes.size} evidence files hold ${total} bytes; a debate bundle holds at most ${EVIDENCE_TOTAL_MAX_BYTES} bytes in total` : null;
}

/**
 * Why the retained locator `<root>/ai-skills/ship-ticket/debate/<TICKET>/<debate-id>` (root = the git common dir, five
 * levels up) is not a chain of real directories, or null: the root must be a directory, not a link, and every component
 * below it is checked with lstat, so an ancestor symlink into scratch is refused, not followed.
 */
function locatorProblem(dir) {
  const root = resolve(dir, '..', '..', '..', '..', '..');
  let p = root;
  try {
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) return { code: 'debate_evidence_mismatch', why: `the git common dir ${root} is a symbolic link or not a directory` };
    for (const part of relative(root, dir).split(sep)) {
      p = join(p, part);
      const c = lstatSync(p);
      if (c.isSymbolicLink() || !c.isDirectory()) return { code: 'debate_evidence_mismatch', why: `${p} is a symbolic link or not a directory; the retained locator is never followed through one` };
    }
  } catch (err) { return { code: 'debate_evidence_missing', why: `${p} is not there (${err.code ?? err.message})` }; }
  return null;
}

/** The retained locator `<git-common-dir>/ai-skills/ship-ticket/debate/<TICKET>/<debate-id>/`. */
export function debateLocator(commonDir, ticket, debateId) {
  if (!SAFE_SEGMENT.test(String(ticket)) || !DEBATE_ID_FORMAT.test(String(debateId))) throw fail('debate_attestation_invalid: unsafe ticket or debate id for the retained locator');
  return join(commonDir, 'ai-skills', 'ship-ticket', 'debate', ticket, debateId);
}

/** Every evidence file an attestation references (bundle-relative; the four evidence names only). */
const evidencePaths = (att) => asList(att?.rounds).flatMap((r) => (isObject(r?.files) ? EVIDENCE_NAMES.filter((n) => Object.hasOwn(r.files, n)).map((n) => r.files[n]) : []));

const realOr = (p) => { try { return realpathSync.native(String(p)); } catch { return resolve(String(p)); } };
/** Trimmed stdout of `git -C dir ...`, or null. Read-only git queries only. */
/**
 * The child environment for every git query of the debate checks and the probe: the caller's environment with every
 * GIT_* variable removed (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_CEILING_DIRECTORIES, GIT_CONFIG*,
 * ...), so an inherited override can never make another directory look like the repository. Built per call.
 */
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
function gitOut(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: gitEnv() });
  return r.status === 0 ? r.stdout.trim() : null;
}
/** The absolute git common dir of `dir`, or null. */
/** Whether `wd` is a worktree the repository at `top` has registered (`git worktree list --porcelain`). */
const registered = (top, wd) => (gitOut(top, ['worktree', 'list', '--porcelain']) ?? '').split('\n').filter((l) => l.startsWith('worktree ')).some((l) => realOr(l.slice('worktree '.length)) === realOr(wd));

/**
 * Bind the relay workdir to the target repository (`repo`, named by the caller; never assumed). One mechanically
 * checkable binding: the workdir exists now, is the top level of a Git work tree, and is either the repository's own top
 * level or a worktree the repository has registered (`git worktree list --porcelain`; a hand-made gitdir whose commondir
 * points at the repository is not registered). Every git query runs with GIT_* overrides scrubbed. Residual: the binding
 * is to the repository, not to a commit: a registered worktree on another branch, or a dirty work tree, still binds, and
 * the relay result does not record HEAD. A snapshot copy, a subdirectory, another repository with
 * identical content and a directory that no longer exists are all refused. The read-only sandbox keeps the counterpart
 * from changing that work tree.
 */
function bindWorkdir(att, repo, add) {
  const unbound = (why) => add('debate_workdir_unbound', why);
  if (att.workdir_kind !== undefined && att.workdir_kind !== 'repo') { unbound(`workdir_kind ${JSON.stringify(att.workdir_kind)} is not accepted: the relay runs in the repository itself or a linked worktree of it`); return; }
  const top = repo ? gitOut(repo, ['rev-parse', '--show-toplevel']) : null;
  if (!top) { unbound('pass --repo <target repository>: the relay workdir is bound to it, never assumed'); return; }
  const wd = String(att.workdir);
  if (!existsSync(wd)) { unbound(`the relay workdir ${wd} does not exist: the binding is checked against the work tree itself`); return; }
  const wdTop = gitOut(wd, ['rev-parse', '--show-toplevel']);
  if (!wdTop || realOr(wdTop) !== realOr(wd)) { unbound(`the relay workdir ${wd} is not the top level of a Git work tree`); return; }
  if (realOr(wd) !== realOr(top) && !registered(top, wd)) unbound(`the relay workdir ${wd} is neither the repository ${realOr(top)} nor a worktree the repository has registered (git worktree list)`);
}

/**
 * Whether the counterpart reconfirmed `digest`: the last completed round is AGREE for it, under a plan_version that no
 * round on an OLDER digest used (and, for `v<n>` versions, newer than every one of them). A new version may take several
 * exchanges on the same digest.
 */
function reconfirmed(rounds, digest) {
  const list = rounds.filter(isObject);
  const lc = list.filter((r) => r.status === 'completed').at(-1);
  if (!lc || lc.plan_digest !== digest || lc.verdict !== 'AGREE') return false;
  const num = (v) => { const m = /^v(\d+)$/.exec(String(v)); return m ? Number(m[1]) : null; };
  return list.filter((r) => r.plan_digest !== digest).every((r) => r.plan_version !== lc.plan_version
    && (num(r.plan_version) === null || num(lc.plan_version) === null || num(lc.plan_version) > num(r.plan_version)));
}

/**
 * `[code, message]` when a disposition does not authorize START, else null: a row with a concrete resolution text,
 * `waived` only with the frozen exception, and `design_change: true` only after a new plan_version and the
 * counterpart's AGREE for the current digest. A pending finding simply has no row.
 */
function dispositionProblem(id, row, D, rounds, digest) {
  if (!row) return ['debate_disposition_pending', `outstanding ${id} has no disposition in the ${DISPO_TOKEN} line (accept_risk, decided or waived with its text)`];
  if (placeholder(row.resolution)) return ['debate_disposition_pending', `${id}: ${row.kind} without a concrete resolution blocks START`];
  if (row.kind === 'waived' && !exceptionOk(D, 'WAIVED') && !exceptionOk(D, 'SKIPPED')) return ['debate_disposition_pending', `${id}: waived needs the owner exception in the ${DISPO_TOKEN} line`];
  if (row.design_change && !reconfirmed(rounds, digest)) return ['debate_reconfirm_required', `${id}: a design-changing disposition needs a new plan_version, the counterpart's AGREE for the new digest, then native approval again`];
  return null;
}

const RANK = { minor: 1, major: 2, blocker: 3 };
const RANK_NAME = ['', 'minor', 'major', 'blocker', 'unknown'];
/**
 * The canonical ledger DERIVED from the verified response objects, in round order: `new` and `maintained` open an id
 * (the highest severity seen wins; a `maintained` id never opened has an unknown severity, which blocks), `conceded` and
 * `confirmed` close an open id in that round. Closing an id that is not open is refused. Aliases play no part.
 */
function deriveLedger(rounds, perRound, add) {
  const ledger = new Map();
  for (const r of rounds) {
    const resp = isObject(r) && r.status === 'completed' ? perRound.get(r.n)?.response : null;
    if (!resp) continue;
    for (const f of resp.findings) {
      const cur = ledger.get(f.id);
      if (f.status === 'conceded' || f.status === 'confirmed') {
        if (!cur?.open) { add('debate_response_invalid', `round ${r.n}: ${f.status} ${f.id}, which is not open in the ledger before that round`); continue; }
        ledger.set(f.id, { rank: cur.rank, open: false, closed_round: r.n });
      } else {
        const rank = Math.max(cur?.rank ?? 0, f.severity ? RANK[f.severity] : (cur ? 0 : 4));
        ledger.set(f.id, { rank, open: true, closed_round: null });
      }
    }
  }
  return ledger;
}

/**
 * The full Planning Debate verification of a plan against a bundle root and the target repository. Read-only. Never
 * forces agreement: UNRESOLVED (including an incomplete review) is a valid presentation state (`ok`), never refused merely because the
 * counterpart did not AGREE; only CONVERGED is debate-qualified. Agreement and finding dispositions come only from the
 * schema-validated response objects; the owner's dispositions only from the frozen dispositions line. A degraded carrier
 * is a transport label: the same checks apply. Documented limit: this detects inconsistency, replay and stale or
 * unrelated results; it cannot authenticate against a host able to fabricate every input.
 */
function verifyDebate(planText, { bundleDir, repo = null }) {
  const digest = planDigest(planText); // throws plan_invalid
  const errors = [], warnings = [];
  const add = (code, message) => errors.push({ code, message });
  const base = { digest, outcome: null, debate_qualified: false, outstanding: [], pending: [], carrier: null, diversity: null, attestation_sha256: null, run_log_metrics: [] };
  const done = (extra = {}) => ({ ...base, ...extra, ok: errors.length === 0, errors, warnings });
  const malformed = malformedReason(parseRunState(planText));
  if (malformed) { add('run_state_malformed', malformed); return done(); }
  const narr = narrativeOf(planText);
  const policy = debatePolicy(narr);
  if (policy.value !== '2') add('debate_policy_missing', policy.count > 1 ? 'the plan header holds more than one debate_policy line' : 'the plan header must carry `debate_policy: 2` (every new implementation plan)');
  else {
    const hidden = hiddenMarkup(narr);
    if (hidden) add('debate_narrative_hidden_markup', hidden);
  }
  const got = readAttestation(planText);
  if (!got.ok) { add(got.error.code, got.error.message); return done(); }
  const att = got.attestation;
  base.attestation_sha256 = got.sha256;
  const dl = readDispositions(narr);
  if (dl.error) add('debate_attestation_invalid', dl.error);
  const D = dl.d ?? null;
  // ---- schema
  if (att.v !== 1 || att.policy !== 2) add('debate_attestation_invalid', 'the attestation must carry v: 1 and policy: 2');
  if (!SAFE_SEGMENT.test(String(att.ticket)) || !DEBATE_ID_FORMAT.test(String(att.debate_id)) || !String(att.debate_id).startsWith(`debate-${att.ticket}-`)) {
    add('debate_attestation_invalid', 'debate_id must be `debate-<ticket>-<yyyymmddThhmmZ>` with a safe ticket key');
  }
  if (D && D.debate_id !== att.debate_id) add('debate_attestation_invalid', `the ${DISPO_TOKEN} line names debate ${D.debate_id}, not the attestation's ${att.debate_id}`);
  const outcome = att.outcome;
  if (outcome === 'LIMIT_REACHED') { add('debate_limit_unsupported', 'LIMIT_REACHED is reserved and unsupported until an authenticated telemetry source exists (F-105-1): a debate that stopped for any reason is UNRESOLVED (incomplete_review derived from the retained results)'); return done(); }
  if (!DEBATE_OUTCOMES.includes(outcome)) {
    add('debate_outcome_invalid', `outcome ${JSON.stringify(outcome)} is not one of ${DEBATE_OUTCOMES.join(', ')}${outcome === 'DEGRADED' ? ' (a degraded carrier is carrier.degraded, never an outcome)' : ''}`);
    return done();
  }
  base.outcome = outcome;
  if (D && D.outcome !== outcome) add('debate_outcome_invalid', `the ${DISPO_TOKEN} line states outcome ${D.outcome}, but the attestation outcome is ${outcome}`);
  if (Object.hasOwn(att, 'debate_qualified')) add('debate_outcome_invalid', 'an attestation never declares debate_qualified: the checker computes it');
  const host = isObject(att.host) ? att.host : {};
  const carrier = isObject(att.carrier) ? att.carrier : {};
  if (!nonEmpty(host.agent) || !nonEmpty(host.identity) || !nonEmpty(carrier.agent) || !nonEmpty(carrier.kind) || !nonEmpty(carrier.identity) || typeof carrier.degraded !== 'boolean') {
    add('debate_carrier_invalid', 'host {agent, identity} and carrier {agent, kind, identity, degraded} are required');
    return done();
  }
  base.carrier = { agent: carrier.agent, kind: carrier.kind, identity: carrier.identity, degraded: carrier.degraded };
  const provider = (id) => String(id).split(':')[0];
  base.diversity = provider(host.identity) === provider(carrier.identity) ? 'same_provider' : 'cross_provider';
  const rounds = asList(att.rounds);
  const findings = asList(att.findings);
  const metrics = isObject(att.metrics) ? att.metrics : {};
  for (const k of ['rounds', 'calls', 'minutes']) if (typeof metrics[k] !== 'number' || metrics[k] < 0) add('debate_attestation_invalid', `metrics.${k} must be a number >= 0`);
  for (const k of ['started_at', 'ended_at']) if (metrics[k] !== null && !(typeof metrics[k] === 'string' && realInstant(metrics[k]))) add('debate_attestation_invalid', `metrics.${k} must be an ISO-8601 instant or null`);
  if (att.limit !== null && att.limit !== undefined) add('debate_limit_unsupported', 'a limit record is not supported: LIMIT_REACHED is reserved until an authenticated telemetry source exists (F-105-1); a debate that stopped is UNRESOLVED');
  if (att.budget !== undefined) add('debate_limit_unsupported', 'a budget record is not supported: the 5-round / 45-minute checkpoint is telemetry and never stops a debate');
  if (rounds.length > 64) { add('debate_attestation_invalid', `the attestation records ${rounds.length} rounds; at most 64 attempted rounds are allowed`); return done(); }
  const tooBig = evidenceSizeProblem(rounds, bundleDir);
  if (tooBig) { add('debate_evidence_mismatch', tooBig); return done(); }
  // ---- carrier: a transport label, never an outcome; Fable or any substitute only as the declared degraded carrier
  if (!asList(CARRIER_KINDS[carrier.agent]).includes(carrier.kind)) add('debate_carrier_invalid', `carrier ${carrier.agent} cannot use kind ${carrier.kind}`);
  if (!carrier.degraded && (carrier.agent !== PAIRED[host.agent] || base.diversity === 'same_provider')) {
    add('debate_carrier_invalid', `a ${host.agent} host pairs with ${PAIRED[host.agent] ?? 'its configured counterpart'}; any substitute (Fable or a same-provider session) is carrier.degraded: true`);
  }
  if (D && D.carrier_degraded !== carrier.degraded) add('debate_carrier_invalid', `the ${DISPO_TOKEN} line disagrees with the attestation carrier.degraded`);
  if (att.carrier.degraded && !(D?.carrier_degraded === true && D.degradation_ack === DEGRADED_ACK)) add('debate_degradation_unacknowledged', `a degraded carrier needs the frozen acknowledgement in the ${DISPO_TOKEN} line`);
  if (carrier.kind !== 'native_session') {
    if (!(typeof att.workdir === 'string' && isAbsolute(att.workdir))) add('debate_attestation_invalid', 'workdir (the directory the relay ran in) must be an absolute path');
    else bindWorkdir(att, repo, add);
  }
  // ---- rounds and their retained evidence
  const seen = new Set();
  const completedNumbers = new Set();
  const perRound = new Map();
  const store = new Map(); // bundle-relative path -> { bytes } | { code, why }: each distinct file is read and hashed once
  rounds.forEach((r, i) => {
    if (!isObject(r) || r.n !== i + 1) { add('debate_attestation_invalid', `round ${i + 1} is not an object numbered n: ${i + 1}`); return; }
    if (!ROUND_STATUS.includes(r.status)) { add('debate_attestation_invalid', `round ${r.n} status ${JSON.stringify(r.status)} is not one of ${ROUND_STATUS.join(', ')}`); return; }
    if (!SAFE_SEGMENT.test(String(r.request_id))) add('debate_attestation_invalid', `round ${r.n} needs a safe request_id`);
    if (seen.has(r.request_id)) add('debate_request_mismatch', `round ${r.n} reuses request_id ${r.request_id} (a replayed request)`);
    seen.add(r.request_id);
    perRound.set(r.n, verifyRound(r, att, bundleDir, add, store));
    if (r.status === 'completed') completedNumbers.add(r.n);
  });
  // ---- the canonical ledger: derived from the response objects; the attestation ledger must equal it
  const ledger = deriveLedger(rounds, perRound, add);
  const attById = new Map();
  for (const f of findings) {
    if (!isObject(f) || !nonEmpty(f.id) || !SEVERITIES.includes(f.severity) || !['open', 'resolved'].includes(f.status)) { add('debate_attestation_invalid', `finding ${JSON.stringify(f?.id)} needs id, severity (${SEVERITIES.join('|')}) and status (open|resolved)`); continue; }
    if (attById.has(f.id)) add('debate_attestation_invalid', `finding ${f.id} appears twice in the attestation ledger`);
    attById.set(f.id, f);
  }
  for (const [id, d] of ledger) {
    const f = attById.get(id);
    const same = f && f.severity === RANK_NAME[d.rank] && f.status === (d.open ? 'open' : 'resolved') && (d.open || (f.closed_by === 'counterpart' && f.closed_round === d.closed_round));
    if (!same) add('debate_attestation_invalid', `the attestation ledger entry for ${id} does not equal the ledger derived from the response objects (${RANK_NAME[d.rank]}, ${d.open ? 'open' : `closed in round ${d.closed_round}`})`);
  }
  for (const id of attById.keys()) if (!ledger.has(id)) add('debate_attestation_invalid', `the attestation ledger holds ${id}, which no verified response object opened`);
  const open = [...ledger].filter(([, d]) => d.open);
  base.outstanding = open.map(([id]) => id);
  const last = rounds.at(-1);
  // incomplete_review is DERIVED: the last round has no retained relay result, or a failed one (status not completed, or exit not 0)
  const lastRelay = isObject(last) ? perRound.get(last.n)?.relay : null;
  const derivedIncomplete = isObject(last) && (!lastRelay || lastRelay.status !== 'completed' || lastRelay.exitCode !== 0);
  if ((att.incomplete_review === true) !== derivedIncomplete) add('debate_attestation_invalid', `incomplete_review must be ${derivedIncomplete}, as derived from the retained result of the last round`);
  const final = att.final;
  // ---- outcomes (independent of the carrier)
  if (outcome === 'CONVERGED') {
    if (!isObject(final) || final.verdict !== 'AGREE') add('debate_outcome_invalid', 'CONVERGED needs final {request_id, plan_version, plan_digest, verdict: AGREE}');
    else {
      if (final.plan_digest !== digest) add('debate_digest_mismatch', `the final AGREE confirms ${final.plan_digest}, but the frozen narrative digest is ${digest} (edited after the confirmation, or another plan)`);
      if (att.plan_digest !== final.plan_digest) add('debate_attestation_invalid', 'plan_digest and final.plan_digest differ');
      if (!last || last.status !== 'completed' || perRound.get(last.n)?.response?.verdict !== 'AGREE' || last.request_id !== final.request_id || last.plan_version !== final.plan_version || last.plan_digest !== final.plan_digest) {
        add('debate_request_mismatch', 'the final AGREE is not the verified response object of the last round for the same request_id, plan_version and plan_digest');
      }
    }
    if (open.some(([, d]) => d.rank >= RANK.major)) add('debate_open_finding', `CONVERGED with an open blocker or major in the derived ledger: ${open.filter(([, d]) => d.rank >= RANK.major).map(([id]) => id).join(', ')}`);
    if (!['done', 'not_applicable'].includes(att.contract_recheck)) add('debate_outcome_invalid', 'CONVERGED needs contract_recheck done or not_applicable (changed-contract compatibility rechecked)');
    if (att.incomplete_review === true) add('debate_outcome_invalid', 'CONVERGED is never an incomplete review');
  } else {
    if (att.plan_digest !== digest) add('debate_digest_mismatch', `the attestation binds ${att.plan_digest}, but the frozen narrative digest is ${digest}`);
    if (outcome === 'UNRESOLVED' && att.incomplete_review === true) {
      const relay = last ? perRound.get(last.n)?.relay : null;
      if (!relay) add('debate_outcome_invalid', 'an incomplete review needs the retained relay result of the failed last attempt');
      else if (relay.status === 'completed' && relay.exitCode === 0) add('debate_outcome_invalid', 'an incomplete review needs a failed last attempt, but its retained relay result says completed with exit 0');
      if (open.some(([id]) => !nonEmpty(attById.get(id)?.host_position) || !nonEmpty(attById.get(id)?.counterpart_position))) add('debate_outcome_invalid', 'every outstanding canonical finding needs both positions');
      if (final !== null && final !== undefined) add('debate_outcome_invalid', 'UNRESOLVED carries no final confirmation');
    } else if (outcome === 'UNRESOLVED') {
      if (!open.length || open.some(([id]) => !nonEmpty(attById.get(id)?.host_position) || !nonEmpty(attById.get(id)?.counterpart_position))) add('debate_outcome_invalid', 'UNRESOLVED needs at least one outstanding canonical finding, each with both positions');
      if (!completedNumbers.size) add('debate_outcome_invalid', 'UNRESOLVED needs at least one verified counterpart response; a debate that stopped on a failure is UNRESOLVED with incomplete_review');
      if (final !== null && final !== undefined) add('debate_outcome_invalid', 'UNRESOLVED carries no final confirmation');
    } else if (outcome === 'SKIPPED') {
      if (rounds.length || findings.length || (final !== null && final !== undefined)) add('debate_outcome_invalid', 'SKIPPED records no round, finding or confirmation');
      if (!exceptionOk(D, 'SKIPPED')) add('debate_exception_missing', `SKIPPED needs the owner exception in the ${DISPO_TOKEN} line: {kind: SKIPPED, a reason, scope: this ticket and the exact acknowledgement}`);
    }
  }
  const byId = new Map(asList(D?.dispositions).map((row) => [row.id, row]));
  const needsLimit = outcome === 'UNRESOLVED' && att.incomplete_review === true;
  const need = [...base.outstanding, ...(needsLimit ? [LIMIT_ID] : [])];
  base.pending = outcome === 'CONVERGED' || outcome === 'SKIPPED' ? [] : need.filter((id) => dispositionProblem(id, byId.get(id), D, rounds, digest));
  base.debate_qualified = outcome === 'CONVERGED' && errors.length === 0;
  const m = (k, v) => (v === null || v === undefined ? [] : [`${k}=${v}`]);
  base.run_log_metrics = [...m('debate_outcome', outcome.toLowerCase()), ...m('debate_carrier', carrier.agent), ...m('debate_carrier_degraded', carrier.degraded),
    ...m('debate_rounds', metrics.rounds), ...m('debate_calls', metrics.calls), ...m('debate_minutes', metrics.minutes),
    ...m('plan_debate_started_at', metrics.started_at), ...m('plan_debate_ended_at', metrics.ended_at), ...(typeof metrics.tokens === 'number' ? [`debate_tokens=${metrics.tokens}`] : [])];
  return done({ attestation: att, line: got.line, byId, D, rounds, needsLimit });
}

/**
 * One round's retained evidence, by carrier kind. Failed or limited attempts keep their actual status; a success is
 * never fabricated: a completed relay round needs exit code 0 in the record and the result, every round is read-only,
 * and a completed round carries a non-empty session id bound to the result. Its response is the counterpart-response-v1
 * object, bound to the round's request_id, plan_version and plan_digest (also those of the brief that was sent).
 * Returns { diag, response }.
 */
function verifyRound(r, att, bundleDir, add, store = new Map()) {
  const out = { relay: null, response: null };
  const kind = att.carrier.kind;
  const files = isObject(r.files) ? r.files : {};
  const hashes = isObject(r.sha256) ? r.sha256 : {};
  if (r.read_only !== true) add('debate_carrier_invalid', `round ${r.n} is not recorded read_only: true`);
  if (r.status === 'completed' && !nonEmpty(r.session_id)) add('debate_carrier_invalid', `round ${r.n}: a completed round needs its non-empty session or thread id`);
  const read = (name) => {
    const rel = files[name];
    if (!relativeEvidence(rel)) { add('debate_attestation_invalid', `round ${r.n} ${name}: evidence paths are bundle-relative (no absolute path, no ..); out_dir is provenance only`); return null; }
    if (!bundleDir) { add('debate_evidence_missing', `round ${r.n} ${name}: no bundle root to resolve ${rel}`); return null; }
    if (!store.has(rel)) { const e = evidenceBytes(bundleDir, rel); store.set(rel, e.bytes ? { bytes: e.bytes, hash: sha256Of(e.bytes) } : e); }
    const e = store.get(rel);
    if (!e.bytes) { add(e.code, `round ${r.n} ${name}: ${e.why}`); return null; }
    if (e.hash !== hashes[name]) add('debate_evidence_mismatch', `round ${r.n} ${name}: ${rel} does not match its recorded sha256`);
    return e.bytes;
  };
  const unknown = Object.keys(files).filter((n) => !EVIDENCE_NAMES.includes(n));
  if (unknown.length) add('debate_attestation_invalid', `round ${r.n} files holds ${unknown.length} unknown evidence name(s) (${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? ', ...' : ''}): only ${EVIDENCE_NAMES.join(', ')}; none is read`);
  const need = r.status !== 'completed' ? [] : kind === 'native_session' ? ['message'] : ['brief', 'result', 'events'];
  for (const n of need) if (!files[n]) add('debate_evidence_missing', `round ${r.n} is ${r.status} but has no ${n} evidence file`);
  const got = Object.fromEntries(EVIDENCE_NAMES.filter((n) => Object.hasOwn(files, n)).map((n) => [n, read(n)]));
  if (r.status !== 'completed' && !files.result && !files.message) {
    const e = r.dispatch_error;
    if (!(isObject(e) && nonEmpty(e.class) && nonEmpty(e.text))) add('debate_evidence_missing', `round ${r.n} (${r.status}) has neither a result file nor dispatch-failure evidence {class, text}`);
  }
  const expect = { request_id: r.request_id, plan_version: r.plan_version, plan_digest: r.plan_digest };
  let parsed = null;
  if (got.result) {
    let res;
    try { res = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(got.result)); } catch { add('debate_evidence_mismatch', `round ${r.n}: result.json is not UTF-8 JSON`); return out; }
    const shape = relayShapeProblem(res);
    if (shape) { add('debate_evidence_mismatch', `round ${r.n}: ${shape}`); return out; }
    out.relay = { status: res.status, exitCode: res.exitCode };
    const status = /_unavailable$/.test(String(res.status)) ? 'unavailable' : res.status;
    if (status !== r.status) add('debate_evidence_mismatch', `round ${r.n} records ${r.status}, but the relay result says ${res.status}`);
    if (res.exitCode !== r.exit_code) add('debate_evidence_mismatch', `round ${r.n} records exit ${r.exit_code}, the relay result says ${res.exitCode}`);
    if (r.status === 'completed' && (r.exit_code !== 0 || res.exitCode !== 0)) add('debate_evidence_mismatch', `round ${r.n}: a completed round needs exit code 0 in the record and in the relay result`);
    if (kind === 'codex_relay') {
      if (r.status === 'completed' && res.threadId !== r.session_id) add('debate_carrier_invalid', `round ${r.n}: thread ${res.threadId} answered, not ${r.session_id}`);
      if (res.sandbox !== 'read-only') add('debate_carrier_invalid', `round ${r.n}: the relay ran with sandbox ${res.sandbox}, not read-only`);
    } else if (kind === 'claude_relay') {
      if (r.status === 'completed' && res.sessionId !== r.session_id) add('debate_carrier_invalid', `round ${r.n}: session ${res.sessionId} answered, not ${r.session_id}`);
      if (res.readOnly !== true) add('debate_carrier_invalid', `round ${r.n}: the Claude relay did not run read-only`);
      if (r.auth_method !== 'claude.ai') add('debate_carrier_invalid', `round ${r.n}: the Claude relay needs verified subscription authentication (authMethod claude.ai), not ${r.auth_method}`);
    }
    if (resolve(String(res.workdir)) !== resolve(String(att.workdir))) add('debate_carrier_invalid', `round ${r.n}: the relay ran in ${res.workdir}, not the debate workdir ${att.workdir}`);
    if (r.status === 'completed') parsed = parseResponse(typeof res.finalMessage === 'string' ? res.finalMessage : null, expect);
  } else if (got.message && r.status === 'completed') {
    parsed = parseResponseBytes(got.message, expect);
    out.relay = { status: 'completed', exitCode: 0 };
  }
  if (got.brief) {
    const b = briefFields(got.brief.toString('utf8'));
    if (b.request_id !== r.request_id || b.plan_version !== r.plan_version || b.plan_digest !== r.plan_digest) {
      add('debate_request_mismatch', `round ${r.n}: the brief that was sent carries request_id ${b.request_id}, plan_version ${b.plan_version}, plan_digest ${b.plan_digest}`);
    }
  }
  if (!parsed) return out;
  if (!parsed.ok) { add(parsed.code, `round ${r.n}: ${parsed.why}`); return out; }
  if (parsed.obj.verdict !== r.verdict) add('debate_attestation_invalid', `round ${r.n} records verdict ${r.verdict}, the response object says ${parsed.obj.verdict}`);
  out.response = parsed.obj;
  return out;
}

/**
 * Why a relay result.json cannot be read safely, or null: an object of bounded depth (checked iteratively) whose read
 * fields have scalar types (status, workdir strings; exitCode a number or null; thread and session ids strings or null;
 * readOnly a boolean; finalMessage, error, versions and timestamps strings when present). Checked before any coercion.
 */
function relayShapeProblem(res) {
  if (!isObject(res)) return 'result.json is not a JSON object';
  const bounds = jsonBoundsProblem(res);
  if (bounds) return `result.json is out of bounds: ${bounds}`;
  const optStr = (v) => v === undefined || v === null || typeof v === 'string';
  if (typeof res.status !== 'string') return 'result.json status is not a string';
  if (!(res.exitCode === null || res.exitCode === undefined || (Number.isInteger(res.exitCode) && res.exitCode >= 0))) return 'result.json exitCode is not a non-negative integer';
  if (!optStr(res.workdir)) return 'result.json workdir is not a string';
  for (const k of ['sandbox', 'threadId', 'sessionId', 'finalMessage', 'error', 'codexVersion', 'claudeVersion', 'startedAt', 'finishedAt']) if (!optStr(res[k])) return `result.json ${k} is not a string`;
  if (!(res.readOnly === undefined || typeof res.readOnly === 'boolean')) return 'result.json readOnly is not a boolean';
  return null;
}

/** PREAPPROVAL: `debate-check`, run at PLAN preflight on the frozen plan before ExitPlanMode. `repo` binds the relay workdir. */
export function debateCheck(planText, { bundleDir = null, repo = null } = {}) {
  const v = verifyDebate(planText, { bundleDir, repo });
  return {
    ok: v.ok, phase: 'preapproval', outcome: v.outcome, debate_qualified: v.debate_qualified, presentable: v.ok, outstanding: v.outstanding, pending: v.pending,
    carrier: v.carrier, diversity: v.diversity, attestation_sha256: v.attestation_sha256, digest: v.digest, run_log_metrics: v.run_log_metrics, errors: v.errors, warnings: v.warnings,
  };
}

/**
 * POSTAPPROVAL: the debate fields of a START, for NEW runs. A plan without `debate_policy` is legacy only when approved
 * before DEBATE_POLICY_CUTOFF (host-trust residual: approved_at is written by the host, as with SECURITY_POLICY_CUTOFF);
 * a `debate_policy: 2` plan needs START.debate_attestation_sha256, the unchanged attestation line, the self-contained
 * retained bundle (never the original scratch paths) and, unless CONVERGED or SKIPPED, a disposition that authorizes for
 * every outstanding canonical finding in the approved digest.
 */
function debateStartCheck(planText, start, { bundleDir, repo, digest, add }) {
  let added = 0;
  const put = (code, message) => { added += 1; add(code, message); };
  const policy = debatePolicy(narrativeOf(planText));
  if (policy.count === 0) {
    if (!debateLegacyApproval(start)) add('debate_policy_missing', `a plan approved from ${DEBATE_POLICY_CUTOFF} on must carry debate_policy: 2; omission is never an implicit legacy fallback`);
    return;
  }
  if (policy.value !== '2') { put('debate_policy_missing', policy.count > 1 ? 'the plan header holds more than one debate_policy line' : `debate_policy ${policy.value} is unknown (expected 2)`); return; }
  if (!nonEmpty(start.debate_attestation_sha256)) { put('debate_attestation_missing', 'START has no debate_attestation_sha256 (the attestation hash stated at ExitPlanMode)'); return; }
  const got = readAttestation(planText);
  if (!got.ok) { put(got.error.code, got.error.message); return; }
  if (start.debate_attestation_sha256 !== got.sha256) add('debate_attestation_changed', `the plan's attestation line hashes ${got.sha256}, not the approved ${start.debate_attestation_sha256}`);
  if (start.debate_attestation_sha256 !== got.sha256) added += 1;
  if (added) return;
  if (!bundleDir) { put('debate_evidence_missing', 'no retained debate bundle: run `brief.mjs debate-retain` after approval and pass --repo to start-check'); return; }
  const loc = locatorProblem(bundleDir);
  if (loc) { put(loc.code, `the retained locator: ${loc.why}`); return; }
  const want = Buffer.from(got.line, 'utf8');
  const lineFile = evidenceBytes(bundleDir, 'attestation.line', want.length);
  if (!lineFile.bytes) { put(lineFile.code, `the retained bundle's attestation.line: ${lineFile.why}`); return; }
  if (!lineFile.bytes.equals(want)) { put('debate_evidence_mismatch', 'the retained attestation.line is not byte-identical to the plan line'); return; }
  const v = verifyDebate(planText, { bundleDir, repo });
  for (const e of v.errors) put(e.code, e.message);
  if (added || v.outcome === 'CONVERGED' || v.outcome === 'SKIPPED') return;
  const need = [...v.outstanding, ...(v.needsLimit ? [LIMIT_ID] : [])];
  for (const id of need) {
    const p = dispositionProblem(id, v.byId.get(id), v.D, v.rounds, digest);
    if (p) add(p[0], p[1]);
  }
}

/**
 * Copy the bundle an attestation references byte-for-byte from `from` (the scratch bundle root) to `to` (the retained
 * locator under `root`, the git common dir), after verifying it against `repo`. Every destination component below
 * `root` is checked with lstat and created one level at a time; a symbolic link or non-directory there is refused, files
 * are created exclusively in a temporary sibling that is then renamed into place, and an existing retained bundle is
 * accepted only when byte-identical and self-contained; it is never overwritten. Returns { ok, retained, errors }.
 */
export function retainBundle(planText, { from, to, root = null, repo = null }) {
  const refuse = (code, message) => ({ ok: false, retained: null, errors: [{ code, message }] });
  const v = verifyDebate(planText, { bundleDir: from, repo });
  if (v.errors.length) return { ok: false, retained: null, errors: v.errors };
  const files = [...new Set(evidencePaths(v.attestation))];
  const line = Buffer.from(v.line, 'utf8');
  const top = root ?? resolve(to, '..', '..', '..', '..', '..');
  const rel = relative(top, to);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return refuse('debate_evidence_missing', 'the retained locator is not below the git common dir');
  const parts = rel.split(sep);
  let p = top;
  try {
    const rootStat = lstatSync(top);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return refuse('debate_evidence_mismatch', `the git common dir ${top} is a symbolic link or not a directory`);
    for (const part of parts.slice(0, -1)) {
      p = join(p, part);
      let st = null;
      try { st = lstatSync(p); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (st && (st.isSymbolicLink() || !st.isDirectory())) return refuse('debate_evidence_mismatch', `${p} is a symbolic link or not a directory; the retained locator is never followed through one`);
      if (!st) mkdirSync(p);
    }
  } catch (err) { return refuse('debate_evidence_missing', `creating the retained locator failed (${err.code ?? err.message}): WAIT_FOR_USER`); }
  const same = (dir) => {
    const lf = evidenceBytes(dir, 'attestation.line', line.length);
    if (!lf.bytes || !lf.bytes.equals(line)) return false;
    return files.every((f) => { const a = evidenceBytes(dir, f), b = evidenceBytes(from, f); return Boolean(a.bytes && b.bytes) && a.bytes.equals(b.bytes); });
  };
  let existing = null;
  try { existing = lstatSync(to); } catch (err) { if (err.code !== 'ENOENT') return refuse('debate_evidence_missing', `cannot inspect ${to} (${err.code})`); }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) return refuse('debate_evidence_mismatch', `${to} is a symbolic link or not a directory; it is never followed or overwritten`);
    return same(to) ? { ok: true, retained: to, errors: [] } : refuse('debate_evidence_mismatch', `a different bundle is already retained at ${to}; it is never overwritten`);
  }
  const tmp = `${to}.tmp-${process.pid}`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    for (const f of files) {
      let d = tmp;
      for (const part of f.split('/').slice(0, -1)) { d = join(d, part); if (!existsSync(d)) mkdirSync(d); }
      copyFileSync(join(from, f), join(tmp, f), fsConstants.COPYFILE_EXCL); // f is bundle-relative with forward slashes; join normalises them
    }
    writeFileSync(join(tmp, 'attestation.line'), line, { flag: 'wx' });
    if (!same(tmp)) throw new Error('the copy is not byte-identical');
    renameSync(tmp, to);
    if (locatorProblem(to) || !same(to)) throw new Error('the retained bundle does not verify after the rename');
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    return refuse('debate_evidence_missing', `retaining the bundle failed (${err.code ?? err.message}): WAIT_FOR_USER, never a START without the retained evidence`);
  }
  return { ok: true, retained: to, errors: [] };
}

/** `<git-common-dir>` of `repo` as an absolute path, or null. */
function gitCommonDir(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', env: gitEnv() });
  return r.status === 0 && r.stdout.trim() ? resolve(repo, r.stdout.trim()) : null;
}
/** The retained bundle directory (and its git common dir root) for the plan's attestation under `repo`, or null. */
function retainedDirFor(planText, repo) {
  const got = readAttestation(planText);
  if (!got.ok) return null;
  const common = gitCommonDir(repo);
  if (!common) return null;
  try { return { root: common, dir: debateLocator(common, got.attestation.ticket, got.attestation.debate_id) }; } catch { return null; }
}

// ---- PLAN carrier probe (F) ------------------------------------------------------------------------------------------
const COVERAGE_PASS = 'candidate identity and untracked-content hash unchanged; ignored files out of coverage';
const errorClass = (code) => (code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : code === 'ENOENT' ? 'provider' : 'relay');
const spawnClass = (code) => (code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'relay');
function resultClass(res) {
  if (!res) return 'relay';
  if (/_unavailable$/.test(String(res.status))) return 'provider';
  const text = `${res.error ?? ''} ${res.finalMessage ?? ''}`;
  if (/\b(401|unauthori[sz]ed|not logged in|log in|login|auth\w*)\b/i.test(text)) return 'auth';
  if (/\b(429|quota|rate.?limit\w*|usage limit)\b/i.test(text)) return 'provider';
  if (/\b(EPERM|EACCES|permission denied|operation not permitted)\b/i.test(text)) return 'permission_denied';
  return 'relay';
}

/**
 * Classify the PLAN-start probe's observations into the plan header's `codex_route`: dispatch, fresh_result, resume,
 * cancellation and coverage, each pass or fail with a failure class (permission_denied | auth | provider | relay). Pure.
 * Carrier-specific (`o.carrier`): the Codex relay binds `threadId` and `sandbox: read-only` and checks `codex login
 * status`; the Claude relay binds `sessionId` and `readOnly: true` and needs `claude auth status` with authMethod
 * claude.ai. A dispatch that fails before a child process starts is a dispatch failure, and a failed process listing is
 * a failure, never a cancellation pass.
 */
/** The binding of the probe's no-op dispatch: a counterpart-response-v1 AGREE for a request_id derived from the nonce. */
const probeExpect = (nonce) => ({ request_id: `probe-${nonce}`, plan_version: 'v1', plan_digest: `sha256:${'0'.repeat(64)}` });
export function classifyProbe(o) {
  const pass = (detail) => ({ result: 'pass', detail });
  const no = (cls, detail) => ({ result: 'fail', class: cls, detail });
  const claude = o.carrier === 'claude';
  const bin = claude ? 'claude' : 'codex';
  const cli = o.cli_version ?? o.codex_version;
  const idOf = (res) => (claude ? res?.sessionId : res?.threadId);
  const readOnly = (res) => (claude ? res?.readOnly === true : res?.sandbox === 'read-only');
  const safe = (x) => (x?.result && relayShapeProblem(x.result) ? { ...x, result: null } : x);
  const d = safe(o.dispatch) ?? {};
  let dispatch;
  if (!o.relay_present) dispatch = no('relay', 'the relay script is missing or unreadable');
  else if (cli?.error) dispatch = no(errorClass(cli.error), `${bin} --version could not run (${cli.error})`);
  else if (cli?.status !== 0) dispatch = no('provider', `${bin} --version failed`);
  else if (o.login?.error) dispatch = no(errorClass(o.login.error), `${bin} authentication status could not run (${o.login.error})`);
  else if (o.login?.status !== 0) dispatch = no('auth', `${bin} authentication status reports no usable login`);
  else if (claude && o.login.authMethod !== 'claude.ai') dispatch = no('auth', `claude auth status reports authMethod ${o.login.authMethod ?? 'unknown'}, not the claude.ai subscription`);
  else if (d.spawn_error) dispatch = no(spawnClass(d.spawn_error), `the relay could not be started (${d.spawn_error})`);
  else if (!d.result) dispatch = no('relay', 'the relay wrote no readable result.json');
  else if (d.result.status !== 'completed') dispatch = no(resultClass(d.result), `the no-op read-only dispatch ended ${d.result.status}`);
  else if (cli && Object.hasOwn(cli, 'version') && !nonEmpty(cli.version)) dispatch = no('provider', `${cli.path ?? bin} --version printed no version: an unknown CLI fails closed`);
  else if (nonEmpty(cli?.version) && String(d.result[claude ? 'claudeVersion' : 'codexVersion'] ?? '').trim() !== cli.version) {
    dispatch = no('relay', `the relay ran ${bin} ${d.result[claude ? 'claudeVersion' : 'codexVersion'] ?? '(no version reported)'}, not the probed ${cli.path ?? bin} (${cli.version})`);
  } else dispatch = pass('read-only no-op dispatch from the repository root completed with the probed CLI');
  const reached = dispatch.result === 'pass';
  const notReached = () => no(dispatch.class, `not reached: dispatch failed (${dispatch.class})`);
  const id = idOf(d.result);
  const fresh_result = !reached ? notReached()
    : nonEmpty(id) && readOnly(d.result) && parseResponse(typeof d.result.finalMessage === 'string' ? d.result.finalMessage : null, probeExpect(o.nonce)).obj?.verdict === 'AGREE' ? pass(`readable result.json, status completed, read-only, new ${claude ? 'sessionId' : 'threadId'} ${id}`)
      : no('relay', `result.json lacks a ${claude ? 'sessionId' : 'threadId'}, is not read-only, or does not answer this probe's nonce`);
  const rs = safe(o.resume) ?? {};
  const resume = fresh_result.result !== 'pass' ? no(fresh_result.class, 'not reached: no fresh result to resume')
    : rs.spawn_error ? no(spawnClass(rs.spawn_error), `the resume could not be started (${rs.spawn_error})`)
      : !rs.result ? no('relay', 'the resume wrote no readable result.json')
        : rs.result.status !== 'completed' ? no(resultClass(rs.result), `the resume ended ${rs.result.status}`)
          : !readOnly(rs.result) ? no('relay', 'the resumed session is not read-only')
            : idOf(rs.result) !== id ? no('relay', `the resume returned ${idOf(rs.result)}, not ${id}`)
            : pass(`--session ${id} returned the same session`);
  const c = safe(o.cancel) ?? {};
  const cancellation = !reached ? notReached()
    : claude ? { result: 'not_applicable_for_carrier', detail: 'the Claude relay exposes only Read, Glob and Grep, so a shell busy brief cannot exercise its watchdog: cancellation is unverified for this carrier, never a pass' }
    : c.spawn_error ? no(spawnClass(c.spawn_error), `the busy dispatch could not be started (${c.spawn_error})`)
      : c.listing_failed ? no('relay', 'the process listing (ps) failed: the child process group cannot be verified, so cancellation is unproven, never a pass')
        : !c.child_seen ? no(c.result ? resultClass(c.result) : 'relay', 'no child process was observed: the relay returned before a child started, which is a dispatch failure, never a cancellation pass')
          : c.result?.status !== 'timeout' ? no('relay', `the busy dispatch ended ${c.result?.status ?? 'without a result'}, not timeout: the watchdog was not exercised`)
            : asList(c.survivors).length ? no('relay', `the child process group survived the timeout (pgid ${asList(c.survivors).join(', ')})`)
              : pass('the child started, the relay reported status timeout and the child process group was verified terminated');
  const cv = o.coverage ?? {};
  const coverage = cv.error ? no('relay', `coverage could not be computed: ${cv.error}`)
    : nonEmpty(cv.before) && cv.before === cv.after && cv.ignored_before === cv.ignored_after ? pass(COVERAGE_PASS)
      : no('relay', 'the candidate identity (tracked diff, untracked content, modes, symlinks) or the ignored-file listing changed during the probe');
  return { dispatch, fresh_result, resume, cancellation, coverage };
}

/** Candidate identity (the repository's own candidate-id.mjs) plus the `git status --porcelain --ignored` listing hash. */
function coverageSnapshot(repo) {
  const cid = spawnSync(process.execPath, [fileURLToPath(new URL('./candidate-id.mjs', import.meta.url)), '--repo', repo, '--base', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
  if (cid.status !== 0) return { error: `candidate-id.mjs failed: ${String(cid.stderr).trim()}` };
  const st = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--ignored', '-z'], { maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
  if (st.status !== 0) return { error: 'git status --porcelain --ignored failed' };
  try { return { candidate: JSON.parse(cid.stdout).candidate_id, ignored: sha256Of(st.stdout) }; } catch { return { error: 'candidate-id.mjs printed no candidate_id' }; }
}

/** Process rows (pid, ppid, pgid) from `ps`, POSIX only; null when the listing is unavailable or fails (cancellation then fails). */
function processRows() {
  if (process.platform === 'win32') return null;
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
  if (r.status !== 0 || r.error) return null;
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 3 && a.every(Number.isFinite));
}

/** Relays (and the foreign process groups their children lead) the probe is running, so a signal or the outer timeout can stop them. */
const ACTIVE_RELAYS = new Set();
function stopActiveRelays() {
  for (const a of ACTIVE_RELAYS) {
    const rows = processRows() ?? [];
    for (const [, ppid, pgid] of rows) if (ppid === a.pid && a.foreign(pgid)) a.groups.add(pgid);
    for (const g of a.groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }
    try { if (process.platform === 'win32') a.child.kill('SIGKILL'); else process.kill(-a.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/**
 * Run the relay once with `args`, the brief on stdin; with `watch`, observe its child process group. The relay runs in
 * its own process group (detached on POSIX), so its ordinary helpers (`codex --version`, `git status`) share the relay's
 * group and are not mistaken for the cancellation target; only a child leading ANOTHER group (the relay's detached
 * child) counts. The probe never signals its own group; a failed listing is recorded, never read as "no survivors".
 */
function relayRun({ relay, repo, env }, args, brief, { watch = false } = {}) {
  return new Promise((done) => {
    const outDir = args[args.indexOf('--out-dir') + 1];
    const obs = { spawn_error: null, result: null, child_seen: false, survivors: [], listing_failed: false };
    const rows0 = processRows();
    const own = rows0?.find(([pid]) => pid === process.pid)?.[2] ?? null;
    if (watch && rows0 === null) obs.listing_failed = true;
    let child;
    try { child = spawn(process.execPath, [relay, ...args], { cwd: repo, env, stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' }); } catch (err) { obs.spawn_error = err.code ?? 'spawn'; done(obs); return; }
    const foreign = (pgid) => pgid !== own && pgid !== child.pid && pgid !== process.pid && pgid > 1;
    const active = { pid: child.pid, child, groups: new Set(), foreign };
    ACTIVE_RELAYS.add(active);
    const timer = watch ? setInterval(() => {
      const rows = processRows();
      if (rows === null) { obs.listing_failed = true; return; }
      for (const [, ppid, pgid] of rows) if (ppid === child.pid && foreign(pgid)) { active.groups.add(pgid); obs.child_seen = true; }
    }, 100) : null;
    child.on('error', (err) => { obs.spawn_error = err.code ?? 'spawn'; });
    child.stdin.on('error', () => {});
    child.stdin.end(brief);
    child.on('close', () => {
      if (timer) clearInterval(timer);
      ACTIVE_RELAYS.delete(active);
      try { obs.result = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8')); } catch { obs.result = null; }
      if (watch) {
        const rows = processRows();
        if (rows === null) obs.listing_failed = true;
        const alive = new Set((rows ?? []).map(([, , pgid]) => pgid));
        obs.survivors = [...active.groups].filter((g) => foreign(g) && alive.has(g));
        for (const g of active.groups) { if (foreign(g)) { try { process.kill(-g, 'SIGKILL'); } catch { /* already gone */ } } }
      }
      done(obs);
    });
  });
}

/** The first executable regular file `name` on `pathList` (absolute directories only), or null. */
function onPath(name, pathList) {
  for (const dir of String(pathList ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
    try { const st = statSync(p); if (st.isFile() && (process.platform === 'win32' || (st.mode & 0o111))) return p; } catch { /* next */ }
  }
  return null;
}

const DURATION = /^(\d+)(s|m)$/;
const durationMs = (v, fallback) => { const m = DURATION.exec(String(v)); return m ? Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000) : fallback; };

/**
 * The PLAN-start probe. Run it in the actual native Plan Mode context; it writes only under --out-dir (the session
 * scratch directory) and changes nothing in the repository (coverage proves that bounded claim). `carrier` is the
 * selected counterpart's relay: codex (Claude host) or claude (Codex host). SIGINT, SIGTERM and the outer timeout stop
 * the relay's own process group and its observed child groups before the probe exits. It cannot detect whether it runs
 * inside Plan Mode or whether --relay is the real delegate relay: `relay_kind_verified` is always false, and a fake relay
 * proves only this parser.
 */
export async function runProbe({ relay, repo, outDir, carrier = 'codex', cli = null, busyTimeout = '30s', probeTimeout = '20m' }) {
  const claude = carrier === 'claude';
  const env = { ...process.env };
  if (claude) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  // One executable, pinned: an absolute --cli, else the first match on PATH, resolved once. Its directory is put first
  // on the relay's PATH so the relay (which resolves the CLI through PATH) runs this same file; the version it reports
  // is compared with this one.
  const name = claude ? 'claude' : 'codex';
  const cliPath = cli ?? onPath(name, env.PATH);
  if (cliPath) env.PATH = `${dirname(cliPath)}${delimiter}${env.PATH ?? ''}`;
  const bin = cliPath ?? name;
  const nonce = createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12);
  const obs = { carrier, nonce };
  let outerFired = false;
  const onSignal = (sig) => { stopActiveRelays(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', stopActiveRelays);
  const outer = setTimeout(() => { outerFired = true; stopActiveRelays(); }, durationMs(probeTimeout, 20 * 60_000));
  try {
    try { obs.relay_present = statSync(relay).isFile(); } catch { obs.relay_present = false; }
    const probeCmd = (args) => { const r = spawnSync(bin, args, { cwd: repo, encoding: 'utf8', timeout: 30_000, env }); return r.error ? { error: r.error.code ?? 'spawn' } : { status: r.status, stdout: r.stdout }; };
    obs.cli_version = cliPath ? probeCmd(['--version']) : { error: 'ENOENT' };
    if (obs.cli_version.status === 0) Object.assign(obs.cli_version, { version: String(obs.cli_version.stdout).trim(), path: cliPath });
    if (obs.cli_version.status !== 0) obs.login = { status: null };
    else if (claude) {
      const a = probeCmd(['auth', 'status']);
      let method = null;
      try { method = JSON.parse(a.stdout ?? '').authMethod ?? null; } catch { method = null; }
      obs.login = a.error ? { error: a.error } : { status: a.status, authMethod: method };
    } else { const a = probeCmd(['login', 'status']); obs.login = a.error ? { error: a.error } : { status: a.status }; }
    const before = coverageSnapshot(repo);
    const want = probeExpect(nonce);
    const noop = `request_id: ${want.request_id}\nplan_version: ${want.plan_version}\nplan_digest: ${want.plan_digest}\n\nThis is a ship-ticket PLAN carrier probe. Do not read, run or change anything. Reply with exactly this one JSON object and nothing else (no prose, no code fence, no whitespace before or after it):\n${JSON.stringify({ v: 1, ...want, verdict: 'AGREE', findings: [] })}\n`;
    const busy = 'This is a ship-ticket cancellation probe. Do not change any file. Run the read-only shell command `sleep 600`, then reply `done`.\n';
    const flags = ['--cd', repo, '--read-only', '--effort', 'high'];
    const authOk = obs.login.status === 0 && (!claude || obs.login.authMethod === 'claude.ai');
    if (obs.relay_present && obs.cli_version.status === 0 && authOk) {
      obs.dispatch = await relayRun({ relay, repo, env }, [...flags, '--timeout', '5m', '--out-dir', join(outDir, 'dispatch')], noop);
      const id = claude ? obs.dispatch.result?.sessionId : obs.dispatch.result?.threadId;
      if (!outerFired && obs.dispatch.result?.status === 'completed' && nonEmpty(id)) obs.resume = await relayRun({ relay, repo, env }, [...flags, '--session', id, '--timeout', '5m', '--out-dir', join(outDir, 'resume')], noop);
      if (!outerFired && !claude) obs.cancel = await relayRun({ relay, repo, env }, [...flags, '--timeout', busyTimeout, '--out-dir', join(outDir, 'cancel')], busy, { watch: true });
    }
    const after = coverageSnapshot(repo);
    obs.coverage = before.error || after.error ? { error: before.error ?? after.error } : { before: before.candidate, after: after.candidate, ignored_before: before.ignored, ignored_after: after.ignored };
    const route = classifyProbe(obs);
    return {
      ok: !outerFired && Object.values(route).every((c) => c.result === 'pass'), carrier, cli_path: cliPath, cli_version: obs.cli_version.version ?? null, codex_route: route, relay_kind_verified: false, outer_timeout: outerFired,
      note: 'whether this ran inside native Plan Mode, and whether --relay is the real delegate relay, is not detectable here: record both; only a real relay inside real Plan Mode is carrier evidence',
    };
  } finally {
    clearTimeout(outer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', stopActiveRelays);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A structured field: a string with no control character (newline included); with `ticks`, no backtick either. */
function checked(field, value, { ticks = false } = {}) {
  if (typeof value !== 'string') throw refuse(field, 'must be a string');
  if (CONTROL.test(value)) throw refuse(field, 'contains a newline or other control character');
  if (ticks && value.includes('`')) throw refuse(field, 'contains a backtick');
  return value;
}
const refuse = (field, why) => Object.assign(new Error(`field ${field} ${why}`), { briefError: true, usage: true });
const checkedList = (field, list, opts) => asList(list).map((v, i) => checked(`${field}[${i}]`, v, opts));

/** Free text (a plan step, a recon answer, notes) as a quotation: every line starts with "> ", so it cannot open a section. */
const quote = (text) => normalise(text).split('\n').map((l) => `> ${l}`);

/** A path field as shown: separators become `/`; an absolute or parent-escaping path shows only its base name. */
function displayPath(p) {
  const posix = String(p).replace(/\\/g, '/');
  return isAbsolute(posix) || /^[A-Za-z]:/.test(posix) || posix.split('/').includes('..') ? basename(posix) : posix;
}

/** The Step cell of the plan's execution DAG row for `id`, or null. */
export function planStep(planText, id) {
  let stepCol = 2;
  for (const raw of normalise(planText).split('\n')) {
    if (!raw.trimStart().startsWith('|')) continue;
    const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const header = cells.findIndex((c) => c.toLowerCase() === 'step');
    if (header >= 0 && cells[0].toLowerCase() === 'id') {
      stepCol = header;
      continue;
    }
    if (cells[0].replace(/`/g, '') === id && cells[stepCol]) return oneLine(cells[stepCol]);
  }
  return null;
}

function reuseLines(recon) {
  if (recon == null) return ['none recorded'];
  const answers = Array.isArray(recon) ? recon : asList(recon.answers);
  if (!answers.length) return ['none recorded'];
  const out = [];
  answers.forEach((a, i) => {
    const at = `recon[${i}]`;
    if (!a || typeof a !== 'object') throw fail('recon answers must be objects with question, answer, paths, signatures');
    // Free text is quoted ("> " on every line) like notes; code-quoted fields are checked.
    const free = (v, fallback) => oneLine(v === undefined || v === null || v === '' ? fallback : v);
    out.push(`- ${free(a.question, '(no question)')}${a.answer ? `: ${free(a.answer)}` : ''}`);
    for (const p of checkedList(`${at}.paths`, a.paths, { ticks: true })) out.push(`  - path: ${code(displayPath(p))}`);
    for (const x of checkedList(`${at}.signatures`, a.signatures, { ticks: true })) out.push(`  - signature: ${code(x)}`);
    for (const q of checkedList(`${at}.quoted_lines`, a.quoted_lines ?? a.quotedLines ?? a['quoted lines'], { ticks: true })) out.push(`  - quoted: ${code(q)}`);
    if (a.confidence) out.push(`  - confidence: ${free(a.confidence)}`);
  });
  return out.flatMap((l) => quote(l));
}

const WORKER_RULES = [
  'Do not commit, switch branches, install dependencies, run a whole-repository formatter or generator, or change an approved integration contract.',
  'The orchestrator owns shared seams, barriers, reconciliation and all Git operations.',
  'Write the failing test first when a RED spec is listed, and run it to see it fail before you write the code.',
  'Run only the test files listed under Required tests, never the whole suite, unless the brief says so.',
  'Never print or store a home directory path, user name or email address in any repository file.',
];

const REPORT_EXAMPLE = [
  '```ship-ticket-report',
  '{"tests":[{"cmd":"<command you ran>","result":"pass"}],"red_seen":[],"blockers":[],"needs_outside_ownership":[]}',
  '```',
];

// Only when the repository declares T0 (`--t0`): the Report block then asks for a fifth key. Absent T0 leaves the brief byte-identical.
const T0_REPORT_LINES = [
  '',
  'This repository declares T0 fast checks. Before you hand over, on your working tree (committed or not), run',
  '`node scripts/fast-checks.mjs run --repo <repo> --base <base sha>` from the ship-ticket skill directory and fix',
  'every failure; a timeout is a failure. Then add the `report` object it prints as a fifth key `t0`, so the block',
  'has these five keys. The orchestrator checks it with `fast-checks.mjs verify` and does not freeze a candidate whose',
  '`t0` is missing (`fast_check_missing`) or failed; the carrier itself does not refuse it. T0 is fast feedback, not proof of',
  'correctness.',
  '',
  '```ship-ticket-report',
  '{"tests":[],"red_seen":[],"blockers":[],"needs_outside_ownership":[],"t0":{"result":"pass","checks":[{"name":"<check name>","result":"pass"}]}}',
  '```',
];

// Only when the plan's T1-S triggers require test kinds (`--test-kinds`, the `test-kinds.mjs require` output). Absent or
// `not_declared` leaves the brief byte-identical; a refused or malformed requirement refuses the brief.
function testKindLines(r, withT0) {
  if (r === null || r === undefined || r?.status === 'not_declared') return null;
  if (!r || r.status !== 'required' || !Array.isArray(r.kinds) || !Array.isArray(r.items)
    || !r.kinds.every((k) => typeof k === 'string' && Object.hasOwn(KINDS, k)) || !r.items.every((i) => typeof i === 'string' && ITEM_ID.test(i)))
    throw fail('the test-kinds requirement is refused or malformed; run `test-kinds.mjs require` and fix the plan first');
  return {
    tests: [
      'Required test kinds (risk-triggered by the approved plan; `scripts/test-kinds.mjs`). Prove each one in at least one test whose title carries its marker:',
      '',
      ...bullets(r.kinds.map((k) => `${code(`[kind:${k}]`)} (${KINDS[k].letter}): ${KINDS[k].definition}.`), 'none'),
      '',
      ...(r.items.length ? [`Plan lifecycle items, each covered by a test whose title carries its marker: ${r.items.map((i) => code(`[plan:${i}]`)).join(', ')}.`, ''] : []),
      'A kind or item you cannot prove goes in `blockers`. A waiver line removes nothing here: only a trusted owner approval can, in a later slice.',
      '',
    ],
    report: [
      '',
      'This plan requires test kinds. Add the key `test_titles` beside the keys above: the full title of every test you added or',
      'changed, markers included. Before freeze the orchestrator runs `test-kinds.mjs check`; it exits 1 (`freeze_refused`) while a',
      'kind or item is missing. ADVISORY: no engine step enforces this yet, but exit 1 is never a freeze permission: the',
      'orchestrator does not freeze on it. A marker on a test that does not prove the property is a defect, not a pass.',
      '',
      '```ship-ticket-report',
      `{"tests":[],"red_seen":[],"blockers":[],"needs_outside_ownership":[],${withT0 ? '"t0":{"result":"pass","checks":[{"name":"<check name>","result":"pass"}]},' : ''}"test_titles":["<test title> [kind:<kind id>]"]}`,
      '```',
    ],
  };
}

/** Build the brief text (digest line included) for one DAG node. Throws a `briefError` on a refused input. */
export function buildBrief({ dag, nodeId, planText, planPath = 'plan.md', recon = null, notes = null, t0 = null, testKinds = null }) {
  const kindLines = testKindLines(testKinds, Boolean(t0));
  const nodes = asList(dag && dag.nodes);
  if (!nodes.length) throw fail('the DAG has no nodes');
  const node = nodes.find((n) => n && n.id === nodeId);
  if (!node) throw fail(`unknown node id "${nodeId}" (DAG nodes: ${nodes.map((n) => n && n.id).join(', ')})`);
  if (typeof planText !== 'string' || !planText.trim()) throw fail('the plan file is empty');

  const f = {
    id: checked('node.id', node.id, { ticks: true }),
    writes: checkedList('writes', node.writes, { ticks: true }),
    reads: checkedList('reads', node.reads, { ticks: true }),
    othersOwned: checkedList('othersOwned', node.othersOwned, { ticks: true }),
    deps: checkedList('deps', node.deps, { ticks: true }),
    resources: checkedList('resources', node.resources, { ticks: true }),
    checks: checkedList('checks', node.checks, { ticks: true }),
    evidence: checkedList('evidence', node.evidence, { ticks: true }),
    acceptance: checkedList('acceptance', node.acceptance, { ticks: true }),
    redSpecs: asList(node.redSpecs).map((r, i) => (typeof r === 'string'
      ? { file: checked(`redSpecs[${i}]`, r, { ticks: true }) }
      : { file: checked(`redSpecs[${i}].file`, r && r.file, { ticks: true }), name: r && r.name !== undefined ? checked(`redSpecs[${i}].name`, r.name) : undefined })),
  };
  const risk = checkedList('risk', node.risk);
  for (const k of ['phase', 'role', 'complexity', 'modelTier', 'unit']) if (node[k] !== undefined && node[k] !== null) checked(k, String(node[k]));
  checked('plan path', String(planPath));
  const step = planStep(planText, node.id);
  const evidenceKinds = [...new Set(risk.flatMap((l) => (Object.hasOwn(RISK_EVIDENCE, l) ? RISK_EVIDENCE[l] : [])))].sort();
  const taskFacts = [
    ['phase', node.phase], ['role', node.role], ['risk', risk.length ? risk.join(', ') : null],
    ['complexity', node.complexity], ['model tier', node.modelTier], ['unit', node.unit],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k} ${v}`);

  const lines = [];
  const section = (name, body) => lines.push(`## ${name}`, '', ...body, '');

  lines.push(`# Brief for node ${code(f.id)}`, '');
  section('Task', [
    `Node ${code(f.id)}${taskFacts.length ? ` (${taskFacts.join('; ')})` : ''}.`,
    '',
    ...(step ? quote(step) : ['No execution DAG row for this node was found in the plan; the fields below define the task.']),
  ]);
  section('Approved plan and digest', [
    `Plan file: ${code(displayPath(planPath))}`,
    '',
    `plan-digest ${planDigest(planText)}`,
    '',
    'Work only inside the approved plan. If the plan and the code disagree, stop and report; do not improvise.',
  ]);
  section('Ownership', [
    'You may write only these paths:',
    '',
    ...bullets(f.writes.map((p) => code(displayPath(p))), 'none: this node writes no files'),
  ]);
  section('Forbidden paths', [
    ...bullets(f.othersOwned.map((p) => `${code(displayPath(p))} (owned by another worker)`), 'none declared by name; every path outside Ownership is still forbidden'),
    '',
    'Other workers are active in this checkout. Do not revert their work. If you need to edit a path outside your ownership, stop and report it in `needs_outside_ownership`.',
  ]);
  section('Dependencies and reads', [
    'Finished before you start:',
    '',
    ...bullets(f.deps.map(code), 'none'),
    '',
    'Read, do not edit:',
    '',
    ...bullets(f.reads.map((p) => code(displayPath(p))), 'none'),
  ]);
  section('Exclusive resources', bullets(f.resources.map(code), 'none'));
  const tests = [];
  if (f.redSpecs.length) {
    tests.push('RED specs (write each, run it, and see it fail first):', '');
    for (const s of f.redSpecs) tests.push(`- ${code(displayPath(s.file))}${s.name ? ` "${oneLine(s.name)}"` : ''}`);
    tests.push('');
  }
  if (f.checks.length) tests.push(`Checks (named test commands): ${f.checks.map(code).join(', ')}`, '');
  if (risk.length) tests.push(`Risk labels: ${risk.join(', ')}. Evidence kinds these labels require: ${evidenceKinds.length ? evidenceKinds.map(code).join(', ') : 'none'}.`, '');
  if (f.evidence.length) tests.push(`Declared evidence: ${f.evidence.map(code).join(', ')}`, '');
  if (kindLines) tests.push(...kindLines.tests);
  tests.push('- Run every test file you add or change and list each command with its result in the report block.');
  section('Required tests', tests);
  section('Reuse inventory', reuseLines(recon));
  section('Acceptance ids', bullets(f.acceptance.map(code), 'none'));
  section('Notes', notes && String(notes).trim() ? quote(normalise(notes).trim()) : ['none']);
  section('Worker rules', bullets(WORKER_RULES, ''));
  section('Report block', [
    'End your final message with one fenced block like this, with exactly these four keys.',
    'Each test is a command and `pass` or `fail`. List the failing specs you saw in `red_seen`.',
    '',
    ...REPORT_EXAMPLE,
    ...(t0 ? T0_REPORT_LINES : []),
    ...(kindLines ? kindLines.report : []),
  ]);

  const body = lines.join('\n').replace(/\n+$/, '\n');
  return `${body}brief-digest sha256:${sha256(body)}\n`;
}

/** Split a brief into `[{ name, lines }]` in order; headings inside fenced blocks do not count. */
function parseSections(text) {
  const out = [];
  let current = null;
  let fence = false;
  for (const line of normalise(text).split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = !fence && /^## (.+?)\s*$/.exec(line);
    if (h) {
      current = { name: h[1], lines: [] };
      out.push(current);
    } else if (current && !DIGEST_LINE.test(line)) current.lines.push(line);
  }
  return out;
}

/** `{ ok, problems, warnings }` for a brief; a problem names the section. */
export function lintBrief(text) {
  const list = parseSections(text);
  const sections = new Map(list.map((s) => [s.name, s.lines]));
  const problems = [];
  const warnings = [];
  const seen = new Set();
  for (const { name } of list) {
    if (!SECTIONS.includes(name)) problems.push(`section "${name}" is not one of the fixed sections`);
    else if (seen.has(name)) problems.push(`section "${name}" appears more than once`);
    seen.add(name);
  }
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) problems.push(`section "${name}" is missing`);
    else if (!sections.get(name).some((l) => l.trim())) problems.push(`section "${name}" is empty`);
    else if (name === 'Report block' && !sections.get(name).some((l) => /^\s*```ship-ticket-report\s*$/.test(l))) problems.push('section "Report block" has no ship-ticket-report block');
  }
  const norm = normalise(text).replace(/\n+$/, '\n');
  const last = norm.replace(/\n$/, '').split('\n').pop();
  const m = DIGEST_LINE.exec(last);
  if (!m) warnings.push('no brief-digest line at the end');
  else if (m[1] !== sha256(norm.slice(0, norm.length - last.length - 1))) warnings.push('brief-digest does not match the brief body (edited after build?)');
  return { ok: problems.length === 0, problems, warnings };
}

function parseFlags(args, allowed) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!allowed.includes(key)) throw Object.assign(new Error(`unknown option ${a}`), { usage: true });
      if (i + 1 >= args.length) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      i += 1;
      opts[key] = args[i];
    } else positional.push(a);
  }
  return { opts, positional };
}

function readT0(path) {
  try { return validateDeclaration(readJson(path, 'T0 declaration')); } catch (err) {
    if (err.t0Config) throw fail(`T0 declaration ${displayPath(path)} is invalid: ${err.message}`);
    throw err;
  }
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw fail(`cannot read ${what} ${displayPath(path)}: ${err.code ?? err.message}`);
  }
}

function readJson(path, what) {
  try {
    return JSON.parse(readText(path, what));
  } catch (err) {
    if (err.briefError) throw err;
    throw fail(`${what} ${displayPath(path)} is not valid JSON: ${err.message}`);
  }
}

/** Refuse an --out that is a symbolic link or that is one of the input files (compared by resolved and real path). */
function checkOut(out, inputs) {
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  let link = false;
  try { link = lstatSync(out).isSymbolicLink(); } catch (e) { if (e.code !== 'ENOENT') throw e; } // lstat sees a dangling link; existsSync does not
  if (link) throw fail('--out is a symbolic link; refusing to write through it');
  const target = new Set([resolve(out), real(out)]);
  // A hard link has another path but the same file: compare device and inode when --out already exists.
  let outId = null;
  try { const st = statSync(out); if (st.ino) outId = `${st.dev}:${st.ino}`; } catch { /* no file yet */ }
  for (const input of inputs.filter(Boolean)) {
    if (target.has(resolve(input)) || target.has(real(input))) throw fail('--out is also an input file (dag, plan, recon or notes); refusing to overwrite it');
    if (outId) {
      let id = null;
      try { const st = statSync(input); if (st.ino) id = `${st.dev}:${st.ino}`; } catch { /* unreadable input fails later with its own message */ }
      if (id === outId) throw fail('--out is a hard link to an input file (dag, plan, recon or notes); refusing to overwrite it');
    }
  }
}

export function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === 'build') {
      const { opts } = parseFlags(rest, ['dag', 'node', 'plan', 'recon', 'notes', 'out', 't0', 'test-kinds']);
      for (const k of ['dag', 'node', 'plan', 'out']) if (!opts[k]) throw Object.assign(new Error(`build needs --${k}`), { usage: true });
      const text = buildBrief({
        dag: readJson(opts.dag, 'DAG'),
        nodeId: opts.node,
        planText: readText(opts.plan, 'plan'),
        planPath: opts.plan,
        recon: opts.recon ? readJson(opts.recon, 'recon file') : null,
        notes: opts.notes ? readText(opts.notes, 'notes file') : null,
        t0: opts.t0 ? readT0(opts.t0) : null,
        testKinds: opts['test-kinds'] ? readJson(opts['test-kinds'], 'test-kinds requirement') : null,
      });
      checkOut(opts.out, [opts.dag, opts.plan, opts.recon, opts.notes, opts.t0, opts['test-kinds']]);
      writeFileSync(opts.out, text);
      const digest = text.trimEnd().split('\n').pop();
      process.stdout.write(`brief written for node ${opts.node}: ${digest}\n`);
      return 0;
    }
    if (command === 'lint') {
      const { positional } = parseFlags(rest, []);
      if (positional.length !== 1) throw Object.assign(new Error('lint needs one brief file'), { usage: true });
      const result = lintBrief(readText(positional[0], 'brief'));
      for (const w of result.warnings) process.stderr.write(`brief: warning: ${w}\n`);
      if (!result.ok) {
        for (const p of result.problems) process.stderr.write(`brief: ${p}\n`);
        return 1;
      }
      process.stdout.write('brief lint ok\n');
      return 0;
    }
    if (command === 'plan-digest') {
      const { opts, positional } = parseFlags(rest, ['plan']);
      if (!opts.plan || positional.length) throw Object.assign(new Error('plan-digest needs --plan and takes no other argument'), { usage: true });
      process.stdout.write(`${planDigest(readText(opts.plan, 'plan'))}\n`);
      return 0;
    }
    if (command === 'start-check') {
      const { opts, positional } = parseFlags(rest, ['plan', 'run-id', 'repo']);
      if (!opts.plan || !opts['run-id'] || positional.length) throw Object.assign(new Error('start-check needs --plan and --run-id and takes no other argument'), { usage: true });
      let text;
      try { text = readFileSync(opts.plan, 'utf8'); } catch (err) {
        process.stdout.write(`${JSON.stringify({ ok: false, errors: [{ code: 'plan_unreadable', message: `cannot read plan: ${err.code ?? err.message}` }], warnings: [] })}\n`);
        return 1;
      }
      // The retained debate bundle is located from the repository (default: the plan's directory), never from scratch paths.
      const repo = resolve(opts.repo ?? dirname(resolve(opts.plan)));
      const r = startCheck(text, { runId: opts['run-id'], bundleDir: retainedDirFor(text, repo)?.dir ?? null, repo });
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.ok ? 0 : 1;
    }
    if (command === 'debate-check') {
      const { opts, positional } = parseFlags(rest, ['plan', 'bundle', 'repo']);
      if (!opts.plan || !opts.bundle || !opts.repo || positional.length) throw Object.assign(new Error('debate-check needs --plan, --bundle and --repo and takes no other argument'), { usage: true });
      let text;
      try { text = readFileSync(opts.plan, 'utf8'); } catch (err) {
        process.stdout.write(`${JSON.stringify({ ok: false, errors: [{ code: 'plan_unreadable', message: `cannot read plan: ${err.code ?? err.message}` }], warnings: [] })}\n`);
        return 1;
      }
      const r = debateCheck(text, { bundleDir: resolve(opts.bundle), repo: resolve(opts.repo) });
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.ok ? 0 : 1;
    }
    if (command === 'debate-serialize') {
      const { opts, positional } = parseFlags(rest, ['attestation', 'dispositions']);
      if (Boolean(opts.attestation) === Boolean(opts.dispositions) || positional.length) throw Object.assign(new Error('debate-serialize needs exactly one of --attestation or --dispositions'), { usage: true });
      if (opts.dispositions) { process.stdout.write(`${serializeDispositions(readJson(opts.dispositions, 'dispositions'))}\n`); return 0; }
      const line = serializeAttestation(readJson(opts.attestation, 'attestation'));
      process.stdout.write(`${line}\ndebate-attestation-sha256 ${sha256Of(Buffer.from(line, 'utf8'))}\n`);
      return 0;
    }
    if (command === 'debate-retain') {
      const { opts, positional } = parseFlags(rest, ['plan', 'bundle', 'repo']);
      if (!opts.plan || !opts.bundle || !opts.repo || positional.length) throw Object.assign(new Error('debate-retain needs --plan, --bundle and --repo'), { usage: true });
      const text = readText(opts.plan, 'plan');
      const loc = retainedDirFor(text, resolve(opts.repo));
      const r = loc ? retainBundle(text, { from: resolve(opts.bundle), to: loc.dir, root: loc.root, repo: resolve(opts.repo) })
        : { ok: false, retained: null, errors: [{ code: 'debate_evidence_missing', message: 'cannot locate <git-common-dir> or read the plan attestation; WAIT_FOR_USER' }] };
      process.stdout.write(`${JSON.stringify(r)}\n`);
      return r.ok ? 0 : 1;
    }
    if (command === 'debate-probe') {
      const { opts, positional } = parseFlags(rest, ['relay', 'repo', 'out-dir', 'carrier', 'cli', 'busy-timeout', 'probe-timeout']);
      if (!opts.relay || !opts.repo || !opts['out-dir'] || positional.length) throw Object.assign(new Error('debate-probe needs --relay, --repo and --out-dir'), { usage: true });
      const carrier = opts.carrier ?? 'codex';
      if (opts.cli !== undefined && !isAbsolute(opts.cli)) throw Object.assign(new Error('debate-probe --cli must be an absolute path (the one executable the relay will run)'), { usage: true });
      if (!['codex', 'claude'].includes(carrier)) throw Object.assign(new Error('debate-probe --carrier is codex or claude'), { usage: true });
      return runProbe({ relay: resolve(opts.relay), repo: resolve(opts.repo), outDir: resolve(opts['out-dir']), carrier, cli: opts.cli ?? null, busyTimeout: opts['busy-timeout'] ?? '30s', probeTimeout: opts['probe-timeout'] ?? '20m' })
        .then((r) => { process.stdout.write(`${JSON.stringify(r)}\n`); return r.ok ? 0 : 1; });
    }
    throw Object.assign(new Error('usage: brief.mjs plan-digest --plan <plan.md> | brief.mjs start-check --plan <plan.md> --run-id <id> [--repo <dir>] | brief.mjs debate-check --plan <plan.md> --bundle <dir> --repo <dir> | brief.mjs debate-serialize --attestation <json> | brief.mjs debate-serialize --dispositions <json> | brief.mjs debate-retain --plan <plan.md> --bundle <dir> --repo <dir> | brief.mjs debate-probe --relay <relay.mjs> --repo <dir> --out-dir <dir> [--carrier codex|claude] [--cli <bin>] [--busy-timeout <dur>] [--probe-timeout <dur>] | brief.mjs build --dag <dag.json> --node <id> --plan <plan.md> [--recon <json>] [--notes <file>] [--t0 <repo>/.ship-ticket/t0.json] [--test-kinds <require.json>] --out <file> | brief.mjs lint <brief>'), { usage: true });
  } catch (err) {
    if (!err.briefError && !err.usage) throw err;
    if (command === 'start-check' && /^plan_invalid/.test(err.message)) {
      process.stdout.write(`${JSON.stringify({ ok: false, errors: [{ code: 'plan_invalid', message: err.message }], warnings: [] })}\n`);
      return 1;
    }
    process.stderr.write(`brief: ${err.message}\n`);
    return err.usage ? 2 : 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  const code = main(process.argv.slice(2));
  if (code && typeof code.then === 'function') code.then((c) => { process.exitCode = c; }, (err) => { process.stderr.write(`brief: ${err.message}\n`); process.exitCode = 1; });
  else process.exitCode = code;
}
