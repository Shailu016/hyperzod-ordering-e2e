// Real browser regression checks; loopback only, no storefront or Slack.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium, webkit } = require('@playwright/test');
const { startCapture } = require('../utils/reporting');
const { assessDiagnostics } = require('../utils/diagnostics');

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: settled navigation preserves genuine failures without cancelling startup reads`, { timeout: 60_000 }, async () => {
    const sockets = new Set();
    const server = http.createServer((request, response) => {
      if (request.url.startsWith('/auth/v1/me')) {
        setTimeout(() => {
          response.writeHead(request.url.includes('outage') ? 503 : 200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ success: !request.url.includes('outage'), data: { id: 7 } }));
        }, 200);
      } else if (request.url.startsWith('/one')) {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        const mode = request.url.includes('outage') ? '?outage' : '';
        response.end(`<html><body>Ready<script>fetch('/auth/v1/me${mode}').then(r=>r.json()).then(data=>window.loaded=data);</script></body></html>`);
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html><body>Destination</body></html>');
      }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const prior = process.env.BASE_URL;
    process.env.BASE_URL = origin;
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      for (const mode of ['', '?outage']) {
        const page = await browser.newPage();
        await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const capture = startCapture(page);
        const started = page.waitForRequest(request => request.url().includes('/auth/v1/me'));
        await page.goto(origin + '/one' + mode, { waitUntil: 'domcontentloaded' });
        await started;
        // Intentionally navigate immediately, before the delayed API response.
        await page.goto(origin + '/two', { waitUntil: 'domcontentloaded' });
        await capture.finish();
        assert.equal(capture.events.filter(event => event.kind === 'cancelled').length, 0);
        const outcome = assessDiagnostics(capture);
        if (mode) assert.ok(outcome.critical.some(event => event.kind === 'http' && event.status === 503));
        else assert.equal(outcome.critical.length, 0);
        await page.close();
      }
      const page = await browser.newPage();
      const capture = startCapture(page);
      await page.goto(origin + '/two');
      await page.evaluate(() => new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/auth/v1/me');
        xhr.addEventListener('abort', () => { console.error('listAvailableCoupons response {data: undefined}'); resolve(); });
        xhr.send(); setTimeout(() => xhr.abort(), 50);
      }));
      await capture.finish();
      assert.ok(assessDiagnostics(capture).critical.some(event => event.kind === 'cancelled' && !event.navigationDiscarded));
      assert.ok(assessDiagnostics(capture).critical.some(event => event.kind === 'console'));
      await page.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        if (prior === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prior;
      }
    }
  });
}

// The real location helper must prove the deployed provider fallback, not just hide a log.
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(name + ': location fallback requires matching provider results and persisted selection', { timeout: 90_000 }, async () => {
    let mode = 'recovered';
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<html><body><div id="app"><header>Fixture store</header><div id="WelcomePage"><input id="search"><div class="search-results"><div class="results-list"></div></div></div></div>
      <script>
        let selected = null;
        document.querySelector('#app').__vue_app__ = { config: { globalProperties: { $store: { getters: { get getSelectedLocation() { return selected; } } } } } };
        let timer;
        document.querySelector('#search').addEventListener('keyup', () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const query = document.querySelector('#search').value;
            if (query.length < 3) return;
            const primary = await fetch('https://api.hyperzod.app/store/v1/places/search?q=' + encodeURIComponent(query)).then(r => r.json());
            if (primary.success !== false) throw new Error('Expected controlled backend failure');
            const fallbackQuery = ${JSON.stringify(mode === 'wrong-query' ? 'Mumbai' : 'Indore')};
            const body = await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + fallbackQuery + '.json?access_token=fixture-token-not-real').then(r => r.json());
            const feature = body.features[0];
            const button = document.createElement('button');
            button.className = 'tw-cursor-pointer'; button.textContent = feature.place_name;
            button.onclick = () => {
              selected = { address: feature.place_name, location: { longitude: feature.center[0], latitude: feature.center[1] } };
              localStorage.setItem('location', JSON.stringify(selected));
              history.pushState({}, '', '/en/home');
              document.querySelector('#WelcomePage').outerHTML = '<div id="MultiVendorHome">Indore fixture merchants</div>';
            };
            document.querySelector('.results-list').replaceChildren(button);
          }, 150);
        });
      </script></body></html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const previous = process.env.BASE_URL, previousQuery = process.env.TEST_LOCATION_QUERY;
    process.env.BASE_URL = origin; process.env.TEST_LOCATION_QUERY = 'Indore';
    let browser;
    try {
      const { ensureLocation } = require('../utils/app');
      browser = await engine.launch();
      for (mode of ['recovered', 'wrong-query', 'order-failure']) {
        const context = await browser.newContext({ baseURL: origin });
        const page = await context.newPage();
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
          if (url.origin === 'https://api.hyperzod.app' && url.pathname === '/store/v1/places/search') {
            return route.fulfill({ status: 200, headers, body: JSON.stringify({ success: false, message: 'Gmap api key not set for tenant-9175' }) });
          }
          if (url.origin === 'https://api.hyperzod.app' && url.pathname === '/store/v1/order') return route.fulfill({ status: 503, headers, body: '{}' });
          if (url.origin === 'https://api.mapbox.com' && url.pathname.startsWith('/geocoding/v5/mapbox.places/')) {
            return route.fulfill({ status: 200, headers, body: JSON.stringify({ type: 'FeatureCollection', features: [{ id: 'place.fixture', type: 'Feature', place_name: 'Indore, India', center: [75.85, 22.72], geometry: { type: 'Point', coordinates: [75.85, 22.72] } }] }) });
          }
          return route.abort();
        });
        const capture = startCapture(page);
        await ensureLocation(page);
        assert.ok(page.url().endsWith('/en/home'));
        if (mode === 'order-failure') await page.evaluate(() => fetch('https://api.hyperzod.app/store/v1/order', { method: 'POST' }));
        await capture.finish();
        const outcome = assessDiagnostics(capture, { page, dependencies: ['geocoding'] });
        if (mode === 'wrong-query') {
          assert.ok(outcome.critical.some(event => /Gmap api key/.test(event.message)));
          assert.equal(capture.geocodingRecoveries.length, 0);
        } else {
          assert.equal(outcome.warnings.filter(event => /Gmap api key/.test(event.message)).length, 1);
          if (mode === 'order-failure') assert.ok(outcome.critical.some(event => event.url.endsWith('/store/v1/order')));
          else assert.equal(outcome.critical.length, 0);
          assert.equal(capture.geocodingRecoveries.length, 1);
        }
        assert.ok(!JSON.stringify(capture).includes('fixture-token-not-real'));
        console.log(name + ': ' + mode + ' checked');
        await context.close();
      }
    } finally {
      await browser?.close();
      await new Promise(resolve => server.close(resolve));
      if (previous === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previous;
      if (previousQuery === undefined) delete process.env.TEST_LOCATION_QUERY; else process.env.TEST_LOCATION_QUERY = previousQuery;
    }
  });
}
