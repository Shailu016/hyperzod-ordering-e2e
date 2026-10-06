const { test, expect } = require('../../fixtures/test.fixture');
const { ensureLocation, ensureLoggedIn, gotoWithRetry, waitForAppBoot } = require('../../utils/app');
async function openMerchant(page) {
  await ensureLocation(page); await ensureLoggedIn(page);
  await gotoWithRetry(page, '/en/home'); await waitForAppBoot(page);
  await page.locator('.merchant-card:visible').first().click();
  await page.waitForURL(/\/m(\/|$)/);
  await expect(page.locator('h1:visible').first()).toBeVisible();
}
test('merchant search filters an unmatched query to an empty state @catalog', async ({ page }) => {
  await openMerchant(page);
  const merchantUrl = page.url().split('?')[0].replace(/\/$/, '');
  await gotoWithRetry(page, `${merchantUrl}/search`);
  const search = page.locator('#MerchantSearchPage input:visible').first();
  await expect(search).toBeVisible();
  const query = `e2e-unmatched-${process.env.E2E_RUN_ID}`;
  await search.fill(''); await search.pressSequentially(query, { delay: 30 });
  await expect(search).toHaveValue(query);
  await expect(page.locator('#MerchantSearchPage').getByText(/no results found|no products found|no item/i).first()).toBeVisible();
  await expect(page.locator('#MerchantSearchPage .add-product-btn:visible')).toHaveCount(0);
});
test('global search returns the exact merchant whose name supplied the query @catalog', async ({ page }) => {
  await openMerchant(page);
  const name = (await page.locator('h1:visible').first().innerText()).trim();
  expect(name.length).toBeGreaterThan(1);
  await gotoWithRetry(page, '/en/search');
  const input = page.locator('#mobileSearchInput:visible, #navSearchBar:visible').first();
  await expect(input).toBeVisible();
  await input.fill(''); await input.pressSequentially(name, { delay: 50 });
  const tab = page.locator('#search-merchant-tab:visible');
  await expect(tab).toBeVisible(); await tab.click();
  await expect(page.locator('#MultiVendorSearch .merchant-card:visible').filter({ hasText: name }).first()).toBeVisible({ timeout: 30_000 });
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
