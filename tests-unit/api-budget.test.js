const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { retryAfterMs, recordThrottle, recordRateLimit, waitForApiBudget, homeReadWasThrottledSince } = require('../utils/api-budget');

test('low server capacity paces the next scenario and preserves a longer Retry-After', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-remaining-budget-'));
  const file = path.join(directory, 'budget.json');
  try {
    recordRateLimit({ 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': '61' }, { file, now: 1_000 });
    assert.equal(fs.existsSync(file), false);
    recordRateLimit({ 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': '60' }, { file, now: 1_000 });
    let waited;
    await waitForApiBudget({ file, now: () => 2_000, sleep: async (ms) => { waited = ms; } });
    assert.equal(waited, 60_000);
    assert.equal(homeReadWasThrottledSince(0, { file }), false, 'low remaining capacity does not authorize a retry');
    recordThrottle('90', { file, now: 1_000 });
    recordRateLimit({ 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': '0' }, { file, now: 1_000 });
    assert.equal(JSON.parse(fs.readFileSync(file)).until, 91_000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('rate-limit reset uses the server clock; malformed capacity headers do not create a budget', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-server-budget-'));
  const file = path.join(directory, 'budget.json');
  try {
    for (const headers of [{}, { 'x-ratelimit-limit': '120' }, { 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': 'bad' }]) recordRateLimit(headers, { file });
    assert.equal(fs.existsSync(file), false);
    recordRateLimit({ 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1780000020', date: new Date(1780000000000).toUTCString() }, { file, now: 1_000 });
    assert.equal(JSON.parse(fs.readFileSync(file)).until, 22_000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('overflowing Retry-After and corrupt cooldown evidence cannot bypass the wait', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-invalid-budget-'));
  const file = path.join(directory, 'budget.json');
  try {
    recordThrottle('9'.repeat(400), { file, now: 1_000 });
    await assert.rejects(waitForApiBudget({ file, now: () => 1_000 }), /bounded/);
    fs.writeFileSync(file, JSON.stringify({ until: null }));
    await assert.rejects(waitForApiBudget({ file }), /Invalid API cooldown/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('only the documented home read throttle enables home-query recovery', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-read-budget-'));
  const file = path.join(directory, 'budget.json');
  try {
    recordThrottle('30', { file, now: 1_000, method: 'POST', endpoint: '/store/v1/order' });
    assert.equal(homeReadWasThrottledSince(0, { file }), false);
    recordThrottle('30', { file, now: 2_000, method: 'POST', endpoint: '/store/v1/home' });
    assert.equal(homeReadWasThrottledSince(1_500, { file }), true);
    assert.equal(homeReadWasThrottledSince(2_001, { file }), false);
    recordThrottle('30', { file, now: 3_000, method: 'POST', endpoint: '/store/v1/cart' });
    assert.equal(homeReadWasThrottledSince(2_001, { file }), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('Retry-After seconds and dates are respected; invalid hints use bounded fallback', () => {
  const now = Date.parse('2026-10-09T05:00:00Z');
  assert.equal(retryAfterMs('12', now), 12_000);
  assert.equal(retryAfterMs('Fri, 09 Oct 2026 05:00:20 GMT', now), 20_000);
  assert.equal(retryAfterMs(undefined, now), 30_000);
});
test('cooldown persists across worker restarts and excessive delays stop without an early request', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-api-budget-'));
  const file = path.join(directory, 'budget.json');
  try {
    recordThrottle('30', { file, now: 1_000 });
    recordThrottle('1', { file, now: 2_000 });
    let waited = 0;
    await waitForApiBudget({ file, now: () => 10_000, sleep: async (ms) => { waited = ms; } });
    assert.equal(waited, 21_000);
    await assert.rejects(waitForApiBudget({ file, now: () => 1_000, maximumWaitMs: 5_000, sleep: async () => assert.fail('Must not retry before server budget') }), /bounded/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
