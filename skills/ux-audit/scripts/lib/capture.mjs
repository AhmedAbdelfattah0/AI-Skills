import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertInside, redactUrl, screenshotName } from './paths.mjs';
import { routeScenario, withAuditPage } from './runtime.mjs';

export async function runCapture({ browser, config, runDir, schemes }) {
  const screensDir = assertInside(runDir, join(runDir, 'screens'));
  await mkdir(screensDir, { recursive: true });
  const captures = [];
  for (const route of config.routes) {
    for (const width of config.viewports) {
      for (const scheme of schemes) {
        const scenario = routeScenario(config, route);
        const file = screenshotName(route.id, width, scheme, scenario);
        const relativeFile = `screens/${file}`;
        try {
          const url = await withAuditPage(browser, config, route, { width, scheme }, async (page, opened) => {
            await page.addStyleTag({ content: `
              *, *::before, *::after {
                animation-duration: 0s !important;
                animation-delay: 0s !important;
                transition-duration: 0s !important;
                transition-delay: 0s !important;
              }
            ` });
            await page.screenshot({
              path: assertInside(runDir, join(runDir, relativeFile)),
              fullPage: true,
              animations: 'disabled',
            });
            return opened.url;
          });
          captures.push({ route: route.id, scenario, width, scheme, url, file: relativeFile, status: 'ok' });
        } catch (error) {
          captures.push({
            route: route.id,
            scenario,
            width,
            scheme,
            url: redactUrl(new URL(route.path, config.baseUrl).toString()),
            file: relativeFile,
            status: 'error',
            error: error.message,
          });
        }
      }
    }
  }
  return captures;
}
