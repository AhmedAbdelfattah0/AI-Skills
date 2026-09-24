#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveDeps } from './bootstrap.mjs';
import { runCapture } from './lib/capture.mjs';
import { runAxe } from './lib/axe.mjs';
import { runContrast } from './lib/contrast.mjs';
import { runFocus } from './lib/focus.mjs';
import { runTargets } from './lib/targets.mjs';
import { runForms } from './lib/forms.mjs';
import { runTokens } from './lib/tokens.mjs';
import { runPerf } from './lib/perf.mjs';
import { runMotion } from './lib/motion.mjs';
import { runReflow } from './lib/reflow.mjs';
import { runTheme } from './lib/theme.mjs';
import { runRtl } from './lib/rtl.mjs';
import { FRAMEWORK_IDS, runStack } from './lib/stack.mjs';
import { assertInside, redactUrl, sanitizeId, writeJsonAtomic } from './lib/paths.mjs';

const LANES = ['stack', 'capture', 'axe', 'contrast', 'focus', 'targets', 'forms', 'tokens', 'perf', 'motion', 'reflow', 'theme', 'rtl'];
const ARTIFACTS = Object.fromEntries(LANES.map((lane) => [lane, `${lane}.json`]));
const DEFAULT_VIEWPORTS = [320, 390, 768, 1024, 1440, 1920];

function usage() {
  return 'Usage: node run.mjs --config <run-dir>/config.json [--only capture,axe,...] [--install-browsers]\n';
}

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function safeMessage(error) {
  return String(error?.message ?? error).replace(/https?:\/\/[^\s)\]}]+/g, (url) => redactUrl(url));
}

function parseCli(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'string' },
        only: { type: 'string' },
        'install-browsers': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
    if (values.help) return { help: true };
    if (!values.config) throw usageError('--config is required');
    const selected = values.only
      ? values.only.split(',').map((lane) => lane.trim()).filter(Boolean)
      : LANES;
    const unknown = selected.filter((lane) => !LANES.includes(lane));
    if (unknown.length) throw usageError(`unknown lane(s): ${unknown.join(', ')}`);
    if (!selected.length) throw usageError('--only must select at least one lane');
    const selectedSet = new Set(selected);
    if (selectedSet.has('tokens')) selectedSet.add('stack');
    return {
      configPath: resolve(values.config),
      selected: selectedSet,
      installBrowsers: values['install-browsers'],
    };
  } catch (error) {
    if (error.usage) throw error;
    throw usageError(error.message);
  }
}

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageError(`${label} must be an object`);
}

function stringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw usageError(`${label} must be an array of strings`);
  return value;
}

async function loadConfig(configPath) {
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { throw usageError(`cannot read config JSON: ${error.message}`); }
  ensureObject(config, 'config');
  let baseUrl;
  try { baseUrl = new URL(config.baseUrl); } catch { throw usageError('baseUrl must be a valid absolute URL'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw usageError('baseUrl must use http or https');
  if (!Array.isArray(config.routes) || config.routes.length === 0) throw usageError('routes must be a non-empty array');
  const routeNames = new Set();
  for (const [index, route] of config.routes.entries()) {
    ensureObject(route, `routes[${index}]`);
    if (typeof route.id !== 'string' || !route.id.trim()) throw usageError(`routes[${index}].id must be a non-empty string`);
    if (typeof route.path !== 'string' || !route.path.trim()) throw usageError(`routes[${index}].path must be a non-empty string`);
    const safe = sanitizeId(route.id);
    if (routeNames.has(safe)) throw usageError(`route ids collide after sanitization: ${route.id}`);
    routeNames.add(safe);
    if (route.readySelector !== undefined && typeof route.readySelector !== 'string') throw usageError(`routes[${index}].readySelector must be a string`);
  }
  if (config.scenarios !== undefined) {
    ensureObject(config.scenarios, 'scenarios');
    const scenarioNames = new Set();
    for (const [name, scenario] of Object.entries(config.scenarios)) {
      const safeName = sanitizeId(name);
      if (scenarioNames.has(safeName)) throw usageError(`scenario names collide after sanitization: ${name}`);
      scenarioNames.add(safeName);
      ensureObject(scenario, `scenarios.${name}`);
      if (!routeNames.has(sanitizeId(scenario.route))) throw usageError(`scenario ${name} references an unknown route`);
      if (!['empty', 'loading', 'error', 'success', 'disabled', 'other'].includes(scenario.state)) {
        throw usageError(`scenarios.${name}.state is unsupported`);
      }
      if (!Array.isArray(scenario.steps)) throw usageError(`scenarios.${name}.steps must be an array`);
      for (const [index, step] of scenario.steps.entries()) {
        ensureObject(step, `scenarios.${name}.steps[${index}]`);
        if (!['click', 'fill', 'press', 'wait', 'route-mock'].includes(step.action)) {
          throw usageError(`scenarios.${name}.steps[${index}].action is unsupported`);
        }
        if (['click', 'fill'].includes(step.action) && typeof step.selector !== 'string') {
          throw usageError(`scenarios.${name}.steps[${index}].selector is required`);
        }
        if (step.action === 'press' && typeof step.key !== 'string') throw usageError(`scenarios.${name}.steps[${index}].key is required`);
        if (step.action === 'route-mock' && (typeof step.url !== 'string' || !step.response)) {
          throw usageError(`scenarios.${name}.steps[${index}] route-mock requires url and response`);
        }
      }
    }
  }
  for (const route of config.routes) {
    if (route.scenario && route.scenario !== 'default' && !Object.hasOwn(config.scenarios ?? {}, route.scenario)) {
      throw usageError(`route ${route.id} references an unknown scenario`);
    }
  }
  const viewports = config.viewports ?? DEFAULT_VIEWPORTS;
  if (!Array.isArray(viewports) || viewports.length === 0
    || viewports.some((width) => !Number.isInteger(width) || width < 200 || width > 7680)) {
    throw usageError('viewports must be a non-empty array of integer CSS widths from 200 to 7680');
  }
  if (typeof config.projectRoot !== 'string' || !isAbsolute(config.projectRoot)) throw usageError('projectRoot must be an absolute path');
  try {
    if (!(await stat(config.projectRoot)).isDirectory()) throw new Error('not a directory');
  } catch (error) { throw usageError(`projectRoot is not a readable directory: ${error.message}`); }
  const runDir = dirname(configPath);
  if (config.storageState !== undefined) {
    if (typeof config.storageState !== 'string' || !isAbsolute(config.storageState)) throw usageError('storageState must be an absolute path');
    const storage = resolve(config.storageState);
    const rel = relative(runDir, storage);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
      throw usageError('storageState must be outside the run directory');
    }
    try {
      if (!(await stat(storage)).isFile()) throw new Error('not a file');
    } catch (error) { throw usageError(`storageState is not a readable file: ${error.message}`); }
  }
  stringArray(config.lockedColors, 'lockedColors');
  if ((config.lockedColors ?? []).some((color) => !/^#[0-9a-f]{6}$/i.test(color))) throw usageError('lockedColors entries must be six-digit hex colors');
  stringArray(config.sourceGlobs, 'sourceGlobs');
  stringArray(config.templateGlobs, 'templateGlobs');
  if (config.framework !== undefined && !FRAMEWORK_IDS.includes(config.framework)) {
    throw usageError(`framework must be one of: ${FRAMEWORK_IDS.join(', ')}`);
  }
  if (config.interactions !== undefined && !Array.isArray(config.interactions)) throw usageError('interactions must be an array');
  for (const [index, interaction] of (config.interactions ?? []).entries()) {
    ensureObject(interaction, `interactions[${index}]`);
    if (typeof interaction.route !== 'string' || !routeNames.has(sanitizeId(interaction.route))) throw usageError(`interactions[${index}].route is unknown`);
    if (typeof interaction.selector !== 'string' || !interaction.selector) throw usageError(`interactions[${index}].selector is required`);
    if (!['click', 'fill', 'press'].includes(interaction.action)) throw usageError(`interactions[${index}].action is unsupported`);
    if (interaction.safe !== undefined && interaction.safe !== true && interaction.safe !== false) throw usageError(`interactions[${index}].safe must be boolean`);
  }
  if (config.theme !== undefined) {
    ensureObject(config.theme, 'theme');
    if (!['auto', 'media', 'toggle', 'attribute', 'none'].includes(config.theme.mode)) throw usageError('theme.mode is unsupported');
  }
  if (config.rtl !== undefined) {
    ensureObject(config.rtl, 'rtl');
    if (!['auto', 'none', 'url', 'attribute'].includes(config.rtl.mode)) throw usageError('rtl.mode is unsupported');
  }
  return {
    ...config,
    baseUrl: baseUrl.toString(),
    viewports: [...new Set(viewports)],
    lockedColors: config.lockedColors ?? [],
    sourceGlobs: config.sourceGlobs,
    templateGlobs: config.templateGlobs,
    interactions: config.interactions ?? [],
    scenarios: config.scenarios ?? {},
    theme: config.theme ?? { mode: 'auto' },
    rtl: config.rtl ?? { mode: 'auto' },
  };
}

function countOutput(output) {
  if (Array.isArray(output)) return output.length;
  if (output?.pages && Array.isArray(output.pages)) return output.pages.length;
  if (output && typeof output === 'object') return Object.keys(output).length;
  return 0;
}

async function main() {
  let cli;
  try { cli = parseCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`ux-audit: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (cli.help) {
    process.stdout.write(usage());
    return;
  }
  let config;
  try { config = await loadConfig(cli.configPath); }
  catch (error) {
    process.stderr.write(`ux-audit: ${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  const runDir = dirname(cli.configPath);
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, cli.selected.has(lane)
    ? { status: 'skipped', reason: 'not-run' }
    : { status: 'skipped', reason: 'not-selected' }]));
  const deps = await resolveDeps({
    projectRoot: config.projectRoot,
    installBrowsers: cli.installBrowsers,
    configPath: cli.configPath,
  });
  if (deps.status === 'degraded') {
    for (const lane of cli.selected) lanes[lane] = { status: 'degraded', reason: deps.reason, remediation: deps.remediation };
    await writeJsonAtomic(assertInside(runDir, join(runDir, 'lanes.json')), lanes);
    process.stderr.write(`ux-audit: ${deps.reason}\nRemediation: ${deps.remediation}\n`);
    process.exitCode = 3;
    return;
  }
  let browser;
  try { browser = await deps.playwright.chromium.launch({ headless: true }); }
  catch (error) {
    const reason = safeMessage(error);
    for (const lane of cli.selected) lanes[lane] = {
      status: 'degraded',
      reason: `Chromium could not launch: ${reason}`,
      remediation: deps.remediation,
    };
    await writeJsonAtomic(assertInside(runDir, join(runDir, 'lanes.json')), lanes);
    process.stderr.write(`ux-audit: Chromium could not launch: ${reason}\n`);
    process.exitCode = 3;
    return;
  }
  const counts = {};
  let stackResult;
  let stackError;
  let themeResult;
  let themeProbeError;
  try {
    if (cli.selected.has('stack')) {
      try {
        stackResult = await runStack({ browser, config });
        await writeJsonAtomic(assertInside(runDir, join(runDir, ARTIFACTS.stack)), stackResult);
        lanes.stack = { status: 'ok' };
        counts.stack = countOutput(stackResult);
      } catch (error) {
        stackError = safeMessage(error);
        stackResult = {
          frameworks: [{ id: 'unknown', version: null, confidence: 'low', evidence: [stackError] }],
          tokenSources: [], vendorStylesheets: [], templateGlobs: config.templateGlobs ?? [],
          scales: { spacing: null, fontSize: null, radius: null, source: 'inferred' },
        };
        lanes.stack = { status: 'degraded', reason: stackError };
      }
    }
    const needsThemeProbe = ['capture', 'axe', 'contrast', 'theme'].some((lane) => cli.selected.has(lane));
    if (needsThemeProbe) {
      try {
        themeResult = await runTheme({ browser, config });
        if (cli.selected.has('theme')) {
          await writeJsonAtomic(assertInside(runDir, join(runDir, ARTIFACTS.theme)), themeResult);
          lanes.theme = { status: 'ok' };
          counts.theme = countOutput(themeResult);
        }
      } catch (error) {
        themeProbeError = safeMessage(error);
        themeResult = { dark: 'ambiguous', method: 'probe-error', evidence: { error: themeProbeError } };
        if (cli.selected.has('theme')) lanes.theme = { status: 'degraded', reason: themeProbeError };
      }
    } else themeResult = { dark: 'absent', method: 'not-probed', evidence: {} };
    const schemes = themeResult.dark === 'detected' ? ['light', 'dark'] : ['light'];
    const runners = {
      capture: () => runCapture({ browser, config, runDir, schemes }),
      axe: () => runAxe({ browser, config, schemes, axeBuilder: deps.axeBuilder }),
      contrast: () => runContrast({ browser, config, schemes }),
      focus: () => runFocus({ browser, config }),
      targets: () => runTargets({ browser, config }),
      forms: () => runForms({ browser, config }),
      tokens: () => runTokens({ browser, config, stack: stackResult }),
      perf: () => runPerf({ browser, config }),
      motion: () => runMotion({ browser, config }),
      reflow: () => runReflow({ browser, config }),
      rtl: () => runRtl({ browser, config }),
    };
    for (const lane of LANES) {
      if (!cli.selected.has(lane) || lane === 'stack' || lane === 'theme') continue;
      try {
        const output = await runners[lane]();
        await writeJsonAtomic(assertInside(runDir, join(runDir, ARTIFACTS[lane])), output);
        const failures = lane === 'capture' ? output.filter((row) => row.status === 'error').length : 0;
        if (failures) lanes[lane] = { status: 'degraded', reason: `${failures} screenshot capture(s) failed` };
        else if (themeProbeError && ['capture', 'axe', 'contrast'].includes(lane)) {
          lanes[lane] = { status: 'degraded', reason: `dark-scheme detection failed: ${themeProbeError}` };
        } else if (lane === 'tokens' && stackError) {
          lanes[lane] = { status: 'degraded', reason: `stack detection failed: ${stackError}` };
        } else lanes[lane] = { status: 'ok' };
        counts[lane] = countOutput(output);
      } catch (error) {
        lanes[lane] = { status: 'degraded', reason: safeMessage(error) };
      }
    }
  } finally {
    await browser.close();
  }
  await writeJsonAtomic(assertInside(runDir, join(runDir, 'lanes.json')), lanes);
  const summary = [...cli.selected].map((lane) => `${lane}:${lanes[lane].status}${counts[lane] === undefined ? '' : `(${counts[lane]})`}`).join(' ');
  process.stdout.write(`ux-audit ${summary}\nrun directory: ${runDir}\n`);
  if ([...cli.selected].some((lane) => lanes[lane].status === 'degraded')) process.exitCode = 3;
}

await main();
