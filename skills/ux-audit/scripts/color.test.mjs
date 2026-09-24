import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, parseColor, proposeCompliant, toOklch } from './lib/color.mjs';

test('known WCAG contrast ratios are accurate', () => {
  assert.equal(Number(contrastRatio(parseColor('#000'), parseColor('#fff')).toFixed(2)), 21);
  assert.ok(Math.abs(contrastRatio(parseColor('#777'), parseColor('#fff')) - 4.48) < 0.01);
});

test('CSS color syntaxes returned by computed styles are parsed', () => {
  for (const color of ['rgb(91, 141, 239)', 'rgba(91, 141, 239, 0.5)', '#5b8def',
    'hsl(219 82% 65%)', 'oklch(0.68 0.15 260 / 80%)']) {
    assert.ok(parseColor(color), color);
  }
});

test('compliant proposal reaches target while preserving OKLCH hue', () => {
  const source = toOklch('#5b8def');
  const proposal = proposeCompliant('#5b8def', '#ffffff', 4.5);
  assert.ok(proposal);
  assert.ok(proposal.ratio >= 4.5, JSON.stringify(proposal));
  const proposed = toOklch(proposal.color);
  const hueDistance = Math.min(Math.abs(source.h - proposed.h), 360 - Math.abs(source.h - proposed.h));
  assert.ok(hueDistance < 1, `${source.h} vs ${proposed.h}`);
});
