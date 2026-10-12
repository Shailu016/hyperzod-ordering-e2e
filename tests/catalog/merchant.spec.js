const { test, expect } = require('../../fixtures/test.fixture');
const { ensureLocation, ensureLoggedIn, gotoWithRetry, waitForAppBoot } = require('../../utils/app');
async function firstMerchant(page) {
  await ensureLocation(page); await ensureLoggedIn(page);
  await gotoWithRetry(page, '/en/home'); await waitForAppBoot(page);
  const card = page.locator('.merchant-card:visible').first();
  await expect(card).toBeVisible();
  const merchant = { id: await card.getAttribute('data-merchant-id'), name: (await card.locator('.merchant-card-title').innerText()).trim() };
  expect(merchant.id).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(merchant.name.length).toBeGreaterThan(0);
  return merchant;
}
async function openMerchant(page) {
  const merchant = await firstMerchant(page);
  await page.locator('.merchant-card:visible').first().click();
  await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForAppBoot(page);
  await expect(page.locator('.add-product-btn .add-btn:visible').first()).toBeVisible({ timeout: 60_000 });
  return merchant;
}
test('merchant search filters an unmatched query to an empty state @catalog', async ({ page }) => {
  await openMerchant(page);
  const merchantUrl = page.url().split('?')[0].replace(/\/$/, '');
  await gotoWithRetry(page, `${merchantUrl}/search`);
  const search = page.locator('#MerchantSearchPage input:visible').first();
  await expect(search).toBeVisible();
  const query = `e2e-unmatched-${process.env.E2E_RUN_ID}`;
  await search.fill(query);
  await expect(search).toHaveValue(query);
  await expect(page.locator('#MerchantSearchPage').getByText(/no results found|no products found|no item/i).first()).toBeVisible();
  await expect(page.locator('#MerchantSearchPage .add-product-btn:visible')).toHaveCount(0);
});
test('global search returns the exact merchant whose name supplied the query @catalog', async ({ page }) => {
  const { id, name } = await firstMerchant(page);
  expect(name.length).toBeGreaterThan(1);
  await gotoWithRetry(page, '/en/search');
  const input = page.locator('#mobileSearchInput:visible, #navSearchBar:visible').first();
  await expect(input).toBeVisible();
  await input.fill(name);
  const tab = page.locator('#search-merchant-tab:visible');
  await expect(tab).toBeVisible(); await tab.click();
  const { normalizeText } = require('../../utils/policy');
  const result = page.locator(`#MultiVendorSearch .merchant-card[data-merchant-id="${id}"]:visible`);
  await expect(result).toBeVisible({ timeout: 30_000 });
  expect(normalizeText(await result.locator('.merchant-card-title').innerText())).toBe(normalizeText(name));
});
test('product deep link displays product content @catalog', async ({ page }) => {
  test.skip(process.env.E2E_PRODUCT_DEEP_LINK !== 'true', 'Declared fixture capability: product deep links disabled');
  await openMerchant(page);
  const link = page.locator('a[href*="/product/"]:visible').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/product\//);
  await expect(page.locator('h1:visible').first()).not.toHaveText('');
  await expect(page.locator('.add-product-btn:visible, .product-popup:visible').first()).toBeVisible();
});
