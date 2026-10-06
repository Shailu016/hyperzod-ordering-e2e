// @ts-check
const { test: teardown, expect } = require("../fixtures/test.fixture");
const {
	waitForAppBoot,
	ensureLocation,
	openAuthPanel,
	submitLoginIntent,
	completeLogin,
	isLoggedIn,
	gotoWithRetry,
	wipeAuthKeepLocation,
	loggedInUserFromStore,
} = require("../utils/app");
const { testUser, readUserMeta } = require("../utils/env");
const { deleteCurrentUserViaUI, proveUserGone } = require("../flows/user.flow");

/**
 * Final stage: deletes every suite-created user candidate through the real UI
 * and proves each is gone, so every run pushes fresh testing data.
 * Candidates = [last setup's meta email, current TEST_USER_EMAIL], deduped:
 * meta can point at a user from a killed run while .env moved on (or vice
 * versa), so both are probed instead of trusting a single source.
 */
teardown("delete the test user account via UI @smoke", async ({ page }) => {
	teardown.setTimeout(300_000);

	const meta = readUserMeta();
	const candidates = [];
	for (const email of [(meta && meta.email) || "", testUser.email || ""]) {
		const e = String(email).trim().toLowerCase();
		if (e && !candidates.includes(e)) candidates.push(e);
	}
	console.log(`[cleanup] candidates: ${candidates.join(", ") || "(none)"}`);

	for (const email of candidates) {
		// Order matters: the wipe touches localStorage, which only exists
		// on the app origin - wiping on about:blank silently does nothing
		// and leaves the old session alive (verified live: cleanup then
		// fails with "no auth entry point" on a logged-in header).
		await gotoWithRetry(page, "/");
		await wipeAuthKeepLocation(page);
		if (await isLoggedIn(page)) {
			throw new Error(
				`wipe failed to clear session for ${email} - aborting instead of acting on ambiguous auth state`
			);
		}
		await ensureLocation(page);
		await openAuthPanel(page);

		let intent = null;
		try {
			intent = await submitLoginIntent(page, email);
		} catch {
			console.log(`[cleanup] intent probe failed for ${email} - skipping`);
			continue;
		}
		if (!intent?.success || !intent?.data?.user_exists) {
			console.log(`[cleanup] ${email} does not exist - nothing to delete`);
			continue;
		}
		try {
			await completeLogin(page, { password: testUser.password, intentBody: intent });
		} catch {
			console.log(`[cleanup] login failed for ${email} - skipping`);
			continue;
		}
		// The user object can hydrate a beat after the token (same lag as
		// setup handles) - poll for it, and skip only on a POSITIVE
		// mismatch. A null object with a valid token still means THIS login
		// succeeded (fresh wipe + fresh intent for this email).
		let me = null;
		await expect
			.poll(async () => (me = await loggedInUserFromStore(page)), {
				timeout: 20_000,
				message: "logged-in user object after cleanup login",
			})
			.toBeTruthy()
			.catch(() => {});
		if (me && String(me.email || "").toLowerCase() !== email) {
			console.log(`[cleanup] session mismatch after login - skipping ${email}`);
			continue;
		}
		await gotoWithRetry(page, "/en/profile");
		await waitForAppBoot(page);
		await deleteCurrentUserViaUI(page, "cleanup");
		await proveUserGone(page, email, "cleanup");
	}
	console.log("[cleanup] done");
});
