// @ts-check
require("dotenv").config();
const { defineConfig, devices } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const RUN_DIR = process.env.E2E_RUN_DIR || "./test-results/standalone";
// Single source of truth for per-project storage states (see utils/env.js).
// playwright.config.js must not duplicate AUTH_DIR layout.
const { AUTH_DIR, PROJECTS, storageStateFor: stateFor, ensureAuthDir, validateBaseURL } = require("./utils/env");

// Single test target for the whole suite (see .env.example).
// All testing happens against the store deployment below -
// no dev server is ever started for it.
//
// Empty BASE_URL fails LOUDLY here (before any browser launches) instead of
// dying later as "Cannot navigate to invalid URL". Local runs set it via
// .env (gitignored); CI sets it via the E2E_BASE_URL secret.
const BASE_URL = (process.env.BASE_URL || "").trim().replace(/\/$/, "");
if (!BASE_URL) {
	throw new Error(
		"BASE_URL is empty: set it in .env (local) or the E2E_BASE_URL secret (CI) to the store URL, e.g. https://automations-store.hyperzod.me/"
	);
}
validateBaseURL(BASE_URL);
const ORDERING_UI_DIR =
	process.env.ORDERING_UI_DIR || "C:\\Hyperzod_repo\\hyperzod-ui-ordering";
const IS_LOCAL_TARGET = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname);
const AUTO_START_SERVER =
	IS_LOCAL_TARGET && (process.env.AUTO_START_SERVER || "true").toLowerCase() !== "false";
console.log(`[e2e] target: ${BASE_URL} (${IS_LOCAL_TARGET ? "local dev server" : "remote store"})`);

ensureAuthDir();
// Pre-seed every per-project state so a cold start never crashes before setup.
for (const name of ["user.json", ...PROJECTS.map((p) => `user-${p}.json`)]) {
	const p = `${AUTH_DIR}/${name}`;
	if (!fs.existsSync(p)) {
		fs.writeFileSync(p, JSON.stringify({ cookies: [], origins: [] }));
	}
}
module.exports = defineConfig({
	testDir: "./tests",
	outputDir: path.join(RUN_DIR, "artifacts"),
	forbidOnly: !!process.env.CI,
	failOnFlakyTests: !!process.env.CI,
	fullyParallel: false,
	// Serial within a project: specs share one user account + one cart.
	workers: 1,
	retries: 0, // Real account/cart/order mutations must never be blindly replayed.
	timeout: 180 * 1000,
	expect: { timeout: 20 * 1000 },
	reporter: [
		["list"],
		["html", { open: "never", outputFolder: path.join(RUN_DIR, "html") }],
		["json", { outputFile: path.join(RUN_DIR, "report.json") }],
		["junit", { outputFile: path.join(RUN_DIR, "junit.xml") }],
	],

	use: {
		baseURL: BASE_URL,
		actionTimeout: 20 * 1000,
		navigationTimeout: 60 * 1000,
		trace: process.env.E2E_RETAIN_SENSITIVE_TRACES === "true" ? "retain-on-failure" : "off",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
		locale: "en-US",
		permissions: [],
	},

	projects: [
		// 1) Creates the user via the signup flow and stores the logged-in state,
		//    then fans it out to web/android/ios states (see utils/env.fanOutStorageStates).
		{
			name: "setup",
			testMatch: /signup\.setup\.js/,
			teardown: "cleanup",
			use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
		},
		// 2a) Desktop web suite.
		{
			name: "web",
			dependencies: ["setup"],
			testMatch: /.*\.spec\.js/,
			testIgnore: /.*\.mobile\.spec\.js/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				storageState: stateFor("web"),
			},
		},
		// 2b) Android mobile-web emulation (Pixel 7).
		{
			name: "android",
			dependencies: ["setup"],
			testMatch: [/.*\.spec\.js/, /.*\.mobile\.spec\.js/],
			testIgnore: /01-login\.spec\.js/,
			use: {
				...devices["Pixel 7"],
				storageState: stateFor("android"),
			},
		},
		// 2c) iOS mobile-web emulation (iPhone 14).
		{
			name: "ios",
			dependencies: ["setup"],
			testMatch: [/.*\.spec\.js/, /.*\.mobile\.spec\.js/],
			testIgnore: /01-login\.spec\.js/,
			use: {
				...devices["iPhone 14"],
				storageState: stateFor("ios"),
			},
		},
		// 3) Runs after everything else and deletes the test user account.
		{
			name: "cleanup",
			testMatch: /delete-user\.teardown\.js/,
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				// Cleanup verifies ownership through a fresh UI login, without revoking an in-flight stored session.
				storageState: { cookies: [], origins: [] },
			},
		},
	],

	...(AUTO_START_SERVER
		? {
				webServer: {
					command: "npm run dev",
					cwd: ORDERING_UI_DIR,
					url: BASE_URL,
					reuseExistingServer: true,
					timeout: 600 * 1000,
					stdout: "ignore",
					stderr: "pipe",
				},
		  }
		: {}),
});
