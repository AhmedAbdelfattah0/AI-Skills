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
        if (/(?:^|[._-])(ar|he|fa|ur)(?:[._-]|$)/i.test(entry.name)) localeFiles.push(entry.name);
        if (/\.(?:css|scss|sass|less)$/i.test(entry.name) && cssRules.length < 20) {
          const contents = await readFile(absolute, 'utf8');
          if (/:dir\(rtl\)|\[dir\s*=\s*["']?rtl/i.test(contents)) cssRules.push(entry.name);
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
    return {
      dir: getComputedStyle(document.documentElement).direction,
      documentDir: document.documentElement.getAttribute('dir'),
      rtlElement: rtlElement ? rtlElement.localName : null,
      cssSignals: cssSignals.slice(0, 20),
    };
  });
}

export async function runRtl({ browser, config }) {
  const settings = config.rtl ?? { mode: 'auto' };
  const route = config.routes[0];
  const projectSignals = await projectLocaleSignals(config.projectRoot);
  if (settings.mode === 'none') return { rtl: 'absent', dir: 'ltr', evidence: { mode: 'none', ...projectSignals } };
  let signals;
  if (settings.mode === 'url') {
    if (!settings.url) throw new Error('rtl.url is required for url mode');
    const targetUrl = new URL(settings.url, config.baseUrl).toString();
    const opened = await openAuditPage(browser, config, { ...route, path: targetUrl }, { width: 1440, scheme: 'light', url: targetUrl });
    try { signals = await pageRtlSignals(opened.page); } finally { await opened.context.close(); }
  } else if (settings.mode === 'attribute') {
    if (!settings.attribute?.selector || !settings.attribute?.name) throw new Error('rtl.attribute requires selector, name, and value');
    signals = await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, async (page) => {
      await page.locator(settings.attribute.selector).evaluate((element, attribute) => {
        element.setAttribute(attribute.name, attribute.value ?? 'rtl');
      }, settings.attribute);
      return pageRtlSignals(page);
    });
  } else if (settings.mode === 'auto') {
    signals = await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, pageRtlSignals);
  } else throw new Error(`Unsupported RTL mode: ${settings.mode}`);
  const reachable = signals.dir === 'rtl' || signals.documentDir === 'rtl' || signals.rtlElement;
  const hasProjectSignals = Boolean(signals.cssSignals.length || projectSignals.localeFiles.length
    || projectSignals.cssRules.length || signals.rtlElement);
  return {
    rtl: reachable ? 'detected' : hasProjectSignals ? 'not-reachable' : 'absent',
    dir: signals.dir,
    evidence: { ...signals, ...projectSignals, url: settings.mode === 'url' ? redactUrl(routeUrl(config.baseUrl, settings.url)) : undefined },
  };
}
