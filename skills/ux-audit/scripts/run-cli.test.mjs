import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'run.mjs');
const fixture = join(scriptsDir, '..', 'evals', 'files', 'fixture');

test('run CLI reports missing config as usage error', () => {
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /--config is required/);
});

test('run CLI refuses storage state inside its run directory', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'ux-audit-cli-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const configPath = join(runDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    baseUrl: 'http://127.0.0.1:4173',
    routes: [{ id: 'home', path: '/' }],
    storageState: join(runDir, 'state.json'),
    projectRoot: fixture,
  }));
  const child = spawnSync(process.execPath, [script, '--config', configPath], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /storageState must be outside the run directory/);
});

test('run CLI rejects an unknown framework override', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'ux-audit-cli-framework-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const configPath = join(runDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    baseUrl: 'http://127.0.0.1:4173', routes: [{ id: 'home', path: '/' }],
    projectRoot: fixture, framework: 'not-a-framework',
  }));
  const child = spawnSync(process.execPath, [script, '--config', configPath], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /framework must be one of/);
});
