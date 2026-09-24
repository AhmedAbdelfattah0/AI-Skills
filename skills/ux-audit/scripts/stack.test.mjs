import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectStack } from './lib/stack.mjs';
import { scanDeclaredTokens, spacingOffScale, tokenProposal } from './lib/tokens.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(scriptsDir, '..', 'evals', 'files', 'fixtures-stack');
const fixture = (name) => join(fixtures, name);

for (const [name, expected, source] of [
  ['tailwind-v3', 'tailwind', 'tailwind config'],
  ['tailwind-v4', 'tailwind', 'tailwind @theme'],
  ['bootstrap5', 'bootstrap', 'bootstrap $spacers'],
]) {
  test(`detects ${name} with evidence and framework scale`, async () => {
    const stack = await detectStack({ projectRoot: fixture(name) });
    assert.equal(stack.frameworks[0].id, expected);
    assert.ok(stack.frameworks[0].evidence.length > 0);
    assert.equal(stack.scales.source, source);
    assert.ok(stack.scales.spacing.length > 0);
  });
}

test('extracts Tailwind arbitrary values with file and line', async () => {
  const projectRoot = fixture('tailwind-v3');
  const stack = await detectStack({ projectRoot });
  const declared = await scanDeclaredTokens({ projectRoot, stack });
  assert.ok(declared.arbitrary.some((row) => row.file === 'src/card.html' && row.line === 1
    && row.value === '13px' && row.utility === 'p-[13px]'));
  assert.ok(declared.arbitrary.some((row) => row.file === 'src/card.tsx' && row.line === 2
    && row.utility === 'text-[#5b8def]'));
  assert.equal(declared.spacing['13px'], 2);
  assert.equal(declared.radius['7px'], 3);
  assert.equal(declared.color['#5b8def'], 3);
});

test('extracts Tailwind v4 theme values and emits native proposal syntax', async () => {
  const projectRoot = fixture('tailwind-v4');
  const stack = await detectStack({ projectRoot });
  const declared = await scanDeclaredTokens({ projectRoot, stack });
  assert.ok(declared.theme.some((row) => row.name === '--spacing-panel' && row.value === '18px'));
  const proposal = tokenProposal({ spacing: { '18px': 1 }, fontSize: {}, fontFamily: {}, color: {}, radius: {}, shadow: {}, duration: {} }, declared, stack);
  assert.equal(proposal.format, 'tailwind-theme');
  assert.match(proposal.snippet, /^@theme \{/);
});

test('Bootstrap defaults are on-scale while app-authored 13px is off-scale', async () => {
  const projectRoot = fixture('bootstrap5');
  const stack = await detectStack({ projectRoot });
  const declared = await scanDeclaredTokens({ projectRoot, stack });
  assert.deepEqual(spacingOffScale({ '0px': 1, '4px': 1, '8px': 1, '16px': 1, '24px': 1, '48px': 1, '13px': 1 }, stack.scales.spacing), ['13px']);
  assert.ok(declared.theme.some((row) => row.name === '$primary'));
  assert.deepEqual(spacingOffScale(declared.spacing, stack.scales.spacing), ['13px']);
});

test('framework override wins while contrary evidence remains', async () => {
  const stack = await detectStack({ projectRoot: fixture('bootstrap5'), framework: 'tailwind' });
  assert.equal(stack.frameworks[0].id, 'tailwind');
  assert.equal(stack.packageRoot, '.');
  assert.equal(stack.frameworks[0].override, true);
  assert.ok(stack.frameworks.some((framework) => framework.id === 'bootstrap'));
});

test('unknown framework marks declared extraction partial', async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ux-audit-unknown-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const stack = await detectStack({ projectRoot });
  const declared = await scanDeclaredTokens({ projectRoot, stack });
  assert.equal(stack.frameworks[0].id, 'unknown');
  assert.equal(declared.partial, true);
  assert.match(declared.reason, /unknown framework/);
});

test('Tailwind config is parsed statically and never executed', async (t) => {
  const markerDir = mkdtempSync(join(tmpdir(), 'ux-audit-config-marker-'));
  const marker = join(markerDir, 'executed.txt');
  t.after(() => rmSync(markerDir, { recursive: true, force: true }));
  const previous = process.env.UX_AUDIT_EXECUTED_CONFIG;
  process.env.UX_AUDIT_EXECUTED_CONFIG = marker;
  try {
    const stack = await detectStack({ projectRoot: fixture('tailwind-v3') });
    assert.equal(stack.frameworks[0].id, 'tailwind');
    assert.equal(existsSync(marker), false);
  } finally {
    if (previous === undefined) delete process.env.UX_AUDIT_EXECUTED_CONFIG;
    else process.env.UX_AUDIT_EXECUTED_CONFIG = previous;
  }
});

test('monorepo Tailwind globs are rooted at the workspace package', async () => {
  const projectRoot = fixture('tailwind-monorepo');
  const stack = await detectStack({ projectRoot });
  assert.equal(stack.frameworks[0].id, 'tailwind');
  assert.equal(stack.packageRoot, 'apps/web');
  assert.equal(stack.frameworks[0].packageRoot, 'apps/web');
  assert.deepEqual(stack.packageRoots, ['apps/web']);
  assert.ok(stack.frameworks[0].packageRoots.includes('apps/web'));
  assert.ok(stack.templateGlobs.includes('apps/web/src/**/*.{html,tsx,jsx,vue,svelte,astro}'));
  assert.ok(stack.sourceGlobs.includes('apps/web/**/*.{css,scss,sass,less}'));
  const declared = await scanDeclaredTokens({ projectRoot, stack });
  assert.ok(declared.arbitrary.some((row) => row.file === 'apps/web/src/x.tsx' && row.value === '44px'));
});

test('Tailwind v3 full default scales include large spacing and display type sizes', async () => {
  const stack = await detectStack({ projectRoot: fixture('tailwind-v3') });
  for (const value of [112, 128, 176, 208, 384]) assert.ok(stack.scales.spacing.includes(value));
  for (const value of [12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72, 96, 128]) assert.ok(stack.scales.fontSize.includes(value));
  assert.equal(stack.scales.keys.spacing['52'], 208);
  assert.equal(stack.scales.keys.fontSize['9xl'], 128);
});
