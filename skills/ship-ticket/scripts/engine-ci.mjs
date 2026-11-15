/**
 * Exact-head CI evidence for the durable run engine (P0 slice E6-min). Node built-ins only.
 *
 * `run-engine.mjs ci` (under the run lock, after the binding and the ship context are re-verified) collects
 * the check runs of the EXACT head that `run-engine.mjs publish` pushed (the PUBLISHED record for HEAD, never
 * a SHA from the command line) through a provider adapter, and records CI_EVIDENCE in the engine state
 * (`state.ci_evidence`, the last 20) and the engine log (never RUN-STATE). `authorize complete` and
 * `next` read only that record; neither calls the provider.
 *
 * Provider adapter (`ghProvider` is the real one; tests inject a fake through the in-process ctx.ciProvider,
 * which no CLI flag or environment variable can set):
 *   checkRuns(sha)    -> { ok, runs: [{ id, name, head_sha, status, conclusion, started_at, completed_at, app, url }], total } | { ok: false, code, error }
 *   pullRequest(n)    -> { ok, pr: { number, head_sha, head_branch, base, mergeable, merge_state, state, url } } | { ok: false, code, error }
 *   recentRuns(branch)-> { ok, runs: [{ id, head_sha, status, conclusion, event, workflow, created_at }] } | { ok: false, code, error }
 *
 * Verdict (`verdict`, one pure function shared by `ci` and `authorize complete`; each check has an id the
 * mutation test omits): STALE (the PR head is not the published head, the PR is another branch, or the remote
 * branch, read at collection, no longer points at the head), PENDING, FAIL, NO_CHECKS, PASS. Only check runs
 * whose head_sha is the published head count. A re-run replaces the earlier run of the same check (same app,
 * check suite and name); same-named runs of another app or workflow are independent checks. ANY failed check
 * on the head (failure, cancelled, timed_out, action_required, startup_failure, stale) is FAIL, required or not.
 * The required set (what must PASS) is config.ciRequiredChecks when the approved DAG names it (an assurance
 * setting: approved in the plan, R0-S A4), else every check run reported on that head. PASS needs at least one
 * required check and every one completed with conclusion `success` (`skipped` and `neutral` are not success). Zero check runs, or a required name with none, is PENDING until
 * config.ciNoChecksMinutes (default 5) after the push and NO_CHECKS from a collection made after it.
 * A provider failure or a page count that does not add up is UNAVAILABLE, never zero checks.
 *
 * NO_CHECKS carries a diagnostic, DETECTED only (it never feeds the verdict): the PR's mergeable and
 * merge state, each workflow file's `on:` triggers and branch/path filters against the files changed since
 * the merge base (a line-based reading of the YAML, not a parser: `parsed: false` where it cannot tell), and
 * the recent runs on the branch.
 *
 * Not covered: legacy commit statuses (the Status API) are not read, so status-only CI is NO_CHECKS (fail
 * closed); the required set is the DAG's, not the branch protection's; a PENDING check has no deadline.
 */
import { spawnSync } from 'node:child_process';
import { statSync, realpathSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';

export const CI_SCHEMA = 'ship-ticket-ci-evidence-v1';
export const CI_STATES = Object.freeze(['PASS', 'PENDING', 'FAIL', 'NO_CHECKS', 'STALE', 'UNAVAILABLE']);
export const DEFAULT_NO_CHECKS_MINUTES = 5;
export const CI_EVIDENCE_KEEP = 20;
/** The verdict's removable checks (mutation test: omitting any one changes a pinned verdict). */
export const VERDICT_CHECKS = Object.freeze(['head_moved', 'pr_branch', 'remote_moved', 'exact_sha', 'at_least_one', 'conclusion', 'any_failed', 'independent_runs', 'required_present', 'all_complete']);
/** Conclusions that are a failed check wherever it runs (required or not); `skipped` and `neutral` fail only a required check. */
export const FAILING = Object.freeze(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
/** authorize complete's removable checks. */
export const AUTHORIZE_CHECKS = Object.freeze(['evidence_present', 'state_pass', 'head_verified', 'recheck']);
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_TEXT = 500;

const ms = (t) => { const v = Date.parse(t ?? ''); return Number.isFinite(v) ? v : null; };
const iso = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : null);
const cut = (s) => String(s ?? '').slice(0, MAX_TEXT);

/** The NO_CHECKS window of a run's bound config, in ms. */
export const noChecksWindowMs = (config) => (config?.ciNoChecksMinutes ?? DEFAULT_NO_CHECKS_MINUTES) * 60000;

/** The PR number of a published entry's PR URL (`.../pull/12`, `.../pr/12`), or null. */
export function prNumberOf(url) {
  const m = /\/(?:pull|pr|pulls)\/(\d+)(?:[/?#].*)?$/.exec(String(url ?? ''));
  return m ? Number(m[1]) : null;
}

/** The later of two runs of one check name (a re-run): by start time, then id. */
const later = (a, b) => (ms(a.started_at) ?? -1) > (ms(b.started_at) ?? -1) || ((ms(a.started_at) ?? -1) === (ms(b.started_at) ?? -1) && String(a.id ?? '') > String(b.id ?? ''));

/**
 * The CI verdict of `checks` for the published head `sha`. Pure.
 * { sha, branch, checks, required (names | undefined), windowMs, dispatchMs, collectedMs, pr ({ head_sha, head_branch } | null) }
 * -> { state, code, reasons, required, required_source, considered, ignored_other_sha, timing }
 */
export function verdict(input, { omit = [] } = {}) {
  const on = (id) => !omit.includes(id);
  const { sha, branch, checks = [], required, windowMs, dispatchMs, collectedMs, pr = null } = input; // input.remoteHead: the branch's remote head at collection (undefined: not read)
  const onSha = on('exact_sha') ? checks.filter(c => c.head_sha === sha) : checks;
  const firstStart = Math.min(...onSha.map(c => ms(c.started_at) ?? Infinity));
  const base = { considered: onSha.length, ignored_other_sha: checks.length - onSha.length };
  const timing = (completed) => ({ first_check_started_at: iso(firstStart), checks_completed_at: completed ?? null });
  const out = (state, code, reasons, extra = {}) => ({ state, code, reasons, ...base, timing: timing(extra.completed), ...extra.more });
  if (on('head_moved') && pr && pr.head_sha !== sha)
    return out('STALE', 'ci_head_moved', [`the PR head is ${pr.head_sha}, the published head is ${sha}: checks of a moved head are never this head's success`]);
  if (on('pr_branch') && pr && branch && pr.head_branch && pr.head_branch !== branch)
    return out('STALE', 'ci_pr_mismatch', [`PR #${pr.number ?? '?'} is branch ${pr.head_branch}, the run published ${branch}`]);
  const windowOver = !Number.isFinite(dispatchMs) || collectedMs - dispatchMs >= windowMs;
  const after = `${Math.round(windowMs / 60000)} min after the push`;
  if (on('at_least_one') && onSha.length === 0) return windowOver
    ? out('NO_CHECKS', 'ci_no_checks', [`no check run on ${sha} ${after}${base.ignored_other_sha ? ` (${base.ignored_other_sha} run(s) of other SHAs ignored)` : ''}`])
    : out('PENDING', 'ci_no_checks_yet', [`no check run on ${sha} yet; NO_CHECKS from ${iso(dispatchMs + windowMs)}`]);
  if (on('remote_moved') && input.remoteHead !== undefined && input.remoteHead !== sha)
    return out('STALE', 'ci_remote_moved', [`the remote branch ${branch ?? ''} is ${input.remoteHead ?? 'gone'}, the published head is ${sha}: checks of a moved branch are never this head's success`]);
  // A re-run replaces the earlier run of the SAME check (same app, same check suite, same name); runs of another app or
  // workflow (another check suite) that share a name are independent checks, and each must pass (R0-S, Codex MEDIUM).
  const keyOf = (c) => (on('independent_runs') ? `${c.app ?? ''}\u0000${c.check_suite ?? ''}\u0000${c.name}` : c.name);
  const latest = new Map();
  for (const c of onSha) { const k = keyOf(c), p = latest.get(k); if (!p || later(c, p)) latest.set(k, c); }
  const runs = [...latest.values()];
  const configured = Array.isArray(required) && required.length > 0;
  const names = configured ? [...required] : [...new Set(runs.map(c => c.name))];
  const more = { required: names, required_source: configured ? 'config' : 'all_on_sha' };
  const req = runs.filter(c => names.includes(c.name));
  // FAIL on any failed check on the exact SHA, required or not: a configured set narrows what must PASS, never what may fail.
  const failed = [...new Set([...req.filter(c => c.status === 'completed' && c.conclusion !== 'success'),
    ...(on('any_failed') ? runs.filter(c => c.status === 'completed' && (c.conclusion === null || FAILING.includes(c.conclusion))) : [])])];
  if (on('conclusion') && failed.length)
    return out('FAIL', 'ci_failed', failed.map(c => `${c.name}${c.app ? ` (${c.app})` : ''}: ${c.conclusion ?? 'no conclusion'}${c.url ? ` (${c.url})` : ''}`), { more: { ...more, failed: failed.map(c => c.name) } });
  const missing = names.filter(n => !runs.some(c => c.name === n));
  if (on('required_present') && missing.length) return windowOver
    ? out('NO_CHECKS', 'ci_required_missing', [`required check(s) ${missing.join(', ')} never ran on ${sha} ${after}`], { more: { ...more, missing } })
    : out('PENDING', 'ci_required_pending', [`required check(s) ${missing.join(', ')} have not started on ${sha}`], { more: { ...more, missing } });
  const open = req.filter(c => c.status !== 'completed');
  if (on('all_complete') && open.length) return out('PENDING', 'ci_pending', open.map(c => `${c.name}: ${c.status}`), { more });
  const completed = iso(Math.max(...req.map(c => ms(c.completed_at) ?? -Infinity)));
  return out('PASS', 'ci_passed', [], { completed, more });
}

/** The latest CI_EVIDENCE recorded for `head` (a later collection supersedes an earlier one), or null. */
export const latestEvidence = (S, head) => (S?.ci_evidence ?? []).findLast(e => e?.head_sha === head) ?? null;

/**
 * `authorize complete`'s CI condition for the published entry `pub`: the latest evidence for its head is PASS,
 * and recomputing the verdict from the recorded checks under the run's bound config (not the evidence's own
 * required list or state) is PASS too. -> { ok: true, evidence } | { ok: false, code, reasons }
 */
export function ciAuthorize(S, pub, { omit = [] } = {}) {
  const on = (id) => !omit.includes(id);
  const ev = latestEvidence(S, pub.head);
  if (on('evidence_present') && !ev) return { ok: false, code: 'ci_evidence_missing', reasons: [`no CI evidence for the published head ${pub.head}: run run-engine.mjs ci`] };
  if (on('state_pass') && ev?.state !== 'PASS')
    return { ok: false, code: typeof ev?.code === 'string' && ev.code !== 'ci_passed' ? ev.code : 'ci_not_passed', reasons: Array.isArray(ev?.reasons) && ev.reasons.length ? ev.reasons : [`CI is ${ev?.state} on ${pub.head}`] };
  // R0-S N3: the evidence must have verified the published branch still pointed at the head (the remote ref read at
  // collection, or the PR head): without a PR nothing else ties the checks of this sha to what the branch ships.
  if (on('head_verified') && ev && ev.remote_head !== pub.head && ev.pr_view?.head_sha !== pub.head)
    return { ok: false, code: 'ci_head_unverified', reasons: [`the CI evidence for ${pub.head} verified neither the remote branch (${ev.remote_head ?? 'not read'}) nor a PR head at this sha: collect again with run-engine.mjs ci`] };
  if (on('recheck')) {
    const v = verdict({ sha: pub.head, branch: pub.branch, checks: Array.isArray(ev?.checks) ? ev.checks : [], required: S.config?.ciRequiredChecks,
      windowMs: 0, dispatchMs: 0, collectedMs: 0, pr: ev?.pr_view ?? null, ...(ev && Object.hasOwn(ev, 'remote_head') ? { remoteHead: ev.remote_head } : {}) });
    if (v.state !== 'PASS') return { ok: false, code: 'ci_evidence_inconsistent', reasons: [`the recorded checks do not give PASS under the bound config (${v.code}): collect again with run-engine.mjs ci`] };
  }
  return { ok: true, evidence: ev };
}

// ---- the real provider (gh) ---------------------------------------------------------------------

const unavailable = (code, error) => ({ ok: false, code, error: cut(error) });

/** Parse JSON lines; null when any line is not a JSON object. */
function jsonLines(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    try { const v = JSON.parse(l); if (!v || typeof v !== 'object' || Array.isArray(v)) return null; out.push(v); } catch { return null; }
  }
  return out;
}

const normRun = (r) => ({ id: r.id ?? null, name: String(r.name ?? ''), head_sha: r.head_sha ?? null, status: r.status ?? null, conclusion: r.conclusion ?? null,
  started_at: r.started_at ?? null, completed_at: r.completed_at ?? null, app: r.app ?? null, check_suite: r.check_suite ?? null, url: r.url ?? null });

/**
 * Parse the check-runs output: one `{ total_count }` line per page followed by that page's runs (gh api --paginate --jq).
 * A page total that disagrees with the runs listed is ci_provider_incomplete.
 */
export function parseCheckRuns(stdout) {
  const lines = jsonLines(stdout);
  if (!lines) return unavailable('ci_provider_unavailable', 'gh check-runs output is not JSON lines');
  const totals = lines.filter(l => Object.hasOwn(l, 'total_count') && !Object.hasOwn(l, 'name')).map(l => l.total_count);
  const runs = lines.filter(l => Object.hasOwn(l, 'name')).map(normRun);
  if (!totals.length || !totals.every(Number.isInteger)) return unavailable('ci_provider_unavailable', 'gh check-runs output has no total_count');
  const total = Math.max(...totals);
  if (runs.length !== total) return unavailable('ci_provider_incomplete', `the provider reports ${total} check run(s) and listed ${runs.length}`);
  return { ok: true, runs, total };
}

/**
 * R0-S N4: the absolute path and sha256 of the first executable `name` on PATH (realpath), or null. `enroll` pins `gh` this way
 * (state.enrollment.tools.gh), and `ci` and `publish` run exactly that file: a stub put earlier on PATH later changes nothing.
 * The resolution at enroll itself trusts that moment's PATH (residual).
 */
export function resolveTool(name, env = process.env) {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const n of names) {
      try {
        const p = join(dir, n);
        if (!statSync(p).isFile()) continue;
        const real = realpathSync(p);
        return { path: real, sha256: 'sha256:' + createHash('sha256').update(readFileSync(real)).digest('hex') };
      } catch { /* not here */ }
    }
  }
  return null;
}

/** The pinned tool, verified: { ok: true, path } | { ok: false, code: 'gh_unpinned' | 'gh_drift', reason }. */
export function pinnedTool(pin, name = 'gh') {
  if (!pin?.path) return { ok: false, code: `${name}_unpinned`, reason: `no ${name} was pinned at enroll (none on PATH then): start a new run with ${name} installed` };
  let digest = null;
  try { digest = 'sha256:' + createHash('sha256').update(readFileSync(pin.path)).digest('hex'); } catch { digest = null; }
  if (digest !== pin.sha256) return { ok: false, code: `${name}_drift`, reason: `${pin.path} is not the ${name} this run pinned at enroll (${pin.sha256}, now ${digest ?? 'missing'}): restore it or start a new run` };
  return { ok: true, path: pin.path };
}

/** The real adapter: the pinned `gh` (`bin`) in the repository (its {owner}/{repo} placeholders resolve from the git remote). */
export function ghProvider({ repoRoot, env = process.env, spawn = spawnSync, bin = 'gh' }) {
  const run = (args) => {
    const r = spawn(bin, args, { cwd: repoRoot, encoding: 'utf8', env, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    return r.status === 0 ? { ok: true, stdout: r.stdout } : unavailable('ci_provider_unavailable', (r.stderr || r.error?.message || `gh exited ${r.status}`).trim());
  };
  const json = (r) => { if (!r.ok) return r; try { return { ok: true, data: JSON.parse(r.stdout) }; } catch { return unavailable('ci_provider_unavailable', 'gh output is not JSON'); } };
  return {
    name: 'gh',
    checkRuns(sha) {
      if (!SHA_RE.test(sha)) return unavailable('ci_provider_unavailable', `not a commit SHA: ${sha}`);
      const r = run(['api', '-X', 'GET', `repos/{owner}/{repo}/commits/${sha}/check-runs`, '-f', 'per_page=100', '--paginate', '--jq',
        '{total_count}, (.check_runs[] | {id, name, head_sha, status, conclusion, started_at, completed_at, app: .app.slug, check_suite: .check_suite.id, url: .html_url})']);
      return r.ok ? parseCheckRuns(r.stdout) : r;
    },
    pullRequest(n) {
      const r = json(run(['pr', 'view', String(n), '--json', 'number,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,state,url']));
      if (!r.ok) return r;
      const d = r.data ?? {};
      return { ok: true, pr: { number: d.number ?? n, head_sha: d.headRefOid ?? null, head_branch: d.headRefName ?? null, base: d.baseRefName ?? null,
        mergeable: d.mergeable ?? null, merge_state: d.mergeStateStatus ?? null, state: d.state ?? null, url: d.url ?? null } };
    },
    recentRuns(branch) {
      const r = json(run(['run', 'list', '--branch', branch, '--limit', '10', '--json', 'databaseId,headSha,status,conclusion,event,workflowName,createdAt']));
      if (!r.ok) return r;
      return { ok: true, runs: (Array.isArray(r.data) ? r.data : []).map(x => ({ id: x.databaseId ?? null, head_sha: x.headSha ?? null, status: x.status ?? null,
        conclusion: x.conclusion ?? null, event: x.event ?? null, workflow: x.workflowName ?? null, created_at: x.createdAt ?? null })) };
    },
  };
}

// ---- NO_CHECKS diagnostic (DETECTED) --------------------------------------------------------------

const gitOut = (repo, args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30000 }); return r.status === 0 ? r.stdout : null; };
const unquote = (s) => s.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
const listOf = (s) => { const v = s.replace(/\s+#.*$/, '').trim(); return v.startsWith('[') ? v.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean) : [unquote(v)].filter(Boolean); };
const FILTER_KEYS = ['branches', 'branches-ignore', 'paths', 'paths-ignore', 'tags', 'tags-ignore', 'types'];

/**
 * The `on:` triggers of a workflow file, read line by line (not a YAML parser): { event: { branches?, paths?, ... } },
 * or null when no top-level `on:` key is found.
 */
export function parseTriggers(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex(l => /^(?:on|"on"|'on'|true)\s*:/.test(l));
  if (i < 0) return null;
  const inline = lines[i].replace(/^[^:]*:/, '').replace(/\s+#.*$/, '').trim();
  const events = {};
  if (inline) { for (const e of listOf(inline)) events[e] = {}; return events; }
  let cur = null, key = null, evIndent = null;
  for (const l of lines.slice(i + 1)) {
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.match(/^ */)[0].length;
    if (ind === 0) break;
    evIndent ??= ind;
    const t = l.trim(), m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(t), item = /^-\s*(.+)$/.exec(t);
    if (ind === evIndent) {
      if (m) { cur = events[m[1]] = {}; key = null; } else if (item) { events[unquote(item[1])] = {}; cur = null; }
      continue;
    }
    if (!cur) continue;
    if (m && FILTER_KEYS.includes(m[1])) { key = m[1]; cur[key] = m[2] ? listOf(m[2]) : []; continue; }
    if (m) { key = null; continue; }
    if (item && key) cur[key].push(unquote(item[1]));
  }
  return events;
}

/** A GitHub filter glob as a RegExp: `**` any path, `*` within a segment, `?` one character. */
export function globRe(p) {
  let s = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') { i++; if (p[i + 1] === '/') { i++; s += '(?:.*/)?'; } else s += '.*'; }
    else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}

/** Whether `value` passes an ordered include list with `!` negations (the last matching pattern decides). */
const included = (value, patterns) => {
  let hit = false;
  for (const p of patterns) { const neg = p.startsWith('!'); if (globRe(neg ? p.slice(1) : p).test(value)) hit = !neg; }
  return hit;
};

/** Whether one event's filters would run on `ref` (a branch) with `changed` files: { would_trigger: bool|null, why }. */
export function filterVerdict(f, ref, changed) {
  if (f.branches && ref && !included(ref, f.branches)) return { would_trigger: false, why: `branch ${ref} is not in branches` };
  if (f['branches-ignore'] && ref && included(ref, f['branches-ignore'])) return { would_trigger: false, why: `branch ${ref} is in branches-ignore` };
  if (changed === null && (f.paths || f['paths-ignore'])) return { would_trigger: null, why: 'changed files unknown' };
  if (f.paths && !changed.some(p => included(p, f.paths))) return { would_trigger: false, why: 'no changed file matches paths' };
  if (f['paths-ignore'] && changed?.length && changed.every(p => included(p, f['paths-ignore']))) return { would_trigger: false, why: 'every changed file matches paths-ignore' };
  return { would_trigger: true, why: 'filters admit this change' };
}

/** Each workflow at `head` with its push and pull_request trigger verdicts against the files changed since `mergeBase`. */
export function workflowDiagnostic(repoRoot, { head, mergeBase, branch, prBase }) {
  const listed = gitOut(repoRoot, ['ls-tree', '--name-only', head, '.github/workflows/']);
  if (listed === null) return { ok: false, reason: 'git ls-tree failed', workflows: [] };
  const files = listed.split('\n').filter(f => /\.ya?ml$/.test(f));
  const diff = mergeBase ? gitOut(repoRoot, ['diff', '--name-only', '--no-renames', mergeBase, head]) : null;
  const changed = diff === null ? null : diff.split('\n').filter(Boolean);
  const workflows = files.map(file => {
    const ev = parseTriggers(gitOut(repoRoot, ['show', `${head}:${file}`]) ?? '');
    if (!ev) return { file, parsed: false };
    const events = Object.keys(ev);
    return { file, parsed: true, events,
      ...(ev.push ? { push: filterVerdict(ev.push, branch, changed) } : {}),
      ...(ev.pull_request ? { pull_request: filterVerdict(ev.pull_request, prBase, changed) } : {}),
      ...(ev.pull_request_target ? { pull_request_target: filterVerdict(ev.pull_request_target, prBase, changed) } : {}) };
  });
  return { ok: true, changed_files: changed, workflows, ...(files.length ? {} : { reason: 'no workflow file under .github/workflows at the published head' }) };
}

// ---- collection ---------------------------------------------------------------------------------

/**
 * One collection for the published entry `pub` -> the CI_EVIDENCE record. `now()` returns epoch ms.
 * Order: the PR view (when a PR is known), then the check runs, then (NO_CHECKS only) the diagnostic.
 */
/** The commit `refs/heads/<branch>` points at on the published remote ({ ok, head: sha | null } or { ok: false, error }). */
export function remoteHeadOf(repoRoot, pub, env) {
  const r = spawnSync('git', ['ls-remote', pub.remote ?? 'origin', `refs/heads/${pub.branch}`], { cwd: repoRoot, encoding: 'utf8', timeout: 60000, ...(env ? { env } : {}) });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.error?.message || `git ls-remote exited ${r.status}`).trim() };
  return { ok: true, head: r.stdout.trim().split(/\s+/)[0] || null };
}

export function collect({ S, repoRoot, provider, pub, pr, now, remote = remoteHeadOf(repoRoot, pub) }) {
  const prNumber = pr ?? prNumberOf(pub.pr?.url);
  const view = prNumber ? provider.pullRequest(prNumber) : null;
  const runs = provider.checkRuns(pub.head);
  const collectedMs = now();
  const head = { schema: CI_SCHEMA, head_sha: pub.head, branch: pub.branch ?? null, pr: prNumber ?? null, provider: provider.name ?? 'custom' };
  const timing = (t = {}) => ({ dispatched_at: pub.at ?? null, first_check_started_at: t.first_check_started_at ?? null,
    checks_completed_at: t.checks_completed_at ?? null, collected_at: iso(collectedMs) });
  const failure = [view && !view.ok ? view : null, !runs.ok ? runs : null, !remote.ok ? { code: 'ci_remote_unavailable', error: `the published branch could not be read: ${cut(remote.error)}` } : null].find(Boolean);
  if (failure) return { ...head, state: 'UNAVAILABLE', code: failure.code ?? 'ci_provider_unavailable', reasons: [failure.error ?? 'provider failed'],
    checks: [], collected_at: iso(collectedMs), timing: timing() };
  const v = verdict({ sha: pub.head, branch: pub.branch, checks: runs.runs, required: S.config?.ciRequiredChecks, windowMs: noChecksWindowMs(S.config),
    dispatchMs: ms(pub.at), collectedMs, pr: view?.pr ?? null, remoteHead: remote.head });
  const { timing: vt, ...rest } = v;
  const ev = { ...head, ...rest, remote_head: remote.head, checks: runs.runs.filter(c => c.head_sha === pub.head), ...(view?.pr ? { pr_view: view.pr } : {}),
    collected_at: iso(collectedMs), timing: timing(vt) };
  if (v.state === 'NO_CHECKS') {
    const recent = pub.branch ? provider.recentRuns(pub.branch) : { ok: false, error: 'no branch recorded' };
    ev.diagnostic = {
      pr: view?.pr ? { number: view.pr.number, mergeable: view.pr.mergeable, merge_state: view.pr.merge_state, state: view.pr.state, base: view.pr.base }
        : { number: null, reason: 'no PR recorded for this publish: pass --pr <n>' },
      workflow_filters: workflowDiagnostic(repoRoot, { head: pub.head, mergeBase: pub.merge_base ?? null, branch: pub.branch, prBase: view?.pr?.base ?? pub.base ?? null }),
      recent_runs: recent.ok ? recent.runs : { error: cut(recent.error) },
      label: 'DETECTED: a diagnostic, never part of the verdict',
    };
  }
  return ev;
}
