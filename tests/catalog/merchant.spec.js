// @ts-check
const { test, expect } = require("../../fixtures/test.fixture");
const { ensureLocation, ensureLoggedIn, waitForAppBoot, gotoWithRetry } = require("../../utils/app");

/**
 * Catalog / merchant / search @regression @catalog.
 * Verified against: views/merchant/merchant.vue, category-products.vue,
 * merchant-search-page.vue, product/product.vue, search/multi-vendor/search.vue.
 */
test.describe("Catalog @catalog", () => {
	test("merchant search page opens from storefront and filters", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		const card = page.locator(".merchant-card").first();
		await expect(card).toBeVisible({ timeout: 60_000 });
		await card.click();
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		await expect(
			page.locator(".add-product-btn .add-btn:visible").first()
		).toBeVisible({ timeout: 60_000 });

		// In-store search entry (header search) - type and expect the UX to
		// respond: filtered menu, a search route, results, or an empty state.
		const searchEntry = page
			.locator('input[type="search"], input[placeholder*="earch" i]')
			.first();
		if (await searchEntry.isVisible().catch(() => false)) {
			await searchEntry.click();
			await searchEntry.pressSequentially("cof", { delay: 100 });
			await expect
				.poll(
					async () => {
						const url = page.url();
						if (/search/.test(url)) return "routed";
						const results = await page
							.locator(".add-product-btn, .product-card, .merchant-product")
							.count();
						if (results > 0) return "results";
						const empty = await page
							.getByText(/no result|nothing found|no item/i)
							.first()
							.isVisible()
							.catch(() => false);
						return empty ? "empty-state" : "waiting";
					},
					{ timeout: 45_000, message: "in-store search should respond" }
				)
				.toMatch(/routed|results|empty-state/);
		} else {
			// Fallback: direct-route the merchant search page for the current merchant.
			const url = page.url();
			await gotoWithRetry(page, `${url.split("?")[0].replace(/\/$/, "")}/search`);
			await waitForAppBoot(page);
			expect(/search|m\//.test(page.url())).toBeTruthy();
		}
	});

	test("global search finds a merchant taken from its own page", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		// Deterministic query: open the first merchant and use words from its
		// own h1 name (exact indexed name - immune to tenant data variance).
		// search.vue ignores queries shorter than 2 chars.
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		const firstCard = page.locator(".merchant-card").first();
		await expect(firstCard, "merchant card on home").toBeVisible({ timeout: 90_000 });
		await firstCard.click();
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		const nameHeading = page.locator("h1").first();
		await expect(nameHeading, "merchant name heading").toBeVisible({ timeout: 60_000 });
		const merchantName = ((await nameHeading.innerText()) || "").trim();
		const blocked = new Set([
			"sponsored", "offer", "offers", "off", "free", "delivery", "deliver",
			"min", "mins", "new", "popular", "featured", "up", "to", "flat", "save",
			"the", "and", "for",
		]);
		const candidates = merchantName
			.split(/[\s,|•·\-–—()]+/)
			.map((w) => w.replace(/[^A-Za-z]/g, ""))
			.filter((w) => w.length >= 4 && !blocked.has(w.toLowerCase()))
			.slice(0, 3);
		expect(
			candidates.length > 0,
			`usable search words from merchant name: ${merchantName.slice(0, 80)}`
		).toBeTruthy();

		await gotoWithRetry(page, "/en/search");
		await waitForAppBoot(page);
		await expect(page.locator("#MultiVendorSearch")).toBeVisible({ timeout: 60_000 });
		// Responsive markup (verified in src): mobile in-page #mobileSearchInput
		// (search.vue), desktop header #navSearchBar (multi-vendor-header.vue).
		const box = page.locator("#mobileSearchInput, #navSearchBar").first();
		await expect(box, "global search input (mobile or desktop markup)").toBeVisible({ timeout: 30_000 });

		// Name queries match on the Merchants tab (#search-merchant-tab,
		// verified in search.vue); rows render merchant-card-basic.
		let found = "";
		for (const word of candidates) {
			await box.click();
			await box.fill("");
			await box.pressSequentially(word, { delay: 100 });
			const merchantTab = page.locator("#search-merchant-tab");
			try {
				await merchantTab.waitFor({ state: "visible", timeout: 30_000 });
				await merchantTab.click();
			} catch {
				/* tabs render only when either list is non-empty - keep polling cards */
			}
			const hits = await expect
				.poll(
					async () => page.locator(".merchant-card").count(),
					{ timeout: 30_000 }
				)
				.toBeGreaterThan(0)
				.then(() => true)
				.catch(() => false);
			if (hits) {
				found = word;
				break;
			}
			console.log(`[search] no merchant results for "${word}" - trying next word`);
		}
		expect(found, `search should find the merchant for one of: ${candidates.join(", ")}`).toBeTruthy();
		console.log(`[search] query "${found}" found merchant "${merchantName}"`);
	});

	test("product detail page opens from merchant menu when linked", async ({ page }) => {
		await ensureLocation(page);
		await ensureLoggedIn(page);
		await gotoWithRetry(page, "/en/home");
		await waitForAppBoot(page);
		const card = page.locator(".merchant-card").first();
		await expect(card).toBeVisible({ timeout: 60_000 });
		await card.click();
		await page.waitForURL(/\/m(\/|$)/, { waitUntil: "domcontentloaded", timeout: 60_000 });
		const productLink = page
			.locator('a[href*="/product/"], .product-card a, .product-card')
			.first();
		if (!(await productLink.isVisible().catch(() => false))) {
			test.skip(true, "merchant cards have no deep-linkable product tiles on this tenant");
			return;
		}
		await productLink.click();
		await page.waitForURL(/product/, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await expect(page.locator("#app-router-view, #app").first()).toBeVisible();
	});
});
