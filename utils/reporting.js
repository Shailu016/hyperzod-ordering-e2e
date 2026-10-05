// @ts-check
/**
 * Production reporting helpers.
 *
 * Goals:
 *  1. Every failure leaves: Playwright trace + video + screenshot (configured
 *     in playwright.config.js) PLUS a console/network log file.
 *  2. Every failure prints a PLAIN-LANGUAGE summary to the console so a
 *     non-engineer can tell "what happened / which feature broke".
 *
 * Payment gateways are out of scope for this suite (COD only), so any failure
 * that points at an external gateway is reported as "skipped by policy",
 * not as an app bug.
 */

const fs = require("fs");
const path = require("path");

/** Map a URL or message fragment to a human feature name. */
function featureFromUrl(url) {
	const u = String(url || "");
	if (/429|too many attempts/i.test(u)) {
		if (u.includes("/boot")) return "App boot (BACKEND RATE LIMIT 429 - infra throttle, NOT an app bug; suite backs off and retries)";
		return "Backend rate limit 429 (infra throttle, NOT an app bug)";
	}
	if (u.includes("/auth/v1/user/login/intent") || u.includes("/auth/v1/user/login"))
		return "Login (auth)";
	if (u.includes("/auth/v1/user/register") || u.includes("/auth/v1/user/otp/verify"))
		return "Signup / OTP (auth)";
	if (u.includes("/auth/v1/user/") && u.includes("DELETE")) return "Delete account (auth)";
	if (u.includes("/auth/v1/me")) return "Session restore (auth)";
	if (u.includes("/store/v1/cart")) return "Cart (add / update)";
	if (u.includes("/store/v1/order")) return "Order placement (checkout)";
	if (u.includes("/store/v1/address") || u.includes("/address/")) return "Delivery address";
	if (u.includes("/store/v1/merchant") || u.includes("merchant"))
		return "Merchant menu";
	if (u.includes("boot") || u.includes("tenant")) return "App boot (tenant settings)";
	if (u.includes("places") || u.includes("reverse") || u.includes("geocode"))
		return "Location search";
	if (/paypal|stripe|razorpay|cashfree|revolut|kkiapay|cybersource/i.test(u))
		return "Payment gateway (OUT OF SCOPE - COD only)";
	return "";
}

function featureFromTestFile(testFile) {
	const f = String(testFile || "");
	if (f.includes("login") || f.includes("signup")) return "Auth (login/signup)";
	if (f.includes("place-order") || f.includes("checkout")) return "Checkout / order placement";
	if (f.includes("cart")) return "Cart";
	if (f.includes("pages")) return "Page rendering (smoke sweep)";
	if (f.includes("address") || f.includes("location")) return "Location / address";
	if (f.includes("profile") || f.includes("orders")) return "Profile / orders";
	if (f.includes("catalog") || f.includes("merchant") || f.includes("search"))
		return "Catalog / merchant / search";
	if (f.includes("a11y") || f.includes("visual")) return "Accessibility / visual";
	return "Ordering app";
}

/**
 * Start collecting console errors, page errors and failed API calls.
 * Call at the start of every test (the shared fixture does this).
 */
function startCapture(page) {
	const capture = { consoleErrors: [], pageErrors: [], failedRequests: [] };
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			capture.consoleErrors.push(msg.text().slice(0, 500));
		}
	});
	page.on("pageerror", (err) => {
		capture.pageErrors.push(String(err && err.message ? err.message : err).slice(0, 500));
	});
	page.on("response", async (resp) => {
		try {
			const status = resp.status();
			if (status >= 400) {
				const url = resp.url();
				// Ignore noisy third-party beacons; keep first-party API failures.
				if (/fonts\.googleapis|fonts\.gstatic|cdn-|sentry/i.test(url)) return;
				// Record the failure FIRST - body parsing is best-effort and
				// must never swallow the fact that the call failed.
				const entry = `${status} ${resp.request().method()} ${url}`;
				try {
					const json = await resp.json();
					capture.failedRequests.push(`${entry} ${JSON.stringify(json).slice(0, 300)}`);
				} catch {
					capture.failedRequests.push(entry);
				}
			}
		} catch {
			/* never let the listener break the test */
		}
	});
	return capture;
}

/** Best-effort toast text for diagnostics (what the user actually saw). */
async function visibleToastText(page) {
	try {
		return (
			await page
				.locator(".v-snackbar__content, #app-snackbar, .alert-message")
				.allInnerTexts()
		)
			.join(" | ")
			.trim()
			.slice(0, 300);
	} catch {
		return "";
	}
}

/**
 * Build + print + attach a plain-language failure report.
 * Never throws - reporting must not mask the original error.
 */
async function reportFailure(testInfo, page, capture, originalError) {
	try {
		const title = testInfo.titlePath.slice(1).join(" > ") || testInfo.title;
		const file = testInfo.file || "";
		// File-derived feature is primary (stable); API-derived signals are
		// listed separately so one noisy endpoint can't misattribute blame.
		const feature = featureFromTestFile(file);
		const failedApis = (capture.failedRequests || []).slice(0, 5);
		const apiFeatures = [];
		for (const r of failedApis) {
			const f = featureFromUrl(r);
			if (f && !apiFeatures.includes(f)) apiFeatures.push(f);
		}
		const toast = page ? await visibleToastText(page) : "";
		const errMsg = String(
			(originalError && originalError.message) || originalError || "unknown error"
		)
			.split("\n")
			.slice(0, 4)
			.join(" | ")
			.slice(0, 400);

		const lines = [
			``,
			`================ FAILED TEST (plain language) ================`,
			`What happened : "${title}" did not finish.`,
			`Which feature : ${feature} is broken or blocked the flow.`,
			`Where         : ${file} @ ${page ? page.url() : "(no page)"}`,
			`Technical hint: ${errMsg}`,
		];
		if (toast) lines.push(`App showed    : "${toast}"`);
		if (apiFeatures.length) lines.push(`Also failing  : ${apiFeatures.join(" | ").slice(0, 300)}`);
		if (failedApis.length) {
			lines.push(`Failed calls  :`);
			for (const r of failedApis) lines.push(`  - ${r.slice(0, 220)}`);
		}
		if (capture.pageErrors && capture.pageErrors.length) {
			lines.push(`Page errors   : ${capture.pageErrors[0].slice(0, 220)}`);
		}
		lines.push(
			`Evidence      : trace + video + screenshot in test-results (retain-on-failure), console log attached below.`
		);
		lines.push(`============================================================`, ``);
		const text = lines.join("\n");
		// eslint-disable-next-line no-console
		console.log(text);

		// Attach the console/network log to the HTML report.
		const logPath = testInfo.outputPath("console.log");
		const logBody = [
			`TEST: ${title}`,
			`FILE: ${file}`,
			`URL: ${page ? page.url() : ""}`,
			``,
			`--- console errors (${capture.consoleErrors.length}) ---`,
			...capture.consoleErrors.slice(0, 30),
			``,
			`--- page errors (${capture.pageErrors.length}) ---`,
			...capture.pageErrors.slice(0, 30),
			``,
			`--- failed requests (${capture.failedRequests.length}) ---`,
			...capture.failedRequests.slice(0, 30),
		].join("\n");
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, logBody);
		await testInfo.attach("console-log", {
			path: logPath,
			contentType: "text/plain",
		});

		// Extra screenshot labelled "console-state" (page as the user saw it).
		if (page) {
			try {
				const shotPath = testInfo.outputPath("console-state.png");
				await page.screenshot({ path: shotPath, fullPage: false });
				await testInfo.attach("console-state", {
					path: shotPath,
					contentType: "image/png",
				});
			} catch {
				/* screenshot is best-effort */
			}
		}
	} catch {
		/* never mask the original failure */
	}
}

module.exports = {
	startCapture,
	visibleToastText,
	reportFailure,
	featureFromUrl,
	featureFromTestFile,
};
