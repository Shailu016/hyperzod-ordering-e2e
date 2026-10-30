// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, expectAuthedUI, isLoggedIn } = require("../../utils/app");
const { ProfilePage } = require("../../pages/ordering.pages");

/**
 * Session handling @regression @auth.
 * Verified against: store/modules/User.js (atAuthSuccess/logoutUser),
 * main.js backend-authoritative expiry policy, views/profile/index.vue.
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

test('expired local hint preserves the same backend-valid session @auth', async ({ page }) => {
	await ensureLocation(page);
	await ensureLoggedIn(page, undefined, { minimumValidityMs: 120_000 });
	expect(await isLoggedIn(page)).toBe(true);
	const before = await require('../../utils/store').readStore(page);
	const token = await page.evaluate(() => localStorage.getItem('access_token'));
	await page.evaluate(() => localStorage.setItem('token_expires_in', JSON.stringify(Date.now() - 1_000)));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await require('../../utils/app').waitForAppBoot(page);
	await expect.poll(async () => isLoggedIn(page)).toBe(true);
	const after = await require('../../utils/store').readStore(page);
	expect(String(after.user.id), 'same authenticated identity after reload').toBe(String(before.user.id));
	expect(await page.evaluate(() => localStorage.getItem('access_token')), 'no automatic reauthentication/token replacement').toBe(token);
	await expectAuthedUI(page);
});
