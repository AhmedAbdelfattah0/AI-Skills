#!/usr/bin/env node
/**
 * PR scope check (S6, F07; Option B): classifies every path of the candidate as planned, supporting or material
 * against the ONE `scope-contract:` line of the approved plan, and writes a `ship-ticket-scope-v1` record. The
 * orchestrator runs it before announcing REVIEW and again on the frozen candidate at SHIP (manual flow included).
 * No gate, engine step or ship-ready check reads it, and the engine never imports it: it adds no authority.
 * No Markdown is parsed: the Files touched table is explanation for the approver and is read by no script.
 * Dependency-free Node >= 18; git and candidate-id.mjs through spawnSync with an argument list, no shell.
 *
 * CLI: check-pr-scope.mjs check --repo <path> --ticket <T> --run-id <id> --base <ref> --plan <plan.md> [--dag <dag.json>] [--out <file>]
 *      check-pr-scope.mjs contract --mode engine|manual [--dag <dag.json>] [--planned <p>]... [--supporting <s>]...
 *      (prints the canonical contract line through the same validator; engine mode takes planned from the DAG writes)
 *
 * The contract, one raw narrative line inside the plan digest bound by START:
 *   scope-contract: {"v":1,"mode":"engine","dag":"sha256:<64 hex>","planned":["apps/web","apps/api/src/**\/*.ts"],"supporting":["tests"]}
 *   scope-contract: {"v":1,"mode":"manual","dag":null,"planned":["src/checkout/page.tsx","src/checkout"],"supporting":["tests"]}
 * Extraction: the narrative (RUN-STATE excluded) split on \n; exactly ONE line starts at column 0 with
 * `scope-contract: `; any OTHER line containing `scope-contract` in any case is `scope_contract_ambiguous` (prose,
 * fence, comment, backticks, list item, indentation, BOM, CR); none is `scope_contract_missing`. The JSON must equal its
 * own canonical form with keys v, mode, dag, planned, supporting in that order (`scope_contract_noncanonical`); line
 * <= 8 KiB, planned <= 64, supporting <= 16, entry <= 256 chars. Field rules (`scope_contract_invalid`):
 *  - every entry is a path with no trailing slash covering itself and everything below (the DAG write syntax): the
 *    engine-dag normalRel rule, no control character or line terminator, no duplicate;
 *  - planned: manual mode literal paths only (no * ? [ ] { }) and at least one; engine mode may carry the DAG's
 *    globs; never a wildcard-only first segment; a single-segment entry is allowed and flagged `broad_planned`;
 *  - supporting: literal, last segment in the closed set tests, test, __tests__, spec, e2e, fixtures, __fixtures__,
 *    docs; no segment .github, .git, .claude, .ship-ticket, .specs or node_modules; disjoint from planned
 *    (`supporting_overlaps_planned`: no entry equals, contains or lies under a planned entry or its literal prefix).
 * Mode binding (the approved contract is the authority; the tripwires below only refuse):
 *  - engine: --dag required (`dag_required`, also after a failed engine init); sha of the --dag file equals `dag`
 *    and, when the run has any DAG_BOUND, exactly one DAG_BOUND equal to it (`dag_unbound`); validateEngineDag passes
 *    (`dag_invalid`); planned equals the DAG write set (`contract_dag_mismatch`);
 *  - manual: no --dag (`contract_mode_mismatch`); no DAG_BOUND of the run, no <T>.state.json, no <T>.engine.jsonl
 *    (`manual_with_engine_evidence`). Falling back from engine to manual is a new plan version re-approved through
 *    ExitPlanMode (the digest changes). The script cannot prove a ticket is ELEVATED or that the owner understood the
 *    mode; that is the S3c human step.
 * Steps (any refusal exits 2 and writes no record): approval (the narrative digest equals the last START of the run,
 * `approval_mismatch`), the contract, the mode, then the path set from candidate-id.mjs --base <ref> with exactly the
 * pinned exclusions `.specs/plans/<T>.md` and `session-log.md` (tracked diff against the merge base, no renames, plus
 * untracked non-ignored files; a git-ignored file is invisible to this check exactly as to the candidate ID; a dirty
 * submodule fails candidate-id). candidate-id excludes by prefix, so a changed path strictly below an exclusion file
 * (`session-log.md/x`) is added here as material with flag `under_exclusion_file` (engine follow-up).
 *
 * Classes, first match wins (a path holding a line terminator is always material):
 *  1. planned: equals an entry (via exact) or lies under one (via directory; engine mode matches every entry `w` as
 *     the engine does, globRe(w) or globRe(w/**), via glob when `w` has * or ?), flag unlisted_under_directory_write;
 *  2. supporting: under a supporting entry, kind `file` (never a symlink, deletion or submodule), not a manifest or
 *     lockfile, and under a `docs` entry not an executable-source extension (else material, flag docs_executable);
 *  3. material: anything else.
 * Advisory flags never change the exit code: case_alias, symlink, symlink_target_outside_contract, submodule,
 * deleted, dependency_manifest, unlisted_under_directory_write, broad_planned, line_terminator, docs_executable,
 * under_exclusion_file. A planned path always matches the engine's Design Contract (designContract + security-plan.mjs
 * globRe), pinned by the property test; supporting paths are outside the DAG writes by design and are listed in the
 * record and the PR body for review.
 *
 * What it proves: the candidate's path set (the set the candidate ID hashes) against the approved contract. What it
 * does not prove: behaviour inside a planned file (a new route inside page.tsx is reassess's new-route signal).
 * A forged record is moot: SHIP recomputes it on the frozen candidate and never trusts a stored one. By design a
 * refusal leaves an earlier record at the default path untouched, and START/DAG_BOUND are read as the engine reads
 * them before init (the last START of the run, no quiescence rule): a stored record is never evidence.
 *
 * Output: the record as JSON on stdout, byte-identical to the file written atomically to --out (default
 * `<git dir>/ai-skills/ship-ticket/<T>.scope.json`, never committed; an --out inside the work tree but outside the
 * git dir is refused), so record_sha = sha256 of stdout.
 * Exit codes: 0 CLEAN, 1 material paths present (listed), 2 refused input, 3 git or candidate-id failure.
 * **Exit 0 is never a commit or freeze permission.**
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, basename, isAbsolute, join, relative, sep, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { under, overlap, validateEngineDag, planNarrativeDigest, runStateEvents, sha, normDigest, BEGIN, END } from './engine-dag.mjs';
import { parseRunState, malformedReason } from './run-state.mjs';
import { gitPath, writeStateAtomic } from './lib/durable-io.mjs';
import { isEntrypoint } from './harness.mjs';

export const SCHEMA = 'ship-ticket-scope-v1';
const CANDIDATE_CLI = fileURLToPath(new URL('./candidate-id.mjs', import.meta.url));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const KEY = 'scope-contract: ';
const KEYS = 'v,mode,dag,planned,supporting';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const SUPPORTING_SEGMENTS = Object.freeze(['tests', 'test', '__tests__', 'spec', 'e2e', 'fixtures', '__fixtures__', 'docs']);
const FORBIDDEN_SEGMENTS = ['.github', '.git', '.claude', '.ship-ticket', '.specs', 'node_modules'];
const DOCS_EXECUTABLE = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|php|go|java|cs|sh|sql)$/i;
const USAGE = 'Usage: check-pr-scope.mjs check --repo <path> --ticket <T> --run-id <id> --base <ref> --plan <plan.md> [--dag <dag.json>] [--out <file>]\n'
  + '       check-pr-scope.mjs contract --mode engine|manual [--dag <dag.json>] [--planned <p>]... [--supporting <s>]...';

class Refusal extends Error {
  constructor(exit, code, message) { super(`${code}: ${message}`); this.exit = exit; this.code = code; }
}
const refuse = (code, message) => { throw new Refusal(2, code, message); };
const gitFail = (code, message) => { throw new Refusal(3, code, message); };

/** engine-dag.mjs normalRel (not exported there), kept local; parity with validateEngineDag is pinned by a test. */
export const normalRel = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.includes('\\')
  && !p.split('/').some(x => x === '..' || x === '.' || !x);

/** security-plan.mjs normPath + globRe (not exported there; a protected file), kept local; a parity test extracts the real source. */
const normPath = (p) => String(p).replace(/^(\.\/)+/, '');
export function globRe(glob) {
  let g = normPath(glob);
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
/** The engine's Design Contract match of one write `w`: `w` or `w/**` (engine-gates.mjs designContract). */
function engineMatcher(entries) {
  const res = entries.map(w => [w, globRe(w), globRe(`${w}/**`)]);
  return (p) => res.find(([, a, b]) => a.test(p) || b.test(p))?.[0];
}
const literalMatcher = (entries) => (p) => entries.find(w => p === w || p.startsWith(w + '/'));
const hasGlob = (w) => /[*?]/.test(w);

const MANIFESTS = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'bun.lock', 'bun.lockb', '.npmrc', '.yarnrc', '.yarnrc.yml', 'deno.json', 'deno.jsonc', 'deno.lock', 'Cargo.toml', 'Cargo.lock',
  'go.mod', 'go.sum', 'go.work', 'Gemfile', 'Gemfile.lock', 'requirements.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock', 'pyproject.toml',
  'uv.lock', 'setup.py', 'setup.cfg', 'composer.json', 'composer.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'gradle.lockfile', 'packages.lock.json', 'Directory.Packages.props', 'Package.swift', 'Package.resolved',
  'Podfile', 'Podfile.lock', 'mix.exs', 'mix.lock', 'pubspec.yaml', 'pubspec.lock']);
/** A dependency manifest or lockfile, by basename. */
export const isManifest = (p) => { const b = posix.basename(p); return MANIFESTS.has(b) || /\.(csproj|fsproj|vbproj)$/.test(b) || /^requirements.*\.txt$/.test(b); };

// ---------------------------------------------------------------------------------------------------- the contract

/** The narrative of `text` with the RUN-STATE block (markers included) removed. */
function narrativeOf(text) {
  const b = text.indexOf(BEGIN), e = text.indexOf(END);
  return b >= 0 && e > b ? text.slice(0, b) + text.slice(e + END.length) : text;
}

/** Validate a contract object's fields; refuses scope_contract_invalid / supporting_overlaps_planned. Returns it. */
export function validateContract(c) {
  const invalid = (why) => refuse('scope_contract_invalid', why);
  if (c.v !== 1) invalid('v must be 1');
  if (c.mode !== 'engine' && c.mode !== 'manual') invalid('mode must be "engine" or "manual"');
  if (c.mode === 'engine' ? !(typeof c.dag === 'string' && DIGEST.test(c.dag)) : c.dag !== null) invalid('dag must be sha256:<64 hex> in engine mode and null in manual mode');
  const list = (name, max) => {
    const v = c[name];
    if (!Array.isArray(v) || v.length > max || !v.every(e => typeof e === 'string')) invalid(`${name} must be an array of at most ${max} strings`);
    if (new Set(v).size !== v.length) invalid(`${name} holds a duplicate entry`);
    for (const e of v) {
      if (e.length > 256 || CONTROL.test(e) || !normalRel(e)) invalid(`${name} entry ${JSON.stringify(e)} is not a normalized repository path (no trailing slash, no . or .., no backslash, no control character)`);
    }
    return v;
  };
  const planned = list('planned', 64), supporting = list('supporting', 16);
  if (c.mode === 'manual' && !planned.length) invalid('a manual-mode contract plans at least one path');
  for (const p of planned) {
    if (c.mode === 'manual' && /[*?[\]{}]/.test(p)) invalid(`manual-mode planned entry ${JSON.stringify(p)} carries glob syntax (literal paths only)`);
    if (/^\*+$/.test(p.split('/')[0])) invalid(`planned entry ${JSON.stringify(p)} has a wildcard-only first segment`);
  }
  for (const s of supporting) {
    const segs = s.split('/');
    if (/[*?[\]{}]/.test(s)) invalid(`supporting entry ${JSON.stringify(s)} carries glob syntax`);
    if (!SUPPORTING_SEGMENTS.includes(segs.at(-1))) invalid(`supporting entry ${JSON.stringify(s)} must end in one of ${SUPPORTING_SEGMENTS.join(', ')}`);
    if (segs.some(x => FORBIDDEN_SEGMENTS.includes(x))) invalid(`supporting entry ${JSON.stringify(s)} lies under ${FORBIDDEN_SEGMENTS.join(', ')}`);
    if (isManifest(s)) invalid(`supporting entry ${JSON.stringify(s)} is a manifest`);
    const match = c.mode === 'engine' ? engineMatcher(planned) : literalMatcher(planned);
    for (const p of planned) {
      const segsP = p.split('/'), firstGlob = segsP.findIndex(hasGlob);
      const prefix = firstGlob < 0 ? p : segsP.slice(0, firstGlob).join('/');
      if (overlap(s, p) || (prefix && overlap(s, prefix)) || match(s)) refuse('supporting_overlaps_planned', `supporting entry ${JSON.stringify(s)} overlaps planned entry ${JSON.stringify(p)}`);
    }
  }
  return c;
}

/** The plan's one `scope-contract:` line, parsed, canonical and validated; refuses (exit 2) otherwise. */
export function parseContract(text) {
  const lines = narrativeOf(text).split('\n');
  const found = lines.filter(l => l.startsWith(KEY));
  const mentions = lines.filter(l => !l.startsWith(KEY) && /scope-contract/i.test(l));
  if (mentions.length || found.length > 1) refuse('scope_contract_ambiguous', `the plan must hold exactly one scope-contract line and mention the key nowhere else (${found.length} line(s), ${mentions.length} other mention(s))`);
  if (!found.length) refuse('scope_contract_missing', 'the plan has no `scope-contract: {...}` line');
  const line = found[0];
  if (Buffer.byteLength(line) > 8192) refuse('scope_contract_noncanonical', 'the scope-contract line exceeds 8 KiB');
  const json = line.slice(KEY.length);
  let c;
  try { c = JSON.parse(json); } catch { refuse('scope_contract_noncanonical', 'the scope-contract value is not JSON'); }
  if (c === null || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).join(',') !== KEYS || JSON.stringify(c) !== json) {
    refuse('scope_contract_noncanonical', `the scope-contract value must be canonical JSON with keys ${KEYS} in that order (no whitespace, escapes or extra keys)`);
  }
  return validateContract(c);
}

/** The canonical contract line for `c` (keys in order, arrays sorted), validated. */
export function contractLine(c) {
  const line = KEY + JSON.stringify({ v: 1, mode: c.mode, dag: c.dag, planned: [...c.planned].sort(), supporting: [...c.supporting].sort() });
  parseContract(line);
  return line;
}

// ---------------------------------------------------------------------------------------------------- classification

/** Where a symlink at repo path `p` with link text `target` points, repo-relative, or null when outside the repository. */
function linkTarget(p, target) {
  const t = String(target).replace(/\\/g, '/');
  if (posix.isAbsolute(t) || win32.isAbsolute(target)) return null;
  const n = posix.normalize(posix.join(posix.dirname(p), t));
  return n === '..' || n.startsWith('../') ? null : n.replace(/\/$/, '');
}

/**
 * Classify candidate entries [{ path, kind }] against a contract's mode, planned and supporting entries (see the
 * header for the rules). `readlink(path)` returns a symlink's link text. Returns [{ path, kind, class, via, flags }].
 */
export function classify(entries, { mode, planned, supporting, readlink }) {
  const make = mode === 'engine' ? engineMatcher : literalMatcher;
  const match = make(planned), lower = make(planned.map(p => p.toLowerCase()));
  const supportMatch = literalMatcher(supporting);
  return entries.map(({ path, kind }) => {
    const flags = [];
    if (kind === 'symlink') {
      flags.push('symlink');
      let target = null;
      try { target = linkTarget(path, readlink(path)); } catch { /* unreadable: outside */ }
      if (target === null || LINE_TERMINATOR.test(target) || !(match(target) || supportMatch(target))) flags.push('symlink_target_outside_contract');
    }
    if (kind === 'submodule') flags.push('submodule');
    if (kind === 'deleted') flags.push('deleted');
    const manifest = isManifest(path);
    if (manifest) flags.push('dependency_manifest');
    let cls = 'material', via = null;
    const root = LINE_TERMINATOR.test(path) ? undefined : planned.includes(path) ? path : match(path);
    const support = root === undefined && !LINE_TERMINATOR.test(path) ? supportMatch(path) : undefined;
    if (LINE_TERMINATOR.test(path)) flags.push('line_terminator');
    else if (root === path) { cls = 'planned'; via = 'exact'; }
    else if (root !== undefined) {
      cls = 'planned'; via = mode === 'engine' && hasGlob(root) ? 'glob' : 'directory';
      flags.push('unlisted_under_directory_write');
      if (!root.includes('/')) flags.push('broad_planned');
    } else if (support !== undefined) {
      if (kind === 'file' && !manifest) {
        if (support.split('/').at(-1) === 'docs' && DOCS_EXECUTABLE.test(path)) flags.push('docs_executable');
        else { cls = 'supporting'; via = 'supporting'; }
      }
    } else if (lower(path.toLowerCase())) flags.push('case_alias');
    return { path, kind, class: cls, via, flags };
  });
}

// ---------------------------------------------------------------------------------------------------- git and files

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('git_failed', `git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}
/** NUL-separated git output, split (no trim: a path may start or end with a space). */
function gitZ(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('git_failed', `git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}
/** candidate-id.mjs's kinds for a work-tree path: symlink, file, submodule (a directory) or deleted. */
function kindOf(abs) {
  try { const st = lstatSync(abs); return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'submodule' : 'file'; } catch { return 'deleted'; }
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

/** A DAG file's digest and validated document; refuses dag_invalid. */
function readDag(dagFile, ticket) {
  let raw, doc;
  try { raw = readFileSync(dagFile); } catch (e) { refuse('dag_invalid', `${dagFile}: ${e.code ?? e.message}`); }
  try { doc = JSON.parse(raw); } catch { refuse('dag_invalid', 'the DAG is not JSON'); }
  let dag;
  try { dag = validateEngineDag(doc, ticket ? { ticket } : {}); } catch (e) { refuse('dag_invalid', e.message); }
  return { digest: sha(raw), writes: [...new Set(dag.nodes.flatMap(n => n.writes))].sort() };
}

/** The mode checks of the contract `c` (see the header); refuses dag_required, dag_unbound, contract_* or manual_with_engine_evidence. */
function bindMode(c, { repo, ticket, runId, events, dag }) {
  const bound = events.filter(e => e.event === 'DAG_BOUND' && e.run_id === runId);
  if (c.mode === 'manual') {
    if (dag !== undefined) refuse('contract_mode_mismatch', 'the approved contract is manual mode; --dag is for an engine-mode contract');
    const base = `ai-skills/ship-ticket/${ticket}`;
    const evidence = bound.length ? 'a DAG_BOUND of this run' : existsSync(gitPath(repo, `${base}.state.json`)) ? `${base}.state.json`
      : existsSync(gitPath(repo, `${base}.engine.jsonl`)) ? `${base}.engine.jsonl` : null;
    if (evidence) refuse('manual_with_engine_evidence', `the contract is manual mode but ${evidence} exists; an engine run needs an engine-mode contract (re-approve through ExitPlanMode)`);
    return;
  }
  if (dag === undefined) refuse('dag_required', 'the approved contract is engine mode: pass the bound DAG with --dag (a failed engine init does not make a run manual)');
  const d = readDag(dag, ticket);
  if (d.digest !== c.dag) refuse('dag_unbound', `the --dag file is ${d.digest}, the approved contract names ${c.dag}`);
  if (bound.length && !(bound.length === 1 && normDigest(bound[0].dag_digest) === d.digest)) refuse('dag_unbound', 'the run has DAG_BOUND events but not exactly one naming this DAG');
  const planned = [...new Set(c.planned)].sort();
  if (planned.join('\0') !== d.writes.join('\0')) refuse('contract_dag_mismatch', `planned ${JSON.stringify(planned)} differs from the DAG writes ${JSON.stringify(d.writes)}`);
}

// ---------------------------------------------------------------------------------------------------- the check

/** Run the check; returns { exit, record, text } or throws a Refusal (exit 2 or 3). Writes nothing itself. */
export function checkScope({ repo, ticket, runId, base, plan, dag }) {
  if (!SAFE_ID.test(ticket ?? '')) refuse('bad_input', `unsafe --ticket ${JSON.stringify(ticket)}`);
  if (!SAFE_ID.test(runId ?? '')) refuse('bad_input', `unsafe --run-id ${JSON.stringify(runId)}`);
  if (typeof base !== 'string' || !base || base.startsWith('-')) refuse('bad_input', `refused ref: ${base}`);
  const approved = approvedPlan(plan, runId);
  const c = parseContract(approved.text);
  bindMode(c, { repo, ticket, runId, events: approved.events, dag });
  const exclusions = [`.specs/plans/${ticket}.md`, 'session-log.md'];
  const r = spawnSync(process.execPath, [CANDIDATE_CLI, '--repo', repo, '--base', base, ...exclusions.flatMap(x => ['--exclude', x])],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) gitFail('candidate_id_failed', `candidate-id: ${(r.stderr || r.error?.message || 'failed').trim()}`);
  let cand;
  try { cand = JSON.parse(r.stdout); } catch { gitFail('candidate_id_failed', 'candidate-id printed no JSON'); }
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  const files = classify(cand.paths.map(p => ({ path: p.path, kind: p.kind })), { mode: c.mode, planned: c.planned, supporting: c.supporting, readlink: (p) => readlinkSync(join(top, p)) });
  // candidate-id excludes by prefix, so a path below an exclusion FILE (session-log.md/x, the plan path used as a
  // directory) is missing from its set; enumerate the same way (tracked diff + untracked, non-ignored) and flag it.
  const changed = [...gitZ(top, ['diff', '--name-only', '-z', '--no-renames', cand.merge_base, '--']),
    ...gitZ(top, ['ls-files', '--others', '--exclude-standard', '-z', '--'])];
  for (const path of [...new Set(changed.filter(p => exclusions.some(x => p.startsWith(x + '/'))))].sort()) {
    const kind = kindOf(join(top, path));
    files.push({ path, kind, class: 'material', via: null, flags: ['under_exclusion_file', ...(kind === 'file' ? [] : [kind])] });
  }
  const count = (k) => files.filter(f => f.class === k).length;
  const counts = { planned: count('planned'), supporting: count('supporting'), material: count('material'), total: files.length };
  const record = { schema: SCHEMA, ticket, run_id: runId, base, merge_base: cand.merge_base, candidate_id: cand.candidate_id,
    approved_plan_digest: approved.digest, mode: c.mode, dag_digest: c.dag, roots: [...c.planned].sort(), supporting: [...c.supporting].sort(),
    broad_planned: c.planned.filter(p => !p.includes('/')).sort(), exclusions, files, counts, outcome: counts.material ? 'MATERIAL' : 'CLEAN' };
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

/** Parse `--flag value` pairs; `repeat` names flags that may repeat (collected into arrays). Returns null on a bad argument. */
function flags(rest, allowed, repeat = []) {
  const f = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.startsWith('--') ? rest[i].slice(2) : null;
    if (!allowed.includes(k) || rest[i + 1] === undefined) return null;
    if (repeat.includes(k)) (f[k] ??= []).push(rest[i + 1]);
    else if (Object.hasOwn(f, k)) return null;
    else f[k] = rest[i + 1];
  }
  return f;
}

function contractCommand(rest) {
  const f = flags(rest, ['mode', 'dag', 'planned', 'supporting'], ['planned', 'supporting']);
  if (!f || !['engine', 'manual'].includes(f.mode) || (f.mode === 'engine') !== (f.dag !== undefined)) { process.stderr.write(USAGE + '\n'); return 2; }
  const d = f.dag === undefined ? null : readDag(resolve(f.dag));
  process.stdout.write(contractLine({ mode: f.mode, dag: d?.digest ?? null, planned: f.planned ?? d?.writes ?? [], supporting: f.supporting ?? [] }) + '\n');
  return 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'contract') return contractCommand(rest);
    const f = cmd === 'check' ? flags(rest, ['repo', 'ticket', 'run-id', 'base', 'plan', 'dag', 'out']) : null;
    if (!f || !f.repo || !f.ticket || !f['run-id'] || !f.base || !f.plan) { process.stderr.write(USAGE + '\n'); return 2; }
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
