// @ts-check
/**
 * Reusable order-placement flows (COD only - payment gateways out of scope).
 * Extracted from tests/03-place-order.spec.js so every new spec shares one
 * implementation instead of copy-paste.
 */
const { expect } = require("@playwright/test");
const { API, ensureLoggedIn, gotoWithRetry } = require("../utils/app");
const { observeUntil } = require("../utils/observe");
const { SESSION_RENEWED, SessionRenewedError, isSessionRenewed, recoverBeforeSubmission } = require("../utils/session-recovery");

// Thrown when a step renewed a dead session: logout wipes local cart/address
// state, so the caller must re-navigate (gotoCheckout) and re-select the
// address, then retry the step - exactly once.
async function observeCheckout(page, label, ready, timeout = 60_000) {
	return observeUntil(label, async () => {
		const state = await require("../utils/store").readStore(page);
		if (state.authenticated === false) throw new SessionRenewedError();
		return state;
	}, ready, { timeout });
}

async function openOrderableMerchant(page) {
	const { expectFirstMerchantCard, waitForAppBoot } = require("../utils/app");
	const { readStore } = require("../utils/store");
	await gotoWithRetry(page, "/en/home");
	await waitForAppBoot(page);
	await expectFirstMerchantCard(page);
	const count = Math.min(await page.locator(".merchant-card:visible").count(), 3);
	for (let candidate = 0; candidate < count; candidate++) {
		if (candidate) { await gotoWithRetry(page, "/en/home"); await waitForAppBoot(page); await expectFirstMerchantCard(page); }
		await page.locator(".merchant-card:visible").nth(candidate).click();
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		const state = await observeUntil("merchant availability hydrated", () => readStore(page), (state) => typeof state.currentMerchant?.is_accepting_orders === "boolean");
		if (!state.currentMerchant.is_accepting_orders) continue;
		await expect(page.locator(".add-product-btn .add-btn:visible").first(), "orderable merchant menu").toBeEnabled({ timeout: 60_000 });
		return;
	}
	throw new Error("No accepting merchant in the bounded fixture selection; maintain the automation tenant");
}

async function confirmDialogIfShown(page) {
	// Word-boundary match: bare /ok/i would also hit "Stock", "Book",
	// "Token" buttons. Scoped to overlay/dialog content only.
	const confirmBtn = page
		.locator(".v-overlay__content, .v-dialog")
		.locator("button, .v-btn")
		.filter({ hasText: /\b(yes|confirm|replace|start fresh|proceed|ok)\b/i })
		.first();
	if (await confirmBtn.isVisible().catch(() => false)) {
		await confirmBtn.click();
		return true;
	}
	return false;
}

/**
 * Pre-select the first available row of every mandatory option group
 * (v-radio-group rows carry data-test-id="testPsOvvHqrtk1n{idx}" - verified
 * in popup/radio-list.vue). Without this, Add is blocked by
 * "You must choose one!". Harmless for optional/already-decided groups.
 */
async function selectFirstPopupOptions(page) {
	const popup = page.locator(".product-popup").first();
	const scope = ((await popup.count()) > 0 ? popup : page);
	for (const group of await scope.locator(".v-radio-group").all()) {
		const row = group
			.locator('[data-test-id^="testPsOvvHqrtk1n"]:not(.option-out-of-stock)')
			.first();
		if (await row.isVisible().catch(() => false)) {
			await row.click();
		}
	}
}

async function ensureEmptyCart(page) {
	const { readStore } = require("../utils/store");
	let state = await readStore(page);
	if (!(state.items || []).length) return;
	const entry = page.locator('button:has(span.scheme-floating-cart-divider):visible, [data-test-id="nnHtWB68sfXf5vc"]:visible').first();
	await expect(entry).toBeVisible();
	await entry.click();
	const panel = page.locator(".scheme-cart-panel:visible").first();
	await expect(panel).toBeVisible();
	for (let clicks = 0; clicks < 50 && (state.items || []).length; clicks++) {
		const before = state.items.reduce((sum, line) => sum + Number(line.quantity), 0);
		const minus = panel.locator(".decrement-btn:visible").first();
		await expect(minus).toBeEnabled();
		await minus.click();
		await expect.poll(async () => {
			state = await readStore(page);
			return (state.items || []).reduce((sum, line) => sum + Number(line.quantity), 0);
		}, { timeout: 15_000 }).toBeLessThan(before);
	}
	await page.reload({ waitUntil: "domcontentloaded" });
	await require("../utils/app").waitForAppBoot(page);
	await expect.poll(async () => (await readStore(page)).items.length).toBe(0);
}

async function addFirstProductToCart(page) {
	const merchantUrl = page.url();
	if (await ensureLoggedIn(page, undefined, { minimumValidityMs: 90_000 })) {
		await gotoWithRetry(page, merchantUrl);
		await require("../utils/app").waitForAppBoot(page);
	}
	await ensureEmptyCart(page);
	const add = page.locator(".add-product-btn .add-btn:visible").first();
	await expect(add, "merchant menu hydration").toBeEnabled({ timeout: 60_000 });
	let response, responseError;
	const waiting = page.waitForResponse(r => new URL(r.url()).pathname === API.cart && ["POST", "PUT"].includes(r.request().method()), { timeout: 70_000 });
	void waiting.then((value) => { response = value; }, (error) => { responseError = error; });
	await add.click();
	const popupAdd = page.locator('[data-test-id="testNraKiacTeqVn"]:visible, .product-popup .add-btn:visible').first();
	const confirm = page.locator(".v-overlay__content:visible, .v-dialog:visible").locator("button, .v-btn").filter({ hasText: /\b(yes|confirm|replace|start fresh|proceed|ok)\b/i }).first();
	let popupHandled = false, confirmHandled = false;
	const deadline = Date.now() + 60_000;
	while (!response) {
		const outcome = await observeUntil("cart popup or acknowledged mutation", async () => {
			if (responseError) throw responseError;
			if (response) return "response";
			if (!popupHandled && await popupAdd.isVisible()) return "popup";
			if (!confirmHandled && await confirm.isVisible()) return "confirm";
			return null;
		}, Boolean, { timeout: Math.max(1, deadline - Date.now()) });
		if (outcome === "popup") { popupHandled = true; await selectFirstPopupOptions(page); await popupAdd.click(); }
		if (outcome === "confirm") { confirmHandled = true; await confirm.click(); }
	}
	expect(response.ok(), "cart HTTP response").toBeTruthy();
	const body = await response.json();
	expect(body.success, "cart mutation succeeded").toBe(true);
	const state = await observeUntil("cart state after acknowledged mutation", () => require("../utils/store").readStore(page), (state) => !!state.cart?.cart_id && state.items?.length > 0);
	require("../utils/policy").cartLines(state.items);
	expect(state.items.length, "cart has exactly the requested fixture").toBeGreaterThan(0);
	return state.cart;
}

async function ensureDeliveryAddress(page) {
	// A dead session bounces checkout away; renew first so the steps below run
	// authenticated. Renewal wipes local state -> caller must restore+retry.
	if (await ensureLoggedIn(page, undefined, { minimumValidityMs: 120_000 })) {
		throw new SessionRenewedError();
	}
	const hasSelection = await page
		.evaluate(() => {
			try {
				const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
				return !!(vuex.Address && vuex.Address.deliveryAddress);
			} catch {
				return false;
			}
		})
		.catch(() => false);
	if (hasSelection) return;

	// Desktop (or mobile with addresses): AddressCard opens the selector.
	const addressCard = page.locator("#AddressCard");
	if (await addressCard.isVisible().catch(() => false)) {
		await addressCard.click();
	} else {
		// Mobile with no address yet: the checkout footer shows a
		// "Select Address" prompt instead of the address card (verified live).
		const selectPrompt = page
			.locator(".checkout-footer, .place-order")
			.getByText(/select address/i)
			.first();
		if (await selectPrompt.isVisible().catch(() => false)) {
			await selectPrompt.click();
		} else {
			const state = await require("../utils/store").readStore(page);
			if (!["pickup", "dine_in"].includes(state.orderType || state.validation?.order_type)) throw new Error("Delivery address UI is missing for a delivery order");
			return;
		}
	}
	const selectPanel = page.locator("#SelectAddress");
	await expect(selectPanel, "address selection panel").toBeVisible({ timeout: 30_000 });
	const savedAddress = selectPanel.locator('[data-test-id="test-id-0"]');
	if (await savedAddress.isVisible().catch(() => false)) {
		await savedAddress.click();
	} else {
		require("../utils/diagnostics").requireDependency(page, "geocoding");
		await selectPanel.locator('[data-test-id="test-id-add-address-btn"]').click();
		const form = page.locator("#addAddressForm");
		await expect(form, "add address form").toBeVisible({ timeout: 60_000 });
		// Reverse-geocode hydrates the form async - wait for fields to become
		// interactive and content to land instead of a fixed sleep.
		const building = form.locator("#building");
		await expect(building, "building/flat input").toBeEnabled({ timeout: 30_000 });
		await expect
			.poll(async () => (await form.innerText().catch(() => "")).length, {
				timeout: 30_000,
				message: "address form hydrated with location data",
			})
			.toBeGreaterThan(0);
		await expect(building, "building/flat input").toBeVisible({ timeout: 30_000 });
		await building.fill("Flat 101, E2E Test Building");
		const landmark = form.locator("#landmark");
		if (await landmark.isVisible().catch(() => false)) {
			await landmark.fill("Near central square");
		}
		const addressResp = page.waitForResponse(
			(r) => r.url().includes("/store/v1/address") && r.request().method() === "POST",
			{ timeout: 60_000 }
		);
		void addressResp.catch(() => {});
		const drawerSubmit = page.locator('[data-test-id="testLuJ2YZasEn7U"]');
		const mobileSubmit = page.locator(".scheme-address-editor__submit");
		if (await drawerSubmit.isVisible().catch(() => false)) {
			await drawerSubmit.click();
		} else if (await mobileSubmit.isVisible().catch(() => false)) {
			// Mobile edit-mode footer (confirm_location.vue) - verified in src.
			await mobileSubmit.click();
		} else {
			await page
				.locator("button, .v-btn")
				.filter({ hasText: /save|submit|add address/i })
				.last()
				.click();
		}
		const body = await (await addressResp).json();
		expect(
			body.success,
			`address creation failed: ${JSON.stringify(body).slice(0, 300)}`
		).toBeTruthy();
	}
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					try {
						const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
						return !!(vuex.Address && vuex.Address.deliveryAddress);
					} catch {
						return false;
					}
				}),
			{ timeout: 30_000, message: "delivery address should be selected" }
		)
		.toBeTruthy();
}

/**
 * COD-only payment choice (policy: gateways ignored).
 * @returns {Promise<string>} chosen method label
 */
async function chooseCashPayment(page) {
	if (await ensureLoggedIn(page, undefined, { minimumValidityMs: 120_000 })) throw new SessionRenewedError();
	const { readStore } = require("../utils/store");
	const { isCashMode } = require("../utils/policy");
	const state = await observeCheckout(page, "eligible payment modes and validation settle", (state) => state.paymentModesLoading !== true && state.validationLoading !== true && state.paymentModes?.length > 0);
	const cash = state.paymentModes.find(isCashMode);
	if (!cash) throw new Error("Required fixture has no supported offline Cash/COD payment mode");
	const row = page.locator('#payment-card [data-test-id="testhsdgs7123ds-' + cash.payment_mode.name + '"]:visible').first();
	await expect(row).toBeVisible({ timeout: 30_000 });
	if (String(state.paymentModeId) !== String(cash.payment_mode_id)) await row.click();
	await observeCheckout(page, "selected offline payment", (state) => String(state.paymentModeId) === String(cash.payment_mode_id) && state.validationLoading !== true);
	return cash;
}

async function handleScheduleDialogIfShown(page) {
	const dialog = page
		.locator(".v-dialog:visible")
		.filter({ has: page.locator(".date-btn") })
		.first();
	try {
		await dialog.waitFor({ state: "visible", timeout: 8_000 });
	} catch {
		return false;
	}
	const dateBtn = dialog.locator(".date-btn").first();
	if (await dateBtn.isVisible().catch(() => false)) await dateBtn.click();
	const timeBtn = dialog.locator(".time-btn").first();
	await timeBtn.waitFor({ state: "visible", timeout: 20_000 });
	await timeBtn.click();
	await dialog.locator(".v-card-actions .v-btn").last().click();
	await dialog.waitFor({ state: "hidden", timeout: 15_000 });
	return true;
}

/**
 * Place-order button: desktop renders #OrderPlaceButton (cart-place.vue),
 * mobile renders .mobile-place-order-btn - same action, responsive markup.
 */
function placeOrderButton(page) {
	// .first(): desktop and mobile markups are exclusive per layout, but the
	// helper must never go strict-mode multi-match if both ever render.
	return page.locator("#OrderPlaceButton:visible, .mobile-place-order-btn:visible").first();
}

/**
 * Navigate to checkout with bounce + session recovery.
 * - Transient validate failures bounce out of /checkout -> re-navigate.
 * - A dead session bounces to home AND wipes local cart/address state:
 *   renew, then re-navigate, and return renewed=true so the caller
 *   re-selects the address before continuing.
 * @returns {Promise<boolean>} true when the session was renewed mid-step
 */
async function gotoCheckout(page, cartId) {
	const url = cartId ? `/en/checkout?cart_id=${cartId}` : "/en/checkout";
	let lastBounce = new Error("Checkout did not render");
	let renewed = false;
	if (await ensureLoggedIn(page, undefined, { minimumValidityMs: 120_000 })) renewed = true;
	for (let attempt = 1; attempt <= 3; attempt++) {
		// Phase 1: reach the checkout shell. A bounce here means transient
		// validate failure -> back off and re-navigate.
		// domcontentloaded (not "load"): third-party beacons/CORS-blocked
		// calls hang the load event on the live store; the shell poll below
		// is the real readiness signal. Navigation timeouts retry as bounces.
		try {
			await gotoWithRetry(page, url);
			await page.waitForURL(/checkout/, { waitUntil: "domcontentloaded", timeout: 30_000 });
			await expect(page.locator("#checkout")).toBeVisible({ timeout: 30_000 });
		} catch (err) {
			if (!(await require("../utils/app").isLoggedIn(page))) throw new SessionRenewedError();
			lastBounce = err;
			if (attempt === 3) break;
			console.log(`[checkout] bounced out of checkout (attempt ${attempt}) - waiting 2s, re-navigating`);
			await page.waitForTimeout(2_000);
			continue;
		}
		// Phase 2: session check. Renewal failures propagate immediately -
		// they are never retried as bounces, so auth errors stay loud.
		if (!(await require("../utils/app").isLoggedIn(page))) throw new SessionRenewedError();
		if (attempt > 1 || renewed) console.log(`[checkout] reached (attempt ${attempt})`);
		return renewed;
	}
	throw lastBounce;
}

async function prepareCheckout(page, { cartId, expectedLines, selectPayment = true, forOrder = false }) {
	const { readStore } = require("../utils/store");
	const { cartLines, assertIdentity } = require("../utils/policy");
	const { readManifest } = require("../utils/manifest");
	const assertNoSubmission = () => {
		const manifest = readManifest();
		const ambiguous = manifest.submissionAttempted && !manifest.orders.length;
		if (ambiguous || (forOrder && (manifest.submissionAttempted || manifest.orders.length))) throw new Error("Order submission already attempted; reconcile instead of replaying checkout");
	};
	if (!cartId || !expectedLines?.length) throw new Error("Checkout recovery needs the acknowledged cart ID and exact line snapshot");
	return recoverBeforeSubmission({
		assertNoSubmission,
		recover: () => ensureLoggedIn(page, undefined, { minimumValidityMs: 120_000 }),
		prepare: async () => {
			await gotoCheckout(page, cartId);
			await observeCheckout(page, "same backend cart rehydrated", (state) => String(state.cart?.cart_id) === String(cartId) && state.items?.length > 0);
			await ensureDeliveryAddress(page);
			const payment = selectPayment ? await chooseCashPayment(page) : null;
			const state = await observeCheckout(page, "checkout validation finished", (state) => state.validationLoading !== true && state.cart?.cart_id != null);
			if (state.customOrderForms?.length) require('../utils/diagnostics').requireDependency(page, 'orderForms');
			assertIdentity(state.user, require("../utils/env").testUser.email, readManifest().userId);
			expect(String(state.cart.cart_id), "cart identity after session recovery").toBe(String(cartId));
			expect(cartLines(state.items), "cart lines after session recovery").toEqual(expectedLines);
			assertNoSubmission();
			return { state, payment };
		},
	});
}

module.exports = {
	confirmDialogIfShown,
	selectFirstPopupOptions,
	addFirstProductToCart,
	ensureEmptyCart,
	ensureDeliveryAddress,
	chooseCashPayment,
	handleScheduleDialogIfShown,
	placeOrderButton,
	gotoCheckout,
	prepareCheckout,
	openOrderableMerchant,
	SESSION_RENEWED,
	SessionRenewedError,
	isSessionRenewed,
};
