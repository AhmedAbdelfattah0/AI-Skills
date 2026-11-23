#!/usr/bin/env node

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { aggregate, buildRun, SUMMARY_SCHEMA } from './run-summary.mjs';
import { CEILING_METRICS, GAP_REASONS, IDENTITY_ACTIVITIES, REVIEW_ROLE_OF, SKILL_REVISION, STRING_METRICS, expectedReviewRoles } from './review-intervals.mjs';
import { CLI_EVENT_NAMES, CLOSABLE, RUN_LOG_SCHEMA as SCHEMA, committedLength, encodeEvent, encodeLoss, encodeRecords, fieldType, isEventName, readEvents, readLog } from './measure/events.mjs';
import { appendLocked, quarantineLocked, sidecarPath } from './run-log-io.mjs';
import { AUTH_SUBDIR, appendPreflight, commonLogDir, dirPreflight, isReservedTicket, labelLegacyRun, legacyLogDirs, legacyPresent, ownLogDir,
  ABANDON_NAME, LEGACY_READ_MAX, archiveTickets, isReservedInterval, readArchive } from './lib/run-log-paths.mjs';
import { processInfo } from './engine-quiesce.mjs';
import { hostname } from 'node:os';
import { isTimestamp } from './lib/shape.mjs';
import { isEntrypoint } from './harness.mjs';

const KINDS = new Set(['workflow', 'phase', 'activity', 'wait']);
/**
 * S5 repair: REVIEW authority stays per worktree, in `<git-path>/ai-skills/ship-ticket/review-auth/<ticket>.jsonl`
 * (lib/run-log-paths AUTH_SUBDIR; no ticket name can address a subdirectory). `.review-auth` is only the suffix of the first
 * repair's files: they are skipped as tickets and read by nothing.
 */
const AUTH_TAG = '.review-auth';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_METRIC = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** A refusal. `fail` throws it; the CLI entry point prints `run-log: <message>` and exits 1, and `batch` reports it per op. */
class RunLogError extends Error {}
function fail(message) {
  throw new RunLogError(message);
}
/** Diagnostics on stderr; silenced while `batch` validates its ops (the same op writes them once, when it is applied). */
let quiet = false;
const note = (text) => { if (!quiet) process.stderr.write(text); };

function usage() {
  return `Usage:
  run-log.mjs start --repo <path> --ticket <key> --run-id <id> --kind <kind> --name <name> --event-id <id> [--metric key=value ...] [--started-at <iso>]
  run-log.mjs end   --repo <path> --ticket <key> --run-id <id> --kind <kind> --name <name> --event-id <id> [--outcome <value>] [--metric key=value ...] [--metrics-from <carrier-result.json>] [--ended-at <iso>]
  run-log.mjs batch --repo <path> --ticket <key> --run-id <id> --ops-file <path|->
  run-log.mjs check --repo <path> [--ticket <key>]
  run-log.mjs abandon --repo <path> --ticket <key> --run-id <id> [--reason old_build_unavailable|superseded|unknown]
  run-log.mjs legacy --repo <path> [--ticket <key>]
  run-log.mjs event --repo <path> --ticket <key> --run-id <id> --name <event> [--event-id <id>] [--metric key=value ...] [--detail <json>] [--started-at <iso> --ended-at <iso>]
  run-log.mjs close --repo <path> --ticket <key> --run-id <id> --through <iso> --final true|false --count-source orchestrator_tally|posthoc --count <kind>=<n> ...
  run-log.mjs quarantine --repo <path> --ticket <key>
  run-log.mjs summary --repo <path> (--ticket <key> | --all)

Kinds: workflow, phase, activity, wait
Location (S5): <git-common-dir>/ai-skills/ship-ticket/<ticket>.jsonl, one file for every worktree of the repository: the ONLY
runtime telemetry source. A linked worktree's pre-S5 log (git rev-parse --git-path ai-skills/ship-ticket) is a read-only archive:
no reader merges it; its presence is counted (legacy_present, own worktree only) and the legacy command prints it for audit.
abandon: record in the shared log that a run started in this worktree's pre-S5 log was abandoned (never a success).
batch: JSON ops [{op:"start"|"end", kind, name, event_id, outcome?, metrics?:{k:v}}], validated first, applied in order, not atomic.
check: read-only preflight, one JSON line {ok, resolved_dir, legacy_logs, degraded?, reason?}; exit 1 is a declared degradation.
A REVIEW phase start is also written to <git-path>/ai-skills/ship-ticket/review-auth/<ticket>.jsonl (REPAIR authority, per worktree).
--started-at/--ended-at on start/end: strict UTC ISO, within now+5s..now-24h, never earlier than a recorded row of the run;
the row is labelled timestamp_source=supplied, label=estimated. event --started-at/--ended-at take the same now-window bounds.
Measurement events (S-04c-design 1.2; validated, closed vocabularies, label=measured|estimated required): ${CLI_EVENT_NAMES.join(', ')}.
start/end refuse these names. event writes one start/end pair in one append; event_id is derived where the event has an identity.
A fallback or recovery run is recorded by hand: event --name run_mode --metric mode=fallback|recovery --metric label=measured.
Every write takes <log>.lock (waits up to 10 s) and validates the whole resulting log; an invalid log refuses every write.
A torn tail (bytes after the last newline) is moved to <log>.lost-<offset>-<sha>[-<layout>].json and a log_loss record is written in its place.
quarantine moves every line that makes writers refuse (undecodable, malformed or invalid lines, ticket mismatches, orphan ends,
duplicate starts, invalid pairs; and a torn tail) the same way, to a fixed point, so writes can resume.
close records an orchestrator closure (label estimated) with explicit counts: <kind> in ${CLOSABLE.filter((k) => k !== 'usage').join(', ')}, or usage.<provider>.
Review timing: the start of a review activity or of the REVIEW phase requires candidate_id and
review_execution (refused without them). A REVIEW phase start also takes skill_revision and four *_ceiling_ms
metrics; when absent or invalid they are recorded as unknown, never refused. gap_reason=no_start_stamp|wait|host_sleep|unknown
names unaccounted time. Summary reports missing_review_intervals (count or "unknown").
Optional start/end: --carrier-result <result.json> binds a fresh relay result at
dispatch and imports its timing on completion. Start requires candidate_id and
review_execution=review-<id> metrics. Summary schema v2; raw events stay v1.
`;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const command = argv[0];
  const options = { metric: [], count: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--all') {
      options.all = true;
      continue;
    }
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${token} requires a value`);
    index += 1;
    if (key === 'metric' || key === 'count') options[key].push(value);
    else if (options[key] !== undefined) fail(`${token} may be supplied only once`);
    else options[key] = value;
  }
  if (options['metrics-from'] !== undefined) {
    // A harness carrier result carries provider-reported counters as ready-made key=value
    // pairs; importing them avoids shell word-splitting a metrics string (zsh does not).
    if (command !== 'end') fail('--metrics-from is supported on end only');
    let result;
    try { result = JSON.parse(readFileSync(resolve(options['metrics-from']), 'utf8')); }
    catch { fail('--metrics-from must name a readable carrier result JSON file'); }
    const pairs = result?.run_log_metrics;
    if (!Array.isArray(pairs) || !pairs.every((pair) => typeof pair === 'string')) {
      fail('--metrics-from file has no run_log_metrics string array');
    }
    options.metric.push(...pairs);
    delete options['metrics-from'];
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value) fail(`--${key.replaceAll('_', '-')} is required`);
  return value;
}

function validateId(label, value) {
  if (!SAFE_ID.test(value)) {
    fail(`${label} must match ${SAFE_ID} and be at most 128 characters`);
  }
  // <ticket>.engine.jsonl is the run engine's event file: ticket X.engine's timing log would be ticket X's.
  if (label === 'ticket' && value.endsWith('.engine')) fail('ticket must not end in .engine (reserved for the run engine event file)');
  if (label === 'ticket' && isReservedTicket(value)) fail('ticket is reserved (compared case-insensitively: a .engine or .review-auth suffix, review-auth, excluded)');
  return value;
}

function parseMetricValue(raw) {
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) fail('a numeric metric value must be a finite number');
    return n;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw.includes('\n') || raw.includes('\r') || raw.length > 512) {
    fail('metric values must be single-line and at most 512 characters');
  }
  return raw;
}

function stringMetric(raw) {
  if (raw.includes('\n') || raw.includes('\r') || raw.length > 512) fail('metric values must be single-line and at most 512 characters');
  return raw;
}

/**
 * END-path review telemetry that is validated but must never refuse the end: a refused end leaves its interval (a REVIEW phase
 * open forever). An invalid, over-long, multi-line or repeated value is recorded as `unknown` with a stderr diagnostic.
 * Identity metrics (candidate_id, review_execution) stay strict: they are bindings, not telemetry.
 */
const LENIENT_END_KEYS = Object.freeze(['gap_reason', 'skill_revision']);
function lenientEndMetric(metrics, key, value) {
  const valid = key === 'gap_reason' ? GAP_REASONS.includes(value) : SKILL_REVISION.test(value);
  const repeated = Object.hasOwn(metrics, key);
  if (valid && !repeated) { metrics[key] = value; return; }
  metrics[key] = 'unknown';
  const why = repeated ? 'repeated' : key === 'gap_reason' ? `not one of: ${[...GAP_REASONS].join(', ')}` : 'not a valid revision';
  note(`run-log: ${key} recorded as unknown (${why}; got ${JSON.stringify(value.slice(0, 40))})\n`);
}

function parseMetrics(values, { lenientGap = false } = {}) {
  const metrics = {};
  for (const item of values) {
    const separator = item.indexOf('=');
    if (separator < 1) fail(`invalid metric ${item}; expected key=value`);
    const key = item.slice(0, separator);
    const value = item.slice(separator + 1);
    if (!SAFE_METRIC.test(key)) fail(`invalid metric key: ${key}`);
    if (lenientGap && LENIENT_END_KEYS.includes(key)) { lenientEndMetric(metrics, key, value); continue; }
    if (Object.hasOwn(metrics, key)) fail(`duplicate metric key: ${key}`);
    metrics[key] = STRING_METRICS.includes(key) ? stringMetric(value) : parseMetricValue(value);
    if (key === 'gap_reason' && !GAP_REASONS.includes(metrics[key])) fail(`gap_reason must be one of: ${[...GAP_REASONS].join(', ')}`);
    if (['review_execution', 'previous_review_execution'].includes(key)
      && (typeof metrics[key] !== 'string' || !/^review-[A-Za-z0-9._-]+$/.test(metrics[key]))) {
      fail(`${key} must be a prefixed review-<opaque> ID`);
    }
  }
  return metrics;
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

/**
 * S5 (F05, cutover): `directory` is the ONE shared log directory of the repository (`<git-common-dir>/ai-skills/ship-ticket`),
 * the only place this script reads and writes telemetry. `legacy` is this worktree's pre-S5 directory (`--git-path`), or null
 * where it is the common dir (the main checkout). Normal commands only COUNT its log (legacy_present, lstat plus a bounded
 * read); `legacy` prints it for audit. No sibling worktree's directory is ever resolved here.
 */
function locations(repo) {
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  try {
    const directory = commonLogDir(repo);
    return { root, directory, legacy: legacyLogDirs(repo).own, authDir: ownLogDir(repo) };
  } catch (error) { return fail(error.message); }
}

function logPath(directory, ticket) {
  return join(directory, `${ticket}.jsonl`);
}
/** `<ticket>.jsonl` or `<ticket>.review-auth.jsonl` -> the ticket. */
function ticketOfPath(path) {
  const name = basename(path, '.jsonl');
  return name.endsWith(AUTH_TAG) ? name.slice(0, -AUTH_TAG.length) : name;
}

/**
 * Legacy rows of a log. A writer (not tolerant) reads the R11 committed prefix: a torn tail or torn record is no longer
 * history, and the next append truncates it. `summary` (tolerant) reads every byte, as before.
 */
function readRows(path, tolerant = false, { pairing = true } = {}) {
  if (!existsSync(path)) return { rows: [], warnings: [], buf: Buffer.alloc(0) };
  const buf = readFileSync(path);
  const { rows, warnings } = rowsFromText((tolerant ? buf : buf.subarray(0, committedLength(buf))).toString('utf8'), path);
  const refusing = pairing ? warnings : warnings.filter((w) => w.run_id === undefined);
  if (!tolerant && refusing.length) fail(`${path}: unsafe log history (${refusing[0].code}); left unchanged`);
  return { rows, warnings, buf };
}

/** Pairing (integrity) warnings of a legacy row set, per run: the check rowsFromText applies to one file. */
function pairWarnings(rows) {
  const byRun = new Map();
  for (const row of rows) {
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
    byRun.get(row.run_id).push(row);
  }
  const warnings = [];
  for (const [id, runRows] of byRun) {
    warnings.push(...buildRun('', id, runRows).integrity_warnings
      .map((warning) => ({ ...warning, run_id: id })));
  }
  return warnings;
}

/** This worktree's pre-S5 log of `ticket`: counted only (lib/run-log-paths legacyPresent), never read into a figure. */
const ownLegacy = (loc, ticket) => (loc.legacy ? legacyPresent(loc.legacy, ticket) : { files: 0 });
/**
 * Rows written in a worktree that still has a pre-S5 log of the ticket carry `legacy_worktree: true`: such a run may have
 * history in that archive that no figure includes (readers label it `partial_legacy: possible`).
 */
function markLegacyWorktree(loc, ticket, metrics) {
  if (ownLegacy(loc, ticket).files) metrics.legacy_worktree = true;
}

/**
 * The writer's view of a ticket: the shared log only, which must be clean (line by line and paired) exactly as a single
 * pre-S5 log had to be. `eventRows` are its S-04 rows (for the never-backdate rule).
 */
function writerRows(loc, ticket) {
  const path = logPath(loc.directory, ticket);
  const own = readRows(path);
  return { path, rows: own.rows, eventRows: readEvents(own.buf).events.flatMap((e) => [e.start, e.end]) };
}

/** The legacy row set of a log text and its warnings. S-04 event rows are not legacy rows: measure/events.mjs readEvents checks them. */
function rowsFromText(contents, path) {
  const rows = [];
  const warnings = [];
  if (contents && !contents.endsWith('\n')) warnings.push({ code: 'incomplete_tail' });
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (isEventName(row?.name)) continue;
      if (row?.schema !== SCHEMA) throw new Error('unsupported_schema');
      if (!['start', 'end'].includes(row.event) || !KINDS.has(row.kind)
        || !['ticket', 'run_id', 'event_id', 'name'].every((key) => typeof row[key] === 'string' && SAFE_ID.test(row[key]))
        || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))
        || !row.metrics || typeof row.metrics !== 'object' || Array.isArray(row.metrics)
        || (row.event === 'end' && (!Number.isFinite(row.duration_ms) || row.duration_ms < 0 || typeof row.outcome !== 'string'))) {
        throw new Error('invalid_record');
      }
      if (Object.hasOwn(row, 'carrier_timing') && !validCarrierTiming(row.carrier_timing, row.timestamp)) throw new Error('invalid_carrier_timing');
      if (row.ticket !== ticketOfPath(path)) throw new Error('ticket_mismatch');
      rows.push(row);
    } catch (error) {
      warnings.push({ line: index + 1, code: error instanceof SyntaxError ? 'invalid_json' : error.message });
    }
  }
  // Pairing errors are integrity errors too: writers must not append into an
  // ambiguous history even if every individual line parses successfully.
  warnings.push(...pairWarnings(rows));
  return { rows, warnings };
}

function validCarrierTiming(timing, collectedAt) {
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return false;
  const start = Date.parse(timing.started_at);
  const end = Date.parse(timing.ended_at);
  return timing.source === 'relay_result' && ['claude', 'codex'].includes(timing.tool)
    && ['completed', 'failed', 'timeout', 'aborted', 'claude_unavailable', 'codex_unavailable'].includes(timing.status)
    && typeof timing.result_sha256 === 'string' && /^[a-f0-9]{64}$/.test(timing.result_sha256)
    && typeof timing.candidate_id === 'string' && SAFE_ID.test(timing.candidate_id)
    && typeof timing.review_execution === 'string' && /^review-[A-Za-z0-9._-]+$/.test(timing.review_execution)
    && typeof timing.started_at === 'string' && typeof timing.ended_at === 'string'
    && Number.isFinite(start) && Number.isFinite(end) && end >= start
    && end <= Date.parse(collectedAt) && timing.duration_ms === end - start
    && timing.collection_delay_ms === Date.parse(collectedAt) - end;
}

function carrierBinding(options, metrics) {
  if (!options['carrier-result']) return undefined;
  if (typeof metrics.candidate_id !== 'string' || !SAFE_ID.test(metrics.candidate_id)
    || typeof metrics.review_execution !== 'string' || !/^review-[A-Za-z0-9._-]+$/.test(metrics.review_execution)) {
    fail('--carrier-result requires candidate_id and prefixed review_execution metrics at dispatch');
  }
  const path = resolve(options['carrier-result']);
  if (existsSync(path)) fail('carrier result path must be fresh at dispatch');
  return { result_path: path, candidate_id: metrics.candidate_id, review_execution: metrics.review_execution };
}

function importCarrier(options, started, root, timestamp) {
  if (!options['carrier-result']) return null;
  const binding = started.carrier_binding;
  if (!binding || resolve(options['carrier-result']) !== binding.result_path) fail('carrier result must match the path bound at dispatch');
  let bytes, result;
  try { bytes = readFileSync(binding.result_path); result = JSON.parse(bytes); }
  catch { fail('carrier result is missing or invalid JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('carrier result must be an object');
  const tool = result.tool === 'claude' ? 'claude' : !result.tool && typeof result.codexVersion === 'string' ? 'codex' : null;
  const readOnly = tool === 'claude' ? result.readOnly === true : result.sandbox === 'read-only';
  if (result.schema !== 'delegate-relay.result.v1' || !tool
    || !['completed', 'failed', 'timeout', 'aborted', 'claude_unavailable', 'codex_unavailable'].includes(result.status)
    || typeof result.workdir !== 'string' || !existsSync(result.workdir)
    || realpathSync(result.workdir) !== realpathSync(root) || !readOnly) {
    fail('unsupported carrier result or mismatched repository/read-only binding');
  }
  const start = Date.parse(result.startedAt), end = Date.parse(result.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < Date.parse(started.timestamp)
    || end < start || end > timestamp.getTime()) fail('invalid carrier execution timestamps');
  // Import only timing and enum metadata, never model output or credential-bearing paths.
  return { source: 'relay_result', tool, status: result.status,
    result_sha256: createHash('sha256').update(bytes).digest('hex'),
    candidate_id: binding.candidate_id, review_execution: binding.review_execution,
    started_at: result.startedAt, ended_at: result.finishedAt,
    duration_ms: end - start, collection_delay_ms: timestamp.getTime() - end };
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const unsafe = (path, why) => Object.assign(new Error(`${path}: ${why}; left unchanged`), { code: 'unsafe_history' });
/**
 * I1/I3: the whole log as it will be after a write must be clean: strict UTF-8, every legacy row valid under the legacy rules,
 * every S-04 record a valid pair, no malformed line and no torn tail. Throws a typed `unsafe_history` error.
 */
function assertCleanLog(bytes, path) {
  let text;
  try { text = strictUtf8.decode(bytes); } catch { throw unsafe(path, 'the log is not valid UTF-8 (recovery: run-log.mjs quarantine)'); }
  const { warnings } = rowsFromText(text, path);
  if (warnings.length) throw unsafe(path, `unsafe log history (${warnings[0].code})`);
  const { lost } = readEvents(bytes);
  const bad = Object.entries(lost).filter(([k, n]) => n && !['loss_records', 'recovered_bytes'].includes(k));
  if (bad.length) throw unsafe(path, `unsafe measurement history (${bad.map(([k, n]) => `${k}=${n}`).join(', ')}; recovery: run-log.mjs quarantine)`);
}
/**
 * The single write path of <ticket>.jsonl: records pass the encodeRecords choke point (an S-04 row only from encodeEvent),
 * then one locked append whose WHOLE resulting file passes assertCleanLog (I1). A torn tail from an interrupted earlier write
 * is moved to a sidecar with a `log_loss` record in the same write (I2). `check(eventEndRows)` sees the committed S-04 events.
 */
async function appendRows(directory, ticket, records, check, { guard, suffix = '.jsonl' } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${ticket}${suffix}`), now = new Date().toISOString();
  const { lost } = await appendLocked(path, encodeRecords(records), { marker: (info) => encodeRecords([encodeLoss(ticket, info, now)]),
    // The guard (stamp, window) runs first, so a stamp overtaken by a concurrent writer is re-stamped; then the whole
    // resulting file is validated.
    check: (after, before) => { if (guard) guard(before); assertCleanLog(after, path);
      if (check) check(readEvents(before).events.map((e) => e.end));
    } });
  if (lost) process.stderr.write(`run-log: moved ${lost.bytes} byte(s) of a torn tail to ${sidecarPath(path, lost)} and recorded log_loss\n`);
}
const failOnError = (promise) => promise.catch((error) => fail(error.message));

function intervalOptions(options) {
  const ticket = validateId('ticket', requireOption(options, 'ticket'));
  const runId = validateId('run id', requireOption(options, 'run-id'));
  const kind = requireOption(options, 'kind');
  if (!KINDS.has(kind)) fail(`--kind must be one of: ${[...KINDS].join(', ')}`);
  const name = validateId('name', requireOption(options, 'name'));
  if (isEventName(name)) fail(`${name} is a measurement event: use run-log.mjs event`);
  const eventId = validateId('event id', requireOption(options, 'event-id'));
  if (isReservedInterval(name, eventId)) fail(`${name}/${eventId} is reserved (legacy_abandoned, legacy-abandoned*; case-insensitive): use run-log.mjs abandon`);
  return { ticket, runId, kind, name, eventId };
}

/**
 * Review-start metrics (A0.1). Only the identity binding (candidate_id, review_execution) is refused when missing:
 * REPAIR authorization reads the REVIEW phase start row, so telemetry must never stop that row from being written.
 * A REVIEW phase start with a missing or invalid skill_revision or ceiling is written with skill_revision=unknown
 * and the bad ceilings absent; summary and eval then report them as unknown.
 */
function validateReviewStart(interval, metrics) {
  const activity = interval.kind === 'activity' && IDENTITY_ACTIVITIES.includes(interval.name);
  const phase = interval.kind === 'phase' && interval.name === 'REVIEW';
  if (!activity && !phase) return;
  const label = `${interval.kind} ${interval.name}`;
  if (typeof metrics.candidate_id !== 'string' || !SAFE_ID.test(metrics.candidate_id)) fail(`${label} start requires a candidate_id metric`);
  if (typeof metrics.review_execution !== 'string') fail(`${label} start requires a review_execution=review-<id> metric`);
  if (!phase) return;
  const noted = [];
  if (typeof metrics.skill_revision !== 'string' || !SKILL_REVISION.test(metrics.skill_revision)) {
    noted.push('skill_revision');
    metrics.skill_revision = 'unknown';
  }
  for (const key of CEILING_METRICS) {
    if (Number.isInteger(metrics[key]) && metrics[key] >= 0) continue;
    noted.push(key);
    delete metrics[key];
  }
  if (noted.length) note(`run-log: recorded as unknown (not refused): ${noted.join(', ')}\n`);
}

/** Review intervals with no closed start/end pair; `unknown` without review_execution ids (built on review-intervals.mjs). */
function missingReviewIntervals(run) {
  const rounds = expectedReviewRoles(run);
  if (rounds === 'unknown') return { count: 'unknown', items: [] };
  const items = [];
  for (const { review_execution: id, roles } of rounds) {
    for (const { role, expected, closed, open } of roles) {
      for (let k = closed; k < expected; k += 1) items.push({ review_execution: id, role, reason: k - closed < open ? 'open_without_end' : 'no_start_end_pair' });
    }
  }
  return { count: items.length, items };
}

/**
 * Supplied timestamps (S5, D1). `start --started-at` / `end --ended-at` record an interval boundary that was not stamped
 * when it happened. They are self-asserted, so they are bounded against the clock AT WRITE TIME and labelled: the row
 * gets `timestamp_source: 'supplied'` and `label: 'estimated'` (a default row is unchanged and carries neither key).
 * Bounds: strict UTC ISO-8601; not after now + 5 s; not before now - 24 h; and never earlier than any row already
 * recorded for the run (legacy or S-04, in the common or the own legacy log), so a supplied stamp never backdates
 * recorded history. An end's start is a row of its run, so an end is never before its start.
 */
const FUTURE_SLACK_MS = 5000;
const PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
function suppliedMs(raw, flag) {
  if (!isTimestamp(raw)) fail(`${flag} must be a strict UTC ISO-8601 timestamp such as 2026-01-01T00:00:00.000Z`);
  return Date.parse(raw);
}
function inWindow(ms, flag, now = Date.now()) {
  if (ms > now + FUTURE_SLACK_MS) fail(`${flag} must be within ${FUTURE_SLACK_MS / 1000} s of now or earlier (it is in the future)`);
  if (ms < now - PAST_WINDOW_MS) fail(`${flag} must be within the last 24 h`);
}
/**
 * The history a stamp is ordered against: the latest instant of the rows of `runId` in the given lists, counting only rows
 * up to `now` + 5 s. A later row ("future history", for example a hand-seeded or clock-skewed 2999 stamp) is kept and
 * reported (check, integrity), never adopted: ordering holds only within the 5 s skew bound. -Infinity when none.
 */
function recordedOf(runId, now, ...lists) {
  let latest = -Infinity;
  for (const list of lists) for (const row of list) {
    if (row?.run_id !== runId) continue;
    const ms = Date.parse(row.timestamp);
    if (Number.isFinite(ms) && ms <= now + FUTURE_SLACK_MS && ms > latest) latest = ms;
  }
  return latest;
}
/** Runs with a row later than now + 5 s (future history), over the given row lists. */
function futureRuns(lists, now = Date.now()) {
  const runs = new Set();
  for (const list of lists) for (const row of list) if (Date.parse(row?.timestamp) > now + FUTURE_SLACK_MS) runs.add(row.run_id);
  return runs.size;
}
/** The rows of the common log as they are inside the lock (`before`): legacy rows and S-04 rows. */
const lockedRows = (before, path) => {
  const text = before.subarray(0, committedLength(before)).toString('utf8');
  return [...rowsFromText(text, path).rows, ...readEvents(before).events.flatMap((e) => [e.start, e.end])];
};
const RESTAMP = 'restamp';
const STAMP_ATTEMPTS = 5;
/**
 * The timestamp of a new start/end row of `runId`, and the guard that re-checks it INSIDE the log lock. run-log-io takes the
 * bytes before it takes the lock, so the stamp is computed from the file as read, and `guard(before)` then validates it
 * against the exact bytes the row is appended after, at the moment of writing: the supplied window (now + 5 s, now - 24 h)
 * and never earlier than a recorded row of the run (history capped at now + 5 s). A supplied stamp that fails there is
 * refused (zero rows). A clock stamp overtaken by a concurrent writer throws `restamp`: the caller re-reads, re-stamps and
 * retries (up to 5 attempts). So the bytes appended are always the bytes checked under the lock.
 * `floor` (an end: its start) is never capped, because an end before its own start is not an interval.
 */
function stampFor(view, runId, raw, flag, floor = -Infinity) {
  const now = Date.now();
  const recorded = Math.max(recordedOf(runId, now, view.rows, view.eventRows), floor);
  const supplied = raw !== undefined;
  let ms;
  if (!supplied) ms = Math.max(now, recorded); // recorded <= now + 5 s: the raise is capped
  else {
    ms = suppliedMs(raw, flag);
    inWindow(ms, flag, now);
    if (ms < recorded) fail(`${flag} ${raw} is earlier than a row already recorded for run ${runId} (${new Date(recorded).toISOString()}); supplied timestamps never backdate recorded history`);
  }
  const guard = (before) => {
    const at = Date.now();
    if (supplied) inWindow(ms, flag, at);
    const latest = Math.max(recordedOf(runId, at, lockedRows(before, view.path)), floor);
    if (ms >= latest) return;
    if (supplied) throw new Error(`${flag} ${raw} is earlier than a row recorded for run ${runId} meanwhile; nothing written`);
    throw Object.assign(new Error(`a row of run ${runId} was recorded while this one waited; re-stamping`), { code: RESTAMP });
  };
  return { at: new Date(ms), supplied, guard };
}
const suppliedKeys = (stamp) => (stamp.supplied ? { timestamp_source: 'supplied', label: 'estimated' } : {});

/** Append `records` with `stamp.guard` in the lock; a `restamp` refusal re-runs `attempt` (re-read, re-stamp) up to 5 times. */
async function appendStamped(attempt) {
  for (let n = 1; ; n += 1) {
    const { directory, ticket, records, guard, after } = attempt();
    if (!records.length) return after();
    try { await appendRows(directory, ticket, records, undefined, { guard }); }
    catch (error) {
      if (error?.code === RESTAMP && n < STAMP_ATTEMPTS) continue;
      fail(error.message);
    }
    return after();
  }
}

/** S5 repair: the per-worktree REVIEW authority copy of a REVIEW phase start (carrier REPAIR reads only this, never the shared log). */
/**
 * Whether an append to `path` can succeed, read-only: lib/run-log-paths appendPreflight mirrors appendRows' operations
 * (mkdir -p of the directory, `<path>.lock` created in it, `<path>` opened for append), plus how the lock module would
 * treat an existing `<path>.lock`. null when it can; else the reason. ONE decision for `check`, batch prevalidation, the
 * single `start` of a REVIEW phase and the authority copy itself (repair 4).
 */
function writableTarget(path) {
  return appendPreflight(path) ?? lockHealth(`${path}.lock`).refuse ?? null;
}
const isReviewStart = (op) => op.op === 'start' && op.kind === 'phase' && op.name === 'REVIEW';
const authorityPath = (loc, ticket) => join(loc.authDir, AUTH_SUBDIR, `${ticket}.jsonl`);

/** A REVIEW start's authority copy must be possible BEFORE its shared row is written (same decision as the copy). */
function preflightAuthority(loc, ticket) {
  const why = writableTarget(authorityPath(loc, ticket));
  if (why) fail(`the REVIEW authority copy cannot be written: ${why}; nothing written`);
}

async function writeAuthority(loc, row) {
  if (row.kind !== 'phase' || row.name !== 'REVIEW' || row.event !== 'start') return;
  try {
    const why = writableTarget(authorityPath(loc, row.ticket));
    if (why) throw new Error(why);
    await appendRows(join(loc.authDir, AUTH_SUBDIR), row.ticket, [row]);
  }
  catch (error) {
    // Truthful accounting (repair 3): the shared row HAS committed. It is not retried (a retry would be a duplicate), and no
    // step re-copies it: which worktree wrote a shared row is not recorded, so a re-copy would be a new authority source.
    throw Object.assign(new RunLogError(`committed_shared=true authority_copy=failed: the REVIEW start ${row.event_id} is in the shared log, but its per-worktree authority copy failed (${error.message}); REPAIR stays unauthorised: record a fresh REVIEW start with a new event id (same review_execution)`), { committedShared: true });
  }
}

async function start(options, { print = true, loc: given } = {}) {
  const repo = requireOption(options, 'repo');
  if (options['ended-at'] !== undefined) fail('--ended-at is an end option (start takes --started-at)');
  const loc = given ?? locations(repo);
  const { directory } = loc;
  const interval = intervalOptions(options);
  const metrics = parseMetrics(options.metric);
  validateReviewStart(interval, metrics);
  markLegacyWorktree(loc, interval.ticket, metrics);
  const binding = carrierBinding(options, metrics);
  if (interval.kind === 'phase' && interval.name === 'REVIEW') preflightAuthority(loc, interval.ticket);
  const row = await appendStamped(() => {
    const view = writerRows(loc, interval.ticket);
    const duplicate = view.rows.find(
      (r) => r.run_id === interval.runId && r.event_id === interval.eventId,
    );
    if (duplicate) fail(`event ${interval.eventId} already exists in run ${interval.runId}`);
    const stamp = stampFor(view, interval.runId, options['started-at'], '--started-at');
    const next = {
      schema: SCHEMA,
      ticket: interval.ticket,
      run_id: interval.runId,
      event: 'start',
      event_id: interval.eventId,
      kind: interval.kind,
      name: interval.name,
      timestamp: stamp.at.toISOString(),
      ...suppliedKeys(stamp),
      metrics,
      ...(binding ? { carrier_binding: binding } : {}),
    };
    return { directory, ticket: interval.ticket, records: [next], guard: stamp.guard, after: () => next };
  });
  await writeAuthority(loc, row);
  if (print) process.stdout.write(`${JSON.stringify(row)}\n`);
  return row;
}

async function end(options, { print = true, loc: given } = {}) {
  const repo = requireOption(options, 'repo');
  if (options['started-at'] !== undefined) fail('--started-at is a start option (end takes --ended-at)');
  const loc = given ?? locations(repo);
  const { directory, root } = loc;
  const interval = intervalOptions(options);
  let replay = null;
  const row = await appendStamped(() => {
    const view = writerRows(loc, interval.ticket);
    const matching = view.rows.filter(
      (r) => r.run_id === interval.runId && r.event_id === interval.eventId,
    );
    const started = matching.find((r) => r.event === 'start');
    if (!started) {
      const legacy = ownLegacy(loc, interval.ticket);
      // Cutover (AC2-C): a run started in this worktree's pre-S5 log is not in the shared log and is never merged into it.
      if (legacy.files) fail(`event ${interval.eventId} has no start in the shared log; this worktree has a pre-S5 log (${legacy.path}, ${legacy.lines} lines). A run started there cannot be ended by this version: close it with the build that started it, or record that it was abandoned with "run-log.mjs abandon --repo ${repo} --ticket ${interval.ticket} --run-id ${interval.runId}"`);
      fail(`event ${interval.eventId} has no start in run ${interval.runId}`);
    }
    if (started.kind !== interval.kind || started.name !== interval.name) {
      fail(`event ${interval.eventId} must end with its original kind and name`);
    }
    const startedAt = Date.parse(started.timestamp);
    if (!Number.isFinite(startedAt)) fail(`event ${interval.eventId} has an invalid start timestamp`);
    if (options['ended-at'] !== undefined && suppliedMs(options['ended-at'], '--ended-at') < startedAt) {
      fail(`--ended-at ${options['ended-at']} is before the start of ${interval.eventId} (${started.timestamp})`);
    }
    const stamp = stampFor(view, interval.runId, options['ended-at'], '--ended-at', startedAt);
    const timestamp = stamp.at;
    const timing = importCarrier(options, started, root, timestamp);
    const previous = matching.find((r) => r.event === 'end');
    if (previous) {
      if (timing && previous.carrier_timing?.result_sha256 === timing.result_sha256
        && (options.outcome === undefined || options.outcome === previous.outcome)
        && options.metric.length === 0) {
        replay = previous;
        return { directory, ticket: interval.ticket, records: [], guard: undefined, after: () => previous };
      }
      fail(`event ${interval.eventId} already ended in run ${interval.runId}`);
    }
    const metrics = parseMetrics(options.metric, { lenientGap: true });
    markLegacyWorktree(loc, interval.ticket, metrics);
    for (const key of ['candidate_id', 'review_execution']) {
      if (metrics[key] !== undefined && metrics[key] !== started.metrics[key]) fail(`${key} cannot change within an interval`);
    }
    const next = {
      schema: SCHEMA,
      ticket: interval.ticket,
      run_id: interval.runId,
      event: 'end',
      event_id: interval.eventId,
      kind: interval.kind,
      name: interval.name,
      timestamp: timestamp.toISOString(),
      ...suppliedKeys(stamp),
      duration_ms: Math.max(0, timestamp.getTime() - startedAt),
      outcome: options.outcome ?? 'complete',
      metrics,
      ...(timing ? { carrier_timing: timing } : {}),
    };
    return { directory, ticket: interval.ticket, records: [next], guard: stamp.guard, after: () => next };
  });
  if (print) process.stdout.write(`${JSON.stringify(replay ?? row)}\n`);
  return replay ?? row;
}
/** One measurement event (or a closure from `close`): encoded by encodeEvent, refused on a duplicate (run, event_id). */
async function writeEvent(options, name, metrics, detail) {
  const loc = locations(requireOption(options, 'repo'));
  const { directory } = loc;
  const ticket = validateId('ticket', requireOption(options, 'ticket'));
  const runId = validateId('run id', requireOption(options, 'run-id'));
  const now = new Date().toISOString();
  const endedAt = options['ended-at'] ?? now, startedAt = options['started-at'] ?? endedAt;
  let encoded;
  try { encoded = encodeEvent({ ticket, runId, eventId: options['event-id'], name, metrics, detail, startedAt, endedAt }); } catch (error) { fail(error.message); }
  // S5 (D2): a supplied --started-at/--ended-at is bounded against the clock at write time like start/end (now + 5 s, now - 24 h).
  // Measurement events keep their own label (measured|estimated) and may overlap earlier rows (concurrent lanes), so the
  // never-backdate rule of start/end does not apply here.
  const supplied = ['started-at', 'ended-at'].filter((flag) => options[flag] !== undefined);
  for (const flag of supplied) inWindow(Date.parse(options[flag]), `--${flag}`, Date.parse(now));
  const id = JSON.parse(encoded.text.slice(0, encoded.text.indexOf('\n'))).event_id;
  // AC15 (repair 6): the abandon event id prefix is reserved for every writer, event and close included (case-insensitive).
  if (isReservedInterval('', options['event-id'] ?? '') || isReservedInterval('', id)) fail(`${options['event-id'] ?? id} is reserved (legacy-abandoned*; case-insensitive): use run-log.mjs abandon`);
  await failOnError(appendRows(directory, ticket, [encoded], (rows) => {
    if (rows.some((row) => row.run_id === runId && row.event_id === id)) throw new Error(`event ${id} already exists in run ${runId}`);
  }, { guard: () => { for (const flag of supplied) inWindow(Date.parse(options[flag]), `--${flag}`); } }));
  process.stdout.write(encoded.text);
}

const typed = (raw, type) => (type === 'int' && /^-?(?:0|[1-9]\d*)$/.test(raw) ? Number(raw)
  : type === 'boolean' && (raw === 'true' || raw === 'false') ? raw === 'true' : raw);

async function eventCommand(options) {
  const name = requireOption(options, 'name');
  if (!CLI_EVENT_NAMES.includes(name)) fail(`--name must be one of: ${CLI_EVENT_NAMES.join(', ')} (closures: run-log.mjs close)`);
  for (const key of ['through', 'final', 'count-source', 'outcome']) if (options[key] !== undefined) fail(`--${key} is not an event option`);
  if (options.count.length) fail('--count is not an event option');
  const metrics = {};
  for (const item of options.metric) {
    const at = item.indexOf('=');
    if (at < 1) fail(`invalid metric ${item}; expected key=value`);
    const key = item.slice(0, at);
    if (Object.hasOwn(metrics, key)) fail(`duplicate metric key: ${key}`);
    metrics[key] = typed(item.slice(at + 1), fieldType(name, key));
  }
  let detail;
  if (options.detail !== undefined) {
    if (options.detail.length > 65536) fail('--detail is too large');
    try { detail = JSON.parse(options.detail); } catch { fail('--detail must be valid JSON'); }
  }
  await writeEvent(options, name, metrics, detail);
}

/** `close`: an orchestrator closure with explicit counts (always label estimated). Engine closures are computed from state (S-04a3), never typed in. */
async function closeCommand(options) {
  if (options['from-engine-state'] !== undefined) fail('--from-engine-state is not available yet (S-04a3)');
  for (const key of ['name', 'event-id', 'detail', 'started-at', 'ended-at', 'outcome']) if (options[key] !== undefined) fail(`--${key} is not a close option`);
  if (options.metric.length) fail('--metric is not a close option');
  const counts = {};
  for (const item of options.count) {
    const [, key, provider, raw] = /^([a-z_]+)(?:\.([a-z_]+))?=(.*)$/.exec(item) ?? [];
    if (!key) fail(`invalid count ${item}; expected <kind>=<n> or usage.<provider>=<n>`);
    const value = typed(raw, 'int');
    if (provider !== undefined && key !== 'usage') fail(`invalid count ${item}`);
    const slot = provider === undefined ? counts : (counts[key] ??= {});
    if (Object.hasOwn(slot, provider ?? key)) fail(`duplicate count: ${item}`);
    slot[provider ?? key] = value;
  }
  const final = options.final === 'true' ? true : options.final === 'false' ? false : fail('--final must be true or false');
  await writeEvent(options, 'closure', { label: 'estimated', through: requireOption(options, 'through'), final,
    emitter: 'orchestrator', count_source: requireOption(options, 'count-source') }, { counts });
}

/**
 * AC12: what `quarantine` moves: every line that makes a writer refuse, computed to a FIXED POINT. That is readEvents' bad
 * ranges (undecodable, malformed or invalid S-04 lines, a torn tail), plus every legacy line that fails the per-row rules
 * (schema, record, ticket), plus, repeatedly until none is left, the row that breaks pairing: a second start of an id, an
 * end without a matching earlier start (orphan, other kind/name, earlier timestamp), an end whose duration, identity or
 * carrier binding disagrees with its start. Returns sorted, disjoint [from, to) byte ranges.
 */
function quarantineRanges(buf, path) {
  const ranges = readEvents(buf).bad.map(([a, b]) => [a, b]);
  const inBad = (l) => ranges.some(([a, b]) => l.from >= a && l.to < b);
  const lines = readLog(buf).lines.filter((l) => !inBad(l));
  let active = lines;
  for (let pass = 0; pass <= lines.length; pass += 1) {
    const drop = pairingBreakers(active, path);
    if (!drop.size) break;
    active = active.filter((l) => !drop.has(l));
  }
  const kept = new Set(active);
  for (const l of lines) if (!kept.has(l)) ranges.push([l.from, l.to + 1]);
  ranges.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of ranges) { const last = merged.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
  return merged;
}
/** One pass: the legacy lines (of `lines`, in order) that a writer's whole-file check refuses, as buildRun judges pairs. */
function pairingBreakers(lines, path) {
  const drop = new Set();
  const runs = new Map();
  for (const l of lines) {
    if (l.text === null) { drop.add(l); continue; }
    if (!l.text.trim()) continue;
    let row;
    try { row = JSON.parse(l.text); } catch { drop.add(l); continue; }
    if (isEventName(row?.name)) continue;
    if (rowsFromText(`${l.text}\n`, path).warnings.some((w) => w.line !== undefined)) { drop.add(l); continue; }
    const run = runs.get(row.run_id) ?? { starts: new Map(), seen: new Set() };
    runs.set(row.run_id, run);
    if (row.event === 'start') {
      if (run.seen.has(row.event_id)) { drop.add(l); continue; }
      run.seen.add(row.event_id);
      run.starts.set(row.event_id, row);
      continue;
    }
    const start = run.starts.get(row.event_id);
    const bad = !start || start.kind !== row.kind || start.name !== row.name || Date.parse(row.timestamp) < Date.parse(start.timestamp)
      || row.duration_ms !== Date.parse(row.timestamp) - Date.parse(start.timestamp)
      || ['candidate_id', 'review_execution'].some((k) => row.metrics?.[k] !== undefined && row.metrics[k] !== start.metrics?.[k])
      || (row.carrier_timing && (Date.parse(row.carrier_timing.started_at) < Date.parse(start.timestamp)
        || row.carrier_timing.candidate_id !== start.metrics?.candidate_id || row.carrier_timing.review_execution !== start.metrics?.review_execution));
    if (bad) { drop.add(l); continue; }
    run.starts.delete(row.event_id);
  }
  return drop;
}

/** I4: move every undecodable, malformed or invalid S-04 line and a torn tail to a sidecar, with a `log_loss` record. */
async function quarantineCommand(options) {
  const { directory } = locations(requireOption(options, 'repo'));
  const ticket = validateId('ticket', requireOption(options, 'ticket'));
  const path = logPath(directory, ticket), now = new Date().toISOString();
  if (!existsSync(path)) fail(`${path} does not exist (quarantine works on the shared log only; a legacy per-worktree log is never changed)`);
  const info = await failOnError(quarantineLocked(path, { select: (buf) => quarantineRanges(buf, path),
    marker: (i) => encodeRecords([encodeLoss(ticket, i, now)]), check: (after) => assertCleanLog(after, path) }));
  process.stdout.write(`${JSON.stringify(info ? { quarantined: info, sidecar: sidecarPath(path, info) } : { quarantined: null })}\n`);
}

/** No known run: `unknown`. Some unknown runs: only a known sum (a lower bound) next to unknown_runs, never a bare total. */
function missingTotal(counted, total) {
  const sum = counted.reduce((a, b) => a + b, 0), unknownRuns = total - counted.length;
  if (!counted.length) return { missing_review_intervals: 'unknown', missing_review_intervals_unknown_runs: unknownRuns };
  return unknownRuns ? { missing_review_intervals: 'at_least', missing_review_intervals_known_sum: sum, missing_review_intervals_unknown_runs: unknownRuns }
    : { missing_review_intervals: sum, missing_review_intervals_unknown_runs: 0 };
}
/** The tickets with a timing log in any of `dirs` (never `<ticket>.engine.jsonl`, the run engine's own event file). */
function ticketsIn(dirs) {
  const names = new Set();
  for (const dir of dirs) {
    let entries = [];
    // Only ENOENT is "no tickets"; an unlistable shared directory is reported, never an empty listing (repair 7).
    try { entries = readdirSync(dir); } catch (e) { if (e?.code === 'ENOENT') continue; fail(`the shared log directory ${dir} cannot be listed (${e?.code ?? e}): figures unavailable`); }
    for (const name of entries) {
      // <ticket>.engine.jsonl is the run engine's own event file, not a timing log.
      // <ticket>.review-auth.jsonl is a per-worktree REVIEW authority copy, not a second ticket.
      if (name.endsWith('.jsonl') && !name.endsWith('.engine.jsonl') && !name.endsWith(`${AUTH_TAG}.jsonl`) && SAFE_ID.test(name.slice(0, -'.jsonl'.length))) names.add(name.slice(0, -'.jsonl'.length));
    }
  }
  return [...names].sort();
}

/** The reporting view of one ticket: the shared log only, every byte read (as summary always did). */
function reportRows(directory, ticket) {
  const path = logPath(directory, ticket);
  let bytes;
  // Only ENOENT is "no log"; any other error (EACCES on the shared directory, ...) is reported, never an empty result.
  try { bytes = readFileSync(path); } catch (e) {
    if (e?.code === 'ENOENT') return { rows: [], warnings: [], bytes: null };
    return fail(`the shared log ${path} cannot be read (${e?.code ?? e}): figures unavailable`);
  }
  return { ...rowsFromText(bytes.toString('utf8'), path), bytes };
}

/** Runs of one ticket's rows, labelled (abandoned, partial_legacy) by the one shared rule (lib/run-log-paths labelLegacyRun). */
function runsOf(ticket, rows, warnings) {
  const byRun = new Map();
  for (const row of rows) {
    const runRows = byRun.get(row.run_id) ?? [];
    runRows.push(row);
    byRun.set(row.run_id, runRows);
  }
  return [...byRun].map(([runId, runRows]) => {
    const runWarnings = warnings.filter((warning) => warning.run_id === undefined || warning.run_id === runId);
    const run = labelLegacyRun(buildRun(ticket, runId, runRows, runWarnings), runRows);
    return { ...run, missing_review_intervals: missingReviewIntervals(run) };
  });
}

function summary(options) {
  const repo = requireOption(options, 'repo');
  const loc = locations(repo);
  if (Boolean(options.all) === Boolean(options.ticket)) {
    fail('summary requires exactly one of --ticket or --all');
  }

  const tickets = options.ticket ? [validateId('ticket', options.ticket)] : ticketsIn([loc.directory]);
  const runs = [];
  const integrityWarnings = [];
  for (const ticket of tickets) {
    const { rows, warnings } = reportRows(loc.directory, ticket);
    integrityWarnings.push(...warnings.map((warning) => ({ ticket, ...warning })));
    runs.push(...runsOf(ticket, rows, warnings));
  }

  const counted = runs.map((r) => r.missing_review_intervals.count).filter(Number.isInteger);
  // Cutover keys appear only when they say something, so a log without them reads byte-identically to before S5.
  const abandoned = runs.filter((r) => r.abandoned).length, partial = runs.filter((r) => r.partial_legacy).length;
  const legacy = options.ticket ? ownLegacy(loc, tickets[0]) : ownLegacyAll(loc);
  const result = { schema: SUMMARY_SCHEMA, event_schema: SCHEMA, integrity_warnings: integrityWarnings,
    aggregate: { ...aggregate(runs), ...(abandoned ? { abandoned_runs: abandoned } : {}), ...(partial ? { partial_legacy_runs: partial } : {}),
      ...missingTotal(counted, runs.length) },
    ...(legacy.files ? { legacy_present: legacy } : {}), runs };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
/** `legacy_present` over every ticket of this worktree's legacy dir (summary --all): own worktree only. */
function ownLegacyAll(loc) {
  if (!loc.legacy) return { files: 0 };
  const listed = archiveTickets(loc.legacy);
  // An archive directory that cannot be listed is unavailable, never an empty listing (repair 6).
  if (listed.errno) return { files: 'unavailable', lines: 'unavailable', errno: listed.errno };
  const per = listed.tickets.map((t) => legacyPresent(loc.legacy, t));
  return { files: per.reduce((n, p) => n + p.files, 0), ...(per.some((p) => p.lines === 'unavailable') ? { lines: 'unavailable' } : {}) };
}
/**
 * Whether the archive holds a well-formed legacy START row of exactly run `runId` for `ticket` (membership only; nothing
 * is aggregated). Every committed line is parsed whole by the legacy row rules (rowsFromText: schema, fields, the
 * file's ticket); the match is on the `run_id` FIELD, never a substring or a metric.
 */
function startInArchive(archive, ticket, runId) {
  if (ticketOfPath(archive.path) !== ticket) return false;
  const text = archive.bytes.subarray(0, committedLength(archive.bytes)).toString('utf8');
  return rowsFromText(text, archive.path).rows.some((r) => r.event === 'start' && r.run_id === runId && r.ticket === ticket);
}

/**
 * Run-log integrity of one ticket for ship-ready-check (S5). Pure read of the shared log. It claims only what
 * was parsed, counted and paired: `events` (legacy rows plus S-04 events, log_loss records excluded), `runs`, `open_phases`
 * (phase starts without an end), `warnings` (line and pairing warnings plus undecodable, malformed or invalid S-04 lines),
 * `loss_records`. Never completeness or authenticity. `{ unavailable: <why> }` when no log exists or git cannot answer:
 * a deleted log is unavailable, never zero events.
 */
export function integritySummary(repo, ticket) {
  try {
    if (typeof ticket !== 'string' || !SAFE_ID.test(ticket)) return { unavailable: 'invalid ticket' };
    const loc = locations(repo);
    const { rows, warnings, bytes } = reportRows(loc.directory, ticket);
    const legacy = ownLegacy(loc, ticket);
    if (bytes === null) return { unavailable: `no run log for ${ticket}`, legacy_present: legacy };
    const read = readEvents(bytes);
    const badS04 = read.lost.undecodable_lines + read.lost.malformed_lines + read.lost.invalid_events;
    const runs = runsOf(ticket, rows, warnings);
    const openPhases = runs.reduce((n, run) => n + run.open_intervals.filter((i) => i.kind === 'phase').length, 0);
    // `events` counts legacy start/end ROWS plus S-04 events (each a start/end PAIR); log_loss records are counted apart.
    return { events: rows.length + read.events.length, runs: runs.length, open_phases: openPhases, warnings: warnings.length + badS04,
      loss_records: read.lost.loss_records, future_history: futureRuns([rows]),
      abandoned_runs: runs.filter((r) => r.abandoned).length, partial_legacy_runs: runs.filter((r) => r.partial_legacy).length, legacy_present: legacy };
  } catch (error) { return { unavailable: error.message.split('\n')[0] }; }
}

/** S-14a: the most shared-log bytes `reviewStarts` reads; a larger log is reported incomplete, never truncated silently. */
export const REVIEW_STARTS_MAX_BYTES = 16 * 1024 * 1024;
const REVIEW_STARTS_ROLES = new Set(['primary', 'second_opinion', 'confirmation']);

/**
 * S-14a (read-only; run-engine.mjs status through engine-next.mjs): the review activity starts of run `runId` in the shared
 * log, each `{ event_id, name, role, review_execution, candidate_id, started_at, result_path, ended, ended_at }`, plus
 * `ceilings` (each REVIEW phase start's metrics by review_execution). `result_path` is the S5 carrier binding, kept only when
 * it binds the start's own candidate_id and review_execution (else null: an unbound file is never a result). Reads through the
 * same validating row parser as `summary`; `complete` is false when the log is unreadable, over REVIEW_STARTS_MAX_BYTES, or has
 * a line or pairing warning that could belong to this run (never "nothing owed" from a damaged log). Never throws, writes nothing.
 */
export function reviewStarts(repo, ticket, runId, { maxBytes = REVIEW_STARTS_MAX_BYTES } = {}) {
  const none = (complete) => ({ complete, starts: [], ceilings: {} });
  let path, bytes;
  try {
    if (typeof ticket !== 'string' || !SAFE_ID.test(ticket)) return none(false);
    path = logPath(commonLogDir(repo), ticket);
    if (!existsSync(path)) return none(true);
    bytes = readFileSync(path);
  } catch { return none(false); }
  if (bytes.length > maxBytes) return none(false);
  const { rows, warnings } = rowsFromText(bytes.toString('utf8'), path);
  const mine = rows.filter((r) => r.run_id === runId);
  const ceilings = {};
  for (const r of mine) if (r.event === 'start' && r.kind === 'phase' && r.name === 'REVIEW' && typeof r.metrics.review_execution === 'string') ceilings[r.metrics.review_execution] = r.metrics;
  const ends = new Map(mine.filter((r) => r.event === 'end').map((r) => [r.event_id, r]));
  const starts = [];
  for (const r of mine) {
    const role = r.kind === 'activity' && r.event === 'start' ? REVIEW_ROLE_OF[r.name] : undefined;
    if (!REVIEW_STARTS_ROLES.has(role) || typeof r.metrics.review_execution !== 'string') continue;
    const b = r.carrier_binding;
    const bound = b && typeof b.result_path === 'string' && b.candidate_id === r.metrics.candidate_id && b.review_execution === r.metrics.review_execution;
    starts.push({ event_id: r.event_id, name: r.name, role, review_execution: r.metrics.review_execution, candidate_id: r.metrics.candidate_id ?? null,
      started_at: r.timestamp, result_path: bound ? b.result_path : null, ended: ends.has(r.event_id), ended_at: ends.get(r.event_id)?.timestamp ?? null });
  }
  return { complete: !warnings.some((w) => w.run_id === undefined || w.run_id === runId), starts, ceilings };
}

/**
 * `check` (S5): a read-only preflight before EnterPlanMode. It writes nothing: no probe file, no directory, no lock.
 * One JSON line `{ ok, resolved_dir, legacy_logs, degraded?, reason? }`; exit 0 when telemetry can be written, else 1.
 * A failure is a declared degradation for the run (record it), never a blocker for the ticket.
 */
/**
 * How the next append's acquireLock (lib/durable-io.mjs, used through run-log-io) would treat an existing `<log>.lock`,
 * read-only. It mirrors that decision table with the SAME process probe (engine-quiesce processInfo) and host name;
 * durable-io exposes no read-only form of it, and it is not changed here. `refuse` = the append would fail (malformed,
 * foreign host, a stale lock whose recovery marker exists); `degraded` = it would proceed (`lock_held`: waits for a live holder up to
 * 10 s; `stale_lock_recoverable`: a dead or reused pid it recovers).
 */
function lockHealth(lockFile) {
  if (!existsSync(lockFile)) return {};
  let held;
  try { held = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { return { refuse: `lock_malformed: ${lockFile} is unreadable; remove it by hand when no writer runs` }; }
  if (!held || typeof held.pid !== 'number' || typeof held.host !== 'string' || !Number.isInteger(held.pid) || held.pid <= 0 || held.pid > 0x7fffffff) {
    return { refuse: `lock_malformed: ${lockFile} is malformed; remove it by hand when no writer runs` };
  }
  if (held.host !== hostname()) return { refuse: `lock_foreign_host: ${lockFile} is held by host ${held.host}; release it on that host` };
  const other = processInfo(held.pid) ?? { alive: false, startTime: null };
  const reused = other.startTime !== null && (held.process_start_time ?? null) !== null && other.startTime !== held.process_start_time;
  if (other.alive && !reused) return { degraded: 'lock_held' };
  // A stale lock is recovered through <lock>.recovery; an existing marker makes that recovery refuse.
  if (existsSync(`${lockFile}.recovery`)) return { refuse: `lock_held: a recovery of a stale ${lockFile} is in progress or was abandoned (${lockFile}.recovery); if no writer runs, remove the marker by hand` };
  return { degraded: 'stale_lock_recoverable' };
}

function checkCommand(options) {
  const out = { ok: false, append_ready: false, resolved_dir: null, legacy_present: { files: 0 } };
  const degraded = [];
  const finish = (reason) => {
    if (reason) out.reason = reason; else { out.ok = true; out.append_ready = true; }
    if (degraded.length) out.degraded = degraded;
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (!out.ok) process.exit(1);
  };
  const repo = options.repo;
  if (!repo) return finish('--repo is required');
  const ticket = options.ticket;
  if (ticket !== undefined && (!SAFE_ID.test(ticket) || isReservedTicket(ticket))) return finish('invalid --ticket');
  let loc;
  try { loc = locations(repo); } catch (error) { return finish(`not a git repository: ${error.message}`); }
  out.resolved_dir = loc.directory;
  /** The next append needs: the file itself when it exists (it is opened for writing), else its nearest existing directory. */
  const dirProblem = dirPreflight(loc.directory);
  if (dirProblem) return finish(dirProblem);
  // legacy_present: this worktree only (lstat plus a bounded read); reported, never a reason to refuse.
  out.legacy_present = ticket !== undefined ? ownLegacy(loc, ticket) : ownLegacyAll(loc);
  if (out.legacy_present.files) degraded.push('legacy_present');
  if (ticket !== undefined) {
    const path = logPath(loc.directory, ticket);
    // The shared log, the directory its <log>.lock is created in, and this worktree's REVIEW authority file.
    for (const target of [path, authorityPath(loc, ticket)]) { const why = writableTarget(target); if (why) return finish(why); }
    const lock = lockHealth(`${path}.lock`);
    if (lock.refuse) return finish(lock.refuse);
    if (lock.degraded) degraded.push(lock.degraded);
    if (existsSync(path)) {
      try { assertCleanLog(readFileSync(path), path); } catch (error) { return finish(error.message); }
    }
    const { rows } = existsSync(path) ? readRows(path, true) : { rows: [] };
    if (futureRuns([rows])) degraded.push('future_history');
  }
  return finish();
}

/**
 * `batch` (S5): start/end ops from a JSON file (or `-`, stdin), so metric values never pass through a shell (an unquoted
 * multi-flag variable is one word in zsh). Ops: `[{ op: 'start'|'end', kind, name, event_id, outcome?, metrics?: {k: v} }]`;
 * metric values are typed exactly as `--metric k=v` would type them. Every op is validated before the first write; ops
 * then run in order and the first failure stops the batch. NOT atomic: ops already applied stay. stdout is one JSON line,
 * `{ applied }` or `{ applied, failed: { index, reason } }` (exit 1).
 */
const BATCH_KEYS = new Set(['op', 'kind', 'name', 'event_id', 'outcome', 'metrics']);
const BATCH_MAX_BYTES = 1024 * 1024;
async function batchCommand(options) {
  let applied = 0;
  // `applied` counts every op whose shared row committed, including a REVIEW start whose authority copy then failed.
  const stop = (index, error, op) => {
    if (!(error instanceof RunLogError) && !(error instanceof Error)) throw error;
    const committed = error?.committedShared === true;
    if (committed) applied += 1;
    const failed = { index, reason: error.message, committed_shared: committed,
      ...(op && isReviewStart(op) ? { authority_copy: committed ? 'failed' : 'pending' } : {}) };
    process.stdout.write(`${JSON.stringify({ applied, failed })}\n`);
    process.exit(1);
  };
  let ops;
  try {
    for (const key of ['kind', 'name', 'event-id', 'outcome', 'started-at', 'ended-at', 'carrier-result', 'detail']) if (options[key] !== undefined) fail(`--${key} is not a batch option (put it in the ops)`);
    if (options.metric.length) fail('--metric is not a batch option (put metrics in the ops)');
    const source = requireOption(options, 'ops-file');
    let text;
    try { text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(source), 'utf8'); } catch { fail('--ops-file must name a readable file (or - for stdin)'); }
    if (Buffer.byteLength(text) > BATCH_MAX_BYTES) fail('--ops-file is too large');
    try { ops = JSON.parse(text); } catch { fail('--ops-file must be a JSON array of ops'); }
    if (!Array.isArray(ops) || !ops.length) fail('--ops-file must be a non-empty JSON array of ops');
  } catch (error) { return stop(null, error); }
  const loc = (() => { try { return locations(requireOption(options, 'repo')); } catch (error) { return stop(null, error); } })();
  const prepared = [];
  quiet = true;
  for (const [index, op] of ops.entries()) {
    try {
      if (!op || typeof op !== 'object' || Array.isArray(op)) fail('an op must be an object');
      for (const key of Object.keys(op)) if (!BATCH_KEYS.has(key)) fail(`unknown op key: ${key}`);
      if (op.op !== 'start' && op.op !== 'end') fail("op must be 'start' or 'end'");
      if (op.op === 'start' && op.outcome !== undefined) fail('outcome is an end field');
      if (op.outcome !== undefined && (typeof op.outcome !== 'string' || !op.outcome)) fail('outcome must be a non-empty string');
      const m = op.metrics ?? {};
      if (!m || typeof m !== 'object' || Array.isArray(m)) fail('metrics must be an object');
      const metric = Object.entries(m).map(([k, v]) => {
        if (!SAFE_METRIC.test(k)) fail(`invalid metric key: ${k}`); // never re-split a key containing '='
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) fail(`metric ${k} must be a string, number, boolean or null`);
        if (typeof v === 'number' && !Number.isFinite(v)) fail(`metric ${k} must be finite`);
        return `${k}=${v === null ? 'null' : String(v)}`;
      });
      const opts = { repo: options.repo, ticket: options.ticket, 'run-id': options['run-id'], kind: op.kind, name: op.name, 'event-id': op.event_id,
        ...(op.outcome !== undefined ? { outcome: op.outcome } : {}), metric, count: [] };
      for (const key of ['kind', 'name', 'event-id']) if (typeof opts[key] !== 'string') fail(`${key.replace('-', '_')} must be a string`);
      const interval = intervalOptions(opts);
      const metrics = parseMetrics(metric, { lenientGap: op.op === 'end' });
      if (op.op === 'start') validateReviewStart(interval, metrics);
      // Everything execution-time encoding would refuse is refused now, before the first write (repair 2).
      encodeRecords([{ schema: SCHEMA, ticket: interval.ticket, run_id: interval.runId, event: op.op, event_id: interval.eventId, kind: interval.kind,
        name: interval.name, timestamp: new Date().toISOString(), ...(op.op === 'end' ? { duration_ms: 0, outcome: op.outcome ?? 'complete' } : {}), metrics }]);
      // A REVIEW start also writes its authority copy: refuse the whole batch now if that path is not writable, before any
      // shared row exists (same decision as `check`).
      if (isReviewStart(op)) preflightAuthority(loc, interval.ticket);
      prepared.push({ op: op.op, opts, raw: op });
    } catch (error) { quiet = false; return stop(index, error, op && typeof op === 'object' ? op : null); }
  }
  quiet = false;
  for (const [index, { op, opts, raw }] of prepared.entries()) {
    try { await (op === 'start' ? start : end)(opts, { print: false, loc }); }
    catch (error) { return stop(index, error, raw); }
    applied += 1;
  }
  process.stdout.write(`${JSON.stringify({ applied })}\n`);
}

/**
 * `abandon` (cutover, AC2-C): record in the SHARED log that a run started in THIS worktree's pre-S5 log was abandoned.
 * Allowed only when this worktree's own pre-S5 log of the ticket holds a valid legacy START row of the run (read through the
 * safe bounded read; no figure is produced from it). It writes one
 * reserved ACTIVITY pair (never a workflow interval, so no recorded run outcome is rewritten): name `legacy_abandoned`,
 * event id `legacy-abandoned.<12 hex of sha256(own legacy path, run id)>`, outcome `abandoned`. Every reader then shows
 * the run as `abandoned`, never complete. Idempotent: an existing record is returned as it is.
 */
const ABANDON_REASONS = ['old_build_unavailable', 'superseded', 'unknown'];
async function abandonCommand(options) {
  const repo = requireOption(options, 'repo');
  const loc = locations(repo);
  const ticket = validateId('ticket', requireOption(options, 'ticket'));
  const runId = validateId('run id', requireOption(options, 'run-id'));
  const reason = options.reason ?? 'unknown';
  if (!ABANDON_REASONS.includes(reason)) fail(`--reason must be one of: ${ABANDON_REASONS.join(', ')}`);
  // Scope (repairs 6-7): run R must have a valid legacy START row in THIS worktree's own archive, read through the safe
  // bounded read (the only place abandon reads the archive); it never produces a figure. A missing, non-regular or
  // unreadable archive refuses.
  const archive = loc.legacy ? readArchive(loc.legacy, ticket, LEGACY_READ_MAX) : { status: 'absent' };
  if (archive.status === 'absent') fail(`this worktree has no pre-S5 log of ${ticket}: abandon applies only to runs started in one (nothing written)`);
  if (archive.status === 'unavailable') fail(`this worktree's pre-S5 log ${archive.path} cannot be read (${archive.errno}): abandon needs to find run ${runId} in it (nothing written)`);
  if (!startInArchive(archive, ticket, runId)) {
    fail(`run ${runId} does not occur in this worktree's pre-S5 log ${archive.path} (no valid legacy start row of that run for ${ticket}${archive.truncated ? `; only its first ${LEGACY_READ_MAX} bytes were scanned` : ''}): abandon applies only to runs started there (nothing written)`);
  }
  const eventId = `legacy-abandoned.${createHash('sha256').update(`${archive.path}\0${runId}`).digest('hex').slice(0, 12)}`;
  const row = await appendStamped(() => {
    const view = writerRows(loc, ticket);
    const completed = (rows) => rows.some((r) => r.run_id === runId && r.event === 'end' && r.kind === 'workflow' && r.outcome === 'complete');
    const refuseCompleted = () => fail(`run ${runId} completed in the shared log (a workflow interval ended "complete"); a completed run is never abandoned (nothing written)`);
    if (completed(view.rows)) refuseCompleted();
    const existing = view.rows.filter((r) => r.run_id === runId && r.event_id === eventId);
    if (existing.length) return { directory: loc.directory, ticket, records: [], guard: undefined, after: () => existing.at(-1) };
    const stamp = stampFor(view, runId, undefined, '--at');
    const base = { schema: SCHEMA, ticket, run_id: runId, event_id: eventId, kind: 'activity', name: ABANDON_NAME, timestamp: stamp.at.toISOString(),
      metrics: { legacy_run: true, legacy_worktree: true, reason } };
    const endRow = { ...base, event: 'end', duration_ms: 0, outcome: 'abandoned' };
    // Checked again INSIDE the lock, against the exact bytes the abandon rows follow (repair 7): a completion committed
    // while this command waited refuses it, whatever its timestamp.
    const guard = (before) => { if (completed(lockedRows(before, view.path))) refuseCompleted(); stamp.guard(before); };
    return { directory: loc.directory, ticket, records: [{ ...base, event: 'start' }, endRow], guard, after: () => endRow };
  });
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

/**
 * `legacy` (cutover): the explicit READ-ONLY audit of the pre-S5 log(s) of the worktree named by `--repo` (an operator
 * names it; no command enumerates worktrees). It prints the rows and a summary computed over THAT file alone, labelled
 * `scope: 'legacy-archive'`; nothing is ever merged into a shared-log figure. In the main checkout there is no archive
 * (its pre-S5 log is the shared log). ENOENT is `absent`; any other read error is reported with its errno.
 */
function legacyCommand(options) {
  const loc = locations(requireOption(options, 'repo'));
  const out = { scope: 'legacy-archive', worktree_log_dir: loc.legacy, tickets: [] };
  if (loc.legacy) {
    let tickets;
    if (options.ticket !== undefined) tickets = [validateId('ticket', options.ticket)];
    else {
      const listed = archiveTickets(loc.legacy);
      if (listed.errno) Object.assign(out, { status: 'unavailable', errno: listed.errno });
      tickets = listed.tickets;
    }
    for (const ticket of tickets) {
      // The same safe read as legacy_present: lstat, regular file only, O_NOFOLLOW|O_NONBLOCK, bounded (repair 6).
      const r = readArchive(loc.legacy, ticket, LEGACY_READ_MAX);
      if (r.status !== 'present') { out.tickets.push({ ticket, path: r.path ?? logPath(loc.legacy, ticket), status: r.status, ...(r.errno ? { errno: r.errno } : {}) }); continue; }
      const { rows, warnings } = rowsFromText(r.bytes.toString('utf8'), r.path);
      out.tickets.push({ ticket, path: r.path, status: 'present', size: r.size, ...(r.truncated ? { truncated: true, bytes_read: r.bytes.length } : {}),
        rows, warnings, summary: { runs: runsOf(ticket, rows, warnings) } });
    }
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command !== 'close' && command !== 'event' && options.count.length) fail('--count is supported on close only');
  if (command === 'start') await start(options);
  else if (command === 'end') await end(options);
  else if (command === 'event') await eventCommand(options);
  else if (command === 'close') await closeCommand(options);
  else if (command === 'quarantine') await quarantineCommand(options);
  else if (command === 'summary') summary(options);
  else if (command === 'batch') await batchCommand(options);
  else if (command === 'check') checkCommand(options);
  else if (command === 'abandon') await abandonCommand(options);
  else if (command === 'legacy') legacyCommand(options);
  else fail(`unknown command: ${command}`);
}

if (isEntrypoint(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    if (!(error instanceof RunLogError)) throw error;
    process.stderr.write(`run-log: ${error.message}\n`);
    process.exit(1);
  }
}
