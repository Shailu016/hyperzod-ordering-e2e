const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeReports } = require('../scripts/summarize');
function report(status = 'expected') {
  return JSON.stringify({ suites: [{ specs: ['signup: fresh user', 'delete the test user account', 'places a COD order'].map((title) => ({ title, tests: [{ status, results: [{ status: status === 'skipped' ? 'skipped' : 'passed' }] }] })) }] });
}
test('all device reports are counted, not only the final project', () => {
  const outcomes = ['web','android','ios'].map((project) => ({ project, exitCode: 0, report: project }));
  const result = summarizeReports({ expectedProjects: ['web','android','ios'] }, outcomes, () => report());
  assert.equal(result.counts.passed, 9); assert.equal(result.status, 'passed');
});
test('missing, skipped and flaky critical tests cannot produce green', () => {
  const setup = { expectedProjects: ['web'] }, outcomes = [{ project: 'web', exitCode: 0, report: 'web' }];
  for (const status of ['skipped', 'flaky']) assert.equal(summarizeReports(setup, outcomes, () => report(status)).status, 'failed');
  assert.equal(summarizeReports(setup, outcomes, () => { throw Error('missing'); }).status, 'failed');
  assert.equal(summarizeReports({ expectedProjects: ['web','ios'] }, outcomes, () => report()).status, 'failed');
});
