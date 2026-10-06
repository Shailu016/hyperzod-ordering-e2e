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
    await capture.finish();
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});

test('late API body errors are drained before success checks and listeners detach', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter();
    const capture = startCapture(page);
    let complete;
    page.emit('response', { url: () => 'https://api.hyperzod.app/store/v1/cart', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ method: () => 'POST' }), json: () => new Promise((resolve) => { complete = resolve; }) });
    const finishing = capture.finish();
    assert.equal(capture.failedRequests.length, 0);
    complete({ success: false });
    await finishing;
    assert.match(capture.failedRequests[0], /APPLICATION/);
    assert.equal(page.listenerCount('response'), 0);
    assert.equal(page.listenerCount('requestfailed'), 0);
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});

test('an API body that never settles cannot silently pass', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter();
    const capture = startCapture(page, { drainTimeoutMs: 10 });
    page.emit('response', { url: () => 'https://api.hyperzod.app/store/v1/cart', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), json: () => new Promise(() => {}) });
    await capture.finish();
    assert.match(capture.failedRequests[0], /diagnostics are incomplete/);
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});
