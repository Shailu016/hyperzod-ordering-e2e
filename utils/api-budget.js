const fs = require('node:fs');
const path = require('node:path');
function budgetFile() { return process.env.E2E_RUN_ID ? path.join(require('./manifest').directoryFor(process.env.E2E_LEASE_OWNER || process.env.E2E_RUN_ID), 'api-budget.json') : null; }
function retryAfterMs(value, now = Date.now()) {
  if (value && /^\d+(?:\.\d+)?$/.test(value)) return Math.max(1_000, Number(value) * 1_000);
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
function homeReadWasThrottledSince(timestamp, { file = budgetFile() } = {}) {
  return !!file && fs.existsSync(file) && Number(JSON.parse(fs.readFileSync(file, 'utf8')).homeReadThrottledAt) >= timestamp;
}
async function waitForApiBudget({ file = budgetFile(), now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maximumWaitMs = 120_000 } = {}) {
  if (!file || !fs.existsSync(file)) return;
  const remaining = Math.max(0, JSON.parse(fs.readFileSync(file, 'utf8')).until - now());
  if (!remaining) return;
  if (remaining > maximumWaitMs) throw new Error('API Retry-After exceeds the bounded test budget; wait before another live run');
  console.log(`[API] respecting rate-limit cooldown (${Math.ceil(remaining / 1_000)}s); no mutation is replayed`);
  await sleep(remaining);
}
module.exports = { retryAfterMs, recordThrottle, waitForApiBudget, homeReadWasThrottledSince };
