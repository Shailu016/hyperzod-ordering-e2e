const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessDiagnostics } = require('../utils/diagnostics');
test('only proven navigation-cancelled reads are warnings; writes and unexplained cancellations fail', () => {
  const result = assessDiagnostics({ successfulReads: {}, events: [
    { kind: 'cancelled', navigationDiscarded: true, method: 'GET', url: 'https://api.hyperzod.app/store/v1/cart' },
    { kind: 'cancelled', navigationDiscarded: true, method: 'POST', url: 'https://api.hyperzod.app/store/v1/home' },
    { kind: 'cancelled', method: 'GET', url: 'https://api.hyperzod.app/store/v1/cart' },
    { kind: 'cancelled', method: 'OPTIONS', url: 'https://api.hyperzod.app/store/v1/cart' },
    { kind: 'cancelled', method: 'POST', url: 'https://api.hyperzod.app/store/v1/cart' },
    { kind: 'application', method: 'POST', url: 'https://api.hyperzod.app/store/v1/cart', message: '{}' },
    { kind: 'inspection', message: 'could not inspect JSON' },
  ] });
  assert.equal(result.warnings.length, 2);
  assert.equal(result.critical.length, 5);
});
