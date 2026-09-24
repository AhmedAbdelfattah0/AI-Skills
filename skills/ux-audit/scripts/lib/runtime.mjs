import { redactUrl, sanitizeId } from './paths.mjs';
import { waitForReadiness } from './readiness.mjs';

export const DEFAULT_VIEWPORTS = {
  320: 844,
  390: 844,
  768: 1024,
  1024: 768,
  1440: 900,
  1920: 1080,
};

export function routeUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

export function routeScenario(config, route) {
  return route.scenario || 'default';
}

async function applyStep(page, step) {
  const timeout = Number.isFinite(step.timeout) ? step.timeout : 10_000;
  if (step.action === 'click') await page.locator(step.selector).click({ timeout });
  else if (step.action === 'fill') await page.locator(step.selector).fill(String(step.value ?? ''), { timeout });
  else if (step.action === 'press') await page.locator(step.selector ?? 'body').press(step.key, { timeout });
  else if (step.action === 'wait') {
    if (step.selector) await page.locator(step.selector).waitFor({ state: step.state ?? 'visible', timeout });
    else await page.waitForTimeout(Math.min(timeout, Number(step.ms) || 0));
  } else if (step.action === 'route-mock') {
    if (!step.url || !step.response) throw new Error('route-mock requires url and response');
    await page.route(step.url, (route) => route.fulfill(step.response));
  } else {
    throw new Error(`Unsupported scenario action: ${step.action}`);
  }
}

function storageForOrigin(config, targetUrl) {
  if (!config.storageState) return undefined;
  return new URL(targetUrl).origin === new URL(config.baseUrl).origin ? config.storageState : undefined;
}

export async function openAuditPage(browser, config, route, options = {}) {
  const width = options.width ?? 1440;
  const scheme = options.scheme ?? 'light';
  const scenarioName = options.scenario ?? routeScenario(config, route);
  const targetUrl = options.url ?? routeUrl(config.baseUrl, route.path);
  const context = await browser.newContext({
    viewport: { width, height: DEFAULT_VIEWPORTS[width] ?? Math.round(width * 0.75) },
    colorScheme: scheme,
    reducedMotion: options.reducedMotion ?? 'no-preference',
    storageState: storageForOrigin(config, targetUrl),
  });
  const page = await context.newPage();
  try {
    if (options.initScript) await page.addInitScript(options.initScript);
    const scenario = config.scenarios?.[scenarioName];
    if (scenario && sanitizeId(scenario.route) === sanitizeId(route.id)) {
      for (const step of scenario.steps ?? []) {
        if (step.action === 'route-mock') await applyStep(page, step);
      }
    }
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeout ?? 20_000 });
    if (scenario && sanitizeId(scenario.route) === sanitizeId(route.id)) {
      for (const step of scenario.steps ?? []) {
        if (step.action !== 'route-mock') await applyStep(page, step);
      }
    }
    await waitForReadiness(page, route.readySelector, options.timeout ?? 10_000);
    return { context, page, url: redactUrl(page.url()), scenario: sanitizeId(scenarioName) };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function withAuditPage(browser, config, route, options, callback) {
  const opened = await openAuditPage(browser, config, route, options);
  try {
    return await callback(opened.page, opened);
  } finally {
    await opened.context.close();
  }
}
