const clamp = (number, min = 0, max = 1) => Math.min(max, Math.max(min, number));
const round = (number, digits = 4) => Number(number.toFixed(digits));

function hueToRgb(p, q, rawHue) {
  let hue = rawHue;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 360;
  if (saturation === 0) return [lightness, lightness, lightness];
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

function angle(raw) {
  const token = raw.trim().toLowerCase();
  if (token.endsWith('turn')) return Number.parseFloat(token) * 360;
  if (token.endsWith('rad')) return Number.parseFloat(token) * 180 / Math.PI;
  if (token.endsWith('grad')) return Number.parseFloat(token) * 0.9;
  return Number.parseFloat(token);
}

function alphaValue(raw = '1') {
  return raw.trim().endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
}

function parseHex(input) {
  const hex = input.slice(1);
  if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/i.test(hex)) return null;
  const expanded = hex.length < 5 ? [...hex].map((part) => part.repeat(2)).join('') : hex;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16) / 255,
    g: Number.parseInt(expanded.slice(2, 4), 16) / 255,
    b: Number.parseInt(expanded.slice(4, 6), 16) / 255,
    a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function parseRgb(input) {
  const match = input.match(/^rgba?\((.*)\)$/i);
  if (!match) return null;
  const [channels, alpha] = match[1].split('/');
  const parts = channels.trim().split(/[\s,]+/).filter(Boolean);
  const legacyAlpha = alpha ?? (parts.length === 4 ? parts.pop() : undefined);
  if (parts.length !== 3) return null;
  const rgb = parts.map((part) => part.endsWith('%')
    ? Number.parseFloat(part) / 100
    : Number.parseFloat(part) / 255);
  if (rgb.some((part) => !Number.isFinite(part))) return null;
  return { r: clamp(rgb[0]), g: clamp(rgb[1]), b: clamp(rgb[2]), a: clamp(alphaValue(legacyAlpha)) };
}

function parseHsl(input) {
  const match = input.match(/^hsla?\((.*)\)$/i);
  if (!match) return null;
  const [channels, alpha] = match[1].split('/');
  const parts = channels.trim().split(/[\s,]+/).filter(Boolean);
  const legacyAlpha = alpha ?? (parts.length === 4 ? parts.pop() : undefined);
  if (parts.length < 3) return null;
  const hue = angle(parts[0]);
  const saturation = Number.parseFloat(parts[1]) / 100;
  const lightness = Number.parseFloat(parts[2]) / 100;
  if (![hue, saturation, lightness].every(Number.isFinite)) return null;
  const [r, g, b] = hslToRgb(hue, clamp(saturation), clamp(lightness));
  return { r, g, b, a: clamp(alphaValue(legacyAlpha)) };
}

function oklabToRgb(lightness, a, b) {
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((channel) => clamp(channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055));
}

function parseOklch(input) {
  const match = input.match(/^oklch\((.*)\)$/i);
  if (!match) return null;
  const [channels, alpha] = match[1].split('/');
  const parts = channels.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] === 'none') return null;
  const lightness = parts[0].endsWith('%') ? Number.parseFloat(parts[0]) / 100 : Number.parseFloat(parts[0]);
  const chroma = Number.parseFloat(parts[1]);
  const hue = parts[2] === 'none' ? 0 : angle(parts[2]);
  if (![lightness, chroma, hue].every(Number.isFinite)) return null;
  const radians = hue * Math.PI / 180;
  const [r, g, b] = oklabToRgb(lightness, chroma * Math.cos(radians), chroma * Math.sin(radians));
  return { r, g, b, a: clamp(alphaValue(alpha)), oklch: { l: lightness, c: chroma, h: ((hue % 360) + 360) % 360 } };
}

export function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  if (normalized === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return (normalized.startsWith('#') && parseHex(normalized))
    || parseRgb(normalized)
    || parseHsl(normalized)
    || parseOklch(normalized);
}

export function composite(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (name) => (foreground[name] * foreground.a
    + background[name] * background.a * (1 - foreground.a)) / alpha;
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
}

function linearize(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color) {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

export function contrastRatio(foreground, background) {
  const bg = background.a < 1 ? composite(background, { r: 1, g: 1, b: 1, a: 1 }) : background;
  const fg = foreground.a < 1 ? composite(foreground, bg) : foreground;
  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToOklch(color) {
  const linear = [color.r, color.g, color.b].map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  const l = Math.cbrt(0.4122214708 * linear[0] + 0.5363325363 * linear[1] + 0.0514459929 * linear[2]);
  const m = Math.cbrt(0.2119034982 * linear[0] + 0.6806995451 * linear[1] + 0.1073969566 * linear[2]);
  const s = Math.cbrt(0.0883024619 * linear[0] + 0.2817188376 * linear[1] + 0.6299787005 * linear[2]);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, b);
  const hue = chroma < 0.00001 ? 0 : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: hue };
}

export function toOklch(input) {
  const color = typeof input === 'string' ? parseColor(input) : input;
  return color ? (color.oklch ?? rgbToOklch(color)) : null;
}

function hex(color) {
  const channel = (number) => Math.round(clamp(number) * 255).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

export function proposeCompliant(rawColor, rawBackground, target) {
  const color = typeof rawColor === 'string' ? parseColor(rawColor) : rawColor;
  const background = typeof rawBackground === 'string' ? parseColor(rawBackground) : rawBackground;
  if (!color || !background || !Number.isFinite(target) || target < 1) return null;
  if (contrastRatio(color, background) >= target) {
    const source = toOklch(color);
    return { color: hex(color), ratio: round(contrastRatio(color, background), 2), oklch: source };
  }
  const source = toOklch(color);
  let best = null;
  for (let index = 0; index <= 2000; index += 1) {
    const lightness = index / 2000;
    const radians = source.h * Math.PI / 180;
    const [r, g, b] = oklabToRgb(lightness, source.c * Math.cos(radians), source.c * Math.sin(radians));
    const candidate = { r, g, b, a: color.a };
    const ratio = contrastRatio(candidate, background);
    if (ratio + 1e-9 < target) continue;
    const distance = Math.abs(lightness - source.l);
    if (!best || distance < best.distance) best = { candidate, ratio, distance, lightness };
  }
  if (!best) return null;
  return {
    color: hex(best.candidate),
    ratio: round(best.ratio, 2),
    oklch: { l: round(best.lightness), c: round(source.c), h: round(source.h, 2) },
  };
}
