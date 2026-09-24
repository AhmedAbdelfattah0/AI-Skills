import { withAuditPage } from './runtime.mjs';

export async function runTargets({ browser, config }) {
  const rows = [];
  for (const route of config.routes) {
    for (const width of config.viewports) {
      const targets = await withAuditPage(browser, config, route, { width, scheme: 'light', shared: true }, (page) => page.evaluate(() => {
        const query = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="combobox"],[tabindex]:not([tabindex="-1"])';
        const selector = (element) => {
          if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
          const parts = [];
          for (let node = element; node?.localName; node = node.parentElement) {
            if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
            const peers = node.parentElement ? [...node.parentElement.children].filter((peer) => peer.localName === node.localName) : [node];
            parts.unshift(peers.length > 1 ? `${node.localName}:nth-of-type(${peers.indexOf(node) + 1})` : node.localName);
            if (node === document.documentElement) break;
          }
          return parts.join(' > ');
        };
        const candidates = [...document.querySelectorAll(query)].flatMap((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden') return [];
          const siblingProse = [...(element.parentElement?.childNodes ?? [])]
            .filter((node) => node !== element && node.nodeType === Node.TEXT_NODE)
            .some((node) => node.textContent.trim().length > 0);
          const inlineSentenceLink = element.matches('a[href]') && style.display === 'inline'
            && element.parentElement?.matches('p,dd,dt,figcaption,blockquote') && siblingProse;
          const nativeType = element.matches('select,input[type="date"],input[type="time"],input[type="datetime-local"],input[type="month"],input[type="week"],input[type="color"],input[type="range"],input[type="file"]')
            && !['none', 'textfield'].includes(style.appearance);
          return [{ element, selector: selector(element), rect, inlineSentenceLink, nativeType }];
        });
        return candidates.map((candidate) => {
          const { rect } = candidate;
          let exception;
          if (rect.width < 24 || rect.height < 24) {
            if (candidate.inlineSentenceLink) exception = 'inline';
            else if (candidate.nativeType) exception = 'ua';
            else {
            const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            const intersects = candidates.some((other) => {
              if (other === candidate) return false;
              const otherCenter = { x: other.rect.left + other.rect.width / 2, y: other.rect.top + other.rect.height / 2 };
              const circleDistance = Math.hypot(center.x - otherCenter.x, center.y - otherCenter.y);
              const nearestX = Math.max(other.rect.left, Math.min(center.x, other.rect.right));
              const nearestY = Math.max(other.rect.top, Math.min(center.y, other.rect.bottom));
              return circleDistance < 24 || Math.hypot(center.x - nearestX, center.y - nearestY) < 12;
            });
            if (!intersects) exception = 'spacing';
            }
          }
          return { selector: candidate.selector, w: Number(rect.width.toFixed(2)), h: Number(rect.height.toFixed(2)), exception };
        });
      }));
      const seen = new Set();
      for (const target of targets) {
        const key = `${route.id}|${width}|${target.selector}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = { route: route.id, width, selector: target.selector, w: target.w, h: target.h,
          below24: !target.exception && (target.w < 24 || target.h < 24),
          below44: target.w < 44 || target.h < 44 };
        if (target.exception) row.exception = target.exception;
        rows.push(row);
      }
    }
  }
  return rows;
}
