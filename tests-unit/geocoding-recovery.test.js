const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startCapture, confirmGeocodingRecovery } = require('../utils/reporting');
const { assessDiagnostics } = require('../utils/diagnostics');
const { queryHash, coordinateHash, backendQuery, mapboxQuery, featureHashes } = require('../utils/geocoding-recovery');
const origin = 'https://automations-store.hyperzod.me';
const primary = 'https://api.hyperzod.app/store/v1/places/search?q=Indore&tenant_id=9175';
const fallback = 'https://api.mapbox.com/geocoding/v5/mapbox.places/Indore.json?access_token=fixture-provider-secret';
const features = { type: 'FeatureCollection', features: [{ type: 'Feature', place_name: 'Indore, India', center: [75.85, 22.72], geometry: { type: 'Point', coordinates: [75.85, 22.72] } }] };

async function scenario(options = {}) {
  const previous = process.env.BASE_URL;
  process.env.BASE_URL = origin;
  try {
    const page = new EventEmitter();
    page.url = () => origin + (options.route || '/en/home');
    page.evaluate = async () => options.selection || { selected: [75.85, 22.72], persisted: [75.85, 22.72] };
    const capture = startCapture(page);
    const respond = async (url, body, method = 'GET', status = 200) => {
      const request = { url: () => url, method: () => method, resourceType: () => 'fetch' };
      page.emit('request', request);
      page.emit('response', { url: request.url, request: () => request, status: () => status, headers: () => ({ 'content-type': 'application/json' }), json: async () => body });
      page.emit('requestfinished', request);
      await capture.drain(true);
    };
    if (options.providerFirst) await respond(fallback, features);
    await respond(primary, { success: false, message: options.message || 'Gmap api key not set for tenant-9175' });
    if (!options.providerFirst) await respond(options.url || fallback, options.features || features, options.method || 'GET', options.status || 200);
    if (options.navigate) await page.goto?.('/en/other');
    if (options.newDocument) page.emit('request', { resourceType: () => 'document', frame: () => undefined });
    const confirmed = options.noConfirmation ? false : await confirmGeocodingRecovery(page, 'Indore');
    if (options.orderFailure) await respond('https://api.hyperzod.app/store/v1/order', {}, 'POST', 503);
    await capture.finish();
    return { capture, confirmed, outcome: assessDiagnostics(capture, { page, dependencies: ['geocoding'] }) };
  } finally { if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous; }
}

test('only same-query successful Mapbox data plus matching selected and persisted location recovers the Google-key error', async () => {
  const { capture, confirmed, outcome } = await scenario();
  assert.equal(confirmed, true);
  assert.equal(outcome.critical.length, 0);
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0].message, /Gmap api key/);
  assert.equal(capture.geocodingRecoveries.length, 1);
  const serialized = JSON.stringify(capture);
  for (const secret of ['fixture-provider-secret', '75.85', '22.72']) assert.ok(!serialized.includes(secret));
});

test('missing, unsuccessful, unrelated or stale fallback proof keeps geocoding failures critical', async () => {
  for (const options of [
    { features: { type: 'FeatureCollection', features: [] } }, { status: 401 }, { status: 500 },
    { url: fallback.replace('Indore', 'Mumbai') }, { url: fallback.replace('api.mapbox.com', 'api.mapbox.com.evil.invalid') },
    { method: 'POST' }, { providerFirst: true }, { newDocument: true }, { noConfirmation: true },
    { selection: { selected: [70, 20], persisted: [70, 20] } },
    { selection: { selected: [75.85, 22.72], persisted: [70, 20] } }, { route: '/en/welcome' },
  ]) {
    const result = await scenario(options);
    assert.ok(result.outcome.critical.some(event => /Gmap api key/.test(event.message)), JSON.stringify(options));
  }
});

test('a valid location recovery never suppresses different application errors or order mutations', async () => {
  assert.equal((await scenario({ message: 'Places permission denied' })).outcome.critical.length, 1);
  const { outcome } = await scenario({ orderFailure: true });
  assert.equal(outcome.warnings.length, 1);
  assert.ok(outcome.critical.some(event => event.method === 'POST' && event.url.endsWith('/store/v1/order')));
});

test('geocoding correlation accepts only documented hosts, methods, queries and valid point features', () => {
  assert.equal(backendQuery(primary, 'GET'), queryHash(' indore '));
  assert.equal(mapboxQuery(fallback), queryHash('Indore'));
  for (const url of [fallback.replace('Indore', '75.85,22.72'), fallback.replace('https:', 'http:'), fallback.replace('api.mapbox.com', 'evil.invalid')]) assert.equal(mapboxQuery(url), null);
  assert.equal(backendQuery(primary, 'POST'), null);
  assert.equal(backendQuery(primary.replace('api.hyperzod.app', 'other.invalid'), 'GET'), null);
  assert.equal(coordinateHash([181, 20]), null);
  assert.equal(coordinateHash([20, 91]), null);
  assert.equal(coordinateHash([NaN, 20]), null);
  assert.equal(featureHashes(features).length, 1);
  assert.equal(featureHashes({ features: features.features }).length, 0);
  assert.equal(featureHashes({ type: 'FeatureCollection', features: [{ ...features.features[0], center: [Infinity, 20] }] }).length, 0);
});
