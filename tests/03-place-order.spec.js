// @ts-check
const { test, expect } = require("../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, gotoAuthed, gotoWithRetry, waitForAppBoot, API } = require("../utils/app");
const { visibleToastText } = require("../utils/reporting");
const {
	addFirstProductToCart,
	ensureDeliveryAddress,
	chooseCashPayment,
	handleScheduleDialogIfShown,
	placeOrderButton,
	gotoCheckout,
	isSessionRenewed,
} = require("../flows/order.flow");
const {
	readCheckoutDiagnostics,
	isMerchantUnorderable,
} = require("../flows/checkout.flow");

/**
 * Full end-to-end order placement (COD ONLY - gateways out of scope):
 * home -> merchant -> add product to cart -> checkout -> address ->
 * Cash/COD -> place order -> success page -> order visible in history.
 *
 * Tenant data varies per run (pickup-only merchants, closed merchants with
 * disabled place buttons), so up to 3 merchants are tried: a merchant is
 * skipped when it offers no COD or proves unorderable via checkout
 * diagnostics. Only a genuinely broken checkout fails the test.
 */

test.describe("Order placement @smoke @checkout", () => {
	test("places a COD order end-to-end and sees it in order history", async ({ page }) => {
		test.setTimeout(600_000);

		await ensureLocation(page);
		await ensureLoggedIn(page);

		let orderId = null;
		let tried = 0;
		for (let idx = 0; idx < 3 && !orderId; idx++) {
			tried = idx + 1;
			// ---- 1. Pick a merchant --------------------------------------
			await gotoWithRetry(page, "/en/home");
			await waitForAppBoot(page);
			const merchantCard = page.locator(".merchant-card").nth(idx);
			await expect(merchantCard, `merchant #${tried} available on home`).toBeVisible({
				timeout: 90_000,
			});
			await merchantCard.click();
			await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
			await expect(
				page.locator(".add-product-btn .add-btn").first(),
				"merchant menu should load"
			).toBeVisible({ timeout: 60_000 });

			// ---- 2. Add product to cart ----------------------------------
			const cart = await addFirstProductToCart(page);
			const activeCartId = (cart && cart.cart_id) || null;

			// ---- 3. Checkout + address (restore once on session renewal) --
			try {
				await gotoCheckout(page, activeCartId);
				await ensureDeliveryAddress(page);
			} catch (err) {
				if (!isSessionRenewed(err)) throw err;
				console.log("[order] session renewed during address step - restoring once");
				await gotoCheckout(page, activeCartId);
				await ensureDeliveryAddress(page);
			}

			// ---- 4. Cash/COD payment --------------------------------------
			let method = null;
			try {
				method = await chooseCashPayment(page);
			} catch (err) {
				const msg = String(err && err.message ? err.message : err);
				if (isSessionRenewed(err)) {
					console.log("[order] session renewed during payment step - restoring once");
					await gotoCheckout(page, activeCartId);
					await ensureDeliveryAddress(page);
					method = await chooseCashPayment(page);
				} else if (!msg.startsWith("SKIP-BY-POLICY")) {
					throw err;
				} else {
					console.log(`[order] merchant #${tried} has no COD - trying next merchant`);
					continue;
				}
			}
			console.log(`[order] using payment method: ${method} (merchant #${tried})`);

			// ---- 5. Place the order --------------------------------------
			let orderBody = null;
			const orderListener = page
				.waitForResponse(
					(r) => r.url().includes(API.placeOrder) && r.request().method() === "POST",
					{ timeout: 150_000 }
				)
				.then(async (r) => {
					orderBody = await r.json();
				})
				.catch(() => {});

			const placeBtn = placeOrderButton(page);
			await expect
				.poll(async () => placeBtn.count(), {
					timeout: 90_000,
					message: "place order button",
				})
				.toBeGreaterThan(0);
			// The button stays disabled while cart validation is in-flight
			// (cartLoading). Under backend throttle that can outlast short
			// waits - let validation settle BEFORE judging enabled state.
			await expect
				.poll(
					async () =>
						page.evaluate(() => {
							try {
								const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
								return !!(vuex.Cart && vuex.Cart.validateCartLoading);
							} catch {
								return false;
							}
						}),
					{ timeout: 120_000, message: "cart validation to settle" }
				)
				.toBe(false);
			try {
				await expect(placeBtn, "place order button enabled").toBeEnabled({
					timeout: 60_000,
				});
			} catch (err) {
				const diag = await readCheckoutDiagnostics(page);
				console.log(`[order] place button stayed disabled (merchant #${tried}): ${diag}`);
				if (isMerchantUnorderable(diag)) {
					console.log(`[order] merchant #${tried} unorderable - trying next merchant`);
					continue;
				}
				throw err;
			}
			const placeBtnLabel = (await placeBtn.innerText()).trim();
			console.log(`[order] place button label: ${placeBtnLabel}`);
			await placeBtn.click();

			// Closed merchants require picking a schedule slot first.
			if (await handleScheduleDialogIfShown(page)) {
				await expect(placeBtn).toBeEnabled({ timeout: 30_000 });
				await placeBtn.click();
				console.log("[order] picked first available schedule slot");
			}

			await expect
				.poll(async () => (orderBody ? true : await visibleToastText(page)), {
					timeout: 150_000,
					message: "order API was never called - check toast/validation errors",
				})
				.toBe(true);

			expect(
				orderBody.success,
				`order placement failed: ${JSON.stringify(orderBody).slice(0, 500)}`
			).toBeTruthy();

			orderId =
				(orderBody.data && (orderBody.data.order_id || orderBody.data.id)) || null;
			console.log(`[order] placed order id: ${orderId} (merchant #${tried})`);

			// ---- 6. Success page ------------------------------------------
			await page.waitForURL(/order\/success|profile\/order/, { waitUntil: "domcontentloaded", timeout: 120_000 });
		}
		if (!orderId) {
			test.skip(
				true,
				"SKIP-BY-POLICY: no orderable COD merchant found on 3 tried merchants and gateways are out of scope."
			);
			return;
		}

		// ---- 7. Verify in order history ------------------------------------
		await gotoAuthed(page, "/en/profile/orders");
		await expect(page.locator("#orders")).toBeVisible({ timeout: 60_000 });

		// order-card.vue exposes data-test-id="test-id-<order_id>" (no id attr).
		await expect(
			page.locator(`#orders [data-test-id="test-id-${orderId}"]`),
			`order ${orderId} should appear in order history`
		).toBeVisible({ timeout: 60_000 });
	});
});
