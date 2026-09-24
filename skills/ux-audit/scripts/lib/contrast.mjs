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

function cssRgb(color) {
  return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
}

function measuredRow(raw, kind, foregroundRaw, required, backgrounds, unmeasurable) {
  if (unmeasurable) return { kind, selector: raw.selector, fg: foregroundRaw, bg: backgrounds.at(-1) ?? null,
    ratio: null, required, pass: false, status: 'unmeasurable', reason: unmeasurable };
  const foreground = parseColor(foregroundRaw);
  const background = opaqueBackground(backgrounds);
  if (!foreground || !background) return { kind, selector: raw.selector, fg: foregroundRaw, bg: backgrounds.at(-1) ?? null,
    ratio: null, required, pass: false, status: 'unmeasurable', reason: 'unsupported-color' };
  const ratio = roundedRatio(foreground, background);
  return { kind, selector: raw.selector, fg: foregroundRaw, bg: cssRgb(background), ratio,
    required, pass: ratio >= required, status: 'measured' };
}

export function boundaryRow(raw) {
  if (raw.boundaryType === 'none') return { kind: 'non-text', selector: raw.selector, fg: raw.backgroundColor,
    bg: raw.parentBackgrounds.at(-1) ?? null, ratio: null, required: 3, pass: false,
    status: 'unmeasurable', reason: 'no-visible-boundary' };
  const foreground = raw.boundaryType === 'border' ? raw.borderColor : raw.backgroundColor;
  const row = measuredRow(raw, 'non-text', foreground, 3, raw.parentBackgrounds, raw.parentUnmeasurable);
  if (row.status === 'measured' && sameColor(parseColor(row.fg), parseColor(row.bg))) {
    return { ...row, ratio: null, pass: false, status: 'unmeasurable', reason: 'no-visible-boundary' };
  }
  return row;
}

export function lockedRow(raw, lockedColors) {
  let foreground;
  let backgrounds;
  let required;
  let unmeasurable;
  let comparisonBackground;
  if (raw.text && lockedColors.some((brand) => sameColor(parseColor(raw.color), brand))) {
    foreground = raw.color;
    backgrounds = raw.textBackgrounds;
    required = raw.required;
    unmeasurable = raw.textUnmeasurable;
    comparisonBackground = opaqueBackground(backgrounds);
  } else if (raw.controlWithText && lockedColors.some((brand) => sameColor(parseColor(raw.backgroundColor), brand))) {
    foreground = raw.backgroundColor;
    backgrounds = [raw.color];
    required = raw.required;
    comparisonBackground = parseColor(raw.color);
  } else {
    const boundary = raw.boundaryType === 'border' ? raw.borderColor
      : raw.boundaryType === 'background' ? raw.backgroundColor : null;
    if (!raw.nonTextEligible || !boundary || !lockedColors.some((brand) => sameColor(parseColor(boundary), brand))) return null;
    foreground = boundary;
    backgrounds = raw.parentBackgrounds;
    required = 3;
    unmeasurable = raw.parentUnmeasurable;
    comparisonBackground = opaqueBackground(backgrounds);
  }
  const measured = measuredRow(raw, 'locked-brand', foreground, required, backgrounds, unmeasurable);
  if (measured.status === 'measured' && !measured.pass) {
    const proposal = proposeCompliant(parseColor(foreground), comparisonBackground, required);
    if (proposal) measured.proposal = { color: proposal.color, ratio: proposal.ratio };
  }
  return measured;
}

export async function runContrast({ browser, config, schemes }) {
  const rows = [];
  const locked = (config.lockedColors ?? []).map(parseColor).filter(Boolean);
  for (const route of config.routes) {
    for (const width of config.viewports) {
      for (const scheme of schemes) {
        const rawRows = await withAuditPage(browser, config, route, { width, scheme, shared: true }, (page) => page.evaluate(() => {
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
          const transparent = (value) => value === 'transparent' || /rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(value);
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll('body *')].filter(visible).map((element) => {
            const style = getComputedStyle(element);
            const parentBackgrounds = [];
            let parentUnmeasurable = null;
            for (let node = element.parentElement; node; node = node.parentElement) {
              const ancestorStyle = getComputedStyle(node);
              if (ancestorStyle.backgroundImage !== 'none') parentUnmeasurable = 'background-image-or-gradient';
              parentBackgrounds.push(ancestorStyle.backgroundColor);
            }
            const ownImage = style.backgroundImage !== 'none';
            const textUnmeasurable = element.closest('video') ? 'video-background'
              : ownImage || parentUnmeasurable ? 'background-image-or-gradient' : null;
            const visibleText = [...element.childNodes].filter((node) => {
              const owner = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
              return !owner?.closest('[aria-hidden="true"]');
            }).map((node) => node.nodeType === Node.TEXT_NODE ? node.textContent : node.innerText).join(' ').trim();
            const directText = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent.trim()).filter(Boolean).join(' ');
            const weight = Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
            const fontSize = Number.parseFloat(style.fontSize);
            const required = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700) ? 3 : 4.5;
            const role = element.getAttribute('role');
            const formControl = ['input', 'select', 'textarea'].includes(element.localName)
              || ['checkbox', 'radio', 'switch', 'combobox', 'textbox', 'slider', 'spinbutton'].includes(role);
            const stateIndicator = ['checkbox', 'radio', 'switch', 'tab', 'option'].includes(role)
              || element.matches('input[type="checkbox"],input[type="radio"]');
            const iconOnly = (element.matches('button,[role="button"]') && !visibleText);
            const nonTextEligible = formControl || stateIndicator || iconOnly;
            const controlWithText = element.matches('button,[role="button"],input[type="button"],input[type="submit"]') && Boolean(visibleText);
            const borderWidth = Math.max(...['Top', 'Right', 'Bottom', 'Left'].map((side) => Number.parseFloat(style[`border${side}Width`]) || 0));
            const borderVisible = borderWidth > 0 && style.borderTopStyle !== 'none' && style.borderTopStyle !== 'hidden' && !transparent(style.borderTopColor);
            const backgroundVisible = !transparent(style.backgroundColor);
            return {
              selector: selector(element), text: Boolean(directText), visibleText: Boolean(visibleText), controlWithText, required, nonTextEligible,
              color: style.color, backgroundColor: style.backgroundColor, borderColor: style.borderTopColor,
              textBackgrounds: [style.backgroundColor, ...parentBackgrounds], parentBackgrounds,
              textUnmeasurable, parentUnmeasurable,
              boundaryType: borderVisible ? 'border' : backgroundVisible ? 'background' : 'none',
            };
          });
        }));
        for (const raw of rawRows) {
          if (raw.text) rows.push({ route: route.id, width, scheme,
            ...measuredRow(raw, 'text', raw.color, raw.required, raw.textBackgrounds, raw.textUnmeasurable) });
          if (raw.nonTextEligible) rows.push({ route: route.id, width, scheme, ...boundaryRow(raw) });
          const brand = lockedRow(raw, locked);
          if (brand) rows.push({ route: route.id, width, scheme, ...brand });
        }
      }
    }
  }
  return rows;
}
