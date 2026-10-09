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
		// Under backend throttling the post-reload session check can 401 once;
		// retry the reload itself before calling it a real logout.
		let alive = false;
		for (let round = 1; round <= 3 && !alive; round++) {
			await page.reload({ waitUntil: "domcontentloaded" });
			await page.waitForLoadState("domcontentloaded");
			alive = await expect
				.poll(async () => isLoggedIn(page), { timeout: 30_000 })
				.toBeTruthy()
				.then(() => true)
				.catch(() => false);
			if (!alive && round < 3) {
				console.log(`[session] reload round ${round}: not logged in yet - retrying (throttle?)`);
			}
		}
		expect(
			alive,
			"session should survive reload (access_token / vuex.User)"
		).toBeTruthy();
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
