#!/usr/bin/env node
/**
 * PR scope check (S6, F07): classifies every path of the candidate against the approved plan as
 * planned, supporting or material, and writes a `ship-ticket-scope-v1` record. The orchestrator runs it
 * before announcing REVIEW and again on the frozen candidate at SHIP (manual flow included). No gate,
 * engine step or ship-ready check reads it, and the engine never imports it: it adds no authority.
 * Dependency-free Node >= 18; git and candidate-id.mjs through spawnSync with an argument list, no shell.
 *
 * CLI: check-pr-scope.mjs check --repo <path> --ticket <T> --run-id <id> --base <ref> --plan <plan.md> [--dag <dag.json>] [--out <file>]
 *
 * Steps, in order; any refusal exits 2 and writes no record:
 *  (a) the plan narrative digest equals approved_plan_digest of this run's last START (`approval_mismatch`);
 *  (b) with --dag: validateEngineDag passes (`dag_invalid`) and the DAG sha is listed in the plan narrative or
 *      equals exactly one DAG_BOUND of this run (`dag_unbound`); roots = every node's writes;
 *  (c) without --dag (manual flow): roots = the paths of exactly ONE `Files touched` table (outside fenced blocks
 *      and RUN-STATE; header row starts with `ID`; each cell holds only backticked paths, or `—`/`none`); a
 *      placeholder, prose, zero or two tables, a bad path or zero paths is `plan_list_unparsable` (fail closed).
 *      With --dag, a parseable table that differs from the DAG writes is the advisory `plan_table_drift`;
 *  (d) the envelope: at most ONE narrative line `scope-envelope: a/, b/` (written by the plan author, approved in
 *      ExitPlanMode, bound by the plan digest; never a flag); every entry normalized and equal to or under a root
 *      (`envelope_outside_contract`); a second line is `envelope_duplicate`; no line means an empty envelope;
 *  (e) exclusions: exactly the pinned pair `.specs/plans/<T>.md` and `session-log.md` (no flag widens it);
 *  (f) the path set and candidate_id come from candidate-id.mjs --base <ref> with those exclusions: the tracked
 *      diff against the merge base (no renames: a rename is a deleted source plus an added destination) plus
 *      untracked, non-ignored files. A git-ignored file is invisible to this check exactly as to the candidate
 *      ID; an edit of .gitignore is itself a changed path. A dirty submodule fails candidate-id.
 *
 * Classes (case-sensitive, via engine-dag.mjs `under`), first match wins:
 *  1. planned, via exact: the path equals a root;
 *  2. supporting, via envelope: under an envelope entry and a root, kind `file`, basename not a dependency manifest or lockfile;
 *  3. planned, via directory: under a root (flag unlisted_under_directory_write);
 *  4. material: anything else. A path holding a line terminator (\n, \r, U+2028, U+2029) is material whatever its
 *     roots, because the engine's contract matcher does not match it under a directory (fail closed).
 * Advisory flags never change the exit code: case_alias (a root matches only case-insensitively; still material),
 * symlink, symlink_target_outside_contract (a symlink is never supporting), submodule, deleted, dependency_manifest,
 * unlisted_under_directory_write, line_terminator. The envelope lies inside the roots, so supporting is a subset of
 * under-roots and the order only moves labels: exit 0 implies every path is inside the engine's Design Contract
 * (designContract + security-plan.mjs globRe), pinned by the property test in check-pr-scope.test.mjs.
 *
 * What it proves: the candidate's path set (the same set the candidate ID hashes) against the approved roots.
 * What it does not prove: behaviour inside a planned file (a new route inside page.tsx is reassess's new-route signal).
 * A forged record is moot: SHIP recomputes it on the frozen candidate and never trusts a stored one.
 *
 * Output: the record as JSON on stdout, byte-identical to the file written atomically to --out (default
 * `<git dir>/ai-skills/ship-ticket/<T>.scope.json`, never committed; an --out inside the work tree but outside the
 * git dir is refused), so record_sha = sha256 of stdout.
 * Exit codes: 0 CLEAN, 1 material paths present (listed), 2 refused input, 3 git or candidate-id failure.
 * **Exit 0 is never a commit or freeze permission.**
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, isAbsolute, join, relative, sep, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { under, validateEngineDag, planNarrativeDigest, runStateEvents, sha, normDigest, BEGIN, END } from './engine-dag.mjs';
import { parseRunState, malformedReason } from './run-state.mjs';
import { gitPath, writeStateAtomic } from './lib/durable-io.mjs';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'ship-ticket-scope-v1';
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const USAGE = 'Usage: check-pr-scope.mjs check --repo <path> --ticket <T> --run-id <id> --base <ref> --plan <plan.md> [--dag <dag.json>] [--out <file>]';

class Refusal extends Error {
  constructor(exit, code, message) { super(`${code}: ${message}`); this.exit = exit; this.code = code; }
}
const refuse = (code, message) => { throw new Refusal(2, code, message); };
const gitFail = (code, message) => { throw new Refusal(3, code, message); };

/** engine-dag.mjs normalRel (not exported there), kept local; parity with validateEngineDag is pinned by a test. */
export const normalRel = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.includes('\\')
  && !p.split('/').some(x => x === '..' || x === '.' || !x);
/** Exactly one trailing slash marks a directory in a plan cell or envelope entry; the rest must be normalRel. */
const dirToken = (t) => (t.endsWith('/') ? t.slice(0, -1) : t);

const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'bun.lock', 'bun.lockb', '.npmrc', '.yarnrc', '.yarnrc.yml', 'deno.json', 'deno.jsonc', 'deno.lock', 'Cargo.toml', 'Cargo.lock',
  'go.mod', 'go.sum', 'go.work', 'Gemfile', 'Gemfile.lock', 'requirements.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'pyproject.toml',
  'uv.lock', 'setup.py', 'setup.cfg', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'gradle.lockfile', 'packages.lock.json', 'Directory.Packages.props', 'Package.swift', 'Package.resolved',
  'Podfile', 'Podfile.lock', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock']);
/** A dependency manifest or lockfile, by basename. */
export const isManifest = (p) => { const b = posix.basename(p); return MANIFESTS.has(b) || /\.(csproj|fsproj|vbproj)$/.test(b) || /^requirements.*\.txt$/.test(b); };

/** Narrative lines of `text` outside the RUN-STATE block and outside fenced code blocks. */
function narrativeLines(text) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  const narrative = b >= 0 && e > b ? text.slice(0, b) + text.slice(e + END.length) : text;
  const out = [];
  let fence = null;
  for (const line of narrative.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) { if (fence === null) fence = m[1][0]; else if (m[1][0] === fence) fence = null; continue; }
    if (fence === null) out.push(line);
  }
  return out;
}

const cells = (line) => { const t = line.trim(); return t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim()); };
const CELL = /^`[^`]+`(?:\s*,?\s*`[^`]+`)*$/;

/** Paths (sorted, unique, trailing slash dropped) of the plan's one `Files touched` table; refuses `plan_list_unparsable`. */
export function parseFilesTable(text) {
  const unparsable = (why) => refuse('plan_list_unparsable', why);
  const lines = narrativeLines(text);
  const heads = [];
  lines.forEach((l, i) => { if (l.trim().startsWith('|')) { const c = cells(l); if (c[0] === 'ID' && c.includes('Files touched')) heads.push(i); } });
  if (heads.length !== 1) unparsable(`expected exactly one table whose header starts with ID and has a Files touched cell, found ${heads.length}`);
  const head = cells(lines[heads[0]]), col = head.indexOf('Files touched');
  if (!/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[heads[0] + 1] ?? '')) unparsable('the Files touched table has no separator row');
  const paths = [];
  for (let i = heads[0] + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const row = cells(lines[i]);
    if (row.length !== head.length) unparsable(`row ${JSON.stringify(lines[i].trim())} has ${row.length} cells, the header ${head.length}`);
    const cell = row[col];
    if (cell === '—' || cell === 'none') continue;
    if (!CELL.test(cell)) unparsable(`Files touched cell ${JSON.stringify(cell)} is not a list of backticked paths (or — / none)`);
    for (const [, tok] of cell.matchAll(/`([^`]+)`/g)) {
      const p = dirToken(tok);
      if (/[<>]/.test(tok) || !normalRel(p)) unparsable(`Files touched path ${JSON.stringify(tok)} is a placeholder or not a normalized repository-relative path`);
      paths.push(p);
    }
  }
  if (!paths.length) unparsable('the Files touched table lists no path');
  return [...new Set(paths)].sort();
}

/** Entries of the plan's at most one `scope-envelope:` narrative line ([] without one); refuses a bad entry or a second line. */
export function parseEnvelope(text) {
  const found = narrativeLines(text).map(l => l.trimStart()).filter(l => l.startsWith('scope-envelope:'));
  if (found.length > 1) refuse('envelope_duplicate', `the plan has ${found.length} scope-envelope lines; at most one`);
  if (!found.length) return [];
  const entries = found[0].slice('scope-envelope:'.length).split(',').map(s => s.trim());
  for (const e of entries) {
    if (!e || /[\s<>`]/.test(e) || !normalRel(dirToken(e))) refuse('envelope_outside_contract', `scope-envelope entry ${JSON.stringify(e)} is not a normalized repository-relative path`);
  }
  return [...new Set(entries.map(dirToken))].sort();
}

/** Where a symlink at repo path `p` with link text `target` points, repo-relative, or null when outside the repository. */
function linkTarget(p, target) {
  const t = String(target).replace(/\\/g, '/');
  if (posix.isAbsolute(t) || win32.isAbsolute(target)) return null;
  const n = posix.normalize(posix.join(posix.dirname(p), t));
  return n === '..' || n.startsWith('../') ? null : n.replace(/\/$/, '');
}

/**
 * Classify candidate entries [{ path, kind }] against `roots` and `envelope` (see the header for the rules).
 * `readlink(path)` returns a symlink's link text. Returns [{ path, kind, class, via, flags }] in input order.
 */
export function classify(entries, { roots, envelope, readlink }) {
  const lower = roots.map(r => r.toLowerCase());
  return entries.map(({ path, kind }) => {
    const flags = [];
    if (kind === 'symlink') {
      flags.push('symlink');
      let target = null;
      try { target = linkTarget(path, readlink(path)); } catch { /* unreadable: outside */ }
      if (target === null || !under(target, roots)) flags.push('symlink_target_outside_contract');
    }
    if (kind === 'submodule') flags.push('submodule');
    if (kind === 'deleted') flags.push('deleted');
    const manifest = isManifest(path);
    if (manifest) flags.push('dependency_manifest');
    let cls = 'material', via = null;
    if (LINE_TERMINATOR.test(path)) flags.push('line_terminator');
    else if (roots.includes(path)) { cls = 'planned'; via = 'exact'; }
    else if (kind === 'file' && !manifest && under(path, envelope) && under(path, roots)) { cls = 'supporting'; via = 'envelope'; }
    else if (under(path, roots)) { cls = 'planned'; via = 'directory'; flags.push('unlisted_under_directory_write'); }
    else if (under(path.toLowerCase(), lower)) flags.push('case_alias');
    return { path, kind, class: cls, via, flags };
  });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('git_failed', `git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

/** realpath of `p`, or of its nearest existing ancestor joined with the rest (the file may not exist yet). */
function realish(p) {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs); // native: expands Windows 8.3 short names as git reports them
  const parent = dirname(abs);
  return parent === abs ? abs : join(realish(parent), basename(abs));
}
const inside = (p, dir) => { const r = relative(dir, p); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };

/** The approved plan's text, digest and events; refuses unless this run's last START approves the current narrative. */
function approvedPlan(planFile, runId) {
  let text;
  try { text = readFileSync(planFile, 'utf8'); } catch (e) { refuse('plan_unreadable', `${planFile}: ${e.code ?? e.message}`); }
  const R = parseRunState(text);
  if (!R) refuse('approval_mismatch', `${planFile} has no RUN-STATE block`);
  const malformed = malformedReason(R);
  if (malformed) refuse('run_state_malformed', malformed);
  const digest = planNarrativeDigest(text);
  const events = runStateEvents(text);
  const start = events.filter(e => e.event === 'START' && e.run_id === runId).at(-1);
  if (!start || normDigest(start.approved_plan_digest) !== digest) refuse('approval_mismatch', `plan narrative does not match the last START of ${runId}`);
  return { text, digest, events };
}

/** The bound DAG's digest and write roots; refuses dag_invalid / dag_unbound (the run-engine.mjs init rule). */
function boundDag(dagFile, { text, events }, ticket, runId) {
  let raw, doc;
  try { raw = readFileSync(dagFile); } catch (e) { refuse('dag_invalid', `${dagFile}: ${e.code ?? e.message}`); }
  try { doc = JSON.parse(raw); } catch { refuse('dag_invalid', 'the DAG is not JSON'); }
  let dag;
  try { dag = validateEngineDag(doc, { ticket }); } catch (e) { refuse('dag_invalid', e.message); }
  const digest = sha(raw);
  const narrative = text.slice(0, text.indexOf(BEGIN)) + text.slice(text.indexOf(END));
  const listed = narrative.includes(digest) || narrative.includes(digest.replace(/^sha256:/, 'sha256-'));
  const bound = events.filter(e => e.event === 'DAG_BOUND' && e.run_id === runId);
  if (!listed && !(bound.length === 1 && normDigest(bound[0].dag_digest) === digest)) {
    refuse('dag_unbound', 'the DAG digest is neither in the approved plan nor in exactly one DAG_BOUND of this run');
  }
  return { digest, roots: [...new Set(dag.nodes.flatMap(n => n.writes))].sort() };
}

/** Run the check; returns { exit, record, text } or throws a Refusal (exit 2 or 3). Writes nothing itself. */
export function checkScope({ repo, ticket, runId, base, plan, dag }) {
  if (!SAFE_ID.test(ticket ?? '')) refuse('bad_input', `unsafe --ticket ${JSON.stringify(ticket)}`);
  if (!SAFE_ID.test(runId ?? '')) refuse('bad_input', `unsafe --run-id ${JSON.stringify(runId)}`);
  if (typeof base !== 'string' || !base || base.startsWith('-')) refuse('bad_input', `refused ref: ${base}`);
  const approved = approvedPlan(plan, runId);
  let roots, source, dagDigest = null, drift = null;
  if (dag !== undefined) {
    ({ digest: dagDigest, roots } = boundDag(dag, approved, ticket, runId));
    source = 'dag';
    try {
      const t = parseFilesTable(approved.text);
      const onlyDag = roots.filter(r => !t.includes(r)), onlyTable = t.filter(p => !roots.includes(p));
      drift = onlyDag.length || onlyTable.length ? { only_in_dag: onlyDag, only_in_table: onlyTable } : null;
    } catch (e) { if (!(e instanceof Refusal)) throw e; drift = { table: 'unparsable', reason: e.message }; }
  } else {
    roots = parseFilesTable(approved.text);
    source = 'plan-table';
  }
  const envelope = parseEnvelope(approved.text);
  const outside = envelope.filter(e => !under(e, roots));
  if (outside.length) refuse('envelope_outside_contract', `scope-envelope ${outside.join(', ')} is not under a ${source === 'dag' ? 'DAG write' : 'Files touched path'}`);
  const exclusions = [`.specs/plans/${ticket}.md`, 'session-log.md'];
  const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', repo, '--base', base, ...exclusions.flatMap(x => ['--exclude', x])],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('candidate_id_failed', `candidate-id: ${(r.stderr || r.error?.message || 'failed').trim()}`);
  let cand;
  try { cand = JSON.parse(r.stdout); } catch { gitFail('candidate_id_failed', 'candidate-id printed no JSON'); }
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  const files = classify(cand.paths.map(p => ({ path: p.path, kind: p.kind })), { roots, envelope, readlink: (p) => readlinkSync(join(top, p)) });
  const count = (c) => files.filter(f => f.class === c).length;
  const counts = { planned: count('planned'), supporting: count('supporting'), material: count('material'), total: files.length };
  const record = { schema: SCHEMA, ticket, run_id: runId, base, merge_base: cand.merge_base, candidate_id: cand.candidate_id,
    approved_plan_digest: approved.digest, dag_digest: dagDigest, source, roots, envelope, exclusions, files, counts,
    outcome: counts.material ? 'MATERIAL' : 'CLEAN', plan_table_drift: drift };
  return { exit: counts.material ? 1 : 0, record, text: JSON.stringify(record, null, 1) + '\n' };
}

/** Where the record goes: --out (refused inside the work tree unless inside the git dir) or the git-dir default. */
function outPath(repo, ticket, out) {
  const top = realish(git(repo, ['rev-parse', '--show-toplevel']));
  if (out === undefined) return gitPath(top, `ai-skills/ship-ticket/${ticket}.scope.json`);
  const target = realish(out);
  const gitDirs = [git(repo, ['rev-parse', '--absolute-git-dir']), resolve(top, git(repo, ['rev-parse', '--git-common-dir']))].map(realish);
  if (inside(target, top) && !gitDirs.some(d => inside(target, d))) refuse('out_in_work_tree', `--out ${out} is inside the work tree; the record is never committed (use the git dir or a path outside the repository)`);
  return target;
}

const FLAGS = ['repo', 'ticket', 'run-id', 'base', 'plan', 'dag', 'out'];

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const f = {};
  let bad = cmd !== 'check';
  for (let i = 0; i < rest.length && !bad; i += 2) {
    const k = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    if (!FLAGS.includes(k) || rest[i + 1] === undefined || Object.hasOwn(f, k)) bad = true;
    else f[k] = rest[i + 1];
  }
  if (bad || !f.repo || !f.ticket || !f['run-id'] || !f.base || !f.plan) { process.stderr.write(USAGE + '\n'); return 2; }
  try {
    const repo = resolve(f.repo);
    // Check the --base and identity inputs before touching git, then the output location before any work.
    if (String(f.base).startsWith('-')) refuse('bad_input', `refused ref: ${f.base}`);
    if (!SAFE_ID.test(f.ticket)) refuse('bad_input', `unsafe --ticket ${JSON.stringify(f.ticket)}`);
    const out = outPath(repo, f.ticket, f.out);
    const res = checkScope({ repo, ticket: f.ticket, runId: f['run-id'], base: f.base, plan: resolve(f.plan), dag: f.dag === undefined ? undefined : resolve(f.dag) });
    try { await writeStateAtomic(out, res.record); } catch (e) { gitFail('record_write_failed', `${out}: ${e.code ?? e.message}`); }
    process.stdout.write(res.text);
    if (res.exit === 1) process.stderr.write('check-pr-scope: MATERIAL\n' + res.record.files.filter(x => x.class === 'material').map(x => `  ${x.path}${x.flags.length ? ` (${x.flags.join(', ')})` : ''}`).join('\n') + '\n');
    return res.exit;
  } catch (e) {
    if (e instanceof Refusal) { process.stderr.write(`check-pr-scope: ${e.message}\n`); return e.exit; }
    if (e?.code === 'plan_invalid') { process.stderr.write(`check-pr-scope: ${e.message}\n`); return 2; }
    if (e?.code === 'not_a_repo') { process.stderr.write(`check-pr-scope: ${e.message}\n`); return 3; }
    process.stderr.write(`check-pr-scope: ${e?.stack ?? e}\n`);
    return 3;
  }
}

if (isEntrypoint(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
