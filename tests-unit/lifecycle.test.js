const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requiresReconciliation } = require('../utils/lifecycle');
test('ambiguous submission and missing cleanup proof block the next device and retain the lease', () => {
  for (const resource of [undefined, { lifecycle: 'authenticated' }, { lifecycle: 'cleanup-unresolved' }, { lifecycle: 'deleted-and-proven', submissionAttempted: {}, orders: [] }]) assert.equal(requiresReconciliation(resource), true);
  assert.equal(requiresReconciliation({ lifecycle: 'absent-proven', orders: [] }), false);
  assert.equal(requiresReconciliation({ lifecycle: 'deleted-and-proven', submissionAttempted: {}, orders: [{ orderId: 123 }] }), false);
});
