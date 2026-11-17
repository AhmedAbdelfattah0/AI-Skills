#!/usr/bin/env node
/**
 * Linked CI snapshot contract (ASTF-39, S-05a): turns raw GitHub check-run, job and annotation pages into a
 * bound, complete, hashed snapshot, or says precisely why it is not one. It maps NOTHING to a verdict: billing
 * detection (R1-R6) and `LOCAL_CI_VERIFIED` belong to later slices, which must refuse unless `state === 'complete'`.
 * Project-agnostic. Missing, null or unknown is `unknown`/`unbound`/`incomplete`, never zero, never pass.
 *
 *   ci-snapshot.mjs check --snapshot <dir> --repo <owner/name> --sha <40 hex>
 *
 * Snapshot directory (input files only; this module never fetches, and never follows a symlink):
 *   check-runs.jsonl            `gh api --paginate commits/<sha>/check-runs --jq '{total_count}, .check_runs[]'`
 *   jobs/<name>.jsonl           ONE file per call of `actions/runs/<id>/attempts/<n>/jobs` (same line shape;
 *                               the total_count rule is per call, so calls must not be concatenated)
 *   annotations/<check-run-id>.jsonl   `check-runs/<id>/annotations --jq '.[]'` (optional when the count is 0)
 * Pages: every call must carry `total_count` on each page, the totals must agree, and the items listed must equal
 * the total, else `incomplete`. A line that is not a JSON object, an unexpected file, a duplicate id, an id that is
 * not a safe integer or digit string: `invalid`.
 *
 * Binding (identity = repository + head SHA): an Actions check run is `bound` only when exactly ONE job names it by
 * `check_run_url` (`/repos/<repo>/check-runs/<id>`, repo equal to --repo), with `head_sha` equal to --sha, the same
 * name, an integer `run_attempt >= 1` and a run id. Two identities, no job, another repo, another head, another case:
 * `unbound`. A non-Actions check run is `external`; its head SHA must still match. A job no check run names is orphan.
 * Supersession: a failed bound attempt is `superseded` only by a higher attempt of the SAME run and job name; a same
 * name in another run never supersedes (`not_superseded`).
 * `provider_snapshot_sha256` = sha256 of the canonical JSON (sorted keys) of every raw line, by file; the raw text
 * is not echoed. Exit: 0 only when the snapshot is complete and fully bound, 1 otherwise, 2 usage.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'ci-snapshot-v1';
const MAX_BYTES = 64 * 1024 * 1024;
const OK_CONCLUSIONS = ['success', 'neutral', 'skipped'];
const failedConclusion = (c) => typeof c === 'string' && !['success', 'neutral', 'skipped'].includes(c);

/** An id as a canonical digit string, or null (numbers must be safe integers; strings must be digits only). */
export const idStr = (v) => (typeof v === 'number' ? (Number.isSafeInteger(v) && v >= 0 ? String(v) : null) : typeof v === 'string' && /^\d+$/.test(v) ? v : null);

/** The check-run id named by a job's `check_run_url`, with its `owner/name` (lower-cased), or null. */
export function checkRunRef(url) {
  const m = /^https:\/\/[^/]+\/repos\/([^/]+\/[^/]+)\/check-runs\/(\d+)\/?$/.exec(String(url ?? ''));
  return m ? { repo: m[1].toLowerCase(), id: m[2] } : null;
}

function objectLines(text) {
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    let v;
    try { v = JSON.parse(l); } catch { return null; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    out.push(v);
  }
  return out;
}

/** One paginated call -> { state: 'complete'|'incomplete'|'invalid', items, lines, reason }. */
export function parsePaged(text, isItem) {
  const lines = objectLines(text);
  if (!lines) return { state: 'invalid', items: [], lines: [], reason: 'not_json_lines' };
  const items = lines.filter(isItem);
  const totals = lines.filter((l) => !isItem(l) && Object.hasOwn(l, 'total_count')).map((l) => l.total_count);
  if (items.length + totals.length !== lines.length) return { state: 'invalid', items: [], lines, reason: 'unrecognised_line' };
  if (!totals.length || !totals.every((t) => Number.isInteger(t) && t >= 0)) return { state: 'incomplete', items, lines, reason: 'no_total_count' };
  if (new Set(totals).size !== 1) return { state: 'incomplete', items, lines, reason: 'total_count_disagree' };
  if (items.length !== totals[0]) return { state: 'incomplete', items, lines, reason: 'items_differ_from_total' };
  return { state: 'complete', items, lines, reason: null };
}

/** The input status of one job. Only a failure-class job needs `steps` and `runner_name`; a skipped one may have a null runner. */
export function classifyJob(j) {
  if (typeof j.conclusion !== 'string') return { input_status: 'unknown', reason: 'conclusion_missing' };
  if (j.conclusion === 'skipped') return j.runner_name === null ? { input_status: 'outside_r3', reason: null } : typeof j.runner_name === 'string' ? { input_status: 'ok', reason: null } : { input_status: 'unknown', reason: 'runner_name_missing' };
  if (OK_CONCLUSIONS.includes(j.conclusion)) return { input_status: 'ok', reason: null };
  if (!Array.isArray(j.steps)) return { input_status: 'unknown', reason: 'steps_missing' };
  if (typeof j.runner_name !== 'string') return { input_status: 'unknown', reason: 'runner_name_missing' };
  return { input_status: 'ok', reason: null };
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

/**
 * The pure core. `texts` = { checkRuns: string|null, jobs: { <file>: string }|null, annotations: { <file>: string }, problems: [] }.
 * -> the snapshot (see the header). `state` is the worst of the parts: invalid > incomplete > complete.
 */
export function buildSnapshot({ texts, repo, sha }) {
  const reasons = [];
  let state = 'complete';
  const worse = (s, why) => { reasons.push(why); if (s === 'invalid' || (s === 'incomplete' && state === 'complete')) state = s; };
  const repoKey = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo)) ? String(repo).toLowerCase() : null;
  const head = /^[0-9a-fA-F]{40}$/.test(String(sha)) ? String(sha).toLowerCase() : null;
  if (!repoKey) worse('invalid', 'repo_malformed');
  if (!head) worse('invalid', 'sha_malformed');
  for (const p of texts.problems ?? []) worse('invalid', p);
  const raw = { check_runs: [], jobs: {}, annotations: {} };

  let checks = [];
  if (texts.checkRuns == null) worse('incomplete', 'check_runs_missing');
  else {
    const r = parsePaged(texts.checkRuns, (l) => Object.hasOwn(l, 'name'));
    raw.check_runs = r.lines;
    if (r.state !== 'complete') worse(r.state, `check_runs_${r.reason}`);
    checks = r.items;
  }
  let jobs = [];
  if (texts.jobs == null) worse('incomplete', 'jobs_missing');
  else for (const [file, text] of Object.entries(texts.jobs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const r = parsePaged(text, (l) => Object.hasOwn(l, 'name') && Object.hasOwn(l, 'id'));
    raw.jobs[file] = r.lines;
    if (r.state !== 'complete') worse(r.state, `jobs_${file}_${r.reason}`);
    jobs.push(...r.items);
  }

  const dup = (list, what) => {
    const seen = new Set();
    for (const x of list) { const id = idStr(x.id); if (id === null) { worse('invalid', `${what}_id_invalid`); continue; } if (seen.has(id)) worse('invalid', `${what}_id_duplicate`); seen.add(id); }
  };
  dup(checks, 'check_run');
  dup(jobs, 'job');

  const byRef = new Map(); // check-run id -> jobs naming it
  for (const j of jobs) { const ref = checkRunRef(j.check_run_url); const k = ref ? ref.id : '\0none'; byRef.set(k, [...(byRef.get(k) ?? []), j]); }
  const jobRows = jobs.map((j) => ({ id: idStr(j.id), name: String(j.name), run_id: idStr(j.run_id), run_attempt: Number.isInteger(j.run_attempt) ? j.run_attempt : null,
    conclusion: typeof j.conclusion === 'string' ? j.conclusion : null, steps: Array.isArray(j.steps) ? j.steps.length : null, ...classifyJob(j), bound: false }));
  const jobRow = new Map(jobRows.map((r) => [r.id, r]));

  const rows = [];
  for (const c of checks) {
    const id = idStr(c.id);
    const row = { id, name: String(c.name), app: typeof c.app?.slug === 'string' ? c.app.slug : null, conclusion: typeof c.conclusion === 'string' ? c.conclusion : null,
      binding: 'unbound', reason: null, job_id: null, run_id: null, run_attempt: null, input_status: 'unbound', supersession: 'not_applicable', annotations: { status: 'unknown', messages: [] } };
    rows.push(row);
    if (typeof c.head_sha !== 'string' || c.head_sha !== head) { row.reason = 'head_sha_mismatch'; continue; }
    if (row.app === null) { row.reason = 'app_missing'; continue; }
    if (row.app !== 'github-actions') { row.binding = 'external'; row.input_status = 'external'; continue; }
    const named = byRef.get(id) ?? [];
    if (!named.length) { row.reason = 'no_job'; continue; }
    const why = named.map((j) => {
      const ref = checkRunRef(j.check_run_url);
      if (ref.repo !== repoKey) return 'job_repo_mismatch';
      if (typeof j.head_sha !== 'string' || j.head_sha !== head) return 'job_head_sha_mismatch';
      if (String(j.name) !== row.name) return 'job_name_mismatch';
      if (!Number.isInteger(j.run_attempt) || j.run_attempt < 1 || idStr(j.run_id) === null) return 'job_identity_invalid';
      return null;
    }).find(Boolean);
    if (why) { row.reason = why; continue; }
    if (named.length > 1) { row.reason = new Set(named.map((j) => `${idStr(j.run_id)}/${j.run_attempt}`)).size > 1 ? 'two_identities' : 'two_jobs'; continue; }
    const jr = jobRow.get(idStr(named[0].id));
    Object.assign(row, { binding: 'bound', job_id: jr.id, run_id: jr.run_id, run_attempt: jr.run_attempt, input_status: jr.input_status, reason: jr.reason });
    jr.bound = true;
  }

  const top = new Map();
  const key = (r) => JSON.stringify([r.run_id, r.name]);
  for (const r of rows) if (r.binding === 'bound') top.set(key(r), Math.max(top.get(key(r)) ?? 0, r.run_attempt));
  for (const r of rows) {
    if (!failedConclusion(r.conclusion)) continue;
    const best = r.binding === 'bound' ? top.get(key(r)) : undefined;
    r.supersession = best !== undefined && r.run_attempt < best ? 'superseded' : 'not_superseded';
    if (r.supersession === 'superseded') r.superseded_by_attempt = best;
  }

  const checkById = new Map(checks.map((c) => [idStr(c.id), c]));
  for (const [file, text] of Object.entries(texts.annotations ?? {})) {
    const id = /^(\d+)\.jsonl$/.exec(file)?.[1];
    const lines = objectLines(text);
    if (!id || !checkById.has(id)) { worse('invalid', `annotations_${file}_unexpected`); continue; }
    if (!lines || !lines.every((l) => typeof l.message === 'string')) { worse('invalid', `annotations_${file}_not_annotations`); continue; }
    raw.annotations[file] = lines;
  }
  for (const row of rows) {
    const expected = checkById.get(row.id)?.output?.annotations_count;
    const got = raw.annotations[`${row.id}.jsonl`];
    const a = row.annotations;
    if (!Number.isInteger(expected) || expected < 0) { a.status = 'unknown'; continue; }
    const n = got ? got.length : 0;
    a.status = expected === 0 ? (n === 0 ? 'none' : 'incomplete') : got === undefined ? 'missing' : n === expected ? 'present' : 'incomplete';
    if (a.status === 'present') a.messages = got.map((l) => l.message);
    if (a.status === 'incomplete' || a.status === 'missing') { a.expected = expected; a.listed = n; }
  }

  const orphan = jobRows.filter((j) => !j.bound).map((j) => j.id);
  const unbound = rows.filter((r) => r.binding === 'unbound').map((r) => r.id);
  const sha256 = state === 'invalid' ? null : createHash('sha256').update(JSON.stringify(canon(raw))).digest('hex');
  return { schema: SCHEMA, repo: repoKey, head_sha: head, state, reasons, binding_complete: unbound.length === 0 && orphan.length === 0 && state === 'complete',
    provider_snapshot_sha256: sha256, check_runs: rows, jobs: jobRows, unbound_check_runs: unbound, orphan_jobs: orphan };
}

function readText(path, problems) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) { problems.push('file_not_regular_or_too_large'); return null; }
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (e) { if (e?.code !== 'ENOENT') problems.push('file_unreadable_or_not_utf8'); return null; }
}

function readDir(dir, sub, namePattern, problems) {
  let names;
  try { const st = lstatSync(join(dir, sub)); if (!st.isDirectory()) { problems.push(`${sub}_not_a_directory`); return null; } names = readdirSync(join(dir, sub)); } catch (e) { if (e?.code !== 'ENOENT') problems.push(`${sub}_unreadable`); return null; }
  const out = {};
  for (const n of names) { if (!namePattern.test(n)) { problems.push(`${sub}_unexpected_entry`); continue; } const t = readText(join(dir, sub, n), problems); if (t !== null) out[n] = t; }
  return out;
}

/** Read a snapshot directory (see the header) and build it. */
export function readSnapshot({ dir, repo, sha }) {
  const problems = [];
  const texts = { checkRuns: readText(join(dir, 'check-runs.jsonl'), problems), jobs: readDir(dir, 'jobs', /^[A-Za-z0-9._-]+\.jsonl$/, problems),
    annotations: readDir(dir, 'annotations', /^\d+\.jsonl$/, problems) ?? {}, problems };
  try { for (const n of readdirSync(dir)) if (!['check-runs.jsonl', 'jobs', 'annotations'].includes(n)) problems.push('snapshot_unexpected_entry'); } catch { problems.push('snapshot_dir_unreadable'); }
  return buildSnapshot({ texts, repo, sha });
}

export function main(argv) {
  const f = {};
  const [cmd, ...rest] = argv;
  for (let i = 0; i < rest.length; i += 2) { if (!rest[i].startsWith('--') || rest[i + 1] === undefined) { f.bad = true; break; } f[rest[i].slice(2)] = rest[i + 1]; }
  if (cmd !== 'check' || f.bad || !f.snapshot || !f.repo || !f.sha) { process.stderr.write('Usage: ci-snapshot.mjs check --snapshot <dir> --repo <owner/name> --sha <40 hex>\n'); return 2; }
  const s = readSnapshot({ dir: f.snapshot, repo: f.repo, sha: f.sha });
  process.stdout.write(JSON.stringify(s) + '\n');
  return s.binding_complete ? 0 : 1;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
