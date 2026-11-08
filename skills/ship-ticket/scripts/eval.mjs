#!/usr/bin/env node
/**
 * Read-only evaluation of ship-ticket runs (P2-6).
 *
 *   eval.mjs report --repo <path> (--ticket <key> | --all) [--usage <jsonl>...]
 *
 * Inputs, all read-only: the run log `<ticket>.jsonl`, the optional engine
 * state `<ticket>.state.json` (both under `git rev-parse --git-path
 * ai-skills/ship-ticket`) and optional usage JSONL files. Anything a source
 * does not carry is reported as the string `unknown`, never as zero.
 *
 * Engine-state fields read (a state whose `run_id` differs from the run is ignored):
 * - `review_chain[]`: gate review records; `kind: 'repair'` counts a REVIEW
 *   repair, `'confirmation'` a confirmation, and a record's optional
 *   `findings: [{severity}]` feeds the pre-ship severity counts.
 * - `events[]`: `{type: 'RESUME', outcome?}`, `{type: 'INFRA_RETRY'}` and
 *   `{type: 'ADMISSION_REFUSED'}` (written by run-engine.mjs).
 * - `unit_checks` (opt-in units only): the per-unit projection (engine-units.mjs), recomputed
 *   against the work tree of `--repo`; printed as `units` only when the state has units, with each
 *   unit's computed `review` state when the run records unit reviews (config.unitReview).
 * - `attempts[].envelope.truncated` (launcher output past 32 MiB): printed as `truncated_outputs`
 *   only when any exists. Usage records without a `phase` are the `phase unknown` bucket of
 *   `tokens_by_phase`.
 * The engine's own event file `<ticket>.engine.jsonl` is never read as a ticket.
 *
 * Run-log marker: any interval with the metric `ui_ticket=true` marks a UI ticket.
 *
 * Exactly three suggestion rules exist; they are printed, never applied.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { aggregateUsage, attachUsage, buildRun, engineResources, truncatedOutputs } from './run-summary.mjs';
import { unitProjection, unitStates } from './engine-units.mjs';
import { withReviews } from './engine-unit-review.mjs';

export const EVAL_SCHEMA = 'ship-ticket-eval-v1';
const UNKNOWN = 'unknown';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const known = (v) => typeof v === 'number' && Number.isFinite(v);

/** Counts `events` of `type` in a matched engine state; `'unknown'` without an events array. */
const countEvents = (state, type) => (Array.isArray(state?.events) ? state.events.filter((e) => e?.type === type).length : UNKNOWN);

function resumes(state) {
  if (!Array.isArray(state?.events)) return UNKNOWN;
  const list = state.events.filter((e) => e?.type === 'RESUME');
  const outcomes = {};
  for (const e of list) {
    const key = typeof e.outcome === 'string' && e.outcome ? e.outcome : UNKNOWN;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  return { attempts: list.length, outcomes };
}

function findingsBySeverity(chain) {
  const withFindings = chain.filter((r) => Array.isArray(r?.findings));
  if (!withFindings.length) return UNKNOWN;
  const counts = {};
  for (const f of withFindings.flatMap((r) => r.findings)) {
    const sev = typeof f?.severity === 'string' && f.severity ? f.severity : UNKNOWN;
    counts[sev] = (counts[sev] ?? 0) + 1;
  }
  return counts;
}

/** Reported cost of an accepted (complete) run per cost basis, never summed across bases; `unknown` otherwise. */
function acceptedCost(run) {
  const bases = Object.entries(run.usage?.cost_by_basis ?? {});
  if (run.outcome !== 'complete' || !bases.length) return UNKNOWN;
  return Object.fromEntries(bases.map(([b, c]) => [b, c.reported_cost_usd]));
}

/**
 * Metrics for one run. `run` is a `buildRun` result, optionally passed through
 * `attachUsage`; `state` is the ticket's engine state, if any.
 * @param {object} run
 * @param {{state?: object}} [sources]
 */
export function evaluateRun(run, { state, repoRoot = null } = {}) {
  const matched = state && state.run_id === run.run_id ? state : null;
  const chain = Array.isArray(matched?.review_chain) ? matched.review_chain : null;
  const hasReview = run.intervals.some((i) => i.kind === 'phase' && i.name === 'REVIEW');
  const logged = (counter) => (hasReview ? run.counters[counter].observed : UNKNOWN);
  const wall = {};
  for (const i of run.intervals.filter((x) => x.kind === 'phase')) wall[i.name] = (wall[i.name] ?? 0) + i.duration_ms;
  const { build_ms: buildMs, review_ms: reviewMs } = run.durations;
  return {
    ticket: run.ticket, run_id: run.run_id, outcome: run.outcome,
    tokens_by_role: run.usage?.tokens_by_role ?? UNKNOWN,
    tokens_by_phase: run.usage?.tokens_by_phase ?? UNKNOWN,
    orchestrator_share_pct: run.usage?.orchestrator_share_pct ?? UNKNOWN,
    wall_ms_by_phase: wall,
    review_executions: run.review_executions.length,
    ...(matched ? engineResources(matched) : { peak_rss_mb: UNKNOWN, peak_cpu_pct: UNKNOWN, parallel_efficiency: UNKNOWN }),
    terminal_review_outcomes: chain ? chain.filter((r) => r?.kind === 'original' && r.overflow === true).length : UNKNOWN,
    retries_authorized: chain ? chain.filter((r) => r?.kind === 'retry').length : UNKNOWN,
    cost_per_accepted_ticket: acceptedCost(run),
    review_repairs: chain ? chain.filter((r) => r?.kind === 'repair').length : logged('repair_batches'),
    confirmations: chain ? chain.filter((r) => r?.kind === 'confirmation').length : logged('confirmations'),
    findings_by_severity: chain ? findingsBySeverity(chain) : UNKNOWN,
    resumes: resumes(matched),
    infra_retries: countEvents(matched, 'INFRA_RETRY'),
    admission_refusals: countEvents(matched, 'ADMISSION_REFUSED'),
    ui_ticket: run.intervals.some((i) => i.metrics?.ui_ticket === true),
    review_to_build_ratio: known(reviewMs) && known(buildMs) && buildMs > 0 ? Math.round(reviewMs / buildMs * 1000) / 1000 : UNKNOWN,
    ...(matched?.unit_checks ? { units: withReviews(matched, unitProjection(matched, repoRoot), repoRoot ? unitStates(matched, repoRoot) : null) } : {}),
    ...(truncatedOutputs(matched).length ? { truncated_outputs: truncatedOutputs(matched) } : {}),
  };
}

/**
 * The three evidence-backed rules. Each fires only on its own condition and
 * never on unknown data. Returns `[{rule, message, evidence}]`; nothing is edited.
 * @param {object} metrics an `evaluateRun` result
 */
export function suggest(metrics) {
  const out = [];
  if (known(metrics.orchestrator_share_pct) && metrics.orchestrator_share_pct > 50) {
    out.push({ rule: 'split_session', message: 'The orchestrator used more than half of the tokens: split the session (one fresh session per ticket or wave).',
      evidence: { orchestrator_share_pct: metrics.orchestrator_share_pct } });
  }
  if (metrics.ui_ticket === true && known(metrics.review_to_build_ratio) && metrics.review_to_build_ratio > 1.2) {
    out.push({ rule: 'parity_probe_first', message: 'Review took more than 1.2x the build on a UI ticket: run the parity probe first.',
      evidence: { review_to_build_ratio: metrics.review_to_build_ratio } });
  }
  if (known(metrics.review_repairs) && metrics.review_repairs > 1) {
    out.push({ rule: 'brief_too_weak', message: 'More than one REVIEW repair was needed: the brief was too weak.',
      evidence: { review_repairs: metrics.review_repairs } });
  }
  return out;
}

const median = (values) => {
  const v = values.filter(known).sort((a, b) => a - b);
  return v.length ? (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2 : UNKNOWN;
};

/**
 * Per-run metrics plus a cross-run view. Usage is joined by `run_id`.
 * @param {{runs: object[], states?: Record<string, object>, records?: object[]}} input
 *   `runs` are `buildRun` results; `states` maps ticket → engine state.
 */
export function evaluate({ runs, states = {}, records = [], repoRoot = null }) {
  const joined = runs.map((r) => attachUsage(r, records));
  const metrics = joined.map((r) => {
    const m = evaluateRun(r, { state: states[r.ticket], repoRoot });
    return { ...m, suggestions: suggest(m) };
  });
  const fired = {};
  for (const s of metrics.flatMap((m) => m.suggestions)) fired[s.rule] = (fired[s.rule] ?? 0) + 1;
  return { schema: EVAL_SCHEMA, runs: metrics,
    cross_run: { runs: metrics.length, orchestrator_share_pct_median: median(metrics.map((m) => m.orchestrator_share_pct)),
      review_repairs_median: median(metrics.map((m) => m.review_repairs)),
      peak_rss_mb_max: metrics.map((m) => m.peak_rss_mb).filter(known).reduce((a, b) => Math.max(a, b), -1) >= 0
        ? Math.max(...metrics.map((m) => m.peak_rss_mb).filter(known)) : UNKNOWN, suggestions_fired: fired,
      ...aggregateUsage(joined) },
    note: 'Read-only. unknown means the source did not carry the value. Suggestions are never applied.' };
}

// ---- CLI ---------------------------------------------------------------------------

function fail(message) {
  process.stderr.write(`eval: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { usage: [] };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--all') { options.all = true; continue; }
    if (token === '--usage') {
      while (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) options.usage.push(rest[++i]);
      if (!options.usage.length) fail('--usage requires at least one file');
      continue;
    }
    if (token !== '--repo' && token !== '--ticket') fail(`unexpected argument: ${token}`);
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) fail(`${token} requires a value`);
    options[token.slice(2)] = rest[++i];
  }
  return { command, options };
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) fail(r.stderr.trim() || `git ${args.join(' ')} failed`);
  return r.stdout.trim();
}

const readJsonl = (path) => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

function readUsage(path) {
  if (!existsSync(path)) fail(`usage file not found: ${path}`);
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  try { return text.startsWith('[') ? JSON.parse(text) : readJsonl(path); } catch { return fail(`usage file is not JSON or JSONL: ${path}`); }
}

function report(options) {
  if (!options.repo) fail('--repo is required');
  if (Boolean(options.all) === Boolean(options.ticket)) fail('report requires exactly one of --ticket or --all');
  const root = git(options.repo, ['rev-parse', '--show-toplevel']);
  const raw = git(options.repo, ['rev-parse', '--git-path', 'ai-skills/ship-ticket']);
  const dir = isAbsolute(raw) ? raw : resolve(root, raw);
  let tickets;
  if (options.ticket) {
    if (!SAFE_ID.test(options.ticket)) fail('invalid ticket');
    tickets = [options.ticket];
  } else {
    // `<ticket>.engine.jsonl` is the run engine's event file, not a timing log.
    tickets = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.endsWith('.engine.jsonl')).map((n) => n.slice(0, -6))
      .filter((n) => SAFE_ID.test(n)).sort() : [];
  }
  const runs = [];
  const states = {};
  for (const ticket of tickets) {
    const log = join(dir, `${ticket}.jsonl`);
    const byRun = new Map();
    for (const row of existsSync(log) ? readJsonl(log) : []) {
      if (typeof row?.run_id !== 'string') continue;
      byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row]);
    }
    for (const [runId, rows] of byRun) runs.push(buildRun(ticket, runId, rows));
    const statePath = join(dir, `${ticket}.state.json`);
    if (existsSync(statePath)) { try { states[ticket] = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* unreadable state stays unknown */ } }
  }
  const records = options.usage.flatMap(readUsage);
  process.stdout.write(`${JSON.stringify(evaluate({ runs, states, records, repoRoot: root }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'report') report(options);
  else fail(`unknown command: ${command}`);
}
