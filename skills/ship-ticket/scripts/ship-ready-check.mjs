#!/usr/bin/env node
/**
 * Ship-ready cross-check (AIS-BENCH-1 Wave 2b). Every SHIP_READY event in a plan's RUN-STATE block
 * must be backed by a `GATE ship-ready ok` event with the same run id and candidate id in the engine log. The
 * engine writes the pair; a hand-written SHIP_READY has no engine line and fails. Read-only; an
 * orchestrator tool that no engine module calls. Dependency-free Node >= 18; no clock.
 *
 * CLI: ship-ready-check.mjs check --run-state <plan.md> --engine-log <file>... [--run-id <ID>] [--require-event]
 * Matching is on the pair (run_id, candidate_id); a SHIP_READY without run_id is unmatched. --run-id checks
 * only that run's SHIP_READY events; --engine-log may repeat (log lines are pooled).
 * A malformed RUN-STATE block (run-state.mjs malformedReason: a `{` line that is not JSON, such as a
 * truncated event, a missing or stray marker, a hidden line break) fails before any matching, so a
 * damaged line can never hide a SHIP_READY. With --require-event a block holding no SHIP_READY fails
 * (use it after SHIP_READY was appended); without it, zero SHIP_READY passes.
 * Exit codes: 0 pass, 1 malformed block, unmatched or (with --require-event) missing SHIP_READY, or
 * unreadable input; 2 usage error.
 * S5 (F05): with --repo <R> --ticket <T>, a pass also prints `run-log integrity: events=N runs=M open_phases=K warnings=W
 * loss_records=L` (or `run-log integrity: unavailable (<why>)`) from run-log.mjs's pure reader. It is information only:
 * it NEVER changes the exit code, and it claims only what was parsed, counted and paired, never completeness or authenticity.
 */
import { readFileSync } from 'node:fs';
import { malformedReason, parseRunState, splitLines } from './run-state.mjs';
import { isEntrypoint } from './harness.mjs';

const pairKey = (runId, candidate) => JSON.stringify([runId, candidate]);

/** `[run_id, candidate_id]` pair keys of GATE ship-ready ok events in engine-log text (JSON lines; others ignored). */
export function gateOkCandidates(logText) {
  const ids = new Set();
  for (const line of splitLines(logText)) {
    if (!line.trim().startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && e.event === 'GATE' && e.gate === 'ship-ready' && e.ok === true && typeof e.candidate_id === 'string' && e.candidate_id && typeof e.run_id === 'string' && e.run_id) ids.add(pairKey(e.run_id, e.candidate_id));
  }
  return ids;
}

/**
 * Compare a plan's RUN-STATE with an engine log. Returns { ok, shipReady, unmatched, reason }:
 * `unmatched` lists each SHIP_READY candidate id (null when the event carries none) with no log line.
 * A malformed block fails first; `requireEvent` makes a block with no SHIP_READY fail.
 */
export function checkShipReady(planText, logText, { requireEvent = false, runId = null } = {}) {
  const R = parseRunState(planText);
  if (!R) return { ok: false, shipReady: [], unmatched: [], reason: 'plan has no RUN-STATE block' };
  const bad = malformedReason(R);
  if (bad) return { ok: false, shipReady: [], unmatched: [], reason: 'malformed RUN-STATE: ' + bad };
  const events = R.events.filter((e) => e.event === 'SHIP_READY' && (runId === null || e.run_id === runId));
  const shipReady = events.map((e) => (typeof e.candidate_id === 'string' && e.candidate_id ? e.candidate_id : null));
  if (requireEvent && shipReady.length === 0) return { ok: false, shipReady, unmatched: [], reason: 'no SHIP_READY event in RUN-STATE (--require-event)' };
  const matched = gateOkCandidates(logText);
  const unmatched = events.map((e, i) => [e, shipReady[i]])
    .filter(([e, id]) => id === null || typeof e.run_id !== 'string' || !e.run_id || !matched.has(pairKey(e.run_id, id))).map(([, id]) => id);
  const reason = unmatched.length
    ? 'SHIP_READY without a matching engine "GATE ship-ready ok" line for candidate: ' + unmatched.map((id) => id ?? '(no candidate_id)').join(', ')
    : '';
  return { ok: unmatched.length === 0, shipReady, unmatched, reason };
}

/** The integrity line for --repo/--ticket (S5); never throws. run-log.mjs is loaded only when asked for. */
export async function integrityLine(repo, ticket) {
  try {
    const { integritySummary } = await import('./run-log.mjs');
    const r = integritySummary(repo, ticket);
    if (r.unavailable !== undefined) return `run-log integrity: unavailable (${r.unavailable})`;
    return `run-log integrity: events=${r.events} runs=${r.runs} open_phases=${r.open_phases} warnings=${r.warnings} loss_records=${r.loss_records}`
      + (r.future_history ? ` degraded=future_history(${r.future_history})` : '')
      // Abandoned runs are never complete; partial_legacy runs may have history only in a pre-S5 archive (S5 cutover).
      + (r.abandoned_runs ? ` abandoned=${r.abandoned_runs}` : '')
      + (r.partial_legacy_runs ? ` partial_legacy=${r.partial_legacy_runs}` : '')
      + (r.legacy_present?.files ? ` legacy_present=${r.legacy_present.lines === 'unavailable' ? 'unavailable' : r.legacy_present.lines}` : '');
  } catch (e) { return `run-log integrity: unavailable (${String(e?.message ?? e).split('\n')[0]})`; }
}

async function main(argv) {
  const [cmd, ...all] = argv;
  // The one boolean flag is taken out first: the pairwise loop below would swallow the next flag as its value.
  const requireEvent = all.includes('--require-event');
  const rest = all.filter((a) => a !== '--require-event');
  const flags = {};
  const logs = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) { flags.bad = true; break; }
    if (rest[i] === '--engine-log') logs.push(rest[i + 1]); else flags[rest[i].slice(2)] = rest[i + 1];
  }
  if (cmd !== 'check' || flags.bad || !flags['run-state'] || !logs.length) {
    process.stderr.write('Usage: ship-ready-check.mjs check --run-state <plan.md> --engine-log <file>... [--run-id <ID>] [--require-event] [--repo <R> --ticket <T>]\n');
    return 2;
  }
  let plan, log;
  try { plan = readFileSync(flags['run-state'], 'utf8'); log = logs.map((f) => readFileSync(f, 'utf8')).join('\n'); }
  catch (e) { process.stderr.write(`ship-ready-check: ${e.message}\n`); return 1; }
  const r = checkShipReady(plan, log, { requireEvent, runId: flags['run-id'] ?? null });
  if (!r.ok) { process.stderr.write(`ship-ready-check: FAIL ${r.reason}\n`); return 1; }
  process.stdout.write(`ship-ready-check: ok (${r.shipReady.length} SHIP_READY matched)\n`);
  if (flags.repo !== undefined && flags.ticket !== undefined) process.stdout.write(`${await integrityLine(flags.repo, flags.ticket)}\n`);
  return 0;
}

if (isEntrypoint(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
