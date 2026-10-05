// @ts-check
/**
 * Retry primitives for the whole suite.
 *
 * Backend reality: throttled APIs (429), origin tar-pits, and cold starts
 * make single-attempt waits flaky. Every retry in this suite funnels through
 * here so backoff policy is defined once:
 *  - exponential backoff with full jitter (decorrelated, thundering-herd safe)
 *  - bounded attempts, last error preserved and rethrown
 *  - optional onRetry hook for log lines (keeps failure logs diagnosable)
 */

/** Sleep helper (ms). */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with full jitter.
 * wait = random(0, min(capMs, baseMs * 2^attempt)).
 */
function backoffMs(attempt, baseMs = 5_000, capMs = 75_000) {
	const grown = baseMs * 2 ** Math.max(0, attempt - 1);
	return Math.floor(Math.random() * Math.min(capMs, grown));
}

/**
 * Run fn() until it resolves, or attempts run out.
 * Between attempts: wait with backoff, then fire onRetry (e.g. reload the
 * page) so the next attempt starts from settled state.
 * @param {() => Promise<T>} fn step to retry
 * @param {{attempts?: number, baseMs?: number, capMs?: number, label?: string, onRetry?: (info: {attempt: number, waitMs: number, error: any}) => void | Promise<void>}} [opts]
 * @returns {Promise<T>} fn's resolution
 * @throws the last error when attempts are exhausted
 */
async function retryAsync(fn, opts = {}) {
	const { attempts = 3, baseMs = 5_000, capMs = 75_000, label = "step", onRetry } = opts;
	let lastError = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			if (attempt === attempts) break;
			const waitMs = backoffMs(attempt, baseMs, capMs);
			await sleep(waitMs);
			if (onRetry) {
				try {
					await onRetry({ attempt, waitMs, error: err });
				} catch {
					/* hook must never break the retry loop */
				}
			}
		}
	}
	throw lastError;
}

module.exports = { sleep, backoffMs, retryAsync };
