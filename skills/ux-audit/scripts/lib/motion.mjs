import { withAuditPage } from './runtime.mjs';

async function collectMotion(page) {
  return page.evaluate(() => {
    const motions = new Map();
    const properties = new Set();
    const parseMs = (raw) => raw.trim().endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000;
    const add = (type, name, durationMs, property, loading) => {
      if (!name || name === 'none' || !Number.isFinite(durationMs) || durationMs <= 0) return;
      const key = `${type}:${name}`;
      const existing = motions.get(key) ?? { type, name, durationMs: 0, properties: new Set(), loading: false };
      existing.durationMs = Math.max(existing.durationMs, durationMs);
      if (property) existing.properties.add(property);
      existing.loading ||= loading;
      motions.set(key, existing);
    };
    const keyframeProperties = new Map();
    const visitRules = (rules) => {
      for (const rule of rules) {
        if (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule) {
          const used = new Set();
          for (const frame of rule.cssRules) for (const property of frame.style) used.add(property);
          keyframeProperties.set(rule.name, used);
        }
        if (rule.cssRules) visitRules(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { visitRules(sheet.cssRules); } catch { /* Cross-origin stylesheets cannot be inspected. */ }
    }
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      const loading = element.matches('[aria-busy="true"],[role="progressbar"]') || /(?:spinner|loading)/i.test(element.className || '');
      const transitionNames = style.transitionProperty.split(',').map((value) => value.trim());
      const transitionDurations = style.transitionDuration.split(',').map(parseMs);
      for (let index = 0; index < transitionNames.length; index += 1) {
        const property = transitionNames[index];
        const duration = transitionDurations[index % transitionDurations.length];
        if (property && property !== 'none') { properties.add(property); add('transition', property, duration, property, loading); }
      }
      const animationNames = style.animationName.split(',').map((value) => value.trim());
      const animationDurations = style.animationDuration.split(',').map(parseMs);
      for (let index = 0; index < animationNames.length; index += 1) {
        const name = animationNames[index];
        const duration = animationDurations[index % animationDurations.length];
        if (name && name !== 'none') {
          properties.add(`animation:${name}`);
          const animated = keyframeProperties.get(name) ?? new Set();
          for (const property of animated) properties.add(property);
          add('animation', name, duration, [...animated].join(','), loading || /(?:spin|spinner|loading)/i.test(name));
        }
      }
    }
    return {
      motions: [...motions.values()].map((item) => ({ ...item, properties: [...item.properties] })),
      properties: [...properties].sort(),
    };
  });
}

export function classifyMotion(item, reduced) {
  const reducedItem = reduced.motions.find((candidate) => candidate.type === item.type && candidate.name === item.name);
  const reducedDuration = reducedItem?.durationMs ?? 0;
  const properties = item.properties.join(',');
  const loadingSpinner = item.loading && item.type === 'animation';
  const shortColor = item.type === 'transition' && item.durationMs <= 200
    && item.properties.every((property) => /^(?:color|background-color|border.*color|opacity)$/.test(property));
  const exempt = loadingSpinner || shortColor;
  const reason = loadingSpinner ? 'loading-spinner' : shortColor ? 'short-color-or-opacity-transition' : undefined;
  const nonEssential = item.durationMs > 200 || /(?:transform|translate|top|right|bottom|left|inset|position)/.test(properties);
  return { name: item.name, type: item.type, durationMs: item.durationMs,
    respected: reducedDuration <= 10, exempt, ...(reason ? { reason } : {}), nonEssential };
}

export async function runMotion({ browser, config }) {
  const rows = [];
  for (const route of config.routes) {
    const normal = await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, collectMotion);
    let reducedMotionRespected = null;
    let motion = [];
    if (normal.motions.length) {
      const reduced = await withAuditPage(browser, config, route, {
        width: 1440,
        scheme: 'light',
        reducedMotion: 'reduce',
      }, collectMotion);
      motion = normal.motions.map((item) => classifyMotion(item, reduced));
      const applicable = motion.filter((item) => item.nonEssential && !item.exempt);
      reducedMotionRespected = applicable.every((item) => item.respected);
    }
    rows.push({ route: route.id, respected: reducedMotionRespected, reducedMotionRespected,
      motion: motion.map(({ nonEssential, ...item }) => item),
      durations: [...new Set(normal.motions.map((item) => item.durationMs))].sort((a, b) => a - b), properties: normal.properties });
  }
  return rows;
}
