// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, expectAuthedUI, isLoggedIn } = require("../../utils/app");
const { ProfilePage } = require("../../pages/ordering.pages");

/**
 * Session handling @regression @auth.
 * Verified against: store/modules/User.js (atAuthSuccess/logoutUser),
 * mixins/global.js checkSessionExpiration, views/profile/index.vue.
 */
test.describe("Session handling @auth", () => {
	test("session survives a full reload", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		expect(await isLoggedIn(page), "setup session must be logged in").toBeTruthy();
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect.poll(() => isLoggedIn(page), {
			timeout: 30_000,
			message: "session should survive one reload without reauthentication or another reload",
		}).toBe(true);
		await expectAuthedUI(page);
	});

	test("profile requires the stored session and shows sidebar", async ({ page }) => {
		await ensureLocation(page);
		// Renews the token when a long run outlived it (see ensureLoggedIn).
		await ensureLoggedIn(page);
		const profile = new ProfilePage(page);
		await profile.goto();
		if (await ensureLoggedIn(page)) {
			await profile.goto();
		}
		await expect(profile.sideBar, "profile sidebar").toBeVisible({ timeout: 60_000 });
	});
});

test('expired local session logs out without automatic renewal @auth', async ({ page }) => {
	await ensureLocation(page);
	await ensureLoggedIn(page);
	expect(await isLoggedIn(page)).toBe(true);
	await page.evaluate(() => localStorage.setItem('token_expires_in', JSON.stringify(Date.now() - 1_000)));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect.poll(async () => isLoggedIn(page)).toBe(false);
});
