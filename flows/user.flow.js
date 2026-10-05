// @ts-check
/**
 * Shared user-lifecycle flows.
 *
 * The suite guarantees fresh testing data on every run:
 *  - setup PURGES any leftover user from an aborted run, then signs up fresh,
 *  - cleanup DELETES the just-registered user after all specs, and proves it.
 * Both go through the real UI (profile -> edit profile -> delete account),
 * verified against components/profile/{side-bar,edit-profile,deleteAccount}.vue
 * and drawers/{side,bottom}-drawer.vue.
 */
const { expect } = require("@playwright/test");
const {
	ensureLocation,
	openAuthPanel,
	submitLoginIntent,
	isLoggedIn,
	gotoWithRetry,
	API,
} = require("../utils/app");

/**
 * Delete the currently logged-in user through the real UI.
 * Precondition: page holds an authenticated session.
 */
async function deleteCurrentUserViaUI(page, logPrefix) {
	const tag = logPrefix || "user";
	// ---- open edit profile -> delete account -------------------------------
	// The pencil button renders twice (desktop + mobile layouts) - use the visible one.
	const editBtn = page.locator('[data-test-id="testNgbezEkhT3CN"]:visible').first();
	await expect(editBtn, "edit profile (pencil) button").toBeVisible({ timeout: 60_000 });
	await editBtn.click();

	// edit-profile is an async chunk inside a `modal-fade` transition that exists
	// in BOTH side-drawer.vue and bottom-drawer.vue (class
	// `scheme-edit-profile-panel`, verified in src). The chunk remounts while
	// loading, so open + attach-trace is retried as one unit (max 3 rounds).
	const deleteBtns = page.locator(
		'.scheme-edit-profile-panel [data-test-id="testRzIhfLmqO4xa"]'
	);
	let attached = false;
	for (let round = 1; round <= 3 && !attached; round++) {
		try {
			if (round > 1) {
				console.log(`[${tag}] re-opening edit profile (round ${round})`);
				await editBtn.click({ timeout: 15_000 });
			}
			await page.waitForFunction(
				() =>
					document.querySelectorAll(
						'.scheme-edit-profile-panel [data-test-id="testRzIhfLmqO4xa"]'
					).length > 0,
				{ timeout: 20_000 }
			);
			await page.waitForTimeout(2500); // async chunk + modal-fade settle
			await expect(deleteBtns.first(), "delete account button attached").toBeAttached({
				timeout: 10_000,
			});
			attached = true;
		} catch (err) {
			if (round === 3) throw err;
		}
	}
	let clicked = false;
	for (const btn of await deleteBtns.all()) {
		try {
			if (!(await btn.isVisible().catch(() => false))) continue;
			const box = await btn.boundingBox().catch(() => null);
			if (!box || box.width === 0 || box.height === 0) continue;
			await btn.scrollIntoViewIfNeeded().catch(() => {});
			await btn.click({ timeout: 10_000 });
			clicked = true;
			break;
		} catch {
			/* try the next twin instance */
		}
	}
	if (!clicked) {
		// Last resort: the drawer animation never reports "stable" - force it.
		await deleteBtns.first().click({ force: true, timeout: 15_000 });
	}

	// Confirm dialog (custom-popup inside v-dialog)
	const dialog = page.locator(".v-dialog, .v-overlay__content").last();
	const confirmBtn = dialog
		.locator("button, .v-btn")
		.filter({ hasText: /delete/i })
		.last();
	await expect(confirmBtn, "delete confirmation button").toBeVisible({ timeout: 30_000 });

	const deleteResp = page.waitForResponse(
		(r) => r.url().includes(API.deleteUser) && r.request().method() === "DELETE",
		{ timeout: 60_000 }
	);
	await confirmBtn.click();
	const body = await (await deleteResp).json();
	expect(
		body.success,
		`delete account API failed: ${JSON.stringify(body).slice(0, 300)}`
	).toBeTruthy();
	console.log(`[${tag}] delete API confirmed success`);

	// App logs the user out and sends them back to the welcome page.
	await expect
		.poll(async () => isLoggedIn(page), {
			timeout: 45_000,
			message: "session should be cleared after deletion",
		})
		.toBeFalsy();
}

/**
 * Prove an email no longer exists on the backend (fresh page, clean slate).
 */
async function proveUserGone(page, email, logPrefix) {
	const tag = logPrefix || "user";
	await page.context().clearCookies();
	await gotoWithRetry(page, "/");
	await page.evaluate(() => localStorage.clear());
	await ensureLocation(page);
	await openAuthPanel(page);
	const result = await submitLoginIntent(page, email);
	expect(result.success).toBeTruthy();
	expect(
		result.data.user_exists,
		"deleted user must not exist on the backend anymore"
	).toBeFalsy();
	console.log(`[${tag}] verified: user no longer exists`);
}

module.exports = { deleteCurrentUserViaUI, proveUserGone, submitLoginIntent };
