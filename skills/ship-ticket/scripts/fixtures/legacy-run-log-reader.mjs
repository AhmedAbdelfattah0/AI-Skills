// FROZEN pre-S5 run-log reader (test fixture; never imported by production code).
// Source: `git show 3b7792c9c1f45dc654a75504589d3e55c659ac92:skills/ship-ticket/scripts/run-log.mjs`
// (blob a70bed5dfb661c7af02d9d2657179eed99d3611b; origin/main before the S5 merge, committed 2026-11-22).
// The text between the BEGIN/END markers is copied verbatim (LF line ends) from that blob, from
// `function rowsFromText` up to (not including) `function carrierBinding`. run-log.test.mjs proves an OLD
// reader accepts rows carrying the S5 keys `timestamp_source` and `label`, and pins the verbatim text against
// the blob whenever that git object is available. The header supplies what the body references:
//   - SCHEMA and the event-name list are FROZEN here (values the pre-S5 reader had through
//     measure/events.mjs at that commit: RUN_LOG_SCHEMA and EVENT_NAMES), so this reader never follows the
//     current schema or event vocabulary. run-log.test.mjs fails if either drifts from the frozen value.
//   - buildRun is the CURRENT run-summary module. It is used only after row acceptance, to derive pairing
//     integrity warnings; it cannot change which rows are accepted or rejected.
import { basename } from 'node:path';
import { buildRun } from '../run-summary.mjs';

const SCHEMA = 'ship-ticket-run-log-v1';
const FROZEN_EVENT_NAMES = new Set(['run_mode', 'review_lane', 'repair_batch', 'gate_run', 'owner_decision', 'host_sleep', 'milestone', 'finding', 'closure', 'log_loss']);
const isEventName = (name) => typeof name === 'string' && FROZEN_EVENT_NAMES.has(name);

const KINDS = new Set(['workflow', 'phase', 'activity', 'wait']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// BEGIN verbatim
export function rowsFromText(contents, path) {
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
// END verbatim
