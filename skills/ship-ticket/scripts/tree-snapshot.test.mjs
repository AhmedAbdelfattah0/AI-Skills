// Main-tree tripwire (ASTF-15, S-03a). Fixtures are real git repositories in temp dirs. Every test asserts a positive
// signal (the expected change class and path appear in the verdict), never merely the absence of an error.
// TREE_SNAPSHOT_UNDER_TEST points at a mutated copy of the module for the mutation checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, chmodSync, utimesSync, statSync, realpathSync, readdirSync, renameSync, existsSync, lstatSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const MODULE = process.env.TREE_SNAPSHOT_UNDER_TEST || fileURLToPath(new URL('./tree-snapshot.mjs', import.meta.url));
const { takeSnapshot, compareSnapshots, validateSnapshot, LIMITS } = await import(pathToFileURL(MODULE).href);
const win = process.platform === 'win32';
const CASE_INSENSITIVE = (() => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), 'treecase-'))); try { writeFileSync(join(d, 'Ab'), ''); return existsSync(join(d, 'aB')); } finally { rmSync(d, { recursive: true, force: true }); } })();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const POSIX_PERMS = (win || isRoot) && 'needs POSIX permissions as a non-root user';
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
const put = (repo, rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
let cliCwd;
const cli = (...args) => { const r = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8', cwd: cliCwd }); return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr }; };

function fixture(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'treesnap-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, 'a.txt', 'alpha\n'); put(repo, 'b.sh', '#!/bin/sh\n'); put(repo, '.gitignore', 'ignored.log\n');
  git(repo, 'add', '-A'); if (!win) git(repo, 'update-index', '--chmod=+x', 'b.sh'); git(repo, 'commit', '-q', '-m', 'base');
  if (!win) chmodSync(join(repo, 'b.sh'), 0o755);
  return { dir, repo };
}
const verdict = (before, repo) => compareSnapshots(before, takeSnapshot(repo));
const ent = (s, name) => s.entries.find((e) => e.n === name);
const paths = (v) => v.changed.map((c) => `${c.what}:${c.path}`);

test('untouched tree is unchanged, and the snapshot is not vacuous', (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  assert.ok(s.entries.length >= 3 && s.entries.some((e) => e.n === 'a.txt' && /^[0-9a-f]{64}$/.test(e.h)));
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
  assert.deepEqual(paths(v), ['head:null']); assert.equal(v.shared_git.result, 'changed'); // the branch moved too, but that is shared state
  s = takeSnapshot(repo);
  git(repo, 'tag', 'lane-tag');
  v = verdict(s, repo);
  assert.equal(v.result, 'unchanged'); assert.equal(v.shared_git.result, 'changed'); assert.deepEqual(v.shared_git.refs.map((r) => r.ref), ['refs/tags/lane-tag']);
  s = takeSnapshot(repo);
  put(repo, 'new.txt', 'x');
  assert.deepEqual(paths(verdict(s, repo)), ['added:new.txt']);
  s = takeSnapshot(repo);
  git(repo, 'config', 'user.nickname', 'zz');
  v = verdict(s, repo);
  assert.equal(v.result, 'unchanged'); assert.equal(v.shared_git.config, true); assert.equal(v.shared_git.result, 'changed');
});

test('AC3 a mode-only change is detected (POSIX)', { skip: win && 'no exec bit on Windows; see the degrade test' }, (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  chmodSync(join(repo, 'a.txt'), 0o755);
  assert.deepEqual(paths(verdict(s, repo)), ['mode:a.txt']);
});

test('fix1 exec bit is the OWNER bit only, as git sees it: 0755->0655 and 0644->0744 change; group/other-only changes do not', { skip: win && 'no exec bit on Windows' }, (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  const status = () => git(repo, 'status', '--porcelain');
  assert.equal(status(), '');
  chmodSync(join(repo, 'b.sh'), 0o655); // git: old mode 100755 / new mode 100644
  assert.notEqual(status(), ''); assert.deepEqual(paths(verdict(s, repo)), ['mode:b.sh']);
  chmodSync(join(repo, 'b.sh'), 0o755);
  chmodSync(join(repo, 'a.txt'), 0o744); assert.deepEqual(paths(verdict(s, repo)), ['mode:a.txt']);
  chmodSync(join(repo, 'a.txt'), 0o644);
  for (const [f, m] of [['a.txt', 0o664], ['a.txt', 0o646], ['b.sh', 0o757], ['b.sh', 0o705]]) { // group/other only: git ignores these
    chmodSync(join(repo, f), m); assert.equal(status(), '', `git sees ${m.toString(8)}`); assert.equal(verdict(s, repo).result, 'unchanged', m.toString(8));
    chmodSync(join(repo, f), f === 'b.sh' ? 0o755 : 0o644);
  }
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

test('adversarial paths: space, unicode and (on a case-sensitive filesystem) case siblings are tracked per exact path', (t) => {
  const { repo } = fixture(t);
  const names = ['we ird/sp ace.txt', ' lead.txt', 'ünï/日本.txt'];
  for (const n of names) put(repo, n, 'x');
  const s = takeSnapshot(repo);
  for (const n of names) assert.ok(ent(s, n), JSON.stringify(n));
  put(repo, 'we ird/sp ace.txt', 'y');
  assert.deepEqual(paths(verdict(s, repo)), ['content:we ird/sp ace.txt']);
});

test('adversarial paths: a newline in a name (POSIX only; Windows forbids control characters)', { skip: win && 'Windows forbids control characters in file names' }, (t) => {
  const { repo } = fixture(t);
  put(repo, 'we ird/new\nline.txt', 'x'); const s = takeSnapshot(repo);
  assert.ok(ent(s, 'we ird/new\nline.txt'));
  put(repo, 'we ird/new\nline.txt', 'y');
  assert.deepEqual(paths(verdict(s, repo)), ['content:we ird/new\nline.txt']);
});

test('case siblings stay separate entries where the filesystem is case-sensitive', { skip: CASE_INSENSITIVE && 'case-insensitive filesystem' }, (t) => {
  const { repo } = fixture(t);
  put(repo, 'Case.txt', '1'); put(repo, 'case.txt', '2'); const s = takeSnapshot(repo);
  assert.ok(ent(s, 'Case.txt') && ent(s, 'case.txt'));
  put(repo, 'case.txt', '3'); assert.deepEqual(paths(verdict(s, repo)), ['content:case.txt']);
});

test('invalid-UTF-8 path and binary content are hashed, not skipped', { skip: (win || process.platform === 'darwin') && 'filesystem rejects non-UTF-8 names' }, (t) => {
  const { repo } = fixture(t);
  writeFileSync(Buffer.concat([Buffer.from(repo + '/'), Buffer.from([0x66, 0xff, 0x2e, 0x62, 0x69, 0x6e])]), Buffer.from([0, 255, 254]));
  const s = takeSnapshot(repo);
  assert.ok(s.entries.some((e) => e.p.startsWith('66ff') && e.k === 'file'));
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
  assert.equal(s.identity, takeSnapshot(repo).identity); assert.ok(s.entries.some((e) => e.n === 'a.txt'));
});

test('sparse / skip-worktree: a tracked path missing from disk is a recorded state, and its restoration is a change', (t) => {
  const { repo } = fixture(t);
  git(repo, 'update-index', '--skip-worktree', 'a.txt'); rmSync(join(repo, 'a.txt'));
  const s = takeSnapshot(repo);
  assert.equal(ent(s, 'a.txt').k, 'missing');
  put(repo, 'a.txt', 'back\n');
  assert.deepEqual(paths(verdict(s, repo)), ['kind:a.txt']);
  git(repo, 'update-index', '--no-skip-worktree', 'a.txt'); // the flag itself lives in the index hash
  assert.ok(verdict(s, repo).changed.some((c) => c.what === 'index'));
});

test('FAIL-CLOSED: an unreadable path (file, or file under an unsearchable directory) is unknown (exit 1), not unchanged', { skip: POSIX_PERMS }, (t) => {
  const { dir, repo } = fixture(t);
  put(repo, 'sub/x.txt', 'x'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'sub');
  for (const [target, back, expected] of [['a.txt', 0o644, 'unknown:a.txt'], ['sub', 0o755, 'unknown:sub/x.txt']]) {
    const f = join(dir, 's-' + target + '.json'); cli('snapshot', '--repo', repo, '--out', f);
    chmodSync(join(repo, target), 0o000);
    try {
      const r = cli('compare', '--before', f, '--repo', repo);
      assert.equal(r.status, 1); assert.equal(r.out.result, 'unknown');
      assert.ok(paths(r.out).includes(expected) || /warned|failed|unreadable/.test(r.out.reason ?? ''), JSON.stringify(r.out)); // per-path unknown, or git's own warning failed the snapshot
    } finally { chmodSync(join(repo, target), back); }
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

// ---- repair batch (review of ddb1004) ----------------------------------------------------------------------------

test('fix2 a NEW unreadable directory that git skips is unknown, never unchanged (000 and 100)', { skip: POSIX_PERMS }, (t) => {
  const { dir, repo } = fixture(t);
  const f = join(dir, 's.json'); assert.equal(cli('snapshot', '--repo', repo, '--out', f).status, 0);
  for (const mode of [0o000, 0o100]) {
    const d = join(repo, 'newdir' + mode); put(repo, 'newdir' + mode + '/payload.js', 'evil'); chmodSync(d, mode);
    try {
      const r = cli('compare', '--before', f, '--repo', repo);
      assert.equal(r.status, 1, mode.toString(8)); assert.equal(r.out.result, 'unknown', mode.toString(8));
    } finally { chmodSync(d, 0o755); rmSync(d, { recursive: true }); }
  }
});

test('fix2 siblings: a new EMPTY directory and a new empty nested file are changes (they alter what is enumerated)', (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  mkdirSync(join(repo, 'emptydir'));
  assert.deepEqual(paths(verdict(s, repo)), ['added:emptydir']);
});

test('fix2 git stderr is not discarded: a listing warning makes the snapshot fail, not pass', { skip: POSIX_PERMS }, (t) => {
  const { dir, repo } = fixture(t);
  put(repo, 'up/x.txt', 'x'); const d = join(repo, 'up'); chmodSync(d, 0o000);
  try {
    const r = cli('snapshot', '--repo', repo, '--out', join(dir, 'o.json'));
    assert.equal(r.status, 1); assert.equal(r.out.result, 'unknown'); assert.match(r.out.reason, /warned|permission/i);
  } finally { chmodSync(d, 0o755); }
});

test('fix3 --out inside the checked tree (relative, ./, absolute, via symlink, in .git) is REJECTED and nothing is written', (t) => {
  const { dir, repo } = fixture(t);
  const before = readFileSync(join(repo, 'a.txt'), 'utf8');
  cliCwd = repo; t.after(() => { cliCwd = undefined; });
  const cases = ['a.txt', './rec.json', 'sub/../rec2.json', join(repo, 'rec3.json'), '.git/rec4.json', join(repo, '.git', 'rec5.json')];
  if (!win) { symlinkSync(repo, join(dir, 'tolink')); cases.push(join(dir, 'tolink', 'rec6.json')); symlinkSync(join(repo, 'a.txt'), join(dir, 'filelink')); cases.push(join(dir, 'filelink')); }
  for (const out of cases) {
    const r = cli('snapshot', '--repo', repo, '--out', out);
    assert.equal(r.status, 1, out); assert.match(r.out.reason, /inside the checked tree/, out);
  }
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), before); assert.equal(existsSync(join(repo, 'rec.json')), false);
  assert.equal(cli('snapshot', '--repo', repo, '--out', join(dir, 'ok.json')).status, 0); // outside is fine
});

test('fix3 --out: a differently-cased spelling of the tree is rejected on a case-insensitive filesystem', { skip: !CASE_INSENSITIVE && 'case-sensitive filesystem' }, (t) => {
  const { repo } = fixture(t);
  const r = cli('snapshot', '--repo', repo, '--out', join(repo.toUpperCase(), 'rec.json'));
  assert.equal(r.status, 1); assert.match(r.out.reason, /inside the checked tree/); assert.equal(existsSync(join(repo, 'rec.json')), false);
});

test('fix4 intent-to-add -> full add of an empty file changes the index digest; assume-unchanged toggles too', (t) => {
  const { repo } = fixture(t);
  put(repo, 'empty.txt', '');
  git(repo, 'add', '-N', 'empty.txt');
  let s = takeSnapshot(repo);
  git(repo, 'add', 'empty.txt');
  assert.deepEqual(paths(verdict(s, repo)), ['index:null']);
  s = takeSnapshot(repo);
  git(repo, 'update-index', '--assume-unchanged', 'a.txt');
  assert.deepEqual(paths(verdict(s, repo)), ['index:null']);
  s = takeSnapshot(repo);
  git(repo, 'update-index', '--no-assume-unchanged', 'a.txt');
  assert.deepEqual(paths(verdict(s, repo)), ['index:null']);
});

test('fix5 path keys are prefix-free: a literal "hex:..." name cannot collide with a non-UTF-8 name', { skip: (win || process.platform === 'darwin') && 'filesystem rejects non-UTF-8 names' }, (t) => {
  const { repo } = fixture(t);
  writeFileSync(Buffer.concat([Buffer.from(repo + '/'), Buffer.from([0x66, 0xff, 0x2e, 0x62, 0x69, 0x6e])]), 'one');
  put(repo, 'hex:66ff2e62696e', 'two');
  const s = takeSnapshot(repo);
  assert.equal(new Set(s.entries.map((e) => e.p)).size, s.entries.length);
  writeFileSync(Buffer.concat([Buffer.from(repo + '/'), Buffer.from([0x66, 0xff, 0x2e, 0x62, 0x69, 0x6e])]), 'ONE');
  assert.equal(verdict(s, repo).result, 'changed');
});

test('fix5 siblings: every key is hex of the raw bytes (ASCII, unicode, newline)', (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  for (const e of s.entries) assert.equal(e.p, Buffer.from(e.n, 'utf8').toString('hex'));
});

test('fix6 a case-only rename of a tracked file is a change on a case-insensitive filesystem', { skip: !CASE_INSENSITIVE && 'case-sensitive filesystem: a case-only rename is a delete+add and is covered by the generic test' }, (t) => {
  const { repo } = fixture(t);
  git(repo, 'config', 'core.ignorecase', 'true');
  const s = takeSnapshot(repo);
  renameSync(join(repo, 'a.txt'), join(repo, 'A.txt'));
  assert.equal(verdict(s, repo).result, 'changed');
});

test('fix7 malformed records are invalid (unknown, exit 1): the counterexample and several truncations', (t) => {
  const { dir, repo } = fixture(t);
  const bad = { schema: 'tree-snapshot/1', entries: [], head: {} };
  assert.equal(compareSnapshots(bad, bad).result, 'unknown');
  const f = join(dir, 'bad.json'); writeFileSync(f, JSON.stringify(bad));
  const r = cli('compare', '--before', f, '--after', f); assert.equal(r.status, 1); assert.equal(r.out.result, 'unknown');
  const good = takeSnapshot(repo);
  assert.equal(validateSnapshot(good), null);
  const drop = (k) => { const c = { ...good }; delete c[k]; return c; };
  for (const k of ['top', 'head', 'refs', 'index', 'config', 'identity', 'entries', 'mode_checked', 'excludes', 'hooks']) { assert.ok(validateSnapshot(drop(k)), 'missing ' + k); assert.equal(compareSnapshots(good, drop(k)).result, 'unknown', k); }
  const mut = [
    { ...good, refs: 'zz' }, { ...good, refs: [1] }, { ...good, head: { ...good.head, sha: 'nothex' } }, { ...good, identity: '0'.repeat(64) },
    { ...good, entries: [good.entries[1], good.entries[0], ...good.entries.slice(2)] }, // unordered
    { ...good, entries: [good.entries[0], good.entries[0], ...good.entries.slice(1)] }, // duplicate
    { ...good, entries: [{ ...good.entries[0], h: 'short' }, ...good.entries.slice(1)] },
    { ...good, entries: [{ ...good.entries[0], k: 'weird' }, ...good.entries.slice(1)] },
    { ...good, entries: [{ p: good.entries[0].p, k: 'file' }, ...good.entries.slice(1)] },
    { ...good, mode_checked: 'yes' }, null, [], 'x',
  ];
  for (const m of mut) { assert.ok(m === null || validateSnapshot(m), JSON.stringify(m)?.slice(0, 60)); assert.equal(compareSnapshots(good, m).result, 'unknown'); }
});

test('fix9 ignore rules are part of the record: an untracked .gitignore, .git/info/exclude and core.excludesFile', (t) => {
  const { dir, repo } = fixture(t);
  put(repo, 'src/keep.js', '1'); let s = takeSnapshot(repo);
  put(repo, 'src/.gitignore', '*\n'); // ignores itself and everything beside it
  assert.equal(verdict(s, repo).result, 'changed');
  s = takeSnapshot(repo);
  put(repo, 'src/.gitignore', '*\n# edited\n'); // an IGNORED .gitignore edited in place
  assert.equal(verdict(s, repo).result, 'changed');
  s = takeSnapshot(repo);
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'secret\n');
  assert.equal(verdict(s, repo).result, 'changed');
  const ex = join(dir, 'global-ignore'); writeFileSync(ex, 'a\n'); git(repo, 'config', 'core.excludesFile', ex);
  s = takeSnapshot(repo); writeFileSync(ex, 'a\nb\n');
  assert.equal(verdict(s, repo).result, 'changed');
});

test('fix9 hooks directory is hashed (detective)', { skip: win && 'hook files need no exec bit here but are skipped on Windows CI' }, (t) => {
  const { repo } = fixture(t);
  const s = takeSnapshot(repo);
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho x\n');
  assert.equal(verdict(s, repo).result, 'changed');
});

test('INVARIANT: every difference git would see, or that changes what is enumerated, is never reported unchanged', (t) => {
  const mutators = {
    edit: (r) => put(r, 'a.txt', 'edited\n'),
    'delete-tracked': (r) => rmSync(join(r, 'a.txt')),
    'new-untracked': (r) => put(r, 'n.txt', 'n'),
    'new-nested': (r) => put(r, 'd/e/f.txt', 'n'),
    'new-empty-dir': (r) => mkdirSync(join(r, 'ed')),
    'stage-edit': (r) => { put(r, 'a.txt', 'staged\n'); git(r, 'add', 'a.txt'); },
    'unstage': (r) => git(r, 'rm', '-q', '--cached', 'a.txt'),
    'add-N': (r) => { put(r, 'z.txt', ''); git(r, 'add', '-N', 'z.txt'); },
    'assume-unchanged': (r) => git(r, 'update-index', '--assume-unchanged', 'a.txt'),
    'skip-worktree': (r) => git(r, 'update-index', '--skip-worktree', 'a.txt'),
    commit: (r) => { put(r, 'a.txt', 'c\n'); git(r, 'commit', '-q', '-am', 'c'); },
    branch: (r) => git(r, 'branch', 'side'), // shared state: tree verdict stays unchanged, shared_git reports it
    'file-to-dir': (r) => { rmSync(join(r, 'a.txt')); mkdirSync(join(r, 'a.txt')); put(r, 'a.txt/in', 'x'); },
    ...(win ? {} : {
      'chmod-u-x': (r) => chmodSync(join(r, 'b.sh'), 0o655),
      'chmod-u+x': (r) => chmodSync(join(r, 'a.txt'), 0o744),
      symlink: (r) => { rmSync(join(r, 'a.txt')); symlinkSync('b.sh', join(r, 'a.txt')); },
      ...(isRoot ? {} : { 'unreadable-new-dir': (r) => { put(r, 'ud/p', 'x'); chmodSync(join(r, 'ud'), 0o000); } }),
    }),
    ...(CASE_INSENSITIVE ? { 'case-rename': (r) => renameSync(join(r, 'a.txt'), join(r, 'A.txt')) } : {}),
  };
  // the independent observation: what git reports, plus a raw directory listing with the owner exec bit
  const observe = (r) => {
    const g = (...a) => { try { return git(r, ...a); } catch { return 'ERR'; } };
    let listing; try { listing = readdirSync(r, { recursive: true, encoding: 'utf8' }); } catch { listing = ['ERR']; }
    listing = listing.filter((n) => !/^\.git([\\/]|$)/.test(n)).sort().map((n) => { try { const st = lstatSync(join(r, n)); return n + ':' + (st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : (st.mode & 0o100) ? 'x' : 'f'); } catch { return n + ':?'; } });
    return JSON.stringify([g('status', '--porcelain=v2', '-uall', '--ignored=no'), g('ls-files', '-s'), g('ls-files', '-v'), g('ls-files', '--debug').replace(/^ +(ctime|mtime|dev|uid|size).*$/gm, '').replace(/flags: /g, 'flags:'), g('diff', 'HEAD', '--raw'), g('for-each-ref'), listing]);
  };
  for (const [name, mutate] of Object.entries(mutators)) {
    const { repo } = fixture(t);
    const s = takeSnapshot(repo); const o1 = observe(repo);
    mutate(repo);
    let o2;
    try {
      o2 = observe(repo);
      assert.notEqual(o1, o2, name + ': the mutator must be observable');
      if (name === 'unreadable-new-dir') assert.throws(() => verdict(s, repo), /warned|permission/i, name); // fail-closed: the tool refuses
      else if (name === 'branch') { const v = verdict(s, repo); assert.equal(v.result, 'unchanged', name); assert.equal(v.shared_git.result, 'changed', name); }
      else assert.equal(verdict(s, repo).result, 'changed', name); // any tool error or `unknown` here FAILS the test
    } finally { try { chmodSync(join(repo, 'ud'), 0o755); } catch { /* absent */ } }
  }
  // the control: a group-bit-only change is invisible to git AND to the snapshot
  if (!win) { const { repo } = fixture(t); const s = takeSnapshot(repo); const o1 = observe(repo); chmodSync(join(repo, 'a.txt'), 0o664); assert.equal(observe(repo), o1); assert.equal(verdict(s, repo).result, 'unchanged'); }
});

// ---- confirmation-repair batch ----------------------------------------------------------------------------------
const outN = (() => { let n = 0; return (dir) => join(dir, `rec${n++}.json`); })();

test('c1 --out never opens an existing file: a hard link to a tracked file, an existing file and a symlink are refused and untouched', { skip: win && 'symlink/hard-link semantics are exercised on POSIX; Windows CI covers the plain path' }, (t) => {
  const { dir, repo } = fixture(t);
  const before = readFileSync(join(repo, 'a.txt'), 'utf8');
  linkSync(join(repo, 'a.txt'), join(dir, 'ext-hardlink')); // an alias of a tracked inode, outside the tree
  writeFileSync(join(dir, 'existing.json'), 'keep');
  symlinkSync(join(dir, 'existing.json'), join(dir, 'ln.json'));
  for (const out of ['ext-hardlink', 'existing.json', 'ln.json']) {
    const r = cli('snapshot', '--repo', repo, '--out', join(dir, out));
    assert.equal(r.status, 1, out); assert.match(r.out.reason, /exists/, out);
  }
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), before); assert.equal(readFileSync(join(dir, 'existing.json'), 'utf8'), 'keep');
  const ok = outN(dir); assert.equal(cli('snapshot', '--repo', repo, '--out', ok).status, 0);
  assert.equal(validateSnapshot(JSON.parse(readFileSync(ok, 'utf8'))), null);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp')), []); // no temp file left behind
});

test('c2 a directory occupying a tracked path is enumerated: a.txt -> empty dir, then a.txt/empty/ created', (t) => {
  const { repo } = fixture(t);
  rmSync(join(repo, 'a.txt')); mkdirSync(join(repo, 'a.txt'));
  const s = takeSnapshot(repo);
  assert.equal(ent(s, 'a.txt').k, 'dir');
  mkdirSync(join(repo, 'a.txt', 'empty'));
  assert.deepEqual(paths(verdict(s, repo)), ['added:a.txt/empty']);
});

test('c2 siblings: a file inside such a directory, and an ordinary directory in place of a tracked file, are changes', (t) => {
  const { repo } = fixture(t);
  const s0 = takeSnapshot(repo);
  rmSync(join(repo, 'a.txt')); mkdirSync(join(repo, 'a.txt'));
  assert.ok(paths(verdict(s0, repo)).includes('kind:a.txt'));
  const s = takeSnapshot(repo); put(repo, 'a.txt/in.txt', 'x');
  assert.deepEqual(paths(verdict(s, repo)), ['added:a.txt/in.txt']);
});

const hooksDir = (repo) => join(repo, '.git', 'hooks');
test('c3 hook mode (owner exec bit), kind, subdirectories and symlinks are part of the hooks digest', { skip: win && 'no exec bit on Windows' }, (t) => {
  const { repo } = fixture(t);
  const h = join(hooksDir(repo), 'pre-commit'); writeFileSync(h, '#!/bin/sh\n'); chmodSync(h, 0o644);
  let s = takeSnapshot(repo); chmodSync(h, 0o755);
  assert.deepEqual(paths(verdict(s, repo)), ['hooks:null']);
  mkdirSync(join(hooksDir(repo), 'sub')); writeFileSync(join(hooksDir(repo), 'sub', 'x'), '1'); // a subdirectory must not make the tool fail
  s = takeSnapshot(repo); writeFileSync(join(hooksDir(repo), 'sub', 'x'), '2');
  assert.deepEqual(paths(verdict(s, repo)), ['hooks:null']);
  symlinkSync('pre-commit', join(hooksDir(repo), 'link')); s = takeSnapshot(repo);
  rmSync(join(hooksDir(repo), 'link')); symlinkSync('other', join(hooksDir(repo), 'link'));
  assert.deepEqual(paths(verdict(s, repo)), ['hooks:null']);
});

test('c4 a RELATIVE core.excludesFile resolves against the tree top, whatever the caller cwd; a configured but missing file is unknown', (t) => {
  const { dir, repo } = fixture(t);
  git(repo, 'config', 'core.excludesFile', '.git/info/custom-ignore');
  writeFileSync(join(repo, '.git', 'info', 'custom-ignore'), 'one\n');
  cliCwd = dir; t.after(() => { cliCwd = undefined; });
  const f = outN(dir); assert.equal(cli('snapshot', '--repo', repo, '--out', f).status, 0);
  writeFileSync(join(repo, '.git', 'info', 'custom-ignore'), 'one\n# comment\n');
  const r = cli('compare', '--before', f, '--repo', repo);
  assert.equal(r.status, 1); assert.deepEqual(r.out.changed.map((c) => c.what), ['excludes']);
  rmSync(join(repo, '.git', 'info', 'custom-ignore'));
  const m = cli('compare', '--before', f, '--repo', repo); assert.equal(m.status, 1); assert.equal(m.out.result, 'unknown');
});

test('c5 shared git state is reported separately: a sibling-worktree commit and a fetch leave the tree unchanged (exit 0) but name the refs', { skip: win && 'worktree/remote fixtures run on POSIX' }, (t) => {
  const { dir, repo } = fixture(t);
  const wt = join(dir, 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'other', wt);
  const remote = join(dir, 'remote.git'); git(dir, 'init', '-q', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', 'origin', 'main');
  const f = outN(dir); assert.equal(cli('snapshot', '--repo', repo, '--out', f).status, 0);
  put(wt, 'w.txt', 'w'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'sibling'); // sibling worktree commit
  const clone = join(dir, 'clone'); git(dir, 'clone', '-q', remote, clone); put(clone, 'c.txt', 'c'); git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'c'); git(clone, 'push', '-q', 'origin', 'HEAD:main');
  git(repo, 'fetch', '-q', 'origin'); // fetch moves refs/remotes/origin/main
  let r = cli('compare', '--before', f, '--repo', repo);
  assert.equal(r.status, 0); assert.equal(r.out.result, 'unchanged'); assert.equal(r.out.shared_git.result, 'changed');
  const names = r.out.shared_git.refs.map((x) => x.ref); // (git may also create origin/HEAD)
  assert.ok(names.includes('refs/heads/other') && names.includes('refs/remotes/origin/main'), names.join());
  r = cli('compare', '--before', f, '--repo', repo, '--strict-shared'); assert.equal(r.status, 1); assert.equal(r.out.result, 'changed');
  const f2 = outN(dir); cli('snapshot', '--repo', repo, '--out', f2); git(repo, 'branch', 'by-lane');
  r = cli('compare', '--before', f2, '--repo', repo); assert.equal(r.status, 0); assert.deepEqual(r.out.shared_git.refs.map((x) => x.ref), ['refs/heads/by-lane']);
  git(repo, 'branch', '-q', '-D', 'by-lane'); const quiet = cli('compare', '--before', f2, '--repo', repo); assert.equal(quiet.out.shared_git.result, 'unchanged');
});

test('c6 files are hashed in chunks (no whole-file Buffer): a multi-chunk file hashes like sha256, and a one-byte edit past the first chunk is seen', (t) => {
  const { repo } = fixture(t);
  const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7); put(repo, 'big.bin', ''); writeFileSync(join(repo, 'big.bin'), big);
  const s = takeSnapshot(repo);
  assert.equal(ent(s, 'big.bin').h, createHash('sha256').update(big).digest('hex'));
  big[big.length - 1] = 8; writeFileSync(join(repo, 'big.bin'), big);
  assert.deepEqual(paths(verdict(s, repo)), ['content:big.bin']);
});

test('c6 the CLI parser rejects a flag-shaped value (usage, exit 2) instead of consuming it', (t) => {
  const { dir, repo } = fixture(t);
  assert.equal(cli('snapshot', '--repo', repo, '--lane', '--out').status, 2); // without the rule: lane = "--out", a success
  assert.equal(cli('snapshot', '--repo', '--lane', 'x').status, 2);
  const f = outN(dir); assert.equal(cli('snapshot', '--repo', repo, '--out', f).status, 0);
  assert.equal(cli('compare', '--before', f, '--after', '--repo').status, 2); // without the rule: after = "--repo", a read failure (exit 1)
});
