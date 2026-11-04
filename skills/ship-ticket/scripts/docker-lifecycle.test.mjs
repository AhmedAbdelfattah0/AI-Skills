import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerArgs, ownedContainers, cleanupOwned } from './docker-lifecycle.mjs';
const id = 'abcdef123456';
const fake = (calls) => (_bin, args) => {
  calls.push(args);
  if (args[0] === 'ps') return { status: 0, stdout: id + '\n' };
  if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify({
    'ai-skills.ship-ticket.owner': 'owner', 'ai-skills.ship-ticket.run': 'run'
  }) };
  if (args[0] === 'rm') return { status: 0, stdout: id };
  return { status: 1, stdout: '' };
};
test('only exact owner and run labels are selected', () => {
  const args = dockerArgs('list', 'owner', 'run').join(' ');
  assert.match(args, /ai-skills.ship-ticket.owner=owner/);
  assert.match(args, /ai-skills.ship-ticket.run=run/);
  assert.throws(() => dockerArgs('list', 'owner;rm', 'run'));
});
test('default dry run never removes containers', () => {
  const calls = [];
  const r = cleanupOwned('owner', 'run', { spawn: fake(calls) });
  assert.equal(r.removed, 0);
  assert.equal(calls.length, 1);
});
test('apply rechecks labels before removing exact container', () => {
  const calls = [];
  const r = cleanupOwned('owner', 'run', { dryRun: false, spawn: fake(calls) });
  assert.equal(r.removed, 1);
  assert.deepEqual(calls.map(x => x[0]), ['ps', 'inspect', 'rm']);
});
test('rejects label mismatch without deleting anything', () => {
  const calls = [];
  const bad = (_bin, args) => {
    calls.push(args);
    return args[0] === 'ps' ? { status: 0, stdout: id } : { status: 0, stdout: '{}' };
  };
  assert.throws(() => cleanupOwned('owner', 'run', { dryRun: false, spawn: bad }), /ownership mismatch/);
  assert.deepEqual(calls.map(x => x[0]), ['ps', 'inspect']);
});
test('invalid Docker output is never used for removal', () => {
  assert.throws(() => ownedContainers('owner', 'run', () => ({ status: 0, stdout: 'oops' })), /unexpected/);
});
