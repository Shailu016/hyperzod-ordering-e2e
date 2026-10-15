const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, verify, constants } = require('node:crypto');
const { slotTitle } = require('../utils/schedule');
const load = () => import('../scheduler/worker.mjs');
const due = '2026-10-15T07:30:00.000Z';
const now = new Date('2026-10-15T10:00:00Z');
const environment = { SCHEDULER_ENABLED: 'true', SCHEDULER_ENABLED_AT: due, GITHUB_REPOSITORY: 'Owner/Repo' };
const marker = Buffer.from('env:\n  E2E_SCHEDULE_PROTOCOL: slots-v1\n').toString('base64');
function fakeAPI({ runs = [], legacy = false, onDispatch } = {}) {
  const calls = [];
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path.startsWith('contents/')) return { content: legacy ? Buffer.from('old workflow').toString('base64') : marker };
    if (path.includes('/runs?')) return { workflow_runs: runs };
    if (path.startsWith('git/ref/')) throw Object.assign(new Error('Not found'), { status: 404 });
    if (path.endsWith('/dispatches')) { if (onDispatch) return onDispatch(body); return null; }
    throw new Error('Unexpected test API path: ' + path);
  };
  return { api, calls };
}

test('independent worker stays inert while disabled and exposes no public dispatch endpoint', async () => {
  const { tick, default: worker } = await load();
  assert.deepEqual(await tick({}, { tokenProvider: () => { throw new Error('Must not authenticate'); } }), { enabled: false, dispatched: [], existing: [] });
  assert.equal((await worker.fetch(new Request('https://fixture.invalid/dispatch', { method: 'POST' }))).status, 404);
});

test('worker recovers the missing 1 PM slot using main and the configured smoke suite', async () => {
  const { tick } = await load();
  const { api, calls } = fakeAPI();
  const result = await tick(environment, { now, api });
  assert.deepEqual(result.dispatched.map((item) => item.due), [due]);
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(post.path, 'actions/workflows/scheduled-e2e-smoke.yml/dispatches');
  assert.deepEqual(post.body, { ref: 'main', inputs: { suite: 'smoke', schedule_slot: due } });
});

test('worker fails closed before dispatch against old main or invalid cutover', async () => {
  const { tick } = await load();
  const old = fakeAPI({ legacy: true });
  await assert.rejects(tick(environment, { now, api: old.api }), /missing scheduled-slot admission/);
  assert.ok(old.calls.every((item) => item.method === 'GET'));
  const current = fakeAPI();
  await assert.rejects(tick({ ...environment, SCHEDULER_ENABLED_AT: 'invalid' }, { now, api: current.api }), /cutover/);
  assert.equal(current.calls.length, 0);
});

test('lost dispatch acknowledgement is reconciled through run history, without replaying failures', async () => {
  const { tick } = await load();
  const first = fakeAPI({ onDispatch: () => { throw new Error('Acknowledgement lost'); } });
  await assert.rejects(tick(environment, { now, api: first.api }), /Acknowledgement lost/);
  assert.equal(first.calls.filter((item) => item.method === 'POST').length, 1);
  const second = fakeAPI({ runs: [{ event: 'workflow_dispatch', display_title: slotTitle('smoke', due), head_branch: 'main', status: 'completed', conclusion: 'failure' }] });
  assert.equal((await tick(environment, { now, api: second.api })).dispatched.length, 0);
  assert.equal(second.calls.filter((item) => item.method === 'POST').length, 0);
});

test('GitHub App JWT is short-lived, signed and limited to this installation repository', async () => {
  const { appToken } = await load();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GITHUB_APP_ID: '123', GITHUB_INSTALLATION_ID: '456', GITHUB_REPOSITORY_ID: '789', GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/app/installations/456/access_tokens');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { repository_ids: [789], permissions: { actions: 'write', contents: 'read' } });
    const jwt = options.headers.Authorization.slice('Bearer '.length);
    const [header, payload, signature] = jwt.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(decoded.iss, '123');
    assert.equal(decoded.exp - decoded.iat, 600);
    assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + payload), { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'base64url')));
    return { ok: true, json: async () => ({ token: 'fixture-installation-token', expires_at: new Date(Number(now) + 3600_000).toISOString() }) };
  };
  assert.equal(await appToken(env, { now, request }), 'fixture-installation-token');
  assert.equal(calls, 1);
});

test('missing, expired or incorrectly scoped authentication never reaches a workflow dispatch', async () => {
  const { appToken, tick } = await load();
  await assert.rejects(appToken({ GITHUB_APP_ID: '1' }, { request: () => { throw new Error('Must not send'); } }), /identity/);
  await assert.rejects(tick(environment, { now, tokenProvider: async () => { throw new Error('Authentication failed'); } }), /Authentication failed/);
});
