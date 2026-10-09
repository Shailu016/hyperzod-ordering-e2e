const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverLease } = require('../utils/lease-recovery');
const { fixture, ref, sha } = require('./lease-fixture');
test('verified inactive owner recovery atomically saves an audit and removes the inspected lock', async () => {
  const { calls, refs, options } = fixture();
  const result = await recoverLease(options);
  assert.equal(refs.has('refs/tags/' + ref), false);
  assert.ok(refs.has('refs/tags/' + result.auditRef));
  assert.equal(calls.at(-1).body.variables.input.refUpdates.length, 2);
});
test('active owners and raced replacements remain locked without orphan audit refs', async () => {
  for (const input of [{ active: true }, { changed: true }, { rejectUpdate: true }]) {
    const { refs, options } = fixture(input);
    await assert.rejects(recoverLease(options), /active|rejected/);
    assert.ok(refs.has('refs/tags/' + ref));
    assert.equal(refs.size, 1);
  }
});
test('missing reconciliation, wrong owner and broad ref names refuse recovery', async () => {
  for (const overrides of [{ resourcesReconciled: false }, { expectedOwner: 'another-run' }, { ref: 'main' }, { expectedSha: 'wrong' }, { evidence: '' }]) {
    const { calls, options } = fixture();
    await assert.rejects(recoverLease({ ...options, ...overrides }));
    assert.equal(calls.some((call) => call.url.endsWith('/graphql')), false);
  }
});
test('repository lookup failure leaves the original lease locked', async () => {
  const { refs, options } = fixture();
  const original = options.request;
  options.request = async (url, settings) => url.endsWith('/hyperzod-ordering-e2e') ? { ok: false, status: 500 } : original(url, settings);
  await assert.rejects(recoverLease(options), /HTTP 500/);
  assert.equal(refs.get('refs/tags/' + ref), sha);
});
