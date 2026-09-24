import { contrastRatio, parseColor } from './color.mjs';
import { withAuditPage } from './runtime.mjs';

function focusContrast(step) {
  const indicator = parseColor(step.indicatorColor);
  const adjacent = parseColor(step.adjacentColor);
  return indicator && adjacent ? Number(contrastRatio(indicator, adjacent).toFixed(2)) : undefined;
}

export async function runFocus({ browser, config }) {
  const rows = [];
  for (const route of config.routes) {
    for (const width of [390, 1440]) {
      const audit = await withAuditPage(browser, config, route, { width, scheme: 'light' }, async (page) => {
        const focusableCount = await page.locator('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').evaluateAll((elements) => elements.filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !element.disabled && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
        }).length);
        const limit = Math.min(200, focusableCount + 5);
        const steps = [];
        const seen = new Map();
        let trapped = false;
        for (let index = 0; index < limit; index += 1) {
          await page.keyboard.press('Tab');
          const step = await page.evaluate(() => {
            const element = document.activeElement;
            if (!(element instanceof HTMLElement) || element === document.body) {
              return { selector: 'body', visible: false, obscured: false, rect: null };
            }
            const selector = (() => {
              if (element.id) return `#${CSS.escape(element.id)}`;
              const parts = [];
              for (let node = element; node?.localName && node !== document.documentElement && parts.length < 5; node = node.parentElement) {
                const peers = node.parentElement
                  ? [...node.parentElement.children].filter((peer) => peer.localName === node.localName)
                  : [];
                parts.unshift(`${node.localName}${peers.length > 1 ? `:nth-of-type(${peers.indexOf(node) + 1})` : ''}`);
              }
              return parts.join(' > ');
            })();
            const style = getComputedStyle(element);
            const focused = {
              outline: `${style.outlineStyle}|${style.outlineWidth}|${style.outlineColor}|${style.outlineOffset}`,
              boxShadow: style.boxShadow,
              border: `${style.borderTopWidth}|${style.borderTopStyle}|${style.borderTopColor}`,
              background: style.backgroundColor,
            };
            element.blur();
            const plainStyle = getComputedStyle(element);
            const unfocused = {
              outline: `${plainStyle.outlineStyle}|${plainStyle.outlineWidth}|${plainStyle.outlineColor}|${plainStyle.outlineOffset}`,
              boxShadow: plainStyle.boxShadow,
              border: `${plainStyle.borderTopWidth}|${plainStyle.borderTopStyle}|${plainStyle.borderTopColor}`,
              background: plainStyle.backgroundColor,
            };
            element.focus();
            const visible = Object.keys(focused).some((key) => focused[key] !== unfocused[key]);
            const rect = element.getBoundingClientRect();
            const points = [
              [rect.left + rect.width / 2, rect.top + rect.height / 2],
              [rect.left + 1, rect.top + 1],
              [rect.right - 1, rect.top + 1],
              [rect.left + 1, rect.bottom - 1],
              [rect.right - 1, rect.bottom - 1],
            ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
            const obscured = points.some(([x, y]) => document.elementsFromPoint(x, y).some((cover) => {
              if (cover === element || cover.contains(element) || element.contains(cover)) return false;
              const coverStyle = getComputedStyle(cover);
              return ['fixed', 'sticky'].includes(coverStyle.position) && Number(coverStyle.opacity) > 0;
            }));
            const shadowColor = style.boxShadow.match(/rgba?\([^)]*\)/)?.[0];
            const indicatorColor = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0
              ? style.outlineColor
              : shadowColor;
            let adjacentColor = 'rgb(255, 255, 255)';
            for (let node = element.parentElement; node; node = node.parentElement) {
              const background = getComputedStyle(node).backgroundColor;
              if (background !== 'rgba(0, 0, 0, 0)') { adjacentColor = background; break; }
            }
            return {
              selector, visible, indicatorColor, adjacentColor, obscured,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              style: focused,
            };
          });
          const prior = seen.get(step.selector);
          if (prior !== undefined && step.selector !== 'body' && seen.size < focusableCount) {
            trapped = true;
            steps.push({ index, ...step, indicatorContrast: focusContrast(step) });
            break;
          }
          seen.set(step.selector, index);
          steps.push({ index, ...step, indicatorContrast: focusContrast(step) });
          if (step.selector === 'body' && index > 0) break;
        }
        return { steps: steps.map(({ indicatorColor, adjacentColor, style, ...step }) => step), trapped };
      });
      rows.push({ route: route.id, width, ...audit });
    }
  }
  return rows;
}
