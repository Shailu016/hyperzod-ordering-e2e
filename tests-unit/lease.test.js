const { test } = require('node:test');
const assert = require('node:assert/strict');
const { acquireLease } = require('../utils/lease');
test('identity lease uses atomic ref creation and checks owner before release', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push([url, options.method]);
    let data = url.endsWith('ref/heads/main') ? { object: { sha: 'base' } } : url.endsWith('commits/base') ? { tree: { sha: 'tree' } } : options.method === 'POST' && url.endsWith('/commits') ? { sha: 'owned' } : { object: { sha: 'owned' } };
    return { ok: true, status: options.method === 'DELETE' ? 204 : 200, json: async () => data };
  };
  const release = await acquireLease({ origin: 'https://test.example', email: 'user@example.invalid', owner: 'run', token: 'fake', request });
  await release(); await release();
  assert.equal(calls.filter((c) => c[1] === 'DELETE').length, 1);
});
test('lease contention fails before a caller can start tests', async () => {
  const request = async (url, options) => ({ ok: !url.endsWith('/refs'), status: 422, json: async () => url.endsWith('ref/heads/main') ? { object: { sha: 'base' } } : url.endsWith('commits/base') ? { tree: { sha: 'tree' } } : { sha: 'owned' } });
  await assert.rejects(acquireLease({ origin: 'https://test.example', email: 'user@example.invalid', owner: 'run', token: 'fake', request }), /another runner/);
});
test('release refuses to delete a lease acquired by another owner', async () => {
  let releasePhase = false;
  let deleted = false;
  const request = async (url, options) => {
    if (options.method === 'DELETE') deleted = true;
    const data = url.endsWith('ref/heads/main') ? { object: { sha: 'base' } } : url.endsWith('commits/base') ? { tree: { sha: 'tree' } } : url.endsWith('/commits') ? { sha: 'owned' } : { object: { sha: releasePhase ? 'someone-else' : 'owned' } };
    return { ok: true, status: 200, json: async () => data };
  };
  const release = await acquireLease({ origin: 'https://test.example', email: 'user@example.invalid', owner: 'run', token: 'fake', request });
  releasePhase = true;
  await assert.rejects(release(), /owner changed/);
  assert.equal(deleted, false);
});
