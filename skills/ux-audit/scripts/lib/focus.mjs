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
        const query = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
        const focusableCount = await page.locator(query).evaluateAll((elements) => elements.filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return !element.disabled && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
        }).length);
        await page.evaluate((focusQuery) => {
          const snapshot = (element) => {
            const style = getComputedStyle(element);
            const pseudo = (name) => {
              const value = getComputedStyle(element, name);
              return `${value.content}|${value.outline}|${value.boxShadow}|${value.border}|${value.background}|${value.transform}|${value.opacity}`;
            };
            return {
              outline: `${style.outlineStyle}|${style.outlineWidth}|${style.outlineColor}|${style.outlineOffset}`,
              boxShadow: style.boxShadow,
              border: `${style.borderTopWidth}|${style.borderTopStyle}|${style.borderTopColor}`,
              background: style.backgroundColor,
              textDecoration: `${style.textDecorationLine}|${style.textDecorationStyle}|${style.textDecorationColor}|${style.textDecorationThickness}`,
              before: pseudo('::before'),
              after: pseudo('::after'),
            };
          };
          // Autofocused fields are already focused on load, so a baseline taken now would
          // equal the focused style and falsely report "no indicator". Blur first, and
          // freeze transitions so neither snapshot is read mid-animation.
          const freeze = document.createElement('style');
          freeze.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
          document.head.append(freeze);
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          window.__uxAuditFocusBaseline = new Map([...document.querySelectorAll(focusQuery)].map((element) => [element, snapshot(element)]));
          const priorTabindex = document.body.getAttribute('tabindex');
          document.body.setAttribute('tabindex', '-1');
          document.body.focus({ preventScroll: true });
          if (priorTabindex === null) document.body.removeAttribute('tabindex');
          else document.body.setAttribute('tabindex', priorTabindex);
        }, query);
        const limit = Math.min(200, focusableCount + 5);
        const steps = [];
        const seen = new Map();
        let trapped = false;
        let previousSelector = null;
        let consecutiveRepeats = 0;
        for (let pressIndex = 0; pressIndex < limit; pressIndex += 1) {
          await page.keyboard.press('Tab');
          const step = await page.evaluate(() => {
            const element = document.activeElement;
            if (!(element instanceof HTMLElement) || element === document.body) {
              return { selector: 'body', visible: false, obscured: false, rect: null };
            }
            const selector = (() => {
              if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
              const parts = [];
              for (let node = element; node?.localName; node = node.parentElement) {
                if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
                const peers = node.parentElement ? [...node.parentElement.children].filter((peer) => peer.localName === node.localName) : [node];
                parts.unshift(peers.length > 1 ? `${node.localName}:nth-of-type(${peers.indexOf(node) + 1})` : node.localName);
                if (node === document.documentElement) break;
              }
              return parts.join(' > ');
            })();
            const style = getComputedStyle(element);
            const pseudo = (name) => {
              const value = getComputedStyle(element, name);
              return `${value.content}|${value.outline}|${value.boxShadow}|${value.border}|${value.background}|${value.transform}|${value.opacity}`;
            };
            // The baseline was captured from this exact element before traversal.
            // Compare focus styling, decoration, and pseudo-elements without blurring,
            // which avoids changing native segmented-control focus state mid-step.
            const focused = {
              outline: `${style.outlineStyle}|${style.outlineWidth}|${style.outlineColor}|${style.outlineOffset}`,
              boxShadow: style.boxShadow,
              border: `${style.borderTopWidth}|${style.borderTopStyle}|${style.borderTopColor}`,
              background: style.backgroundColor,
              textDecoration: `${style.textDecorationLine}|${style.textDecorationStyle}|${style.textDecorationColor}|${style.textDecorationThickness}`,
              before: pseudo('::before'),
              after: pseudo('::after'),
            };
            const unfocused = window.__uxAuditFocusBaseline.get(element) ?? focused;
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
          // Focus returning to <body> means Tab left the document: the cycle is complete.
          // It is not a focusable element, so it is never recorded as a missing indicator.
          if (step.selector === 'body') { if (steps.length > 0) break; continue; }
          if (step.selector === previousSelector && step.selector !== 'body') {
            consecutiveRepeats += 1;
            if (consecutiveRepeats <= 6) continue;
          } else consecutiveRepeats = 0;
          previousSelector = step.selector;
          const prior = seen.get(step.selector);
          const traversed = new Set(steps.map((item) => item.selector).filter((selector) => selector !== 'body'));
          if (prior !== undefined && step.selector !== 'body' && prior < steps.length - 1 && traversed.size < focusableCount) {
            trapped = true;
            steps.push({ index: steps.length, ...step, indicatorContrast: focusContrast(step) });
            break;
          }
          if (!seen.has(step.selector)) seen.set(step.selector, steps.length);
          steps.push({ index: steps.length, ...step, indicatorContrast: focusContrast(step) });
        }
        return { steps: steps.map(({ indicatorColor, adjacentColor, style, ...step }) => step), trapped };
      });
      rows.push({ route: route.id, width, ...audit });
    }
  }
  return rows;
}
