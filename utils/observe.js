/** Bounded polling for observations only. Never put a mutation in read(). */
async function observeUntil(label, read, ready, { timeout = 60_000, interval = 500, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeout;
  let lastError;
  while (now() < deadline) {
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(read),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: observation timed out`)), Math.max(1, deadline - now())); }),
      ]);
      if (ready(value)) return value;
    } catch (error) {
      // Auth/identity/business failures must escape to their own recovery policy.
      if (!/observation timed out|Execution context was destroyed|Cannot find context|Mounted Vuex store is unavailable/.test(String(error?.message))) throw error;
      lastError = error;
    } finally { clearTimeout(timer); }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(interval, remaining));
  }
  throw new Error(`${label}: did not settle within ${timeout}ms${lastError ? ` (${lastError.message})` : ''}`);
}
module.exports = { observeUntil };
