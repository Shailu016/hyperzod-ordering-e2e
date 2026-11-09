const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assessDiagnostics, requireDependency } = require('../utils/diagnostics');
const event = (path, extra = {}) => ({ kind: 'http', method: 'GET', status: 500, url: `https://api.hyperzod.app${path}`, key: path, sequence: 1, message: 'request failed', ...extra });
const assess = (events, options, successfulReads = {}) => assessDiagnostics({ events, successfulReads }, options);

test('browser-cancelled images are visible warnings; API reads and broken image responses still fail', () => {
  const image = event('/assets/banner.svg', { kind: 'cancelled', resourceType: 'image' });
  assert.equal(assess([image]).warnings.length, 1);
  for (const resourceType of ['fetch', 'xhr', 'script', 'document', undefined]) {
    assert.equal(assess([{ ...image, resourceType }]).critical.length, 1);
  }
  assert.equal(assess([{ ...image, kind: 'http', status: 404 }]).critical.length, 1);
});

test('known third-party fixture icon failures remain visible warnings without masking store failures', () => {
  const icon = { kind: 'console', url: 'https://www.jiomart.com/assets/ds2web/jds-icons/star-icon.svg', message: 'Failed to load resource: the server responded with a status of 500 ()' };
  assert.equal(assess([icon]).warnings.length, 1);
  // CI Chromium renders the reason phrase; local builds log empty parens.
  assert.equal(assess([{ ...icon, message: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' }]).warnings.length, 1);
  assert.equal(assess([{ ...icon, message: 'Failed to load resource: the server responded with a status of 404 (Not Found)' }]).warnings.length, 1);
  for (const changed of [
    { ...icon, url: 'https://api.hyperzod.app/store/v1/order' },
    { ...icon, url: 'https://www.jiomart.com/assets/ds2web/jds-icons/checkout.js' },
    { ...icon, url: 'https://www.jiomart.com/assets/ds2web/jds-icons/star-icon.png' },
    { ...icon, message: 'TypeError: checkout failed' },
    { ...icon, kind: 'page' },
  ]) assert.equal(assess([changed]).critical.length, 1);
});

test('closing an optional chat socket is a warning, while chat dependencies and other sockets remain critical', () => {
  const closing = { kind: 'console', url: 'https://browser.sentry-cdn.com/bundle.js', message: "WebSocket connection to 'wss://chat.apps.hyperzod.com/connection/websocket' failed: WebSocket is closed before the connection is established." };
  assert.equal(assess([closing]).warnings.length, 1);
  assert.equal(assess([closing], { dependencies: ['chat'] }).critical.length, 1);
  assert.equal(assess([{ ...closing, message: closing.message.replace('chat.apps.hyperzod.com', 'api.hyperzod.app') }]).critical.length, 1);
  assert.equal(assess([{ ...closing, message: 'Unexpected checkout TypeError' }]).critical.length, 1);
});

test('chat credential reads are optional only on the exact chat host and without a chat dependency', () => {
  const chat = { ...event('/api/v1/embed/notifications/connection', { method: 'POST', status: 401 }), url: 'https://chat.apps.hyperzod.com/api/v1/embed/notifications/connection' };
  const pageError = { kind: 'page', url: chat.url, message: '//chat.apps.hyperzod.com/api/v1/embed/notifications/connection due to access control checks.' };
  assert.equal(assess([chat, pageError]).critical.length, 0);
  assert.equal(assess([pageError]).warnings.length, 1);
  assert.equal(assess([pageError], { dependencies: ['chat'] }).critical.length, 1);
  assert.equal(assess([{ ...pageError, message: 'TypeError in chat notifications' }]).critical.length, 1);
  assert.equal(assess([chat, pageError], { dependencies: ['chat'] }).critical.length, 2);
  assert.equal(assess([{ ...chat, url: 'https://api.hyperzod.app/api/v1/embed/notifications/connection' }]).critical.length, 1);
  assert.equal(assess([{ ...chat, url: 'https://chat.apps.hyperzod.com/api/v1/embed/messages' }]).critical.length, 1);
});

test('an address 401 after successful owned-account deletion requires explicit absence proof and event order', () => {
  const address = event('/store/v1/address', { status: 401, sequence: 9 });
  const capture = { events: [address], successfulReads: {}, successfulAccountDeletions: [{ userId: '123', sequence: 8 }] };
  assert.equal(assessDiagnostics(capture, { deletedUserId: 123 }).critical.length, 0);
  assert.equal(assessDiagnostics(capture).critical.length, 1);
  assert.equal(assessDiagnostics(capture, { deletedUserId: 456 }).critical.length, 1);
  assert.equal(assessDiagnostics({ ...capture, successfulAccountDeletions: [] }, { deletedUserId: 123 }).critical.length, 1);
  assert.equal(assessDiagnostics({ ...capture, events: [{ ...address, sequence: 7 }] }, { deletedUserId: 123 }).critical.length, 1);
  assert.equal(assessDiagnostics({ ...capture, events: [{ ...address, method: 'POST' }] }, { deletedUserId: 123 }).critical.length, 1);
  assert.equal(assessDiagnostics({ ...capture, events: [{ ...address, status: 500 }] }, { deletedUserId: 123 }).critical.length, 1);
});

test('the CMS fallback scenario permits only its exact missing-page business result', () => {
  const missing = event('/store/v1/page', { kind: 'application', status: 200, message: 'APPLICATION GET https://api.hyperzod.app/store/v1/page "Page not found"' });
  assert.equal(assess([missing], { expectedMissingPage: true }).warnings.length, 1);
  assert.equal(assess([missing]).critical.length, 1);
  assert.equal(assess([event('/store/v1/page')], { expectedMissingPage: true }).critical.length, 1);
  assert.equal(assess([{ ...missing, message: 'Server crashed' }], { expectedMissingPage: true }).critical.length, 1);
});
test('optional recommendation and wallet reads are visible warnings; mutations still fail', () => {
  const result = assess([event('/store/v1/recommend/products'), event('/store/v1/wallet/wallet-info')]);
  assert.equal(result.warnings.length, 2); assert.equal(result.critical.length, 0);
  assert.equal(assess([event('/store/v1/wallet/redeem-gift-card', { method: 'POST' })]).critical.length, 1);
  assert.equal(assess([event('/store/v1/order', { method: 'POST' })]).critical.length, 1);
});

test('documented recommendation POST queries are optional only without a feature dependency', () => {
  const events = ['products/merchant', 'products', 'merchants', 'similarItems'].map((path) => event('/store/v1/recommend/' + path, { method: 'POST' }));
  assert.equal(assess(events).warnings.length, 4);
  assert.equal(assess(events, { dependencies: ['recommendations'] }).critical.length, 4);
  assert.equal(assess([event('/store/v1/recommend/unknown', { method: 'POST' })]).critical.length, 1);
});
test('geocoding and wallet dependencies promote errors back to failures', () => {
  const page = {};
  requireDependency(page, 'geocoding');
  assert.equal(assess([event('/store/v1/places/reverseGeocode')], { page }).critical.length, 1);
  assert.equal(assess([event('/store/v1/wallet/wallet-info')], { dependencies: ['wallet'] }).critical.length, 1);
  assert.equal(assess([event('/store/v1/places/reverseGeocode')]).warnings.length, 1);
  assert.equal(assess([event('/store/v1/form-builder/order/delivery', { kind: 'application' })]).warnings.length, 1);
  assert.equal(assess([event('/store/v1/form-builder/order/delivery', { kind: 'application' })], { dependencies: ['orderForms'] }).critical.length, 1);
});
test('transient reads recover only when the same request succeeds later; POST does not', () => {
  const path = '/store/v1/cart';
  assert.equal(assess([event(path)], {}, { [path]: 2 }).warnings.length, 1);
  assert.equal(assess([event(path)], {}, { [path + '?another-cart']: 2 }).critical.length, 1);
  assert.equal(assess([event(path, { method: 'POST' })], {}, { [path]: 2 }).critical.length, 1);
  assert.equal(assess([event(path)], {}, { [path]: 0 }).critical.length, 1);
});
test('cleanup catalog aborts warn only after matching account deletion is proven', () => {
  const makeAbort = (path, sequence, extra = {}) => ({
    kind: 'cancelled', method: 'GET', resourceType: 'xhr', status: undefined,
    navigationDiscarded: false, sequence, url: `https://api.hyperzod.app${path}`, key: path,
    message: `TRANSPORT GET https://api.hyperzod.app${path} net::ERR_ABORTED`, ...extra,
  });
  const capture = {
    events: [
      makeAbort('/store/v1/search/product-category/products', 183),
      makeAbort('/store/v1/merchant/listByIds', 184),
    ],
    successfulReads: {},
    successfulAccountDeletions: [{ userId: '671761', sequence: 293 }],
  };
  const outcome = assessDiagnostics(capture, { deletedUserId: 671761 });
  assert.equal(outcome.critical.length, 0);
  assert.equal(outcome.warnings.length, 2);
  assert.ok(outcome.warnings.every(item => item.diagnosticDisposition === 'cleanup-only-catalog-read-after-proven-deletion'));
  assert.ok(outcome.warnings.every(item => /net::ERR_ABORTED$/.test(item.message)), 'raw cancellation evidence remains visible');
  assert.equal(assess(capture.events).critical.length, 2, 'commerce projects still fail on the same cancellations');
  const consoleOutcome = assessDiagnostics({ ...capture, events: [
    capture.events[0],
    { kind: 'console', url: capture.events[0].url, sequence: 185, message: 'Failed to load resource: net::ERR_ABORTED' },
  ] }, { deletedUserId: 671761 });
  assert.equal(consoleOutcome.critical.length, 0, 'the matching browser network echo follows the same narrow cleanup disposition');

  const unsafe = [
    [{ ...capture, successfulAccountDeletions: [] }, { deletedUserId: 671761 }],
    [capture, { deletedUserId: 123 }],
    [{ ...capture, events: [makeAbort('/store/v1/search/product-category/products', 294)] }, { deletedUserId: 671761 }],
    [{ ...capture, events: [makeAbort('/store/v1/cart', 183)] }, { deletedUserId: 671761 }],
    [{ ...capture, events: [makeAbort('/store/v1/merchant/listByIds', 183, { method: 'POST' })] }, { deletedUserId: 671761 }],
    [{ ...capture, events: [makeAbort('/store/v1/merchant/listByIds', 183, { message: 'TRANSPORT GET https://api.hyperzod.app/store/v1/merchant/listByIds net::ERR_FAILED' })] }, { deletedUserId: 671761 }],
  ];
  for (const [evidence, options] of unsafe) assert.equal(assessDiagnostics(evidence, options).critical.length, evidence.events.length);
});
test('negative login permits expected rejection but keeps auth outages and transport failures red', () => {
  const options = { expectedAuthRejection: true }, path = '/auth/v1/user/login';
  assert.equal(assess([event(path, { method: 'POST', status: 401 })], options).warnings.length, 1);
  assert.equal(assess([event(path, { method: 'POST' })], options).critical.length, 1);
  assert.equal(assess([event(path, { method: 'POST', kind: 'transport' })], options).critical.length, 1);
});
test('CORS/resource console messages deduplicate optional failures without hiding app errors', () => {
  const url = 'https://api.hyperzod.app/store/v1/recommend/products';
  const warning = event('/store/v1/recommend/products', { kind: 'transport' });
  assert.equal(assess([warning, { kind: 'console', url, message: 'Access to fetch blocked by CORS policy' }]).critical.length, 0);
  assert.equal(assess([warning, { kind: 'console', url, message: 'TypeError in checkout' }]).critical.length, 1);
  assert.equal(assess([{ kind: 'console', url: '', message: 'Failed to load resource' }]).critical.length, 1);
  assert.equal(assess([{ kind: 'page', message: 'TypeError' }, { kind: 'inspection', message: 'incomplete' }]).critical.length, 2);
});

test('Safari CORS-shaped page rejections require a proven discarded read or later successful recovery', () => {
  const cancelled = event('/store/v1/merchant/menu', { kind: 'cancelled', navigationDiscarded: true });
  const pageError = { kind: 'page', url: cancelled.url, message: '//api.hyperzod.app/store/v1/merchant/menu due to access control checks.' };
  assert.equal(assess([cancelled, pageError]).critical.length, 0);
  assert.equal(assess([{ ...cancelled, navigationDiscarded: false }, pageError]).critical.length, 2);
  assert.equal(assess([{ ...cancelled, method: 'POST', url: 'https://api.hyperzod.app/store/v1/cart' }, { ...pageError, url: 'https://api.hyperzod.app/store/v1/cart' }]).critical.length, 2);
  assert.equal(assess([cancelled, { ...pageError, message: 'this.getLoggedInUser is not a function' }]).critical.length, 1);
});
