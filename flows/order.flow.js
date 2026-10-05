// @ts-check
/**
 * Reusable order-placement flows (COD only - payment gateways out of scope).
 * Extracted from tests/03-place-order.spec.js so every new spec shares one
 * implementation instead of copy-paste.
 */
const { expect } = require("@playwright/test");
const { API, ensureLoggedIn, gotoWithRetry } = require("../utils/app");

// Thrown when a step renewed a dead session: logout wipes local cart/address
// state, so the caller must re-navigate (gotoCheckout) and re-select the
// address, then retry the step - exactly once.
const SESSION_RENEWED = "SESSION-RENEWED";

class SessionRenewedError extends Error {
	constructor() {
		super(SESSION_RENEWED);
		this.name = "SessionRenewedError";
		this.code = SESSION_RENEWED;
	}
}

/** Typed check for renewal control-flow. Never match on raw strings. */
function isSessionRenewed(err) {
	return (
		!!err &&
		(err instanceof SessionRenewedError ||
			String((err && err.message) || err).includes(SESSION_RENEWED))
	);
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
			await row.click().catch(() => {});
		}
	}
}

async function addFirstProductToCart(page) {
	// Under backend throttling the product popup and cart sync can lag several
	// seconds, and the Add button can sit under a transient overlay:
	// re-locate + retry click and sync as a unit.
	for (let round = 1; round <= 3; round++) {
		const addBtn = page.locator(".add-product-btn .add-btn:visible").first();
		await expect(addBtn, "an Add button on the merchant menu").toBeVisible({
			timeout: 90_000,
		});
		const cartUpdate = page
			.waitForResponse(
				(r) =>
					r.url().includes(API.cart) &&
					["POST", "PUT"].includes(r.request().method()) &&
					r.status() === 200,
				{ timeout: 45_000 }
			)
			.catch(() => null);
		await addBtn.click({ timeout: 15_000 }).catch(() => {
			console.log(`[cart] add click missed (round ${round}) - retrying`);
		});
		// Product with options/instructions -> popup with its own Add button.
		const popupAdd = page
			.locator('[data-test-id="testNraKiacTeqVn"], .product-popup .add-btn')
			.first();
		try {
			await popupAdd.waitFor({ state: "visible", timeout: 15_000 });
			await selectFirstPopupOptions(page);
			await popupAdd.click();
		} catch {
			/* simple product */
		}
		await confirmDialogIfShown(page);
		const resp = await cartUpdate;
		if (resp) {
			const body = await resp.json();
			expect(body.success, `cart update failed: ${JSON.stringify(body).slice(0, 300)}`).toBeTruthy();
			return body.data;
		}
		console.log(`[cart] no cart sync after add (round ${round}) - retrying`);
	}
	throw new Error("cart update API call never completed after adding a product (3 rounds)");
}

async function ensureDeliveryAddress(page) {
	// A dead session bounces checkout away; renew first so the steps below run
	// authenticated. Renewal wipes local state -> caller must restore+retry.
	if (await ensureLoggedIn(page)) {
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
			return; // pickup-style order types don't need an address
		}
	}
	const selectPanel = page.locator("#SelectAddress");
	await expect(selectPanel, "address selection panel").toBeVisible({ timeout: 30_000 });
	const savedAddress = selectPanel.locator('[data-test-id="test-id-0"]');
	if (await savedAddress.isVisible().catch(() => false)) {
		await savedAddress.click();
	} else {
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
	if (await ensureLoggedIn(page)) {
		throw new SessionRenewedError();
	}
	const methods = page.locator("#payment-card .payment-method");
	await expect(methods.first(), "at least one payment method").toBeVisible({
		timeout: 60_000,
	});
	const cash = methods.filter({ hasText: /cash|cod|delivery/i }).first();
	if (await cash.isVisible().catch(() => false)) {
		await cash.click();
		return "cash";
	}
	throw new Error(
		"SKIP-BY-POLICY: no Cash/COD method available and payment gateways are out of scope - cannot place order without opening an external gateway."
	);
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
	await dialog.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});
	return true;
}

/**
 * Place-order button: desktop renders #OrderPlaceButton (cart-place.vue),
 * mobile renders .mobile-place-order-btn - same action, responsive markup.
 */
function placeOrderButton(page) {
	// .first(): desktop and mobile markups are exclusive per layout, but the
	// helper must never go strict-mode multi-match if both ever render.
	return page.locator("#OrderPlaceButton, .mobile-place-order-btn").first();
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
	let lastBounce = null;
	let renewed = false;
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
			lastBounce = err;
			if (attempt === 3) break;
			console.log(`[checkout] bounced out of checkout (attempt ${attempt}) - waiting 20s, re-navigating`);
			await page.waitForTimeout(20_000);
			continue;
		}
		// Phase 2: session check. Renewal failures propagate immediately -
		// they are never retried as bounces, so auth errors stay loud.
		if (await ensureLoggedIn(page)) {
			renewed = true;
			if (attempt === 3) {
				throw new Error("session kept dying on checkout after 3 renewals");
			}
			console.log("[checkout] session renewed on checkout - re-navigating to restore");
			continue;
		}
		if (attempt > 1 || renewed) console.log(`[checkout] reached (attempt ${attempt})`);
		return renewed;
	}
	throw lastBounce;
}

module.exports = {
	confirmDialogIfShown,
	selectFirstPopupOptions,
	addFirstProductToCart,
	ensureDeliveryAddress,
	chooseCashPayment,
	handleScheduleDialogIfShown,
	placeOrderButton,
	gotoCheckout,
	SESSION_RENEWED,
	SessionRenewedError,
	isSessionRenewed,
};
