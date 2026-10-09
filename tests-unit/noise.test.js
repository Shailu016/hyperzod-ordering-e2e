const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessDiagnostics } = require('../utils/diagnostics');
test('read cancellation is a warning but cancelled writes and incomplete inspection remain failures', () => {
  const result = assessDiagnostics({ successfulReads: {}, events: [
    { kind: 'cancelled', method: 'GET', url: 'https://api.hyperzod.app/store/v1/cart' },
    { kind: 'cancelled', method: 'POST', url: 'https://api.hyperzod.app/store/v1/home' },
    { kind: 'cancelled', method: 'POST', url: 'https://api.hyperzod.app/store/v1/cart' },
    { kind: 'application', method: 'POST', url: 'https://api.hyperzod.app/store/v1/cart', message: '{}' },
    { kind: 'inspection', message: 'could not inspect JSON' },
  ] });
  assert.equal(result.warnings.length, 2);
  assert.equal(result.critical.length, 3);
});
