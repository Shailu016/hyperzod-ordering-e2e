// @ts-check
/**
 * Page objects for the Hyperzod ordering app.
 * Only models with real importers live here - do not add speculative POMs.
 * Selectors are verified against hyperzod-ui-ordering src (see utils/app.js header).
 */
const { expect } = require("@playwright/test");
const { waitForAppBoot, gotoWithRetry } = require("../utils/app");

class ProfilePage {
	/** @param {import("@playwright/test").Page} page */
	constructor(page) {
		this.page = page;
		this.root = page.locator("#profile:visible").first();
		this.sideBar = page.locator("#ProfileSideBar:visible").first(); // id rendered twice (layout + page)
		this.logoutItem = page.locator('[data-test-id="test0id836jsdhGS"]').first();
		this.editProfileBtn = page.locator('[data-test-id="testNgbezEkhT3CN"]:visible').first();
	}
	async goto(tab) {
		await gotoWithRetry(this.page, tab ? `/en/profile/${tab}` : "/en/profile");
		await waitForAppBoot(this.page);
		await expect(this.root).toBeVisible({ timeout: 60_000 });
	}
}

module.exports = { ProfilePage };
