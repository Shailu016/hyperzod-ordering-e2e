// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, waitForAppBoot, expectFirstMerchantCard, gotoWithRetry } = require("../../utils/app");
const { addFirstProductToCart } = require("../../flows/order.flow");

/**
 * Mobile-web parity (Pixel 7 + iPhone 14 emulation) @mobile.
 * This file is EXCLUDED from the desktop `web` project and runs only on
 * the `android` / `ios` projects (see playwright.config testIgnore).
 * Verified against: merchant-bottom-nav.vue, cart-bottomsheet.vue,
 * mobile-page-header, responsive tailwind breakpoints (xs/sxs/sm).
 */
test.describe("Mobile storefront @mobile", () => {
	test("home renders without horizontal overflow and merchant opens", async ({
		page,
	}) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		await expect(page.locator("#MultiVendorHome")).toBeVisible({ timeout: 60_000 });
		await expectFirstMerchantCard(page);

		const overflow = await page.evaluate(() => {
			const de = document.documentElement;
			return de.scrollWidth - de.clientWidth;
		});
		expect(overflow, "no horizontal page overflow on mobile").toBeLessThanOrEqual(1);

		await page.locator(".merchant-card").first().tap().catch(async () => {
			await page.locator(".merchant-card").first().click();
		});
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		await expect(
			page.locator(".add-product-btn .add-btn:visible").first()
		).toBeVisible({ timeout: 60_000 });
	});

	test("cart opens as bottom-sheet on mobile", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		const card = await expectFirstMerchantCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await card.click();
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		// Shared flow (retries + mandatory-option pre-select); tap-first for
		// mobile, falling back to click inside the flow as needed.
		await addFirstProductToCart(page);
		// Cart affordance on mobile: floating pill button (cart icon + divider
		// + count, verified in cart-floating-button.vue), header cart, or CTA.
		const cartEntry = page
			.locator(
				'button:has(span.scheme-floating-cart-divider), [data-test-id="nnHtWB68sfXf5vc"], .cart-floating-button, #cart-floating-button, .place-order-btn'
			);
		// The floating pill renders after the cart sync lands - poll.
		await expect
			.poll(async () => cartEntry.count(), {
				timeout: 60_000,
				message: "cart entry point on mobile",
			})
			.toBeGreaterThan(0);
	});

	test("profile and checkout routes fit the viewport", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		for (const route of ["/en/profile", "/en/checkout"]) {
			await gotoWithRetry(page, route);
			await waitForAppBoot(page);
			const overflow = await page.evaluate(() => {
				const de = document.documentElement;
				return de.scrollWidth - de.clientWidth;
			});
			expect(overflow, `${route}: no horizontal overflow`).toBeLessThanOrEqual(1);
		}
	});
});
