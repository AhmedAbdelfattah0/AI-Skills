import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterColors, clusterFontSizes, clusterSpacing, extractDeclaredCss, fontSizeOffScale,
  stripTransparentShadowLayers, tokenProposal } from './lib/tokens.mjs';

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

test('spacing keywords are excluded from token counts', () => {
  const { counts } = extractDeclaredCss('.x { gap: normal; margin: 13px; }');
  assert.equal(counts.spacing.normal, undefined);
  assert.equal(counts.spacing['13px'], 1);
});

test('Tailwind proposals preserve on-scale type and map or name deviations', () => {
  const empty = { spacing: {}, fontSize: {}, fontFamily: {}, color: {}, radius: {}, shadow: {}, duration: {} };
  const stack = { frameworks: [{ id: 'tailwind' }], tokenSources: [], scales: {
    spacing: [0, 4, 8, 12, 16], fontSize: [12, 14, 16], radius: [0, 4, 8],
    keys: { spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 }, fontSize: { xs: 12, sm: 14, base: 16 }, radius: { none: 0, DEFAULT: 4, lg: 8 } },
  } };
  const declared = { ...empty, spacing: { '13px': 1 }, fontSize: { '11px': 40, '12px': 10 },
    shadow: { '0 1px 2px rgba(0,0,0,0), 0 2px 4px rgba(0,0,0,.25)': 2 } };
  const proposal = tokenProposal(empty, declared, stack, {
    offScale: { spacing: ['13px'], fontSize: ['11px'] }, lockedColors: ['#5b8def'],
  });
  assert.deepEqual(proposal.spacing[0], { value: '13px', count: 1, action: 'use-existing', key: '3', target: '12px', recommendation: '3' });
  assert.equal(proposal.fontSize.length, 1);
  assert.equal(proposal.fontSize[0].key, '2xs');
  assert.equal(proposal.fontSize[0].action, 'add-token');
  assert.ok(Object.hasOwn(proposal.color, 'brand-light'));
  assert.doesNotMatch(proposal.shadow[0].value, /rgba\(0,0,0,0\)/);
});

test('transparent shadow layers are removed without dropping visible layers', () => {
  assert.equal(stripTransparentShadowLayers('0 0 0 rgba(0, 0, 0, 0), 0 2px 4px rgba(0,0,0,.2)'),
    '0 2px 4px rgba(0,0,0,.2)');
});

test('proposals skip locked colours the theme already defines and drop shadow resets', () => {
  const empty = { spacing: {}, fontSize: {}, fontFamily: {}, color: {}, radius: {}, shadow: {}, duration: {} };
  const stack = { frameworks: [{ id: 'tailwind' }], tokenSources: [], scales: { keys: {} } };
  const declared = { ...empty, theme: [{ file: 'tailwind.config.ts', name: 'brand.500', value: '#B8843A', category: 'color' }],
    shadow: { 'none !important': 3, '0 1px 2px rgba(0,0,0,.05)': 5 } };
  const proposal = tokenProposal(empty, declared, stack, { offScale: { spacing: [], fontSize: [] }, lockedColors: ['#b8843a', '#5b8def'] });
  assert.ok(!Object.values(proposal.color).some((entry) => entry.value.toLowerCase() === '#b8843a'));
  assert.ok(Object.values(proposal.color).some((entry) => entry.value === '#5b8def'));
  assert.deepEqual(proposal.shadow.map((entry) => [entry.key, entry.value]), [['elevation-1', '0 1px 2px rgba(0,0,0,.05)']]);
});
