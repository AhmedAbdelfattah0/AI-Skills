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
  run-log.mjs end   --repo <path> --ticket <key> --run-id <id> --kind <kind> --name <name> --event-id <id> [--outcome <value>] [--metric key=value ...]
  run-log.mjs summary --repo <path> (--ticket <key> | --all)

Kinds: workflow, phase, activity, wait
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

function parseMetrics(values) {
  const metrics = {};
  for (const item of values) {
    const separator = item.indexOf('=');
    if (separator < 1) fail(`invalid metric ${item}; expected key=value`);
    const key = item.slice(0, separator);
    const value = item.slice(separator + 1);
    if (!SAFE_METRIC.test(key)) fail(`invalid metric key: ${key}`);
    if (Object.hasOwn(metrics, key)) fail(`duplicate metric key: ${key}`);
    metrics[key] = parseMetricValue(value);
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
      .filter((name) => name.endsWith('.jsonl'))
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
      runs.push(buildRun(ticket, runId, runRows, runWarnings));
    }
  }

  const result = { schema: SUMMARY_SCHEMA, event_schema: SCHEMA, integrity_warnings: integrityWarnings, aggregate: aggregate(runs), runs };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'start') start(options);
else if (command === 'end') end(options);
else if (command === 'summary') summary(options);
else fail(`unknown command: ${command}`);
