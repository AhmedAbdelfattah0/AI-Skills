import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterColors, clusterFontSizes, clusterSpacing, extractDeclaredCss, fontSizeOffScale } from './lib/tokens.mjs';

test('spacing clusters to nearby 4px and 8px scale steps', () => {
  const clusters = clusterSpacing({ '13px': 3, '15px': 1, '37px': 2 });
  assert.deepEqual(clusters.map((cluster) => cluster.value), ['12px', '16px', '40px']);
});

test('font sizes fit a compact modular scale', () => {
  const clusters = clusterFontSizes({ '12px': 4, '14px': 2, '16px': 8, '20px': 3, '24px': 2 });
  assert.ok(clusters.length <= 5);
  assert.ok(clusters.every((cluster) => Number.isFinite(cluster.ratio)));
});

test('common UI font sizes are on-scale while irregular sizes are not', () => {
  const counts = Object.fromEntries(['12px', '14px', '16px', '18px', '20px', '24px', '32px', '13.3333px', '15px']
    .map((value) => [value, 1]));
  assert.deepEqual(fontSizeOffScale(counts), ['13.3333px', '15px']);
});

test('near-identical colors share a delta-E OK cluster', () => {
  const clusters = clusterColors({ '#5b8def': 4, '#5c8eef': 2, '#ffffff': 9 });
  assert.equal(Object.keys(clusters).length, 2);
  assert.deepEqual(clusters['#5b8def'].sources, ['#5b8def', '#5c8eef']);
});

test('declared token extraction keeps custom properties separate', () => {
  const { counts, customProperties } = extractDeclaredCss(':root { --space: 13px; color: #123456; margin: 13px; }');
  assert.equal(customProperties['--space'], '13px');
  assert.equal(counts.spacing['13px'], 2);
  assert.equal(counts.color['#123456'], 1);
});
