const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverLease } = require('../utils/lease-recovery');
const { fixture } = require('./lease-fixture');
test('age alone cannot recover a lease without reconciliation and inactive-owner proof', async () => {
  for (const overrides of [{ ownerInactive: false }, { resourcesReconciled: false }]) {
    const { options, calls } = fixture();
    await assert.rejects(recoverLease({ ...options, ...overrides }), /confirmations/);
    assert.equal(calls.length, 0);
  }
});
