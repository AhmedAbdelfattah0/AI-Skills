// T0 fast checks (ASTF-41, S-01a). Scanners here are FAKE node scripts that record the paths they receive;
// the tests assert a positive signal (the path reached the scanner AND the verdict is a fail), never "no error".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseWorkerReport } from './worker-report.mjs';
import { buildBrief, lintBrief } from './brief.mjs';
import { killTree, utf8Path, stripNewline } from './fast-checks.mjs';

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

// Real (tiny) checker for the SCRUM-202 patterns: a REPLICA of D9 (JWT-shaped literal) and D15 (`let` never reassigned,
// the word "any" in a comment). It is NOT nn-guard or eslint; it only proves the runner catches such findings.
const REPLICA = `
import { readFileSync } from 'node:fs';
let bad = 0;
for (const f of process.argv.slice(2)) {
  const text = readFileSync(f, 'utf8');
  if (/eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/.test(text)) { bad++; console.error(f + ': D9 jwt-shaped literal'); }
  for (const m of text.matchAll(/^\\s*let (\\w+)\\b/gm)) if (!new RegExp('\\\\b' + m[1] + '\\\\s*(=[^=]|\\\\+\\\\+|--|\\\\+=)', 'g').test(text.replace(m[0], ''))) { bad++; console.error(f + ': D15 prefer-const ' + m[1]); }
  if (/\\/\\/.*\\bany\\b/.test(text)) { bad++; console.error(f + ': D15 flagged comment word'); }
}
process.exit(bad ? 1 : 0);
`;

// prefix '' = repo is the git top level; 'pkg/' = --repo is a subdirectory of it.
function fixture(t, checks, { prefix = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fastchk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const top = join(dir, 'repo');
  mkdirSync(top);
  git(top, 'init', '-q', '-b', 'main');
  const repo = join(top, prefix);
  put(top, prefix + 'src/a.spec.ts', 'export const a = 1;\n');
  put(top, prefix + 'src/keep.ts', 'export const k = 1;\n');
  const tools = join(dir, 'tools'); mkdirSync(tools);
  const scanner = join(tools, 'scanner.mjs'); writeFileSync(scanner, SCANNER);
  const replica = join(tools, 'replica.mjs'); writeFileSync(replica, REPLICA);
  const record = join(tools, 'record.txt');
  const decl = (mode, extra = {}) => ({ name: 'secrets', kind: 'secrets', cmd: [process.execPath, scanner, record, mode, '{files}'], files: true, ...extra });
  const declare = (c) => { put(top, '.ship-ticket/t0.json', JSON.stringify({ checks: c })); };
  if (checks) declare(checks(decl, { scanner, replica, record, tools }));
  git(top, 'add', '-A'); git(top, 'commit', '-q', '-m', 'base');
  const base = git(top, 'rev-parse', 'HEAD');
  const seen = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((p) => p.replace(/\\/g, '/')) : []);
  const cli = (sub, args, opts = {}) => spawnSync(process.execPath, [CLI, sub, '--repo', repo, ...args], { encoding: 'utf8', ...opts });
  const run = (...args) => cli('run', args.includes('--base') ? args : ['--base', base, ...args]);
  const p = (rel) => prefix + rel;
  return { dir, top, repo, base, decl, declare, seen, run, cli, record, scanner, replica, p, tools };
}
const json = (r) => JSON.parse(r.stdout);

test('no declaration at base: not_declared, exit 0, nothing spawned (AC8)', (t) => {
  const fx = fixture(t);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).code, 'not_declared');
  assert.deepEqual(fx.seen(), []);
});

test('--base is required for run and verify (usage error, exit 2)', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  assert.equal(fx.cli('run', []).status, 2);
  assert.equal(fx.cli('verify', ['--report-file', join(fx.dir, 'x')]).status, 2);
});

test('--base must be a real commit and cannot be an option (m2)', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  for (const bad of ['no-such-ref', '--output=x', 'HEAD:src']) {
    const r = fx.cli('run', ['--base', bad]);
    assert.equal(r.status, 1, bad); assert.equal(json(r).code, 'base_invalid', bad);
  }
});

test('dirty secret: a JWT-shaped literal in an UNCOMMITTED, UNTRACKED spec fails T0 (AC2, D9 replica)', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  assert.equal(json(r).result, 'fail');
  assert.ok(fx.seen().includes('src/new.spec.ts'), 'the untracked file reached the scanner: ' + fx.seen());
  assert.ok(!r.stdout.includes(JWT), 'the verdict never carries scanner output');
});

test('dirty secret: modified-unstaged and staged files are scanned too', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.top, 'src/a.spec.ts', `const t = '${JWT}';\n`);
  put(fx.top, 'src/staged.ts', 'export const s = 1;\n'); git(fx.top, 'add', 'src/staged.ts');
  const r = fx.run();
  assert.equal(r.status, 1);
  const seen = fx.seen();
  assert.ok(seen.includes('src/a.spec.ts') && seen.includes('src/staged.ts'), seen.join(','));
});

test('clean dirty file passes and the file was scanned; the report carries enums only', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.top, 'src/new.ts', 'export const n = 1;\n');
  const r = fx.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).result, 'pass');
  assert.ok(fx.seen().includes('src/new.ts'));
  assert.deepEqual(json(r).report, { result: 'pass', checks: [{ name: 'secrets', result: 'pass' }] });
});

test('renamed file is still scanned: staged git mv with an edit, and a committed rename via --base', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  git(fx.top, 'mv', 'src/a.spec.ts', 'src/b.spec.ts');
  put(fx.top, 'src/b.spec.ts', `const t = '${JWT}';\n`);
  let r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  assert.ok(fx.seen().includes('src/b.spec.ts'), 'staged rename new path: ' + fx.seen());
  assert.ok(!fx.seen().includes('src/a.spec.ts'), 'the deleted old path is not passed');
  const fx2 = fixture(t, (d) => [d('jwt')]);
  git(fx2.top, 'mv', 'src/a.spec.ts', 'src/c.spec.ts');
  put(fx2.top, 'src/c.spec.ts', `const t = '${JWT}';\n`);
  git(fx2.top, 'add', '-A'); git(fx2.top, 'commit', '-q', '-m', 'rename');
  r = fx2.run('--base', fx2.base);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(fx2.seen().includes('src/c.spec.ts'), 'committed rename new path: ' + fx2.seen());
});

test('deleted files are not passed to the scanner', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  unlinkSync(join(fx.top, 'src/keep.ts'));
  put(fx.top, 'src/new.ts', 'x\n');
  assert.equal(fx.run().status, 0);
  assert.ok(fx.seen().includes('src/new.ts') && !fx.seen().includes('src/keep.ts'), fx.seen().join(','));
});

test('B2: --repo is a monorepo SUBDIRECTORY: an edited tracked file with a secret is still scanned and fails', (t) => {
  const fx = fixture(t, (d) => [d('jwt')], { prefix: 'pkg/' });
  put(fx.top, 'pkg/src/a.spec.ts', `const t = '${JWT}';\n`);
  put(fx.top, 'other/x.ts', 'export const x = 1;\n');
  const r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  assert.equal(json(r).result, 'fail');
  const seen = fx.seen();
  assert.ok(seen.includes('src/a.spec.ts'), 'tracked file under the subdirectory: ' + seen);
  assert.ok(seen.includes('../other/x.ts'), 'a change outside --repo is still passed, relative to --repo: ' + seen);
});

test('B2 sibling: a changed path git lists but disk cannot resolve (non-UTF-8 name) is a FAIL, not a silent drop', (t) => {
  if (process.platform !== 'linux') return; // only Linux filesystems accept a non-UTF-8 name
  const fx = fixture(t, (d) => [d('jwt')]);
  writeFileSync(Buffer.concat([Buffer.from(join(fx.top, 'src') + '/'), Buffer.from([0xff, 0xfe, 0x2e, 0x74, 0x73])]), 'x\n');
  const r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).code, 'unresolvable_path');
});

test('B1: the declaration is read from BASE: deleting it in the tree is declaration_tampered, never not_declared', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  unlinkSync(join(fx.top, '.ship-ticket/t0.json'));
  const r = fx.run();
  assert.equal(r.status, 1);
  assert.equal(json(r).code, 'declaration_tampered');
  const msg = join(fx.dir, 'msg.txt'); writeFileSync(msg, fence(BASE));
  const v = fx.cli('verify', ['--base', fx.base, '--report-file', msg]);
  assert.equal(v.status, 1); assert.equal(json(v).code, 'declaration_tampered');
});

test('B1: weakening a check in the tree (cmd -> node -e 0), or adding a check, is declaration_tampered', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  fx.declare([{ name: 'secrets', kind: 'secrets', cmd: [process.execPath, '-e', '0'] }]);
  let r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).code, 'declaration_tampered');
  fx.declare([fx.decl('jwt'), { name: 'extra', kind: 'lint', cmd: [process.execPath, '-e', '0'] }]);
  r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).code, 'declaration_tampered');
});

test('B1: a declaration only the branch has is ignored (not_declared); a symlink in its place is tampered', (t) => {
  const fx = fixture(t);
  fx.declare([fx.decl('jwt')]);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 0); assert.equal(json(r).code, 'not_declared');
  assert.deepEqual(fx.seen(), [], 'the branch declaration is never executed');
  if (process.platform === 'win32') return;
  const fx2 = fixture(t, (d) => [d('jwt')]);
  unlinkSync(join(fx2.top, '.ship-ticket/t0.json'));
  symlinkSync(join(fx2.dir, 'nowhere.json'), join(fx2.top, '.ship-ticket/t0.json'));
  assert.equal(json(fx2.run()).code, 'declaration_tampered');
});

test('sibling: a check whose own command path is a changed file fails (checker_modified)', (t) => {
  const fx = fixture(t);
  put(fx.top, 'tools/scan.mjs', 'process.exit(0)\n');
  fx.declare([{ name: 'own', kind: 'lint', cmd: [process.execPath, 'tools/scan.mjs', '{files}'], files: true }]);
  git(fx.top, 'add', '-A'); git(fx.top, 'commit', '-q', '-m', 'tool');
  const base = git(fx.top, 'rev-parse', 'HEAD');
  put(fx.top, 'src/new.ts', 'x\n');
  assert.equal(fx.run('--base', base).status, 0, 'unchanged checker runs and passes');
  put(fx.top, 'tools/scan.mjs', 'process.exit(0) // weakened\n');
  const r = fx.run('--base', base);
  assert.equal(r.status, 1);
  assert.equal(json(r).checks[0].code, 'checker_modified');
});

test('sibling: assume-unchanged / skip-worktree bits hide edits and are a FAIL (index_flags_hidden)', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  git(fx.top, 'update-index', '--assume-unchanged', 'src/keep.ts');
  put(fx.top, 'src/keep.ts', `const t = '${JWT}';\n`);
  let r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).code, 'index_flags_hidden');
  git(fx.top, 'update-index', '--no-assume-unchanged', 'src/keep.ts');
  git(fx.top, 'update-index', '--skip-worktree', 'src/keep.ts');
  r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).code, 'index_flags_hidden');
});

test('sibling: inherited GIT_DIR / GIT_INDEX_FILE cannot redirect the scan', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  const other = mkdtempSync(join(tmpdir(), 'fastchk-o-')); t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'init', '-q', '-b', 'main');
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.cli('run', ['--base', fx.base], { env: { ...process.env, GIT_DIR: join(other, '.git'), GIT_INDEX_FILE: join(other, 'idx') } });
  assert.equal(r.status, 1, r.stderr); assert.ok(fx.seen().includes('src/new.spec.ts'));
});

test('M3: nothing changed since base: the check is reported skipped (not pass); verify refuses a skipped check when files changed', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  const r = fx.run();
  assert.equal(r.status, 0);
  assert.deepEqual(json(r).report, { result: 'pass', checks: [{ name: 'secrets', result: 'skipped' }] });
  assert.equal(json(r).checks[0].result, 'skipped');
  put(fx.top, 'src/new.ts', 'x\n');
  const msg = join(fx.dir, 'msg.txt');
  writeFileSync(msg, fence({ ...BASE, t0: { result: 'pass', checks: [{ name: 'secrets', result: 'skipped' }] } }));
  const v = fx.cli('verify', ['--base', fx.base, '--report-file', msg]);
  assert.equal(v.status, 1); assert.equal(json(v).code, 'fast_check_skipped');
});

test('Codex 1: a changed submodule, a nested repository and a symlink are a FAIL, never a silent drop', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  const sub = join(fx.dir, 'subrepo'); mkdirSync(sub); git(sub, 'init', '-q', '-b', 'main'); put(sub, 'f.txt', '1\n'); git(sub, 'add', '-A'); git(sub, 'commit', '-q', '-m', 's');
  git(fx.top, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
  git(fx.top, 'add', '-A'); git(fx.top, 'commit', '-q', '-m', 'add sub');
  const base = git(fx.top, 'rev-parse', 'HEAD');
  put(fx.top, 'vendor/sub/leak.txt', `const t = '${JWT}';\n`);
  let r = fx.run('--base', base);
  assert.equal(r.status, 1); assert.equal(json(r).code, 'unsupported_changed_surface');
  rmSync(join(fx.top, 'vendor/sub/leak.txt'));
  put(fx.top, 'nested/inner.ts', 'x\n'); git(join(fx.top, 'nested'), 'init', '-q');
  r = fx.run('--base', base);
  assert.equal(r.status, 1); assert.equal(json(r).code, 'unsupported_changed_surface');
  if (process.platform === 'win32') return;
  rmSync(join(fx.top, 'nested'), { recursive: true });
  symlinkSync(join(fx.dir, 'elsewhere'), join(fx.top, 'link.ts'));
  r = fx.run('--base', base);
  assert.equal(r.status, 1); assert.equal(json(r).code, 'unsupported_changed_surface');
});

test('AC3 replica: a REAL checker catches D9 (JWT literal) and D15 (prefer-const, flagged comment word) in dirty and renamed files', (t) => {
  const fx = fixture(t, (d, x) => [
    { name: 'lint', kind: 'lint', cmd: [process.execPath, x.replica, '{files}'], files: true },
    { name: 'nn-guard', kind: 'nn-guard', cmd: [process.execPath, x.replica, '{files}'], files: true }]);
  put(fx.top, 'src/ok.ts', 'let n = 0;\nn += 1;\nexport const v = n;\n');
  assert.equal(fx.run().status, 0, 'clean dirty file passes');
  put(fx.top, 'src/d15a.spec.ts', 'let done = false;\nexport const x = done;\n');
  let r = fx.run();
  assert.equal(r.status, 1); assert.deepEqual(json(r).report.checks.map((c) => c.result), ['fail', 'fail']);
  unlinkSync(join(fx.top, 'src/d15a.spec.ts'));
  put(fx.top, 'src/d15b.ts', '// accepts any value here\nexport const y = 1;\n');
  assert.equal(fx.run().status, 1, 'D15 comment word');
  unlinkSync(join(fx.top, 'src/d15b.ts'));
  git(fx.top, 'mv', 'src/a.spec.ts', 'src/renamed.spec.ts');
  put(fx.top, 'src/renamed.spec.ts', `export const tok = '${JWT}';\n`);
  r = fx.run();
  assert.equal(r.status, 1, 'D9 in a renamed file'); assert.ok(r.stderr.includes('D9'), r.stderr);
});

test('a timeout is a FAIL, never a PASS (Neg)', (t) => {
  const fx = fixture(t, (d) => [d('sleep', { timeout_ms: 400 })]);
  put(fx.top, 'src/new.ts', 'x\n');
  const started = Date.now();
  const r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  const out = json(r);
  assert.equal(out.result, 'fail');
  assert.equal(out.checks[0].timed_out, true);
  assert.equal(out.checks[0].result, 'fail');
  assert.ok(Date.now() - started < 20000, 'returned promptly');
});

test('Codex 3: on timeout the whole process tree is killed: a descendant heartbeat STOPS', async (t) => {
  const fx = fixture(t, (d, x) => {
    const spawner = join(x.tools, 'spawner.mjs');
    writeFileSync(spawner, `import { spawn } from 'node:child_process';
const hb = process.argv[2];
spawn(process.execPath, ['-e', "const fs=require('fs');setInterval(()=>fs.appendFileSync(" + JSON.stringify(hb) + ",'x'),100)"], { stdio: 'ignore' });
setTimeout(()=>{},60000);`);
    return [{ name: 'tree', kind: 'other', cmd: [process.execPath, spawner, join(x.tools, 'hb.txt')], timeout_ms: 1500 }];
  });
  const r = fx.run();
  assert.equal(r.status, 1, r.stderr);
  assert.equal(json(r).checks[0].timed_out, true);
  const hb = join(fx.tools, 'hb.txt');
  assert.ok(existsSync(hb) && readFileSync(hb).length > 0, 'the descendant was alive and beating');
  await new Promise((res) => setTimeout(res, 400));
  const before = readFileSync(hb).length;
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(readFileSync(hb).length, before, 'no heartbeat after the verdict: the descendant is not running');
});

test('spawn error, empty list, malformed declaration at base are FAIL, never PASS', (t) => {
  const fx = fixture(t, () => [{ name: 'lint', kind: 'lint', cmd: ['definitely-not-a-real-binary-t0'] }]);
  put(fx.top, 'src/new.ts', 'x\n');
  let r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).result, 'fail');
  for (const bad of [{ checks: [] }, { checks: [{ name: 'x', cmd: 'node a.js' }] }, { checks: [{ name: 'x', kind: 'lint', cmd: ['node'], files: true }] }, 'not json', { checks: [{ name: 'x', kind: 'lint', cmd: ['node'], timeout_ms: 5 }] }]) {
    const f2 = fixture(t);
    put(f2.top, '.ship-ticket/t0.json', typeof bad === 'string' ? bad : JSON.stringify(bad));
    git(f2.top, 'add', '-A'); git(f2.top, 'commit', '-q', '-m', 'decl');
    r = f2.run('--base', git(f2.top, 'rev-parse', 'HEAD'));
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.equal(json(r).code, 't0_config_invalid');
  }
  const bare = mkdtempSync(join(tmpdir(), 'fastchk-nogit-')); t.after(() => rmSync(bare, { recursive: true, force: true }));
  r = spawnSync(process.execPath, [CLI, 'run', '--repo', bare, '--base', 'HEAD'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(json(r).code, 'file_set_unavailable');
});

test('scanner stdout (a secret echo) is never in the verdict JSON', (t) => {
  const fx = fixture(t, (d) => [d('echo')]);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(JWT));
});

test('run-log: --ticket/--run-id writes a t0_check activity row with outcome and numeric metrics only', (t) => {
  const fx = fixture(t, (d) => [d('echo')]);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  const r = fx.run('--ticket', 'T1', '--run-id', 'run-1');
  assert.equal(r.status, 1, r.stderr);
  const log = join(fx.top, '.git', 'ai-skills', 'ship-ticket', 'T1.jsonl');
  const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.event, x.kind, x.name]), [['start', 'activity', 't0_check'], ['end', 'activity', 't0_check']]);
  assert.equal(rows[1].outcome, 'fail');
  assert.ok(!readFileSync(log, 'utf8').includes(JWT));
  const s = spawnSync(process.execPath, [RUN_LOG, 'summary', '--repo', fx.top, '--ticket', 'T1'], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
});

test('run-log failure never changes the verdict', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.top, 'src/new.ts', 'x\n');
  const r = fx.run('--ticket', 'bad ticket!', '--run-id', 'run-1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(r).result, 'pass');
});

const BASE = { tests: [{ cmd: 'node --test a', result: 'pass' }], red_seen: [], blockers: [], needs_outside_ownership: [] };
const T0_OK = { result: 'pass', checks: [{ name: 'secrets', result: 'pass' }] };
const fence = (o) => 'Done.\n```ship-ticket-report\n' + JSON.stringify(o) + '\n```\n';

test('parseWorkerReport: default behaviour and failure strings are unchanged (AC8)', () => {
  assert.equal(parseWorkerReport(fence(BASE)).status, 'structured');
  assert.equal(parseWorkerReport(fence({ ...BASE, t0: T0_OK })).status, 'structured', 'a compliant five-key report is never downgraded');
  assert.equal(parseWorkerReport(fence({ ...BASE, t0: 'pass' })).failure.split(':')[0], 'fast_check_invalid');
  assert.equal(parseWorkerReport(fence({ ...BASE, other: 1 })).failure, 'report keys: missing [] unexpected [other]');
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
  const verify = (o) => { writeFileSync(msg, fence(o)); return fx.cli('verify', ['--base', fx.base, '--report-file', msg]); };
  const both = { result: 'pass', checks: [{ name: 'secrets', result: 'pass' }, { name: 'lint', result: 'pass' }] };
  let r = verify(BASE); assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_missing');
  r = verify({ ...BASE, t0: { result: 'fail', checks: [{ name: 'secrets', result: 'fail' }, { name: 'lint', result: 'pass' }] } });
  assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_failed');
  r = verify({ ...BASE, t0: T0_OK }); assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_incomplete');
  r = verify({ ...BASE, t0: { ...both, result: 'pass', checks: [{ name: 'secrets', result: 'pass' }, { name: 'lint', result: 'fail' }] } });
  assert.equal(r.status, 1); assert.equal(json(r).code, 'fast_check_failed', 'a pass verdict over a failing check is not trusted');
  r = verify({ ...BASE, t0: both }); assert.equal(r.status, 0, r.stdout); assert.equal(json(r).code, 'ok');
  r = verify({ ...BASE, t0: { ...both, checks: [{ name: 'secrets"; x', result: 'pass' }, { name: 'lint', result: 'pass' }] } });
  assert.equal(r.status, 1); assert.ok(!r.stdout.includes('secrets"'), 'worker text is not echoed');
  // undeclared at base: nothing demanded
  const fx2 = fixture(t);
  writeFileSync(msg, fence(BASE));
  r = fx2.cli('verify', ['--base', fx2.base, '--report-file', msg]); assert.equal(r.status, 0); assert.equal(json(r).code, 'not_declared');
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

test('Codex 2: brief --t0 <file> --out <same file> (and a hard link to it) is refused and the declaration survives', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fastchk-brief-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = (n, c) => { writeFileSync(join(dir, n), c); return join(dir, n); };
  const dag = w('dag.json', JSON.stringify(DAG)); const plan = w('plan.md', PLAN);
  const t0Text = JSON.stringify({ checks: [{ name: 'secrets', kind: 'secrets', cmd: ['x'] }] });
  const t0 = w('t0.json', t0Text);
  const brief = fileURLToPath(new URL('./brief.mjs', import.meta.url));
  let r = spawnSync(process.execPath, [brief, 'build', '--dag', dag, '--node', 'api', '--plan', plan, '--t0', t0, '--out', t0], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(readFileSync(t0, 'utf8'), t0Text);
  const hard = join(dir, 'hard.json'); linkSync(t0, hard);
  r = spawnSync(process.execPath, [brief, 'build', '--dag', dag, '--node', 'api', '--plan', plan, '--t0', t0, '--out', hard], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(readFileSync(t0, 'utf8'), t0Text);
});

test('A1: a git replace of the base commit cannot hide the scan or swap the declaration', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  put(fx.top, 'src/new.spec.ts', `const token = '${JWT}';\n`);
  // replace base with an empty-tree commit whose declaration is harmless: replace refs would rewrite what --base reads
  const empty = git(fx.top, 'hash-object', '-t', 'tree', '/dev/null');
  const fake = git(fx.top, 'commit-tree', empty, '-m', 'fake');
  git(fx.top, 'replace', '-f', fx.base, fake);
  const r = fx.run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(fx.seen().includes('src/new.spec.ts'), 'the real base is used: ' + fx.seen());
});

test('A2: a non-UTF-8 path with a lossy alias is a FAIL; a repo directory with a leading space works', (t) => {
  if (process.platform === 'linux') {
    const fx = fixture(t, (d) => [d('jwt')]);
    put(fx.top, 'src/\ufffd.ts', 'clean\n'); // the alias a lossy decode would resolve to
    writeFileSync(Buffer.concat([Buffer.from(join(fx.top, 'src') + '/'), Buffer.from([0xff, 0x2e, 0x74, 0x73])]), 'x\n');
    git(fx.top, 'rm', '-q', '--cached', '-r', '.', '--ignore-unmatch');
    const r = fx.run();
    assert.equal(r.status, 1); assert.equal(json(r).code, 'unresolvable_path');
  }
  if (process.platform === 'win32') return;
  const fx2 = fixture(t, (d) => [d('jwt')], { prefix: ' pkg/' });
  put(fx2.top, ' pkg/src/new.spec.ts', `const t = '${JWT}';\n`);
  const r2 = fx2.run();
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.ok(fx2.seen().includes('src/new.spec.ts'), fx2.seen().join(','));
});

test('A3: the declaration is looked up at the TOP LEVEL; --repo <subdir> cannot bypass it, and a subdir copy is ignored', (t) => {
  const fx = fixture(t, (d) => [d('jwt')], { prefix: 'pkg/' });
  put(fx.top, 'pkg/src/new.spec.ts', `const t = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 1); assert.equal(json(r).result, 'fail');
  assert.ok(fx.seen().length > 0, 'the top-level declaration ran for a subdirectory --repo');
  // a declaration that exists only inside the subdirectory is not a declaration
  const fx2 = fixture(t, null, { prefix: 'pkg/' });
  put(fx2.top, 'pkg/.ship-ticket/t0.json', JSON.stringify({ checks: [fx2.decl('jwt')] }));
  git(fx2.top, 'add', '-A'); git(fx2.top, 'commit', '-q', '-m', 'sub decl');
  assert.equal(json(fx2.run('--base', git(fx2.top, 'rev-parse', 'HEAD'))).code, 'not_declared');
});

test('A4: no declaration at base returns not_declared BEFORE any changed-surface check (AC8)', (t) => {
  if (process.platform === 'win32') return;
  const fx = fixture(t);
  symlinkSync(join(fx.dir, 'elsewhere'), join(fx.top, 'link.ts'));
  git(fx.top, 'update-index', '--assume-unchanged', 'src/keep.ts');
  const r = fx.run();
  assert.equal(r.status, 0, r.stdout); assert.equal(json(r).code, 'not_declared');
});

test('A5: killTree falls back to the direct child when taskkill fails, and reports it', () => {
  const calls = [];
  const child = { pid: 123, killed: false, kill() { this.killed = true; return true; }, unref() { calls.push('unref'); } };
  const degraded = killTree(child, { platform: 'win32', run: () => ({ status: 1 }) });
  assert.equal(child.killed, true); assert.equal(degraded, true); assert.ok(calls.includes('unref'));
  const ok = { pid: 1, kill() { throw new Error('must not be called'); }, unref() {} };
  assert.equal(killTree(ok, { platform: 'win32', run: () => ({ status: 0 }) }), false);
  const missing = { pid: 2, killed: false, kill() { this.killed = true; }, unref() {} };
  assert.equal(killTree(missing, { platform: 'win32', run: () => ({ error: new Error('ENOENT') }) }), true);
});

test('A6: verify rejects `skipped` for a check that is not file-scoped', (t) => {
  const fx = fixture(t, (d) => [d('jwt'), { name: 'lint', kind: 'lint', cmd: [process.execPath, '-e', '0'] }]);
  const msg = join(fx.dir, 'msg.txt');
  writeFileSync(msg, fence({ ...BASE, t0: { result: 'pass', checks: [{ name: 'secrets', result: 'skipped' }, { name: 'lint', result: 'skipped' }] } }));
  const v = fx.cli('verify', ['--base', fx.base, '--report-file', msg]);
  assert.equal(v.status, 1); assert.equal(json(v).code, 'fast_check_skipped', 'lint is files:false, so it can never be skipped');
});

test('A7: checker_modified compares real paths (symlink target), splits --opt=path, and covers a config argument', (t) => {
  if (process.platform === 'win32') return;
  const fx = fixture(t);
  put(fx.top, 'cfg/rules.json', '{}\n'); put(fx.top, 'tools/scan.mjs', 'process.exit(0)\n');
  symlinkSync(join(fx.top, 'cfg/rules.json'), join(fx.top, 'cfg/alias.json'));
  fx.declare([{ name: 'own', kind: 'lint', cmd: [process.execPath, 'tools/scan.mjs', '--config=cfg/alias.json', '{files}'], files: true }]);
  git(fx.top, 'add', '-A'); git(fx.top, 'commit', '-q', '-m', 'tool');
  const base = git(fx.top, 'rev-parse', 'HEAD');
  put(fx.top, 'src/new.ts', 'x\n');
  assert.equal(fx.run('--base', base).status, 0);
  put(fx.top, 'cfg/rules.json', '{"weak":true}\n'); // the alias target changed, not the argument path itself
  const r = fx.run('--base', base);
  assert.equal(r.status, 1); assert.equal(json(r).checks[0].code, 'checker_modified');
});

test('A2 unit: utf8Path refuses bytes that only a lossy decode would alias (runs on every OS)', () => {
  assert.equal(utf8Path(Buffer.from('src/ok.ts')), 'src/ok.ts');
  assert.equal(utf8Path(Buffer.from([0x73, 0xff, 0x2e, 0x74, 0x73])), null);
  assert.equal(utf8Path(Buffer.from(' lead space.ts')), ' lead space.ts');
});

test('F1: only the single trailing LF git emits is stripped (a trailing CR belongs to a directory name)', (t) => {
  assert.equal(stripNewline(Buffer.from('/r/pkg\r\n')), '/r/pkg\r');
  assert.equal(stripNewline(Buffer.from('/r/pkg\n')), '/r/pkg');
  assert.equal(stripNewline(Buffer.from(' /r/ x \n')), ' /r/ x ');
  if (process.platform === 'win32') return;
  const fx = fixture(t, (d) => [d('jwt')], { prefix: 'cr\r/' });
  put(fx.top, 'cr\r/src/new.spec.ts', `const t = '${JWT}';\n`);
  const r = fx.run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(fx.seen().includes('src/new.spec.ts'), fx.seen().join(','));
});

test('F2: an inherited GIT_DIR cannot send the t0_check row to ANOTHER repository (and checks get a GIT_*-free env)', (t) => {
  const fx = fixture(t, (d) => [d('jwt')]);
  const other = mkdtempSync(join(tmpdir(), 'fastchk-o-')); t.after(() => rmSync(other, { recursive: true, force: true }));
  git(other, 'init', '-q', '-b', 'main');
  put(fx.top, 'src/new.ts', 'x\n');
  const r = fx.cli('run', ['--base', fx.base, '--ticket', 'T9', '--run-id', 'run-9'], { env: { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(fx.top, '.git', 'ai-skills', 'ship-ticket', 'T9.jsonl')), 'the row landed in the checked repository');
  assert.ok(!existsSync(join(other, '.git', 'ai-skills')), 'nothing was written into the other repository');
});

test('F2 sibling: a declared check never sees an inherited GIT_* variable', (t) => {
  const fx = fixture(t);
  const probe = join(fx.tools, 'probe.mjs');
  writeFileSync(probe, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], Object.keys(process.env).filter((k) => k.startsWith('GIT_')).join(','));`);
  const out = join(fx.tools, 'env.txt');
  fx.declare([{ name: 'probe', kind: 'other', cmd: [process.execPath, probe, out] }]);
  git(fx.top, 'add', '-A'); git(fx.top, 'commit', '-q', '-m', 'probe');
  const r = fx.cli('run', ['--base', git(fx.top, 'rev-parse', 'HEAD')], { env: { ...process.env, GIT_DIR: join(fx.top, '.git'), GIT_AUTHOR_NAME: 'x' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8'), '');
});
