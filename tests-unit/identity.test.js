const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolatedIdentity } = require('../utils/isolated-identity');
test('isolated local identities are unique aliases and reject invalid email', () => {
  const first = isolatedIdentity('tester+existing@example.invalid'), second = isolatedIdentity('tester+existing@example.invalid');
  assert.match(first.email, /^tester\.e2e[a-f0-9]{16}@example.invalid$/);
  assert.match(first.phone, /^9\d{9}$/);
  assert.notEqual(first.email, second.email);
  assert.throws(() => isolatedIdentity('invalid'), /Valid/);
});
