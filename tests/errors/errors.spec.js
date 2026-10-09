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
		await expect(page).toHaveURL(/\/page\/terms/);
		// Missing tenant content must render the explicit fallback, not a blank shell.
		const content = page.getByRole('heading', { name: /terms/i }).first();
		const missing = page.getByText('Page Not Found', { exact: true });
		await expect(content.or(missing).first()).toBeVisible();
		if (await missing.isVisible()) test.info().annotations.push({ type: 'capability', description: 'Terms page absent on this tenant; explicit Page Not Found fallback verified' });
	});
});
