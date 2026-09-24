import { redactUrl, sanitizeId } from './paths.mjs';
import { waitForReadiness } from './readiness.mjs';

const sharedPages = new WeakMap();
const runtimeProfiles = new WeakMap();

function profileFor(browser) {
  if (!runtimeProfiles.has(browser)) runtimeProfiles.set(browser, { navigations: 0, reusedPages: 0, navigationMs: 0, routes: {} });
  return runtimeProfiles.get(browser);
}

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
    const navigationStarted = performance.now();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeout ?? 20_000 });
    if (scenario && sanitizeId(scenario.route) === sanitizeId(route.id)) {
      for (const step of scenario.steps ?? []) {
        if (step.action !== 'route-mock') await applyStep(page, step);
      }
    }
    await waitForReadiness(page, route.readySelector, options.timeout ?? 10_000);
    const profile = profileFor(browser);
    const routeProfile = profile.routes[route.id] ?? { navigations: 0, reusedPages: 0, navigationMs: 0 };
    const elapsed = performance.now() - navigationStarted;
    profile.navigations += 1;
    profile.navigationMs += elapsed;
    routeProfile.navigations += 1;
    routeProfile.navigationMs += elapsed;
    profile.routes[route.id] = routeProfile;
    return { context, page, url: redactUrl(page.url()), scenario: sanitizeId(scenarioName) };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function withAuditPage(browser, config, route, options, callback) {
  if (options.shared) {
    let cache = sharedPages.get(browser);
    if (!cache) { cache = new Map(); sharedPages.set(browser, cache); }
    const key = JSON.stringify({ route: route.id, path: route.path, scenario: options.scenario ?? routeScenario(config, route),
      width: options.width ?? 1440, scheme: options.scheme ?? 'light' });
    let pending = cache.get(key);
    if (!pending) {
      pending = openAuditPage(browser, config, route, options);
      cache.set(key, pending);
    } else {
      const profile = profileFor(browser);
      const routeProfile = profile.routes[route.id] ?? { navigations: 0, reusedPages: 0, navigationMs: 0 };
      profile.reusedPages += 1;
      routeProfile.reusedPages += 1;
      profile.routes[route.id] = routeProfile;
    }
    try {
      const opened = await pending;
      return await callback(opened.page, opened);
    } catch (error) {
      const opened = await pending.catch(() => null);
      if (opened) await opened.context.close();
      cache.delete(key);
      throw error;
    }
  }
  const opened = await openAuditPage(browser, config, route, options);
  try {
    return await callback(opened.page, opened);
  } finally {
    await opened.context.close();
  }
}

export async function closeSharedAuditPages(browser) {
  const cache = sharedPages.get(browser);
  if (!cache) return;
  const opened = await Promise.all([...cache.values()].map((pending) => pending.catch(() => null)));
  await Promise.all(opened.filter(Boolean).map(({ context }) => context.close()));
  sharedPages.delete(browser);
}

export function runtimeProfile(browser) {
  const profile = profileFor(browser);
  return { ...profile, navigationMs: Number(profile.navigationMs.toFixed(2)), routes: Object.fromEntries(
    Object.entries(profile.routes).map(([route, values]) => [route, { ...values, navigationMs: Number(values.navigationMs.toFixed(2)) }]),
  ) };
}
