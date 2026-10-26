const { test } = require('node:test');
const assert = require('node:assert/strict');
const { acquireLease } = require('../utils/lease');
const { fixture } = require('./lease-fixture');
const input = { origin: 'https://test.example', email: 'user@example.invalid', owner: 'run' };
test('identity lease creation is exclusive and release is atomic and idempotent', async () => {
  const { calls, refs, options } = fixture();
  const release = await acquireLease({ ...input, ...options });
  assert.equal(refs.size, 1);
  await release(); await release();
  assert.equal(refs.size, 0);
  assert.equal(calls.filter((c) => c.url.endsWith('/graphql')).length, 1);
  assert.equal(calls.some((c) => c.method === 'DELETE'), false);
});
test('lease contention fails before tests; age never authorizes stealing', async () => {
  const { calls, options } = fixture({ contend: true });
  await assert.rejects(acquireLease({ ...input, ...options }), (error) => {
    assert.equal(error.code, 'identity-lease-conflict');
    assert.equal(error.leaseConflict.owner, 'run-123');
    assert.equal(error.leaseConflict.githubRunId, '123');
    assert.equal(error.leaseConflict.source, 'github');
    assert.match(error.message, /Tests did not start/);
    assert.equal(JSON.stringify(error.leaseConflict).includes(input.email), false);
    return true;
  });
  assert.equal(calls.some((c) => c.method === 'DELETE' || c.url.endsWith('/graphql')), false);
});
test('lost create acknowledgement is reconciled only by the exact ownership SHA', async () => {
  const { refs, options, calls } = fixture({ lostAck: true });
  const release = await acquireLease({ ...input, ...options });
  assert.equal(calls.filter((call) => call.url.endsWith('git/refs') && call.method === 'POST').length, 1);
  await release();
  assert.equal(refs.size, 0);
});
test('unverified ref or invalid metadata cannot be reported as a confirmed conflict', async () => {
  for (const invalid of ['missing', 'metadata']) {
    const { options } = fixture({ contend: true });
    const request = async (url, args) => {
      if (invalid === 'missing' && /git\/ref\/tags\//.test(url)) return { ok: false, status: 404 };
      if (invalid === 'metadata' && /git\/commits\/[a-f0-9]{40}$/.test(url)) return { ok: true, status: 200, json: async () => ({ tree: { sha: 'tree' }, message: '{"owner":"private@example.invalid"}' }) };
      return options.request(url, args);
    };
    await assert.rejects(acquireLease({ ...input, ...options, request }), (error) => {
      assert.notEqual(error.code, 'identity-lease-conflict');
      assert.equal(error.leaseConflict, undefined);
      return true;
    });
  }
});
test('owner changing immediately before release remains locked', async () => {
  const { refs, options } = fixture({ changed: true });
  const release = await acquireLease({ ...input, ...options });
  await assert.rejects(release(), /rejected/);
  assert.equal([...refs.values()][0], 'c'.repeat(40));
});
