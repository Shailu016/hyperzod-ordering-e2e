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
			const capture = startCapture(page);
			try {
				await use(capture);
			} finally {
				// testInfo.status is set by the time fixtures tear down.
				if (testInfo.status !== testInfo.expectedStatus) {
					const err = testInfo.error;
					await reportFailure(testInfo, page, capture, err);
				}
			}
		},
		{ auto: true },
	],
});

module.exports = { test, expect: base.expect, devices: base.devices };
