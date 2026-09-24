import { withAuditPage } from './runtime.mjs';

export async function runReflow({ browser, config }) {
  const rows = [];
  for (const route of config.routes) {
    const horizontalScroll = await withAuditPage(browser, config, route, { width: 320, scheme: 'light' },
      (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1));
    const zoom200Ok = await withAuditPage(browser, config, route, { width: 640, scheme: 'light' }, (page) => page.evaluate(() => {
      // CSS zoom 2 on a 640px viewport models a 320 CSS-pixel effective canvas without
      // deviceScaleFactor (which changes raster density, not layout/zoom semantics).
      document.documentElement.style.zoom = '2';
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
    }));
    const clippedCount = await withAuditPage(browser, config, route, { width: 320, scheme: 'light' }, (page) => page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
        p { margin-bottom: 2em !important; }`;
      document.head.append(style);
      return [...document.querySelectorAll('body *')].filter((element) => {
        const computed = getComputedStyle(element);
        const hasText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        return hasText && ['hidden', 'clip'].includes(computed.overflowY) && element.scrollHeight > element.clientHeight + 1;
      }).length;
    }));
    rows.push({
      route: route.id,
      width: 320,
      horizontalScroll,
      zoom200Ok,
      textSpacingOk: clippedCount === 0,
      clippedTextCount: clippedCount,
    });
  }
  return rows;
}
