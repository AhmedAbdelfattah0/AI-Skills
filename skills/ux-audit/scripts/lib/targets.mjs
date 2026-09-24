import { withAuditPage } from './runtime.mjs';

export async function runTargets({ browser, config }) {
  const rows = [];
  for (const route of config.routes) {
    for (const width of config.viewports) {
      const targets = await withAuditPage(browser, config, route, { width, scheme: 'light' }, (page) => page.evaluate(() => {
        const query = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="combobox"],[tabindex]:not([tabindex="-1"])';
        const selector = (element) => element.id ? `#${CSS.escape(element.id)}` : element.localName;
        return [...document.querySelectorAll(query)].flatMap((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden') return [];
          const inlineSentenceLink = element.matches('a[href]')
            && getComputedStyle(element).display === 'inline'
            && (element.parentElement?.textContent.trim().length ?? 0) > element.textContent.trim().length;
          if (inlineSentenceLink) return [];
          return [{ selector: selector(element), w: Number(rect.width.toFixed(2)), h: Number(rect.height.toFixed(2)) }];
        });
      }));
      rows.push(...targets.map((target) => ({
        route: route.id,
        width,
        ...target,
        below24: target.w < 24 || target.h < 24,
        below44: target.w < 44 || target.h < 44,
      })));
    }
  }
  return rows;
}
