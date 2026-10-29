/* Loopback regression for the observed location drawer covering Login. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium, webkit } = require('@playwright/test');
const { dismissSettledLocationDrawer } = require('../utils/location-readiness');

function fixture(mode) {
  const mobile = mode === 'mobile';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0}header{padding:20px;text-align:right}#LoginBtn{padding:12px}
    .location-overlay{position:fixed;inset:0;background:#0008;z-index:9}
    .drawer{position:fixed;inset:0 auto 0 0;width:80%;max-width:480px;background:white;z-index:10}
    .v-card-title{display:flex;justify-content:space-between;padding:15px}.v-card-title button{padding:12px}
    #loginEmailOrNumber{position:fixed;top:100px;right:20px}</style></head><body>
    <header><button id="LoginBtn">Login</button></header><input id="loginEmailOrNumber" hidden>
    <div class="location-overlay"></div>
    <nav id="stale" class="drawer location-panel v-navigation-drawer--active" style="display:none">
      <div class="v-card-title"><span>Search for your location</span><button id="closeBtn">Close stale twin</button></div>
    </nav>
    <nav id="active" class="drawer ${mobile ? 'v-bottom-sheet v-overlay--active' : 'location-panel v-navigation-drawer--active'}">
      <div class="v-card-title"><span>Search for your location</span><button ${mobile ? '' : 'id="closeBtn"'}>Close</button></div>
      <input placeholder="Search for area or street name"><p>Indore Active</p>
      <section><div class="v-card-title"><span>Edit Address</span><button id="nested-close">Close nested editor</button></div></section>
    </nav>
    <script>
      window.closeClicks=0;window.loginClicks=0;window.nestedCloseClicks=0;
      localStorage.clear();
      ${mode !== 'no-location' ? `localStorage.setItem('location',JSON.stringify({id:'fixture-location',label:'Indore'}));` : ''}
      // The actual custom drawer does not close through Escape.
      document.addEventListener('keydown',event=>{if(event.key==='Escape')event.preventDefault()});
      document.querySelector('#active .v-card-title button').onclick=()=>{
        window.closeClicks++;
        ${mode === 'broken' ? '' : `document.querySelector('#active').classList.remove('v-navigation-drawer--active','v-overlay--active');
        document.querySelector('#active').style.${mode === 'offscreen' ? "transform='translateX(-110%)'" : "display='none'"};document.querySelector('.location-overlay').style.display='none';`}
      };
      document.querySelector('#stale button').onclick=()=>{throw Error('Hidden drawer must never be clicked')};
      document.querySelector('#nested-close').onclick=()=>{window.nestedCloseClicks++};
      document.querySelector('#LoginBtn').onclick=()=>{window.loginClicks++;document.querySelector('#loginEmailOrNumber').hidden=false};
    </script></body></html>`;
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: settled location drawers close through their UI before Login; unresolved drawers fail safely`, { timeout: 60_000 }, async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(fixture(new URL(request.url, 'http://127.0.0.1').searchParams.get('mode')));
    });
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const priorBase = process.env.BASE_URL;
    const priorAllowed = process.env.E2E_ALLOWED_ORIGINS;
    process.env.BASE_URL = origin;
    process.env.E2E_ALLOWED_ORIGINS = origin;
    const { ensureLocation, openAuthPanel, gotoWithRetry } = require('../utils/app');
    let browser;
    try {
      browser = await engine.launch({ headless: true });
      for (const mode of ['desktop', 'mobile', 'offscreen', 'no-location', 'broken']) {
        const page = await browser.newPage({ viewport: mode === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
        await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(origin + '/en/home?mode=' + mode);
        const selected = () => page.evaluate(() => localStorage.getItem('location'));
        const before = await selected();
        const hasLocation = async () => !!(await selected());
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#active').isVisible(), true);
        if (mode === 'broken') {
          await assert.rejects(dismissSettledLocationDrawer(page, hasLocation, { timeout: 2000 }));
          assert.equal(await page.evaluate(() => window.closeClicks), 1, 'the close UI was exercised but did not dismiss its drawer');
          assert.equal(await page.locator('#active').isVisible(), true);
          assert.equal(await page.evaluate(() => window.loginClicks), 0);
        } else if (mode === 'no-location') {
          assert.equal(await dismissSettledLocationDrawer(page, hasLocation, { timeout: 1000 }), false);
          assert.equal(await page.locator('#active').isVisible(), true);
          assert.equal(await page.evaluate(() => window.closeClicks), 0);
        } else {
          assert.equal(await dismissSettledLocationDrawer(page, hasLocation, { timeout: 5000 }), true);
          assert.equal(await page.locator('#active').isVisible(), mode === 'offscreen');
          await page.locator('#LoginBtn').click({ timeout: 5000 });
          assert.equal(await page.locator('#loginEmailOrNumber').isVisible(), true);
          assert.equal(await page.evaluate(() => window.closeClicks), 1);
          assert.equal(await dismissSettledLocationDrawer(page, hasLocation, { timeout: 1000 }), false);
          // Exercise the actual cached-location fast path, not just the new
          // helper. Before this repair ensureLocation returned with the drawer
          // still covering Login and openAuthPanel swallowed its click failure.
          await page.goto(origin + '/en/home?mode=' + mode);
          let extraDocumentRequests = 0;
          page.on('request', request => { if (request.isNavigationRequest()) extraDocumentRequests++; });
          await ensureLocation(page);
          assert.equal(await page.locator('#active').isVisible(), mode === 'offscreen');
          await openAuthPanel(page);
          assert.equal(await page.locator('#loginEmailOrNumber').isVisible(), true);
          assert.equal(extraDocumentRequests, 0, 'settled location must not trigger another boot/navigation');
          // Later navigations reopen the picker too; readiness belongs at the
          // shared navigation/boot boundary, not just before authentication.
          await gotoWithRetry(page, origin + '/en/home?mode=' + mode);
          assert.equal(await page.evaluate(() => window.closeClicks), 1);
          await page.locator('#LoginBtn').click({ timeout: 5000 });
          assert.equal(await page.locator('#loginEmailOrNumber').isVisible(), true);
        }
        assert.equal(await selected(), before, 'closing an optional drawer must preserve the exact selected location');
        assert.equal(await page.evaluate(() => window.nestedCloseClicks), 0, 'the nested address editor close control must never be selected');
        await page.close();
      }
    } finally {
      if (priorBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = priorBase;
      if (priorAllowed === undefined) delete process.env.E2E_ALLOWED_ORIGINS; else process.env.E2E_ALLOWED_ORIGINS = priorAllowed;
      try { await browser?.close(); }
      finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
    }
  });
}
