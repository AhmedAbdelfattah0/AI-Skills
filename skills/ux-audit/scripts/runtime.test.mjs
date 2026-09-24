import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSharedAuditPages, runtimeProfile, withAuditPage } from './lib/runtime.mjs';

function fakeBrowser() {
  const state = { contexts: 0, closes: 0, navigations: 0 };
  return {
    state,
    async newContext() {
      state.contexts += 1;
      const page = {
        async goto() { state.navigations += 1; },
        url() { return 'http://fixture.test/'; },
        async waitForLoadState() {},
        locator() { return { first() { return { async waitFor() {} }; } }; },
        async evaluate() {},
      };
      return { async newPage() { return page; }, async close() { state.closes += 1; } };
    },
  };
}

test('shared observational pages navigate once per route and viewport tuple', async () => {
  const browser = fakeBrowser();
  const config = { baseUrl: 'http://fixture.test', scenarios: {} };
  const route = { id: 'home', path: '/', readySelector: 'main' };
  const options = { width: 390, scheme: 'light', shared: true };
  await withAuditPage(browser, config, route, options, async () => 'capture');
  await withAuditPage(browser, config, route, options, async () => 'axe');
  assert.equal(browser.state.contexts, 1);
  assert.equal(browser.state.navigations, 1);
  assert.equal(runtimeProfile(browser).reusedPages, 1);
  assert.deepEqual(runtimeProfile(browser).routes.home.navigations, 1);
  assert.deepEqual(runtimeProfile(browser).routes.home.reusedPages, 1);
  await closeSharedAuditPages(browser);
  assert.equal(browser.state.closes, 1);
});
