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
