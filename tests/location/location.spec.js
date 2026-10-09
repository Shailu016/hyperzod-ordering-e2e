// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { waitForAppBoot, ensureLocation, ensureLoggedIn, hasSelectedLocation, gotoWithRetry } = require("../../utils/app");
test.use({ apiDependencies: ["geocoding"] });

/**
 * Location gate (welcome -> home) @smoke @regression.
 * Verified against: views/index/welcome.vue, views/search/service-area.vue,
 * store/modules/Utils.js (isServiceableArea), mainApp.vue boot flow.
 */
test.describe("Location gate @smoke @location", () => {
	test("welcome redirects away once a serviceable location is stored", async ({
		page,
	}) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		const persisted = await page.evaluate(() => {
			try {
				if (localStorage.getItem("location")) return true;
				const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
				return !!(vuex.Utils && vuex.Utils.selectedLocation);
			} catch {
				return false;
			}
		});
		expect(persisted, "serviceable location must be persisted").toBeTruthy();
		expect(await hasSelectedLocation(page)).toBeTruthy();
		const location = (await require("../../utils/store").readStore(page)).location;
		await gotoWithRetry(page, "/");
		await expect(page).toHaveURL(/\/(home|m)(\/|$)/);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect.poll(async () => (await require("../../utils/store").readStore(page)).location).toEqual(location);
	});

	test("service-area map page renders without boot error", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/service-area");
		await waitForAppBoot(page);
		expect(/boot-failed|boot-error/.test(page.url())).toBeFalsy();
		await expect
			.poll(async () => page.url(), { timeout: 30_000 })
			.toMatch(/service-area/);
		await expect(page.getByRole('region', { name: 'Map', exact: true }).or(page.locator('canvas:visible')).first(), 'rendered service-area map').toBeVisible();
	});

	test("search page accepts typed global-search input", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/search");
		await waitForAppBoot(page);
		await expect(page.locator("#MultiVendorSearch")).toBeVisible({ timeout: 60_000 });
		const input = page.locator("#mobileSearchInput:visible, #navSearchBar:visible").first();
		await expect(input).toBeEditable();
		await input.fill("");
		await input.pressSequentially("e2e-fixture", { delay: 50 });
		await expect(input).toHaveValue("e2e-fixture");
	});
});
