const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startCapture } = require('../utils/reporting');
test('transport failures and successful HTTP application errors are recorded', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter();
    const capture = startCapture(page);
    page.emit('requestfailed', { url: () => 'https://api.hyperzod.app/store/v1/cart', method: () => 'POST', failure: () => ({ errorText: 'net::ERR_FAILED' }) });
    page.emit('response', { url: () => 'https://api.hyperzod.app/store/v1/cart', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ method: () => 'POST' }), json: async () => ({ success: false, message: { email: 'private@example.invalid' } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.failedRequests.length, 2);
    assert.match(capture.failedRequests[0], /TRANSPORT/);
    assert.match(capture.failedRequests[1], /APPLICATION/);
    assert.ok(!capture.failedRequests[1].includes('private@example.invalid'));
    page.emit('requestfailed', { url: () => 'https://api.hyperzod.app/store/v1/cart', method: () => 'GET', failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
    assert.equal(capture.cancelledRequests.length, 1);
    assert.equal(capture.failedRequests.length, 2);
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});
