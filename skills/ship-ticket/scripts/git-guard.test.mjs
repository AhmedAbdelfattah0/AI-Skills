/**
 * git-guard.mjs: the opt-in per-repository pre-push guard (P0 slice E1). Every repository here is a
 * temp repo with a local bare remote and an isolated global git config; nothing touches a real
 * repository, global config or hooks directory. The bypass rows are EXPECTED and documented: the
 * guard is a guardrail on the supported path, not a security boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
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

test('ticketOf: default pattern, capture groups and safe keys', () => {
  assert.equal(ticketOf('T-1-work', TICKET_PATTERN), 'T-1');
  assert.equal(ticketOf('SCRUM-140', TICKET_PATTERN), 'SCRUM-140');
  assert.equal(ticketOf('feature-x', TICKET_PATTERN), null);
  assert.equal(ticketOf('feat/AIS-12-x', TICKET_PATTERN), null, 'the default is anchored');
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
  // an enrolled run with no engine SHIP_READY is denied by authorize itself
  assert.equal(fx.cli('enroll', {}).status, 0);
  assert.equal(fx.cli('context', { phase: 'ship' }).status, 0);
  blocked(push(fx, ['origin', 'T-1-work']), 'engine_not_initialized');
  // a malformed ledger fails closed
  writeFileSync(fx.ledgerFile(), '{');
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
  installed(fx);
  blocked(push(fx, ['origin', 'T-1-work']), 'not_enrolled');
  fx.okGit(['config', '--local', '--unset', 'core.hooksPath']);
  bypass('unset core.hooksPath', push(fx, ['origin', 'T-1-work']));
});

test('an authorized run: publish pushes through the installed guard (no lock re-entry); a different sha is push_not_head', { skip: WIN_SKIP }, (t) => {
  const fx = enrollFixture(t);
  fx.toShipReady();
  fx.commitAll();
  assert.equal(fx.cli('context', { phase: 'ship' }).status, 0);
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
