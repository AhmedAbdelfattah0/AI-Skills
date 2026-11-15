/**
 * git-guard.mjs: the opt-in per-repository pre-push guard (P0 slice E1). Every repository here is a
 * temp repo with a local bare remote and an isolated global git config; nothing touches a real
 * repository, global config or hooks directory. The bypass rows are EXPECTED and documented: the
 * guard is a guardrail on the supported path, not a security boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POSIX } from './engine-test-fixture.mjs';
import { enrollFixture } from './engine-enroll.test-helper.mjs';
import { BACKUP, MARKER, ticketOf, TICKET_PATTERN } from './git-guard.mjs';

const WIN_SKIP = POSIX ? false : 'sh pre-push hooks and the POSIX engine';
const GUARD = fileURLToPath(new URL('./git-guard.mjs', import.meta.url));
const guard = (fx, args, env = fx.env) => spawnSync(process.execPath, [GUARD, ...args, '--repo', fx.repo], { encoding: 'utf8', env });
const installed = (fx, extra = []) => { const r = guard(fx, ['install', ...extra]); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const push = (fx, args, env = fx.env) => spawnSync('git', ['push', ...args], { cwd: fx.repo, encoding: 'utf8', env });
const blocked = (r, code) => { assert.notEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stderr, new RegExp(`git-guard: push of refs/heads/\\S+ blocked \\(T-1\\): ${code}`)); };

test('ticketOf: the default pattern finds the ticket in every documented branch shape', () => {
  const shapes = { 'T-1-work': 'T-1', 'SCRUM-140': 'SCRUM-140', 'feat/SCRUM-140-x': 'SCRUM-140', 'feature/AB-1': 'AB-1',
    'AIS-BENCH-1-x': 'AIS-BENCH-1', 'fix/AIS-BENCH-1-phase0-slice2': 'AIS-BENCH-1', 'SCRUM-140-fix-2': 'SCRUM-140', 'feat/AIS-12-x': 'AIS-12',
    'feature-x': null, main: null, 'release/v2': null };
  for (const [branch, ticket] of Object.entries(shapes)) assert.equal(ticketOf(branch, TICKET_PATTERN), ticket, branch);
  assert.equal(ticketOf('feat/AIS-12-x', '^feat/([A-Z]+-[0-9]+)'), 'AIS-12');
});

test('install backs up an existing pre-push hook, runs it first, and uninstall restores it', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  const hooks = join(fx.repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const mine = '#!/bin/sh\necho "user hook ran" >&2\nexit 0\n';
  writeFileSync(join(hooks, 'pre-push'), mine);
  chmodSync(join(hooks, 'pre-push'), 0o755);
  const r = installed(fx);
  assert.equal(r.backed_up, true);
  assert.ok(readFileSync(join(hooks, 'pre-push'), 'utf8').includes(MARKER));
  assert.equal(readFileSync(join(hooks, BACKUP), 'utf8'), mine);
  assert.equal(JSON.parse(guard(fx, ['status']).stdout).installed, true);
  // idempotent: a second install keeps the one backup
  assert.equal(installed(fx).backed_up, false);
  // the user's hook still runs (on a non-ticket push that the guard lets through)
  fx.okGit(['checkout', '-q', '-b', 'feature-x']);
  const p = push(fx, ['origin', 'feature-x']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /user hook ran/);
  const u = guard(fx, ['uninstall']);
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(JSON.parse(u.stdout), { installed: false, removed: true, restored: true });
  assert.equal(readFileSync(join(hooks, 'pre-push'), 'utf8'), mine);
  assert.equal(existsSync(join(hooks, BACKUP)), false);
  // uninstall never removes a hook it did not write
  const again = guard(fx, ['uninstall']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /not_ours/);
});

test('install refuses a shared (global) core.hooksPath and uses a repository-local one', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  writeFileSync(fx.env.GIT_CONFIG_GLOBAL, `[core]\n\thooksPath = ${join(fx.root, 'shared-hooks')}\n`);
  const r = guard(fx, ['install']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hooks_path_shared/);
  assert.equal(existsSync(join(fx.root, 'shared-hooks', 'pre-push')), false);
  writeFileSync(fx.env.GIT_CONFIG_GLOBAL, '');
  fx.okGit(['config', '--local', 'core.hooksPath', '.githooks']);
  appendFileSync(join(fx.repo, '.git', 'info', 'exclude'), '.githooks/\n'); // an in-tree hooks dir must be ignored (M3)
  const ok = installed(fx);
  assert.equal(ok.hook, join(fx.repo, '.githooks', 'pre-push'));
  assert.equal(existsSync(join(fx.repo, '.git', 'hooks', 'pre-push')), false);
});

test('fail closed: a ticket branch with no enrollment cannot be pushed; other branches and tags are untouched', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  installed(fx);
  blocked(push(fx, ['origin', 'T-1-work']), 'not_enrolled');
  assert.equal(fx.remoteHead(), null);
  fx.okGit(['tag', 'v1']);
  assert.equal(push(fx, ['origin', 'v1']).status, 0, 'tags pass');
  fx.okGit(['branch', 'feature-x']);
  assert.equal(push(fx, ['origin', 'feature-x']).status, 0, 'non-ticket branches pass');
  // an admitted run with no engine SHIP_READY is denied by authorize itself
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  blocked(push(fx, ['origin', 'T-1-work']), 'ship_ready_missing');
  // a malformed engine state fails closed
  writeFileSync(fx.stateFile(), '{');
  blocked(push(fx, ['origin', 'T-1-work']), 'not_enrolled');
});

test('wrapped pushes still run the hook and are blocked; the documented bypasses get through', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  installed(fx);
  const wrapped = {
    'sh -c': () => spawnSync('sh', ['-c', 'git push origin T-1-work'], { cwd: fx.repo, encoding: 'utf8', env: fx.env }),
    'bash -c': () => spawnSync('bash', ['-c', 'git push origin T-1-work'], { cwd: fx.repo, encoding: 'utf8', env: fx.env }),
    'node execSync': () => spawnSync(process.execPath, ['-e', "require('child_process').execSync('git push origin T-1-work', { stdio: 'inherit' })"],
      { cwd: fx.repo, encoding: 'utf8', env: fx.env }),
    script: () => { const f = join(fx.root, 'ship.sh'); writeFileSync(f, '#!/bin/sh\ngit push origin T-1-work\n'); chmodSync(f, 0o755);
      return spawnSync(f, [], { cwd: fx.repo, encoding: 'utf8', env: fx.env }); },
  };
  for (const [name, run] of Object.entries(wrapped)) {
    const r = run();
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /git-guard: push of refs\/heads\/T-1-work blocked/, name);
    assert.equal(fx.remoteHead(), null, `${name} pushed nothing`);
  }
  // EXPECTED BYPASSES (guardrail, not boundary): each one reaches the remote without authorization.
  const bypass = (name, r) => { assert.equal(r.status, 0, `${name}: ${r.stderr}`); assert.equal(fx.remoteHead(), fx.head(), name);
    assert.equal(spawnSync('git', ['--git-dir', fx.remote, 'update-ref', '-d', 'refs/heads/T-1-work']).status, 0); };
  bypass('--no-verify', push(fx, ['--no-verify', 'origin', 'T-1-work']));
  bypass('-c core.hooksPath=/dev/null', spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'T-1-work'], { cwd: fx.repo, encoding: 'utf8', env: fx.env }));
  bypass('GIT_CONFIG_* env', push(fx, ['origin', 'T-1-work'], { ...fx.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' }));
  // a guard installed into a repository core.hooksPath is dropped by unsetting it
  assert.equal(guard(fx, ['uninstall']).status, 0);
  fx.okGit(['config', '--local', 'core.hooksPath', '.githooks']);
  appendFileSync(join(fx.repo, '.git', 'info', 'exclude'), '.githooks/\n');
  installed(fx);
  blocked(push(fx, ['origin', 'T-1-work']), 'not_enrolled');
  fx.okGit(['config', '--local', '--unset', 'core.hooksPath']);
  bypass('unset core.hooksPath', push(fx, ['origin', 'T-1-work']));
});

test('an authorized run: publish pushes through the installed guard (no lock re-entry); a different sha is push_not_head', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  fx.toShipReady();
  fx.commitAll();
  installed(fx);
  // pushing an older sha to the ticket branch is not the authorized HEAD
  blocked(push(fx, ['origin', 'HEAD~1:refs/heads/T-1-work']), 'push_not_head');
  const p = fx.cli('publish', {});
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.equal(p.out.code, 'published');
  assert.equal(fx.remoteHead(), fx.head());
  // a plain git push of the authorized HEAD is allowed by the guard too
  fx.okGit(['branch', 'T-1-copy']);
  assert.equal(push(fx, ['origin', 'T-1-copy']).status, 0);
  // a new unreviewed commit is blocked at the hook
  writeFileSync(join(fx.repo, 'src', 'a.txt'), 'after review');
  fx.commitAll('unreviewed');
  blocked(push(fx, ['origin', 'T-1-work']), 'candidate_stale');
  assert.notEqual(fx.remoteHead(), fx.head());
});

test('linked worktrees: installed from a linked worktree the hook lands in the common hooks dir and judges each work tree by its own engine state', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  fx.toShipReady();
  fx.commitAll();
  const wt = join(fx.root, 'wt');
  fx.okGit(['worktree', 'add', '-q', '-b', 'T-1-other', wt, 'HEAD']);
  const r = guard({ ...fx, repo: wt }, ['install']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hook, join(fx.repo, '.git', 'hooks', 'pre-push'), 'the common hooks directory');
  // the main work tree has an admitted, ship-ready run: its push is authorized
  assert.equal(push(fx, ['origin', 'T-1-work']).status, 0);
  assert.equal(fx.remoteHead(), fx.head());
  // the linked work tree has no engine state of its own (state is per work tree): fail closed
  const other = spawnSync('git', ['push', 'origin', 'T-1-other'], { cwd: wt, encoding: 'utf8', env: fx.env });
  blocked(other, 'not_enrolled');
  assert.equal(fx.remoteHead('T-1-other'), null);
});

// ------------------------------------------------------------------ review repair (H1, M3, M6, LOWs)

test('H1: a branch naming a ticket that has engine state is guarded whatever the pattern', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  installed(fx, ['--pattern', '^never-matches$']);
  blocked(push(fx, ['origin', 'T-1-work']), 'ship_ready_missing');
  fx.okGit(['branch', 'feat/T-1-more']);
  blocked(push(fx, ['origin', 'feat/T-1-more']), 'ship_ready_missing');
  fx.okGit(['branch', 'T-10-other']);
  assert.equal(push(fx, ['origin', 'T-10-other']).status, 0, 'T-10 is another ticket, not T-1');
});

test('M3: a hooks directory inside the work tree is refused unless ignored (.githooks, .husky; husky\'s ignored .husky/_ is fine)', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  for (const dir of ['.githooks', '.husky']) {
    fx.okGit(['config', '--local', 'core.hooksPath', dir]);
    const r = guard(fx, ['install']);
    assert.equal(r.status, 1, dir);
    assert.match(r.stderr, /hooks_dir_in_worktree/, dir);
    assert.equal(existsSync(join(fx.repo, dir, 'pre-push')), false, dir);
  }
  mkdirSync(join(fx.repo, '.husky', '_'), { recursive: true });
  writeFileSync(join(fx.repo, '.husky', '_', '.gitignore'), '*\n');
  fx.okGit(['config', '--local', 'core.hooksPath', '.husky/_']);
  installed(fx);
  assert.equal(fx.git(['status', '--porcelain']).stdout.includes('.husky/_'), false, 'the candidate stays clean');
});

test('M6: backup_exists refuses to overwrite an earlier backup', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  const hooks = join(fx.repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(hooks, BACKUP), '#!/bin/sh\nexit 0\n');
  const r = guard(fx, ['install']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /backup_exists/);
});

test('LOW: a sh backup hook keeps its $0 semantics (basename pre-push, the hooks dir), like husky expects', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  const hooks = join(fx.repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\necho "name=$(basename "$0") dir=$(dirname "$0") remote=$1" >&2\nexit 0\n');
  chmodSync(join(hooks, 'pre-push'), 0o755);
  installed(fx);
  fx.okGit(['branch', 'feature-x']);
  const p = push(fx, ['origin', 'feature-x']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /name=pre-push dir=\S*\.git\/hooks remote=origin/);
});

test('LOW: a moved guard script blocks only ticket-like branches, with the reinstall instruction', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  const r = installed(fx);
  writeFileSync(r.hook, readFileSync(r.hook, 'utf8').replace(GUARD, join(fx.root, 'moved', 'git-guard.mjs')));
  fx.okGit(['branch', 'feature-x']);
  assert.equal(push(fx, ['origin', 'feature-x']).status, 0, 'a non-ticket push is never blocked');
  const p = push(fx, ['origin', 'T-1-work']);
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /missing; run git-guard\.mjs install again/);
  assert.equal(fx.remoteHead(), null);
});

test('documented bypass: HEAD:refs/heads/<name without a ticket> is not guarded', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  installed(fx);
  const p = push(fx, ['origin', 'HEAD:refs/heads/shipped']);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(fx.remoteHead('shipped'), fx.head(), 'the unauthorized commit reached the remote under another name');
});
