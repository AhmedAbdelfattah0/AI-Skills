import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDispatch, dispatch } from './carrier.mjs';
import { summarizeUsage } from './usage.mjs';
const base = { phase: 'BUILD', provider: 'claude', approved: true, approvedPlanId: 'plan-v1',
  workdir: '/tmp', ownership: { writes: ['src'] }, args: ['--version'], timeoutMs: 10000 };
test('carrier rejects PLAN, REVIEW and unapproved work', () => {
  assert.throws(() => prepareDispatch({ ...base, phase: 'PLAN' }), /cannot be dispatched/);
  assert.throws(() => prepareDispatch({ ...base, phase: 'REVIEW' }), /cannot be dispatched/);
  assert.throws(() => prepareDispatch({ ...base, approved: false }), /approved plan/);
});
test('provider routing respects security and does not invent model flags', () => {
  const p = prepareDispatch({ ...base, risk: ['auth'], modelTier: 'economy' });
  assert.equal(p.modelTier, 'strong');
  assert.deepEqual(p.args, ['--version']);
  assert.equal(p.mappedModel, null);
});
test('carrier emits metadata only, never raw stdout or stderr', () => {
  const r = dispatch(base, () => ({ status: 0, stdout: 'secret', stderr: 'token' }));
  assert.equal(r.succeeded, true);
  assert.equal(JSON.stringify(r).includes('secret'), false);
  assert.equal(JSON.stringify(r).includes('token'), false);
});
test('usage preserves unknown counts and rejects invalid counters', () => {
  const r = summarizeUsage([{ provider: 'claude', run_id: 'a', input_tokens: 10 },
    { provider: 'claude', run_id: 'a', output_tokens: 3 }]);
  assert.equal(r.providers.claude.input_tokens, 10);
  assert.equal(r.providers.claude.output_tokens, 3);
  assert.equal(r.providers.claude.reported_cost_usd, null);
  assert.throws(() => summarizeUsage([{ provider: 'claude', run_id: 'a', input_tokens: -1 }]), /invalid usage/);
});
