// @ts-check
const { test: setup, expect } = require("../fixtures/test.fixture");
const {
	ensureLocation,
	openAuthPanel,
	submitLoginIntent,
	completeLogin,
	completeSignupForm,
	expectLoggedInUser,
	expectLoggedIn,
	waitForAppBoot,
	gotoWithRetry,
} = require("../utils/app");
const { testUser, config, STORAGE_STATE, ensureAuthDir, saveUserMeta, validateEnv, fanOutStorageStates } = require("../utils/env");
const { deleteCurrentUserViaUI, proveUserGone } = require("../flows/user.flow");

/**
 * First stage of the suite - guarantees fresh testing data for every run:
 *  1. If a previous (aborted) run left the test user behind, log in and
 *     DELETE it through the real UI, then prove it is gone.
 *  2. Register a brand-new user through the real signup UI
 *     (email intent -> signup form -> OTP) and persist the session for the
 *     rest of the suite.
 */
setup("signup: purge leftovers, create user via UI and persist session @smoke", async ({ page, context }) => {
	setup.setTimeout(300_000);

	const missing = validateEnv();
	expect(missing, `Missing required .env vars: ${missing.join(", ")}`).toEqual([]);

	// The target URL is given by you (BASE_URL). Fail fast with a plain
	// message when it is unreachable instead of timing out inside the browser.
	try {
		const res = await fetch(config.baseURL, { method: "HEAD" });
		console.log(`[setup] target reachable: ${config.baseURL} (HTTP ${res.status})`);
	} catch (err) {
		throw new Error(
			`Target URL unreachable: ${config.baseURL}. Check BASE_URL in .env (https://automations-store.hyperzod.me/). Cause: ${String(err.message).slice(0, 200)}`
		);
	}

	// ---- 1. purge leftovers -----------------------------------------------
	// The auth panel opens ONCE and stays open across the probe: re-clicking
	// #LoginBtn while the panel covers the header never resolves.
	await ensureLocation(page);
	await openAuthPanel(page);
	const probe = await submitLoginIntent(page, testUser.email);
	if (!probe.success) {
		const msg = JSON.stringify(probe).slice(0, 300);
		if (/blocked/i.test(msg)) {
			throw new Error(
				`login/intent refused: the test user is BLOCKED on this tenant (${config.baseURL}). ` +
					`Re-run with fresh credentials, e.g. TEST_USER_EMAIL=...e2e...@gmail.com and a fresh TEST_USER_PHONE. Response: ${msg}`
			);
		}
		throw new Error(`login/intent failed: ${msg}`);
	}
	if (probe.data && probe.data.user_exists) {
		console.log("[setup] leftover user from a previous run - purging for fresh data");
		await completeLogin(page, { password: testUser.password, intentBody: probe });
		await gotoWithRetry(page, "/en/profile");
		await waitForAppBoot(page);
		await deleteCurrentUserViaUI(page, "setup-purge");
		await proveUserGone(page, testUser.email, "setup-purge");

		// Fresh slate: the purge logged out and cleared storage. Reload so
		// the auth panel starts from its initial email step - proveUserGone
		// leaves it mid-flow (password/OTP step), which openAuthPanel cannot
		// reuse and would fail to re-open.
		await gotoWithRetry(page, "/");
		await waitForAppBoot(page);
		await ensureLocation(page);
		await openAuthPanel(page);
	}
	const intent = (probe.data && probe.data.user_exists)
		? await submitLoginIntent(page, testUser.email)
		: probe;
	if (!intent.success) {
		throw new Error(`login/intent failed: ${JSON.stringify(intent).slice(0, 300)}`);
	}
	let mode = "signup";
	if (intent.data && intent.data.user_exists) {
		// Lost a race with a concurrent run - fall back to login so the suite
		// stays self-healing instead of failing the whole pipeline.
		await completeLogin(page, { password: testUser.password, intentBody: intent });
		mode = "login";
	} else {
		await completeSignupForm(page, testUser);
	}
	console.log(`[setup] auth completed via: ${mode}`);

	await expectLoggedIn(page);

	// User object hydrates a beat after the token - poll via helper.
	const user = await expectLoggedInUser(page, testUser.email);

	ensureAuthDir();
	await context.storageState({ path: STORAGE_STATE });
	fanOutStorageStates();
	saveUserMeta({
		id: user.id,
		email: user.email,
		mode,
		createdAt: new Date().toISOString(),
	});
	console.log(`[setup] stored session for user id=${user.id} (${user.email})`);
});
