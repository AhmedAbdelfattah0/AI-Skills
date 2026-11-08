/**
 * The worker's final message and its fenced `ship-ticket-report` block, for carrier.mjs. Moved
 * out of carrier.mjs unchanged (re-exported there). No imports.
 */

/** Extract the worker's final message text and error flag from provider output. */
export function finalMessage(provider, stdout) {
  if (provider === 'claude') {
    try { const r = JSON.parse(stdout); return { text: typeof r.result === 'string' ? r.result : null, is_error: r.is_error === true }; }
    catch { return { text: null, is_error: true }; }
  }
  if (provider === 'codex') {
    let text = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      try { const e = JSON.parse(line); if (e.type === 'item.completed' && e.item?.type === 'agent_message') text = e.item.text; } catch { /* skip */ }
    }
    return { text, is_error: text === null };
  }
  return { text: null, is_error: false };
}

const REPORT_FENCE = /```ship-ticket-report[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
const REPORT_KEYS = ['tests', 'red_seen', 'blockers', 'needs_outside_ownership'];
const stringList = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');

/**
 * Parse and validate the LAST fenced `ship-ticket-report` block of a worker's
 * final message: `{tests:[{cmd, result:'pass'|'fail'}], red_seen:[], blockers:[],
 * needs_outside_ownership:[]}` (exactly these keys). Returns
 * `{status:'structured', report}` or `{status:'unstructured', failure}`; never throws.
 */
export function parseWorkerReport(text) {
  if (typeof text !== 'string') return { status: 'unstructured', failure: 'no final message' };
  const blocks = [...text.matchAll(REPORT_FENCE)];
  if (!blocks.length) return { status: 'unstructured', failure: 'no ship-ticket-report block' };
  let report;
  try { report = JSON.parse(blocks[blocks.length - 1][1]); } catch (e) { return { status: 'unstructured', failure: 'invalid JSON: ' + e.message }; }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { status: 'unstructured', failure: 'report is not an object' };
  const keys = Object.keys(report);
  const extra = keys.filter(k => !REPORT_KEYS.includes(k));
  const missing = REPORT_KEYS.filter(k => !keys.includes(k));
  if (extra.length || missing.length) return { status: 'unstructured', failure: 'report keys: missing [' + missing + '] unexpected [' + extra + ']' };
  if (!Array.isArray(report.tests) || !report.tests.every(t => t && typeof t === 'object' && !Array.isArray(t)
    && typeof t.cmd === 'string' && t.cmd.length > 0 && (t.result === 'pass' || t.result === 'fail')))
    return { status: 'unstructured', failure: 'tests must be [{cmd, result:"pass"|"fail"}]' };
  for (const k of REPORT_KEYS.slice(1)) if (!stringList(report[k])) return { status: 'unstructured', failure: k + ' must be an array of strings' };
  return { status: 'structured', report };
}
