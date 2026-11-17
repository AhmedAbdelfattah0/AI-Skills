// T0 fast checks (ASTF-41, S-01a). Scanners here are FAKE node scripts that record the paths they receive;
// the tests assert a positive signal (the path reached the scanner AND the verdict is a fail), never "no error".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseWorkerReport } from './worker-report.mjs';
import { buildBrief, lintBrief } from './brief.mjs';

const CLI = fileURLToPath(new URL('./fast-checks.mjs', import.meta.url));
const RUN_LOG = fileURLToPath(new URL('./run-log.mjs', import.meta.url));
// Assembled at run time so this file itself holds no JWT-shaped literal.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcDEF123456789ghiJKL'].join('.');

const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const put = (repo, rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };

// Fake scanner: argv = [record, mode, ...files]. Appends every received path to `record`; mode 'jwt' fails on a
// JWT-shaped literal, 'echo' also prints the secret, 'sleep' hangs, 'ok' passes.
const SCANNER = `
import { appendFileSync, readFileSync } from 'node:fs';
const [record, mode, ...files] = process.argv.slice(2);
for (const f of files) appendFileSync(record, f + '\\n');
if (mode === 'sleep') setTimeout(() => {}, 60000);
else {
  let bad = false;
  if (mode === 'jwt' || mode === 'echo') for (const f of files) {
    const m = /eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/.exec(readFileSync(f, 'utf8'));
    if (m) { bad = true; if (mode === 'echo') console.log(m[0]); }
  }
  process.exit(bad ? 1 : 0);
}
`;

function fixture(t, checks) {
  const dir = mkdtempSync(join(tmpdir(), 'fastchk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'src/a.spec.ts', 'export const a = 1;\n');
  put(repo, 'src/keep.ts', 'export const k = 1;\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const tools = join(dir, 'tools'); mkdirSync(tools);
  const scanner = join(tools, 'scanner.mjs'); writeFileSync(scanner, SCANNER);
  const record = join(tools, 'record.txt');
  const decl = (mode, extra = {}) => ({ name: 'secrets', kind: 'secrets', cmd: [process.execPath, scanner, record, mode, '{files}'], files: true, ...extra });
  const declare = (c) => { put(repo, '.ship-ticket/t0.json', JSON.stringify({ checks: c })); };
  if (checks) declare(checks(decl));
  const seen = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/')) : []);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'run', '--repo', repo, ...args], { encoding: 'utf8' });
  return { dir, repo, base, decl, declare, seen, run, record };
}
const json = (r) => JSON.parse(r.stdout);

test('no declaration: not_declared, exit 0, nothing spawned (AC8)', (t) => {
  const fx = fixture(t);
  const r = fx.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).code, 'not_declared');
  assert.deepEqual(fx.seen(), []);
});

test('dirty secret: a JWT-shaped literal in an UNCOMMITTED, UNTRACKED spec fails T0 (AC2, D9 replica)', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.repo, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  assert.equal(json(r).result, 'fail');
  assert.ok(fx.seen().includes('src/new.spec.ts'), 'the untracked file reached the scanner: ' + fx.seen());
  assert.ok(!r.stdout.includes(JWT), 'the verdict never carries scanner output');
});

test('dirty secret: modified-unstaged and staged files are scanned too', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.repo, 'src/a.spec.ts', `const t = '${JWT}';\n`);
  put(fx.repo, 'src/staged.ts', 'export const s = 1;\n'); git(fx.repo, 'add', 'src/staged.ts');
  const r = fx.run();
  assert.equal(r.status, 1);
  const seen = fx.seen();
  assert.ok(seen.includes('src/a.spec.ts') && seen.includes('src/staged.ts'), seen.join(','));
});

test('clean working tree with a clean dirty file passes and the file was scanned', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.repo, 'src/new.ts', 'export const n = 1;\n');
  const r = fx.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).result, 'pass');
  assert.ok(fx.seen().includes('src/new.ts'));
  assert.deepEqual(json(r).report, { result: 'pass', checks: [{ name: 'secrets', result: 'pass' }] });
});

test('renamed file is still scanned: staged git mv with an edit, and a committed rename via --base', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  git(fx.repo, 'mv', 'src/a.spec.ts', 'src/b.spec.ts');
  put(fx.repo, 'src/b.spec.ts', `const t = '${JWT}';\n`);
  let r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(fx.seen().includes('src/b.spec.ts'), 'staged rename new path: ' + fx.seen());
  assert.ok(!fx.seen().includes('src/a.spec.ts'), 'the deleted old path is not passed');
  // committed rename: only a --base range can see it
  const fx2 = fixture(t, (d) => [d('jwt')]);
  git(fx2.repo, 'mv', 'src/a.spec.ts', 'src/c.spec.ts');
  put(fx2.repo, 'src/c.spec.ts', `const t = '${JWT}';\n`);
  git(fx2.repo, 'add', '-A'); git(fx2.repo, 'commit', '-q', '-m', 'rename');
  r = fx2.run('--base', fx2.base);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(fx2.seen().includes('src/c.spec.ts'), 'committed rename new path: ' + fx2.seen());
});

test('deleted files are not passed to the scanner', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  unlinkSync(join(fx.repo, 'src/keep.ts'));
  put(fx.repo, 'src/new.ts', 'x\n');
  assert.equal(fx.run().status, 0);
  assert.ok(fx.seen().includes('src/new.ts') && !fx.seen().includes('src/keep.ts'), fx.seen().join(','));
});

test('a timeout is a FAIL, never a PASS, and the hung scanner is killed (Neg)', (t) => {
  const fx = fixture(t, (d) => [d('sleep', { timeout_ms: 400 })]);
  put(fx.repo, 'src/new.ts', 'x\n');
  const started = Date.now();
  const r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  const out = json(r);
  assert.equal(out.result, 'fail');
  assert.equal(out.checks[0].timed_out, true);
  assert.equal(out.checks[0].result, 'fail');
  assert.ok(Date.now() - started < 20000, 'returned promptly');
});

test('spawn error, empty list, malformed declaration and unreadable file set are FAIL, never PASS', (t) => {
  const fx = fixture(t, () => [{ name: 'lint', kind: 'lint', cmd: ['definitely-not-a-real-binary-t0'] }]);
  let r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).result, 'fail');
  for (const bad of [{ checks: [] }, { checks: [{ name: 'x', cmd: 'node a.js' }] }, { checks: [{ name: 'x', kind: 'lint', cmd: ['node'], files: true }] }, 'not json', { checks: [{ name: 'x', kind: 'lint', cmd: ['node'], timeout_ms: 5 }] }]) {
    put(fx.repo, '.ship-ticket/t0.json', typeof bad === 'string' ? bad : JSON.stringify(bad));
    r = fx.run();
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.equal(json(r).result, 'fail');
    assert.equal(json(r).code, 't0_config_invalid');
  }
  const bare = mkdtempSync(join(tmpdir(), 'fastchk-nogit-')); t.after(() => rmSync(bare, { recursive: true, force: true }));
  put(bare, '.ship-ticket/t0.json', JSON.stringify({ checks: [{ name: 'x', kind: 'lint', cmd: [process.execPath, '-e', '0'] }] }));
  r = spawnSync(process.execPath, [CLI, 'run', '--repo', bare], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(json(r).code, 'file_set_unavailable');
});

test('scanner stdout (a secret echo) is never in the verdict JSON', (t) => {
  const fx = fixture(t, (d) => [d('echo')]);
  put(fx.repo, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(JWT));
});

test('run-log: --ticket/--run-id writes a t0_check activity row with outcome and numeric metrics only', (t) => {
  const fx = fixture(t, (d) => [d('echo')]);
  put(fx.repo, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run('--ticket', 'T1', '--run-id', 'run-1');
  assert.equal(r.status, 1, r.stderr);
  const log = join(fx.repo, '.git', 'ai-skills', 'ship-ticket', 'T1.jsonl');
  const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.event, x.kind, x.name]), [['start', 'activity', 't0_check'], ['end', 'activity', 't0_check']]);
  assert.equal(rows[1].outcome, 'fail');
  assert.ok(!readFileSync(log, 'utf8').includes(JWT));
  const s = spawnSync(process.execPath, [RUN_LOG, 'summary', '--repo', fx.repo, '--ticket', 'T1'], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
});

test('run-log failure never changes the verdict', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.repo, 'src/new.ts', 'x\n');
  const r = fx.run('--ticket', 'bad ticket!', '--run-id', 'run-1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).result, 'pass');
});

const BASE = { tests: [{ cmd: 'node --test a', result: 'pass' }], red_seen: [], blockers: [], needs_outside_ownership: [] };
const T0_OK = { result: 'pass', checks: [{ name: 'secrets', result: 'pass' }] };
const fence = (o) => 'Done.\n```ship-ticket-report\n' + JSON.stringify(o) + '\n```\n';

test('parseWorkerReport: default behaviour and failure strings are unchanged (AC8)', () => {
  assert.equal(parseWorkerReport(fence(BASE)).status, 'structured');
  assert.equal(parseWorkerReport(fence({ ...BASE, t0: T0_OK })).failure, 'report keys: missing [] unexpected [t0]');
  assert.equal(parseWorkerReport(fence(BASE), { t0Declared: false }).status, 'structured');
});

test('parseWorkerReport: declared T0 and no t0 key is refused as fast_check_missing (AC1)', () => {
  assert.deepEqual(parseWorkerReport(fence(BASE), { t0Declared: true }), { status: 'unstructured', failure: 'fast_check_missing' });
  const ok = parseWorkerReport(fence({ ...BASE, t0: T0_OK }), { t0Declared: true });
  assert.equal(ok.status, 'structured');
  assert.deepEqual(ok.report.t0, T0_OK);
  for (const bad of [{ result: 'timeout', checks: [] }, { result: 'pass' }, { result: 'pass', checks: [{ name: 'x', result: 'maybe' }] }, 'pass', null]) {
    const r = parseWorkerReport(fence({ ...BASE, t0: bad }), { t0Declared: true });
    assert.equal(r.status, 'unstructured');
    assert.match(r.failure, /^fast_check_invalid/);
  }
});

test('verify: declared repo refuses a report with no t0, a failed t0, or one missing a declared check', (t) => {
  const fx = fixture(t, (d) => [d('jwt'), { name: 'lint', kind: 'lint', cmd: [process.execPath, '-e', '0'] }]);
  const msg = join(fx.dir, 'msg.txt');
  const verify = (o) => { writeFileSync(msg, fence(o)); return spawnSync(process.execPath, [CLI, 'verify', '--repo', fx.repo, '--report-file', msg], { encoding: 'utf8' }); };
  const both = { result: 'pass', checks: [{ name: 'secrets', result: 'pass' }, { name: 'lint', result: 'pass' }] };
  let r = verify(BASE); assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_missing');
  r = verify({ ...BASE, t0: { result: 'fail', checks: [{ name: 'secrets', result: 'fail' }, { name: 'lint', result: 'pass' }] } });
  assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_failed');
  r = verify({ ...BASE, t0: T0_OK }); assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_incomplete');
  r = verify({ ...BASE, t0: { ...both, result: 'pass', checks: [{ name: 'secrets', result: 'pass' }, { name: 'lint', result: 'fail' }] } });
  assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_failed', 'a pass verdict over a failing check is not trusted');
  r = verify({ ...BASE, t0: both }); assert.equal(r.status, 0, r.stdout); assert.equal(json(r).code, 'ok');
  // undeclared repo: nothing demanded
  rmSync(join(fx.repo, '.ship-ticket'), { recursive: true });
  r = verify(BASE); assert.equal(r.status, 0); assert.equal(json(r).code, 'not_declared');
});

const DAG = { schema: 'ship-ticket-engine-dag-v1', nodes: [{ id: 'api', deps: [], writes: ['src/api.js'], othersOwned: [], promptFile: 'p.md' }] };
const PLAN = '# Plan\n\n| ID | Owner | Step | Files touched | Depends on |\n|---|---|---|---|---|\n| `api` | b | s | `src/api.js` | none |\n\n<!-- RUN-STATE:BEGIN -->\n{"event":"START","timestamp":"2026-01-01T00:00:00.000Z"}\n<!-- RUN-STATE:END -->\n';

test('brief: byte-identical when T0 is not declared; declared adds the t0 instruction and still lints', () => {
  const plain = buildBrief({ dag: DAG, nodeId: 'api', planText: PLAN });
  assert.equal(buildBrief({ dag: DAG, nodeId: 'api', planText: PLAN, t0: null }), plain);
  assert.ok(!plain.includes('fast-checks'));
  const withT0 = buildBrief({ dag: DAG, nodeId: 'api', planText: PLAN, t0: { checks: [{ name: 'secrets', kind: 'secrets', cmd: ['x'] }] } });
  assert.match(withT0, /fast-checks\.mjs run/);
  assert.match(withT0, /"t0"/);
  assert.equal(lintBrief(withT0).ok, true, lintBrief(withT0).problems.join(';'));
});
