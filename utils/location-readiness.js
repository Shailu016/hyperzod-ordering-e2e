const { expect } = require('@playwright/test');

// A persisted location does not imply an unobstructed header. These drawers
// ignore Escape; use the location drawer's own close control, never a store
// mutation, forced click, or a blanket "close the last dialog" fallback.
async function dismissSettledLocationDrawer(page, hasSelectedLocation, { timeout = 10_000 } = {}) {
  // Mobile uses a separate fullscreen searchModal, titled "Select your
  // location". Its Back header closes only searchModal through the UI.
  const searchSheet = page.locator('.scheme-location-search-host.v-overlay--active')
    .filter({ has: page.locator('#mobileLocationSearch .scheme-location-search__header') }).filter({ visible: true });
  let closedSearch = false;
  if (await searchSheet.count() && await hasSelectedLocation(page)) {
    await expect(searchSheet, 'one active mobile location search sheet').toHaveCount(1, { timeout });
    await searchSheet.locator('#mobileLocationSearch .scheme-location-search__header').click({ timeout });
    await expect(searchSheet, 'mobile location search must close before continuing').toHaveCount(0, { timeout });
    if (!await hasSelectedLocation(page)) throw new Error('Closing mobile location search lost the selected location');
    closedSearch = true;
  }
  const drawer = page.locator('.location-panel.v-navigation-drawer--active, .v-bottom-sheet.v-overlay--active')
    .filter({ has: page.getByText(/^search for your location$/i) }).filter({ visible: true });
  if (!await drawer.count()) return closedSearch;
  if (!await hasSelectedLocation(page)) return false; // a mandatory picker must be satisfied normally
  await expect(drawer, 'one active location drawer').toHaveCount(1, { timeout });
  const close = drawer.locator('.v-card-title')
    .filter({ has: page.getByText(/^search for your location$/i) }).locator('button').filter({ visible: true });
  await expect(close, 'settled location drawer close control').toHaveCount(1, { timeout });
  await close.click({ timeout });
  await expect(drawer, 'location drawer must close before auth navigation').toHaveCount(0, { timeout });
  // Auth, address and cart panels reuse the same overlay class. Only the
  // sibling overlay belonging to the location panel is ours to observe.
  await expect(page.locator('.location-overlay:has(+ .location-panel):visible'), 'location scrim must stop covering the header').toHaveCount(0, { timeout });
  if (!await hasSelectedLocation(page)) throw new Error('Closing the location drawer lost the selected location');
  return true;
}

module.exports = { dismissSettledLocationDrawer };
