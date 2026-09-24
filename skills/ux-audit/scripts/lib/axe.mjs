import { withAuditPage } from './runtime.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

function trimFinding(finding) {
  return {
    id: finding.id,
    impact: finding.impact,
    tags: finding.tags,
    help: finding.help,
    nodes: finding.nodes.map((node) => ({
      target: node.target,
      html: node.html.slice(0, 300),
      summary: node.failureSummary ?? node.any?.map((check) => check.message).join('; ') ?? '',
    })),
  };
}

export async function runAxe({ browser, config, schemes, axeBuilder }) {
  const rows = [];
  for (const route of config.routes) {
    for (const width of config.viewports) {
      for (const scheme of schemes) {
        await withAuditPage(browser, config, route, { width, scheme }, async (page) => {
          const audit = await new axeBuilder({ page }).withTags(TAGS).analyze();
          rows.push({
            route: route.id,
            width,
            scheme,
            violations: audit.violations.map(trimFinding),
            incomplete: audit.incomplete.map(trimFinding),
          });
        });
      }
    }
  }
  return rows;
}
