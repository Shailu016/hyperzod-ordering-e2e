const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');
const path = require('node:path');
const { evaluateAcceptance, KNOWN } = require('../scripts/check-pr-acceptance');
const { summarizeReports } = require('../scripts/summarize');
function fixture(known = true) {
  const initial = { runId: '123-fixture', githubRunId: '123', origin: 'https://automations-store.hyperzod.me', suite: 'all', expectedProjects: ['web', 'android', 'ios'] };
  const reports = {}, resources = {};
  for (const project of initial.expectedProjects) {
    reports[project] = { errors: [], suites: [{ specs: ['signup: create user', 'delete the test user', 'places a COD order', KNOWN.title].map((title, index) => ({ title, tests: [{ projectName: index === 0 ? 'setup' : index === 1 ? 'cleanup' : project, status: 'expected', results: [{ status: 'passed', retry: 0 }] }] })) }] };
    resources[project] = { runId: initial.runId + '-' + project, origin: initial.origin, key: 'a'.repeat(24), lifecycle: 'deleted-and-proven', orders: [] };
  }
  const failing = reports.web.suites[0].specs[3].tests[0];
  if (known) {
    failing.status = 'unexpected';
    failing.results = [{ status: 'failed', retry: 0, errors: [{ message: 'Error: unexpected application or required API failures\nexpect(...).toEqual([])' }], attachments: [{ name: 'api-diagnostics', contentType: 'application/json', body: Buffer.from(JSON.stringify({ critical: [{ kind: 'page', message: KNOWN.message }] })).toString('base64') }] }];
  }
  const outcomes = initial.expectedProjects.map(project => ({ project, exitCode: project === 'web' && known ? 1 : 0, report: project }));
  const summary = { ...summarizeReports(initial, outcomes, file => JSON.stringify(reports[file])), finishedAt: '2026-10-29T00:00:00Z' };
  const options = { runId: '123', outcome: known ? 'failure' : 'success', now: Date.parse('2026-10-29T00:00:00Z') };
  return { summary, reports, resources, options, failing };
}
const evaluate = f => evaluateAcceptance(f.summary, f.reports, f.resources, f.options);
test('known storefront failure can accept the PR without changing raw failed results', () => {
  const f = fixture(); const before = JSON.stringify(f);
  assert.equal(evaluate(f).decision, 'accepted-with-known-storefront-issue');
  assert.equal(f.summary.status, 'failed');
  assert.equal(f.summary.counts.failed, 1);
  assert.equal(JSON.stringify(f), before);
  assert.equal(evaluate(fixture(false)).decision, 'accepted');
});
test('known exception never admits unknown failures, missing proof or expired policy', () => {
  const changes = [
    f => { f.options.now = Date.parse(KNOWN.expiresAt); },
    f => { f.summary.leaseRetainedReason = 'unresolved cleanup'; },
    f => { f.resources.web.lifecycle = 'cleanup-unresolved'; },
    f => { f.resources.web.submissionAttempted = {}; },
    f => { delete f.reports.ios; },
    f => { f.summary.counts.failed = 0; },
    f => { f.failing.results[0].errors.push({ message: 'New assertion failed' }); },
    f => { f.failing.results[0].errors[0].message = 'TimeoutError: element missing'; },
    f => { f.failing.results[0].attachments = []; },
    f => { f.failing.results[0].retry = 1; },
    f => { f.failing.results[0].attachments[0].body = Buffer.from(JSON.stringify({ critical: [{ kind: 'page', message: KNOWN.message }, { kind: 'http', status: 503 }] })).toString('base64'); },
    f => { f.failing.projectName = 'android'; },
    f => { f.summary.outcomes[0].signal = 'SIGTERM'; },
    f => { f.options.outcome = 'cancelled'; },
    f => { f.options.runId = '124'; },
    f => { f.summary.outcomes.pop(); },
    f => { f.reports.android.suites[0].specs[2].tests[0].status = 'skipped'; },
    f => { f.reports.android.suites[0].specs[0].tests[0].status = 'unexpected'; },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => evaluate(f)); }
});
test('workflow contains a mandatory acceptance policy after the nonblocking raw suite step', () => {
  const workflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/verify-pr.yml'), 'utf8'));
  const steps = workflow.jobs.acceptance.steps;
  const suite = steps.find(step => step.id === 'suite');
  const gate = steps.find(step => step.run === 'node scripts/check-pr-acceptance.js');
  assert.equal(suite['continue-on-error'], true);
  assert.equal(gate.if, 'always()');
  assert.equal(gate['continue-on-error'], undefined);
  assert.equal(gate.env.E2E_SUITE_OUTCOME, '${{ steps.suite.outcome }}');
  assert.ok(steps.indexOf(gate) > steps.indexOf(suite));
});
