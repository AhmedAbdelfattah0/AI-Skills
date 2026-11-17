#!/usr/bin/env node
/**
 * Linked CI snapshot verifier (ASTF-39, S-05a). CONTRACT (deliberately narrow): this module is a BINDING AND
 * INTERNAL-CONSISTENCY verifier of a CAPTURED snapshot. `state: 'snapshot_valid'` means ONLY that the supplied files are
 * internally consistent (page counts, annotation counts, attempt numbering), well-formed, non-empty, and every check run
 * and job is bound to the expected provider origin + repository + head SHA (annotation files are matched to a bound check
 * run by file name and count only). It does NOT attest what
 * NOT_ATTESTED lists (also emitted as `not_attested` in the JSON): `snapshot_valid` is never "CI passed" and never "nothing
 * missing upstream". Those are owed by the capture manifest (S-05e: expected counts, the run listing) and by the
 * classifier (S-05b). It maps NOTHING to a verdict; later slices must refuse unless `state === 'snapshot_valid'` AND treat
 * the output as inputs, not as a result. Project-agnostic. Missing, null or unknown is never zero, never pass.
 *
 *   ci-snapshot.mjs check --snapshot <dir> --repo <owner/name> --sha <40 hex> --origin <https API base>
 *
 * `--origin` is REQUIRED (https://api.github.com, or a GHES base such as https://ghe.example/api/v3). Every
 * `url` / `check_run_url` must be exactly `<origin>/repos/<owner>/<name>/check-runs/<id>`; another installation: unbound.
 * Snapshot directory (input files only; never fetched; a symlink is refused: every entry and the root itself, after lexical normalisation by
 * path.resolve (so `link/`, `link/.`, `dir/../link` all name the link). Symlinks in ANCESTOR directories are allowed, e.g. /tmp on macOS):
 *   check-runs.jsonl            `gh api --paginate "commits/<sha>/check-runs?filter=all" --jq '{total_count}, .check_runs[]'`
 *                               (filter=all: the default `latest` drops earlier attempts' check runs)
 *   jobs/<name>.jsonl           ONE file per call of `actions/runs/<id>/attempts/<n>/jobs` (same line shape; the
 *                               total_count rule is per call, so calls must not be concatenated)
 *   annotations/<check-run-id>.jsonl   `check-runs/<id>/annotations --jq '.[]'` (optional when the count is 0)
 *
 * VALID (state 'snapshot_valid', `internally_consistent: true`, CLI exit 0) ONLY IF ALL predicates in SITES hold. A predicate can be raised from several
 * sites; SITES lists every site's reason code, `fail`/`unbind` throw on a reason not listed, and the table test must
 * show every listed reason firing (so a site without a breaking case fails the suite). `failed_predicates` is the set
 * of predicates that fired, not every failure (the first failure per check run wins).
 *   identity_args        repo is owner/name, sha is 40 hex, origin is an https URL without credentials/query
 *   files_safe           root and entries: real directory/regular file, no symlink, UTF-8, size cap, no unexpected entry
 *   lines_wellformed     every line a JSON object (nesting <= MAX_DEPTH); names strings; annotation lines match SHAPES.annotation
 *   pages_complete       check-runs.jsonl and jobs/ exist; each call: total_count on every page, equal, items == total
 *   ids_canonical_unique ids canonical digit strings or safe integers (no leading zero), unique per kind
 *   non_empty            at least one check run (an empty capture proves nothing)
 *   check_bound_to_repo  EVERY check run (external too): own URL under origin and --repo, head_sha == --sha, app present
 *   ids_agree            check id == the id in its own url; job id == the id in its check_run_url
 *   actions_check_one_job an Actions check run has a job naming it with the same repo, head SHA, name, a SAFE integer
 *                        run_attempt >= 1 and a run id; none: unbound
 *   raw_fields_typed     every field this module reads from a check run / job (SHAPES.check_run, SHAPES.job, also steps, labels, runner_*,
 *                        timestamps, step conclusions) has its declared type; a wrong type is flagged, never turned into null
 *   job_files_coherent   all jobs of one file share one run_id and run_attempt
 *   job_name_unique      no two bound jobs share (run_id, run_attempt, name)
 *   status_consistent    check and job `completed`; equal conclusions
 *   outcomes_known       a completed check/job has a conclusion in CONCLUSIONS (never null/absent/unrecognised)
 *   job_inputs_known     every job has the fields the classifier needs (conclusion; steps and runner_name when failure-class);
 *                        steps and labels match SHAPES (closed schema); a malformed entry is flagged, never defaulted
 *   attempts_contiguous  per run_id the attempts present are exactly 1..max (a lone attempt 2 hides attempt 1)
 *   no_orphan_jobs       every job is bound by a check run of the snapshot
 *   annotations_complete for EVERY check run the listed annotations equal output.annotations_count
 * Supersession (per row): a failed bound attempt is `superseded` only by a higher attempt of the SAME run_id and job
 * name that is COMPLETED with a conclusion other than skipped, neutral or cancelled.
 * Rows CARRY the raw classification inputs (status, conclusion, run_attempt, timestamps, steps as
 * [{name,status,conclusion,number}], runner_name with an explicit absent/null/string state, runner_group_name, labels,
 * annotation messages with count and sha256) so S-05b needs no second read. `provider_snapshot_sha256` = sha256 of the
 * canonical JSON (sorted keys) of the PARSED raw lines (not whitespace or duplicate keys); null when invalid.
 * States: snapshot_valid | incomplete (a part is missing or inconsistent) | empty (no check runs) | invalid (malformed or unsafe input).
 * Exit: 0 only when snapshot_valid, 1 otherwise, 2 usage.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isEntrypoint } from './harness.mjs';
import { depthOf, idStr, MAX_DEPTH, shapeProblem } from './lib/shape.mjs';

export const SCHEMA = 'ci-snapshot-v1';
export const NOT_ATTESTED = Object.freeze([
  'upstream_exhaustiveness: runs that never created check runs (awaiting approval, startup_failure, other workflows, later re-runs) may be absent',
  'ci_outcome: snapshot_valid is not CI passed; no verdict, billing, workflow/event eligibility or required-check policy',
  'annotation_association: annotation files are matched to a check run by file name and count only',
  'job_and_annotation_urls: only check_run_url and the check run url are bound to the origin',
  'byte_identity: the hash covers parsed values, not bytes; files are read once after a type check (no TOCTOU guard)',
]);
export const CONCLUSIONS = Object.freeze(['success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'stale', 'startup_failure']);
/** predicate -> every reason code (suffix) a site may raise. The single source for PREDICATES and the table test. */
export const SITES = Object.freeze({
  identity_args: ['repo_malformed', 'sha_malformed', 'origin_malformed'],
  files_safe: ['file_not_regular_or_too_large', 'file_unreadable_or_not_utf8', 'entry_not_a_directory', 'dir_unreadable', 'unexpected_entry', 'root_not_a_real_directory', 'annotation_file_unexpected'],
  lines_wellformed: ['not_json_lines', 'unrecognised_line', 'name_not_string', 'annotation_not_an_annotation', 'too_deep'],
  pages_complete: ['check_runs_missing', 'jobs_missing', 'no_total_count', 'total_count_disagree', 'items_differ_from_total'],
  ids_canonical_unique: ['id_invalid', 'id_duplicate'],
  non_empty: ['no_check_runs'],
  check_bound_to_repo: ['own_url_not_origin_repo', 'head_sha_mismatch', 'app_missing'],
  ids_agree: ['own_id_mismatch', 'job_id_mismatch'],
  actions_check_one_job: ['no_job', 'job_repo_mismatch', 'job_head_sha_mismatch', 'job_name_mismatch', 'job_identity_invalid'],
  raw_fields_typed: ['field_type'],
  job_files_coherent: ['mixed_run_attempt'],
  job_name_unique: ['ambiguous_job_name'],
  status_consistent: ['check_not_completed', 'job_not_completed', 'conclusion_mismatch'],
  outcomes_known: ['check_conclusion_unknown', 'job_conclusion_unknown'],
  job_inputs_known: ['job_inputs_unknown', 'malformed_step', 'malformed_labels'],
  attempts_contiguous: ['attempt_gap'],
  no_orphan_jobs: ['not_bound'],
  annotations_complete: ['annotations_missing', 'annotations_incomplete', 'annotations_unknown'],
});
export const PREDICATES = Object.freeze(Object.keys(SITES));
const MAX_BYTES = 64 * 1024 * 1024;
const OK_CONCLUSIONS = ['success', 'neutral', 'skipped'];
const failedConclusion = (c) => typeof c === 'string' && !OK_CONCLUSIONS.includes(c);
const NOT_EXECUTED = ['skipped', 'neutral', 'cancelled'];
const STATUSES = ['queued', 'in_progress', 'completed', 'pending', 'waiting', 'requested'];
const CONC = { enum: CONCLUSIONS, nullable: true, optional: true };
const STAT = { enum: STATUSES, optional: true };
/**
 * Every field this module READS from a raw object, with its exact type, described once (the invariant test fails if the
 * module reads a field that is not declared here). Tokens: string, null, int, posint, id (canonical id), ts (strict
 * ISO-8601 UTC), joined by `|`; a leading `?` = optional key. Objects: { object, open?, nullable?, optional? } (closed
 * unless `open`: provider objects carry fields this module never reads); { enum, nullable?, optional? }; { arrayOf }.
 * A wrongly-typed declared field is `raw_fields_typed`: never converted to null silently.
 */
export const SHAPES = Object.freeze({
  step: { object: { name: 'string', status: { enum: STATUSES }, conclusion: { enum: CONCLUSIONS, nullable: true }, number: 'posint', started_at: '?ts|null', completed_at: '?ts|null' } },
  labels: { arrayOf: 'string' },
  annotation: { object: { path: '?string', start_line: '?int', end_line: '?int', start_column: '?int|null', end_column: '?int|null', annotation_level: '?string', title: '?string|null', message: 'string', raw_details: '?string|null', blob_href: '?string' } },
  check_run: { open: true, object: { id: 'id', name: 'string', head_sha: '?string', status: STAT, conclusion: CONC, started_at: '?ts|null', completed_at: '?ts|null', url: '?string',
    app: { open: true, nullable: true, optional: true, object: { slug: '?string' } }, output: { open: true, nullable: true, optional: true, object: { annotations_count: '?int|null' } } } },
  job: { open: true, object: { id: 'id', name: 'string', head_sha: '?string', status: STAT, conclusion: CONC, started_at: '?ts|null', completed_at: '?ts|null', run_id: '?id', run_attempt: '?posint',
    check_run_url: '?string', runner_name: '?string|null', runner_group_name: '?string|null', labels: { arrayOf: 'string', nullable: true, optional: true },
    steps: { arrayOf: { object: { name: 'string', status: { enum: STATUSES }, conclusion: { enum: CONCLUSIONS, nullable: true }, number: 'posint', started_at: '?ts|null', completed_at: '?ts|null' } }, nullable: true, optional: true } } },
  page: { open: true, object: { total_count: '?int' } },
});
export { idStr, shapeProblem };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const safePos = (v) => Number.isSafeInteger(v) && v >= 1;

/** The normalised origin (scheme+host[:port][/base path], no trailing slash), or null. */
export function normOrigin(o) {
  try {
    const u = new URL(String(o));
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.hostname) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

/** `<origin>/repos/<owner>/<name>/check-runs/<id>` -> { repo (lower-cased), id }, or null (another origin, shape or a leading-zero id). */
export function checkRunRef(url, origin) {
  const m = new RegExp(`^${esc(origin ?? '\0')}/repos/([^/]+/[^/]+)/check-runs/(0|[1-9]\\d*)/?$`).exec(typeof url === 'string' ? url : '');
  return m ? { repo: m[1].toLowerCase(), id: m[2] } : null;
}

function objectLines(text) {
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    let v;
    try { v = JSON.parse(l); } catch { return null; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (depthOf(v) > MAX_DEPTH) return 'too_deep';
    out.push(v);
  }
  return out;
}

/** One paginated call -> { state: 'ok'|'incomplete'|'invalid', items, lines, reason, predicate }. */
export function parsePaged(text, isItem) {
  const lines = objectLines(text);
  if (lines === 'too_deep') return { state: 'invalid', items: [], lines: [], reason: 'too_deep', predicate: 'lines_wellformed' };
  if (!lines) return { state: 'invalid', items: [], lines: [], reason: 'not_json_lines', predicate: 'lines_wellformed' };
  const items = lines.filter(isItem);
  const totals = lines.filter((l) => !isItem(l) && Object.hasOwn(l, 'total_count')).map((l) => l.total_count);
  if (items.length + totals.length !== lines.length) return { state: 'invalid', items: [], lines, reason: 'unrecognised_line', predicate: 'lines_wellformed' };
  const inc = (reason) => ({ state: 'incomplete', items, lines, reason, predicate: 'pages_complete' });
  if (!totals.length || !totals.every((n) => Number.isSafeInteger(n) && n >= 0)) return inc('no_total_count');
  if (new Set(totals).size !== 1) return inc('total_count_disagree');
  if (items.length !== totals[0]) return inc('items_differ_from_total');
  return { state: 'ok', items, lines, reason: null, predicate: null };
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

const state3 = (v) => (v === undefined ? 'absent' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const str = (v) => (typeof v === 'string' ? v : null);
/** The raw classification inputs of a job, with explicit absent/null markers (never a default). */
const jobInputs = (j) => {
  const stepList = Array.isArray(j.steps) ? j.steps.map((s) => { const p = shapeProblem(s, SHAPES.step); return p ? { malformed: true, type: state3(s), problem: p } : { name: s.name, status: s.status, conclusion: s.conclusion, number: s.number }; }) : null;
  const stepsBad = (j.steps !== undefined && j.steps !== null && !Array.isArray(j.steps)) || (stepList?.some((s) => s.malformed) ?? false);
  const labelsProblem = j.labels === undefined || j.labels === null ? null : shapeProblem(j.labels, SHAPES.labels);
  return { status: str(j.status), conclusion: str(j.conclusion), run_attempt: safePos(j.run_attempt) ? j.run_attempt : null, started_at: str(j.started_at), completed_at: str(j.completed_at),
    steps_state: stepsBad ? 'malformed' : state3(j.steps), steps: stepList, steps_type: state3(j.steps), runner_name_state: state3(j.runner_name), runner_name: str(j.runner_name), runner_group_name: str(j.runner_group_name),
    labels_state: labelsProblem ? 'malformed' : state3(j.labels), labels: labelsProblem || !Array.isArray(j.labels) ? null : j.labels.slice(), labels_type: state3(j.labels), labels_problem: labelsProblem };
};

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const sha256 = (v) => createHash('sha256').update(JSON.stringify(canon(v))).digest('hex');

/**
 * The pure core. `texts` = { checkRuns: string|null, jobs: { <file>: string }|null, annotations: { <file>: string }, problems: [[predicate, reason]] }.
 * -> the snapshot (see the header). `state` is the worst of the parts: invalid > incomplete > empty > snapshot_valid.
 */
export function buildSnapshot({ texts, repo, sha, origin }) {
  const reasons = [], failed = new Set();
  let state = 'snapshot_valid';
  const fail = (s, predicate, why) => {
    if (!SITES[predicate]?.some((x) => why === x || why.endsWith(`_${x}`))) throw new Error(`unlisted site ${predicate}/${why}`);
    reasons.push(why); failed.add(predicate);
    if (s === 'invalid' || (s === 'incomplete' && state !== 'invalid') || (s === 'empty' && state === 'snapshot_valid')) state = s;
  };
  const repoKey = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo)) ? String(repo).toLowerCase() : null;
  const head = /^[0-9a-fA-F]{40}$/.test(String(sha)) ? String(sha).toLowerCase() : null;
  const org = normOrigin(origin);
  if (!repoKey) fail('invalid', 'identity_args', 'repo_malformed');
  if (!head) fail('invalid', 'identity_args', 'sha_malformed');
  if (!org) fail('invalid', 'identity_args', 'origin_malformed');
  for (const [pred, why] of texts.problems ?? []) fail('invalid', pred, why);
  const raw = { check_runs: [], jobs: {}, annotations: {} };

  let checks = [];
  if (texts.checkRuns == null) fail('incomplete', 'pages_complete', 'check_runs_missing');
  else {
    const r = parsePaged(texts.checkRuns, (l) => Object.hasOwn(l, 'name'));
    raw.check_runs = r.lines;
    if (r.state !== 'ok') fail(r.state, r.predicate, `check_runs_${r.reason}`);
    checks = r.items;
  }
  const jobs = [];
  if (texts.jobs == null) fail('incomplete', 'pages_complete', 'jobs_missing');
  else for (const [file, text] of Object.entries(texts.jobs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const r = parsePaged(text, (l) => Object.hasOwn(l, 'name') && Object.hasOwn(l, 'id'));
    raw.jobs[file] = r.lines;
    if (r.state !== 'ok') fail(r.state, r.predicate, `jobs_${file}_${r.reason}`);
    if (new Set(r.items.map((j) => `${idStr(j.run_id)}/${safePos(j.run_attempt) ? j.run_attempt : '?'}`)).size > 1) fail('invalid', 'job_files_coherent', `jobs_${file}_mixed_run_attempt`);
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

  const fieldProblems = [];
  for (const [kind, list] of [['check_run', checks], ['job', jobs]]) for (const x of list) {
    const p = shapeProblem(x, SHAPES[kind]);
    if (p) { fieldProblems.push({ kind, id: idStr(x.id), problem: p.slice(0, 120) }); fail('incomplete', 'raw_fields_typed', `${kind}_${idStr(x.id) ?? 'unknown'}_field_type`); }
  }
  const malformedIds = new Set(fieldProblems.map((f) => `${f.kind}:${f.id}`));

  const byRef = new Map(); // check-run id -> jobs naming it
  for (const j of jobs) { const ref = checkRunRef(j.check_run_url, org); const k = ref ? ref.id : '\0none'; byRef.set(k, [...(byRef.get(k) ?? []), j]); }
  const jobRows = jobs.map((j) => ({ id: idStr(j.id), name: typeof j.name === 'string' ? j.name : null, run_id: idStr(j.run_id), run_attempt: safePos(j.run_attempt) ? j.run_attempt : null, fields_malformed: malformedIds.has(`job:${idStr(j.id)}`), inputs: jobInputs(j), ...classifyJob(j), bound: false }));
  const jobRow = new Map(jobRows.map((r) => [r.id, r]));

  const rows = [];
  for (const c of checks) {
    const id = idStr(c.id);
    const row = { id, name: typeof c.name === 'string' ? c.name : null, app: typeof c.app?.slug === 'string' ? c.app.slug : null, status: str(c.status), conclusion: str(c.conclusion), started_at: str(c.started_at), completed_at: str(c.completed_at),
      fields_malformed: malformedIds.has(`check_run:${id}`), binding: 'unbound', reason: null, predicate: null, job_id: null, run_id: null, run_attempt: null, job_inputs: null, input_status: 'unbound', supersession: 'not_applicable',
      annotations: { status: 'unknown', messages: [], count: null, sha256: null } };
    rows.push(row);
    const unbind = (predicate, reason) => { row.predicate = predicate; row.reason = reason; };
    const own = checkRunRef(c.url, org);
    if (!own || own.repo !== repoKey) { unbind('check_bound_to_repo', 'own_url_not_origin_repo'); continue; }
    if (own.id !== id) { unbind('ids_agree', 'own_id_mismatch'); continue; }
    if (typeof c.head_sha !== 'string' || c.head_sha !== head) { unbind('check_bound_to_repo', 'head_sha_mismatch'); continue; }
    if (row.app === null) { unbind('check_bound_to_repo', 'app_missing'); continue; }
    if (row.status !== 'completed') { unbind('status_consistent', 'check_not_completed'); continue; }
    if (!CONCLUSIONS.includes(row.conclusion)) { unbind('outcomes_known', 'check_conclusion_unknown'); continue; }
    if (row.app !== 'github-actions') { row.binding = 'external'; row.input_status = 'external'; continue; }
    const named = byRef.get(id) ?? [];
    if (!named.length) { unbind('actions_check_one_job', 'no_job'); continue; }
    const why = named.map((j) => {
      const ref = checkRunRef(j.check_run_url, org);
      if (ref.repo !== repoKey) return ['actions_check_one_job', 'job_repo_mismatch'];
      if (idStr(j.id) !== ref.id) return ['ids_agree', 'job_id_mismatch'];
      if (typeof j.head_sha !== 'string' || j.head_sha !== head) return ['actions_check_one_job', 'job_head_sha_mismatch'];
      if (j.name !== c.name) return ['actions_check_one_job', 'job_name_mismatch'];
      if (!safePos(j.run_attempt) || idStr(j.run_id) === null) return ['actions_check_one_job', 'job_identity_invalid'];
      if (j.status !== 'completed') return ['status_consistent', 'job_not_completed'];
      if (!CONCLUSIONS.includes(j.conclusion)) return ['outcomes_known', 'job_conclusion_unknown'];
      if (j.conclusion !== c.conclusion) return ['status_consistent', 'conclusion_mismatch'];
      return null;
    }).find(Boolean);
    if (why) { unbind(...why); continue; }
    // Two jobs naming one check run cannot both pass ids_agree (ids are unique), so exactly one remains here.
    const jr = jobRow.get(idStr(named[0].id));
    Object.assign(row, { binding: 'bound', job_id: jr.id, run_id: jr.run_id, run_attempt: jr.run_attempt, input_status: jr.input_status, reason: jr.reason, job_inputs: jr.inputs });
    jr.bound = true;
  }

  // The name cannot tell two jobs of one run attempt apart (GitHub allows duplicate `name:`): neither is trusted.
  const slot = (r) => JSON.stringify([r.run_id, r.run_attempt, r.name]);
  const slots = new Map();
  for (const r of rows) if (r.binding === 'bound') slots.set(slot(r), (slots.get(slot(r)) ?? 0) + 1);
  for (const r of rows) if (r.binding === 'bound' && slots.get(slot(r)) > 1) {
    Object.assign(r, { binding: 'unbound', input_status: 'unbound', predicate: 'job_name_unique', reason: 'ambiguous_job_name', job_inputs: null });
    jobRow.get(r.job_id).bound = false;
  }

  const key = (r) => JSON.stringify([r.run_id, r.name]);
  const top = new Map();
  for (const r of rows) if (r.binding === 'bound' && !NOT_EXECUTED.includes(r.conclusion)) top.set(key(r), Math.max(top.get(key(r)) ?? 0, r.run_attempt));
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
    if (!id || !checkById.has(id)) { fail('invalid', 'files_safe', `annotations_${file}_annotation_file_unexpected`); continue; }
    if (lines === 'too_deep') { fail('invalid', 'lines_wellformed', `annotations_${file}_too_deep`); continue; }
    if (!lines || !lines.every((l) => shapeProblem(l, SHAPES.annotation) === null)) { fail('invalid', 'lines_wellformed', `annotations_${file}_annotation_not_an_annotation`); continue; }
    raw.annotations[file] = lines;
  }
  for (const row of rows) {
    const expected = checkById.get(row.id)?.output?.annotations_count;
    const got = raw.annotations[`${row.id}.jsonl`];
    const a = row.annotations;
    if (!Number.isSafeInteger(expected) || expected < 0) a.status = 'unknown';
    else {
      const n = got ? got.length : 0;
      a.status = expected === 0 ? (n === 0 ? 'none' : 'incomplete') : got === undefined ? 'missing' : n === expected ? 'present' : 'incomplete';
      a.count = n; a.sha256 = got ? sha256(got) : null;
      if (a.status === 'present') a.messages = got.map((l) => l.message);
      if (a.status === 'incomplete' || a.status === 'missing') { a.expected = expected; a.listed = n; }
    }
    if (!['none', 'present'].includes(a.status)) fail('incomplete', 'annotations_complete', `check_run_${row.id}_annotations_${a.status}`);
  }
  for (const r of rows) if (r.binding === 'unbound') fail('incomplete', r.predicate ?? 'actions_check_one_job', `check_run_${r.id}_${r.reason ?? 'no_job'}`);
  const orphan = jobRows.filter((j) => !j.bound).map((j) => j.id);
  for (const id of orphan) fail('incomplete', 'no_orphan_jobs', `job_${id}_not_bound`);
  for (const j of jobRows) {
    if (j.input_status === 'unknown') { j.inputs_unknown = true; fail('incomplete', 'job_inputs_known', `job_${j.id}_job_inputs_unknown`); }
    if (j.inputs.steps_state === 'malformed') { j.inputs_unknown = true; fail('incomplete', 'job_inputs_known', `job_${j.id}_malformed_step`); }
    if (j.inputs.labels_state === 'malformed') { j.inputs_unknown = true; fail('incomplete', 'job_inputs_known', `job_${j.id}_malformed_labels`); }
  }
  const attempts = new Map();
  for (const j of jobRows) if (j.run_id !== null && j.run_attempt !== null) attempts.set(j.run_id, new Set([...(attempts.get(j.run_id) ?? []), j.run_attempt]));
  for (const [run, set] of attempts) if (set.size !== Math.max(...set)) fail('incomplete', 'attempts_contiguous', `run_${run}_attempt_gap`);
  if (checks.length === 0) fail('empty', 'non_empty', 'no_check_runs');
  const unbound = rows.filter((r) => r.binding === 'unbound').map((r) => r.id);
  const hash = state === 'invalid' ? null : sha256(raw);
  return { schema: SCHEMA, repo: repoKey, head_sha: head, origin: org, state, not_attested: NOT_ATTESTED, failed_predicates: [...failed].sort(), reasons, field_problems: fieldProblems, internally_consistent: state === 'snapshot_valid',
    provider_snapshot_sha256: hash, check_runs: rows.map(({ predicate, ...r }) => r), jobs: jobRows, unbound_check_runs: unbound, orphan_jobs: orphan };
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
  try { const st = lstatSync(join(dir, sub)); if (!st.isDirectory()) { problems.push(['files_safe', 'entry_not_a_directory']); return null; } names = readdirSync(join(dir, sub)); } catch (e) { if (e?.code !== 'ENOENT') problems.push(['files_safe', 'dir_unreadable']); return null; }
  const out = {};
  for (const n of names) { if (!namePattern.test(n)) { problems.push(['files_safe', 'unexpected_entry']); continue; } const t = readText(join(dir, sub, n), problems); if (t !== null) out[n] = t; }
  return out;
}

/** Read a snapshot directory (see the header) and build it. */
export function readSnapshot({ dir, repo, sha, origin }) {
  const problems = [];
  const root = resolve(String(dir)); // lexical normalisation: `link/`, `link/.`, `dir/../link` all become the link itself, which lstat then refuses
  let rootOk = false;
  try { rootOk = lstatSync(root).isDirectory(); } catch { /* reported below */ }
  if (!rootOk) problems.push(['files_safe', 'root_not_a_real_directory']);
  const texts = rootOk
    ? { checkRuns: readText(join(root, 'check-runs.jsonl'), problems), jobs: readDir(root, 'jobs', /^[A-Za-z0-9._-]+\.jsonl$/, problems), annotations: readDir(root, 'annotations', /^\d+\.jsonl$/, problems) ?? {}, problems }
    : { checkRuns: null, jobs: null, annotations: {}, problems };
  if (rootOk) try { for (const n of readdirSync(root)) if (!['check-runs.jsonl', 'jobs', 'annotations'].includes(n)) problems.push(['files_safe', 'unexpected_entry']); } catch { problems.push(['files_safe', 'dir_unreadable']); }
  return buildSnapshot({ texts, repo, sha, origin });
}

export function main(argv) {
  const f = {};
  const [cmd, ...rest] = argv;
  for (let i = 0; i < rest.length; i += 2) { if (!rest[i].startsWith('--') || rest[i + 1] === undefined) { f.bad = true; break; } f[rest[i].slice(2)] = rest[i + 1]; }
  if (cmd !== 'check' || f.bad || !f.snapshot || !f.repo || !f.sha || !f.origin) { process.stderr.write('Usage: ci-snapshot.mjs check --snapshot <dir> --repo <owner/name> --sha <40 hex> --origin <https API base>\n'); return 2; }
  const s = readSnapshot({ dir: f.snapshot, repo: f.repo, sha: f.sha, origin: f.origin });
  process.stdout.write(JSON.stringify(s) + '\n');
  return s.state === 'snapshot_valid' ? 0 : 1;
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
