// @ts-check
/**
 * Read checkout validation state for diagnostics (and orderability verdicts).
 * Mirrors cart-place.vue disableCheckoutBtn inputs that live in vuex.
 * @returns {Promise<string>} one-line diagnostic snapshot
 */
async function readCheckoutDiagnostics(page) {
	try {
		return await page.evaluate(() => {
			try {
				const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
				const validateError = (vuex.Cart && vuex.Cart.validateError) || {};
				const loading = vuex.Cart && vuex.Cart.validateCartLoading;
				const carts = (vuex.Cart && vuex.Cart.cartMerchant) || [];
				const merchant = (Array.isArray(carts) ? carts[0] : carts) || {};
				const boot = (vuex.Utils && vuex.Utils.bootSettings) || {};
				const acceptOrders =
					boot.accept_orders && boot.accept_orders.enable_accept_orders;
				const toastEl = document.querySelector(
					".v-snackbar__content, #app-snackbar, .alert-message"
				);
				const toast = (toastEl && toastEl.innerText) || "";
				const placing =
					vuex.NotPersist && typeof vuex.NotPersist.placeOrder !== "undefined"
						? vuex.NotPersist.placeOrder
						: "n/a";
				// DOM truth: duplicate IDs across drawers/footers would make a
				// selector land on a hidden, permanently-disabled twin.
				const btns = Array.from(
					document.querySelectorAll("#OrderPlaceButton, .mobile-place-order-btn")
				).map(
					(b) =>
						`id=${b.id || "?"} visible=${b.offsetParent !== null} ` +
						`disabled=${b.disabled} ` +
						`text=${(b.innerText || "").slice(0, 30)}`
				);
				return (
					`validateError=${JSON.stringify(validateError).slice(0, 300)} ` +
					`validateLoading=${loading} ` +
					`merchant_open=${merchant.is_open} ` +
					`accepting=${merchant.is_accepting_orders} ` +
					`tenant_accept_orders=${acceptOrders} ` +
					`placing=${placing} ` +
					`buttons=[${btns.join(" | ").slice(0, 300)}] ` +
					`toast=${String(toast).slice(0, 200)}`
				);
			} catch (e) {
				return `diag-failed: ${String(e).slice(0, 100)}`;
			}
		});
	} catch {
		return "diag-unavailable";
	}
}

/** True when diagnostics prove the merchant cannot take this order
 *  (undeliverable / closed / tenant not accepting orders) as opposed to a
 *  slow-but-recoverable checkout. */
function isMerchantUnorderable(diag) {
	return /is_delivering[^0-9a-z]*false|not.?deliver|closed|not.?accepting|tenant_accept_orders[^0-9a-z]*false/i.test(
		String(diag || "")
	);
}

module.exports = { readCheckoutDiagnostics, isMerchantUnorderable };
