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
const { assessDiagnostics } = require("../utils/diagnostics");

const test = base.test.extend({
	apiDependencies: [[], { option: true }],
	// Auto-fixture: runs for every test without being requested.
	_failureReporter: [
		async ({ page, apiDependencies }, use, testInfo) => {
			require("../utils/manifest").assertManagedRun();
			await require('../utils/api-budget').waitForApiBudget();
			const capture = startCapture(page);
			let fixtureError;
			try {
				await use(capture);
				await capture.finish();
				const dependencies = [...apiDependencies, ...(process.env.E2E_ORDER_FORMS === 'true' ? ['orderForms'] : [])];
				const manifest = require('../utils/manifest').readManifest();
				const deletedUserId = testInfo.title === 'delete the test user account via UI @smoke' && manifest.lifecycle === 'deleted-and-proven' ? manifest.userId : undefined;
				const outcome = assessDiagnostics(capture, { page, dependencies, deletedUserId, expectedAuthRejection: testInfo.title === "rejects invalid credentials", expectedMissingPage: testInfo.title === 'custom CMS page route does not crash the shell' });
				if (outcome.warnings.length || outcome.critical.length) await testInfo.attach("api-diagnostics", { body: Buffer.from(JSON.stringify(outcome, null, 2)), contentType: "application/json" });
				if (outcome.warnings.length) testInfo.annotations.push({ type: "warning", description: `${outcome.warnings.length} background/recovered API diagnostics; see attachment` });
				if (testInfo.status === "passed") base.expect(outcome.critical, "unexpected application or required API failures").toEqual([]);
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
