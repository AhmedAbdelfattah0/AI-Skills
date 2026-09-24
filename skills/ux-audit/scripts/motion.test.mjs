import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMotion } from './lib/motion.mjs';

const reduced = (motions = []) => ({ motions });

test('motion classification exempts short color transitions and loading spinners', () => {
  const color = classifyMotion({ type: 'transition', name: 'color', durationMs: 150, properties: ['color'], loading: false }, reduced());
  assert.equal(color.exempt, true);
  assert.equal(color.reason, 'short-color-or-opacity-transition');
  const spinner = classifyMotion({ type: 'animation', name: 'spin', durationMs: 1000, properties: ['transform'], loading: true }, reduced());
  assert.equal(spinner.exempt, true);
  assert.equal(spinner.reason, 'loading-spinner');
});

test('long movement must reduce to ten milliseconds or less', () => {
  const failed = classifyMotion({ type: 'transition', name: 'transform', durationMs: 600, properties: ['transform'], loading: false },
    reduced([{ type: 'transition', name: 'transform', durationMs: 120, properties: ['transform'] }]));
  assert.equal(failed.nonEssential, true);
  assert.equal(failed.respected, false);
  const passed = classifyMotion({ type: 'animation', name: 'slide', durationMs: 400, properties: ['left'], loading: false }, reduced());
  assert.equal(passed.respected, true);
});
