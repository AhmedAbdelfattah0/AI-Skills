// Pure summary calculations. Persisted events remain ship-ticket-run-log-v1.
export const SUMMARY_SCHEMA = 'ship-ticket-run-summary-v2';
const sum = (values) => values.length ? values.reduce((a, b) => a + b, 0) : null;
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
};
const span = (i) => [Date.parse(i.started_at), Date.parse(i.ended_at)];
export function union(spans) {
  const result = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue;
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const length = (spans) => union(spans).reduce((n, [a, b]) => n + b - a, 0);
const intersection = (a, b) => a.flatMap(([s, e]) => b.map(([x, y]) => [Math.max(s, x), Math.min(e, y)]));
const pct = (n, d) => d > 0 ? Math.round(n / d * 1000) / 10 : null;

function effectiveSpan(i) {
  const t = i.carrier_timing;
  return t ? [Date.parse(t.started_at), Date.parse(t.ended_at)] : span(i);
}
function parallelGroups(intervals) {
  const grouped = new Map();
  for (const i of intervals.filter((i) => i.kind === 'activity')) {
    const id = i.metrics.parallel_group;
    if (typeof id !== 'string' || !id) continue;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(i);
  }
  return [...grouped].map(([id, members]) => {
    const spans = members.map(effectiveSpan);
    const points = [...new Set(spans.flat())].sort((a, b) => a - b);
    let overlap = 0;
    let peak = 0;
    for (let p = 0; p < points.length - 1; p++) {
      const active = spans.filter(([s, e]) => s <= points[p] && e > points[p]).length;
      peak = Math.max(peak, active);
      if (active > 1) overlap += points[p + 1] - points[p];
    }
    const frontend = union(members.filter((i) => i.name === 'frontend_build').map(effectiveSpan));
    const backend = union(members.filter((i) => i.name === 'backend_build').map(effectiveSpan));
    const both = length(intersection(frontend, backend));
    const wall = points.at(-1) - points[0];
    const carrierCount = members.filter((i) => i.carrier_timing).length;
    return {
      parallel_group: id,
      member_count: members.length,
      started_at: new Date(points[0]).toISOString(),
      ended_at: new Date(points.at(-1)).toISOString(),
      wall_ms: wall,
      summed_member_ms: spans.reduce((n, [s, e]) => n + e - s, 0),
      concurrent_wall_overlap_ms: overlap,
      peak_concurrency: peak,
      timing_basis: carrierCount === members.length ? 'carrier' : carrierCount ? 'mixed' : 'logger_intervals',
      carrier_timed_members: carrierCount,
      flags: members.length === 1 ? ['single_member'] : peak < 2 ? ['no_recorded_concurrency'] : [],
      frontend_backend_overlap_ms: frontend.length && backend.length ? both : null,
      frontend_overlap_pct: pct(both, length(frontend)),
      backend_overlap_pct: pct(both, length(backend)),
      frontend_backend_union_overlap_pct: frontend.length && backend.length ? pct(both, length([...frontend, ...backend])) : null,
      members: members.map((i) => ({ event_id: i.event_id, name: i.name, duration_ms: i.duration_ms })),
    };
  });
}

function counters(intervals) {
  const phases = intervals.filter((i) => i.kind === 'phase' && i.name === 'REVIEW');
  const count = (name, metric) => {
    const observed = intervals.filter((i) => i.kind === 'activity' && i.name === name).length;
    const declarations = phases.map((i) => i.metrics[metric]);
    const valid = declarations.filter((n) => Number.isInteger(n) && n >= 0);
    const declared = valid.length === phases.length ? sum(valid) : null;
    return { observed, declared, declaration_complete: phases.length > 0 && valid.length === phases.length,
      mismatch: declared === null ? null : observed !== declared };
  };
  return {
    repair_batches: count('review_repair', 'repair_batches'),
    confirmations: count('review_confirmation', 'confirmation_count'),
    primary_degradations_observed: intervals.filter((i) => i.kind === 'activity' && i.name === 'primary_review' && i.outcome === 'degraded').length,
    optional_degradations_observed: intervals.filter((i) => i.kind === 'activity' && i.name === 'optional_review' && i.outcome === 'degraded').length,
  };
}

export function buildRun(ticket, runId, rows, fileWarnings = []) {
  const starts = new Map();
  const seen = new Set();
  const intervals = [];
  const warnings = [...fileWarnings];
  const warn = (code, eventId) => {
    if (!warnings.some((w) => w.code === code && w.event_id === eventId && w.run_id === runId)) {
      warnings.push({ code, event_id: eventId, run_id: runId });
    }
  };
  for (const row of rows) {
    if (row.event === 'start') {
      if (seen.has(row.event_id)) { warn('duplicate_start', row.event_id); continue; }
      seen.add(row.event_id);
      starts.set(row.event_id, row);
      continue;
    }
    const start = starts.get(row.event_id);
    if (!start || start.kind !== row.kind || start.name !== row.name || Date.parse(row.timestamp) < Date.parse(start.timestamp)) {
      warn('invalid_pair', row.event_id);
      continue;
    }
    const duration = Date.parse(row.timestamp) - Date.parse(start.timestamp);
    if (row.duration_ms !== duration) warn('duration_mismatch', row.event_id);
    const interval = { event_id: row.event_id, kind: row.kind, name: row.name,
      started_at: start.timestamp, ended_at: row.timestamp, duration_ms: duration,
      outcome: row.outcome, metrics: { ...start.metrics, ...row.metrics } };
    for (const key of ['candidate_id', 'review_execution']) {
      if (row.metrics[key] !== undefined && row.metrics[key] !== start.metrics[key]) {
        warn('identity_mismatch', row.event_id);
        if (Object.hasOwn(start.metrics, key)) interval.metrics[key] = start.metrics[key];
        else delete interval.metrics[key];
      }
    }
    if (row.carrier_timing) {
      const timing = row.carrier_timing;
      if (Date.parse(timing.started_at) < Date.parse(start.timestamp)
        || timing.candidate_id !== start.metrics.candidate_id
        || timing.review_execution !== start.metrics.review_execution) {
        warn('carrier_binding_mismatch', row.event_id);
      } else interval.carrier_timing = timing;
    }
    intervals.push(interval);
    starts.delete(row.event_id);
  }
  const open = [...starts.values()].map((r) => ({ event_id: r.event_id, kind: r.kind, name: r.name, started_at: r.timestamp, metrics: r.metrics }));
  const phases = intervals.filter((i) => i.kind === 'phase');
  const phaseDuration = (name) => sum(phases.filter((i) => i.name === name).map((i) => i.duration_ms));
  // Native-mode switch waits include planning and are not pure user waits.
  const waits = union(intervals.filter((i) => i.kind === 'wait' && !i.metrics.includes_native_plan_mode).map(span));
  const adjusted = (name) => {
    const spans = phases.filter((i) => i.name === name).map(span);
    return spans.length ? length(spans) - length(intersection(spans, waits)) : null;
  };
  const phaseCoverage = phases.map((p) => {
    const pSpan = [span(p)];
    const activities = intervals.filter((i) => i.kind === 'activity').map(effectiveSpan);
    return { event_id: p.event_id, name: p.name,
      recorded_wait_overlap_ms: length(intersection(pSpan, waits)),
      uninstrumented_ms: p.duration_ms - length(intersection(pSpan, [...activities, ...waits])) };
  });
  const workflows = intervals.filter((i) => i.kind === 'workflow');
  const profiles = [...new Set(phases.filter((i) => i.name === 'REVIEW').map((i) => i.metrics.review_profile).filter(Boolean))];
  const executionIds = [...new Set(intervals.map((i) => i.metrics.review_execution).filter((id) => typeof id === 'string'))];
  const reviewExecutions = executionIds.map((id) => {
    const members = intervals.filter((i) => i.metrics.review_execution === id);
    const phase = members.find((i) => i.kind === 'phase' && i.name === 'REVIEW');
    return { review_execution: id, metadata: phase?.metrics ?? {}, counters: counters(members),
      event_ids: members.map((i) => i.event_id) };
  });
  let state = 'closed';
  if (warnings.length) state = 'unknown_due_to_integrity';
  else if (open.some((i) => i.kind === 'wait')) state = 'waiting';
  else if (open.some((i) => i.name === 'native_plan_mode')) state = 'planning_or_approval';
  else if (open.length) state = 'active_or_unexpected_stop';
  return {
    ticket, run_id: runId,
    outcome: workflows.at(-1)?.outcome ?? (open.length ? 'open' : 'unknown'),
    open_state: state,
    integrity_warnings: warnings,
    oldest_open_age_ms: open.length ? Math.max(0, Date.now() - Math.min(...open.map((i) => Date.parse(i.started_at)))) : null,
    review_profile: profiles.length === 1 ? profiles[0] : null,
    durations: {
      ...Object.fromEntries(['workflow', 'phase', 'activity', 'wait'].map((kind) => [`${kind}_ms`, sum(intervals.filter((i) => i.kind === kind).map((i) => i.duration_ms))])),
      build_ms: phaseDuration('BUILD'), review_ms: phaseDuration('REVIEW'),
      build_wall_excluding_recorded_waits_ms: adjusted('BUILD'),
      review_wall_excluding_recorded_waits_ms: adjusted('REVIEW'),
    },
    measurement_caveat: 'Intervals can include delayed collection and unrecorded waits; adjusted wall time is not active compute. Missing activity events do not prove absence of work.',
    counters: counters(intervals), review_executions: reviewExecutions,
    review_execution_coverage: executionIds.length ? 'recorded_ids_only' : 'legacy_unknown',
    phase_coverage: phaseCoverage, parallel_groups: parallelGroups(intervals), open_intervals: open, intervals,
  };
}

export function aggregate(runs) {
  const groups = runs.flatMap((r) => r.parallel_groups);
  const ratio = (review, build) => median(runs.filter((r) => Number.isFinite(r.durations[review]) && r.durations[build] > 0).map((r) => r.durations[review] / r.durations[build]));
  return {
    runs: runs.length,
    completed_runs: runs.filter((r) => r.outcome === 'complete').length,
    failed_runs: runs.filter((r) => r.outcome === 'fail').length,
    open_runs: runs.filter((r) => r.open_intervals.length).length,
    integrity_affected_runs: runs.filter((r) => r.integrity_warnings.length).length,
    planning_runs: runs.filter((r) => r.open_state === 'planning_or_approval').length,
    waiting_runs: runs.filter((r) => r.open_state === 'waiting').length,
    open_without_wait: runs.filter((r) => r.open_state === 'active_or_unexpected_stop').length,
    review_median_ms: median(runs.map((r) => r.durations.review_ms)),
    standard_review_median_ms: median(runs.filter((r) => r.review_profile === 'standard').map((r) => r.durations.review_ms)),
    elevated_review_median_ms: median(runs.filter((r) => r.review_profile === 'elevated').map((r) => r.durations.review_ms)),
    review_to_build_ratio_median: ratio('review_ms', 'build_ms'),
    review_to_build_excluding_recorded_waits_ratio_median: ratio('review_wall_excluding_recorded_waits_ms', 'build_wall_excluding_recorded_waits_ms'),
    counter_mismatch_runs: runs.filter((r) => r.counters.repair_batches.mismatch || r.counters.confirmations.mismatch).length,
    primary_degradations_observed: runs.reduce((n, r) => n + r.counters.primary_degradations_observed, 0),
    optional_degradations_observed: runs.reduce((n, r) => n + r.counters.optional_degradations_observed, 0),
    parallel_groups: groups.length,
    peak_concurrency: groups.length ? Math.max(...groups.map((g) => g.peak_concurrency)) : null,
    frontend_backend_union_overlap_pct_median: median(groups.map((g) => g.frontend_backend_union_overlap_pct)),
  };
}

const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
const UNKNOWN = 'unknown';
/** Bucket of usage records that carry no phase (usage.mjs imports without --phase): ticket budget only. */
const PHASE_UNKNOWN = 'phase unknown';
const known = (v) => typeof v === 'number' && Number.isFinite(v);

/** Processed tokens of one usage record, or null when it reports no token counter. */
function processed(record) {
  const present = TOKEN_KEYS.filter((k) => known(record[k]));
  return present.length ? present.reduce((n, k) => n + record[k], 0) : null;
}

/**
 * Joins provider-reported usage records into a run summary by `run_id`.
 * Returns a copy of `run` with `usage`: tokens by role (processed = input +
 * output + cache read + cache write; `'unknown'` when no record of the role
 * reports a counter), the total, the orchestrator share in percent, and
 * reported cost partitioned by `cost_basis` (bases are never added together).
 * @param {object} run a `buildRun` result
 * @param {object[]} records usage records (any run; others are ignored)
 */
export function attachUsage(run, records) {
  const mine = (Array.isArray(records) ? records : []).filter((r) => r && r.run_id === run.run_id);
  const roles = {};
  const phases = {};
  const cost = {};
  for (const r of mine) {
    const phase = phases[typeof r.phase === 'string' && r.phase ? r.phase : PHASE_UNKNOWN] ??= { events: 0, processed_tokens: null };
    phase.events++;
    const role = typeof r.role === 'string' && r.role ? r.role : UNKNOWN;
    const slot = roles[role] ??= { events: 0, processed_tokens: null };
    slot.events++;
    const p = processed(r);
    if (p !== null) { slot.processed_tokens = (slot.processed_tokens ?? 0) + p; phase.processed_tokens = (phase.processed_tokens ?? 0) + p; }
    if (known(r.reported_cost_usd)) {
      const basis = typeof r.cost_basis === 'string' && /^[a-z_]{1,32}$/.test(r.cost_basis) ? r.cost_basis : UNKNOWN;
      const slotCost = cost[basis] ??= { reported_cost_usd: 0 };
      slotCost.reported_cost_usd += r.reported_cost_usd;
    }
  }
  for (const slot of [...Object.values(roles), ...Object.values(phases)]) slot.processed_tokens ??= UNKNOWN;
  const totals = Object.values(roles).map((r) => r.processed_tokens).filter(known);
  const total = totals.length ? totals.reduce((a, b) => a + b, 0) : null;
  const orchestrator = roles.orchestrator?.processed_tokens;
  const anyUnknown = mine.some((r) => processed(r) === null); // one record without counters makes the share unknowable
  return { ...run, usage: {
    tokens_by_role: mine.length ? roles : UNKNOWN,
    tokens_by_phase: mine.length ? phases : UNKNOWN,
    processed_tokens_total: total ?? UNKNOWN,
    orchestrator_share_pct: known(orchestrator) && !anyUnknown && total > 0 ? Math.round(orchestrator / total * 1000) / 10 : UNKNOWN,
    cost_by_basis: cost,
  } };
}

/**
 * Cost per accepted ticket, partitioned by cost basis. A ticket is accepted
 * when any of its runs completed. Per basis the divisor is the number of
 * accepted tickets that reported cost in that basis; no cross-basis figure
 * exists. Runs without `usage` (not joined) are skipped.
 * @param {object[]} runs `attachUsage` results
 */
export function aggregateUsage(runs) {
  const tickets = new Map();
  for (const r of runs) {
    const t = tickets.get(r.ticket) ?? { accepted: false, cost: {} };
    tickets.set(r.ticket, t);
    if (r.outcome === 'complete') t.accepted = true;
    for (const [basis, c] of Object.entries(r.usage?.cost_by_basis ?? {})) t.cost[basis] = (t.cost[basis] ?? 0) + c.reported_cost_usd;
  }
  const accepted = [...tickets.values()].filter((t) => t.accepted);
  const bases = {};
  for (const t of accepted) {
    for (const [basis, usd] of Object.entries(t.cost)) {
      const b = bases[basis] ??= { accepted_tickets_with_cost: 0, reported_cost_usd_total: 0 };
      b.accepted_tickets_with_cost++;
      b.reported_cost_usd_total += usd;
    }
  }
  for (const b of Object.values(bases)) b.per_accepted_ticket = Math.round(b.reported_cost_usd_total / b.accepted_tickets_with_cost * 1e6) / 1e6;
  return { accepted_tickets: accepted.length, cost_per_accepted_ticket_by_basis: bases,
    note: 'Partitioned by cost_basis; bases are never added together.' };
}

/**
 * Attempts whose launcher output passed the 32 MiB capture cap (B12): `[{attempt_id, kind, node,
 * stdout_bytes}]`, empty when none. A flag only: the attempt's outcome was decided as without it.
 * @param {object|null} state
 */
export const truncatedOutputs = (state) => (Array.isArray(state?.attempts) ? state.attempts : [])
  .filter((a) => a?.envelope?.truncated === true)
  .map((a) => ({ attempt_id: a.attempt_id, kind: a.kind, node: a.node, stdout_bytes: a.envelope.stdout_bytes ?? UNKNOWN }));

/**
 * Resource and parallelism metrics from an engine state's attempts (Wave 1 instrumentation).
 * Only attempts with a launcher envelope count. Every value is `unknown` when its source is missing,
 * never 0: `peak_rss_mb` / `peak_cpu_pct` are the max over attempts of the launcher's sampled
 * process-group peaks (an attempt whose sampler recorded `unknown` contributes nothing, and no
 * numeric peak at all is `unknown`); `parallel_efficiency` = sum of attempt durations (started_at ..
 * envelope.ended_at) / (wall x width), wall being first start to last end of those attempts.
 * @param {object|null} state
 */
export function engineResources(state) {
  const attempts = (Array.isArray(state?.attempts) ? state.attempts : []).filter((a) => a?.envelope);
  const maxOf = (key) => { const v = attempts.map((a) => a.envelope[key]).filter(known); return v.length ? Math.max(...v) : UNKNOWN; };
  const spans = attempts.map((a) => [Date.parse(a.started_at), Date.parse(a.envelope.ended_at)]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s);
  const width = state?.config?.width ?? 1;
  const wall = spans.length ? Math.max(...spans.map((x) => x[1])) - Math.min(...spans.map((x) => x[0])) : 0;
  const busy = spans.reduce((a, [s, e]) => a + (e - s), 0);
  return { peak_rss_mb: maxOf('peak_rss_mb'), peak_cpu_pct: maxOf('peak_cpu_pct'),
    parallel_efficiency: wall > 0 && known(width) && width > 0 ? Math.round(busy / (wall * width) * 1000) / 1000 : UNKNOWN };
}
