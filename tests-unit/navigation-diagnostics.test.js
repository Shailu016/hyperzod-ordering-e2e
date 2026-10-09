const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startCapture } = require('../utils/reporting');
const { assessDiagnostics } = require('../utils/diagnostics');

test('a main-frame SPA route change proves discarded reads without allowing cancelled cart mutations', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    for (const [method, navigate, expected] of [['GET', true, 0], ['GET', false, 1], ['POST', true, 2]]) {
      const page = new EventEmitter();
      let url = 'https://automations-store.hyperzod.me/en/home';
      const frame = { url: () => url };
      page.url = () => url; page.mainFrame = () => frame;
      const capture = startCapture(page);
      const request = { method: () => method, url: () => 'https://api.hyperzod.app/store/v1/cart', resourceType: () => 'fetch', failure: () => ({ errorText: 'Load request cancelled' }) };
      page.emit('request', request);
      if (navigate) { url = 'https://automations-store.hyperzod.me/en/search'; page.emit('framenavigated', frame); }
      page.emit('requestfailed', request);
      page.emit('pageerror', { message: '/api.hyperzod.app/store/v1/cart due to access control checks.' });
      await capture.finish();
      assert.equal(assessDiagnostics(capture).critical.length, expected);
    }
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});
test('only a proven document-discarded read is downgraded; mutation and malformed JSON stay critical', async () => {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    for (const [method, navigate, message, expected] of [
      ['GET', true, 'No resource with given identifier found', 0],
      ['GET', false, 'No resource with given identifier found', 1],
      ['POST', true, 'No resource with given identifier found', 1],
      ['GET', true, 'Unexpected token in JSON', 1],
    ]) {
      const page = new EventEmitter(), frame = {};
      page.mainFrame = () => frame;
      const capture = startCapture(page);
      const request = { method: () => method, url: () => 'https://api.hyperzod.app/store/v1/cart', resourceType: () => 'fetch' };
      page.emit('request', request);
      if (navigate) page.emit('request', { resourceType: () => 'document', frame: () => frame });
      page.emit('response', { url: request.url, status: () => 200, headers: () => ({ 'content-type': 'application/json' }), request: () => request, json: async () => { throw new Error(message); } });
      page.emit('requestfinished', request);
      await capture.finish();
      assert.equal(assessDiagnostics(capture).critical.length, expected);
    }
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
});
