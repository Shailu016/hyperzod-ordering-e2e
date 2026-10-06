// @ts-check
/**
 * Shared Playwright fixture for the whole suite.
 *
 * Usage in new specs:
 *   const { test, expect } = require("../fixtures/test.fixture");
 *
 * What it adds over vanilla @playwright/test:
 *  - per-test console/network capture (utils/reporting.startCapture)
 *  - on failure: plain-language console summary + console.log + screenshot
 *    attachments ("console-log", "console-state")
 *
 * Old specs that require("@playwright/test") directly keep working - they
 * just don't get the plain-language report until they migrate.
 */
const base = require("@playwright/test");
const { startCapture, reportFailure } = require("../utils/reporting");

const test = base.test.extend({
	// Auto-fixture: runs for every test without being requested.
	_failureReporter: [
		async ({ page }, use, testInfo) => {
			require("../utils/manifest").assertManagedRun();
			const capture = startCapture(page);
			let fixtureError;
			try {
				await use(capture);
				await capture.finish();
				if (testInfo.status === "passed") {
					base.expect(capture.pageErrors, "unexpected application errors").toEqual([]);
					if (!/rejects invalid credentials/.test(testInfo.title)) {
						base.expect(capture.consoleErrors.filter((message) => !/fonts\.googleapis|fonts\.gstatic|favicon|sentry/i.test(message)), "unexpected console errors").toEqual([]);
					}
					const unexpected = capture.failedRequests.filter((entry) => {
						const expectedRejection = /rejects invalid credentials/.test(testInfo.title) && /\/auth\/v1\/user\/(login|otp\/verify)/.test(entry) && !/TRANSPORT/.test(entry);
						return !expectedRejection;
					});
					base.expect(unexpected, "unexpected first-party network failures").toEqual([]);
				}
			} catch (error) {
				fixtureError = error;
				throw error;
			} finally {
				await capture.finish();
				// testInfo.status is set by the time fixtures tear down.
				if (fixtureError || testInfo.status !== testInfo.expectedStatus) {
					const err = fixtureError || testInfo.error;
					await reportFailure(testInfo, page, capture, err);
				}
			}
		},
		{ auto: true },
	],
});

module.exports = { test, expect: base.expect, devices: base.devices };
