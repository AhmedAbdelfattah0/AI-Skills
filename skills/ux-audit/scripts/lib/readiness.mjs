export async function waitForReadiness(page, readySelector, timeout = 10_000) {
  await page.waitForLoadState('domcontentloaded', { timeout });
  if (readySelector) {
    await page.locator(readySelector).first().waitFor({ state: 'visible', timeout });
  } else {
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => {
        let quietTimer;
        const finish = () => {
          clearTimeout(quietTimer);
          clearTimeout(capTimer);
          observer.disconnect();
          resolve();
        };
        const schedule = () => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, 500);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
          characterData: true,
        });
        const capTimer = setTimeout(finish, 5_000);
        schedule();
      });
    });
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(
    () => requestAnimationFrame(resolve),
  )));
}
