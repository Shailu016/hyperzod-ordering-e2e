// @ts-check
const { test, expect } = require("../fixtures/test.fixture");
const { waitForAppBoot, ensureLocation, ensureLoggedIn, gotoAuthed, gotoWithRetry } = require("../utils/app");

/**
 * Smoke sweep over every user-reachable page of the ordering app.
 * Runs with the authenticated storage state created by the setup project.
 */

async function assertNoBootError(page) {
	expect(
		/boot-failed|boot-error/.test(page.url()),
		`page landed on a boot error: ${page.url()}`
	).toBeFalsy();
}

test.describe("Page sweep - every page renders @smoke @regression", () => {
	test.beforeEach(async ({ page }) => {
		// Guarantees location + session are hydrated before deep links.
		// ensureLoggedIn renews the token when a long run outlives it.
		await ensureLocation(page);
		await ensureLoggedIn(page);
	});

	test("home page renders merchants", async ({ page }) => {
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		await expect(page.locator("#MultiVendorHome")).toBeVisible({ timeout: 60_000 });
		await expect(
			page.locator(".merchant-card").first(),
			"at least one merchant card on home"
		).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("search page renders", async ({ page }) => {
		await gotoWithRetry(page, "/en/search");
		await waitForAppBoot(page);
		await expect(page.locator("#MultiVendorSearch")).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("merchant page opens from home and shows products", async ({ page }) => {
		await gotoWithRetry(page, "/en/home");
		const firstMerchant = page.locator(".merchant-card").first();
		await expect(firstMerchant).toBeVisible({ timeout: 60_000 });
		await firstMerchant.click();

		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		await expect(
			page.locator(".add-product-btn .add-btn").first(),
			"merchant menu should expose add-to-cart buttons"
		).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("checkout page renders (empty cart state)", async ({ page }) => {
		await gotoWithRetry(page, "/en/checkout");
		await waitForAppBoot(page);
		await expect(page.locator("#checkout")).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("profile page renders", async ({ page }) => {
		await gotoWithRetry(page, "/en/profile");
		await waitForAppBoot(page);
		// #profile exists on both the layout and the page component
		await expect(page.locator("#profile").first()).toBeVisible({ timeout: 60_000 });
		// #ProfileSideBar is duplicated across layout breakpoints - use the first.
		await expect(page.locator("#ProfileSideBar").first()).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("orders page renders", async ({ page }) => {
		await gotoAuthed(page, "/en/profile/orders");
		await expect(page.locator("#orders")).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("addresses page renders", async ({ page }) => {
		await gotoAuthed(page, "/en/profile/address");
		await expect(page.locator("#addresses")).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("language page renders", async ({ page }) => {
		await gotoAuthed(page, "/en/profile/language");
		await expect(page.locator("#Languages")).toBeVisible({ timeout: 60_000 });
		await assertNoBootError(page);
	});

	test("help page renders", async ({ page }) => {
		await gotoAuthed(page, "/en/profile/help");
		// Help page has no stable id - it must at least stay on the route.
		// Desktop renders the profile sidebar; mobile renders its own header.
		await expect(page).toHaveURL(/profile\/help/, { timeout: 60_000 });
		const sideBar = page.locator("#ProfileSideBar").first();
		const helpHeading = page.getByRole("heading", { name: /help/i }).first();
		await expect
			.poll(
				async () =>
					(await sideBar.isVisible().catch(() => false)) ||
					(await helpHeading.isVisible().catch(() => false)),
				{ timeout: 60_000, message: "help layout (sidebar or heading)" }
			)
			.toBeTruthy();
		await assertNoBootError(page);
	});
});
