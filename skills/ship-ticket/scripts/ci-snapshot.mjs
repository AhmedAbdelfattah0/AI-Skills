#!/usr/bin/env node
/**
 * Linked CI snapshot contract (ASTF-39, S-05a): turns raw GitHub check-run, job and annotation pages into a
 * bound, complete, hashed snapshot, or says precisely why it is not one. It maps NOTHING to a verdict: billing
 * detection (R1-R6) and `LOCAL_CI_VERIFIED` belong to later slices, which must refuse unless `state === 'complete'`.
 * Project-agnostic. Missing, null or unknown is `unknown`/`unbound`/`incomplete`, never zero, never pass.
 *
 *   ci-snapshot.mjs check --snapshot <dir> --repo <owner/name> --sha <40 hex>
 *
 * Snapshot directory (input files only; this module never fetches, and never follows a symlink, root included):
 *   check-runs.jsonl            `gh api --paginate "commits/<sha>/check-runs?filter=all" --jq '{total_count}, .check_runs[]'`
 *                               (filter=all: the default `latest` drops earlier attempts' check runs)
 *   jobs/<name>.jsonl           ONE file per call of `actions/runs/<id>/attempts/<n>/jobs` (same line shape; the
 *                               total_count rule is per call, so calls must not be concatenated)
 *   annotations/<check-run-id>.jsonl   `check-runs/<id>/annotations --jq '.[]'` (optional when the count is 0)
 *
 * A snapshot is COMPLETE (state 'complete', CLI exit 0) ONLY IF ALL of these predicates hold. Each is implemented
 * once (the `fail(...)` call that names it) and listed in PREDICATES; a failing one is reported in `failed_predicates`.
 * The table-driven test breaks each in turn from a complete snapshot, and fails if a predicate has no breaking case.
 *   identity_args           --repo is owner/name and --sha is 40 hex
 *   files_safe              root, entries: regular, no symlink, UTF-8, within the size cap, no unexpected entry
 *   lines_wellformed        every line is a JSON object; names are strings; no unrecognised line
 *   pages_complete          every call carries total_count on each page, the totals agree, items listed == total;
 *                           check-runs.jsonl and jobs/ exist
 *   ids_canonical_unique    ids are canonical digit strings or safe integers (no leading zero), unique per kind
 *   check_bound_to_repo     EVERY check run (Actions or not) carries its own URL naming --repo and its own id, and
 *                           its head_sha equals --sha; an external check without that is unbound
 *   actions_check_one_job   an Actions check run is named by exactly one job (check_run_url) with the same repo, head
 *                           SHA, name, an integer run_attempt >= 1 and a run id; no job, two jobs, two identities: unbound
 *   ids_agree               a job's own id equals the check-run id its check_run_url names
 *   job_files_coherent      all jobs of one file share one run_id and run_attempt
 *   job_name_unique         no two bound jobs share (run_id, run_attempt, name): the name cannot tell them apart
 *   status_consistent       a check run and its job are both `completed`, with equal conclusions
 *   no_orphan_jobs          every job is named by a check run of the snapshot
 *   annotations_complete    for EVERY check run the listed annotations equal output.annotations_count (absent or
 *                           non-integer count, count > 0 without a file, a count mismatch: not complete)
 * Supersession (reported per row, not a completeness predicate): a failed bound attempt is `superseded` only by a
 * higher attempt of the SAME run_id and job name that is COMPLETED with a conclusion other than null, skipped, neutral
 * or cancelled; anything else is `not_superseded`.
 * `provider_snapshot_sha256` = sha256 of the canonical JSON (sorted keys) of the PARSED raw lines, by file (it does
 * not distinguish whitespace or duplicate keys); null when invalid. Not checked: the API host of `check_run_url`, and
 * whether a partial re-run repeats unchanged jobs under their old ids (needs a real capture).
 * Exit: 0 only when complete, 1 otherwise, 2 usage.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'ci-snapshot-v1';
export const PREDICATES = Object.freeze(['identity_args', 'files_safe', 'lines_wellformed', 'pages_complete', 'ids_canonical_unique', 'check_bound_to_repo',
  'actions_check_one_job', 'ids_agree', 'job_files_coherent', 'job_name_unique', 'status_consistent', 'no_orphan_jobs', 'annotations_complete']);
const MAX_BYTES = 64 * 1024 * 1024;
const OK_CONCLUSIONS = ['success', 'neutral', 'skipped'];
const failedConclusion = (c) => typeof c === 'string' && !OK_CONCLUSIONS.includes(c);
const NOT_EXECUTED = [null, 'skipped', 'neutral', 'cancelled'];

/** An id as a canonical digit string (no leading zero), or null (numbers must be safe integers). */
export const idStr = (v) => (typeof v === 'number' ? (Number.isSafeInteger(v) && v >= 0 ? String(v) : null) : typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? v : null);

/** The check-run id named by a check run's `url` or a job's `check_run_url`, with its `owner/name` (lower-cased), or null. */
export function checkRunRef(url) {
  const m = /^https:\/\/[^/]+\/repos\/([^/]+\/[^/]+)\/check-runs\/(0|[1-9]\d*)\/?$/.exec(String(url ?? ''));
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

/** One paginated call -> { state: 'complete'|'incomplete'|'invalid', items, lines, reason, predicate }. */
export function parsePaged(text, isItem) {
  const lines = objectLines(text);
  if (!lines) return { state: 'invalid', items: [], lines: [], reason: 'not_json_lines', predicate: 'lines_wellformed' };
  const items = lines.filter(isItem);
  const totals = lines.filter((l) => !isItem(l) && Object.hasOwn(l, 'total_count')).map((l) => l.total_count);
  if (items.length + totals.length !== lines.length) return { state: 'invalid', items: [], lines, reason: 'unrecognised_line', predicate: 'lines_wellformed' };
  const inc = (reason) => ({ state: 'incomplete', items, lines, reason, predicate: 'pages_complete' });
  if (!totals.length || !totals.every((n) => Number.isInteger(n) && n >= 0)) return inc('no_total_count');
  if (new Set(totals).size !== 1) return inc('total_count_disagree');
  if (items.length !== totals[0]) return inc('items_differ_from_total');
  return { state: 'complete', items, lines, reason: null, predicate: null };
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
 * The pure core. `texts` = { checkRuns: string|null, jobs: { <file>: string }|null, annotations: { <file>: string }, problems: [[predicate, reason]] }.
 * -> the snapshot (see the header). `state` is the worst of the parts: invalid > incomplete > complete.
 */
export function buildSnapshot({ texts, repo, sha }) {
  const reasons = [], failed = new Set();
  let state = 'complete';
  const fail = (s, predicate, why) => {
    if (!PREDICATES.includes(predicate)) throw new Error(`unknown predicate ${predicate}`);
    reasons.push(why); failed.add(predicate);
    if (s === 'invalid' || (s === 'incomplete' && state === 'complete')) state = s;
  };
  const repoKey = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo)) ? String(repo).toLowerCase() : null;
  const head = /^[0-9a-fA-F]{40}$/.test(String(sha)) ? String(sha).toLowerCase() : null;
  if (!repoKey) fail('invalid', 'identity_args', 'repo_malformed');
  if (!head) fail('invalid', 'identity_args', 'sha_malformed');
  for (const [pred, why] of texts.problems ?? []) fail('invalid', pred, why);
  const raw = { check_runs: [], jobs: {}, annotations: {} };

  let checks = [];
  if (texts.checkRuns == null) fail('incomplete', 'pages_complete', 'check_runs_missing');
  else {
    const r = parsePaged(texts.checkRuns, (l) => Object.hasOwn(l, 'name'));
    raw.check_runs = r.lines;
    if (r.state !== 'complete') fail(r.state, r.predicate, `check_runs_${r.reason}`);
    checks = r.items;
  }
  const jobs = [], jobFile = new Map();
  if (texts.jobs == null) fail('incomplete', 'pages_complete', 'jobs_missing');
  else for (const [file, text] of Object.entries(texts.jobs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const r = parsePaged(text, (l) => Object.hasOwn(l, 'name') && Object.hasOwn(l, 'id'));
    raw.jobs[file] = r.lines;
    if (r.state !== 'complete') fail(r.state, r.predicate, `jobs_${file}_${r.reason}`);
    if (new Set(r.items.map((j) => `${idStr(j.run_id)}/${j.run_attempt}`)).size > 1) fail('invalid', 'job_files_coherent', `jobs_${file}_mixed_run_attempt`);
    for (const j of r.items) jobFile.set(j, file);
    jobs.push(...r.items);
  }
  for (const x of [...checks, ...jobs]) if (typeof x.name !== 'string') fail('invalid', 'lines_wellformed', 'name_not_string');

  for (const [list, what] of [[checks, 'check_run'], [jobs, 'job']]) {
    const seen = new Set();
    for (const x of list) {
      const id = idStr(x.id);
      if (id === null) { fail('invalid', 'ids_canonical_unique', `${what}_id_invalid`); continue; }
      if (seen.has(id)) fail('invalid', 'ids_canonical_unique', `${what}_id_duplicate`);
      seen.add(id);
    }
  }

  const byRef = new Map(); // check-run id -> jobs naming it
  for (const j of jobs) { const ref = checkRunRef(j.check_run_url); const k = ref ? ref.id : '\0none'; byRef.set(k, [...(byRef.get(k) ?? []), j]); }
  const jobRows = jobs.map((j) => ({ id: idStr(j.id), name: String(j.name), run_id: idStr(j.run_id), run_attempt: Number.isInteger(j.run_attempt) ? j.run_attempt : null,
    status: typeof j.status === 'string' ? j.status : null, conclusion: typeof j.conclusion === 'string' ? j.conclusion : null, steps: Array.isArray(j.steps) ? j.steps.length : null, ...classifyJob(j), bound: false }));
  const jobRow = new Map(jobRows.map((r) => [r.id, r]));

  const rows = [];
  for (const c of checks) {
    const id = idStr(c.id);
    const row = { id, name: String(c.name), app: typeof c.app?.slug === 'string' ? c.app.slug : null, status: typeof c.status === 'string' ? c.status : null,
      conclusion: typeof c.conclusion === 'string' ? c.conclusion : null, binding: 'unbound', reason: null, predicate: null, job_id: null, run_id: null, run_attempt: null,
      input_status: 'unbound', supersession: 'not_applicable', annotations: { status: 'unknown', messages: [] } };
    rows.push(row);
    const unbind = (predicate, reason) => { row.predicate = predicate; row.reason = reason; };
    const own = checkRunRef(c.url);
    if (!own || own.repo !== repoKey) { unbind('check_bound_to_repo', 'own_repo_mismatch'); continue; }
    if (own.id !== id) { unbind('ids_agree', 'own_id_mismatch'); continue; }
    if (typeof c.head_sha !== 'string' || c.head_sha !== head) { unbind('check_bound_to_repo', 'head_sha_mismatch'); continue; }
    if (row.app === null) { unbind('check_bound_to_repo', 'app_missing'); continue; }
    if (row.status !== 'completed') { unbind('status_consistent', 'check_not_completed'); continue; }
    if (row.app !== 'github-actions') { row.binding = 'external'; row.input_status = 'external'; continue; }
    const named = byRef.get(id) ?? [];
    if (!named.length) { unbind('actions_check_one_job', 'no_job'); continue; }
    const why = named.map((j) => {
      const ref = checkRunRef(j.check_run_url);
      if (ref.repo !== repoKey) return ['actions_check_one_job', 'job_repo_mismatch'];
      if (idStr(j.id) !== ref.id) return ['ids_agree', 'job_id_mismatch'];
      if (typeof j.head_sha !== 'string' || j.head_sha !== head) return ['actions_check_one_job', 'job_head_sha_mismatch'];
      if (j.name !== c.name) return ['actions_check_one_job', 'job_name_mismatch'];
      if (!Number.isInteger(j.run_attempt) || j.run_attempt < 1 || idStr(j.run_id) === null) return ['actions_check_one_job', 'job_identity_invalid'];
      if (j.status !== 'completed' || j.conclusion !== c.conclusion) return ['status_consistent', 'check_job_state_mismatch'];
      return null;
    }).find(Boolean);
    if (why) { unbind(...why); continue; }
    // Two jobs naming one check run cannot both pass ids_agree (ids are unique), so exactly one remains here.
    const jr = jobRow.get(idStr(named[0].id));
    Object.assign(row, { binding: 'bound', job_id: jr.id, run_id: jr.run_id, run_attempt: jr.run_attempt, input_status: jr.input_status, reason: jr.reason });
    jr.bound = true;
  }

  // The name cannot tell two jobs of one run attempt apart (GitHub allows duplicate `name:`): neither is trusted.
  const slot = (r) => JSON.stringify([r.run_id, r.run_attempt, r.name]);
  const slots = new Map();
  for (const r of rows) if (r.binding === 'bound') slots.set(slot(r), (slots.get(slot(r)) ?? 0) + 1);
  for (const r of rows) if (r.binding === 'bound' && slots.get(slot(r)) > 1) {
    Object.assign(r, { binding: 'unbound', input_status: 'unbound', predicate: 'job_name_unique', reason: 'ambiguous_job_name' });
    jobRow.get(r.job_id).bound = false;
  }

  const key = (r) => JSON.stringify([r.run_id, r.name]);
  const top = new Map();
  for (const r of rows) if (r.binding === 'bound' && r.status === 'completed' && !NOT_EXECUTED.includes(r.conclusion)) top.set(key(r), Math.max(top.get(key(r)) ?? 0, r.run_attempt));
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
    if (!id || !checkById.has(id)) { fail('invalid', 'files_safe', `annotations_${file}_unexpected`); continue; }
    if (!lines || !lines.every((l) => typeof l.message === 'string')) { fail('invalid', 'lines_wellformed', `annotations_${file}_not_annotations`); continue; }
    raw.annotations[file] = lines;
  }
  for (const row of rows) {
    const expected = checkById.get(row.id)?.output?.annotations_count;
    const got = raw.annotations[`${row.id}.jsonl`];
    const a = row.annotations;
    if (!Number.isInteger(expected) || expected < 0) a.status = 'unknown';
    else {
      const n = got ? got.length : 0;
      a.status = expected === 0 ? (n === 0 ? 'none' : 'incomplete') : got === undefined ? 'missing' : n === expected ? 'present' : 'incomplete';
      if (a.status === 'present') a.messages = got.map((l) => l.message);
      if (a.status === 'incomplete' || a.status === 'missing') { a.expected = expected; a.listed = n; }
    }
    if (!['none', 'present'].includes(a.status)) fail('incomplete', 'annotations_complete', `check_run_${row.id}_annotations_${a.status}`);
  }
  for (const r of rows) if (r.binding === 'unbound' && r.predicate) fail('incomplete', r.predicate, `check_run_${r.id}_${r.reason}`);
  const orphan = jobRows.filter((j) => !j.bound).map((j) => j.id);
  for (const id of orphan) fail('incomplete', 'no_orphan_jobs', `job_${id}_not_bound`);
  const unbound = rows.filter((r) => r.binding === 'unbound').map((r) => r.id);
  const sha256 = state === 'invalid' ? null : createHash('sha256').update(JSON.stringify(canon(raw))).digest('hex');
  return { schema: SCHEMA, repo: repoKey, head_sha: head, state, failed_predicates: [...failed].sort(), reasons, binding_complete: state === 'complete',
    provider_snapshot_sha256: sha256, check_runs: rows.map(({ predicate, ...r }) => r), jobs: jobRows, unbound_check_runs: unbound, orphan_jobs: orphan };
}

function readText(path, problems) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) { problems.push(['files_safe', 'file_not_regular_or_too_large']); return null; }
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (e) { if (e?.code !== 'ENOENT') problems.push(['files_safe', 'file_unreadable_or_not_utf8']); return null; }
}

function readDir(dir, sub, namePattern, problems) {
  let names;
  try { const st = lstatSync(join(dir, sub)); if (!st.isDirectory()) { problems.push(['files_safe', `${sub}_not_a_directory`]); return null; } names = readdirSync(join(dir, sub)); } catch (e) { if (e?.code !== 'ENOENT') problems.push(['files_safe', `${sub}_unreadable`]); return null; }
  const out = {};
  for (const n of names) { if (!namePattern.test(n)) { problems.push(['files_safe', `${sub}_unexpected_entry`]); continue; } const t = readText(join(dir, sub, n), problems); if (t !== null) out[n] = t; }
  return out;
}

/** Read a snapshot directory (see the header) and build it. */
export function readSnapshot({ dir, repo, sha }) {
  const problems = [];
  let rootOk = false;
  try { rootOk = lstatSync(dir).isDirectory(); } catch { /* reported below */ }
  if (!rootOk) problems.push(['files_safe', 'snapshot_root_not_a_real_directory']);
  const texts = rootOk
    ? { checkRuns: readText(join(dir, 'check-runs.jsonl'), problems), jobs: readDir(dir, 'jobs', /^[A-Za-z0-9._-]+\.jsonl$/, problems), annotations: readDir(dir, 'annotations', /^\d+\.jsonl$/, problems) ?? {}, problems }
    : { checkRuns: null, jobs: null, annotations: {}, problems };
  if (rootOk) try { for (const n of readdirSync(dir)) if (!['check-runs.jsonl', 'jobs', 'annotations'].includes(n)) problems.push(['files_safe', 'snapshot_unexpected_entry']); } catch { problems.push(['files_safe', 'snapshot_dir_unreadable']); }
  return buildSnapshot({ texts, repo, sha });
}

export function main(argv) {
  const f = {};
  const [cmd, ...rest] = argv;
  for (let i = 0; i < rest.length; i += 2) { if (!rest[i].startsWith('--') || rest[i + 1] === undefined) { f.bad = true; break; } f[rest[i].slice(2)] = rest[i + 1]; }
  if (cmd !== 'check' || f.bad || !f.snapshot || !f.repo || !f.sha) { process.stderr.write('Usage: ci-snapshot.mjs check --snapshot <dir> --repo <owner/name> --sha <40 hex>\n'); return 2; }
  const s = readSnapshot({ dir: f.snapshot, repo: f.repo, sha: f.sha });
  process.stdout.write(JSON.stringify(s) + '\n');
  return s.state === 'complete' ? 0 : 1;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
