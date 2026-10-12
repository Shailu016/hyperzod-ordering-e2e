const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startCapture, settlePageRequests } = require('../utils/reporting');
const { assessDiagnostics } = require('../utils/diagnostics');
const { summarizeReports } = require('../scripts/summarize');

test('navigation waits for an active API response and retains its application error', async () => {
  const prior = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter(); let navigated = false;
    page.goto = async () => { navigated = true; };
    const capture = startCapture(page);
    const request = { method: () => 'GET', url: () => 'https://api.hyperzod.app/auth/v1/me', resourceType: () => 'xhr' };
    page.emit('request', request);
    const navigation = page.goto('/next');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(navigated, false);
    page.emit('response', { url: request.url, request: () => request, status: () => 200, headers: () => ({ 'content-type': 'application/json' }), json: async () => ({ success: false, message: 'Invalid session' }) });
    page.emit('requestfinished', request);
    await navigation; await capture.finish();
    assert.equal(navigated, true);
    assert.match(assessDiagnostics(capture).critical[0].message, /Invalid session/);
  } finally { if (prior === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prior; }
});

test('an unresolved mutation blocks navigation and leaves incomplete evidence', async () => {
  const prior = process.env.BASE_URL;
  process.env.BASE_URL = 'https://automations-store.hyperzod.me';
  try {
    const page = new EventEmitter(); let navigated = false;
    page.goto = async () => { navigated = true; };
    const capture = startCapture(page, { navigationDrainTimeoutMs: 10 });
    const request = { method: () => 'POST', url: () => 'https://api.hyperzod.app/store/v1/cart', resourceType: () => 'xhr' };
    page.emit('request', request);
    await assert.rejects(page.goto('/next'), /Navigation blocked/);
    assert.equal(navigated, false);
    await assert.rejects(settlePageRequests(page, 10), /did not settle/);
    page.emit('requestfinished', request);
    await capture.finish();
    assert.ok(assessDiagnostics(capture).critical.some(event => event.kind === 'inspection'));
  } finally { if (prior === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prior; }
});

const coupon = { kind: 'cancelled', method: 'GET', navigationDiscarded: true, url: 'https://api.hyperzod.app/store/v1/promotional/coupons/available', key: 'coupon-query', sequence: 55, message: 'Load request cancelled' };
const consoleEvent = { kind: 'console', sequence: 56, url: 'https://browser.sentry-cdn.com/bundle.js', message: 'listAvailableCoupons response {data: undefined}' };
const assess = (events, options = {}, successfulReads = {}) => assessDiagnostics({ events, successfulReads }, options);

test('the exact coupon console echo needs an immediately preceding navigation cancellation', () => {
  assert.equal(assess([coupon, consoleEvent]).critical.length, 0);
  for (const changed of [
    { ...coupon, navigationDiscarded: false }, { ...coupon, kind: 'http', status: 500 },
    { ...coupon, kind: 'application' }, { ...coupon, method: 'POST' },
    { ...coupon, sequence: 50 }, { ...coupon, url: 'https://api.hyperzod.app/store/v1/cart' },
  ]) assert.ok(assess([changed, consoleEvent]).critical.includes(consoleEvent));
  assert.equal(assess([consoleEvent]).critical.length, 1);
  assert.equal(assess([coupon, consoleEvent], { dependencies: ['coupons'] }).critical.length, 1);
  assert.equal(assess([coupon, { ...consoleEvent, message: 'listAvailableCoupons response {data: {success: false}}' }]).critical.length, 1);
});

test('cancelled reads recover only through a later successful identical request', () => {
  const cancelled = { ...coupon, navigationDiscarded: false };
  assert.equal(assess([cancelled], {}, { 'coupon-query': 57 }).critical.length, 0);
  assert.equal(assess([cancelled], {}, { 'coupon-query': 54 }).critical.length, 1);
  assert.equal(assess([cancelled], {}, { 'another-query': 57 }).critical.length, 1);
  assert.equal(assess([{ ...cancelled, method: 'POST', url: 'https://api.hyperzod.app/store/v1/order' }], {}, { 'coupon-query': 57 }).critical.length, 1);
  assert.equal(assess([{ ...cancelled, kind: 'application' }], {}, { 'coupon-query': 57 }).critical.length, 1);
});

test('unexplained CORS, logout failures and application TypeErrors remain critical', () => {
  for (const message of ['/api.hyperzod.app/auth/v1/logout due to access control checks.', 'this.getLoggedInUser is not a function', "undefined is not an object (evaluating 'e.coords.latitude')"]) {
    const event = { kind: 'page', sequence: 56, url: 'https://api.hyperzod.app/auth/v1/logout', message };
    assert.ok(assess([coupon, event]).critical.includes(event));
  }
});

test('background diagnostics cannot replace accessibility, navigation or infrastructure failures in summaries', () => {
  for (const message of ['accessibility violations: button-name', 'TimeoutError: page.waitForURL', 'Test timeout: local execution interrupted']) {
    const report = { suites: [{ specs: [{ title: 'scenario', tests: [{ status: 'unexpected', results: [{ status: 'failed', errors: [{ message }], attachments: [{ name: 'api-diagnostics', body: Buffer.from(JSON.stringify({ critical: [{ message: 'coupon read cancelled' }] })).toString('base64') }] }] }] }] }] };
    const result = summarizeReports({ expectedProjects: ['web'] }, [{ project: 'web', report: 'report', exitCode: 1 }], () => JSON.stringify(report));
    assert.equal(result.failedTests[0].error, message);
  }
});
