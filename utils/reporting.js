const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./policy');
function firstParty(url) {
  const host = new URL(url).hostname;
  return host === new URL(process.env.BASE_URL).hostname || /(^|\.)hyperzod\.(app|me|dev)$/.test(host);
}
function startCapture(page) {
  const capture = { consoleErrors: [], pageErrors: [], failedRequests: [], cancelledRequests: [] };
  const push = (key, value) => { if (capture[key].length < 100) capture[key].push(redact(value).slice(0, 600)); };
  page.on('console', (msg) => { if (msg.type() === 'error') push('consoleErrors', msg.text()); });
  page.on('pageerror', (error) => push('pageErrors', error.message));
  page.on('requestfailed', (request) => {
    if (firstParty(request.url())) {
      const failure = request.failure()?.errorText || 'unknown';
      push(/ERR_ABORTED|ERR_CANCELED/.test(failure) ? 'cancelledRequests' : 'failedRequests', `TRANSPORT ${request.method()} ${request.url()} ${failure}`);
    }
  });
  page.on('response', async (response) => {
    if (!firstParty(response.url())) return;
    const status = response.status();
    if (status >= 400) push('failedRequests', `${status} ${response.request().method()} ${response.url()}`);
    if (status === 200 && /\/auth\/v1\/|\/store\/v1\//.test(response.url()) && /json/i.test(response.headers()['content-type'] || '')) {
      try {
        const body = await response.json();
        if (body.success === false) push('failedRequests', `APPLICATION ${response.request().method()} ${response.url()} ${JSON.stringify(body.message || {})}`);
      } catch { /* capture HTTP/transport evidence separately */ }
    }
  });
  return capture;
}
async function visibleToastText(page) { return redact((await page.locator('.v-snackbar__content, #app-snackbar, .alert-message').allInnerTexts()).join(' | ')).slice(0, 400); }
async function reportFailure(testInfo, page, capture, error) {
  try {
    const log = redact(JSON.stringify({ test: testInfo.title, url: page.url(), error: error?.message, ...capture }, null, 2));
    const destination = testInfo.outputPath('console.log');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, log);
    console.log(`Failure: ${testInfo.title}\n${redact(error?.message || 'See evidence')}\nEvidence: ${destination}`);
    await testInfo.attach('console-log', { path: destination, contentType: 'text/plain' });
  } catch { /* do not replace the original test error */ }
}
module.exports = { startCapture, visibleToastText, reportFailure };
