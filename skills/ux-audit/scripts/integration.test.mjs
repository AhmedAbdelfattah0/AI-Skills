import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveDeps } from './bootstrap.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(scriptsDir, '..', 'evals', 'files', 'fixture');
const runScript = join(scriptsDir, 'run.mjs');

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    const timeout = setTimeout(() => child.kill('SIGTERM'), options.timeout);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

test('browser lanes produce deterministic fixture evidence', { timeout: 180_000 }, async (t) => {
  if (!process.env.UX_AUDIT_DEPS_DIR) {
    const reason = 'UX_AUDIT_DEPS_DIR is unset; browser integration requires preinstalled dependencies';
    console.log(`SKIP: ${reason}`);
    t.skip(reason);
    return;
  }
  const deps = await resolveDeps({ projectRoot: fixtureDir });
  if (deps.status === 'degraded') {
    console.log(`SKIP: ${deps.reason}`);
    t.skip(deps.reason);
    return;
  }
  try {
    const probe = await deps.playwright.chromium.launch({ headless: true });
    await probe.close();
  } catch (error) {
    const sandboxFailure = error.message.match(/FATAL:[^\n]*Permission denied[^\n]*/)?.[0];
    const reason = sandboxFailure
      ? `Chromium could not launch in the test sandbox: ${sandboxFailure}`
      : `Chromium could not launch: ${error.message.split('\n')[0]}`;
    console.log(`SKIP: ${reason}`);
    t.skip(reason);
    return;
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.test').pathname;
    const name = pathname === '/' ? 'index.html' : basename(pathname);
    const path = join(fixtureDir, name);
    try {
      const content = readFileSync(path);
      const type = extname(path) === '.css' ? 'text/css' : 'text/html';
      response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const runDir = mkdtempSync(join(tmpdir(), 'ux-audit-integration-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const configPath = join(runDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    baseUrl,
    routes: [
      { id: 'home', path: '/', readySelector: 'main', scenario: 'default' },
      { id: 'form', path: '/form.html', readySelector: 'form', scenario: 'default' },
      { id: 'home-ar', path: '/ar.html', readySelector: 'main', scenario: 'default' },
    ],
    scenarios: {},
    interactions: [{ route: 'form', selector: '#feedback', action: 'click', safe: true, expect: 'any-visible-change' }],
    theme: { mode: 'media', toggleSelector: null, attribute: null },
    rtl: { mode: 'auto', url: null, attribute: null },
    viewports: [320, 390, 1440],
    lockedColors: ['#5b8def'],
    sourceGlobs: ['*.css'],
    projectRoot: fixtureDir,
  }, null, 2));
  const started = performance.now();
  const child = await runChild(process.execPath, [runScript, '--config', configPath], {
    env: process.env,
    timeout: 160_000,
  });
  console.log(`fixture browser audit elapsed: ${Math.round(performance.now() - started)}ms`);
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /navigation profile: \d+ loads, [1-9]\d* reuses,/);
  const reusedPages = Number(/navigation profile: \d+ loads, (\d+) reuses,/.exec(child.stdout)?.[1]);
  assert.ok(reusedPages >= 51, `expected at least 51 observational page reuses, got ${reusedPages}`);
  assert.ok(json(join(runDir, 'capture.json')).some((row) => row.status === 'ok'));
  const axe = json(join(runDir, 'axe.json'));
  assert.ok(axe.some((row) => row.violations.some((violation) => violation.id === 'button-name')));
  const forms = json(join(runDir, 'forms.json'));
  assert.ok(forms.some((row) => row.selector === '#email' && row.placeholderOnly
    && row.nameSource === 'placeholder' && row.autocomplete === null));
  const locked = json(join(runDir, 'contrast.json')).filter((row) => row.kind === 'locked-brand');
  assert.ok(locked.some((row) => !row.pass && row.proposal));
  assert.ok(locked.every((row) => !row.pass || !Object.hasOwn(row, 'proposal')));
  assert.ok(locked.every((row) => row.fg !== row.bg));
  const nonText = json(join(runDir, 'contrast.json')).filter((row) => row.kind === 'non-text');
  assert.ok(!nonText.some((row) => ['#feedback', '#no-focus'].includes(row.selector)));
  const targets = json(join(runDir, 'targets.json'));
  assert.ok(targets.some((row) => row.below24));
  assert.ok(targets.some((row) => row.below44 && !row.below24));
  assert.ok(targets.some((row) => row.selector === '#inline-link' && row.exception === 'inline' && !row.below24));
  assert.equal(new Set(targets.map((row) => `${row.route}|${row.width}|${row.selector}`)).size, targets.length);
  const focus = json(join(runDir, 'focus.json')).filter((row) => row.route === 'form');
  assert.ok(focus.every((row) => row.trapped === false));
  assert.ok(focus.every((row) => row.steps.findIndex((step) => step.selector === '#first-name')
    < row.steps.findIndex((step) => step.selector === '#start-date')));
  assert.ok(focus.every((row) => row.steps.filter((step) => step.selector === '#start-date').length === 1));
  // #first-name is autofocused on load; its indicator must still be detected (baseline taken after blur).
  assert.ok(focus.every((row) => row.steps.some((step) => step.selector === '#first-name' && step.visible === true)));
  assert.ok(json(join(runDir, 'focus.json')).every((row) => row.steps.every((step) => step.selector !== 'body')));
  const homeFocus = json(join(runDir, 'focus.json')).filter((row) => row.route === 'home');
  assert.ok(homeFocus.every((row) => row.steps.some((step) => step.selector === '#no-focus' && step.visible === false)));
  assert.ok(homeFocus.every((row) => row.steps.some((step) => step.selector !== '#no-focus' && step.visible === true)));
  const tokens = json(join(runDir, 'tokens.json'));
  assert.ok(['13px', '22px', '37px'].every((value) => tokens.offScale.spacing.includes(value)));
  assert.ok(Object.keys(tokens.rendered.uaDefaults.spacing).length > 0);
  assert.equal(tokens.rendered.uaDefaults.spacing.normal, undefined);
  assert.ok(!tokens.offScale.spacing.includes('21.44px'));
  assert.ok(!tokens.offScale.spacing.includes('19.92px'));
  assert.equal(json(join(runDir, 'stack.json')).frameworks[0].id, 'plain-css');
  assert.ok(json(join(runDir, 'reflow.json')).some((row) => row.horizontalScroll));
  const motion = json(join(runDir, 'motion.json'));
  assert.ok(motion.some((row) => row.durations.includes(600)
    && row.motion.some((item) => item.name === 'transform' && !item.respected && !item.exempt)
    && row.respected === false));
  assert.ok(motion.some((row) => row.motion.some((item) => item.name === 'spin' && item.exempt && item.reason === 'loading-spinner')));
  assert.ok(motion.some((row) => row.motion.some((item) => item.name === 'color' && item.exempt)));
  assert.equal(json(join(runDir, 'theme.json')).dark, 'detected');
  const rtl = json(join(runDir, 'rtl.json'));
  assert.equal(rtl.rtl, 'detected');
  assert.ok(rtl.routes.some((row) => row.route === 'home-ar' && row.direction === 'rtl'));
  assert.equal(json(join(runDir, 'perf.json')).interactions[0].status, 'ok');
  assert.ok(Object.values(json(join(runDir, 'lanes.json'))).every((lane) => lane.status === 'ok'));
  // A partial re-run must not mark the lanes it skipped as not-selected.
  const partial = await runChild(process.execPath, [runScript, '--config', configPath, '--only', 'stack'], {
    env: process.env,
    timeout: 60_000,
  });
  assert.equal(partial.status, 0, `${partial.stdout}\n${partial.stderr}`);
  assert.ok(Object.values(json(join(runDir, 'lanes.json'))).every((lane) => lane.status === 'ok'));
});
