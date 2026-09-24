import { withAuditPage } from './runtime.mjs';

const PERFORMANCE_INIT = `(() => {
  window.__uxAuditPerf = { cls: 0, lcp: null };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__uxAuditPerf.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* Layout Instability API is unavailable in this browser. */ }
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) window.__uxAuditPerf.lcp = entries.at(-1).startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* LCP observer is unavailable in this browser. */ }
})();`;

async function interactionProbe(page, interaction) {
  const locator = page.locator(interaction.selector).first();
  if (await locator.count() === 0) return { firstFeedbackMs: null, status: 'skipped', reason: 'selector-not-found' };
  const unsafeReason = await locator.evaluate((element, probe) => {
    const words = [probe.selector, element.id, element.getAttribute('name'), element.getAttribute('aria-label'),
      element.textContent, element.getAttribute('href'), element.getAttribute('formaction')].filter(Boolean).join(' ');
    if (/\b(?:delete|destroy|remove|pay|purchase|checkout|place[- ]?order|submit[- ]?order)\b/i.test(words)) {
      return 'dangerous action semantics';
    }
    if (probe.action === 'click') {
      const submit = element.matches('input[type="submit"],input[type="image"],button[type="submit"]')
        || (element.matches('button:not([type])') && element.closest('form'));
      if (submit || element.hasAttribute('formaction')) return 'form submission';
      const anchor = element.closest('a[href]');
      if (anchor) {
        const destination = new URL(anchor.href, location.href);
        if (!['http:', 'https:'].includes(destination.protocol) || destination.origin !== location.origin) return 'cross-origin navigation';
      }
    }
    if (probe.action === 'press' && probe.key === 'Enter' && element.closest('form')) return 'Enter may submit a form';
    return null;
  }, interaction);
  if (unsafeReason) return { firstFeedbackMs: null, status: 'skipped', reason: `unsafe: ${unsafeReason}` };
  await page.evaluate((selector) => {
    const target = document.querySelector(selector);
    const viewportVisible = (element) => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const started = performance.now();
    window.__uxAuditFeedback = { started, first: null, done: false };
    const mark = (element) => {
      if (window.__uxAuditFeedback.first === null && viewportVisible(element)) {
        window.__uxAuditFeedback.first = performance.now() - started;
        observer.disconnect();
      }
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) mark(record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const fingerprint = () => target ? `${target.getAttribute('style')}|${target.textContent}|${JSON.stringify(target.getBoundingClientRect().toJSON?.())}` : '';
    const initial = fingerprint();
    const watch = () => {
      if (window.__uxAuditFeedback.done || window.__uxAuditFeedback.first !== null) return;
      const current = fingerprint();
      if (current !== initial) mark(target);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    setTimeout(() => { window.__uxAuditFeedback.done = true; observer.disconnect(); }, 1000);
  }, interaction.selector);
  if (interaction.action === 'click') await locator.click();
  else if (interaction.action === 'fill') await locator.fill(String(interaction.value ?? 'ux-audit'));
  else if (interaction.action === 'press') await locator.press(interaction.key ?? 'Enter');
  else return { firstFeedbackMs: null, status: 'skipped', reason: 'unsupported-action' };
  await page.waitForFunction(() => window.__uxAuditFeedback.done || window.__uxAuditFeedback.first !== null, null, { timeout: 1200 });
  const elapsed = await page.evaluate(() => window.__uxAuditFeedback.first);
  return elapsed === null
    ? { firstFeedbackMs: null, status: 'no-feedback' }
    : { firstFeedbackMs: Number(elapsed.toFixed(2)), status: 'ok' };
}

export async function runPerf({ browser, config }) {
  const pages = [];
  for (const route of config.routes) {
    for (const width of config.viewports) {
      const metrics = await withAuditPage(browser, config, route, {
        width,
        scheme: 'light',
        initScript: PERFORMANCE_INIT,
      }, async (page) => {
        await page.waitForTimeout(100);
        return page.evaluate(() => window.__uxAuditPerf);
      });
      pages.push({ route: route.id, width, cls: Number(metrics.cls.toFixed(4)), lcp: metrics.lcp === null ? null : Number(metrics.lcp.toFixed(2)), lab: true });
    }
  }
  const interactions = [];
  for (const interaction of config.interactions ?? []) {
    const base = { route: interaction.route, selector: interaction.selector };
    if (interaction.safe !== true) {
      interactions.push({ ...base, firstFeedbackMs: null, status: 'skipped', reason: interaction.safe === false ? 'unsafe' : 'safe-flag-missing' });
      continue;
    }
    const route = config.routes.find((candidate) => candidate.id === interaction.route);
    if (!route) {
      interactions.push({ ...base, firstFeedbackMs: null, status: 'skipped', reason: 'route-not-found' });
      continue;
    }
    const probe = await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' },
      (page) => interactionProbe(page, interaction));
    interactions.push({ ...base, ...probe });
  }
  return { pages, interactions };
}
