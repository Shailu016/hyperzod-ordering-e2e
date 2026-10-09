const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverBeforeSubmission, SessionRenewedError, hasSessionBudget } = require('../utils/session-recovery');
test('one expired session restores the same cart before returning a preparation', async () => {
  let attempts = 0, recovered = 0;
  const cart = { id: 42, lines: [{ product: 7, quantity: 2 }] };
  const result = await recoverBeforeSubmission({ assertNoSubmission() {}, prepare: async () => { if (++attempts === 1) throw new SessionRenewedError(); return cart; }, recover: async () => { recovered++; } });
  assert.deepEqual(result, cart); assert.equal(recovered, 1); assert.equal(attempts, 2);
});
test('mutation/business failures are never replayed', async () => {
  let recovered = 0;
  await assert.rejects(recoverBeforeSubmission({ assertNoSubmission() {}, prepare: async () => { throw new Error('Ambiguous order POST'); }, recover: async () => { recovered++; } }), /Ambiguous/);
  assert.equal(recovered, 0);
});
test('a submission attempt blocks recovery and a second expiry does not loop', async () => {
  let attempted = false, recovered = 0;
  await assert.rejects(recoverBeforeSubmission({ assertNoSubmission() { if (attempted) throw new Error('submission recorded'); }, prepare: async () => { attempted = true; throw new SessionRenewedError(); }, recover: async () => { recovered++; } }), /submission recorded/);
  assert.equal(recovered, 0);
  await assert.rejects(recoverBeforeSubmission({ assertNoSubmission() {}, prepare: async () => { throw new SessionRenewedError(); }, recover: async () => { recovered++; } }), SessionRenewedError);
  assert.equal(recovered, 1);
});
test('missing, expired and near-expiry tokens do not satisfy a submission budget', () => {
  for (const expiry of [undefined, null, NaN, 900, 1000, 1050]) assert.equal(hasSessionBudget(expiry, 100, 1000), false);
  assert.equal(hasSessionBudget(1200, 100, 1000), true);
});
