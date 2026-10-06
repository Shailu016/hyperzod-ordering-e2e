const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./policy');
function firstParty(url) {
  const host = new URL(url).hostname;
  return host === new URL(process.env.BASE_URL).hostname || /(^|\.)hyperzod\.(app|me|dev)$/.test(host);
}
function startCapture(page, { drainTimeoutMs = 5_000 } = {}) {
  const capture = { consoleErrors: [], pageErrors: [], failedRequests: [], cancelledRequests: [] };
  const pending = new Set();
  const listeners = [];
  const listen = (event, handler) => { page.on(event, handler); listeners.push([event, handler]); };
  const push = (key, value) => { if (capture[key].length < 100) capture[key].push(redact(value).slice(0, 600)); };
  listen('console', (msg) => { if (msg.type() === 'error') push('consoleErrors', msg.text()); });
  listen('pageerror', (error) => push('pageErrors', error.message));
  listen('requestfailed', (request) => {
    if (firstParty(request.url())) {
      const failure = request.failure()?.errorText || 'unknown';
      push(/ERR_ABORTED|ERR_CANCELED/.test(failure) ? 'cancelledRequests' : 'failedRequests', `TRANSPORT ${request.method()} ${request.url()} ${failure}`);
    }
  });
  listen('response', (response) => {
    if (!firstParty(response.url())) return;
    const status = response.status();
    if (status >= 400) push('failedRequests', `${status} ${response.request().method()} ${response.url()}`);
    if (status === 200 && /\/auth\/v1\/|\/store\/v1\//.test(response.url()) && /json/i.test(response.headers()['content-type'] || '')) {
      const task = (async () => {
        try {
          const body = await response.json();
          if (body.success === false) push('failedRequests', `APPLICATION ${response.request().method()} ${response.url()} ${JSON.stringify(body.message || {})}`);
        } catch { push('failedRequests', `APPLICATION could not inspect JSON response ${response.url()}`); }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    }
  });
  let finished;
  capture.finish = () => {
    if (finished) return finished;
    for (const [event, handler] of listeners) page.removeListener(event, handler);
    finished = (async () => {
      let timer;
      try {
        const drained = await Promise.race([
          Promise.all([...pending]).then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), drainTimeoutMs); }),
        ]);
        if (!drained) push('failedRequests', 'APPLICATION response inspection timed out; diagnostics are incomplete');
      } finally { clearTimeout(timer); }
    })();
    return finished;
  };
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
