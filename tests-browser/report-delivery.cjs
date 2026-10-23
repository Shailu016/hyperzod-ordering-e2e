/* Offline integration: real Playwright failure media, no storefront or webhook. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, webkit } = require('@playwright/test');

test('public reports preserve native reports, screenshots, playable videos and Slack links', { timeout: 180_000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ordering-report-delivery-'));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const input = path.join(temporary, 'input');
  const runId = '123-local-fixture';
  const source = { id: 123, run_attempt: 1, run_number: 1, head_sha: 'a'.repeat(40), conclusion: 'failure' };
  let server;
  const browsers = [];
  try {
    fs.mkdirSync(input, { recursive: true });
    const spec = path.join(temporary, 'controlled.spec.cjs');
    fs.writeFileSync(spec, `const {test,expect}=require(${JSON.stringify(require.resolve('@playwright/test'))});
      test('Controlled local fixture: checkout assertion',async({page})=>{
        await page.route('**/*',route=>route.abort());
        await page.setContent('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:20px system-ui;background:#f4f6fa;padding:24px"><h1>Controlled local fixture</h1><p>Report delivery test only. No storefront connection.</p><h2>Order preview</h2><p>Example basket: 2 items</p><button>Continue checkout</button><p id="status">Payment required</p></body></html>');
        // Keep the controlled failure visible long enough to record decoded frames
        // on fast Linux runners as well as desktop machines.
        await expect(page.locator('#status')).toHaveText('Checkout complete',{timeout:2000});
      });`);
    const config = path.join(temporary, 'fixture.config.cjs');
    fs.writeFileSync(config, `const {devices}=require(${JSON.stringify(require.resolve('@playwright/test'))});
      const path=require('node:path'); const device=process.env.REPORT_FIXTURE_DEVICE;
      const output=path.join(${JSON.stringify(input)},${JSON.stringify(runId)},device);
      module.exports={testDir:__dirname,testMatch:'controlled.spec.cjs',workers:1,retries:0,
        outputDir:path.join(output,'artifacts'),
        reporter:[['html',{open:'never',outputFolder:path.join(output,'html')}],['json',{outputFile:path.join(output,'report.json')}]],
        use:{screenshot:'only-on-failure',video:'retain-on-failure',trace:'off'},
        projects:[{name:device,use:{...devices[device==='ios'?'iPhone 14':device==='android'?'Pixel 7':'Desktop Chrome']}}]};`);
    const projects = [];
    const failedTests = [];
    for (const device of ['web', 'android', 'ios']) {
      let exit = 0;
      try {
        execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '-c', config], {
          cwd: temporary, env: { ...process.env, REPORT_FIXTURE_DEVICE: device, E2E_NOTIFICATIONS_DISABLED: 'true', PW_TEST_HTML_REPORT_OPEN: 'never' }, stdio: 'pipe', timeout: 45_000,
        });
      } catch (error) { exit = error.status; }
      assert.equal(exit, 1, 'controlled assertion must fail and produce real evidence');
      const report = JSON.parse(fs.readFileSync(path.join(input, runId, device, 'report.json'), 'utf8'));
      assert.equal(report.stats.unexpected, 1);
      const counts = { passed: report.stats.expected, failed: report.stats.unexpected, skipped: report.stats.skipped, flaky: report.stats.flaky, notRun: 0 };
      projects.push({ project: device, status: 'failed', counts, critical: {} });
      failedTests.push({ project: device, title: 'Controlled local fixture: checkout assertion', error: 'Controlled assertion: expected Checkout complete; received Payment required.' });
    }
    const finished = new Date().toISOString();
    const summary = { runId, suite: 'controlled local fixture', status: 'failed', startedAt: finished, finishedAt: finished,
      counts: { passed: 0, failed: 3, skipped: 0, flaky: 0, notRun: 0 }, projects, failedTests };
    const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
    json(path.join(input, 'summary.json'), summary);
    json(path.join(input, 'source.json'), source);
    const sourceFile = path.join(temporary, 'source.json');
    json(sourceFile, source);
    const prepared = path.join(temporary, 'prepared');
    const site = path.join(temporary, 'site');
    const execute = (...args) => execFileSync(python, args, { cwd: root, stdio: 'pipe', timeout: 20_000 });
    execute('scripts/report_site.py', 'prepare', '--input', input, '--output', prepared, '--source', sourceFile);
    execute('scripts/report_site.py', 'assemble', '--bundles', path.join(prepared, 'bundle'), '--output', site);
    const metadata = JSON.parse(fs.readFileSync(path.join(prepared, 'publication.json'), 'utf8'));
    assert.equal(metadata.failures.length, 3);
    const context = { GITHUB_REPOSITORY: 'Shailu016/hyperzod-ordering-e2e', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: source.head_sha,
      E2E_REPORT_PUBLISH_STATUS: 'success', E2E_REPORT_BASE_URL: 'https://reports.example.invalid/', E2E_PUBLICATION_FILE: path.join(prepared, 'publication.json') };
    const contextFile = path.join(temporary, 'context.json');
    json(contextFile, context);
    execute('scripts/preview-slack.py', path.join(site, 'slack-preview.html'), path.join(input, 'summary.json'), contextFile);
    const pendingContextFile = path.join(temporary, 'pending-context.json');
    json(pendingContextFile, { ...context, E2E_REPORT_PUBLISHER: 'true', E2E_REPORT_PUBLISH_STATUS: 'failure',
      E2E_REPORT_DEPLOY_STATUS: 'success', E2E_REPORT_VERIFY_STATUS: 'pending',
      E2E_REPORT_ARTIFACT_STATUS: 'success', E2E_REPORT_ARTIFACT_RUN_ID: '888' });
    execute('scripts/preview-slack.py', path.join(site, 'slack-pending.html'), path.join(input, 'summary.json'), pendingContextFile);
    const mime = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webm': 'video/webm', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
    server = http.createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = path.resolve(site, '.' + pathname);
      if (!file.startsWith(site + path.sep)) { response.writeHead(403).end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
      const size = fs.statSync(file).size;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || end < start) { response.writeHead(416).end(); return; }
      response.writeHead(range ? 206 : 200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      const stream = fs.createReadStream(file, { start, end });
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    // Remap URLs in the local preview only. The real payload retains HTTPS Pages URLs.
    const localPreview = path.join(site, 'slack-preview.html');
    fs.writeFileSync(localPreview, fs.readFileSync(localPreview, 'utf8').replaceAll('https://reports.example.invalid', base));
    const pendingPreview = path.join(site, 'slack-pending.html');
    fs.writeFileSync(pendingPreview, fs.readFileSync(pendingPreview, 'utf8').replaceAll('https://reports.example.invalid', base));
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch();
      browsers.push(browser);
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(10_000);
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith(base + '/')) return route.continue();
        return route.abort();
      });
      await page.goto(base + '/runs/123-1/');
      assert.equal(await page.getByRole('link', { name: 'Open Playwright report' }).count(), 3);
      for (const failure of metadata.failures) {
        console.log(engine.name() + ': validating ' + failure.project + ' screenshot and video');
        await page.goto(base + '/runs/123-1/' + failure.path, { waitUntil: 'domcontentloaded' });
        await page.locator('img').waitFor();
        await page.waitForFunction(() => document.querySelector('img').naturalWidth > 0);
        // Exercise the visible player with a user gesture. WebKit may suspend
        // playback when a muted video remains below the screenshot/off screen.
        await page.locator('video').scrollIntoViewIfNeeded();
        await page.locator('video').click({ position: { x: 5, y: 5 } });
        // Windows WebKit also stalls on the original raw WebM. Verify its
        // explicit download fallback; Chromium and Linux WebKit must play it.
        if (!(process.platform === 'win32' && engine === webkit)) {
          await page.locator('video').evaluate((video) => new Promise((resolve, reject) => {
            const cleanup = () => {
              clearTimeout(timer);
              video.removeEventListener('timeupdate', progressed);
              video.removeEventListener('playing', progressed);
            };
            const progressed = () => {
              if (video.currentTime > 0 && video.readyState >= 2) { cleanup(); resolve(); }
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error('No decoded playback progress: ' + JSON.stringify({ state: video.readyState, time: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended, visibility: document.visibilityState, error: video.error?.message })));
            }, 8000);
            // Observe progress before play: a short recording can finish before
            // a later polling assertion begins in WebKit.
            video.addEventListener('timeupdate', progressed);
            video.addEventListener('playing', progressed);
            video.muted = true;
            video.play().catch((error) => { cleanup(); reject(error); });
          }));
        }
        const downloadEvent = page.waitForEvent('download');
        await page.getByRole('link', { name: 'Download video', exact: true }).click();
        const download = await downloadEvent;
        assert.equal(await download.failure(), null);
        assert.deepEqual(fs.readFileSync(await download.path()), fs.readFileSync(path.join(site, 'runs', '123-1', failure.video)));
      }
      await page.goto(base + '/runs/123-1/devices/ios/#?q=s:failed');
      await page.getByText('Controlled local fixture: checkout assertion', { exact: true }).first().waitFor();
      await page.goto(base + '/slack-preview.html');
      assert.equal(await page.getByRole('link', { name: 'Open full report', exact: true }).count(), 1);
      assert.equal(await page.getByRole('link', { name: 'Watch video', exact: true }).count(), 3);
      await page.waitForFunction(() => [...document.querySelectorAll('img')].length === 2 && [...document.querySelectorAll('img')].every((image) => image.naturalWidth > 0));
      await page.getByRole('link', { name: 'Open full report', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/runs/123-1/');
      await page.goto(base + '/slack-preview.html');
      if (process.env.E2E_REPORT_PREVIEW_DIR && engine === chromium) {
        const preview = path.resolve(process.env.E2E_REPORT_PREVIEW_DIR);
        fs.mkdirSync(preview, { recursive: true });
        await page.screenshot({ path: path.join(preview, 'slack-preview.png'), fullPage: true });
        await page.goto(base + '/runs/123-1/' + metadata.failures[2].path, { waitUntil: 'domcontentloaded' });
        await page.screenshot({ path: path.join(preview, 'failure-page.png'), fullPage: true });
        fs.cpSync(site, path.join(preview, 'site'), { recursive: true });
      }
      await page.goto(base + '/slack-pending.html');
      assert.equal(await page.getByRole('link', { name: 'Open report (verification pending)', exact: true }).count(), 1);
      assert.equal(await page.getByRole('link', { name: 'Saved report & media', exact: true }).getAttribute('href'), 'https://github.com/Shailu016/hyperzod-ordering-e2e/actions/runs/888#artifacts');
      assert.equal(await page.locator('img').count(), 0);
      assert.match(await page.locator('h2').innerText(), /Failed$/);
      await page.getByRole('link', { name: 'Open report (verification pending)', exact: true }).click();
      assert.equal(new URL(page.url()).pathname, '/runs/123-1/');
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
    }
  } finally {
    for (const browser of browsers) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('ordering-report-delivery-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
