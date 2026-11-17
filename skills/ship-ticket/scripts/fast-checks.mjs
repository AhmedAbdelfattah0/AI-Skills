#!/usr/bin/env node
/**
 * T0 fast checks (ASTF-41, S-01a): deterministic, cheap checks a builder runs on the WORKING TREE before it
 * hands over. T0 is fast feedback, not proof: it does not establish semantic correctness.
 *
 *   fast-checks.mjs run    --repo <path> [--base <ref>] [--ticket <key> --run-id <id>]
 *   fast-checks.mjs verify --repo <path> --report-file <file with the worker's final message>
 *
 * The repository declares its checks in `<repo>/.ship-ticket/t0.json` (opt-in; absent = not declared, and
 * nothing changes: exit 0, code `not_declared`):
 *   {"checks":[{"name":"secrets","kind":"secrets","cmd":["gitleaks","dir","--no-banner","{files}"],
 *               "files":true,"timeout_ms":120000}]}
 * `cmd` is an argv array (never a shell string). `{files}` (required when `files` is true) expands to one argv
 * entry per file in the scan set. `kind` is one of KINDS. This module ships NO scanner: the scanners are the
 * repository's own.
 *
 * The scan set is owned here: tracked changes against HEAD (staged and unstaged; a rename contributes its new
 * path), plus every untracked non-ignored file individually, plus, with `--base`, the committed range
 * base..HEAD. There is no way to narrow it to committed files only. Deleted and non-regular paths are dropped.
 *
 * Anything but a clean exit 0 is a FAIL: non-zero exit, timeout, signal, spawn error, invalid or empty
 * declaration, an unreadable file set. The verdict JSON holds enums, names and numbers only, never scanner
 * output (a secrets scanner echoes the secret); a failing check's output tail goes to stderr for the builder.
 * Exit: 0 pass or not_declared, 1 fail/refused, 2 usage.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** `{declared:false}` when the repo has no declaration file; else `{declared:true, checks}`. Throws `t0Config` when invalid. */
export function loadDeclaration(repo) {
  const path = join(repo, DECLARATION_PATH);
  if (!existsSync(path)) return { declared: false };
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw refuse(`${DECLARATION_PATH} is not valid JSON`); }
  return { declared: true, ...validateDeclaration(parsed) };
}

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const zList = (out) => out.split('\0').filter(Boolean);

/**
 * The scan set: tracked changes vs HEAD (index and worktree), untracked non-ignored files one by one, and with
 * `base` the committed range. Renames are listed by their new path (rename detection is off, so the old path is a
 * deletion and is dropped). Only existing regular files remain. Throws when git cannot answer.
 */
export function scanSet(repo, base = null) {
  const found = new Set(zList(git(repo, ['diff', '-z', '--name-only', '--no-renames', 'HEAD', '--'])));
  for (const p of zList(git(repo, ['ls-files', '-z', '--others', '--exclude-standard']))) found.add(p);
  if (base) for (const p of zList(git(repo, ['diff', '-z', '--name-only', '--no-renames', base, 'HEAD', '--']))) found.add(p);
  return [...found].filter((p) => { try { return lstatSync(join(repo, p)).isFile(); } catch { return false; } }).sort();
}

function tail(fd) {
  const size = fstatSync(fd).size;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  if (len > 0) readSync(fd, buf, 0, len, size - len);
  return buf.toString('utf8');
}

/** Run one declared check. Output goes to a temp FILE (a killed child's grandchildren cannot hold a pipe open). */
function runOne(repo, check, files) {
  const out = { name: check.name, kind: check.kind, result: 'fail', exit: null, timed_out: false, skipped: false, duration_ms: 0, files: 0 };
  let args = check.cmd.slice(1);
  if (check.files) {
    if (files.length === 0) return { ...out, result: 'skipped', skipped: true };
    args = args.flatMap((a) => (a === '{files}' ? files.map((f) => (f.startsWith('-') ? `./${f}` : f)) : [a]));
    out.files = files.length;
  }
  const dir = mkdtempSync(join(tmpdir(), 't0-'));
  const fd = openSync(join(dir, 'out'), 'w+');
  const started = Date.now();
  let r;
  try {
    r = spawnSync(check.cmd[0], args, { cwd: repo, stdio: ['ignore', fd, fd], timeout: check.timeout_ms, killSignal: 'SIGKILL', windowsHide: true });
    out.duration_ms = Date.now() - started;
    out.exit = Number.isInteger(r.status) ? r.status : null;
    out.timed_out = r.error?.code === 'ETIMEDOUT';
    out.result = !r.error && r.status === 0 && !r.signal ? 'pass' : 'fail';
    if (out.result === 'fail') out.output_tail = tail(fd);
  } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  return out;
}

/**
 * Run T0 on the working tree. Returns `{declared, result:'pass'|'fail'|'not_declared', code, checks, files, report}`.
 * `report` is the ready-to-paste worker-report `t0` value (enums and names only).
 */
export function runFastChecks({ repo, base = null }) {
  let decl;
  try { decl = loadDeclaration(repo); } catch (e) {
    if (!e.t0Config) throw e;
    return { declared: true, result: 'fail', code: 't0_config_invalid', reason: e.message, checks: [], files: 0, report: null };
  }
  if (!decl.declared) return { declared: false, result: 'not_declared', code: 'not_declared', checks: [], files: 0, report: null };
  let files;
  try { files = scanSet(repo, base); } catch (e) {
    return { declared: true, result: 'fail', code: 'file_set_unavailable', checks: [], files: 0, report: null };
  }
  const checks = decl.checks.map((c) => runOne(repo, c, files));
  const failed = checks.some((c) => c.result === 'fail');
  const ranAny = checks.some((c) => c.result === 'pass');
  const result = !failed && (ranAny || files.length === 0) ? 'pass' : 'fail';
  const report = { result, checks: checks.map((c) => ({ name: c.name, result: c.result === 'pass' || c.result === 'skipped' ? 'pass' : 'fail' })) };
  return { declared: true, result, code: result === 'pass' ? 'ok' : 't0_failed', checks, files: files.length, report };
}

/** Orchestrator check of a worker message against the repo's declaration (AC1). */
export function verifyReport({ repo, text }) {
  let decl;
  try { decl = loadDeclaration(repo); } catch (e) { if (e.t0Config) return { ok: false, code: 't0_config_invalid', reason: e.message }; throw e; }
  if (!decl.declared) return { ok: true, code: 'not_declared' };
  const parsed = parseWorkerReport(text, { t0Declared: true });
  if (parsed.status !== 'structured') return { ok: false, code: parsed.failure.startsWith('fast_check_') ? parsed.failure.split(':')[0] : 'report_unstructured', reason: parsed.failure };
  const t0 = parsed.report.t0;
  const declaredNames = decl.checks.map((c) => c.name).sort();
  const reportedNames = t0.checks.map((c) => c.name).sort();
  if (JSON.stringify(declaredNames) !== JSON.stringify(reportedNames)) return { ok: false, code: 'fast_check_incomplete', reason: `declared [${declaredNames}] reported [${reportedNames}]` };
  if (t0.result !== 'pass' || t0.checks.some((c) => c.result !== 'pass')) return { ok: false, code: 'fast_check_failed' };
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

export function main(argv) {
  const [cmd, ...rest] = argv;
  const usage = () => { process.stderr.write('Usage: fast-checks.mjs run --repo <path> [--base <ref>] [--ticket <key> --run-id <id>] | verify --repo <path> --report-file <file>\n'); return 2; };
  if (cmd === 'run') {
    const f = parseFlags(rest, ['repo', 'base', 'ticket', 'run-id']);
    if (!f || !f.repo || (f.ticket === undefined) !== (f['run-id'] === undefined)) return usage();
    const repo = resolve(f.repo);
    const eventId = 't0-' + randomBytes(4).toString('hex');
    if (f.ticket) logActivity(repo, f.ticket, f['run-id'], 'start', { eventId, args: [] });
    const r = runFastChecks({ repo, base: f.base ?? null });
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
    const f = parseFlags(rest, ['repo', 'report-file']);
    if (!f || !f.repo || !f['report-file']) return usage();
    let text;
    try { text = readFileSync(f['report-file'], 'utf8'); } catch { process.stderr.write('fast-checks: cannot read --report-file\n'); return 1; }
    const v = verifyReport({ repo: resolve(f.repo), text });
    process.stdout.write(JSON.stringify(v) + '\n');
    return v.ok ? 0 : 1;
  }
  return usage();
}

if (isEntrypoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
