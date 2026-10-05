// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, waitForAppBoot, gotoWithRetry } = require("../../utils/app");

/**
 * Error + guard pages @regression.
 * Verified against: views/errors/*.vue, router guards (maintenance/blocked).
 */
test.describe("Error pages @errors", () => {
	test("custom CMS page route does not crash the shell", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/page/terms");
		await waitForAppBoot(page);
		expect(/boot-failed|boot-error/.test(page.url())).toBeFalsy();
		await expect(page.locator("#app-router-view, #app").first()).toBeVisible();
	});
});
