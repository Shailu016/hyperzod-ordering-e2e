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

	test("mobile checkout entry preserves the exact cart and displays its items", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		const card = await expectFirstMerchantCard(page);
		await expect(card).toBeVisible({ timeout: 30_000 });
		await card.click();
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		const cart = await addFirstProductToCart(page);
		const { readStore } = require('../../utils/store');
		const { cartLines } = require('../../utils/policy');
		const baseline = await readStore(page);
		const expectedLines = cartLines(baseline.items);
		// The actual floating Checkout button routes directly unless the tenant enables the recommendation journey.
		const entry = page.locator('button:has(span.scheme-floating-cart-divider):visible').first();
		await expect(entry, 'floating mobile Checkout button').toBeVisible({ timeout: 60_000 });
		await expect(entry).toBeEnabled();
		await entry.click();
		if (baseline.checkoutJourneyEnabled === true) {
			require('../../utils/diagnostics').requireDependency(page, 'recommendations');
			const journey = page.locator('.v-bottom-sheet .checkout-journey-sheet:visible').first();
			await expect(journey).toBeVisible();
			const proceed = journey.locator('.checkout-journey-sheet__footer button');
			await expect(proceed).toBeEnabled({ timeout: 30_000 });
			await proceed.click();
		}
		await expect(page).toHaveURL(/\/checkout(?:[/?]|$)/);
		const checkout = page.locator('#checkout:visible');
		await expect(checkout).toBeVisible();
		await expect.poll(async () => String((await readStore(page)).cart?.cart_id)).toBe(String(cart.cart_id));
		expect(cartLines((await readStore(page)).items)).toEqual(expectedLines);
		for (const item of baseline.items) await expect(checkout).toContainText(item.product_name);
	});

	test("profile and checkout routes fit the viewport", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		for (const route of ["/en/profile", "/en/checkout"]) {
			await gotoWithRetry(page, route);
			await waitForAppBoot(page);
			await expect(page).toHaveURL(new RegExp(route + "(?:$|[?])"));
			await expect(page.locator(route.includes("checkout") ? "#checkout" : "#profile").first()).toBeVisible();
			const overflow = await page.evaluate(() => {
				const de = document.documentElement;
				return de.scrollWidth - de.clientWidth;
			});
			expect(overflow, `${route}: no horizontal overflow`).toBeLessThanOrEqual(1);
		}
	});
});
