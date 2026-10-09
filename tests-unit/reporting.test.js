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
  assert.equal(result.projects.length, 3);
  assert.ok(result.projects.every((p) => p.counts.passed === 3 && Object.values(p.critical).every((value) => value === 'passed')));
});

test('failed setup dependency coverage is not run, and Slack receives the useful API diagnostic', () => {
  const document = JSON.parse(report());
  document.suites[0].specs.push({ title: 'dependent UI check', tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] });
  document.suites[0].specs.push({ title: 'addresses', tests: [{ status: 'unexpected', results: [{ status: 'failed', errors: [{ message: 'generic assertion' }], attachments: [{ name: 'api-diagnostics', path: 'diagnostics' }] }] }] });
  const result = summarizeReports({ expectedProjects: ['web'] }, [{ project: 'web', report: 'report', exitCode: 1 }], (name) => name === 'report' ? JSON.stringify(document) : JSON.stringify({ critical: [{ message: 'this.getLoggedInUser is not a function' }] }));
  assert.equal(result.counts.notRun, 1);
  assert.equal(result.counts.skipped, 0);
  assert.equal(result.failedTests[0].error, 'this.getLoggedInUser is not a function');
});

test('Playwright inline base64 diagnostic attachments supply the actionable failure reason', () => {
  const document = JSON.parse(report());
  document.suites[0].specs.push({ title: 'address page', tests: [{ status: 'unexpected', results: [{ status: 'failed', attachments: [{ name: 'api-diagnostics', body: Buffer.from(JSON.stringify({ critical: [{ message: 'address getter is not callable' }] })).toString('base64') }] }] }] });
  const result = summarizeReports({ expectedProjects: ['web'] }, [{ project: 'web', report: 'report', exitCode: 1 }], () => JSON.stringify(document));
  assert.equal(result.failedTests[0].error, 'address getter is not callable');
});
test('missing, skipped and flaky critical tests cannot produce green', () => {
  const setup = { expectedProjects: ['web'] }, outcomes = [{ project: 'web', exitCode: 0, report: 'web' }];
  for (const status of ['skipped', 'flaky']) assert.equal(summarizeReports(setup, outcomes, () => report(status)).status, 'failed');
  assert.equal(summarizeReports(setup, outcomes, () => { throw Error('missing'); }).status, 'failed');
  assert.equal(summarizeReports({ expectedProjects: ['web','ios'] }, outcomes, () => report()).status, 'failed');
});

test('new skipped coverage fails while the declared optional fixture skip is visible', () => {
  const initial = { expectedProjects: ['web'] }, outcomes = [{ project: 'web', exitCode: 0, report: 'web' }];
  const document = JSON.parse(report());
  const extra = { title: 'new required UI check', tests: [{ status: 'skipped', results: [{ status: 'skipped' }] }] };
  document.suites[0].specs.push(extra);
  assert.equal(summarizeReports(initial, outcomes, () => JSON.stringify(document)).status, 'failed');
  extra.title = 'product deep link displays product content @catalog';
  extra.tests[0].annotations = [{ type: 'skip', description: 'Declared fixture capability: product deep links disabled' }];
  const result = summarizeReports(initial, outcomes, () => JSON.stringify(document));
  assert.equal(result.status, 'passed');
  assert.equal(result.counts.skipped, 1);
});
