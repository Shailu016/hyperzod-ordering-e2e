const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeUntil } = require('../utils/observe');
test('late popup hydration can settle without replaying the action', async () => {
  let time = 0, reads = 0;
  const result = await observeUntil('popup', async () => { reads++; return time >= 15_000 ? 'visible' : null; }, Boolean, { timeout: 30_000, interval: 1_000, now: () => time, wait: async (ms) => { time += ms; } });
  assert.equal(result, 'visible'); assert.equal(reads, 16);
});
test('observations stop at the deadline and propagate session/business errors', async () => {
  let time = 0;
  await assert.rejects(observeUntil('loading', async () => false, Boolean, { timeout: 100, interval: 30, now: () => time, wait: async (ms) => { time += ms; } }), /within 100ms/);
  assert.equal(time, 100);
  await assert.rejects(observeUntil('auth', async () => { throw new Error('identity changed'); }, Boolean), /identity changed/);
});
test('an observation that never returns still obeys its deadline', async () => {
  await assert.rejects(observeUntil('hung read', () => new Promise(() => {}), Boolean, { timeout: 20 }), /did not settle/);
});
