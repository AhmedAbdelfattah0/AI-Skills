import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openAuditPage, routeUrl, withAuditPage } from './runtime.mjs';
import { redactUrl } from './paths.mjs';

const SKIP = new Set(['node_modules', 'dist', 'build', 'vendor', '.git']);

async function projectLocaleSignals(root) {
  const localeFiles = [];
  const cssRules = [];
  async function walk(directory, depth = 0) {
    if (depth > 8) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile()) {
        const rel = absolute.slice(root.length + 1).split('\\').join('/');
        if (/(?:^|[._\/-])(ar|he|fa|ur)(?:[._\/-]|$)/i.test(rel)) localeFiles.push(rel);
        if (/\.(?:css|scss|sass|less)$/i.test(entry.name) && cssRules.length < 20) {
          const contents = await readFile(absolute, 'utf8');
          if (/:dir\(rtl\)|\[dir\s*=\s*["']?rtl/i.test(contents)) cssRules.push(rel);
        }
      }
    }
  }
  await walk(root);
  return { localeFiles: localeFiles.slice(0, 20), cssRules: cssRules.slice(0, 20) };
}

async function pageRtlSignals(page) {
  return page.evaluate(() => {
    const cssSignals = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) if (/:dir\(rtl\)|\[dir\s*=\s*["']?rtl/i.test(rule.cssText)) cssSignals.push(rule.cssText.slice(0, 160));
      } catch { /* Cross-origin CSSOM is unavailable. */ }
    }
    const rtlElement = document.querySelector('[dir="rtl"]');
    const documentDirection = getComputedStyle(document.documentElement).direction;
    const rtlElementDirection = rtlElement ? getComputedStyle(rtlElement).direction : null;
    return {
      direction: documentDirection === 'rtl' || rtlElementDirection === 'rtl' ? 'rtl' : documentDirection,
      documentDir: document.documentElement.getAttribute('dir'),
      rtlElement: rtlElement ? (rtlElement.id ? `#${CSS.escape(rtlElement.id)}` : rtlElement.localName) : null,
      rtlElementDirection,
      cssSignals: cssSignals.slice(0, 20),
    };
  });
}

async function configuredRouteSignals(browser, config, settings) {
  const results = [];
  for (const route of config.routes) {
    const signals = await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, async (page, opened) => {
      if (settings.mode === 'attribute') {
        if (!settings.attribute?.selector || !settings.attribute?.name) throw new Error('rtl.attribute requires selector, name, and value');
        await page.locator(settings.attribute.selector).evaluate((element, attribute) => {
          element.setAttribute(attribute.name, attribute.value ?? 'rtl');
        }, settings.attribute);
      }
      return { ...(await pageRtlSignals(page)), url: opened.url };
    });
    results.push({ route: route.id, ...signals });
  }
  return results;
}

export async function runRtl({ browser, config }) {
  const settings = config.rtl ?? { mode: 'auto' };
  const projectSignals = await projectLocaleSignals(config.projectRoot);
  if (settings.mode === 'none') {
    return { rtl: 'absent', dir: 'ltr', routes: [], evidence: { mode: 'none', ...projectSignals } };
  }
  let routes;
  if (settings.mode === 'url') {
    if (!settings.url) throw new Error('rtl.url is required for url mode');
    const route = config.routes[0];
    const targetUrl = new URL(settings.url, config.baseUrl).toString();
    const opened = await openAuditPage(browser, config, { ...route, path: targetUrl }, { width: 1440, scheme: 'light', url: targetUrl });
    try {
      routes = [{ route: route.id, ...(await pageRtlSignals(opened.page)), url: redactUrl(targetUrl) }];
    } finally { await opened.context.close(); }
  } else if (settings.mode === 'auto' || settings.mode === 'attribute') {
    routes = await configuredRouteSignals(browser, config, settings);
  } else throw new Error(`Unsupported RTL mode: ${settings.mode}`);
  const reachable = routes.some((route) => route.direction === 'rtl' || route.documentDir === 'rtl' || route.rtlElementDirection === 'rtl');
  const hasProjectSignals = routes.some((route) => route.cssSignals.length || route.rtlElement)
    || projectSignals.localeFiles.length > 0 || projectSignals.cssRules.length > 0;
  return {
    rtl: reachable ? 'detected' : hasProjectSignals ? 'not-reachable' : 'absent',
    dir: reachable ? 'rtl' : routes[0]?.direction ?? 'ltr',
    routes: routes.map(({ cssSignals, ...route }) => route),
    evidence: {
      ...projectSignals,
      cssSignals: [...new Set(routes.flatMap((route) => route.cssSignals))].slice(0, 20),
      configuredRoutesChecked: routes.length,
      url: settings.mode === 'url' ? redactUrl(routeUrl(config.baseUrl, settings.url)) : undefined,
    },
  };
}
