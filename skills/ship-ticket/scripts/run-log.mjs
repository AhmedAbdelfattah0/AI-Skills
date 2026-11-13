#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { aggregate, buildRun, SUMMARY_SCHEMA } from './run-summary.mjs';
import { CEILING_METRICS, GAP_REASONS, IDENTITY_ACTIVITIES, SKILL_REVISION, STRING_METRICS, expectedReviewRoles } from './review-intervals.mjs';

const SCHEMA = 'ship-ticket-run-log-v1';
const KINDS = new Set(['workflow', 'phase', 'activity', 'wait']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_METRIC = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function fail(message) {
  process.stderr.write(`run-log: ${message}\n`);
  process.exit(1);
}

function usage() {
  return `Usage:
  run-log.mjs start --repo <path> --ticket <key> --run-id <id> --kind <kind> --name <name> --event-id <id> [--metric key=value ...]
  run-log.mjs end   --repo <path> --ticket <key> --run-id <id> --kind <kind> --name <name> --event-id <id> [--outcome <value>] [--metric key=value ...] [--metrics-from <carrier-result.json>]
  run-log.mjs summary --repo <path> (--ticket <key> | --all)

Kinds: workflow, phase, activity, wait
Review timing: the start of a review activity or of the REVIEW phase requires candidate_id and
review_execution (refused without them). A REVIEW phase start also takes skill_revision and four *_ceiling_ms
metrics; when absent or invalid they are recorded as unknown, never refused. gap_reason=no_start_stamp|wait|unknown
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
  const options = { metric: [] };
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
    if (key === 'metric') options.metric.push(value);
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
  return value;
}

function parseMetricValue(raw) {
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw);
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

function parseMetrics(values) {
  const metrics = {};
  for (const item of values) {
    const separator = item.indexOf('=');
    if (separator < 1) fail(`invalid metric ${item}; expected key=value`);
    const key = item.slice(0, separator);
    const value = item.slice(separator + 1);
    if (!SAFE_METRIC.test(key)) fail(`invalid metric key: ${key}`);
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

function locations(repo) {
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  const rawDirectory = git(repo, ['rev-parse', '--git-path', 'ai-skills/ship-ticket']);
  const directory = isAbsolute(rawDirectory) ? rawDirectory : resolve(root, rawDirectory);
  return { root, directory };
}

function logPath(directory, ticket) {
  return join(directory, `${ticket}.jsonl`);
}

function readRows(path, tolerant = false) {
  if (!existsSync(path)) return { rows: [], warnings: [] };
  const contents = readFileSync(path, 'utf8');
  const rows = [];
  const warnings = [];
  if (contents && !contents.endsWith('\n')) warnings.push({ code: 'incomplete_tail' });
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.schema !== SCHEMA) throw new Error('unsupported_schema');
      if (!['start', 'end'].includes(row.event) || !KINDS.has(row.kind)
        || !['ticket', 'run_id', 'event_id', 'name'].every((key) => typeof row[key] === 'string' && SAFE_ID.test(row[key]))
        || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))
        || !row.metrics || typeof row.metrics !== 'object' || Array.isArray(row.metrics)
        || (row.event === 'end' && (!Number.isFinite(row.duration_ms) || row.duration_ms < 0 || typeof row.outcome !== 'string'))) {
        throw new Error('invalid_record');
      }
      if (Object.hasOwn(row, 'carrier_timing') && !validCarrierTiming(row.carrier_timing, row.timestamp)) throw new Error('invalid_carrier_timing');
      if (row.ticket !== basename(path, '.jsonl')) throw new Error('ticket_mismatch');
      rows.push(row);
    } catch (error) {
      warnings.push({ line: index + 1, code: error instanceof SyntaxError ? 'invalid_json' : error.message });
    }
  }
  // Pairing errors are integrity errors too: writers must not append into an
  // ambiguous history even if every individual line parses successfully.
  const byRun = new Map();
  for (const row of rows) {
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
    byRun.get(row.run_id).push(row);
  }
  for (const [id, runRows] of byRun) {
    warnings.push(...buildRun('', id, runRows).integrity_warnings
      .map((warning) => ({ ...warning, run_id: id })));
  }
  if (!tolerant && warnings.length) fail(`${path}: unsafe log history (${warnings[0].code}); left unchanged`);
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

function appendRow(directory, ticket, row) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(logPath(directory, ticket), `${JSON.stringify(row)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function intervalOptions(options) {
  const ticket = validateId('ticket', requireOption(options, 'ticket'));
  const runId = validateId('run id', requireOption(options, 'run-id'));
  const kind = requireOption(options, 'kind');
  if (!KINDS.has(kind)) fail(`--kind must be one of: ${[...KINDS].join(', ')}`);
  const name = validateId('name', requireOption(options, 'name'));
  const eventId = validateId('event id', requireOption(options, 'event-id'));
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
  if (noted.length) process.stderr.write(`run-log: recorded as unknown (not refused): ${noted.join(', ')}\n`);
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

function start(options) {
  const repo = requireOption(options, 'repo');
  const { directory } = locations(repo);
  const interval = intervalOptions(options);
  const path = logPath(directory, interval.ticket);
  const duplicate = readRows(path).rows.find(
    (row) => row.run_id === interval.runId && row.event_id === interval.eventId,
  );
  if (duplicate) fail(`event ${interval.eventId} already exists in run ${interval.runId}`);

  const metrics = parseMetrics(options.metric);
  validateReviewStart(interval, metrics);
  const binding = carrierBinding(options, metrics);
  const row = {
    schema: SCHEMA,
    ticket: interval.ticket,
    run_id: interval.runId,
    event: 'start',
    event_id: interval.eventId,
    kind: interval.kind,
    name: interval.name,
    timestamp: new Date().toISOString(),
    metrics,
    ...(binding ? { carrier_binding: binding } : {}),
  };
  appendRow(directory, interval.ticket, row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function end(options) {
  const repo = requireOption(options, 'repo');
  const { directory, root } = locations(repo);
  const interval = intervalOptions(options);
  const path = logPath(directory, interval.ticket);
  const rows = readRows(path).rows;
  const matching = rows.filter(
    (row) => row.run_id === interval.runId && row.event_id === interval.eventId,
  );
  const started = matching.find((row) => row.event === 'start');
  if (!started) fail(`event ${interval.eventId} has no start in run ${interval.runId}`);
  if (started.kind !== interval.kind || started.name !== interval.name) {
    fail(`event ${interval.eventId} must end with its original kind and name`);
  }

  const timestamp = new Date();
  const timing = importCarrier(options, started, root, timestamp);
  const previous = matching.find((row) => row.event === 'end');
  if (previous) {
    if (timing && previous.carrier_timing?.result_sha256 === timing.result_sha256
      && (options.outcome === undefined || options.outcome === previous.outcome)
      && options.metric.length === 0) {
      process.stdout.write(`${JSON.stringify(previous)}\n`);
      return;
    }
    fail(`event ${interval.eventId} already ended in run ${interval.runId}`);
  }
  const metrics = parseMetrics(options.metric);
  for (const key of ['candidate_id', 'review_execution']) {
    if (metrics[key] !== undefined && metrics[key] !== started.metrics[key]) fail(`${key} cannot change within an interval`);
  }
  const startedAt = Date.parse(started.timestamp);
  if (!Number.isFinite(startedAt)) fail(`event ${interval.eventId} has an invalid start timestamp`);
  const row = {
    schema: SCHEMA,
    ticket: interval.ticket,
    run_id: interval.runId,
    event: 'end',
    event_id: interval.eventId,
    kind: interval.kind,
    name: interval.name,
    timestamp: timestamp.toISOString(),
    duration_ms: Math.max(0, timestamp.getTime() - startedAt),
    outcome: options.outcome ?? 'complete',
    metrics,
    ...(timing ? { carrier_timing: timing } : {}),
  };
  appendRow(directory, interval.ticket, row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}
/** No known run: `unknown`. Some unknown runs: only a known sum (a lower bound) next to unknown_runs, never a bare total. */
function missingTotal(counted, total) {
  const sum = counted.reduce((a, b) => a + b, 0), unknownRuns = total - counted.length;
  if (!counted.length) return { missing_review_intervals: 'unknown', missing_review_intervals_unknown_runs: unknownRuns };
  return unknownRuns ? { missing_review_intervals: 'at_least', missing_review_intervals_known_sum: sum, missing_review_intervals_unknown_runs: unknownRuns }
    : { missing_review_intervals: sum, missing_review_intervals_unknown_runs: 0 };
}
function summary(options) {
  const repo = requireOption(options, 'repo');
  const { directory } = locations(repo);
  if (Boolean(options.all) === Boolean(options.ticket)) {
    fail('summary requires exactly one of --ticket or --all');
  }

  let tickets = [];
  if (options.ticket) {
    tickets = [validateId('ticket', options.ticket)];
  } else if (existsSync(directory)) {
    tickets = readdirSync(directory)
      // <ticket>.engine.jsonl is the run engine's own event file, not a timing log.
      .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.engine.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .filter((name) => SAFE_ID.test(name))
      .sort();
  }

  const runs = [];
  const integrityWarnings = [];
  for (const ticket of tickets) {
    const { rows, warnings } = readRows(logPath(directory, ticket), true);
    integrityWarnings.push(...warnings.map((warning) => ({ ticket, ...warning })));
    const byRun = new Map();
    for (const row of rows) {
      const runRows = byRun.get(row.run_id) ?? [];
      runRows.push(row);
      byRun.set(row.run_id, runRows);
    }
    for (const [runId, runRows] of byRun) {
      const runWarnings = warnings.filter((warning) => warning.run_id === undefined || warning.run_id === runId);
      const run = buildRun(ticket, runId, runRows, runWarnings);
      runs.push({ ...run, missing_review_intervals: missingReviewIntervals(run) });
    }
  }

  const counted = runs.map((r) => r.missing_review_intervals.count).filter(Number.isInteger);
  const result = { schema: SUMMARY_SCHEMA, event_schema: SCHEMA, integrity_warnings: integrityWarnings,
    aggregate: { ...aggregate(runs), ...missingTotal(counted, runs.length) }, runs };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'start') start(options);
else if (command === 'end') end(options);
else if (command === 'summary') summary(options);
else fail(`unknown command: ${command}`);
