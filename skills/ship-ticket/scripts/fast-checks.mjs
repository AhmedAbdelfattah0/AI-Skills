#!/usr/bin/env node
/**
 * T0 fast checks (ASTF-41, S-01a): deterministic, cheap checks a builder runs on the WORKING TREE before it
 * hands over. T0 is fast feedback, not proof: it does not establish semantic correctness.
 *
 *   fast-checks.mjs run    --repo <path> --base <ref> [--ticket <key> --run-id <id>]
 *   fast-checks.mjs verify --repo <path> --base <ref> --report-file <file with the worker's final message>
 *
 * The repository declares its checks in `.ship-ticket/t0.json` (opt-in), read from the TRUSTED `--base` commit and never
 * from the working tree being checked. `--base` is required. The working-tree copy must equal the base copy
 * (`declaration_tampered` otherwise); a declaration that exists only on the branch is ignored (`not_declared`). The file
 * is authored and reviewed like CI configuration by someone with authority over the repository; its commands run with
 * the caller's environment and permissions (argv exec prevents shell injection, it is not a trust boundary).
 *   {"checks":[{"name":"secrets","kind":"secrets","cmd":["gitleaks","dir","--no-banner","{files}"],
 *               "files":true,"timeout_ms":120000}]}
 * `cmd` is an argv array (never a shell string). `{files}` (required when `files` is true) expands to one argv
 * entry per file in the scan set. `kind` is one of KINDS. This module ships NO scanner: the scanners are the
 * repository's own. A check whose own command path is among the changed files fails (`checker_modified`).
 *
 * The scan set is owned here (see `prepare`): everything whose working-tree state differs from base (committed, staged,
 * unstaged), every untracked non-ignored file, a rename under its new path; deleted files are dropped. `--repo` may be a
 * subdirectory of the git top level. A submodule, nested repository, symlink or unresolvable path is a failure
 * (`unsupported_changed_surface`, `unresolvable_path`), never a silent drop, as is an assume-unchanged or
 * skip-worktree bit (`index_flags_hidden`). Git-ignored files are out of scope. The index is not scanned separately:
 * a staged secret whose working copy was cleaned is not seen.
 *
 * Anything but a clean exit 0 is a FAIL: non-zero exit, timeout, signal, spawn error, invalid or empty
 * declaration, an unreadable file set. The verdict JSON holds enums, names and numbers only, never scanner
 * output (a secrets scanner echoes the secret); a failing check's output tail goes to stderr for the builder.
 * Each check runs in its own process group, killed on timeout (Windows: `taskkill /T`, tree state not observable).
 * A declared command must itself exit non-zero on a finding (eslint warnings and `--exit-code 0` scanners pass T0); on Windows
 * a `.cmd` shim needs its real executable; a very large file list can exceed the OS argument limit (fails closed).
 * Exit: 0 pass or not_declared, 1 fail/refused, 2 usage.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './harness.mjs';
import { parseWorkerReport } from './worker-report.mjs';

export const KINDS = ['lint', 'typecheck', 'nn-guard', 'secrets', 'security', 'other'];
export const DECLARATION_PATH = '.ship-ticket/t0.json';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 1800000;
const MIN_TIMEOUT_MS = 100;
const TAIL_BYTES = 4000;

const refuse = (message) => Object.assign(new Error(message), { t0Config: true });

/** Validate a parsed declaration. Returns `{checks}` normalised; throws a `t0Config` error naming the problem. */
export function validateDeclaration(decl) {
  if (!decl || typeof decl !== 'object' || Array.isArray(decl) || !Array.isArray(decl.checks)) throw refuse('declaration must be {"checks":[...]}');
  if (decl.checks.length === 0) throw refuse('declaration has no checks (an empty declared list is a failure, not a pass)');
  const names = new Set();
  const checks = decl.checks.map((c, i) => {
    const at = `checks[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw refuse(`${at} must be an object`);
    if (typeof c.name !== 'string' || !SAFE_NAME.test(c.name)) throw refuse(`${at}.name must match ${SAFE_NAME}`);
    if (names.has(c.name)) throw refuse(`${at}.name "${c.name}" is repeated`);
    names.add(c.name);
    if (!KINDS.includes(c.kind)) throw refuse(`${at}.kind must be one of: ${KINDS.join(', ')}`);
    if (!Array.isArray(c.cmd) || c.cmd.length === 0 || !c.cmd.every((a) => typeof a === 'string' && a.length > 0)) throw refuse(`${at}.cmd must be a non-empty array of non-empty strings (an argv, not a shell string)`);
    const files = c.files === true;
    if (c.files !== undefined && typeof c.files !== 'boolean') throw refuse(`${at}.files must be a boolean`);
    if (files && !c.cmd.includes('{files}')) throw refuse(`${at}.cmd must contain the {files} argument when files is true`);
    if (!files && c.cmd.includes('{files}')) throw refuse(`${at}.cmd contains {files} but files is not true`);
    const timeout = c.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : c.timeout_ms;
    if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) throw refuse(`${at}.timeout_ms must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`);
    return { name: c.name, kind: c.kind, cmd: [...c.cmd], files, timeout_ms: timeout };
  });
  return { checks };
}

const GIT_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];
const gitEnv = () => { const e = { ...process.env }; for (const k of GIT_ENV_DROP) delete e[k]; return e; };
const gitRaw = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv(), maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, args) => gitRaw(cwd, args).toString('utf8');
const zList = (out) => out.split('\0').filter(Boolean);
const stop = (code, reason) => ({ stop: { code, reason } });

/**
 * Everything T0 needs before running a command, all read from git, none of it trusted from the tree under test:
 *  - the declaration comes from `--base` (the trusted commit). The working-tree copy must be byte-identical to it
 *    (deleted, edited, replaced by a link: `declaration_tampered`); a declaration only the branch has is ignored
 *    (`not_declared`), since the branch is the thing being checked;
 *  - the scan set is every path whose working-tree state differs from base (committed, staged, unstaged) plus every
 *    untracked non-ignored file, resolved against the git top level so `--repo` may be a subdirectory.
 * Anything git lists that cannot be scanned as a regular file (submodule, nested repository, symlink, a path that
 * cannot be resolved) or that git is told to ignore (assume-unchanged / skip-worktree bits) is a stop, never a drop.
 * Returns `{stop:{code,reason}}` or `{top, repoReal, decl|null, changed:[top-relative], files:[repo-relative args]}`.
 */
export function prepare(repo, base) {
  if (typeof base !== 'string' || !base || base.startsWith('-')) return stop('base_invalid', '--base must be a commit-ish that does not start with "-"');
  let top; let prefix; let sha; let repoReal;
  try {
    repoReal = realpathSync(repo);
    top = realpathSync(git(repoReal, ['rev-parse', '--show-toplevel']).trim());
    prefix = git(repoReal, ['rev-parse', '--show-prefix']).trim();
    sha = git(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', base + '^{commit}']).trim();
  } catch { return stop(top ? 'base_invalid' : 'file_set_unavailable', 'git could not resolve the repository or --base'); }
  const declPath = prefix + DECLARATION_PATH;
  let decl = null;
  try {
    const entry = git(top, ['ls-tree', '-z', sha, '--', declPath]);
    if (entry) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
      if (!m || m[2] !== 'blob' || !/^100(644|755)$/.test(m[1])) return stop('t0_config_invalid', 'the base declaration is not a regular file');
      const baseBytes = gitRaw(top, ['cat-file', 'blob', m[3]]);
      let treeBytes = null;
      try { if (lstatSync(join(repoReal, DECLARATION_PATH)).isFile()) treeBytes = readFileSync(join(repoReal, DECLARATION_PATH)); } catch { /* missing */ }
      if (!treeBytes || !treeBytes.equals(baseBytes)) return stop('declaration_tampered', `${DECLARATION_PATH} differs from its content at --base (deleted, edited or replaced); the declaration is only read from base`);
      try { decl = validateDeclaration(JSON.parse(baseBytes.toString('utf8'))); } catch (e) { return stop('t0_config_invalid', e.t0Config ? e.message : `${DECLARATION_PATH} at base is not valid JSON`); }
    }
  } catch { return stop('file_set_unavailable', 'git could not read the declaration at --base'); }
  let changed;
  try {
    for (const rec of zList(git(top, ['ls-files', '-v', '-z']))) if (/^[a-zS] /.test(rec)) return stop('index_flags_hidden', 'a tracked file carries an assume-unchanged or skip-worktree bit, which hides edits from git');
    const found = new Set(zList(git(top, ['diff', '-z', '--name-only', '--no-renames', '--ignore-submodules=none', '--diff-filter=d', sha, '--'])));
    for (const p of zList(git(top, ['ls-files', '-z', '--others', '--exclude-standard']))) found.add(p);
    changed = [...found].sort();
  } catch { return stop('file_set_unavailable', 'git could not list the changed files'); }
  for (const p of changed) {
    let st;
    try { st = lstatSync(join(top, p)); } catch { return stop('unresolvable_path', 'a changed path could not be resolved on disk (not silently dropped)'); }
    if (!st.isFile()) return stop('unsupported_changed_surface', 'a changed path is a submodule, nested repository, directory or symlink, which T0 cannot scan');
  }
  const files = changed.map((p) => { const r = relative(repoReal, join(top, p)).split(sep).join('/'); return r.startsWith('-') ? `./${r}` : r; });
  return { top, repoReal, decl, changed, files };
}

/** Kill `child`'s whole tree: POSIX process group, Windows `taskkill /T /F` (the limit: the tree is not observable afterwards). */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); return; }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ }
}

/** Run one declared check in its own process group. Output goes to a temp FILE; the group is killed on timeout and after exit. */
function runOne(cwd, check, prep) {
  const base = { name: check.name, kind: check.kind, result: 'fail', exit: null, timed_out: false, duration_ms: 0, files: 0 };
  let args = check.cmd.slice(1);
  if (check.files) {
    if (prep.files.length === 0) return Promise.resolve({ ...base, result: 'skipped' });
    args = args.flatMap((a) => (a === '{files}' ? prep.files : [a]));
    base.files = prep.files.length;
  }
  const touched = check.cmd.filter((a) => a !== '{files}').some((a) => {
    const abs = resolve(cwd, a);
    const rel = relative(prep.top, abs).split(sep).join('/');
    return !rel.startsWith('..') && prep.changed.includes(rel);
  });
  if (touched) return Promise.resolve({ ...base, code: 'checker_modified' });
  const dir = mkdtempSync(join(tmpdir(), 't0-'));
  const fd = openSync(join(dir, 'out'), 'w+');
  const started = Date.now();
  return new Promise((done) => {
    let settled = false;
    let child;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) killTree(child);
      const out = { ...base, duration_ms: Date.now() - started, ...extra };
      if (out.result === 'fail') { try { out.output_tail = tail(fd); } catch { /* no tail */ } }
      try { closeSync(fd); } catch { /* closed */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
      done(out);
    };
    let timer;
    try { child = spawn(check.cmd[0], args, { cwd, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', windowsHide: true }); } catch { return finish({}); }
    timer = setTimeout(() => finish({ timed_out: true }), check.timeout_ms);
    child.on('error', () => finish({}));
    child.on('exit', (code, signal) => finish({ exit: code, result: code === 0 && !signal ? 'pass' : 'fail' }));
  });
}

function tail(fd) {
  const size = fstatSync(fd).size;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  if (len > 0) readSync(fd, buf, 0, len, size - len);
  return buf.toString('utf8');
}

const stopped = (s) => ({ declared: true, result: 'fail', code: s.stop.code, reason: s.stop.reason, checks: [], files: 0, report: null });

/**
 * Run T0 on the working tree against the trusted `base`. Returns `{declared, result:'pass'|'fail'|'not_declared', code,
 * checks, files, report}`; `report` is the ready-to-paste worker-report `t0` value (names and enums only).
 */
export async function runFastChecks({ repo, base = null }) {
  const prep = prepare(repo, base);
  if (prep.stop) return stopped(prep);
  if (!prep.decl) return { declared: false, result: 'not_declared', code: 'not_declared', checks: [], files: 0, report: null };
  const checks = [];
  for (const c of prep.decl.checks) checks.push(await runOne(prep.repoReal, c, prep));
  const failed = checks.some((c) => c.result === 'fail');
  const result = failed ? 'fail' : 'pass';
  const report = { result, checks: checks.map((c) => ({ name: c.name, result: c.result })) };
  return { declared: true, result, code: result === 'pass' ? 'ok' : 't0_failed', checks, files: prep.files.length, report };
}

/** Orchestrator check of a worker message against the BASE declaration and the current tree (AC1). Codes only: no worker text is echoed. */
export function verifyReport({ repo, base, text }) {
  const prep = prepare(repo, base);
  if (prep.stop) return { ok: false, code: prep.stop.code };
  if (!prep.decl) return { ok: true, code: 'not_declared' };
  const parsed = parseWorkerReport(text, { t0Declared: true });
  if (parsed.status !== 'structured') return { ok: false, code: parsed.failure.startsWith('fast_check_') ? parsed.failure.split(':')[0] : 'report_unstructured' };
  const t0 = parsed.report.t0;
  if (!t0.checks.every((c) => SAFE_NAME.test(c.name))) return { ok: false, code: 'fast_check_invalid' };
  const declaredNames = prep.decl.checks.map((c) => c.name).sort();
  const reportedNames = t0.checks.map((c) => c.name).sort();
  if (JSON.stringify(declaredNames) !== JSON.stringify(reportedNames)) return { ok: false, code: 'fast_check_incomplete' };
  if (t0.result !== 'pass' || t0.checks.some((c) => c.result === 'fail')) return { ok: false, code: 'fast_check_failed' };
  if (prep.files.length > 0 && t0.checks.some((c) => c.result === 'skipped')) return { ok: false, code: 'fast_check_skipped' };
  return { ok: true, code: 'ok' };
}

const RUN_LOG = fileURLToPath(new URL('./run-log.mjs', import.meta.url));
function logActivity(repo, ticket, runId, phase, extra) {
  const r = spawnSync(process.execPath, [RUN_LOG, phase, '--repo', repo, '--ticket', ticket, '--run-id', runId, '--kind', 'activity', '--name', 't0_check', '--event-id', extra.eventId, ...extra.args], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) process.stderr.write(`fast-checks: run-log ${phase} not recorded (verdict unchanged): ${String(r.stderr).trim().split('\n')[0]}\n`);
}

function parseFlags(argv, allowed) {
  const f = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !allowed.includes(argv[i].slice(2)) || argv[i + 1] === undefined) return null;
    f[argv[i].slice(2)] = argv[i + 1];
  }
  return f;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const usage = () => { process.stderr.write('Usage: fast-checks.mjs run --repo <path> --base <ref> [--ticket <key> --run-id <id>] | verify --repo <path> --base <ref> --report-file <file>\n'); return 2; };
  if (cmd === 'run') {
    const f = parseFlags(rest, ['repo', 'base', 'ticket', 'run-id']);
    if (!f || !f.repo || !f.base || (f.ticket === undefined) !== (f['run-id'] === undefined)) return usage();
    const repo = resolve(f.repo);
    const eventId = 't0-' + randomBytes(4).toString('hex');
    if (f.ticket) logActivity(repo, f.ticket, f['run-id'], 'start', { eventId, args: [] });
    const r = await runFastChecks({ repo, base: f.base });
    if (f.ticket && r.declared) {
      const failedCount = r.checks.filter((c) => c.result === 'fail').length;
      logActivity(repo, f.ticket, f['run-id'], 'end', { eventId, args: ['--outcome', r.result, '--metric', `checks=${r.checks.length}`, '--metric', `failed=${failedCount}`, '--metric', `files=${r.files}`, '--metric', `timed_out=${r.checks.filter((c) => c.timed_out).length}`] });
    } else if (f.ticket) logActivity(repo, f.ticket, f['run-id'], 'end', { eventId, args: ['--outcome', 'not_declared'] });
    for (const c of r.checks) if (c.result === 'fail' && c.output_tail) process.stderr.write(`--- t0 ${c.name} (exit ${c.exit}${c.timed_out ? ', TIMED OUT' : ''}) output tail ---\n${c.output_tail}\n`);
    if (r.reason) process.stderr.write(`fast-checks: ${r.reason}\n`);
    const verdict = { ...r, checks: r.checks.map(({ output_tail, ...c }) => c) };
    process.stdout.write(JSON.stringify(verdict) + '\n');
    return r.result === 'fail' ? 1 : 0;
  }
  if (cmd === 'verify') {
    const f = parseFlags(rest, ['repo', 'base', 'report-file']);
    if (!f || !f.repo || !f.base || !f['report-file']) return usage();
    let text;
    try { text = readFileSync(f['report-file'], 'utf8'); } catch { process.stderr.write('fast-checks: cannot read --report-file\n'); return 1; }
    const v = verifyReport({ repo: resolve(f.repo), base: f.base, text });
    process.stdout.write(JSON.stringify(v) + '\n');
    return v.ok ? 0 : 1;
  }
  return usage();
}

if (isEntrypoint(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
