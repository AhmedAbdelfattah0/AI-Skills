import { composite, contrastRatio, parseColor, proposeCompliant } from './color.mjs';
import { withAuditPage } from './runtime.mjs';

const roundedRatio = (foreground, background) => Number(contrastRatio(foreground, background).toFixed(2));

function sameColor(left, right) {
  return left && right && ['r', 'g', 'b'].every((channel) => Math.abs(left[channel] - right[channel]) < 1 / 255);
}

function opaqueBackground(layers) {
  let background = parseColor('#ffffff');
  for (const layer of [...layers].reverse()) {
    const parsed = parseColor(layer);
    if (parsed) background = composite(parsed, background);
  }
  return background;
}

function measuredRow(raw, kind, foregroundRaw, required) {
  if (raw.unmeasurable) {
    return {
      kind,
      selector: raw.selector,
      fg: foregroundRaw,
      bg: raw.backgrounds.at(-1) ?? null,
      ratio: null,
      required,
      pass: false,
      status: 'unmeasurable',
      reason: raw.unmeasurable,
    };
  }
  const foreground = parseColor(foregroundRaw);
  const background = opaqueBackground(raw.backgrounds);
  if (!foreground || !background) {
    return { kind, selector: raw.selector, fg: foregroundRaw, bg: raw.backgrounds.at(-1) ?? null,
      ratio: null, required, pass: false, status: 'unmeasurable', reason: 'unsupported-color' };
  }
  const ratio = roundedRatio(foreground, background);
  return {
    kind,
    selector: raw.selector,
    fg: foregroundRaw,
    bg: `rgb(${Math.round(background.r * 255)}, ${Math.round(background.g * 255)}, ${Math.round(background.b * 255)})`,
    ratio,
    required,
    pass: ratio >= required,
    status: 'measured',
  };
}

function lockedRows(raw, lockedColors) {
  const property = ['color', 'backgroundColor', 'borderColor']
    .find((candidate) => lockedColors.some((brand) => sameColor(parseColor(raw[candidate]), brand)));
  if (!property) return [];
  const used = parseColor(raw[property]);
  const required = property === 'color' && raw.text ? raw.required : 3;
  const measured = measuredRow(raw, 'locked-brand', raw[property], required);
  if (measured.status === 'measured' && !measured.pass) {
    const proposal = proposeCompliant(used, opaqueBackground(raw.backgrounds), measured.required);
    if (proposal) measured.proposal = { color: proposal.color, ratio: proposal.ratio };
  }
  return [measured];
}

export async function runContrast({ browser, config, schemes }) {
  const rows = [];
  const locked = (config.lockedColors ?? [])
    .map(parseColor)
    .filter(Boolean);
  for (const route of config.routes) {
    for (const width of config.viewports) {
      for (const scheme of schemes) {
        const rawRows = await withAuditPage(browser, config, route, { width, scheme }, (page) => page.evaluate(() => {
          const selector = (element) => {
            if (element.id) return `#${CSS.escape(element.id)}`;
            const parts = [];
            for (let node = element; node?.localName && node !== document.documentElement && parts.length < 5; node = node.parentElement) {
              const siblings = node.parentElement
                ? [...node.parentElement.children].filter((sibling) => sibling.localName === node.localName)
                : [];
              parts.unshift(`${node.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`);
            }
            return parts.join(' > ');
          };
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll('body *')].filter(visible).flatMap((element) => {
            const style = getComputedStyle(element);
            const backgrounds = [];
            let unmeasurable = null;
            for (let node = element; node; node = node.parentElement) {
              const ancestorStyle = getComputedStyle(node);
              if (ancestorStyle.backgroundImage !== 'none') unmeasurable = 'background-image-or-gradient';
              backgrounds.push(ancestorStyle.backgroundColor);
            }
            if (element.closest('video')) unmeasurable = 'video-background';
            const text = [...element.childNodes]
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent.trim()).join(' ');
            const weight = Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
            const fontSize = Number.parseFloat(style.fontSize);
            const required = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700) ? 3 : 4.5;
            const tag = element.localName;
            const interactive = ['input', 'select', 'textarea', 'button'].includes(tag);
            const result = [{
              selector: selector(element), tag, text: Boolean(text), interactive, required,
              color: style.color, backgroundColor: style.backgroundColor,
              borderColor: style.borderTopColor, backgrounds, unmeasurable,
            }];
            return result;
          });
        }));
        for (const raw of rawRows) {
          if (raw.text) rows.push({ route: route.id, width, scheme, ...measuredRow(raw, 'text', raw.color, raw.required) });
          if (raw.interactive) {
            const foreground = raw.tag === 'button' && raw.backgroundColor !== 'rgba(0, 0, 0, 0)'
              ? raw.backgroundColor
              : raw.borderColor;
            rows.push({ route: route.id, width, scheme, ...measuredRow(raw, 'non-text', foreground, 3) });
          }
          rows.push(...lockedRows(raw, locked).map((row) => ({ route: route.id, width, scheme, ...row })));
        }
        const focusRows = await withAuditPage(browser, config, route, { width, scheme }, (page) => page.evaluate(async () => {
          const candidates = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
            .filter((element) => element.getBoundingClientRect().width > 0 && !element.disabled);
          const rows = [];
          for (const element of candidates.slice(0, 100)) {
            element.focus();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const style = getComputedStyle(element);
            if (style.outlineStyle === 'none' || Number.parseFloat(style.outlineWidth) === 0) continue;
            const backgrounds = [];
            for (let node = element; node; node = node.parentElement) backgrounds.push(getComputedStyle(node).backgroundColor);
            rows.push({ selector: element.id ? `#${CSS.escape(element.id)}` : element.localName,
              foreground: style.outlineColor, backgrounds, unmeasurable: null });
          }
          return rows;
        }));
        for (const raw of focusRows) {
          rows.push({ route: route.id, width, scheme, ...measuredRow(raw, 'non-text', raw.foreground, 3) });
        }
      }
    }
  }
  return rows;
}
