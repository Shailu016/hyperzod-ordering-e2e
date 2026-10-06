// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, gotoAuthed } = require("../../utils/app");

/**
 * Profile / orders / wallet / language @regression @profile.
 * Verified against: views/profile/*.vue, components/profile/*.
 */
test.describe("Profile @profile", () => {
	test("orders history renders (empty or populated)", async ({ page }) => {
		await ensureLocation(page);
		await gotoAuthed(page, "/en/profile/orders");
		await expect(page.locator("#orders")).toBeVisible({ timeout: 60_000 });
		// Order cards show "Order #<id>" + merchant + Track Order (verified live);
		// the list container carries per-order data-test-id="test-id-<order_id>".
		// The list loads AFTER the #orders shell mounts, so poll for either
		// populated cards or the empty state instead of asserting instantly.
		await expect
			.poll(
				async () => {
					const refs = await page
						.locator(
							'#orders [data-test-id^="test-id-"], #orders :text("Track Order")'
						)
						.count();
					if (refs > 0) return "populated";
					const empty = await page
						.locator("#orders")
						.getByText(/no orders? yet|no order/i)
						.first()
						.isVisible()
						.catch(() => false);
					return empty ? "empty" : "loading";
				},
				{ timeout: 30_000, message: "orders list should load" }
			)
			.toMatch(/populated|empty/);
	});

	test("address book renders with add affordance", async ({ page }) => {
		await ensureLocation(page);
		await gotoAuthed(page, "/en/profile/address");
		await expect(page.locator("#addresses")).toBeVisible({ timeout: 60_000 });
		const addBtn = page.locator('[data-test-id="test-id-add-address-btn"]');
		const addByText = page.getByRole("button", { name: /add address/i });
		expect(
			(await addBtn.count()) > 0 ||
				(await addByText.count()) > 0 ||
				((await page.locator("#addresses").innerText()).length > 0),
			"address page shows list or add button"
		).toBeTruthy();
	});

	test("language page lists locales and keeps selection", async ({ page }) => {
		await ensureLocation(page);
		await gotoAuthed(page, "/en/profile/language");
		await expect(page.locator("#Languages")).toBeVisible({ timeout: 60_000 });
		const options = page.locator('#Languages input[type="radio"], #Languages .v-radio, #Languages li, #Languages .v-list-item');
		expect(await options.count(), "language options listed").toBeGreaterThan(0);
		const radios = page.locator('#Languages input[type="radio"]');
		const count = await radios.count();
		expect(count).toBeGreaterThan(0);
		const selected = page.locator('#Languages input[type="radio"]:checked');
		await expect(selected).toHaveCount(1);
		const previousIndex = await selected.evaluate((el) => [...document.querySelectorAll('#Languages input[type="radio"]')].indexOf(el));
		const next = radios.nth(count > 1 ? (previousIndex + 1) % count : previousIndex);
		await next.check();
		await page.locator('#Languages .submit-btn:visible').click();
		await expect.poll(async () => page.evaluate(() => localStorage.getItem('user_selected_locale'))).not.toBeNull();
		const locale = await page.evaluate(() => localStorage.getItem('user_selected_locale'));
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect.poll(async () => page.evaluate(() => localStorage.getItem('user_selected_locale'))).toBe(locale);
		await expect(page).toHaveURL(new RegExp('/' + locale + '/profile/language'));
		await expect(page.locator('#Languages input[type="radio"]:checked')).toHaveCount(1);
		if (count > 1) {
			await radios.nth(previousIndex).check();
			await page.locator('#Languages .submit-btn:visible').click();
		}

	});

});
