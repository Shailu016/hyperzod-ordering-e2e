// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, waitForAppBoot, expectFirstMerchantCard, gotoWithRetry } = require("../../utils/app");
const { addFirstProductToCart, openOrderableMerchant } = require("../../flows/order.flow");

/**
 * Cart behavior @regression @cart.
 * Verified against: store/modules/Cart (optimistic sync + debounce 200ms),
 * components/cart/cart-sidepanel.vue + cart-bottomsheet.vue + multi-cart.vue.
 * Known app bug (README): removing the LAST product can return a Cart API
 * validation error - the test asserts the app stays usable, not the API.
 */
test.describe("Cart @cart", () => {
	test.beforeEach(async ({ page }) => {
		test.setTimeout(240_000);
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await openOrderableMerchant(page);
	});

	test("add product syncs cart API and cart persists across reload", async ({ page }) => {
		// Shared flow: retries under throttle and pre-selects mandatory
		// product options (else "You must choose one!" blocks the sync).
		await addFirstProductToCart(page);

		const exactBefore = require("../../utils/policy").cartLines((await require("../../utils/store").readStore(page)).items);
		const before = await page.evaluate(() => {
			try {
				const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
				return JSON.stringify((vuex.Cart && vuex.Cart.cartItems) || []).length;
			} catch {
				return 0;
			}
		});
		expect(before, "cart items stored in vuex").toBeGreaterThan(2);

		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForAppBoot(page);
		const after = await page.evaluate(() => {
			try {
				const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
				return JSON.stringify((vuex.Cart && vuex.Cart.cartItems) || []).length;
			} catch {
				return 0;
			}
		});
		expect(after, "cart survives reload").toBeGreaterThan(2);
		await expect.poll(async () => require("../../utils/policy").cartLines((await require("../../utils/store").readStore(page)).items)).toEqual(exactBefore);
	});

	test("quantity stepper increases line quantity", async ({ page }) => {
		await addFirstProductToCart(page);
		const totalQty = () =>
			page.evaluate(() => {
				try {
					const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
					const items = (vuex.Cart && vuex.Cart.cartItems) || [];
					return items.map((i) => i.quantity || 0).reduce((a, b) => a + b, 0);
				} catch {
					return 0;
				}
			});
		await expect
			.poll(totalQty, { timeout: 30_000, message: "cart quantity after add" })
			.toBeGreaterThan(0);
		const before = await totalQty();
		// After add, a stepper (- qty +) replaces the Add button - press +
		// once and prove the line quantity actually increments. The glyphs
		// are SVGs (verified in components/common/add-product.vue), so target
		// the increment button by class, never by "+" text.
		const stepper = page.locator(".add-product-btn:visible").first();
		const plus = stepper.locator("button.increment-btn").first();
		if (!(await plus.isVisible().catch(() => false))) {
			throw new Error("Required quantity-stepper fixture is missing");
		}
		await plus.click();
		// Products with option groups re-open the addon-confirm sheet
		// ("I'LL CHOOSE" vs "REPEAT", verified live) instead of incrementing
		// directly - REPEAT keeps the previous selections and adds the line.
		const repeatBtn = page
			.locator(".v-overlay__content, .v-dialog")
			.locator("button, .v-btn")
			.filter({ hasText: /repeat/i })
			.first();
		if (await repeatBtn.isVisible().catch(() => false)) {
			await repeatBtn.click();
		}
		await expect
			.poll(totalQty, { timeout: 30_000, message: "cart quantity after increment" })
			.toBe(before + 1);
	});
});
