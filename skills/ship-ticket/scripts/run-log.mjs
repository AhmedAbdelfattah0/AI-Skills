#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

function readRows(path) {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, 'utf8');
  if (!contents.trim()) return [];
  return contents.trimEnd().split('\n').map((line, index) => {
    try {
      const row = JSON.parse(line);
      if (row.schema !== SCHEMA) fail(`${path}:${index + 1} has an unsupported schema`);
      return row;
    } catch (error) {
      if (error instanceof SyntaxError) fail(`${path}:${index + 1} is not valid JSON`);
      throw error;
    }
  });
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
  const duplicate = readRows(path).find(
    (row) => row.run_id === interval.runId && row.event_id === interval.eventId,
  );
  if (duplicate) fail(`event ${interval.eventId} already exists in run ${interval.runId}`);

  const row = {
    schema: SCHEMA,
    ticket: interval.ticket,
    run_id: interval.runId,
    event: 'start',
    event_id: interval.eventId,
    kind: interval.kind,
    name: interval.name,
    timestamp: new Date().toISOString(),
    metrics: parseMetrics(options.metric),
  };
  appendRow(directory, interval.ticket, row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function end(options) {
  const repo = requireOption(options, 'repo');
  const { directory } = locations(repo);
  const interval = intervalOptions(options);
  const path = logPath(directory, interval.ticket);
  const rows = readRows(path);
  const matching = rows.filter(
    (row) => row.run_id === interval.runId && row.event_id === interval.eventId,
  );
  const started = matching.find((row) => row.event === 'start');
  if (!started) fail(`event ${interval.eventId} has no start in run ${interval.runId}`);
  if (matching.some((row) => row.event === 'end')) {
    fail(`event ${interval.eventId} already ended in run ${interval.runId}`);
  }
  if (started.kind !== interval.kind || started.name !== interval.name) {
    fail(`event ${interval.eventId} must end with its original kind and name`);
  }

  const timestamp = new Date();
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
    metrics: parseMetrics(options.metric),
  };
  appendRow(directory, interval.ticket, row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(3))
    : sorted[middle];
}

function buildRun(ticket, runId, rows) {
  const starts = new Map();
  const intervals = [];
  for (const row of rows) {
    if (row.event === 'start') {
      starts.set(row.event_id, row);
      continue;
    }
    if (row.event !== 'end') continue;
    const started = starts.get(row.event_id);
    if (!started) continue;
    intervals.push({
      event_id: row.event_id,
      kind: row.kind,
      name: row.name,
      started_at: started.timestamp,
      ended_at: row.timestamp,
      duration_ms: row.duration_ms,
      outcome: row.outcome,
      metrics: { ...started.metrics, ...row.metrics },
    });
    starts.delete(row.event_id);
  }

  const openIntervals = [...starts.values()].map((row) => ({
    event_id: row.event_id,
    kind: row.kind,
    name: row.name,
    started_at: row.timestamp,
    metrics: row.metrics,
  }));
  const durationByKind = Object.fromEntries(
    [...KINDS].map((kind) => [
      `${kind}_ms`,
      intervals
        .filter((interval) => interval.kind === kind)
        .reduce((sum, interval) => sum + interval.duration_ms, 0),
    ]),
  );
  const phaseDuration = (name) =>
    intervals.find((interval) => interval.kind === 'phase' && interval.name === name)?.duration_ms ?? null;
  const review = intervals.find(
    (interval) => interval.kind === 'phase' && interval.name === 'REVIEW',
  );
  const workflow = intervals.find((interval) => interval.kind === 'workflow');
  const hasOpenWait = openIntervals.some((interval) => interval.kind === 'wait');
  const hasOpenNativePlan = openIntervals.some(
    (interval) => interval.kind === 'activity' && interval.name === 'native_plan_mode',
  );
  const oldestOpenTimestamp = openIntervals
    .map((interval) => Date.parse(interval.started_at))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  let openState = 'closed';
  if (openIntervals.length > 0 && hasOpenWait) openState = 'waiting';
  else if (openIntervals.length > 0 && hasOpenNativePlan) openState = 'planning_or_approval';
  else if (openIntervals.length > 0) openState = 'active_or_unexpected_stop';

  return {
    ticket,
    run_id: runId,
    outcome: workflow?.outcome ?? (openIntervals.length > 0 ? 'open' : 'unknown'),
    open_state: openState,
    oldest_open_age_ms: oldestOpenTimestamp === undefined
      ? null
      : Math.max(0, Date.now() - oldestOpenTimestamp),
    review_profile: review?.metrics.review_profile ?? null,
    durations: {
      ...durationByKind,
      build_ms: phaseDuration('BUILD'),
      review_ms: phaseDuration('REVIEW'),
    },
    counters: {
      repair_batches: intervals.filter((interval) => interval.name === 'review_repair').length,
      confirmations: intervals.filter((interval) => interval.name === 'review_confirmation').length,
      reviewer_degradations: intervals.filter(
        (interval) => interval.name === 'optional_review' && interval.outcome === 'degraded',
      ).length,
    },
    open_intervals: openIntervals,
    intervals,
  };
}

function aggregate(runs) {
  const completed = runs.filter((run) => run.outcome === 'complete');
  const reviewDurations = runs
    .map((run) => run.durations.review_ms)
    .filter(Number.isFinite);
  const standardReviewDurations = runs
    .filter((run) => run.review_profile === 'standard')
    .map((run) => run.durations.review_ms)
    .filter(Number.isFinite);
  const elevatedReviewDurations = runs
    .filter((run) => run.review_profile === 'elevated')
    .map((run) => run.durations.review_ms)
    .filter(Number.isFinite);
  const reviewToBuildRatios = runs
    .filter((run) => Number.isFinite(run.durations.review_ms) && run.durations.build_ms > 0)
    .map((run) => Number((run.durations.review_ms / run.durations.build_ms).toFixed(3)));

  return {
    runs: runs.length,
    completed_runs: completed.length,
    failed_runs: runs.filter((run) => run.outcome === 'fail').length,
    open_runs: runs.filter((run) => run.open_intervals.length > 0).length,
    planning_runs: runs.filter((run) => run.open_state === 'planning_or_approval').length,
    waiting_runs: runs.filter((run) => run.open_state === 'waiting').length,
    open_without_wait: runs.filter(
      (run) => run.open_state === 'active_or_unexpected_stop',
    ).length,
    review_median_ms: median(reviewDurations),
    standard_review_median_ms: median(standardReviewDurations),
    elevated_review_median_ms: median(elevatedReviewDurations),
    review_to_build_ratio_median: median(reviewToBuildRatios),
    runs_with_review_repair: runs.filter((run) => run.counters.repair_batches > 0).length,
    runs_with_confirmation: runs.filter((run) => run.counters.confirmations > 0).length,
    optional_reviewer_degradations: runs.reduce(
      (sum, run) => sum + run.counters.reviewer_degradations,
      0,
    ),
  };
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
  for (const ticket of tickets) {
    const rows = readRows(logPath(directory, ticket));
    const byRun = new Map();
    for (const row of rows) {
      const runRows = byRun.get(row.run_id) ?? [];
      runRows.push(row);
      byRun.set(row.run_id, runRows);
    }
    for (const [runId, runRows] of byRun) runs.push(buildRun(ticket, runId, runRows));
  }

  const result = { schema: SCHEMA, aggregate: aggregate(runs), runs };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'start') start(options);
else if (command === 'end') end(options);
else if (command === 'summary') summary(options);
else fail(`unknown command: ${command}`);
