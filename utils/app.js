// @ts-check
const { expect } = require("@playwright/test");
const { config } = require("./env");
const { retryAsync } = require("./retry");

/** Escape user input before embedding it in a RegExp. */
function escapeRegExp(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Shared UI flows for the Hyperzod ordering app.
 * Selectors are taken from the hyperzod-ui-ordering source code:
 *  - welcome location box ......... #search (location-master.vue)
 *  - header login button .......... #LoginBtn (multi-vendor-header.vue)
 *  - header account button ........ #ProfileBtn.account-btn
 *  - header cart button ........... [data-test-id="nnHtWB68sfXf5vc"]
 *  - login/signup intent input .... #loginEmailOrNumber + #continueBtn
 *  - signup form .................. #Signup (#firstName #emailInput #telInput #passwordInput)
 *  - signup submit ................ [data-test-id="test-zXJcBCYOrSEG"]
 *  - login password + submit ...... #loginPassword + [data-test-id="test-V6wOPa9xb61D"]
 *  - OTP screen ................... #OTP .v-otp-input input + verify .dbIbDx31CiH2
 */

const API = {
	loginIntent: "/auth/v1/user/login/intent",
	login: "/auth/v1/user/login",
	register: "/auth/v1/user/register",
	otpVerify: "/auth/v1/user/otp/verify",
	deleteUser: "/auth/v1/user/",
	cart: "/store/v1/cart",
	placeOrder: "/store/v1/order",
	address: "/address/",
};

/** Wait until the app shell (vuetify layout) is mounted. */
async function waitForAppBoot(page) {
	await page.waitForLoadState("domcontentloaded");

	// The boot API rate-limits (429) under rapid serial runs. Boot failure
	// (URL redirect OR inline content) retries with exponential backoff +
	// jitter before it counts as a real failure.
	let recoveries = 0;
	try {
		await retryAsync(
			async () => {
				await expectBootOk(page, 20_000);
				if (await bootFailureSeen(page)) {
					throw new Error("Boot Failed content rendered inline");
				}
			},
			{
				attempts: 3,
				baseMs: 2_000,
				capMs: 5_000,
				label: "app boot",
				onRetry: async ({ attempt, waitMs, error }) => {
					recoveries = attempt;
					console.log(
						`[boot] boot failure (attempt ${attempt}): ${String(error && error.message ? error.message : error).slice(0, 120)} - waited ${Math.round(waitMs / 1000)}s, reloading`
					);
					await require('./api-budget').waitForApiBudget();
					await page.reload({ waitUntil: 'domcontentloaded' });
					await page.waitForLoadState("domcontentloaded");
				},
			}
		);
	} catch (err) {
		throw new Error(
			`App boot failed after bounded recovery (inspect HTTP status and transport evidence): ${String(err && err.message ? err.message : err).slice(0, 200)}`
		);
	}
	if (recoveries > 0) console.log(`[boot] recovered after ${recoveries} backoff reload(s)`);
}

async function expectBootOk(page, timeout) {
	await expect
		.poll(
			async () => {
				const url = page.url();
				if (/boot-failed|boot-error/.test(url)) {
					throw new Error(`App boot failed, landed on: ${url}`);
				}
				const roots = await page.locator("#WelcomePage:visible, #MultiVendorHome:visible, #MultiVendorSearch:visible, header:visible, #checkout:visible, #profile:visible, #orders:visible, #addresses:visible, #Languages:visible, #MerchantSearchPage:visible, :text(\"Page Not Found\"):visible, .scheme-merchant-page:visible").count();
				if (roots) return roots;
				if (/\/service-area(?:[/?]|$)/.test(url) && await page.getByRole('region', { name: 'Map', exact: true }).or(page.locator('canvas:visible')).first().isVisible()) return 1;
				return 0;
			},
			{ timeout, message: "app did not boot" }
		)
		.toBeGreaterThan(0);
}

async function bootFailureSeen(page) {
	if (/boot-failed|boot-error/.test(page.url())) return true;
	return await page
		.getByText(/boot failed|failed loading boot config/i)
		.first()
		.isVisible()
		.catch(() => false);
}

/**
 * Poll for the first merchant card on home/discovery.
 * Merchant lists hydrate async (skeletons first) and can take a while on a
 * cold dev backend - poll instead of a fixed expect so slow spells pass.
 */
async function expectFirstMerchantCard(page, timeout = 90_000) {
	const startedAt = Date.now(), deadline = startedAt + timeout;
	const budget = require('./api-budget');
	for (let attempt = 0; attempt < 2; attempt++) {
		let result;
		await expect.poll(async () => {
			result = await page.locator(".merchant-card:visible").count() > 0 ? 'ready' :
				!attempt && budget.homeReadWasThrottledSince(startedAt - 5_000) ? 'throttled' : 'loading';
			return result;
		}, { timeout: Math.max(1, deadline - Date.now()), message: "no merchant cards loaded on home" }).toMatch(/^(ready|throttled)$/);
		if (result === 'ready') break;
		// Only the proven read-only home query is recovered; cart/order actions are not repeated.
		await budget.waitForApiBudget({ maximumWaitMs: Math.max(0, deadline - Date.now()) });
		if (Date.now() >= deadline) throw new Error('Home rate-limit recovery exceeded the merchant-read budget');
		await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(20_000, deadline - Date.now()) });
	}
	return page.locator(".merchant-card:visible").first();
}

/**
 * Navigate with retry. The live store origin occasionally stalls document
 * delivery entirely (tar-pit under load) - a single 60s timeout must not
 * fail a test that passes on immediate retry.
 */
async function gotoWithRetry(page, url, { timeout = 20_000 } = {}) {
	await retryAsync(
		async () => {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout });
		},
		{
			attempts: 2,
			baseMs: 1_000,
			capMs: 3_000,
			shouldRetry: (err) => /Timeout|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK/i.test(String(err.message)),
			label: `goto ${url}`,
			onRetry: ({ attempt, waitMs, error }) =>
				console.log(
					`[nav] goto ${url} failed (attempt ${attempt}: ${String(error && error.message ? error.message : error).slice(0, 100)}) - retried after ${Math.round(waitMs / 1000)}s`
				),
		}
	);
}

/**
 * Verify the app actually rendered something interactive. With a dead
 * session the boot can mount an empty shell (router-view present, zero
 * content: no header, no welcome) that every helper then fails on.
 * @returns {"ok"|"wiped"} "wiped" when recovery cleared storage (location
 *          is gone too - the caller must run the full location flow).
 */
async function ensureInteractiveShell(page) {
	const probe = () =>
		page
			.locator("#WelcomePage:visible, #MultiVendorHome:visible, header:visible, [role='banner']:visible, #LoginBtn:visible, #ProfileBtn:visible")
			.first()
			.isVisible()
			.catch(() => false);
	if (await probe()) return "ok";
	console.log("[boot] blank shell detected - recovering");
	if (await isLoggedIn(page).catch(() => true)) {
		// Valuable session: reload only, never wipe another user's state.
		await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
		await waitForAppBoot(page);
		if (await probe()) return "ok";
		throw new Error("app shell blank after reload with live session (backend not serving UI?)");
	}
	// Nothing to protect: full wipe + reboot lands on welcome.
	await page.context().clearCookies();
	await gotoWithRetry(page, "/");
	await page.evaluate(() => localStorage.clear());
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitForAppBoot(page);
	return "wiped";
}

/** True when a delivery location has already been picked. */
async function hasSelectedLocation(page) {
	return await page.evaluate(() => {
		try {
			if (localStorage.getItem("location")) return true;
			const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
			return !!(vuex.Utils && vuex.Utils.selectedLocation);
		} catch {
			return false;
		}
	});
}

/**
 * Open the app and make sure a serviceable delivery location is selected.
 * Fast path: when the page already runs the booted app with a persisted
 * location (the norm after setup - storageState restores localStorage), skip
 * the "/" navigation entirely. Every avoided boot is one less call against
 * the dev API's rate limiter (429s on /store/v1/boot under rapid runs).
 */
async function ensureLocation(page) {
	const currentUrl = page.url();
	const fresh = !currentUrl || currentUrl.startsWith("about:") || currentUrl.startsWith("chrome");
	if (!fresh) {
		try {
			if (await hasSelectedLocation(page)) {
				// Storage says settled - but verify it rendered. A "wiped"
				// recovery also cleared location, so fall through to set it.
				if ((await ensureInteractiveShell(page)) !== "wiped") return;
			}
		} catch {
			/* fall through to full flow */
		}
	}
	await gotoWithRetry(page, "/");
	await waitForAppBoot(page);
	await ensureInteractiveShell(page);
	require("./diagnostics").requireDependency(page, "geocoding");

	// Already redirected away from welcome: location is settled only if it
	// is persisted AND no forced location drawer is open. CAUTION: the
	// drawer can FLASH during boot while location resolves (verified live:
	// healthy home page behind a 2s drawer) - so a visible drawer alone
	// proves nothing until it persists with no location behind it.
	if (!(await page.locator("#WelcomePage").isVisible().catch(() => false))) {
		const heading = page.getByText(/search for your location/i).first();
		const openNow = await heading.isVisible().catch(() => false);
		const locatedNow = await hasSelectedLocation(page).catch(() => false);
		if (!openNow && locatedNow) return; // settled, common case
		if (openNow && !locatedNow) {
			// Flash or stuck? The app can auto-resolve location (and close
			// the drawer itself) ~20s into boot - give it 30s to settle on
			// its own before touching anything.
			const resolved = await expect
				.poll(
					async () => {
						if (await hasSelectedLocation(page).catch(() => false)) return "settled";
						if (!(await heading.isVisible().catch(() => false))) return "closed";
						return "waiting";
					},
					{ timeout: 30_000 }
				)
				.toMatch(/settled|closed/)
				.then(() => true)
				.catch(() => false);
			if (resolved) {
				console.log("[location] transient drawer resolved on its own - proceeding");
				return;
			}
			// Genuinely stuck: satisfy it the same way as welcome - type the
			// query in the drawer's own search box, pick the first suggestion.
			// Re-verify openness first: it may have closed in the gap.
			if (!(await heading.isVisible().catch(() => false))) {
				console.log("[location] drawer closed during settle check - proceeding");
				return;
			}
			console.log("[location] forced location drawer open - selecting via drawer");
			const drawerSearch = page.getByPlaceholder(/search for area/i).first();
			try {
				await drawerSearch.click({ timeout: 8_000 });
			} catch {
				// Covered/animating: one last state check before failing loudly.
				if (!(await heading.isVisible().catch(() => false))) {
					console.log("[location] drawer gone after click miss - proceeding");
					return;
				}
				throw new Error(
					"location drawer search box present but not clickable (covered by overlay?)"
				);
			}
			await drawerSearch.pressSequentially(config.locationQuery, { delay: 80 });
			const drawerResults = page.locator(
				".search-results .results-list .tw-cursor-pointer"
			);
			await expect(drawerResults.first(), "location suggestions").toBeVisible({
				timeout: 30_000,
			});
			await drawerResults.first().click();
			await page.waitForURL(/\/(home|m)(\/|\?|$)/, { timeout: 60_000 });
			await expect
				.poll(async () => hasSelectedLocation(page), {
					timeout: 30_000,
					message: "location was not persisted",
				})
				.toBeTruthy();
			return;
		}
		// No location and no drawer to satisfy it - leave the page
		// interactive (dismiss any scrim) and let the caller fail loudly
		// if it truly needs a location.
		await page.keyboard.press("Escape").catch(() => {});
		return;
	}

	const searchBox = page.locator("#WelcomePage input#search").first();
	await expect(searchBox, "welcome page location input").toBeVisible({ timeout: 30_000 });
	await searchBox.click();
	// The input uses v-debounce (keyup based) - characters must be typed with
	// real key events, fill() would never trigger the location search.
	await searchBox.pressSequentially(config.locationQuery, { delay: 80 });

	const results = page.locator(".search-results .results-list .tw-cursor-pointer");
	await expect(results.first(), "location suggestions").toBeVisible({ timeout: 30_000 });
	await results.first().click();

	// Serviceable location selected -> app routes to home or merchant page.
	await page.waitForURL(/\/(home|m)(\/|\?|$)/, { timeout: 60_000 });
	await expect
		.poll(async () => hasSelectedLocation(page), {
			timeout: 30_000,
			message: "location was not persisted",
		})
		.toBeTruthy();
}

/** Open the auth side panel via the header Login button. Idempotent: if the
 *  panel is already open (e.g. left open by a probe step), it just returns
 *  instead of clicking #LoginBtn through the open drawer (which never
 *  resolves - the #side-panels subtree intercepts pointer events). */
async function openAuthPanel(page) {
	// Location first: a forced location drawer covers the header and swallows
	// auth clicks. ensureLocation is idempotent (fast-path when settled), so
	// this is nearly free and makes call order irrelevant.
	await ensureLocation(page);
	const input = page.locator("#loginEmailOrNumber");
	const loginBtn = page.locator("#LoginBtn");
	// Mobile tenant layouts have no header login button: auth entry is the
	// bottom-nav Account button (verified live on asdasds-store).
	const accountNav = page.getByRole("button", { name: /account/i }).first();
	// Retry as a unit: the entry point can be absent mid-redirect, and the
	// drawer animates over it as it opens (a click can miss while the panel
	// ends up open, or vice versa). The input check after each round decides.
	for (let round = 1; round <= 3; round++) {
		try {
			// Panel already open (e.g. left open by a probe step) - done.
			if (await input.isVisible().catch(() => false)) return;
			// A leftover drawer (location search, side menu) can cover the
			// header and swallow clicks into its scrim (verified live:
			// "Search for your location" overlaying #LoginBtn). Dismiss
			// first; the 500ms lets the close transition uncover the header.
			await page.keyboard.press("Escape").catch(() => {});
			await page.waitForTimeout(500);
			if (await input.isVisible().catch(() => false)) return;
			if (await loginBtn.isVisible().catch(() => false)) {
				await loginBtn.click({ timeout: 8_000 }).catch(() => {});
			} else if (await accountNav.isVisible().catch(() => false)) {
				// Mobile: Account tab lands on /en/profile; logged out it
				// shows a "Login" row - tap it to open the auth sheet.
				await accountNav.tap().catch(async () => {
					await accountNav.click({ timeout: 8_000 }).catch(() => {});
				});
				await page.waitForTimeout(1500);
				const loginRow = page.getByText("Login", { exact: true }).first();
				if (await loginRow.isVisible().catch(() => false)) {
					await loginRow.click({ timeout: 8_000 }).catch(() => {});
				}
			} else {
				throw new Error("no auth entry point visible (header login nor bottom-nav account)");
			}
			if (await input.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)) {
				return;
			}
			console.log(`[auth] auth panel did not open (round ${round}) - retrying`);
		} catch (err) {
			if (round === 3) throw err;
			await page.waitForTimeout(3000);
		}
	}
	await expect(input, "auth panel login input").toBeVisible({ timeout: 15_000 });
}

/**
 * Submit the email on the first auth step.
 * @returns {Promise<any>} parsed /login/intent response body
 */
async function submitLoginIntent(page, emailOrPhone) {
	const input = page.locator("#loginEmailOrNumber");
	await input.fill(emailOrPhone);
	const respPromise = page.waitForResponse(
		(r) => r.url().includes(API.loginIntent) && r.request().method() === "POST",
		{ timeout: 45_000 }
	);
	await page.locator("#continueBtn").click();
	const resp = await respPromise;
	return await resp.json();
}

/** Pick a dial-code country inside any visible country-code dropdown. */
async function selectCountry(page, countryName) {
	const toggle = page.locator(".country-select-toggle").first();
	if (!(await toggle.isVisible().catch(() => false))) return;
	await toggle.click();
	const search = page.locator(".country-select-option-search input").first();
	await expect(search).toBeVisible({ timeout: 10_000 });
	await search.fill(countryName);
	const option = page
		.locator(".country-select-dropdown li")
		.filter({ hasText: new RegExp(escapeRegExp(countryName), "i") })
		.first();
	await expect(option).toBeVisible({ timeout: 10_000 });
	await option.click();
}

/** Extract otp code echoed by dev APIs (data.otp.code). */
function otpFromResponse(body) {
	try {
		return body && body.data && body.data.otp && body.data.otp.code
			? String(body.data.otp.code)
			: null;
	} catch {
		return null;
	}
}

/** Fill the 4 digit OTP screen and verify. */
async function completeOtp(page, otpCode) {
	const otpRoot = page.locator("#OTP");
	await expect(otpRoot, "OTP screen").toBeVisible({ timeout: 20_000 });
	const code = String(otpCode || config.fallbackOtp);

	const otpInput = otpRoot.locator(".v-otp-input input").first();
	await otpInput.click();
	await page.keyboard.type(code, { delay: 120 });

	const verifyBtn = otpRoot.locator(".dbIbDx31CiH2");
	const respPromise = page.waitForResponse(
		(r) => r.url().includes(API.otpVerify) && r.request().method() === "POST",
		{ timeout: 45_000 }
	);
	if (await verifyBtn.isEnabled().catch(() => false)) {
		await verifyBtn.click();
	}
	const resp = await respPromise;
	const body = await resp.json();
	if (!body.success) {
		throw new Error(`OTP verification failed: ${JSON.stringify(body).slice(0, 300)}`);
	}
	return body;
}

/** Assert the app stored an authenticated session. */
async function expectLoggedIn(page) {
	await expect
		.poll(
			async () => {
				return await page.evaluate(() => {
					try {
						const token = localStorage.getItem("access_token");
						if (token && token !== "null" && token !== "undefined") return true;
						const vuex = JSON.parse(localStorage.getItem("vuex") || "{}");
						return !!(vuex.User && vuex.User.isLoggedIn);
					} catch {
						return false;
					}
				});
			},
			{ timeout: 45_000, message: "access_token was not stored - login/signup failed" }
		)
		.toBeTruthy();
	await expectAuthedUI(page);
}

/**
 * Assert the visible UI reflects a logged-in session on ANY layout.
 * Desktop shows a hidden #LoginBtn; mobile tenant layouts have no header
 * login button at all, so a bottom-nav Account entry counts instead.
 * Polls because the header swaps a beat after the token lands.
 */
async function expectAuthedUI(page) {
	await expectLoggedInUser(page, require("./env").testUser.email);
	await expect.poll(async () => {
		const profile = await page.locator("#ProfileBtn:visible, #ProfileSideBar:visible").count();
		const account = await page.getByRole("button", { name: /account/i }).first().isVisible();
		return profile > 0 || account;
	}, { timeout: 15_000, message: "authenticated identity and account controls" }).toBeTruthy();
}

/** Assert the logged-in user object, which can hydrate a beat after the
 *  token lands (verified live: token present, object null). Polls instead of
 *  asserting the vuex snapshot instantly. @returns the user object. */
async function expectLoggedInUser(page, email, timeout = 30_000) {
	let user = null;
	await expect
		.poll(async () => (user = await loggedInUserFromStore(page)), {
			timeout,
			message: "logged-in user object in the vuex store",
		})
		.toBeTruthy();
	if (email) {
		expect(String(user.email || "").toLowerCase(), "logged-in user email").toBe(
			String(email).toLowerCase()
		);
	}
	return user;
}

/** True when the app currently has an authenticated session. */
async function isLoggedIn(page) {
	try {
		const state = await require("./store").readStore(page);
		return state.authenticated === true && !!state.user;
	} catch { return false; }
}

/** Wipe auth state but KEEP location. The location drawer is forced
 *  open only when the app considers location unset - a full storage wipe
 *  summons it and it covers the header. Clearing just the session (token +
 *  User subtree) keeps location settled so auth entry points stay clickable.
 *  After this, isLoggedIn(page) is guaranteed false. */
async function wipeAuthKeepLocation(page) {
	await page.context().clearCookies();
	await page.evaluate(() => {
		try {
			localStorage.removeItem('access_token');
			localStorage.removeItem('token_expires_in');
			const raw = localStorage.getItem('vuex');
			if (raw) {
				const vuex = JSON.parse(raw);
				if (vuex.User) {
					vuex.User.isLoggedIn = false;
					vuex.User.loggedInUser = null;
				}
				localStorage.setItem('vuex', JSON.stringify(vuex));
			}
		} catch {
			/* best effort - callers re-verify */
		}
	});
	// Rebuild Vuex from the cleared storage: the mounted app still holds its old session.
	await page.reload({ waitUntil: "domcontentloaded" });
	await waitForAppBoot(page);
}

/** Re-login when the stored session expired mid-run (verified live: the app
 *  boots with checkSessionExpiration and logs out once token_expires_in
 *  passes - long runs outlive it). No-op when already logged in, so it is
 *  safe in every beforeEach. Returns true when it had to renew. */
async function ensureLoggedIn(page, user, { minimumValidityMs = 60_000 } = {}) {
	const u = user || require("./env").testUser;
	const expectedId = require("./manifest").readManifest().userId;
	const { readStore } = require('./store');
	const { hasSessionBudget } = require('./session-recovery');
	const initial = await readStore(page);
	if (!initial.user && initial.hasToken && hasSessionBudget(initial.tokenExpiresAt, minimumValidityMs)) {
		try {
			await require('./observe').observeUntil('stored session identity hydration', () => readStore(page),
				(state) => (state.authenticated === true && state.user) || !state.hasToken || !hasSessionBudget(state.tokenExpiresAt, minimumValidityMs),
				{ timeout: 5_000, interval: 200 });
		} catch (error) {
			if (!String(error.message).startsWith('stored session identity hydration: did not settle')) throw error;
			// No trustworthy live identity: authenticate through UI, never force a browser auth flag.
		}
	}
	if (await isLoggedIn(page)) {
		const me = await loggedInUserFromStore(page);
		require("./policy").assertIdentity(me, u.email, expectedId);
		if (require("./session-recovery").hasSessionBudget((await require("./store").readStore(page)).tokenExpiresAt, minimumValidityMs)) return false;
		await wipeAuthKeepLocation(page);
	}
	console.log("[auth] session unavailable or near expiry - authenticating the dedicated test identity");
	// Stable ground first: the current page may be mid-redirect after the
	// logout bounce (header without login button). A fresh boot also settles
	// any half-loaded state before the auth panel opens.
	await gotoWithRetry(page, "/");
	await waitForAppBoot(page);
	await ensureLocation(page);
	await openAuthPanel(page);
	const intent = await submitLoginIntent(page, u.email);
	if (require("./policy").intentState(intent) !== "present") throw new Error("Expected test account disappeared during session recovery");
	await completeLogin(page, { password: u.password, intentBody: intent });
	const restored = await expectLoggedInUser(page, u.email);
	require("./policy").assertIdentity(restored, u.email, expectedId);
	if (!require("./session-recovery").hasSessionBudget((await require("./store").readStore(page)).tokenExpiresAt, minimumValidityMs)) throw new Error("Fresh token lifetime is insufficient for the requested observation/submission budget");
	require("./diagnostics").markSessionRecovered(page);
	const env = require("./env");
	const fs = require("node:fs");
	const previous = JSON.parse(fs.readFileSync(env.STORAGE_STATE, "utf8"));
	const fresh = require('./auth-state').authenticatedState(await page.context().storageState(), await require('./store').readUserState(page), new URL(config.baseURL).origin);
	fs.writeFileSync(env.STORAGE_STATE, JSON.stringify(require("./auth-state").refreshAuthState(previous, fresh, new URL(config.baseURL).origin)));
	env.fanOutStorageStates();
	return true;
}

/**
 * Navigate to an auth-protected route with renewal.
 * A plain goto+boot can land logged-out (expired token is cleared AT boot),
 * bouncing to home. If renewal happened, the logout already bounced us away,
 * so navigate once more on the fresh session.
 */
async function gotoAuthed(page, url) {
	await gotoWithRetry(page, url);
	await waitForAppBoot(page);
	if (await ensureLoggedIn(page)) {
		console.log(`[auth] renewed on ${url} - re-navigating`);
		await gotoWithRetry(page, url);
		await waitForAppBoot(page);
	}
}

/** Read the logged-in user object from the persisted vuex store. */
async function loggedInUserFromStore(page) {
	try { return (await require("./store").readStore(page)).user || null; }
	catch { return null; }
}

/**
 * Full signup flow for a brand-new user.
 * Assumes the /login/intent step already reported user_exists=false and the
 * signup tab is open.
 */
async function completeSignupForm(page, user) {
	const form = page.locator("#Signup");
	await expect(form, "signup form").toBeVisible({ timeout: 20_000 });

	await form.locator("#firstName").fill(user.firstName);

	const emailInput = form.locator("#emailInput");
	if ((await emailInput.inputValue().catch(() => "")) === "") {
		await emailInput.fill(user.email);
	}

	// Phone (only asked when intent was via email)
	const telInput = form.locator("#telInput");
	if (await telInput.isVisible().catch(() => false)) {
		await selectCountry(page, user.country);
		await telInput.fill(user.phone);
	}

	const passwordInput = form.locator("#passwordInput");
	if (await passwordInput.isVisible().catch(() => false)) {
		await passwordInput.fill(user.password);
	}

	// Consent checkbox (only when tenant enables it)
	const consent = form.locator(".register_consent input[type=checkbox]");
	if (await consent.isVisible().catch(() => false)) {
		await consent.check();
	}

	const respPromise = page.waitForResponse(
		(r) => r.url().includes(API.register) && r.request().method() === "POST",
		{ timeout: 60_000 }
	);
	respPromise.catch(() => {});
	const signup = form.locator('[data-test-id="test-zXJcBCYOrSEG"]');
	await expect(signup, 'signup fields must pass client validation before submission').toBeEnabled();
	await signup.click();
	const resp = await respPromise;
	const body = await resp.json();

	if (!body.success) {
		throw new Error(`Signup API failed: ${JSON.stringify(body).slice(0, 400)}`);
	}

	// OTP step (dev backend echoes the code in the response).
	// NOTE (verified live 2026-09-16): the tenant may auto-login on register
	// (access_token stored, app routes home) even when otp_mode_enabled=true,
	// so #OTP never renders. Only do OTP when we are NOT already logged in.
	const alreadyLoggedIn = await expect
		.poll(async () => isLoggedIn(page), { timeout: 15_000 })
		.toBeTruthy()
		.then(() => true)
		.catch(() => false);
	if (alreadyLoggedIn) return body;

	if (body.data && body.data.otp_mode_enabled) {
		const otpShown = await page
			.locator("#OTP")
			.waitFor({ state: "visible", timeout: 15_000 })
			.then(() => true)
			.catch(() => false);
		if (otpShown) {
			await completeOtp(page, otpFromResponse(body));
		} else if (!(await isLoggedIn(page))) {
			throw new Error(
				"Signup API succeeded but neither a session nor an OTP screen appeared"
			);
		}
	}

	await expectLoggedIn(page);
	return body;
}

/**
 * Login step after /login/intent for an existing user.
 * Supports both auth modes of the tenant:
 *  - password mode: #loginPassword + login API
 *  - OTP mode: #loginOTP (single field, dev backend echoes the code in the
 *    intent response) + otp/verify API
 */
async function completeLogin(page, { password, intentBody } = {}) {
	const passwordInput = page.locator("#loginPassword");
	const otpInput = page.locator("#loginOTP");
	await expect(passwordInput.or(otpInput).first(), "login password/OTP input").toBeVisible({
		timeout: 20_000,
	});

	if (await passwordInput.isVisible().catch(() => false)) {
		await passwordInput.fill(password);
		// The submit can sit under a transient overlay (loading spinner,
		// throttled backend) - retry click + response as a unit. Login POSTs
		// are idempotent, so a double-fire is harmless.
		const submitBtn = page.locator('[data-test-id="test-V6wOPa9xb61D"]');
		let body = null;
		for (let round = 1; round <= 3 && !body; round++) {
			const respPromise = page
				.waitForResponse(
					(r) => r.url().includes(API.login) && r.request().method() === "POST",
					{ timeout: 45_000 }
				)
				.catch(() => null);
			await submitBtn.click({ timeout: 15_000 }).catch(() => {
				console.log(`[auth] login submit click missed (round ${round}) - retrying`);
			});
			const resp = await respPromise;
			if (resp) body = await resp.json().catch(() => null);
		}
		if (!body) {
			throw new Error("Login API never responded after 3 submit attempts (backend throttled?)");
		}
		if (!body.success) {
			throw new Error(`Login API failed: ${JSON.stringify(body).slice(0, 400)}`);
		}
		if (body.data && body.data.redirect_to === "verify_otp" && !body.data.access_token) {
			await completeOtp(page, otpFromResponse(body));
		}
	} else {
		// OTP mode - the field is pre-filled when the backend echoes the code.
		const prefilled = await otpInput.inputValue().catch(() => "");
		if (!prefilled) {
			const code = otpFromResponse(intentBody) || config.fallbackOtp;
			await otpInput.fill(String(code));
		}
		const respPromise = page.waitForResponse(
			(r) => r.url().includes(API.otpVerify) && r.request().method() === "POST",
			{ timeout: 60_000 }
		);
		await page.locator('[data-test-id="test-V6wOPa9xb61D"]').click();
		const body = await (await respPromise).json();
		if (!body.success) {
			throw new Error(`OTP login failed: ${JSON.stringify(body).slice(0, 400)}`);
		}
	}

	await expectLoggedIn(page);
}

module.exports = {
	API,
	waitForAppBoot,
	expectFirstMerchantCard,
	ensureLocation,
	hasSelectedLocation,
	openAuthPanel,
	submitLoginIntent,
	selectCountry,
	completeSignupForm,
	completeLogin,
	completeOtp,
	expectLoggedIn,
	expectAuthedUI,
	isLoggedIn,
	wipeAuthKeepLocation,
	expectLoggedInUser,
	ensureInteractiveShell,
	ensureLoggedIn,
	gotoAuthed,
	gotoWithRetry,
	loggedInUserFromStore,
	otpFromResponse,
	escapeRegExp,
};
