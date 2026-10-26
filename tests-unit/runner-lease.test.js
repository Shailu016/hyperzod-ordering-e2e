const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const identity = require('../utils/isolated-identity');

test('managed runner records a verified lease block before spawning tests and defaults to a local identity', async () => {
  const filename = path.resolve(__dirname, '../scripts/run-suite.js');
  const writes = new Map();
  const env = { BASE_URL: 'https://test.example', TEST_USER_EMAIL: 'shared@example.invalid', TEST_USER_PHONE: '9999999999' };
  const held = { ref: 'e2e-lease-' + 'a'.repeat(24), sha: 'b'.repeat(40), owner: 'other-run', source: 'local', acquiredAt: '2026-10-26T00:00:00.000Z' };
  const blocked = Object.assign(new Error('Tests did not start: another runner holds the test account lock'), { code: 'identity-lease-conflict', leaseConflict: held });
  let leasedEmail;
  const dependencies = {
    dotenv: { config() {} },
    'node:fs': { mkdirSync() {}, writeFileSync(file, value) { writes.set(file, JSON.parse(value)); } },
    'node:child_process': { spawn() { assert.fail('No browser test may start without ownership'); } },
    '../utils/lease': { async acquireLease(input) { leasedEmail = input.email; throw blocked; } },
    '../utils/manifest': { exportManifest() { assert.fail('No test resource should exist'); } },
    '../utils/policy': { assertAllowedTarget() { return env.BASE_URL; } },
    './summarize': { summarizeReports() { assert.fail('No test report can be summarized'); } },
    '../utils/lifecycle': { requiresReconciliation() { assert.fail('No test was spawned'); } },
    '../utils/env': { validateEnv() { return []; } },
    '../utils/isolated-identity': { ...identity, useIsolatedIdentity() { return identity.useIsolatedIdentity(env); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) { return dependencies[name] || require(name); },
    module, __dirname: path.dirname(filename), console: { log() {} },
    process: { env, argv: [], once() {}, removeListener() {} },
  }, { filename });
  await assert.rejects(module.exports.run('all'), /Tests did not start/);
  assert.notEqual(leasedEmail, 'shared@example.invalid');
  assert.match(leasedEmail, /\.e2e[a-f0-9]{16}@example.invalid$/);
  const summary = [...writes.values()].at(-1);
  assert.equal(summary.status, 'infrastructure-failed');
  assert.equal(summary.testsStarted, false);
  assert.equal(summary.errorCode, 'identity-lease-conflict');
  assert.deepEqual(summary.leaseConflict, held);
  assert.deepEqual(summary.outcomes, []);
  assert.equal(summary.counts, undefined);
  assert.equal(JSON.stringify(summary).includes(leasedEmail), false);
});
