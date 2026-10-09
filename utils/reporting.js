const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('./policy');
const { isReadRequest } = require('./diagnostics');
function safeURL(url) { try { const value = new URL(url); return value.origin + value.pathname; } catch { return ''; } }
function firstParty(url) {
  try { const host = new URL(url).hostname; return host === new URL(process.env.BASE_URL).hostname || host === 'chat.apps.hyperzod.com' || /(^|\.)hyperzod\.(app|me|dev)$/.test(host); }
  catch { return false; }
}
function startCapture(page, { drainTimeoutMs = 5_000 } = {}) {
  const capture = { consoleErrors: [], pageErrors: [], failedRequests: [], cancelledRequests: [], events: [], successfulReads: Object.create(null), successfulAccountDeletions: [] };
  const pending = new Map(), requests = new Map(), listeners = [];
  let closing = false;
  const requestDocuments = new WeakMap();
  const requestNavigations = new WeakMap();
  let documentGeneration = 0;
  let navigationGeneration = 0, mainURL = typeof page.url === 'function' ? page.url() : '';
  let sequence = 0, overflow = false;
  const listen = (event, handler) => { page.on(event, handler); listeners.push([event, handler]); };
  const record = (event) => {
    event.message = redact(event.message).slice(0, 600);
    event.url = redact(safeURL(event.url));
    if (capture.events.length < 100) capture.events.push(event); else overflow = true;
    const key = event.kind === 'console' ? 'consoleErrors' : event.kind === 'page' ? 'pageErrors' : event.kind === 'cancelled' ? 'cancelledRequests' : 'failedRequests';
    if (capture[key].length < 100) capture[key].push(event.message);
  };
  const requestEvent = (request) => ({ method: request.method(), resourceType: request.resourceType?.(), url: request.url(), key: crypto.createHash('sha256').update(`${request.method()} ${request.url()} ${request.postData?.() || ''}`).digest('hex'), sequence: ++sequence });
  listen('framenavigated', (frame) => {
    if (frame === page.mainFrame?.() && frame.url() !== mainURL) {
      mainURL = frame.url(); navigationGeneration++;
    }
  });
  listen('request', (request) => {
    if (request.resourceType?.() === 'document' && request.frame?.() === page.mainFrame?.()) documentGeneration++;
    requestDocuments.set(request, documentGeneration);
    requestNavigations.set(request, navigationGeneration);
    if (!closing && firstParty(request.url?.()) && /\/(auth|store)\/v1\//.test(request.url())) {
      let done;
      const finished = new Promise((resolve) => { done = resolve; });
      requests.set(request, { event: requestEvent(request), finished, done });
    }
  });
  const settled = (request) => { requests.get(request)?.done(); requests.delete(request); };
  listen('requestfinished', settled);
  listen('console', (msg) => {
    if (msg.type() === 'error') record({ kind: 'console', message: msg.text(), url: msg.location?.()?.url || '', sequence: ++sequence });
  });
  listen('pageerror', (error) => {
    const message = error?.message || String(error);
    const absolute = message.match(/https?:\/\/[^\s]+/)?.[0];
    const webkit = message.match(/\/{1,2}((?:[a-z0-9-]+\.)*hyperzod\.(?:app|com|me|dev)\/[^\s]+)/i)?.[1];
    record({ kind: 'page', message, url: absolute || (webkit ? 'https://' + webkit : ''), sequence: ++sequence });
  });
  listen('requestfailed', (request) => {
    settled(request);
    if (!firstParty(request.url())) return;
    const failure = request.failure()?.errorText || 'unknown', event = requestEvent(request);
    const navigationDiscarded = (requestDocuments.has(request) && requestDocuments.get(request) < documentGeneration) ||
      (requestNavigations.has(request) && requestNavigations.get(request) < navigationGeneration);
    record({ ...event, navigationDiscarded, kind: /ERR_ABORTED|ERR_CANCELED|Load request cancel(?:l)?ed/i.test(failure) ? 'cancelled' : 'transport', message: `TRANSPORT ${event.method} ${safeURL(event.url)} ${failure}` });
  });
  listen('response', (response) => {
    if (!firstParty(response.url())) return;
    const event = requestEvent(response.request()), status = response.status();
    if (/\/(auth|store)\/v1\//.test(response.url())) {
      try { require('./api-budget').recordRateLimit(response.headers()); }
      catch { record({ ...event, kind: 'inspection', message: 'API remaining-request budget could not be persisted' }); }
    }
    if (status === 429 && /\/(auth|store)\/v1\//.test(response.url())) {
      try { require('./api-budget').recordThrottle(response.headers()['retry-after'], { method: event.method, endpoint: new URL(response.url()).pathname }); }
      catch { record({ ...event, kind: 'inspection', message: 'API rate-limit cooldown could not be persisted' }); }
    }
    if (status >= 400) record({ ...event, kind: 'http', status, message: `${status} ${event.method} ${safeURL(event.url)}` });
    const success = () => {
      if (isReadRequest(event) && (/\/(auth|store)\/v1\//.test(event.url) || capture.events.some((failure) => failure.key === event.key))) {
        if (Object.keys(capture.successfulReads).length < 200 || capture.successfulReads[event.key]) capture.successfulReads[event.key] = event.sequence;
        else overflow = true;
      }
    };
    if (status >= 200 && status < 300 && /\/(auth|store)\/v1\//.test(response.url()) && /json/i.test(response.headers()['content-type'] || '')) {
      if (pending.size >= 100) { overflow = true; return; }
      const task = (async () => {
        try {
          const body = await response.json();
          if (body.success === false) record({ ...event, kind: 'application', status, message: `APPLICATION ${event.method} ${safeURL(event.url)} ${JSON.stringify(body.message || {})}` });
          else {
            success();
            const userId = new URL(event.url).pathname.match(/^\/auth\/v1\/user\/(\d+)\/?$/)?.[1];
            if (event.method === 'DELETE' && body.success === true && userId) capture.successfulAccountDeletions.push({ userId, sequence: event.sequence });
          }
        } catch (error) {
          const detail = String(error?.message || error);
          const previousDocument = requestDocuments.has(response.request()) && requestDocuments.get(response.request()) < documentGeneration;
          const navigationDiscardedRead = previousDocument && isReadRequest(event) && /No resource with given identifier found/.test(detail);
          record({ ...event, navigationDiscarded: navigationDiscardedRead, kind: navigationDiscardedRead ? 'cancelled' : 'inspection', status, message: `APPLICATION could not inspect JSON response ${safeURL(event.url)}${navigationDiscardedRead ? ' (read discarded by document navigation)' : ''}: ${detail}` });
        }
      })();
      pending.set(task, event);
      void task.then(() => pending.delete(task), () => { pending.delete(task); overflow = true; });
    } else if (status >= 200 && status < 300) success();
  });
  capture.drain = async (includeRequests = false, timeoutMs = drainTimeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (pending.size || (includeRequests && requests.size)) {
      let timer;
      try {
        const drained = await Promise.race([
          Promise.all([...pending.keys(), ...(includeRequests ? [...requests.values()].map((request) => request.finished) : [])]).then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now())); }),
        ]);
        if (!drained) {
          const incomplete = [...pending.values(), ...(includeRequests ? [...requests.values()].map((request) => request.event) : [])];
          for (const event of incomplete) record({ ...event, kind: 'inspection', message: 'APPLICATION request/response inspection timed out; diagnostics are incomplete' });
          break;
        }
      } finally { clearTimeout(timer); }
    }
  };
  // Finish reading response bodies before explicit document navigation invalidates CDP resources.
  const navigations = ['goto', 'reload'].filter((name) => typeof page[name] === 'function').map((name) => {
    const original = page[name];
    page[name] = async (...args) => {
      await capture.drain();
      // Chromium can cancel the old document's requests before it emits the
      // new document request or framenavigated. Record our explicit navigation
      // boundary before calling the browser, preserving proof for those reads.
      documentGeneration++;
      navigationGeneration++;
      return original.apply(page, args);
    };
    return [name, original];
  });
  let finished;
  capture.finish = () => {
    if (finished) return finished;
    closing = true;
    finished = (async () => {
      await capture.drain(true);
      for (const [event, handler] of listeners) page.removeListener(event, handler);
      for (const [name, original] of navigations) page[name] = original;
      if (overflow) capture.events.push({ kind: 'inspection', message: 'Diagnostics capacity exceeded; evidence is incomplete', sequence: ++sequence, url: '' });
    })();
    return finished;
  };
  return capture;
}
async function visibleToastText(page) { return redact((await page.locator('.v-snackbar__content, #app-snackbar, .alert-message').allInnerTexts()).join(' | ')).slice(0, 400); }
async function reportFailure(testInfo, page, capture, error) {
  try {
    const log = redact(JSON.stringify({ test: testInfo.title, url: safeURL(page.url()), error: error?.message, ...capture }, null, 2));
    const destination = testInfo.outputPath('console.log');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, log);
    console.log(`Failure: ${testInfo.title}\n${redact(error?.message || 'See evidence')}\nEvidence: ${destination}`);
    await testInfo.attach('console-log', { path: destination, contentType: 'text/plain' });
  } catch { /* do not replace the original test error */ }
}
module.exports = { startCapture, visibleToastText, reportFailure };
