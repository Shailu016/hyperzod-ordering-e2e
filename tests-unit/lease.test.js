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
  await assert.rejects(acquireLease({ ...input, ...options }), /another runner/);
  assert.equal(calls.some((c) => c.method === 'DELETE' || c.url.endsWith('/graphql')), false);
});
test('owner changing immediately before release remains locked', async () => {
  const { refs, options } = fixture({ changed: true });
  const release = await acquireLease({ ...input, ...options });
  await assert.rejects(release(), /rejected/);
  assert.equal([...refs.values()][0], 'c'.repeat(40));
});
