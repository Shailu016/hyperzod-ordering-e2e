// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn } = require("../../utils/app");
const {
	addFirstProductToCart,
	prepareCheckout,
	openOrderableMerchant,
} = require("../../flows/order.flow");

/**
 * Checkout validation states @regression @checkout.
 * COD only - never clicks a gateway button (policy).
 * Verified against: views/checkout.vue:1633 + cart/card/* components.
 */
test.describe("Checkout states @checkout", () => {
	test.beforeEach(async ({ page }) => {
		test.setTimeout(300_000);
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await openOrderableMerchant(page);
		const cart = await addFirstProductToCart(page);
		const expectedLines = require("../../utils/policy").cartLines((await require("../../utils/store").readStore(page)).items);
		await prepareCheckout(page, { cartId: cart.cart_id, expectedLines });
	});

	test("bill summary and place-order button render", async ({ page }) => {
		// Desktop: #OrderPlaceButton, mobile: .mobile-place-order-btn (verified
		// in cart-place.vue). The footer hydrates after cart validation, so poll.
		await expect(require("../../flows/order.flow").placeOrderButton(page), "place order button should render visibly").toBeVisible({ timeout: 30_000 });
		const state = await require("../../utils/store").readStore(page);
		require("../../utils/policy").validateBill(state.cart);
		await expect(page.locator('#summary:visible')).toContainText(state.cart.total_amount_formatted);
		await page.locator('#summary:visible').click();
		const details = page.locator('.v-card:visible').filter({ has: page.locator('.v-card-title').filter({ hasText: /bill details/i }) }).last();
		await expect(details, 'expanded bill details').toBeVisible();
		for (const key of ['sub_total_amount', 'total_amount', 'delivery_fee', 'delivery_tax', 'tax', 'packaging_charge', 'discount_amount', 'tip_amount', 'merchant_tip_amount']) {
			if (Number(state.cart[key]) > 0 && state.cart[key + '_formatted']) await expect(details).toContainText(state.cart[key + '_formatted']);
		}
		// Visible bill and backend line amounts must agree.
		const bodyText = (await page.locator("#checkout").innerText()).toLowerCase();
		expect(
			/total|subtotal|delivery|amount|payable/.test(bodyText),
			"checkout shows a bill summary"
		).toBeTruthy();
	});

	test("payment section lists Cash/COD when tenant offers it", async ({ page }) => {
		const current = await require("../../utils/store").readStore(page);
		const { payment: chosen } = await prepareCheckout(page, { cartId: current.cart.cart_id, expectedLines: require("../../utils/policy").cartLines(current.items) });
		expect(require("../../utils/policy").isCashMode(chosen)).toBe(true);
	});
});
