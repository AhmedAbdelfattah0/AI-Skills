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
import { readFileSync, writeFileSync, lstatSync, statSync, realpathSync, copyFileSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync, constants as fsConstants } from 'node:fs';
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
export const DEBATE_OUTCOMES = Object.freeze(['CONVERGED', 'UNRESOLVED', 'LIMIT_REACHED', 'SKIPPED']);
/** Every refusal code `debate-check` and the START debate fields can return. */
export const DEBATE_CODES = Object.freeze(['debate_policy_missing', 'debate_attestation_missing', 'debate_attestation_invalid', 'debate_attestation_changed',
  'debate_evidence_missing', 'debate_evidence_mismatch', 'debate_digest_mismatch', 'debate_request_mismatch', 'debate_echo_invalid', 'debate_carrier_invalid',
  'debate_degradation_unacknowledged', 'debate_open_finding', 'debate_outcome_invalid', 'debate_limit_invalid', 'debate_exception_missing',
  'debate_disposition_pending', 'debate_reconfirm_required', 'debate_workdir_unbound']);
/** The frozen acknowledgement sentences of section 7 "Debate carrier and exceptions requested" (exact text). */
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
const LIMIT_KINDS = ['configured_budget', 'provider_limit', 'resource_limit'];
const SEVERITIES = ['blocker', 'major', 'minor'];
const CONCRETE = new Set(['accept_risk', 'decided', 'waived']);
const ECHO_LINE = /^(verdict|request_id|plan_version|plan_digest): (\S+)$/;
const BRIEF_LINE = /^(request_id|plan_version|plan_digest): (\S+)$/;
const CONCEDE_LINE = /^finding ([A-Za-z0-9][A-Za-z0-9._-]*): (conceded|confirmed)$/;
/** A fence-like run (three or more backticks or tildes) at any indent or behind any quote prefix. */
const FENCE_RUN = /^[ \t>]*(`{3,}|~{3,})/m;
const sha256Of = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const placeholder = (v) => !nonEmpty(v) || /^(none|tbd|todo|pending|n\/a|-)$/i.test(v.trim()) || /<[^>]*>/.test(v);

/** Keys sorted at every depth; arrays keep their order. */
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
  let again;
  try { again = serializeAttestation(att); } catch (err) { return bad('debate_attestation_invalid', err.message); }
  if (again !== line) return bad('debate_attestation_invalid', 'the attestation line is not in canonical form (use `brief.mjs debate-serialize`; never hand-edit it)');
  return { ok: true, line, sha256: sha256Of(Buffer.from(line, 'utf8')), attestation: att };
}

/** The `debate_policy:` header value of the narrative: { value, count }. */
function debatePolicy(narr) {
  const found = [...normalise(narr).matchAll(/^\s*debate_policy:\s*(\S*)\s*$/gm)].map((m) => m[1]);
  return { value: found.length === 1 ? found[0] : null, count: found.length };
}

/**
 * Whether line `at` sits inside a fenced block: a run of three or more backticks or tildes (any indent or quote prefix)
 * opens one, and a run of the same character at least as long with nothing after it closes it.
 */
function insideFence(lines, at) {
  let open = null;
  for (let i = 0; i < at; i += 1) {
    const m = /^[ \t>]*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!open) open = { ch: m[1][0], len: m[1].length };
    else if (m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim()) open = null;
  }
  return open !== null;
}

/** Section 7 of the narrative (from `## 7.` to the next `## ` heading), or ''. */
function sectionSeven(narr) {
  const lines = normalise(narr).split('\n');
  const at = lines.findIndex((l) => /^## 7\./.test(l));
  if (at < 0) return '';
  const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  return lines.slice(at, end < 0 ? lines.length : end).join('\n');
}

/** The frozen "Debate carrier and exceptions requested" bullets of section 7. */
function carrierSection(sec7) {
  const lines = sec7.split('\n');
  const at = lines.findIndex((l) => /^### Debate carrier and exceptions requested\s*$/.test(l));
  const out = { present: at >= 0 };
  if (at < 0) return out;
  const keys = { 'carrier.degraded': 'degraded', 'degradation acknowledgement': 'degradationAck', exception: 'exception', 'exception reason': 'reason', 'exception acknowledgement': 'exceptionAck', scope: 'scope' };
  for (const l of lines.slice(at + 1)) {
    if (/^#{2,3} /.test(l)) break;
    const m = /^- ([a-z. ]+): (.*)$/.exec(l.trimEnd());
    if (m && Object.hasOwn(keys, m[1])) out[keys[m[1]]] = m[2].trim();
  }
  return out;
}

/** Whether section 7 carries the owner exception of `kind` (SKIPPED or WAIVED): reason, scope this ticket and the exact acknowledgement. */
function exceptionOk(sec, kind) {
  return Boolean(sec.present) && sec.exception === kind && !placeholder(sec.reason) && sec.scope === 'this ticket'
    && sec.exceptionAck === (kind === 'SKIPPED' ? SKIP_ACK : WAIVE_ACK);
}

/** Disposition rows of section 7's `| Finding | Disposition | Resolution | Design change |` table, by finding id. */
function dispositionRows(sec7) {
  const rows = new Map();
  const lines = sec7.split('\n');
  const at = lines.findIndex((l) => /^\|\s*Finding\s*\|\s*Disposition\s*\|\s*Resolution\s*\|\s*Design change\s*\|\s*$/.test(l.trimEnd()));
  if (at < 0) return rows;
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('|')) break;
    const cells = l.trimEnd().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const [id, disposition, resolution, design] = cells;
    if (id) rows.set(id.replace(/`/g, ''), { disposition: (disposition ?? '').replace(/`/g, ''), resolution: resolution ?? '', design: design ?? '' });
  }
  return rows;
}

/**
 * The anchored header of a counterpart response: the lines before its first blank line, and nothing else, are parsed.
 * Every header line is exactly one of the four echo lines (`verdict:`, `request_id:`, `plan_version:`, `plan_digest:`)
 * or a concession `finding <ID>: conceded|confirmed` with nothing after the keyword, from column 1. Any other header line
 * (a fence run, an indented or quoted line, prose, a hedged concession) refuses the response; the rest of the response is
 * prose and is never read for an echo or a concession, so no fence state is tracked.
 */
function parseHeader(text) {
  const lines = normalise(text).split('\n');
  const end = lines.findIndex((l) => l.trim() === '');
  const fields = {};
  const concessions = new Set();
  for (const raw of end < 0 ? lines : lines.slice(0, end)) {
    const l = raw.replace(/[ \t]+$/, '');
    let m;
    if ((m = ECHO_LINE.exec(l))) {
      if (Object.hasOwn(fields, m[1])) return { ok: false, why: `the response repeats the echo line ${m[1]}:` };
      fields[m[1]] = m[2];
    } else if ((m = CONCEDE_LINE.exec(l))) concessions.add(m[1]);
    else return { ok: false, why: `the response header (the lines before the first blank line) holds a line that is neither an echo line nor \`finding <ID>: conceded|confirmed\`: ${JSON.stringify(l.slice(0, 60))}` };
  }
  for (const k of ['verdict', 'request_id', 'plan_version']) if (!Object.hasOwn(fields, k)) return { ok: false, why: `the response header has no \`${k}: <value>\` line` };
  if (!['AGREE', 'CHANGES_REQUESTED'].includes(fields.verdict)) return { ok: false, why: `verdict ${fields.verdict} is neither AGREE nor CHANGES_REQUESTED` };
  return { ok: true, ...fields, concessions };
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
    if (!lstatSync(p).isFile()) return { code: 'debate_evidence_mismatch', why: `${rel} is not a regular file` };
    if (!realpathSync(p).startsWith(realpathSync(root) + sep)) return { code: 'debate_evidence_mismatch', why: `${rel} resolves outside the bundle` };
  } catch (err) { return { code: 'debate_evidence_missing', why: `${rel} is not readable in the bundle (${err.code ?? err.message})` }; }
  return { path: p };
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

/** Every evidence file an attestation references (bundle-relative). */
const evidencePaths = (att) => asList(att?.rounds).flatMap((r) => Object.values(isObject(r?.files) ? r.files : {}));

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
 * `[code, message]` when a disposition row does not authorize, else null: a concrete kind with its text, `waived` only
 * with the frozen exception, a Design change cell of exactly yes or no (anything else fails closed), and yes only after
 * a new plan_version and the counterpart's AGREE for the current digest.
 */
function dispositionProblem(id, row, sec, rounds, digest) {
  if (!row) return ['debate_disposition_pending', `outstanding ${id} has no disposition row in section 7 (accept_risk, decided or waived with its text)`];
  if (!CONCRETE.has(row.disposition) || placeholder(row.resolution)) return ['debate_disposition_pending', `${id}: ${row.disposition || '(empty)'} without a concrete resolution blocks START (decide and re-debate are pending)`];
  if (row.disposition === 'waived' && !exceptionOk(sec, 'WAIVED') && !exceptionOk(sec, 'SKIPPED')) return ['debate_disposition_pending', `${id}: waived needs the owner exception frozen in section 7`];
  const design = row.design.trim().toLowerCase();
  if (design !== 'yes' && design !== 'no') return ['debate_disposition_pending', `${id}: the Design change cell must be exactly yes or no, not ${JSON.stringify(row.design)}`];
  if (design === 'yes' && !reconfirmed(rounds, digest)) return ['debate_reconfirm_required', `${id}: a design-changing disposition needs a new plan_version, the counterpart's AGREE for the new digest, then native approval again`];
  return null;
}

/**
 * The full Planning Debate verification of a plan against a bundle root and the target repository. Read-only. Never
 * forces agreement: UNRESOLVED and LIMIT_REACHED are valid presentation states (`ok`), never refused merely because the
 * counterpart did not AGREE; only CONVERGED is debate-qualified. A degraded carrier is a transport label: the same checks
 * apply to it, and a substitute's verified concession counts exactly like any other. Documented limit: this detects
 * inconsistency, replay and stale or unrelated results; it cannot authenticate against a host able to fabricate every input.
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
  const got = readAttestation(planText);
  if (!got.ok) { add(got.error.code, got.error.message); return done(); }
  const att = got.attestation;
  base.attestation_sha256 = got.sha256;
  const sec7 = sectionSeven(narr);
  const sec = carrierSection(sec7);
  const rows = dispositionRows(sec7);
  const narrLines = normalise(narr).split('\n');
  const s7 = narrLines.flatMap((l, i) => (/^## 7\./.test(l) ? [i] : []));
  if (s7.length !== 1) add('debate_attestation_invalid', `the plan must hold exactly one \`## 7.\` heading (found ${s7.length})`);
  else if (insideFence(narrLines, s7[0])) add('debate_attestation_invalid', 'section 7 sits inside a fenced block opened earlier in the plan: its machine-read lines must be outside every fence');
  if (FENCE_RUN.test(sec7)) add('debate_attestation_invalid', 'section 7 holds a code fence: its machine-read lines (Result, Attestation, carrier section, disposition table) must be fence-free');
  for (const [what, re] of [['Attestation:', /^\s*Attestation:/], ['### Debate carrier and exceptions requested', /^\s*#+\s*Debate carrier and exceptions requested/], ['disposition table header', /^\s*\|\s*Finding\s*\|\s*Disposition\s*\|/]]) {
    if (sec7.split('\n').filter((l) => re.test(l)).length > 1) add('debate_attestation_invalid', `section 7 holds more than one ${what} line`);
  }
  // ---- schema
  if (att.v !== 1 || att.policy !== 2) add('debate_attestation_invalid', 'the attestation must carry v: 1 and policy: 2');
  if (!SAFE_SEGMENT.test(String(att.ticket)) || !DEBATE_ID_FORMAT.test(String(att.debate_id)) || !String(att.debate_id).startsWith(`debate-${att.ticket}-`)) {
    add('debate_attestation_invalid', 'debate_id must be `debate-<ticket>-<yyyymmddThhmmZ>` with a safe ticket key');
  }
  const ref = /^Attestation:\s*(\S+)\s*$/m.exec(sec7);
  if (!ref || ref[1] !== att.debate_id) add('debate_attestation_invalid', `section 7 must predeclare \`Attestation: ${att.debate_id}\` in the frozen narrative`);
  const outcome = att.outcome;
  if (!DEBATE_OUTCOMES.includes(outcome)) {
    add('debate_outcome_invalid', `outcome ${JSON.stringify(outcome)} is not one of ${DEBATE_OUTCOMES.join(', ')}${outcome === 'DEGRADED' ? ' (a degraded carrier is carrier.degraded, never an outcome)' : ''}`);
    return done();
  }
  base.outcome = outcome;
  const resultLines = sec7.split('\n').filter((l) => l.includes('**Result:**'));
  const declared = /^\*\*Result:\*\*\s*`?([A-Z_]+)/.exec(resultLines[0] ?? '')?.[1];
  if (resultLines.length !== 1) add('debate_outcome_invalid', `section 7 must hold exactly one **Result:** line (found ${resultLines.length})`);
  else if (declared !== outcome) add('debate_outcome_invalid', declared ? `section 7 states **Result:** ${declared}, but the attestation outcome is ${outcome}` : 'section 7 must state the outcome as the first word of its **Result:** line, from column 1');
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
  const budget = isObject(att.budget) ? att.budget : null;
  if (!budget || !['max_rounds', 'max_minutes'].every((k) => budget[k] === null || (typeof budget[k] === 'number' && budget[k] > 0))) add('debate_attestation_invalid', 'budget must be {max_rounds, max_minutes}, each null (no cap) or a positive number');
  // ---- carrier: a transport label, never an outcome; Fable or any substitute only as the declared degraded carrier
  if (!asList(CARRIER_KINDS[carrier.agent]).includes(carrier.kind)) add('debate_carrier_invalid', `carrier ${carrier.agent} cannot use kind ${carrier.kind}`);
  if (!carrier.degraded && (carrier.agent !== PAIRED[host.agent] || base.diversity === 'same_provider')) {
    add('debate_carrier_invalid', `a ${host.agent} host pairs with ${PAIRED[host.agent] ?? 'its configured counterpart'}; any substitute (Fable or a same-provider session) is carrier.degraded: true`);
  }
  if (sec.present && sec.degraded !== String(carrier.degraded)) add('debate_carrier_invalid', 'the frozen carrier section of section 7 disagrees with the attestation carrier.degraded');
  if (att.carrier.degraded && !(sec.degraded === 'true' && sec.degradationAck === DEGRADED_ACK)) add('debate_degradation_unacknowledged', 'a degraded carrier needs the frozen acknowledgement in section 7 "Debate carrier and exceptions requested"');
  if (carrier.kind !== 'native_session') {
    if (!(typeof att.workdir === 'string' && isAbsolute(att.workdir))) add('debate_attestation_invalid', 'workdir (the directory the relay ran in) must be an absolute path');
    else bindWorkdir(att, repo, add);
  }
  // ---- rounds and their retained evidence
  const seen = new Set();
  const completedNumbers = new Set();
  const perRound = new Map();
  rounds.forEach((r, i) => {
    if (!isObject(r) || r.n !== i + 1) { add('debate_attestation_invalid', `round ${i + 1} is not an object numbered n: ${i + 1}`); return; }
    if (!ROUND_STATUS.includes(r.status)) { add('debate_attestation_invalid', `round ${r.n} status ${JSON.stringify(r.status)} is not one of ${ROUND_STATUS.join(', ')}`); return; }
    if (!SAFE_SEGMENT.test(String(r.request_id))) add('debate_attestation_invalid', `round ${r.n} needs a safe request_id`);
    if (seen.has(r.request_id)) add('debate_request_mismatch', `round ${r.n} reuses request_id ${r.request_id} (a replayed request)`);
    seen.add(r.request_id);
    perRound.set(r.n, verifyRound(r, att, bundleDir, add));
    if (r.status === 'completed') completedNumbers.add(r.n);
  });
  // ---- the canonical ledger
  const ids = new Map();
  for (const f of findings) {
    if (!isObject(f) || !nonEmpty(f.id) || !SEVERITIES.includes(f.severity) || !['open', 'resolved'].includes(f.status)) { add('debate_attestation_invalid', `finding ${JSON.stringify(f?.id)} needs id, severity (${SEVERITIES.join('|')}) and status (open|resolved)`); continue; }
    const names = [f.id, ...asList(f.aliases)];
    for (const name of names) {
      if (ids.has(name)) add('debate_attestation_invalid', `finding id or alias ${name} is used twice in the canonical ledger`);
      ids.set(name, f.id);
    }
    if (f.status === 'resolved' && f.severity !== 'minor') {
      if (f.closed_by === 'owner') {
        const p = dispositionProblem(f.id, rows.get(f.id), sec, rounds, digest);
        if (p) add(p[0], `${f.severity} ${f.id} closed by the owner: ${p[1]}`);
      } else {
        const conceded = perRound.get(f.closed_round)?.concessions;
        const byCounterpart = f.closed_by === 'counterpart' && completedNumbers.has(f.closed_round) && nonEmpty(f.evidence) && Boolean(conceded?.has(f.id));
        if (!byCounterpart) add('debate_attestation_invalid', `${f.severity} ${f.id} is closed without a verified round whose response concedes it (\`finding ${f.id}: conceded|confirmed\`) with evidence, or an owner disposition`);
      }
    }
  }
  const open = findings.filter((f) => isObject(f) && f.status === 'open');
  base.outstanding = open.map((f) => f.id);
  const last = rounds.at(-1);
  const final = att.final;
  // ---- outcomes (independent of the carrier)
  if (outcome === 'CONVERGED') {
    if (!isObject(final) || final.verdict !== 'AGREE') add('debate_outcome_invalid', 'CONVERGED needs final {request_id, plan_version, plan_digest, verdict: AGREE}');
    else {
      if (final.plan_digest !== digest) add('debate_digest_mismatch', `the final AGREE confirms ${final.plan_digest}, but the frozen narrative digest is ${digest} (edited after the confirmation, or another plan)`);
      if (att.plan_digest !== final.plan_digest) add('debate_attestation_invalid', 'plan_digest and final.plan_digest differ');
      if (!last || last.status !== 'completed' || last.verdict !== 'AGREE' || last.request_id !== final.request_id || last.plan_version !== final.plan_version || last.plan_digest !== final.plan_digest) {
        add('debate_request_mismatch', 'the final AGREE is not the verified response of the last round for the same request_id, plan_version and plan_digest');
      }
    }
    if (open.some((f) => f.severity === 'blocker' || f.severity === 'major')) add('debate_open_finding', `CONVERGED with an open blocker or major: ${open.filter((f) => f.severity !== 'minor').map((f) => f.id).join(', ')}`);
    if (!['done', 'not_applicable'].includes(att.contract_recheck)) add('debate_outcome_invalid', 'CONVERGED needs contract_recheck done or not_applicable (changed-contract compatibility rechecked)');
    if (att.limit !== null && att.limit !== undefined) add('debate_outcome_invalid', 'CONVERGED carries no limit');
  } else {
    if (att.plan_digest !== digest) add('debate_digest_mismatch', `the attestation binds ${att.plan_digest}, but the frozen narrative digest is ${digest}`);
    if (outcome === 'UNRESOLVED') {
      if (!open.length || open.some((f) => !nonEmpty(f.host_position) || !nonEmpty(f.counterpart_position))) add('debate_outcome_invalid', 'UNRESOLVED needs at least one outstanding canonical finding, each with both positions');
      if (!completedNumbers.size) add('debate_outcome_invalid', 'UNRESOLVED needs at least one verified counterpart response; a debate that never got one is LIMIT_REACHED');
      if (final !== null && final !== undefined) add('debate_outcome_invalid', 'UNRESOLVED carries no final confirmation');
    } else if (outcome === 'LIMIT_REACHED') {
      if (att.final !== null) add('debate_outcome_invalid', 'LIMIT_REACHED is never converted to CONVERGED: final must be null');
      checkLimit(att, last, last ? perRound.get(last.n)?.diag : null, add);
      if (!findings.length && att.incomplete_review !== true) add('debate_limit_invalid', 'a limit reached with no findings must say incomplete_review: true');
    } else if (outcome === 'SKIPPED') {
      if (rounds.length || findings.length || (final !== null && final !== undefined)) add('debate_outcome_invalid', 'SKIPPED records no round, finding or confirmation');
      if (!exceptionOk(sec, 'SKIPPED')) add('debate_exception_missing', 'SKIPPED needs the owner exception frozen in section 7 "Debate carrier and exceptions requested": exception: SKIPPED, a reason, scope: this ticket and the exact acknowledgement');
    }
  }
  const resolveId = (id) => ids.get(id) ?? id;
  const byId = new Map([...rows].map(([id, row]) => [resolveId(id), row]));
  const need = [...base.outstanding, ...(outcome === 'LIMIT_REACHED' ? ['LIMIT'] : [])];
  base.pending = outcome === 'CONVERGED' || outcome === 'SKIPPED' ? [] : need.filter((id) => dispositionProblem(id, byId.get(id), sec, rounds, digest));
  base.debate_qualified = outcome === 'CONVERGED' && errors.length === 0;
  const m = (k, v) => (v === null || v === undefined ? [] : [`${k}=${v}`]);
  base.run_log_metrics = [...m('debate_outcome', outcome.toLowerCase()), ...m('debate_carrier', carrier.agent), ...m('debate_carrier_degraded', carrier.degraded),
    ...m('debate_rounds', metrics.rounds), ...m('debate_calls', metrics.calls), ...m('debate_minutes', metrics.minutes),
    ...m('plan_debate_started_at', metrics.started_at), ...m('plan_debate_ended_at', metrics.ended_at), ...(typeof metrics.tokens === 'number' ? [`debate_tokens=${metrics.tokens}`] : [])];
  return done({ attestation: att, line: got.line, byId, sec, rounds });
}

const PROVIDER_RE = /\b(429|quota|rate.?limit\w*|usage limit\w*)\b/i;
const RESOURCE_RE = /\b(EPERM|EACCES|ENOMEM|ENOSPC|EMFILE|out of memory|killed|timed? ?out)\b/i;
/**
 * The class of one whole diagnostic entry: a structured dispatch class when there is one, otherwise read from the entry's
 * full text: provider when only provider/quota/rate-limit words occur, resource when only permission/resource/kill/
 * timeout words occur, ambiguous when both or neither do (an ambiguous entry supports no limit kind).
 */
function entryClass(text, dispatchClass = null) {
  if (dispatchClass) return dispatchClass === 'provider' ? 'provider' : ['permission_denied', 'resource'].includes(dispatchClass) ? 'resource' : 'ambiguous';
  const p = PROVIDER_RE.test(text), r = RESOURCE_RE.test(text);
  return p && !r ? 'provider' : r && !p ? 'resource' : 'ambiguous';
}
/**
 * The diagnostic entries of a relay result: its `error` text and the error events of events.jsonl (`type: error`,
 * `turn.failed`, an item of type `error`). Counterpart output (agent messages, reasoning, the final message) never counts.
 */
function diagnosticEntries(res, eventsText) {
  const out = [];
  const push = (t) => { if (typeof t === 'string' && t.trim()) out.push({ text: t, cls: entryClass(t) }); };
  push(res.error);
  for (const l of normalise(eventsText).split('\n')) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (!isObject(e)) continue;
    const item = isObject(e.item) ? e.item : null;
    const isError = e.type === 'error' || e.type === 'turn.failed' || item?.type === 'error';
    if (!isError) continue;
    push(e.message);
    push(typeof e.error === 'string' ? e.error : e.error?.message);
    push(item?.message ?? item?.text);
  }
  return out;
}

/**
 * The limit record: kind and kind-specific evidence. configured_budget names the configured value it reached; a
 * provider or resource limit quotes text that occurs in the last attempt's RETAINED diagnostics (relay result, events
 * or dispatch error), and that text must be of the limit's class: a provider limit needs provider, quota or rate-limit
 * diagnostics; EPERM or EACCES is a permission or resource limit, never a provider limit.
 */
function checkLimit(att, last, lastDiag, add) {
  const L = att.limit;
  if (!isObject(L) || !LIMIT_KINDS.includes(L.kind) || !nonEmpty(L.evidence)) { add('debate_limit_invalid', `limit must be {kind: ${LIMIT_KINDS.join(' | ')}, evidence}`); return; }
  if (L.kind === 'configured_budget') {
    const b = isObject(att.budget) ? att.budget : {};
    const used = isObject(att.metrics) ? att.metrics : {};
    const configured = [[b.max_rounds, used.rounds], [b.max_minutes, used.minutes]].filter(([v]) => typeof v === 'number');
    if (!configured.length) add('debate_limit_invalid', 'configured_budget needs a configured max_rounds or max_minutes (an owner or repository override)');
    else if (!configured.some(([v, u]) => typeof u === 'number' && u >= v && L.evidence.includes(String(v)))) add('debate_limit_invalid', 'the configured budget was not reached, or the evidence does not name the configured value');
  } else if (!last || last.status === 'completed') add('debate_limit_invalid', `${L.kind} needs a last attempt with its actual status (failed, timeout, aborted or unavailable) and diagnostics`);
  else {
    const ev = L.evidence.trim();
    const hits = asList(lastDiag).filter((e) => e.text.includes(ev));
    const providerish = hits.some((e) => e.cls === 'provider');
    const resourceish = hits.some((e) => e.cls === 'resource');
    if (!hits.length) add('debate_limit_invalid', 'the limit evidence is not quoted from one retained diagnostic entry of the last attempt (the relay error, an error event or the dispatch error; never a counterpart message)');
    else {
      if (L.kind === 'provider_limit' && !providerish) add('debate_limit_invalid', 'provider_limit needs a diagnostic entry of the provider class (quota or rate limit only); EPERM or EACCES is a permission or resource limit, and an entry naming both is ambiguous');
      if (L.kind === 'resource_limit' && !resourceish) add('debate_limit_invalid', 'resource_limit needs a diagnostic entry of the resource class (permission, resource, kill or timeout only); an entry naming both is ambiguous');
    }
  }
}

/**
 * One round's retained evidence, by carrier kind. Failed or limited attempts keep their actual status; a success is
 * never fabricated: a completed relay round needs exit code 0 in the record and the result, every round is read-only,
 * and a completed round carries a non-empty session id bound to the result. Returns { diag, concessions }.
 */
function verifyRound(r, att, bundleDir, add) {
  const out = { diag: [], concessions: new Set() };
  const kind = att.carrier.kind;
  const files = isObject(r.files) ? r.files : {};
  const hashes = isObject(r.sha256) ? r.sha256 : {};
  if (r.read_only !== true) add('debate_carrier_invalid', `round ${r.n} is not recorded read_only: true`);
  if (r.status === 'completed' && !nonEmpty(r.session_id)) add('debate_carrier_invalid', `round ${r.n}: a completed round needs its non-empty session or thread id`);
  const read = (name) => {
    const rel = files[name];
    if (!relativeEvidence(rel)) { add('debate_attestation_invalid', `round ${r.n} ${name}: evidence paths are bundle-relative (no absolute path, no ..); out_dir is provenance only`); return null; }
    if (!bundleDir) { add('debate_evidence_missing', `round ${r.n} ${name}: no bundle root to resolve ${rel}`); return null; }
    const c = containedFile(bundleDir, rel);
    if (!c.path) { add(c.code, `round ${r.n} ${name}: ${c.why}`); return null; }
    const bytes = readFileSync(c.path);
    const want = hashes[name];
    if (sha256Of(bytes) !== want) add('debate_evidence_mismatch', `round ${r.n} ${name}: ${rel} does not match its recorded sha256`);
    return bytes;
  };
  const need = r.status !== 'completed' ? [] : kind === 'native_session' ? ['message'] : ['brief', 'result', 'events'];
  for (const n of need) if (!files[n]) add('debate_evidence_missing', `round ${r.n} is ${r.status} but has no ${n} evidence file`);
  const got = Object.fromEntries(Object.keys(files).map((n) => [n, read(n)]));
  if (r.status !== 'completed' && !files.result && !files.message) {
    const e = r.dispatch_error;
    if (!(isObject(e) && nonEmpty(e.class) && nonEmpty(e.text))) add('debate_evidence_missing', `round ${r.n} (${r.status}) has neither a result file nor dispatch-failure evidence {class, text}`);
    else out.diag = [{ text: e.text, cls: entryClass(e.text, e.class) }];
  }
  let text = null;
  if (got.result) {
    let res;
    try { res = JSON.parse(got.result.toString('utf8')); } catch { add('debate_evidence_mismatch', `round ${r.n}: result.json is not JSON`); return out; }
    out.diag = diagnosticEntries(res, got.events ? got.events.toString('utf8') : '');
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
    text = typeof res.finalMessage === 'string' ? res.finalMessage : '';
  } else if (got.message) {
    text = got.message.toString('utf8');
  }
  if (got.brief) {
    const b = briefFields(got.brief.toString('utf8'));
    if (b.request_id !== r.request_id || b.plan_version !== r.plan_version || (r.plan_digest && b.plan_digest !== r.plan_digest)) {
      add('debate_request_mismatch', `round ${r.n}: the brief that was sent carries request_id ${b.request_id}, plan_version ${b.plan_version}${r.plan_digest ? `, plan_digest ${b.plan_digest}` : ''}`);
    }
  }
  if (r.status !== 'completed' || text === null) return out;
  const echoed = parseHeader(text);
  if (!echoed.ok) { add('debate_echo_invalid', `round ${r.n}: ${echoed.why}`); return out; }
  if (echoed.verdict !== r.verdict) add('debate_echo_invalid', `round ${r.n} records verdict ${r.verdict}, the response says ${echoed.verdict}`);
  if (echoed.request_id !== r.request_id) add('debate_request_mismatch', `round ${r.n}: the response echoes request_id ${echoed.request_id}, not ${r.request_id} (a stale or foreign response)`);
  if (echoed.plan_version !== r.plan_version || (r.plan_digest && echoed.plan_digest !== r.plan_digest)) add('debate_request_mismatch', `round ${r.n}: the response echoes another plan_version or plan_digest`);
  out.concessions = echoed.concessions;
  return out;
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
  const lineFile = containedFile(bundleDir, 'attestation.line');
  if (!lineFile.path) { put(lineFile.code, `the retained bundle's attestation.line: ${lineFile.why}`); return; }
  if (!readFileSync(lineFile.path).equals(Buffer.from(got.line, 'utf8'))) { put('debate_evidence_mismatch', 'the retained attestation.line is not byte-identical to the plan line'); return; }
  const v = verifyDebate(planText, { bundleDir, repo });
  for (const e of v.errors) put(e.code, e.message);
  if (added || v.outcome === 'CONVERGED' || v.outcome === 'SKIPPED') return;
  const need = [...v.outstanding, ...(v.outcome === 'LIMIT_REACHED' ? ['LIMIT'] : [])];
  for (const id of need) {
    const p = dispositionProblem(id, v.byId.get(id), v.sec, v.rounds, digest);
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
    try {
      const lf = containedFile(dir, 'attestation.line');
      if (!lf.path || !readFileSync(lf.path).equals(line)) return false;
      return files.every((f) => { const c = containedFile(dir, f); return Boolean(c.path) && readFileSync(c.path).equals(readFileSync(join(from, ...f.split('/')))); });
    } catch { return false; }
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
      copyFileSync(join(from, ...f.split('/')), join(tmp, ...f.split('/')), fsConstants.COPYFILE_EXCL);
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
export function classifyProbe(o) {
  const pass = (detail) => ({ result: 'pass', detail });
  const no = (cls, detail) => ({ result: 'fail', class: cls, detail });
  const claude = o.carrier === 'claude';
  const bin = claude ? 'claude' : 'codex';
  const cli = o.cli_version ?? o.codex_version;
  const idOf = (res) => (claude ? res?.sessionId : res?.threadId);
  const readOnly = (res) => (claude ? res?.readOnly === true : res?.sandbox === 'read-only');
  const d = o.dispatch ?? {};
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
    : nonEmpty(id) && readOnly(d.result) && String(d.result.finalMessage ?? '').includes(`probe-ok ${o.nonce}`) ? pass(`readable result.json, status completed, read-only, new ${claude ? 'sessionId' : 'threadId'} ${id}`)
      : no('relay', `result.json lacks a ${claude ? 'sessionId' : 'threadId'}, is not read-only, or does not answer this probe's nonce`);
  const rs = o.resume ?? {};
  const resume = fresh_result.result !== 'pass' ? no(fresh_result.class, 'not reached: no fresh result to resume')
    : rs.spawn_error ? no(spawnClass(rs.spawn_error), `the resume could not be started (${rs.spawn_error})`)
      : !rs.result ? no('relay', 'the resume wrote no readable result.json')
        : rs.result.status !== 'completed' ? no(resultClass(rs.result), `the resume ended ${rs.result.status}`)
          : !readOnly(rs.result) ? no('relay', 'the resumed session is not read-only')
            : idOf(rs.result) !== id ? no('relay', `the resume returned ${idOf(rs.result)}, not ${id}`)
            : pass(`--session ${id} returned the same session`);
  const c = o.cancel ?? {};
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
    const noop = `This is a ship-ticket PLAN carrier probe. Do not read, run or change anything. Reply with exactly one line: probe-ok ${nonce}\n`;
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
      const { opts, positional } = parseFlags(rest, ['attestation']);
      if (!opts.attestation || positional.length) throw Object.assign(new Error('debate-serialize needs --attestation and takes no other argument'), { usage: true });
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
    throw Object.assign(new Error('usage: brief.mjs plan-digest --plan <plan.md> | brief.mjs start-check --plan <plan.md> --run-id <id> [--repo <dir>] | brief.mjs debate-check --plan <plan.md> --bundle <dir> --repo <dir> | brief.mjs debate-serialize --attestation <json> | brief.mjs debate-retain --plan <plan.md> --bundle <dir> --repo <dir> | brief.mjs debate-probe --relay <relay.mjs> --repo <dir> --out-dir <dir> [--carrier codex|claude] [--cli <bin>] [--busy-timeout <dur>] [--probe-timeout <dur>] | brief.mjs build --dag <dag.json> --node <id> --plan <plan.md> [--recon <json>] [--notes <file>] [--t0 <repo>/.ship-ticket/t0.json] [--test-kinds <require.json>] --out <file> | brief.mjs lint <brief>'), { usage: true });
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
