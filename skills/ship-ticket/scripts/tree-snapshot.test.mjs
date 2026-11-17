// Main-tree tripwire (ASTF-15, S-03a). Fixtures are real git repositories in temp dirs. Every test asserts a positive
// signal (the expected change class and path appear in the verdict), never merely the absence of an error.
// TREE_SNAPSHOT_UNDER_TEST points at a mutated copy of the module for the mutation checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, chmodSync, utimesSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const MODULE = process.env.TREE_SNAPSHOT_UNDER_TEST || fileURLToPath(new URL('./tree-snapshot.mjs', import.meta.url));
const { takeSnapshot, compareSnapshots, LIMITS } = await import(pathToFileURL(MODULE).href);
const win = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const put = (repo, rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
const cli = (...args) => { const r = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' }); return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr }; };

function fixture(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'treesnap-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'a.txt', 'alpha\n'); put(repo, 'b.sh', '#!/bin/sh\n'); put(repo, '.gitignore', 'ignored.log\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  return { dir, repo };
}
const verdict = (before, repo) => compareSnapshots(before, takeSnapshot(repo));
const paths = (v) => v.changed.map((c) => `${c.what}:${c.path}`);

test('untouched tree is unchanged, and the snapshot is not vacuous', (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  assert.ok(s.entries.length >= 3 && s.entries.some((e) => e.p === 'a.txt' && /^[0-9a-f]{64}$/.test(e.h)));
  git(repo, 'status'); // a read-only git command must not register as a change
  const v = verdict(s, repo);
  assert.equal(v.result, 'unchanged'); assert.deepEqual(v.changed, []);
});

test('AC1 a seeded fake-reviewer write fails with the path list (CLI, exit 1)', (t) => {
  const { dir, repo } = fixture(t);
  const f = join(dir, 'start.json');
  assert.equal(cli('snapshot', '--repo', repo, '--lane', 'lane-1', '--out', f).status, 0);
  put(repo, 'a.txt', 'tampered\n');
  const r = cli('compare', '--before', f, '--repo', repo);
  assert.equal(r.status, 1); assert.equal(r.out.result, 'changed'); assert.equal(r.out.lane, 'lane-1');
  assert.deepEqual(paths(r.out), ['content:a.txt']);
});

test('AC2 a second edit to an already-dirty path is detected although the git status text is identical', (t) => {
  const { repo } = fixture(t);
  put(repo, 'a.txt', 'dirty-one\n');
  const stamp = statSync(join(repo, 'a.txt'));
  const status1 = git(repo, 'status', '--porcelain');
  const s = takeSnapshot(repo);
  put(repo, 'a.txt', 'dirty-TWO\n'); // same length, still modified
  utimesSync(join(repo, 'a.txt'), stamp.atime, stamp.mtime); // restored mtime
  assert.equal(git(repo, 'status', '--porcelain'), status1); // the premise: status text cannot see this edit
  assert.deepEqual(paths(verdict(s, repo)), ['content:a.txt']);
});

test('AC3 index-only add, HEAD move, new branch/tag, new untracked file are each detected', (t) => {
  const { repo } = fixture(t);
  put(repo, 'a.txt', 'dirty\n');
  let s = takeSnapshot(repo);
  git(repo, 'add', 'a.txt');
  let v = verdict(s, repo);
  assert.deepEqual(paths(v), ['index:null']); // content unchanged, only the index moved
  s = takeSnapshot(repo);
  git(repo, 'commit', '-q', '-m', 'second');
  v = verdict(s, repo);
  assert.ok(v.changed.some((c) => c.what === 'head') && v.changed.some((c) => c.what === 'refs'));
  s = takeSnapshot(repo);
  git(repo, 'tag', 'lane-tag');
  assert.deepEqual(paths(verdict(s, repo)), ['refs:null']);
  s = takeSnapshot(repo);
  put(repo, 'new.txt', 'x');
  assert.deepEqual(paths(verdict(s, repo)), ['added:new.txt']);
  s = takeSnapshot(repo);
  git(repo, 'config', 'core.hooksPath', '/nonexistent');
  assert.deepEqual(paths(verdict(s, repo)), ['config:null']);
});

test('AC3 a mode-only change is detected (POSIX)', { skip: win && 'no exec bit on Windows; see the degrade test' }, (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  chmodSync(join(repo, 'a.txt'), 0o755);
  assert.deepEqual(paths(verdict(s, repo)), ['mode:a.txt']);
});

test('AC3 mode comparison degrades explicitly where there is no exec bit, never silently equal', (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo, { platform: 'win32' });
  assert.equal(s.mode_checked, false); assert.ok(s.entries.every((e) => e.x === undefined || e.x === null));
  const v = compareSnapshots(s, takeSnapshot(repo, { platform: 'win32' }));
  assert.equal(v.result, 'unchanged'); assert.deepEqual(v.degraded, ['file_mode_not_compared']);
  const mixed = compareSnapshots(takeSnapshot(repo), takeSnapshot(repo, { platform: 'win32' }));
  assert.deepEqual(mixed.degraded, ['file_mode_not_compared']);
});

test('AC4 a write through a symlink that points into the main tree is detected', { skip: win && 'symlinks need privileges on Windows' }, (t) => {
  const { dir, repo } = fixture(t);
  mkdirSync(join(dir, 'lane')); symlinkSync(join(repo, 'a.txt'), join(dir, 'lane', 'link'));
  const s = takeSnapshot(repo);
  writeFileSync(join(dir, 'lane', 'link'), 'via-symlink\n');
  assert.deepEqual(paths(verdict(s, repo)), ['content:a.txt']);
});

test('a tracked symlink retargeted is detected as content', { skip: win && 'symlinks need privileges on Windows' }, (t) => {
  const { repo } = fixture(t);
  symlinkSync('a.txt', join(repo, 'ln')); git(repo, 'add', 'ln'); git(repo, 'commit', '-q', '-m', 'ln');
  const s = takeSnapshot(repo);
  rmSync(join(repo, 'ln')); symlinkSync('b.sh', join(repo, 'ln'));
  assert.deepEqual(paths(verdict(s, repo)), ['content:ln']);
});

test('AC5 taking a snapshot does not rewrite the index', (t) => {
  const { repo } = fixture(t);
  put(repo, 'a.txt', 'touched\n'); // stat-dirty entry: a refreshing git command would rewrite the index
  const idx = join(repo, '.git', 'index');
  const before = readFileSync(idx); const m = statSync(idx).mtimeMs;
  takeSnapshot(repo); takeSnapshot(repo);
  assert.ok(before.equals(readFileSync(idx))); assert.equal(statSync(idx).mtimeMs, m);
});

test('AC6 every verdict states the documented limits', (t) => {
  const { dir, repo } = fixture(t);
  const f = join(dir, 's.json'); cli('snapshot', '--repo', repo, '--out', f);
  const r = cli('compare', '--before', f, '--repo', repo);
  assert.equal(r.status, 0); assert.deepEqual(r.out.limits, LIMITS);
  const text = LIMITS.join(' | ');
  for (const needle of ['git-ignored', 'shared .git', 'absolute path', 'nested repositories', 'same user']) assert.ok(text.includes(needle), needle);
});

test('a git-ignored file change is NOT seen (documented limit, pinned so it cannot silently change)', (t) => {
  const { repo } = fixture(t);
  put(repo, 'ignored.log', 'one'); const s = takeSnapshot(repo);
  put(repo, 'ignored.log', 'two');
  assert.equal(verdict(s, repo).result, 'unchanged');
});

test('adversarial paths: newline, space, unicode, case siblings are tracked per exact path', (t) => {
  const { repo } = fixture(t);
  const names = ['we ird/new\nline.txt', ' lead.txt', 'ünï/日本.txt'];
  for (const n of names) put(repo, n, 'x');
  if (!win) { put(repo, 'Case.txt', '1'); put(repo, 'case.txt', '2'); } // case siblings only where the filesystem allows
  const s = takeSnapshot(repo);
  for (const n of names) assert.ok(s.entries.some((e) => e.p === n), JSON.stringify(n));
  put(repo, 'we ird/new\nline.txt', 'y');
  assert.deepEqual(paths(verdict(s, repo)), ['content:we ird/new\nline.txt']);
});

test('invalid-UTF-8 path and binary content are hashed, not skipped', { skip: (win || process.platform === 'darwin') && 'filesystem rejects non-UTF-8 names' }, (t) => {
  const { repo } = fixture(t);
  writeFileSync(Buffer.concat([Buffer.from(repo + '/'), Buffer.from([0x66, 0xff, 0x2e, 0x62, 0x69, 0x6e])]), Buffer.from([0, 255, 254]));
  const s = takeSnapshot(repo);
  assert.ok(s.entries.some((e) => e.p.startsWith('hex:66ff') && e.k === 'file'));
});

test('autocrlf and filters: a CRLF-only edit is a content change (raw bytes are hashed)', (t) => {
  const { repo } = fixture(t);
  git(repo, 'config', 'core.autocrlf', 'true');
  put(repo, 'a.txt', 'alpha\n'); const s = takeSnapshot(repo);
  put(repo, 'a.txt', 'alpha\r\n');
  assert.deepEqual(paths(verdict(s, repo)), ['content:a.txt']);
});

test('inherited GIT_DIR / GIT_INDEX_FILE / GIT_CONFIG_* do not redirect the snapshot', (t) => {
  const { dir, repo } = fixture(t);
  const other = join(dir, 'other'); mkdirSync(other); git(other, 'init', '-q');
  const run = () => spawnSync(process.execPath, [MODULE, 'snapshot', '--repo', repo], { encoding: 'utf8', env: { ...process.env, GIT_DIR: join(other, '.git'), GIT_INDEX_FILE: join(dir, 'bogus-index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.identity, takeSnapshot(repo).identity); assert.ok(s.entries.some((e) => e.p === 'a.txt'));
});

test('sparse / skip-worktree: a tracked path missing from disk is a recorded state, and its restoration is a change', (t) => {
  const { repo } = fixture(t);
  git(repo, 'update-index', '--skip-worktree', 'a.txt'); rmSync(join(repo, 'a.txt'));
  const s = takeSnapshot(repo);
  assert.equal(s.entries.find((e) => e.p === 'a.txt').k, 'missing');
  put(repo, 'a.txt', 'back\n');
  assert.deepEqual(paths(verdict(s, repo)), ['kind:a.txt']);
  git(repo, 'update-index', '--no-skip-worktree', 'a.txt'); // the flag itself lives in the index hash
  assert.ok(verdict(s, repo).changed.some((c) => c.what === 'index'));
});

test('FAIL-CLOSED: an unreadable path (file, or file under an unsearchable directory) is unknown (exit 1), not unchanged', { skip: (win || isRoot) && 'needs POSIX permissions as a non-root user' }, (t) => {
  const { dir, repo } = fixture(t);
  put(repo, 'sub/x.txt', 'x'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'sub');
  for (const [target, mode, back, expected] of [['a.txt', 0o000, 0o644, 'unknown:a.txt'], ['sub', 0o000, 0o755, 'unknown:sub/x.txt']]) {
    chmodSync(join(repo, target), mode); t.after(() => { try { chmodSync(join(repo, target), back); } catch { /* fixture already removed */ } });
    const f = join(dir, 's.json'); cli('snapshot', '--repo', repo, '--out', f);
    const r = cli('compare', '--before', f, '--repo', repo);
    assert.equal(r.status, 1); assert.equal(r.out.result, 'unknown'); assert.deepEqual(paths(r.out), [expected]);
    chmodSync(join(repo, target), back);
  }
});

test('FAIL-CLOSED: not a repository, missing or garbage start record, different repository, bad usage', (t) => {
  const { dir, repo } = fixture(t);
  const notRepo = join(dir, 'plain'); mkdirSync(notRepo);
  const a = cli('snapshot', '--repo', notRepo); assert.equal(a.status, 1); assert.equal(a.out.result, 'unknown');
  const f = join(dir, 's.json'); writeFileSync(f, 'not json');
  assert.equal(cli('compare', '--before', f, '--repo', repo).out.result, 'unknown');
  assert.equal(cli('compare', '--before', join(dir, 'absent.json'), '--repo', repo).status, 1);
  const s = takeSnapshot(repo);
  assert.equal(compareSnapshots(s, { ...takeSnapshot(repo), top: '/elsewhere' }).result, 'unknown');
  assert.equal(compareSnapshots(s, { ...s, schema: 'x' }).result, 'unknown');
  assert.equal(cli('nope').status, 2); assert.equal(cli('compare', '--before', f).status, 2);
});

test('compare --after reads two records and agrees with the live comparison', (t) => {
  const { dir, repo } = fixture(t);
  const f1 = join(dir, '1.json'), f2 = join(dir, '2.json');
  cli('snapshot', '--repo', repo, '--out', f1); put(repo, 'b.sh', 'changed\n'); cli('snapshot', '--repo', repo, '--out', f2);
  const r = cli('compare', '--before', f1, '--after', f2);
  assert.equal(r.status, 1); assert.deepEqual(paths(r.out), ['content:b.sh']);
});
