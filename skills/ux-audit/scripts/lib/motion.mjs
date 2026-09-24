import { withAuditPage } from './runtime.mjs';

async function collectMotion(page) {
  return page.evaluate(() => {
    const durations = [];
    const activeDurations = [];
    const properties = new Set();
    const parseMs = (raw) => raw.trim().endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000;
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      for (const raw of [...style.transitionDuration.split(','), ...style.animationDuration.split(',')]) {
        const duration = parseMs(raw);
        if (Number.isFinite(duration) && duration > 0) {
          durations.push(duration);
          activeDurations.push(duration);
        }
      }
      const transitionDurations = style.transitionDuration.split(',').map(parseMs);
      if (transitionDurations.some((duration) => duration > 0)) {
        for (const property of style.transitionProperty.split(',')) if (property.trim() && property.trim() !== 'none') properties.add(property.trim());
      }
      if (style.animationName !== 'none' && style.animationDuration.split(',').map(parseMs).some((duration) => duration > 0)) {
        for (const name of style.animationName.split(',')) properties.add(`animation:${name.trim()}`);
      }
    }
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.style) {
          for (const raw of `${rule.style.transitionDuration},${rule.style.animationDuration}`.split(',')) {
            const duration = parseMs(raw);
            if (Number.isFinite(duration) && duration > 0) durations.push(duration);
          }
          for (const property of rule.style.transitionProperty.split(',')) if (property.trim() && property.trim() !== 'none') properties.add(property.trim());
          if (rule.style.animationName && rule.style.animationName !== 'none') properties.add(`animation:${rule.style.animationName}`);
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch { /* Cross-origin stylesheets cannot be inspected. */ }
    }
    return {
      durations: [...new Set(durations)].sort((a, b) => a - b),
      activeDurations: [...new Set(activeDurations)].sort((a, b) => a - b),
      properties: [...properties].sort(),
    };
  });
}

export async function runMotion({ browser, config }) {
  const rows = [];
  for (const route of config.routes) {
    const normal = await withAuditPage(browser, config, route, { width: 1440, scheme: 'light' }, collectMotion);
    let reducedMotionRespected = null;
    if (normal.durations.length) {
      const reduced = await withAuditPage(browser, config, route, {
        width: 1440,
        scheme: 'light',
        reducedMotion: 'reduce',
      }, collectMotion);
      reducedMotionRespected = reduced.activeDurations.length === 0 || Math.max(...reduced.activeDurations) <= 10;
    }
    rows.push({ route: route.id, reducedMotionRespected, durations: normal.durations, properties: normal.properties });
  }
  return rows;
}
