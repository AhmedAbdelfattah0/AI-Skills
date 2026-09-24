import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parseColor, toOklch } from './color.mjs';
import { extractTailwindConfig, filesMatchingGlobs } from './stack.mjs';
import { withAuditPage } from './runtime.mjs';

const TOKEN_KEYS = ['spacing', 'fontSize', 'fontFamily', 'color', 'radius', 'shadow', 'duration'];
const COMMON_FONT_SCALE = [12, 14, 16, 18, 20, 24, 30, 32, 36, 48, 60, 72];

function emptyCounts() {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, {}]));
}

function increment(counts, key, rawValue, amount = 1) {
  const tokenValue = String(rawValue ?? '').trim();
  if (!tokenValue || tokenValue === 'none' || tokenValue === '0s' || tokenValue === '0px') return;
  if (key === 'spacing' && /^(?:normal|auto|initial|inherit|unset|revert(?:-layer)?)$/i.test(tokenValue)) return;
  counts[key][tokenValue] = (counts[key][tokenValue] ?? 0) + amount;
}

function mergeCounts(target, source) {
  for (const key of TOKEN_KEYS) {
    for (const [tokenValue, count] of Object.entries(source[key] ?? {})) increment(target, key, tokenValue, count);
  }
}

const PROPERTY_BUCKETS = {
  'font-size': 'fontSize', 'font-family': 'fontFamily', color: 'color',
  'background-color': 'color', 'border-color': 'color', 'border-top-color': 'color',
  'border-right-color': 'color', 'border-bottom-color': 'color', 'border-left-color': 'color',
  'border-radius': 'radius', 'box-shadow': 'shadow', 'transition-duration': 'duration',
  'animation-duration': 'duration',
};

function bucketFor(property) {
  if (/^(?:margin|padding)(?:-(?:top|right|bottom|left))?$|^(?:row-|column-)?gap$/.test(property)) return 'spacing';
  if (/^border-(?:top-|right-|bottom-|left-)?radius$/.test(property)) return 'radius';
  return PROPERTY_BUCKETS[property];
}

function customPropertyBucket(property, tokenValue) {
  if (parseColor(tokenValue)) return 'color';
  if (/^-?\d*\.?\d+(?:ms|s)$/i.test(tokenValue)) return 'duration';
  if (/font.*(?:size|scale)/i.test(property)) return 'fontSize';
  if (/font.*family/i.test(property)) return 'fontFamily';
  if (/radius|rounded/i.test(property)) return 'radius';
  if (/shadow/i.test(property)) return 'shadow';
  if (/space|spacing|gap|margin|padding/i.test(property)) return 'spacing';
  return null;
}

export function extractDeclaredCss(css, counts = emptyCounts(), customProperties = {}) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declaration = /(--[\w-]+|[\w-]+)\s*:\s*([^;{}]+)\s*(?:;|(?=}))/g;
  for (const match of withoutComments.matchAll(declaration)) {
    const property = match[1].toLowerCase();
    const tokenValue = match[2].trim();
    if (property.startsWith('--')) customProperties[property] = tokenValue;
    const bucket = property.startsWith('--') ? customPropertyBucket(property, tokenValue) : bucketFor(property);
    if (!bucket) continue;
    for (const part of ['color', 'duration'].includes(bucket) ? tokenValue.split(',') : [tokenValue]) increment(counts, bucket, part);
  }
  return { counts, customProperties };
}

function pixels(raw) {
  const value = String(raw).trim();
  const px = value.match(/^(-?\d*\.?\d+)px$/i);
  if (px) return Number(px[1]);
  const rem = value.match(/^(-?\d*\.?\d+)rem$/i);
  return rem ? Number(rem[1]) * 16 : null;
}

function weightedEntries(counts) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

export function clusterSpacing(counts) {
  const clusters = new Map();
  for (const [tokenValue, count] of Object.entries(counts)) {
    const number = pixels(tokenValue);
    if (number === null) continue;
    const step = Math.abs(number) <= 32 ? 4 : 8;
    const representative = `${Math.round(number / step) * step}px`;
    if (!clusters.has(representative)) clusters.set(representative, { value: representative, count: 0, sources: [] });
    const cluster = clusters.get(representative);
    cluster.count += count;
    cluster.sources.push(tokenValue);
  }
  return [...clusters.values()].sort((left, right) => pixels(left.value) - pixels(right.value));
}

export function clusterFontSizes(counts) {
  const entries = Object.entries(counts).map(([value, count]) => ({ value, size: pixels(value), count })).filter((entry) => entry.size);
  if (!entries.length) return [];
  const ratios = [1.125, 1.2, 1.25, 1.333];
  const bases = [...new Set(entries.map((entry) => entry.size))];
  let fit;
  for (const base of bases) {
    for (const ratio of ratios) {
      const error = entries.reduce((sum, entry) => {
        const exponent = Math.round(Math.log(entry.size / base) / Math.log(ratio));
        return sum + Math.abs(base * ratio ** exponent - entry.size) * entry.count;
      }, 0);
      if (!fit || error < fit.error) fit = { base, ratio, error };
    }
  }
  const groups = new Map();
  for (const entry of entries) {
    const exponent = Math.round(Math.log(entry.size / fit.base) / Math.log(fit.ratio));
    const tokenValue = `${Number((fit.base * fit.ratio ** exponent).toFixed(2))}px`;
    if (!groups.has(tokenValue)) groups.set(tokenValue, { value: tokenValue, count: 0, sources: [], ratio: fit.ratio });
    const group = groups.get(tokenValue);
    group.count += entry.count;
    group.sources.push(entry.value);
  }
  return [...groups.values()].sort((left, right) => pixels(left.value) - pixels(right.value));
}

function inferredFontScale(counts) {
  const weighted = weightedEntries(counts)
    .map(([value, count]) => ({ size: pixels(value), count }))
    .filter((entry) => entry.size !== null);
  const observed = weighted.map((entry) => entry.size);
  const scale = [...COMMON_FONT_SCALE];
  let best;
  for (const base of [...new Set([16, ...weighted.slice(0, 5).map((entry) => entry.size)])]) {
    for (const ratio of [1.125, 1.2, 1.25, 1.333]) {
      const candidate = Array.from({ length: 13 }, (_, index) => base * ratio ** (index - 4));
      const nonCommonMatches = observed.filter((size) => !COMMON_FONT_SCALE.some((known) => Math.abs(known - size) <= 0.5)
        && candidate.some((known) => Math.abs(known - size) <= 0.5));
      const error = weighted.reduce((sum, entry) => {
        const nearest = Math.min(...candidate.map((known) => Math.abs(known - entry.size)));
        return sum + nearest * entry.count;
      }, 0);
      if (nonCommonMatches.length >= 3 && (!best || nonCommonMatches.length > best.matches ||
        (nonCommonMatches.length === best.matches && error < best.error))) {
        best = { candidate, matches: nonCommonMatches.length, error };
      }
    }
  }
  if (best) scale.push(...best.candidate);
  return scale;
}

export function fontSizeOffScale(counts, configuredScale) {
  const scale = configuredScale?.length ? configuredScale : inferredFontScale(counts);
  return Object.keys(counts).filter((tokenValue) => {
    const size = pixels(tokenValue);
    return size !== null && !scale.some((known) => Math.abs(known - size) <= 0.5);
  });
}

export function spacingOffScale(counts, configuredScale) {
  return Object.keys(counts).filter((tokenValue) => {
    const size = pixels(tokenValue);
    if (size === null) return false;
    if (configuredScale?.length) return !configuredScale.some((known) => Math.abs(known - size) <= 0.5);
    return Math.abs(size % (Math.abs(size) <= 32 ? 4 : 8)) > 0.001;
  });
}

function topLevels(counts, maximum = 5) {
  return weightedEntries(counts).slice(0, maximum).map(([value, count]) => ({ value, count }));
}

function colorVector(raw) {
  const parsed = parseColor(raw);
  const color = parsed && toOklch(parsed);
  if (!color) return null;
  const radians = color.h * Math.PI / 180;
  return [color.l, color.c * Math.cos(radians), color.c * Math.sin(radians)];
}

export function clusterColors(counts, threshold = 0.02) {
  const clusters = [];
  for (const [tokenValue, count] of weightedEntries(counts)) {
    const vector = colorVector(tokenValue);
    if (!vector) continue;
    const existing = clusters.find((cluster) => Math.hypot(...vector.map((part, index) => part - cluster.vector[index])) < threshold);
    if (existing) { existing.count += count; existing.sources.push(tokenValue); }
    else clusters.push({ representative: tokenValue, count, sources: [tokenValue], vector });
  }
  return Object.fromEntries(clusters.map(({ representative, count, sources }) => [representative, { count, sources }]));
}

function proposalFormat(stack) {
  const primary = stack.frameworks[0]?.id;
  if (primary === 'tailwind') return 'tailwind-theme';
  if (primary === 'bootstrap') return 'bootstrap-sass';
  if (['angular-material', 'mui', 'chakra', 'styled-components', 'emotion'].includes(primary)) return 'js-theme';
  return 'css-custom-properties';
}

function nearestScale(raw, keys = {}) {
  const value = pixels(raw);
  if (value === null) return null;
  return Object.entries(keys).map(([key, size]) => ({ key, size, distance: Math.abs(size - value) }))
    .sort((left, right) => left.distance - right.distance || left.size - right.size)[0] ?? null;
}

function semanticTokenName(category, raw, stack) {
  const value = pixels(raw);
  const fontScale = stack.scales?.fontSize ?? [];
  if (category === 'fontSize' && value !== null && fontScale.length && value < Math.min(...fontScale)) return '2xs';
  if (category === 'fontSize') return value >= 48 ? 'display' : 'caption';
  if (category === 'spacing') return value <= 16 ? 'compact' : value <= 48 ? 'control' : 'layout';
  if (category === 'radius') return value <= 4 ? 'subtle' : value <= 12 ? 'card' : 'surface';
  return category;
}

function deviationEntries(category, counts, offScale, stack, threshold = 3) {
  const keys = stack.scales?.keys?.[category] ?? {};
  const names = new Map();
  return offScale.map((value) => {
    const count = counts[value] ?? 0;
    const nearest = nearestScale(value, keys);
    if (count <= threshold && nearest) return { value, count, action: 'use-existing', key: nearest.key,
      target: `${nearest.size}px`, recommendation: category === 'fontSize' ? `text-${nearest.key}` : nearest.key };
    const baseKey = semanticTokenName(category, value, stack);
    const occurrence = (names.get(baseKey) ?? 0) + 1;
    names.set(baseKey, occurrence);
    const key = occurrence === 1 ? baseKey : `${baseKey}-${occurrence}`;
    return { value, count, action: 'add-token', key,
      recommendation: category === 'fontSize' ? `text-${key}` : key };
  }).sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export function stripTransparentShadowLayers(value) {
  const text = String(value);
  const layers = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if ((char === ',' && depth === 0) || index === text.length) {
      const layer = text.slice(start, index).trim();
      if (layer && !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/i.test(layer) && !/\/\s*0(?:\.0+)?\s*\)/i.test(layer)) layers.push(layer);
      start = index + 1;
    }
  }
  return layers.join(', ') || 'none';
}

function brandPalette(lockedColors, combinedColors, declaredTheme = []) {
  const result = {};
  // A locked colour the project's theme already defines needs no new token: proposing
  // `brand-1: #B8843A` beside an existing `brand-500: #B8843A` only duplicates identity.
  const declaredHex = new Set(declaredTheme.map((entry) => String(entry.value).trim().toLowerCase()));
  for (const [index, raw] of lockedColors.entries()) {
    if (declaredHex.has(String(raw).trim().toLowerCase())) continue;
    const color = toOklch(raw);
    if (!color) continue;
    const sameHue = Object.keys(combinedColors).map((value) => toOklch(value)).filter(Boolean)
      .filter((candidate) => Math.abs(candidate.h - color.h) <= 8 && candidate.c > 0.02);
    const prefix = lockedColors.length === 1 ? 'brand' : `brand-${index + 1}`;
    result[prefix] = { value: raw, source: 'lockedColors' };
    if (sameHue.length < 3) {
      result[`${prefix}-light`] = { value: `oklch(${Math.min(0.95, color.l + 0.16).toFixed(3)} ${color.c.toFixed(3)} ${color.h.toFixed(1)})`, source: 'lockedColors-tint' };
      result[`${prefix}-dark`] = { value: `oklch(${Math.max(0.2, color.l - 0.16).toFixed(3)} ${color.c.toFixed(3)} ${color.h.toFixed(1)})`, source: 'lockedColors-shade' };
    }
  }
  return result;
}

function proposalSnippet(format, proposal, stack) {
  const added = (group) => proposal[group].filter((entry) => entry.action === 'add-token').slice(0, 5);
  const groups = { spacing: added('spacing'), fontSize: added('fontSize'), radius: added('radius'),
    shadow: proposal.shadow.slice(0, 5), color: Object.entries(proposal.color).slice(0, 8) };
  if (format === 'tailwind-theme') {
    if (stack.tokenSources.some((source) => source.kind === 'theme-css')) {
      const variables = [
        ...groups.spacing.map((entry) => [`--spacing-${entry.key}`, entry.value]),
        ...groups.fontSize.map((entry) => [`--text-${entry.key}`, entry.value]),
        ...groups.radius.map((entry) => [`--radius-${entry.key}`, entry.value]),
        ...groups.shadow.map((entry) => [`--shadow-${entry.key}`, entry.value]),
        ...groups.color.map(([name, entry]) => [`--color-${name}`, entry.value]),
      ];
      return `@theme {\n${variables.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`;
    }
    const object = (entries) => entries.map((entry) => `'${entry.key}': '${entry.value}'`).join(', ');
    const colors = groups.color.map(([name, entry]) => `'${name}': '${entry.value}'`).join(', ');
    return `theme: { extend: { spacing: { ${object(groups.spacing)} }, fontSize: { ${object(groups.fontSize)} }, borderRadius: { ${object(groups.radius)} }, boxShadow: { ${object(groups.shadow)} }, colors: { ${colors} } } }`;
  }
  if (format === 'bootstrap-sass') {
    return [`$spacers: (${groups.spacing.map((entry) => `${entry.key}: ${entry.value}`).join(', ')});`,
      groups.fontSize[0] ? `$font-size-base: ${groups.fontSize[0].value};` : '',
      groups.radius[0] ? `$border-radius: ${groups.radius[0].value};` : '',
      groups.shadow[0] ? `$box-shadow: ${groups.shadow[0].value};` : '',
      groups.color[0] ? `$primary: ${groups.color[0][1].value};` : ''].filter(Boolean).join('\n');
  }
  if (format === 'js-theme') {
    const object = (entries) => entries.map((entry) => `${entry.key}: '${entry.value}'`).join(', ');
    const colors = groups.color.map(([name, entry]) => `${name}: '${entry.value}'`).join(', ');
    return `const theme = { space: { ${object(groups.spacing)} }, fontSizes: { ${object(groups.fontSize)} }, radii: { ${object(groups.radius)} }, shadows: { ${object(groups.shadow)} }, colors: { ${colors} } };`;
  }
  const variables = [...groups.spacing, ...groups.fontSize, ...groups.radius, ...groups.shadow].map((entry) => [`--${entry.key}`, entry.value])
    .concat(groups.color.map(([name, entry]) => [`--${name}`, entry.value]));
  return `:root {\n${variables.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}`;
}

export function tokenProposal(rendered, declared, stack = { frameworks: [{ id: 'plain-css' }], tokenSources: [], scales: { keys: {} } }, options = {}) {
  const combined = emptyCounts();
  mergeCounts(combined, rendered);
  mergeCounts(combined, declared);
  const offScale = options.offScale ?? {
    spacing: spacingOffScale(combined.spacing, stack.scales?.spacing),
    fontSize: fontSizeOffScale(combined.fontSize, stack.scales?.fontSize),
  };
  const radiusOffScale = Object.keys(combined.radius).filter((value) => {
    const size = pixels(value);
    return size !== null && stack.scales?.radius?.length && !stack.scales.radius.some((known) => Math.abs(known - size) <= 0.5);
  });
  const proposal = {
    spacing: deviationEntries('spacing', combined.spacing, offScale.spacing, stack),
    fontSize: deviationEntries('fontSize', combined.fontSize, offScale.fontSize, stack),
    radius: deviationEntries('radius', combined.radius, radiusOffScale, stack),
    shadow: topLevels(combined.shadow).map((entry, index) => ({ ...entry,
      key: `elevation-${index + 1}`, value: stripTransparentShadowLayers(entry.value) }))
      // `none` and `!important` overrides are resets, not elevation levels.
      .filter((entry) => !/^none\b/i.test(entry.value) && !/!important/i.test(entry.value))
      .map((entry, index) => ({ ...entry, key: `elevation-${index + 1}` })),
    color: brandPalette(options.lockedColors ?? [], combined.color, declared.theme ?? []),
    colorClusters: clusterColors(combined.color),
  };
  proposal.format = proposalFormat(stack);
  proposal.snippet = proposalSnippet(proposal.format, proposal, stack);
  return proposal;
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function extractTailwindArbitrary(source, file) {
  const rows = [];
  const attribute = /(?:class|className)\s*=\s*(?:["']([^"']*)["']|\{?`([^`]*)`\}?)/g;
  for (const match of source.matchAll(attribute)) {
    const classes = match[1] ?? match[2] ?? '';
    for (const utility of classes.matchAll(/(?:^|\s)([^\s"'`]*-\[([^\]]+)\])/g)) {
      rows.push({ file, line: lineAt(source, match.index + utility.index), value: utility[2], utility: utility[1] });
    }
  }
  const inlineStyle = /style\s*=\s*(?:["']([^"']+)["']|\{\{([^}]+)\}\})/g;
  for (const match of source.matchAll(inlineStyle)) {
    const body = match[1] ?? match[2];
    for (const declaration of body.matchAll(/([\w-]+)\s*:\s*['"]?([^;,}'"]+)/g)) {
      rows.push({ file, line: lineAt(source, match.index + declaration.index), value: declaration[2].trim(), utility: `inline-style:${declaration[1]}` });
    }
  }
  return rows;
}

function arbitraryCategory(row) {
  if (row.utility.startsWith('inline-style:')) return bucketFor(row.utility.slice('inline-style:'.length));
  const utility = row.utility.split(':').at(-1);
  if (/^(?:[mp][trblxy]?|gap(?:-[xy])?|space-[xy]|(?:min-|max-)?[wh]|inset(?:-[xy])?|top|right|bottom|left)-/i.test(utility)) return 'spacing';
  if (/^rounded(?:-[trbl]{1,2})?-/i.test(utility)) return 'radius';
  if (/^text-/i.test(utility) && pixels(row.value) !== null) return 'fontSize';
  if (/^(?:text|bg|border|fill|stroke)-/i.test(utility) && parseColor(row.value)) return 'color';
  return null;
}

function addThemeRecord(declared, file, name, tokenValue, category) {
  declared.theme.push({ file, name, value: tokenValue, category });
  if (category) increment(declared, category, tokenValue);
}

function tailwindThemeFromConfig(declared, file, source) {
  const theme = extractTailwindConfig(source);
  for (const [name, tokenValue] of Object.entries(theme.spacing)) addThemeRecord(declared, file, name, tokenValue, 'spacing');
  for (const [name, tokenValue] of Object.entries(theme.colors)) addThemeRecord(declared, file, name, tokenValue, 'color');
  for (const [name, tokenValue] of Object.entries(theme.fontSize)) addThemeRecord(declared, file, name, tokenValue, 'fontSize');
  for (const [name, tokenValue] of Object.entries(theme.borderRadius)) addThemeRecord(declared, file, name, tokenValue, 'radius');
}

function tailwindThemeFromCss(declared, file, source) {
  const themeBlock = source.match(/@theme\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  for (const match of themeBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const category = name.startsWith('--spacing') ? 'spacing' : name.startsWith('--color') ? 'color'
      : name.startsWith('--radius') ? 'radius' : name.startsWith('--font-size') ? 'fontSize' : null;
    addThemeRecord(declared, file, name, match[2].trim(), category);
    declared.customProperties[name] = match[2].trim();
  }
}

function extractSassOverrides(declared, file, source) {
  for (const match of source.matchAll(/\$([\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const tokenValue = match[2].trim();
    const category = /spacer|spacing|margin|padding/.test(name) ? 'spacing'
      : /font-size/.test(name) ? 'fontSize' : /border-radius/.test(name) ? 'radius'
        : /box-shadow/.test(name) ? 'shadow' : /primary|secondary|success|danger|warning|info|color/.test(name) ? 'color' : null;
    if (category) addThemeRecord(declared, file, `$${name}`, tokenValue, category);
  }
}

function extractPreprocessorVariables(declared, file, source, sigil) {
  const escaped = sigil === '$' ? '\\$' : '@';
  const pattern = new RegExp(`${escaped}([\\w-]+)\\s*:\\s*([^;{}]+);`, 'g');
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    const tokenValue = match[2].trim();
    const category = customPropertyBucket(name, tokenValue)
      ?? (/font/i.test(name) && pixels(tokenValue) !== null ? 'fontSize' : null)
      ?? (pixels(tokenValue) !== null ? 'spacing' : null);
    if (category) addThemeRecord(declared, file, `${sigil}${name}`, tokenValue, category);
  }
}

function extractJsTheme(declared, file, source) {
  for (const match of source.matchAll(/(?:^|[,\s])([\w-]+)\s*:\s*['"](#[0-9a-f]{3,8}|-?\d*\.?\d+(?:px|rem))['"]/gim)) {
    const tokenValue = match[2];
    const category = parseColor(tokenValue) ? 'color' : /radius/i.test(match[1]) ? 'radius'
      : /font/i.test(match[1]) ? 'fontSize' : 'spacing';
    addThemeRecord(declared, file, match[1], tokenValue, category);
  }
}

function derivedSourceGlobs(stack) {
  if (stack.sourceGlobs?.length) return stack.sourceGlobs;
  const primary = stack.frameworks[0]?.id;
  const roots = stack.packageRoots?.length ? stack.packageRoots : ['.'];
  const rooted = (glob) => roots.map((root) => `${root === '.' ? '' : `${root}/`}${glob}`);
  if (primary === 'tailwind') return [...rooted('**/*.{css,scss,sass,less}'), ...rooted('tailwind.config.{js,cjs,mjs,ts}')];
  if (['mui', 'chakra', 'styled-components', 'emotion', 'angular-material'].includes(primary)) return rooted('**/*.{css,scss,sass,less,js,jsx,ts,tsx}');
  return rooted('**/*.{css,scss,sass,less}');
}

export async function scanDeclaredTokens({ projectRoot, stack, sourceGlobs, templateGlobs }) {
  const declared = { ...emptyCounts(), customProperties: {}, theme: [], arbitrary: [], vendorStylesheets: [...(stack.vendorStylesheets ?? [])] };
  const primary = stack.frameworks[0]?.id ?? 'unknown';
  if (primary === 'unknown') {
    declared.partial = true;
    declared.reason = 'unknown framework; declared-token authorship cannot be determined';
    return declared;
  }
  const styleFiles = await filesMatchingGlobs(projectRoot, sourceGlobs?.length ? sourceGlobs : derivedSourceGlobs(stack));
  const scanned = new Set();
  for (const absolute of styleFiles) {
    scanned.add(resolve(absolute));
    const file = relative(projectRoot, absolute).split('\\').join('/');
    const source = await readFile(absolute, 'utf8');
    if (primary === 'tailwind' && /tailwind\.config\./.test(file)) tailwindThemeFromConfig(declared, file, source);
    else if (primary === 'tailwind') {
      tailwindThemeFromCss(declared, file, source);
      extractDeclaredCss(source.replace(/@theme\s*\{[\s\S]*?\}/g, ''), declared, declared.customProperties);
    }
    else if (primary === 'bootstrap') { extractSassOverrides(declared, file, source); extractDeclaredCss(source, declared, declared.customProperties); }
    else if (['mui', 'chakra', 'styled-components', 'emotion', 'angular-material'].includes(primary)) {
      extractJsTheme(declared, file, source);
      extractDeclaredCss(source, declared, declared.customProperties);
      declared.partial = true;
      declared.reason = `${primary} theme extraction is best effort`;
    } else {
      if (primary === 'sass') extractPreprocessorVariables(declared, file, source, '$');
      if (primary === 'less') extractPreprocessorVariables(declared, file, source, '@');
      extractDeclaredCss(source, declared, declared.customProperties);
      if (primary === 'css-modules') {
        declared.partial = true;
        declared.reason = 'CSS Modules token extraction is best-effort; dynamically composed class names are not statically resolved';
      }
    }
  }
  if (primary === 'tailwind') {
    for (const tokenSource of stack.tokenSources.filter((entry) => entry.framework === 'tailwind')) {
      const absolute = resolve(projectRoot, tokenSource.path);
      if (scanned.has(absolute)) continue;
      const source = await readFile(absolute, 'utf8');
      if (tokenSource.kind === 'config') tailwindThemeFromConfig(declared, tokenSource.path, source);
      else tailwindThemeFromCss(declared, tokenSource.path, source);
    }
    const templates = await filesMatchingGlobs(projectRoot, templateGlobs?.length ? templateGlobs : stack.templateGlobs);
    for (const absolute of templates) {
      const file = relative(projectRoot, absolute).split('\\').join('/');
      const rows = extractTailwindArbitrary(await readFile(absolute, 'utf8'), file);
      for (const row of rows) {
        const category = arbitraryCategory(row);
        if (category) increment(declared, category, row.value);
      }
      declared.arbitrary.push(...rows);
    }
  }
  return declared;
}

async function renderedTokens(page) {
  return page.evaluate(() => {
    const counts = { spacing: {}, fontSize: {}, fontFamily: {}, color: {}, radius: {}, shadow: {}, duration: {}, uaDefaults: { spacing: {} } };
    const add = (bucket, tokenValue, target = counts) => {
      if (!tokenValue || tokenValue === 'none' || tokenValue === '0s' || tokenValue === '0px') return;
      if (bucket === 'spacing' && !/^-?\d*\.?\d+(?:px|rem)$/i.test(tokenValue)) return;
      target[bucket][tokenValue] = (target[bucket][tokenValue] ?? 0) + 1;
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const elements = [...document.querySelectorAll('*')].filter(visible);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;visibility:hidden;pointer-events:none';
    document.documentElement.append(iframe);
    const defaults = new Map();
    for (const tag of new Set(elements.map((element) => element.localName))) {
      const element = iframe.contentDocument.createElement(tag);
      iframe.contentDocument.body.append(element);
      const style = iframe.contentWindow.getComputedStyle(element);
      defaults.set(tag, Object.fromEntries(['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap', 'rowGap', 'columnGap'].map((property) => [property, style[property]])));
    }
    for (const element of elements) {
      const style = getComputedStyle(element);
      for (const property of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'gap', 'rowGap', 'columnGap']) {
        if (style[property] === defaults.get(element.localName)?.[property]) add('spacing', style[property], counts.uaDefaults);
        else add('spacing', style[property]);
      }
      add('fontSize', style.fontSize);
      add('fontFamily', style.fontFamily);
      for (const property of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']) add('color', style[property]);
      for (const property of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius']) add('radius', style[property]);
      add('shadow', style.boxShadow);
      for (const tokenValue of [...style.transitionDuration.split(','), ...style.animationDuration.split(',')]) add('duration', tokenValue.trim());
    }
    iframe.remove();
    return counts;
  });
}

async function cssomSources(page) {
  return page.evaluate(() => {
    const sources = [];
    const visit = (rules, blocks) => {
      for (const rule of rules) { if (rule.cssText) blocks.push(rule.cssText); if (rule.cssRules) visit(rule.cssRules, blocks); }
    };
    for (const sheet of document.styleSheets) {
      try {
        if (!sheet.href || new URL(sheet.href, location.href).origin === location.origin) {
          const blocks = [];
          visit(sheet.cssRules, blocks);
          sources.push({ href: sheet.href, css: blocks.join('\n') });
        }
      } catch { /* Cross-origin CSSOM is intentionally unavailable. */ }
    }
    return sources;
  });
}

function bootstrapVendor(source) {
  return /bootstrap/i.test(source.href ?? '') || (/--bs-[\w-]+/.test(source.css) && /\.btn(?:[,{.:\s])/.test(source.css));
}

function combinedCounts(left, right) {
  const combined = emptyCounts();
  mergeCounts(combined, left);
  mergeCounts(combined, right);
  return combined;
}

export async function runTokens({ browser, config, stack }) {
  const rendered = { ...emptyCounts(), uaDefaults: { spacing: {} } };
  const primary = stack.frameworks[0]?.id ?? 'unknown';
  const cssom = [];
  for (const route of config.routes) {
    await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, async (page) => {
      const routeTokens = await renderedTokens(page);
      mergeCounts(rendered, routeTokens);
      for (const [tokenValue, count] of Object.entries(routeTokens.uaDefaults.spacing)) {
        rendered.uaDefaults.spacing[tokenValue] = (rendered.uaDefaults.spacing[tokenValue] ?? 0) + count;
      }
      cssom.push(...await cssomSources(page));
    });
  }
  const declared = await scanDeclaredTokens({ projectRoot: config.projectRoot, stack,
    sourceGlobs: config.sourceGlobs, templateGlobs: config.templateGlobs });
  if (primary !== 'unknown' && primary !== 'tailwind') {
    for (const source of cssom) {
      if (primary === 'bootstrap' && bootstrapVendor(source)) {
        if (source.href) declared.vendorStylesheets.push(`${source.href}#bootstrap-rules`);
      } else extractDeclaredCss(source.css, declared, declared.customProperties);
    }
  }
  declared.vendorStylesheets = [...new Set(declared.vendorStylesheets)];
  const authored = combinedCounts(rendered, declared);
  const offScale = primary === 'unknown'
    ? {
        spacing: [],
        fontSize: [],
        partial: true,
        reason: 'Unknown framework: off-scale judgement is unavailable without a declared token source',
      }
    : {
        spacing: spacingOffScale(authored.spacing, stack.scales.spacing),
        fontSize: fontSizeOffScale(authored.fontSize, stack.scales.fontSize),
      };
  const proposal = tokenProposal(rendered, declared, stack, { offScale, lockedColors: config.lockedColors });
  if (primary === 'unknown') {
    proposal.partial = true;
    proposal.reason = 'Unknown framework: native proposal formatting is unavailable';
    proposal.snippet = '/* Set config.framework or sourceGlobs before mapping these values to project tokens. */';
  }
  return { rendered, declared, offScale, proposal };
}
