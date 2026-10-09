const { test, expect } = require('../../fixtures/test.fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { ensureLocation, ensureLoggedIn, gotoAuthed } = require('../../utils/app');
test('critical routes meet WCAG A/AA automated checks and account controls receive keyboard focus @a11y', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await ensureLocation(page); await ensureLoggedIn(page);
  const violations = [];
  for (const [route, root] of [['/en/home', '#MultiVendorHome'], ['/en/profile', '#profile'], ['/en/checkout', '#checkout']]) {
    await gotoAuthed(page, route);
    await expect(page.locator(`${root}:visible`).first()).toBeVisible();
    expect(await page.title()).not.toBe('');
    expect(await page.locator('html').getAttribute('lang')).toMatch(/^[a-z]{2}/i);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await testInfo.attach(`axe-${root.slice(1)}`, { body: Buffer.from(JSON.stringify(results.violations)), contentType: 'application/json' });
    violations.push(...results.violations.map((v) => ({ route, id: v.id, impact: v.impact, nodes: v.nodes.length })));
  }
  const summary = violations.map((v) => `${v.route}: ${v.id} (${v.impact}, ${v.nodes} nodes)`).join('; ');
  expect.soft(violations, `accessibility violations: ${summary}`).toEqual([]);
  await gotoAuthed(page, '/en/home');
  const control = page.locator('#ProfileBtn:visible').first().or(page.getByRole('button', { name: /account/i }).first()).first();
  await expect(control).toBeVisible();
  let reached = false;
  for (let attempt = 0; attempt < 50 && !reached; attempt++) {
    await page.keyboard.press('Tab');
    reached = await control.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));
  }
  expect(reached, 'account control reached through keyboard traversal').toBe(true);
});
