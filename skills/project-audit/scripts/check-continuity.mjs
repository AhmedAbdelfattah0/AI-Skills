#!/usr/bin/env node
// Read-only structural guard. Evidence truth and full claim equivalence need review.
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const terminal = new Set(['COMPLETE', 'COMPLETE_DEGRADED', 'INCOMPLETE']);
const mapped = new Set(['RETAINED', 'MAPPED', 'PARTIAL']);
const pending = new Set(['PARTIAL', 'NOT_RECHECKED']);
const dispositions = new Set([...mapped, ...pending, 'RESOLVED', 'REJECTED', 'OUT_OF_SCOPE']);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(nonblank);
const evidence = value => strings(value) && value.length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function records(value, key, label) {
  if (!Array.isArray(value) && !object(value)) throw new Error(`Unsupported ${label} collection`);
  const entries = Array.isArray(value) ? value.map(v => [v?.[key], v]) : Object.entries(value);
  const result = new Map();
  for (const [fallback, item] of entries) {
    const id = item?.[key] ?? fallback;
    if (!object(item) || !nonblank(id) || result.has(id)
        || (!Array.isArray(value) && item[key] !== undefined && item[key] !== fallback)) {
      throw new Error(`Invalid or duplicate identifier in ${label}`);
    }
    result.set(id, { ...item, [key]: id });
  }
  return result;
}

function header(manifest) {
  const repositories = manifest?.system?.repositories;
  if (manifest?.schema !== 'project-audit/manifest@2'
      || !nonblank(manifest.run_id) || !Number.isFinite(Date.parse(manifest.created_at))
      || ![...terminal, 'IN_PROGRESS', 'WAITING_FOR_USER'].includes(manifest.status)
      || !Array.isArray(repositories) || repositories.length === 0
      || repositories.some(r => !nonblank(r.identity) || !nonblank(r.commit))) {
    throw new Error('Unsupported manifest header, repository identities or pins');
  }
}

function findings(manifest) {
  const result = records(manifest.findings, 'id', 'findings');
  for (const item of result.values()) {
    if (!['Critical', 'High', 'Medium', 'Low'].includes(item.severity)
        || !['CONFIRMED', 'SUSPECTED'].includes(item.status)) {
      throw new Error('Unsupported historical/current finding classification');
    }
  }
  return result;
}

/** Validate accounting only; never infer equivalence from IDs, titles or digests. */
export function checkContinuity(current, priors) {
  header(current);
  const now = findings(current);
  const rows = records(current.coverage, 'row_id', 'coverage');
  const gaps = records(current.degradations, 'id', 'degradations');
  const sources = new Map();
  const priorRuns = new Set();
  for (const prior of priors) {
    header(prior);
    if (!terminal.has(prior.status) || prior.run_id === current.run_id
        || Date.parse(prior.created_at) >= Date.parse(current.created_at)
        || priorRuns.has(prior.run_id)) throw new Error('Invalid or duplicate prior run');
    priorRuns.add(prior.run_id);
    for (const [id, finding] of findings(prior)) sources.set(`${prior.run_id}/${id}`, finding);
  }

  const issues = [];
  const issue = (code, source = null) => issues.push({ code, ...(source ? { source } : {}) });
  const reconciliation = current.reconciliation;
  const declared = reconciliation?.prior_runs;
  if (!strings(declared) || new Set(declared).size !== declared.length
      || declared.length !== priorRuns.size || declared.some(id => !priorRuns.has(id))) {
    issue('PRIOR_RUN_INVENTORY_MISMATCH');
  }
  const ledger = reconciliation?.prior_findings;
  if (!Array.isArray(ledger)) issue('MISSING_PRIOR_FINDING_LEDGER');
  const seen = new Set();
  const counts = {};
  let criticalResidual = false;
  let hasResidual = false;
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    const source = entry?.source;
    if (!object(entry) || !sources.has(source)) { issue('UNKNOWN_SOURCE', source); continue; }
    if (seen.has(source)) issue('DUPLICATE_SOURCE', source);
    seen.add(source);
    const old = sources.get(source);
    const disposition = entry.disposition;
    if (!dispositions.has(disposition)) issue('INVALID_DISPOSITION', source);
    else counts[disposition] = (counts[disposition] ?? 0) + 1;
    if (!nonblank(entry.reason)) issue('MISSING_REASON', source);
    if (!strings(entry.evidence) || (disposition !== 'NOT_RECHECKED' && !evidence(entry.evidence))) {
      issue('MISSING_DECISION_EVIDENCE', source);
    }
    const ids = strings(entry.current_ids) ? entry.current_ids : [];
    if (!strings(entry.current_ids) || new Set(ids).size !== ids.length
        || (mapped.has(disposition) ? ids.length === 0 : ids.length !== 0)) {
      issue('INVALID_TARGETS', source);
    }
    if (disposition === 'RETAINED' && (ids.length !== 1 || ids[0] !== old.id)) {
      issue('RETAINED_ID_MISMATCH', source);
    }
    const changes = entry.classification_changes;
    if (!object(changes)) issue('MISSING_CLASSIFICATION_CHANGE_MAP', source);
    else if (Object.keys(changes).some(id => !ids.includes(id))) issue('UNKNOWN_CHANGE_TARGET', source);
    for (const id of ids) {
      const target = now.get(id);
      if (!target) { issue('UNKNOWN_CURRENT_FINDING', source); continue; }
      if (old.severity !== target.severity || old.status !== target.status) {
        if (!nonblank(changes?.[id]?.reason) || !evidence(changes?.[id]?.evidence)) {
          issue('UNEXPLAINED_CLASSIFICATION_CHANGE', source);
        }
      }
    }
    if (!pending.has(disposition)) continue;
    hasResidual = true;
    const residual = entry.residual;
    if (!nonblank(residual?.description) || !evidence(residual?.rows) || !evidence(residual?.degradations)) {
      issue('MISSING_RESIDUAL_SCOPE', source);
      continue;
    }
    const critical = ['Critical', 'High'].includes(old.severity)
      || residual.rows.some(id => rows.get(id)?.criticality === 'critical');
    criticalResidual ||= critical;
    for (const rowId of residual.rows) {
      const row = rows.get(rowId);
      if (!row || !['DEGRADED', 'FAIL'].includes(row.outcome)
          || !Array.isArray(row.degradations)
          || !residual.degradations.some(id => row.degradations.includes(id)
            && (gaps.get(id)?.rows ?? gaps.get(id)?.affected_rows ?? []).includes(rowId))) {
        issue('UNLINKED_RESIDUAL_ROW', source);
      }
    }
    for (const gapId of residual.degradations) {
      const gap = gaps.get(gapId);
      const affected = gap?.rows ?? gap?.affected_rows;
      if (!gap || gap.kind !== 'coverage' || gap.resolved !== false
          || !nonblank(gap.closing_action) || !strings(affected)
          || !affected.some(id => residual.rows.includes(id) && rows.get(id)?.degradations?.includes(gapId))
          || (critical && gap.critical !== true)) {
        issue('INVALID_RESIDUAL_DEGRADATION', source);
      }
    }
  }
  const missing = [...sources.keys()].filter(source => !seen.has(source));
  if (missing.length) issue('UNACCOUNTED_PRIOR_FINDINGS');
  if (hasResidual && current.status === 'COMPLETE') issue('RESIDUAL_REQUIRES_DEGRADED_STATUS');
  if (criticalResidual && current.release_assessment?.category === 'NO_BLOCKERS_OBSERVED') {
    issue('CRITICAL_RESIDUAL_FORBIDS_CLEAR_ASSESSMENT');
  }
  return { ok: issues.length === 0, prior_runs: priorRuns.size, prior_observations: sources.size,
    accounted_observations: seen.size, dispositions: counts, issues, missing_sources: missing };
}

async function readManifest(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`Unreadable manifest: ${file}`); }
}

/** Auto-discovery prevents a caller from accidentally checking only matching history. */
export async function loadHistory(currentPath, extraPaths = []) {
  const currentFile = await realpath(currentPath);
  const current = await readManifest(currentFile);
  header(current);
  const root = path.dirname(path.dirname(currentFile));
  const identities = new Set(current.system.repositories.map(r => r.identity));
  const paths = new Set();
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const file = path.join(root, dir.name, 'manifest.json');
    let canonical;
    try { canonical = await realpath(file); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (canonical !== currentFile) paths.add(canonical);
  }
  const explicit = new Set();
  for (const file of extraPaths) { const canonical = await realpath(file); paths.add(canonical); explicit.add(canonical); }
  const priors = [];
  for (const file of [...paths].sort()) {
    const prior = await readManifest(file);
    header(prior); // Unknown or corrupt history must not silently look empty.
    const eligible = prior.run_id !== current.run_id && terminal.has(prior.status)
      && Date.parse(prior.created_at) < Date.parse(current.created_at);
    if (explicit.has(file) && !eligible) throw new Error(`Explicit input is not an earlier terminal run: ${file}`);
    if (eligible && (explicit.has(file) || prior.system.repositories.some(r => identities.has(r.identity)))) {
      priors.push(prior);
    }
  }
  return { current, priors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: check-continuity.mjs CURRENT_MANIFEST [EXTRA_PRIOR_MANIFEST ...]');
    const { current, priors } = await loadHistory(process.argv[2], process.argv.slice(3));
    const result = checkContinuity(current, priors);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 2;
  }
}
