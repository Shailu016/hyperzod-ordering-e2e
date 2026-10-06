// @ts-check
const { test, expect } = require("../fixtures/test.fixture");
const {
	ensureLocation,
	openAuthPanel,
	submitLoginIntent,
	completeLogin,
	expectLoggedIn,
	isLoggedIn,
	expectLoggedInUser,
	API,
	gotoWithRetry,
} = require("../utils/app");
const { testUser } = require("../utils/env");

// This spec validates the login journey from a clean browser - no reuse of
// the signup session.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Authentication - login/logout of the signed-up user @smoke @auth", () => {
	test("logs in (password or OTP mode) and logs out again", async ({ page }) => {
		test.setTimeout(300_000);

		await ensureLocation(page);

		// -- Login ---------------------------------------------------------
		await openAuthPanel(page);
		const intent = await submitLoginIntent(page, testUser.email);
		expect(intent.success, "login intent should succeed").toBeTruthy();
		expect(
			intent.data.user_exists,
			"user created during setup should exist"
		).toBeTruthy();

		await completeLogin(page, { password: testUser.password, intentBody: intent });
		await expectLoggedIn(page);

		// User object hydrates a beat after the token - poll via helper.
		await expectLoggedInUser(page, testUser.email);

		// -- Logout --------------------------------------------------------
		await gotoWithRetry(page, "/en/profile");
		const logoutItem = page.locator('[data-test-id="test0id836jsdhGS"]').first();
		await expect(logoutItem, "logout menu entry").toBeVisible({ timeout: 30_000 });
		await logoutItem.click();

		// Some deployments show a confirmation popup before logging out.
		const confirm = page
			.locator(".v-dialog, .v-overlay__content")
			.locator("button, .v-btn")
			.filter({ hasText: /yes|logout|confirm/i })
			.first();
		if (await confirm.isVisible().catch(() => false)) {
			await confirm.click();
		}

		await expect
			.poll(async () => isLoggedIn(page), {
				timeout: 45_000,
				message: "session should be cleared after logout",
			})
			.toBeFalsy();
	});

	test("rejects invalid credentials", async ({ page }) => {
		test.setTimeout(240_000);

		await ensureLocation(page);
		await openAuthPanel(page);
		const intent = await submitLoginIntent(page, testUser.email);
		expect(intent.data.user_exists).toBeTruthy();

		const passwordInput = page.locator("#loginPassword");
		const otpInput = page.locator("#loginOTP");
		await expect(passwordInput.or(otpInput).first()).toBeVisible({ timeout: 20_000 });

		if (await passwordInput.isVisible().catch(() => false)) {
			// Password mode -> wrong password must fail
			await passwordInput.fill("definitely-wrong-password-123");
			const respPromise = page.waitForResponse(
				(r) => r.url().includes(API.login) && r.request().method() === "POST"
			);
			await page.locator('[data-test-id="test-V6wOPa9xb61D"]').click();
			const body = await (await respPromise).json();
			expect(body.success, "login with a wrong password must fail").toBeFalsy();
		} else {
			// OTP mode -> wrong code must fail
			await otpInput.fill("0000");
			const respPromise = page.waitForResponse(
				(r) => r.url().includes(API.otpVerify) && r.request().method() === "POST"
			);
			await page.locator('[data-test-id="test-V6wOPa9xb61D"]').click();
			const body = await (await respPromise).json();
			expect(body.success, "login with a wrong OTP must fail").toBeFalsy();
		}

		expect(await isLoggedIn(page), "user must stay logged out").toBeFalsy();
	});
});

test('logged-out browser cannot read a protected order history @smoke @auth', async ({ page }) => {
	await ensureLocation(page);
	expect(await isLoggedIn(page)).toBe(false);
	await gotoWithRetry(page, '/en/profile/orders');
	await expect(page).not.toHaveURL(/profile\/orders/);
	await expect(page.locator('#orders:visible')).toHaveCount(0);
});
