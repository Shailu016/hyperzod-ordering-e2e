const fs = require('node:fs');
const path = require('node:path');
function budgetFile() { return process.env.E2E_RUN_ID ? path.join(require('./manifest').directoryFor(process.env.E2E_LEASE_OWNER || process.env.E2E_RUN_ID), 'api-budget.json') : null; }
function retryAfterMs(value, now = Date.now()) {
  if (value && /^\d+(?:\.\d+)?$/.test(value)) return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1_000, Number(value) * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? date - now : 30_000;
}
/** @param {string | undefined} value @param {{file?: string | null, now?: number, method?: string, endpoint?: string}} [options] */
function recordThrottle(value, { file = budgetFile(), now = Date.now(), method, endpoint } = {}) {
  if (!file) return;
  let previous = {};
  if (fs.existsSync(file)) previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  const until = Math.max(previous.until || 0, now + retryAfterMs(value, now));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const homeReadThrottledAt = method === 'POST' && endpoint === '/store/v1/home' ? now : previous.homeReadThrottledAt;
  fs.writeFileSync(file + '.tmp', JSON.stringify({ until, homeReadThrottledAt }));
  fs.renameSync(file + '.tmp', file);
}
// Functional tests should not consume a whole per-IP minute just by opening
// several pages in quick succession. Reserve half a window for the next test's
// requests. This delays scenario starts; it never replays a browser request.
function recordRateLimit(headers, { file = budgetFile(), now = Date.now() } = {}) {
  if (!file) return;
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  if (!Number.isSafeInteger(limit) || limit <= 0 || headers['x-ratelimit-remaining'] == null ||
      !Number.isSafeInteger(remaining) || remaining < 0 || remaining > Math.floor(limit / 2)) return;
  const reset = Number(headers['x-ratelimit-reset']) * 1_000;
  const serverNow = Date.parse(headers.date);
  // Laravel normally includes Reset only on a throttled response. Without it,
  // wait a full minute from observation, plus clock/boundary margin.
  const waitMs = Number.isFinite(reset) && reset > 0 ? Math.max(0, reset - (Number.isFinite(serverNow) ? serverNow : now)) + 1_000 : 61_000;
  recordThrottle(String(waitMs / 1_000), { file, now });
}
function homeReadWasThrottledSince(timestamp, { file = budgetFile() } = {}) {
  return !!file && fs.existsSync(file) && Number(JSON.parse(fs.readFileSync(file, 'utf8')).homeReadThrottledAt) >= timestamp;
}
async function waitForApiBudget({ file = budgetFile(), now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maximumWaitMs = 120_000 } = {}) {
  if (!file || !fs.existsSync(file)) return;
  const until = JSON.parse(fs.readFileSync(file, 'utf8')).until;
  if (!Number.isFinite(until) || until < 0) throw new Error('Invalid API cooldown evidence; refusing to start another scenario');
  const remaining = Math.max(0, until - now());
  if (!remaining) return;
  if (remaining > maximumWaitMs) throw new Error('API Retry-After exceeds the bounded test budget; wait before another live run');
  console.log(`[API] respecting rate-limit cooldown (${Math.ceil(remaining / 1_000)}s); no mutation is replayed`);
  await sleep(remaining);
}
module.exports = { retryAfterMs, recordThrottle, recordRateLimit, waitForApiBudget, homeReadWasThrottledSince };
