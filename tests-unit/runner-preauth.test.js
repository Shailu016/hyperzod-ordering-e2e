const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const policy = require('../utils/policy');
const lifecycle = require('../utils/lifecycle');

test('pre-auth runner failure releases only proven untouched identity, never continues or reports green', async () => {
  for (const mode of ['untouched', 'accessed', 'legacy', 'missing-report', 'executed-main']) {
    const filename = path.resolve(__dirname, '../scripts/run-suite.js');
    const writes = new Map();
    const env = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123', BASE_URL: 'https://test.example', E2E_ALLOWED_ORIGINS: 'https://test.example', TEST_USER_EMAIL: 'shared@example.invalid' };
    const report = { stats: { startTime: '2026-10-29T07:00:00Z', duration: 100 }, errors: [], suites: [{ specs: [
      { title: 'signup: purge leftovers, create user via UI and persist session @smoke', file: 'signup.setup.js', tests: [{ projectName: 'setup', projectId: 'setup', status: 'unexpected', results: [{ status: 'failed', retry: 0 }] }] },
      { title: 'delete the test user account via UI @smoke', file: 'delete-user.teardown.js', tests: [{ projectName: 'cleanup', projectId: 'cleanup', status: 'unexpected', results: [{ status: 'failed', retry: 0 }] }] },
      { title: 'places a COD order end-to-end and sees it in order history @smoke @checkout', file: '03-place-order.spec.js', tests: [{ projectName: 'web', projectId: 'web', status: 'skipped', results: [] }] },
    ] }] };
    if (mode === 'executed-main') { report.suites[0].specs[2].tests[0].status = 'unexpected'; report.suites[0].specs[2].tests[0].results = [{ status: 'failed' }]; }
    let released = 0, spawned = 0;
    const dependencies = {
      dotenv: { config() {} },
      'node:fs': { mkdirSync() {}, writeFileSync(file, value) { writes.set(file, value); }, readFileSync(file) {
        if (file.endsWith('report.json')) { if (mode === 'missing-report') throw new Error('missing report'); return JSON.stringify(report); }
        if (!writes.has(file)) throw new Error('missing file');
        return writes.get(file);
      } },
      'node:child_process': { spawn() { spawned++; const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 1)); return child; } },
      '../utils/lease': { async acquireLease() { return async () => { released++; }; } },
      '../utils/manifest': { exportManifest(id) { return { runId: id, origin: env.BASE_URL, key: policy.identityKey(env.BASE_URL, env.TEST_USER_EMAIL), lifecycle: 'cleanup-unresolved', orders: [], ...(mode === 'legacy' ? {} : { identityAccessJournalVersion: 1, identityAccessStarted: mode === 'accessed' }) }; } },
      '../utils/policy': policy,
      '../utils/lifecycle': lifecycle,
      './summarize': require('../scripts/summarize'),
      '../utils/env': { validateEnv() { return []; } },
    };
    const module = { exports: {} };
    const mockRequire = (name) => dependencies[name] || require(name);
    mockRequire.resolve = require.resolve;
    const process = { env, argv: [], once() {}, removeListener() {}, exitCode: 0 };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: mockRequire, module, __dirname: path.dirname(filename), console: { log() {} }, process }, { filename });
    await module.exports.run('all');
    const summary = JSON.parse([...writes.values()].at(-1));
    assert.equal(spawned, 1, mode);
    assert.equal(process.exitCode, 1, mode);
    assert.notEqual(summary.status, 'passed', mode);
    assert.equal(summary.outcomes.length, 1, mode);
    assert.equal(released, mode === 'untouched' ? 1 : 0, mode);
    assert.equal(summary.leaseReleaseReason, mode === 'untouched' ? 'identity-access-never-started' : undefined, mode);
    assert.equal(Boolean(summary.leaseRetainedReason), mode !== 'untouched', mode);
  }
});
