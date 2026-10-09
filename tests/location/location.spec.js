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
		page, apiDiagnostics,
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
		const { readStore } = require("../../utils/store");
		// The app starts /me and address reads asynchronously during mount.
		// A visible route or persisted location does not mean those reads ended.
		// Settle them before deliberate document changes rather than creating
		// aborts and later guessing whether they were harmless.
		await apiDiagnostics.drain(true, 20_000);
		const initial = await readStore(page);
		expect(initial.authenticated, "initial authenticated session").toBe(true);
		const ownedUserId = require("../../utils/manifest").readManifest().userId;
		expect(String(initial.user?.id), "run-owned user before redirect").toBe(String(ownedUserId));
		const location = initial.location;
		await gotoWithRetry(page, "/");
		await expect(page).toHaveURL(/\/(home|m)(\/|$)/);
		await waitForAppBoot(page);
		await apiDiagnostics.drain(true, 20_000);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForAppBoot(page);
		await apiDiagnostics.drain(true, 20_000);
		await expect(page).toHaveURL(/\/(home|m)(\/|$)/);
		await expect.poll(async () => (await readStore(page)).location).toEqual(location);
		const afterReload = await readStore(page);
		expect(afterReload.authenticated, "session must survive reload without reauthentication").toBe(true);
		expect(String(afterReload.user?.id), "same run-owned user after reload").toBe(String(ownedUserId));
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
