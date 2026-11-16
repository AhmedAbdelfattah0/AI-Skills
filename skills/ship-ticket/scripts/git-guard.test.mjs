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
import { BACKUP, MARKER, ticketOf, TICKET_PATTERN, check } from './git-guard.mjs';

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
  // a plain git push of the authorized HEAD to the bound branch is allowed by the guard too; to another ticket-named branch it is not (R0-S A2)
  assert.equal(push(fx, ['origin', 'T-1-work']).status, 0);
  fx.okGit(['branch', 'T-1-copy']);
  blocked(push(fx, ['origin', 'T-1-copy']), 'push_destination_mismatch');
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
  // T-10 is another ticket, not T-1 (a branch at another commit: T-1's checked-out HEAD under any name is T-1's, R0-S A2).
  fx.okGit(['checkout', '-q', '-b', 'T-10-other']);
  fx.okGit(['commit', '-q', '--allow-empty', '-m', 'T-10 work']);
  fx.okGit(['checkout', '-q', 'T-1-work']);
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

test('R0-S A2: HEAD:refs/heads/<name without a ticket> is guarded by the checked-out ticket branch; a copy branch remains the documented bypass', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  installed(fx);
  const p = push(fx, ['origin', 'HEAD:refs/heads/shipped']);
  assert.notEqual(p.status, 0, p.stderr);
  assert.equal(fx.remoteHead('shipped'), null, 'the unauthorized commit never reached the remote under another name');
  fx.okGit(['branch', 'copy']);
  const c = push(fx, ['origin', 'copy:refs/heads/shipped']);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(fx.remoteHead('shipped'), fx.head(), 'documented bypass: a source branch naming no ticket, pushed to a name with none');
});

// ------------------------------------------------------------------ E1 follow-up (stacked base, URL remote, pattern limits)

test('stacked PR: the parent branch bound as config.base passes its own hook; --base naming any other ref is pr_base_unbound (R0-S batch 2: no --base laundering)', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t, { base: 'T-0-parent' });
  // The parent ticket's commit sits under this ticket's branch, and the approved DAG binds the parent as config.base.
  writeFileSync(join(fx.repo, 'docs', 'parent.txt'), 'parent work');
  fx.commitAll('parent ticket');
  fx.okGit(['branch', '-f', 'T-0-parent', 'HEAD']);
  fx.okGit(['push', '-q', '-f', 'origin', 'T-0-parent']); // the parent ticket's branch is published (round 3: the base is the remote's commit)
  fx.toShipReady();
  fx.commitAll();
  installed(fx);
  assert.equal(fx.cli('authorize', { stage: 'publish' }).out.binding.base, 'T-0-parent', 'the hook (no --base) judges the bound base');
  assert.equal(fx.cli('authorize', { stage: 'publish', base: fx.defaultBranch }).out.code, 'pr_base_unbound', 'a --base other than the bound one');
  const p = fx.cli('publish', { base: 'T-0-parent' });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.equal(p.out.code, 'published');
  assert.equal(fx.remoteHead(), fx.head(), 'the hook allowed the stacked push');
  assert.deepEqual([fx.readState().publish_intent.base, fx.readState().publish_intent.head], ['T-0-parent', fx.head()]);
  // With config.base HEAD a --base at the parent is refused before anything else: it would launder the parent commit.
  const h = enrollFixture(t);
  writeFileSync(join(h.repo, 'docs', 'parent.txt'), 'parent work');
  h.commitAll('parent ticket');
  h.okGit(['branch', 'T-0-parent']);
  h.toShipReady();
  h.commitAll();
  assert.equal(h.cli('authorize', { stage: 'publish' }).out.code, 'base_mismatch', 'the remote default branch: the parent commit is unreviewed');
  assert.equal(h.cli('authorize', { stage: 'publish', base: 'T-0-parent' }).out.code, 'pr_base_unbound');
  assert.equal(h.cli('publish', { base: 'T-0-parent' }).out.code, 'pr_base_unbound');
  assert.equal(h.remoteHead(), null);
});

test('git push <url>: the URL of a configured remote is judged as that remote; an unknown URL is identity_changed (round 4: the actual destination against the enrolled identity), never refs/remotes/<url>/HEAD', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  fx.toShipReady();
  fx.commitAll();
  installed(fx);
  const other = join(fx.root, 'other.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', other], { encoding: 'utf8', env: fx.env }).status, 0);
  blocked(push(fx, [other, 'T-1-work']), 'identity_changed');
  const r = push(fx, [fx.remote, 'T-1-work']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fx.remoteHead(), fx.head(), 'the URL of origin pushes under origin\'s authorization');
  assert.doesNotMatch(r.stderr + push(fx, [other, 'T-1-work']).stderr, /refs\/remotes\//);
});

test('pattern limits: fix/issue-42 and release-2026-11 are false positives (fail closed) until --pattern narrows it; a two-ticket branch is judged by one run', { skip: WIN_SKIP }, async (t) => {
  assert.equal(ticketOf('fix/issue-42', TICKET_PATTERN), 'issue-42');
  assert.equal(ticketOf('release-2026-11', TICKET_PATTERN), 'release-2026');
  const fx = enrollFixture(t);
  installed(fx);
  for (const b of ['fix/issue-42', 'release-2026-11']) {
    fx.okGit(['branch', b]);
    const p = push(fx, ['origin', b]);
    assert.notEqual(p.status, 0, b);
    assert.match(p.stderr, /not_enrolled/, b);
  }
  installed(fx, ['--pattern', '^(?:feat|fix)/([A-Z][A-Z0-9]*-[0-9]+)']);
  for (const b of ['fix/issue-42', 'release-2026-11']) assert.equal(push(fx, ['origin', b]).status, 0, `${b} after narrowing`);
  // One ticket per branch: only the first ticket with engine state (else the first the pattern finds) is consulted.
  assert.equal(fx.cli('init', { dag: fx.dagFile }).status, 0);
  const asked = [];
  const r = await check(fx.repo, `refs/heads/feat/T-2-T-1 ${'1'.repeat(40)} refs/heads/feat/T-2-T-1 ${'0'.repeat(40)}\n`,
    { authorizeFn: async (ctx) => { asked.push(ctx.ticket); return { allow: false, code: 'stub', reasons: [] }; } });
  assert.deepEqual([asked, r.decisions.map(d => d.ticket)], [['T-1'], ['T-1']], 'T-1 has state here, so T-2 is never consulted');
});
