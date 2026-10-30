const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requiresReconciliation, identityAccessNeverStarted } = require('../utils/lifecycle');
test('ambiguous submission and missing cleanup proof block the next device and retain the lease', () => {
  for (const resource of [undefined, { lifecycle: 'authenticated' }, { lifecycle: 'cleanup-unresolved' }, { lifecycle: 'deleted-and-proven', submissionAttempted: {}, orders: [] }]) assert.equal(requiresReconciliation(resource), true);
  assert.equal(requiresReconciliation({ lifecycle: 'absent-proven', orders: [] }), false);
  assert.equal(requiresReconciliation({ lifecycle: 'deleted-and-proven', submissionAttempted: {}, orders: [{ orderId: 123 }] }), false);
});

function preauthFixture() {
  const expected = { runId: 'owner-web', origin: 'https://test.example', key: 'a'.repeat(24) };
  const resource = { ...expected, lifecycle: 'cleanup-unresolved', identityAccessJournalVersion: 1, identityAccessStarted: false, orders: [] };
  const failed = (projectName) => ({ projectName, projectId: projectName, status: 'unexpected', results: [{ status: 'failed', retry: 0 }] });
  const report = { stats: { startTime: '2026-10-29T07:00:00Z', duration: 100 }, errors: [], suites: [{ specs: [
    { file: 'signup.setup.js', tests: [failed('setup')] },
    { file: 'delete-user.teardown.js', tests: [failed('cleanup')] },
    { file: '03-place-order.spec.js', tests: [{ projectName: 'web', projectId: 'web', status: 'skipped', results: [] }] },
  ] }] };
  return { expected, resource, report };
}
test('only verified pre-auth failures release an untouched identity without claiming account absence', () => {
  const { expected, resource, report } = preauthFixture();
  assert.equal(requiresReconciliation(resource), true);
  assert.equal(identityAccessNeverStarted(resource, expected, report, 'web'), true);
  for (const change of [{ runId: 'another' }, { key: 'b'.repeat(24) }, { origin: 'https://other.example' },
    { identityAccessStarted: true }, { identityAccessStarted: undefined }, { identityAccessStarted: 'false' }, { identityAccessJournalVersion: undefined },
    { userId: null }, { submissionAttempted: false }, { orders: undefined }, { orders: [{ orderId: 3 }] }, { lifecycle: 'authenticated' }]) {
    assert.equal(identityAccessNeverStarted({ ...resource, ...change }, expected, report, 'web'), false, JSON.stringify(change));
  }
  assert.equal(identityAccessNeverStarted(resource, expected, undefined, 'web'), false);
  assert.equal(identityAccessNeverStarted(resource, expected, { ...report, errors: [{ message: 'worker interrupted' }] }, 'web'), false);
  assert.equal(identityAccessNeverStarted(resource, expected, { ...report, stats: {} }, 'web'), false);
});
test('executed cases, retries, missing lifecycle tests or malformed reports cannot prove no access', () => {
  for (const mutate of [
    (r) => { r.suites[0].specs[2].tests[0].status = 'expected'; r.suites[0].specs[2].tests[0].results = [{ status: 'passed' }]; },
    (r) => { r.suites[0].specs[2].tests[0].results = [{ status: 'skipped' }]; },
    (r) => { r.suites[0].specs[0].tests[0].results.push({ status: 'failed', retry: 1 }); },
    (r) => { r.suites[0].specs[0].tests[0].results = [{ status: 'passed' }]; },
    (r) => { r.suites[0].specs[0].tests[0].projectId = 'another'; },
    (r) => { r.suites[0].specs[1].file = 'another.js'; },
    (r) => { r.suites[0].specs.splice(1, 1); },
    (r) => { r.suites[0].specs.push(r.suites[0].specs[0]); },
  ]) {
    const { expected, resource, report } = preauthFixture();
    mutate(report);
    assert.equal(identityAccessNeverStarted(resource, expected, report, 'web'), false);
  }
});
