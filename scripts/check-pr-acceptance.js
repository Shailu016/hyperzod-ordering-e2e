const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { summarizeReports, testCases } = require('./summarize');
const { requiresReconciliation } = require('../utils/lifecycle');

// Explicit owner-approved baseline, not a general exemption for application errors.
const KNOWN = {
  id: 'address-getter-call',
  title: 'address book renders with add affordance',
  message: 'this.getLoggedInUser is not a function',
  expiresAt: '2026-11-12T00:00:00.000Z',
  evidence: 'https://github.com/Shailu016/hyperzod-ordering-e2e/actions/runs/40889329902',
};

function evaluateAcceptance(summary, reports, resources, { runId, outcome, now = Date.now() }) {
  assert.ok(['success', 'failure'].includes(outcome), 'Suite did not complete');
  assert.ok(/^\d+$/.test(runId) && summary.githubRunId === runId && summary.runId.startsWith(runId + '-'), 'Wrong source run');
  assert.ok(['passed', 'failed'].includes(summary.status) && summary.finishedAt, 'Incomplete/infrastructure result');
  assert.ok(!summary.error && !summary.leaseReleaseError && !summary.leaseRetainedReason, 'Unresolved infrastructure/lease');
  assert.deepEqual(summary.expectedProjects, ['web', 'android', 'ios'], 'Full device coverage required');
  assert.deepEqual(summary.outcomes.map(item => item.project), ['web', 'android', 'ios'], 'Missing device execution');
  let knownFailures = 0;
  for (const project of summary.expectedProjects) {
    const resource = resources[project], report = reports[project];
    assert.ok(resource && resource.runId === summary.runId + '-' + project && resource.origin === summary.origin && /^[a-f0-9]{24}$/.test(resource.key) && resource.key === resources.web?.key && Array.isArray(resource.orders) && !requiresReconciliation(resource), 'Missing/unsafe lifecycle');
    assert.ok(Array.isArray(report?.suites) && Array.isArray(report.errors) && !report.errors.length, 'Incomplete runner report');
    for (const item of testCases(report)) {
      if (item.status === 'expected') assert.ok(item.results?.length === 1 && item.results[0].status === 'passed' && item.results[0].retry === 0, 'Test did not pass on first attempt');
    }
    const failed = testCases(report).filter(item => item.status === 'unexpected');
    assert.ok(failed.length <= 1, 'Additional storefront failures');
    for (const item of failed) {
      assert.ok(now < Date.parse(KNOWN.expiresAt), 'Known storefront exception expired');
      assert.ok(item.title === KNOWN.title && item.projectName === project && item.results?.length === 1, 'Unapproved failure');
      const result = item.results[0];
      assert.ok(result.status === 'failed' && result.retry === 0 && result.errors?.length === 1 && /^Error: unexpected application or required API failures\b/.test(result.errors[0].message), 'Failure is not the known diagnostic guard');
      const attachments = (result.attachments || []).filter(a => a.name === 'api-diagnostics' && a.body && a.contentType === 'application/json');
      assert.equal(attachments.length, 1, 'Known error needs captured inline diagnostics');
      const diagnostics = JSON.parse(Buffer.from(attachments[0].body, 'base64').toString('utf8'));
      assert.ok(Array.isArray(diagnostics.critical) && diagnostics.critical.length > 0 && diagnostics.critical.every(event => event.kind === 'page' && event.message === KNOWN.message), 'Additional/different critical diagnostic');
      knownFailures++;
    }
    const execution = summary.outcomes.find(item => item.project === project);
    assert.equal(execution.exitCode, failed.length ? 1 : 0, 'Unexpected runner exit');
    assert.ok(!execution.signal && !execution.error, 'Runner interrupted');
  }
  const recalculated = summarizeReports(summary, summary.outcomes, file => {
    const item = summary.outcomes.find(outcome => outcome.report === file);
    assert.ok(item, 'Unknown report');
    return JSON.stringify(reports[item.project]);
  });
  assert.deepEqual(summary.counts, recalculated.counts, 'Inconsistent result counts');
  assert.equal(summary.status, recalculated.status, 'Inconsistent raw test outcome');
  assert.deepEqual(summary.issues, recalculated.issues, 'Inconsistent run issues');
  assert.equal(recalculated.counts.failed, knownFailures, 'Unaccounted failure');
  assert.ok(!recalculated.counts.flaky && !recalculated.counts.notRun, 'Flaky or missing coverage');
  assert.ok(recalculated.projects.every(device => Object.values(device.critical).every(value => value === 'passed')), 'Lifecycle/COD checks did not pass');
  const permittedIssues = summary.expectedProjects.filter(project => testCases(reports[project]).some(item => item.status === 'unexpected')).map(project => project + ': runner failed');
  assert.deepEqual(recalculated.issues, permittedIssues, 'Unapproved skipped/critical/incomplete coverage');
  assert.equal(outcome, knownFailures ? 'failure' : 'success', 'Process outcome inconsistent with tests');
  return { decision: knownFailures ? 'accepted-with-known-storefront-issue' : 'accepted', knownFailures, issue: knownFailures ? KNOWN : undefined };
}

function main() {
  const root = path.resolve(__dirname, '..', 'test-results');
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'summary.json'), 'utf8'));
  assert.ok(/^[A-Za-z0-9_-]{1,100}$/.test(summary.runId), 'Invalid run identifier');
  const reports = {}, resources = {};
  for (const project of ['web', 'android', 'ios']) {
    const dir = path.join(root, summary.runId, project);
    reports[project] = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
    resources[project] = JSON.parse(fs.readFileSync(path.join(dir, 'resource-lifecycle.json'), 'utf8'));
  }
  const decision = evaluateAcceptance(summary, reports, resources, { runId: process.env.GITHUB_RUN_ID, outcome: process.env.E2E_SUITE_OUTCOME });
  fs.writeFileSync(path.join(root, 'pr-acceptance-decision.json'), JSON.stringify(decision, null, 2));
  const text = decision.knownFailures ? `PR accepted with ${decision.knownFailures} known storefront failure(s): ${KNOWN.id}. Tests remain failed; storefront health is not green. Exception expires ${KNOWN.expiresAt}. Evidence: ${KNOWN.evidence}` : 'PR acceptance passed with no known storefront exceptions.';
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}
if (require.main === module) { try { main(); } catch (error) { console.error('PR acceptance blocked: ' + error.message); process.exitCode = 1; } }
module.exports = { evaluateAcceptance, KNOWN };
