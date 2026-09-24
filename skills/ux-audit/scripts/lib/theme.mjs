import { withAuditPage } from './runtime.mjs';

async function snapshot(page) {
  return page.evaluate(() => {
    const representative = [...document.querySelectorAll('body,header,nav,main,section,article,aside,footer,h1,h2,h3,p,a,button,input,select,textarea,[role]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      }).slice(0, 50);
    const elements = representative.map((element, index) => {
      const style = getComputedStyle(element);
      return { key: element.id ? `#${element.id}` : `${element.localName}:${index}`, color: style.color, backgroundColor: style.backgroundColor };
    });
    const root = getComputedStyle(document.documentElement);
    const customProperties = {};
    for (const name of [...root].filter((name) => name.startsWith('--')).sort()) customProperties[name] = root.getPropertyValue(name).trim();
    return { elements, customProperties };
  });
}

function compare(light, dark, method) {
  let changed = 0;
  let sampled = 0;
  const darkElements = new Map(dark.elements.map((element) => [element.key, element]));
  for (const element of light.elements) {
    const counterpart = darkElements.get(element.key);
    if (!counterpart) continue;
    for (const key of ['color', 'backgroundColor']) {
      sampled += 1;
      if (element[key] !== counterpart[key]) changed += 1;
    }
  }
  for (const [name, value] of Object.entries(light.customProperties)) {
    if (!Object.hasOwn(dark.customProperties, name)) continue;
    sampled += 1;
    if (value !== dark.customProperties[name]) changed += 1;
  }
  const ratio = sampled ? changed / sampled : 0;
  return {
    dark: ratio >= 0.2 ? 'detected' : changed > 0 ? 'ambiguous' : 'absent',
    method,
    evidence: { sampledValues: sampled, changedValues: changed, changedRatio: Number(ratio.toFixed(3)) },
  };
}

async function mediaProbe(browser, config, route) {
  const light = await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, snapshot);
  const dark = await withAuditPage(browser, config, route, { width: 1440, scheme: 'dark' }, snapshot);
  return compare(light, dark, 'media');
}

async function pageStateProbe(browser, config, route, mode) {
  return withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, async (page) => {
    const settings = config.theme ?? {};
    if (mode === 'attribute') {
      const attribute = settings.attribute;
      if (!attribute?.selector || !attribute.name) throw new Error('theme.attribute requires selector, name, light, and dark');
      await page.locator(attribute.selector).evaluate((element, values) => element.setAttribute(values.name, values.light), attribute);
      const light = await snapshot(page);
      await page.locator(attribute.selector).evaluate((element, values) => element.setAttribute(values.name, values.dark), attribute);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return compare(light, await snapshot(page), 'attribute');
    }
    if (!settings.toggleSelector) throw new Error('theme.toggleSelector is required for toggle mode');
    const light = await snapshot(page);
    await page.locator(settings.toggleSelector).click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return compare(light, await snapshot(page), 'toggle');
  });
}

export async function runTheme({ browser, config }) {
  const route = config.routes[0];
  const settings = config.theme ?? { mode: 'auto' };
  if (settings.mode === 'none') return { dark: 'absent', method: 'none', evidence: { reason: 'disabled-by-config' } };
  if (settings.mode === 'media') return mediaProbe(browser, config, route);
  if (settings.mode === 'toggle') return pageStateProbe(browser, config, route, 'toggle');
  if (settings.mode === 'attribute') return pageStateProbe(browser, config, route, 'attribute');
  if (settings.mode !== 'auto') throw new Error(`Unsupported theme mode: ${settings.mode}`);
  if (settings.toggleSelector) return pageStateProbe(browser, config, route, 'toggle');
  if (settings.attribute) return pageStateProbe(browser, config, route, 'attribute');
  return mediaProbe(browser, config, route);
}
