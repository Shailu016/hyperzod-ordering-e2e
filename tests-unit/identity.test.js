const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolatedIdentity, useIsolatedIdentity } = require('../utils/isolated-identity');
test('local runs isolate by default, shared identity requires explicit opt-in, CI remains shared', () => {
  assert.equal(useIsolatedIdentity({}), true);
  assert.equal(useIsolatedIdentity({ E2E_ISOLATED_IDENTITY: '' }), true);
  assert.equal(useIsolatedIdentity({ E2E_ISOLATED_IDENTITY: 'false' }), false);
  assert.equal(useIsolatedIdentity({ GITHUB_ACTIONS: 'true' }), false);
  assert.throws(() => useIsolatedIdentity({ E2E_ISOLATED_IDENTITY: 'FALSE' }), /true or false/);
  assert.throws(() => useIsolatedIdentity({ GITHUB_ACTIONS: 'true', E2E_ISOLATED_IDENTITY: 'true' }), /local/);
});
test('isolated local identities are unique aliases and reject invalid email', () => {
  const first = isolatedIdentity('tester+existing@example.invalid'), second = isolatedIdentity('tester+existing@example.invalid');
  assert.match(first.email, /^tester\.e2e[a-f0-9]{16}@example.invalid$/);
  assert.match(first.phone, /^9\d{9}$/);
  assert.notEqual(first.email, second.email);
  assert.throws(() => isolatedIdentity('invalid'), /Valid/);
});
