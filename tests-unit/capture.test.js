const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startCapture } = require('../utils/reporting');
const { assessDiagnostics } = require('../utils/diagnostics');

test('explicit API settlement waits for requests and JSON bodies without hiding a failure', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter(), capture = startCapture(page);
    const request = { method: () => 'GET', url: () => 'https://api.hyperzod.app/auth/v1/me', resourceType: () => 'xhr' };
    page.emit('request', request);
    let complete, settled = false;
    const draining = capture.drain(true, 1_000).then(() => { settled = true; });
    page.emit('response', { url: request.url, status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => request,
      json: () => new Promise((resolve) => { complete = resolve; }) });
    page.emit('requestfinished', request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'a finished request is insufficient while its JSON inspection is pending');
    complete({ success: false, message: 'Session invalid' });
    await draining;
    await capture.finish();
    assert.equal(assessDiagnostics(capture).critical.length, 1);
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});

test('a scenario settlement timeout preserves critical incomplete evidence', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter(), capture = startCapture(page);
    const request = { method: () => 'GET', url: () => 'https://api.hyperzod.app/store/v1/address', resourceType: () => 'xhr' };
    page.emit('request', request);
    await capture.drain(true, 10);
    page.emit('requestfinished', request);
    await capture.finish();
    assert.ok(assessDiagnostics(capture).critical.some((event) => /diagnostics are incomplete/.test(event.message)));
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});

test('deletion evidence requires a successful JSON acknowledgement and chat diagnostics retain their host', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter(), capture = startCapture(page);
    for (const [method, id, success] of [['DELETE', 123, true], ['DELETE', 456, false], ['GET', 789, true]]) {
      const url = 'https://api.hyperzod.app/auth/v1/user/' + id;
      page.emit('response', { url: () => url, status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ method: () => method, url: () => url }), json: async () => ({ success }) });
    }
    const url = 'https://chat.apps.hyperzod.com/api/v1/embed/notifications/connection';
    page.emit('response', { url: () => url, status: () => 401, headers: () => ({}), request: () => ({ method: () => 'POST', url: () => url }) });
    page.emit('pageerror', { message: '//chat.apps.hyperzod.com/api/v1/embed/notifications/connection due to access control checks.' });
    await capture.finish();
    assert.deepEqual(capture.successfulAccountDeletions.map((deletion) => deletion.userId), ['123']);
    assert.ok(capture.events.some((event) => event.kind === 'http' && event.url === url));
    assert.ok(capture.events.some((event) => event.kind === 'page' && event.url === url));
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});

test('a request started by the test cannot deliver an unseen HTTP failure after teardown starts', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter(), capture = startCapture(page);
    const request = { method: () => 'GET', url: () => 'https://api.hyperzod.app/store/v1/address', resourceType: () => 'fetch' };
    page.emit('request', request);
    const finishing = capture.finish();
    assert.equal(page.listenerCount('response'), 1);
    page.emit('response', { url: request.url, status: () => 500, headers: () => ({}), request: () => request });
    page.emit('requestfinished', request);
    await finishing;
    assert.match(capture.failedRequests[0], /500 GET/);
    assert.equal(page.listenerCount('response'), 0);
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});

test('explicit navigation drains JSON bodies before the browser invalidates resources', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter();
    let navigated = false, complete;
    page.goto = async () => { navigated = true; };
    const original = page.goto;
    const capture = startCapture(page);
    page.emit('response', { url: () => 'https://api.hyperzod.app/store/v1/boot', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ method: () => 'GET', url: () => 'https://api.hyperzod.app/store/v1/boot' }), json: () => new Promise((resolve) => { complete = resolve; }) });
    const moving = page.goto('/next');
    assert.equal(navigated, false);
    complete({ success: false });
    await moving;
    assert.equal(navigated, true);
    assert.match(capture.failedRequests[0], /APPLICATION/);
    await capture.finish();
    assert.equal(page.goto, original);
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});

test('unusual page errors remain diagnostic evidence and capacity exhaustion fails visibly', async () => {
  const page = new EventEmitter();
  const capture = startCapture(page);
  page.emit('pageerror', 'string error');
  page.emit('pageerror', null);
  for (let i = 0; i < 101; i++) page.emit('pageerror', new Error('problem'));
  await capture.finish();
  assert.equal(capture.pageErrors[0], 'string error');
  assert.equal(capture.pageErrors[1], 'null');
  assert.ok(capture.events.some((event) => /capacity exceeded/.test(event.message)));
});
test('transport failures and successful HTTP application errors are recorded', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter();
    const capture = startCapture(page);
    page.emit('requestfailed', { url: () => 'https://api.hyperzod.app/store/v1/cart', method: () => 'POST', failure: () => ({ errorText: 'net::ERR_FAILED' }) });
    page.emit('response', { url: () => 'https://api.hyperzod.app/store/v1/cart', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ method: () => 'POST', url: () => 'https://api.hyperzod.app/store/v1/cart' }), json: async () => ({ success: false, message: { email: 'private@example.invalid' } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capture.failedRequests.length, 2);
    assert.match(capture.failedRequests[0], /TRANSPORT/);
    assert.match(capture.failedRequests[1], /APPLICATION/);
    assert.ok(!capture.failedRequests[1].includes('private@example.invalid'));
    page.emit('requestfailed', { url: () => 'https://api.hyperzod.app/store/v1/cart', method: () => 'GET', failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
    assert.equal(capture.cancelledRequests.length, 1);
    assert.equal(capture.failedRequests.length, 2);
    page.emit('requestfailed', { url: () => 'https://api.hyperzod.app/store/v1/cart', method: () => 'GET', failure: () => ({ errorText: 'Load request cancelled' }) });
    assert.equal(capture.cancelledRequests.length, 2);
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
    page.emit('response', { url: () => 'https://api.hyperzod.app/store/v1/cart', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ method: () => 'POST', url: () => 'https://api.hyperzod.app/store/v1/cart' }), json: () => new Promise((resolve) => { complete = resolve; }) });
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
    page.emit('response', { url: () => 'https://api.hyperzod.app/store/v1/cart', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => ({ method: () => 'GET', url: () => 'https://api.hyperzod.app/store/v1/cart' }), json: () => new Promise(() => {}) });
    await capture.finish();
    assert.match(capture.failedRequests[0], /diagnostics are incomplete/);
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});
