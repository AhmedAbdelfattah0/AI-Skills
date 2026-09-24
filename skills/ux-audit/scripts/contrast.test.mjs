import test from 'node:test';
import assert from 'node:assert/strict';
import { boundaryRow, lockedRow } from './lib/contrast.mjs';
import { parseColor } from './lib/color.mjs';

const base = {
  selector: '#control', required: 4.5, text: false, visibleText: false, controlWithText: false,
  nonTextEligible: true, color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
  borderColor: 'rgba(0, 0, 0, 0)', parentBackgrounds: ['rgb(255, 255, 255)'],
  textBackgrounds: ['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'],
  parentUnmeasurable: null, textUnmeasurable: null,
};

test('a control without a visible border or distinct background reports no boundary', () => {
  const row = boundaryRow({ ...base, boundaryType: 'none' });
  assert.equal(row.reason, 'no-visible-boundary');
  assert.equal(row.status, 'unmeasurable');
});

test('a control background equal to its parent is not compared with itself', () => {
  const row = boundaryRow({ ...base, boundaryType: 'background', backgroundColor: 'rgb(255, 255, 255)' });
  assert.equal(row.reason, 'no-visible-boundary');
  assert.equal(row.ratio, null);
});

test('locked control backgrounds are compared with their text, never themselves', () => {
  const raw = { ...base, boundaryType: 'background', controlWithText: true, visibleText: true,
    backgroundColor: 'rgb(91, 141, 239)', color: 'rgb(255, 255, 255)' };
  const row = lockedRow(raw, [parseColor('#5b8def')]);
  assert.equal(row.kind, 'locked-brand');
  assert.notEqual(row.fg, row.bg);
  assert.equal(row.bg, 'rgb(255, 255, 255)');
});

test('locked decorative backgrounds do not create locked-brand findings', () => {
  const raw = { ...base, nonTextEligible: false, boundaryType: 'background', backgroundColor: 'rgb(91, 141, 239)' };
  assert.equal(lockedRow(raw, [parseColor('#5b8def')]), null);
});
