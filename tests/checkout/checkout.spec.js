// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, waitForAppBoot, expectFirstMerchantCard, gotoWithRetry } = require("../../utils/app");
const {
	addFirstProductToCart,
	ensureDeliveryAddress,
	gotoCheckout,
	isSessionRenewed,
} = require("../../flows/order.flow");

/**
 * Checkout validation states @regression @checkout.
 * COD only - never clicks a gateway button (policy).
 * Verified against: views/checkout.vue:1633 + cart/card/* components.
 */
test.describe("Checkout states @checkout", () => {
	test.beforeEach(async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		const card = await expectFirstMerchantCard(page);
		await card.click();
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		await addFirstProductToCart(page);
		const cart = await page.evaluate(() => {
			try {
				const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
				const c = vuex.Cart && (vuex.Cart.selectedCart || (vuex.Cart.cart || [])[0]);
				return c && (c.cart_id || c.id) ? { cart_id: c.cart_id || c.id } : null;
			} catch {
				return null;
			}
		});
		const cartId = cart && cart.cart_id;
		// cart-place.vue hides the place button until a delivery address is
		// set (hideOrderPlaceButton) - select one up front so every test sees
		// the real checkout state instead of depending on run order.
		// SESSION_RENEWED: logout wiped local state -> restore + retry once.
		try {
			await gotoCheckout(page, cartId);
			await ensureDeliveryAddress(page);
		} catch (err) {
			if (!isSessionRenewed(err)) throw err;
			console.log("[checkout] session renewed in setup - restoring once");
			await gotoCheckout(page, cartId);
			await ensureDeliveryAddress(page);
		}
	});

	test("bill summary and place-order button render", async ({ page }) => {
		// Desktop: #OrderPlaceButton, mobile: .mobile-place-order-btn (verified
		// in cart-place.vue). The footer hydrates after cart validation, so poll.
		await expect
			.poll(
				async () =>
					page.locator("#OrderPlaceButton, .mobile-place-order-btn").count(),
				{ timeout: 90_000, message: "place order button should hydrate" }
			)
			.toBeGreaterThan(0);
		// Bill rows render inside checkout; at minimum totals text is present.
		const bodyText = (await page.locator("#checkout").innerText()).toLowerCase();
		expect(
			/total|subtotal|delivery|amount|payable/.test(bodyText),
			"checkout shows a bill summary"
		).toBeTruthy();
	});

	test("address selection persists for delivery orders", async ({ page }) => {
		const addressCard = page.locator("#AddressCard");
		if (!(await addressCard.isVisible().catch(() => false))) {
			test.skip(true, "order type needs no delivery address (pickup-style)");
			return;
		}
		await ensureDeliveryAddress(page);
		const persisted = await page.evaluate(() => {
			try {
				const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
				return !!(vuex.Address && vuex.Address.deliveryAddress);
			} catch {
				return false;
			}
		});
		expect(persisted, "delivery address stays selected").toBeTruthy();
	});

	test("payment section lists Cash/COD when tenant offers it", async ({ page }) => {
		const methods = page.locator("#payment-card .payment-method");
		await expect(methods.first(), "payment methods listed").toBeVisible({
			timeout: 60_000,
		});
		const text = ((await methods.allInnerTexts()).join(" | ") || "").toLowerCase();
		if (!/cash|cod|delivery/.test(text)) {
			test.skip(
				true,
				`tenant offers no COD method (offers: ${text.slice(0, 120)}) - gateways out of scope`
			);
			return;
		}
		expect(/cash|cod|delivery/.test(text)).toBeTruthy();
	});
});
