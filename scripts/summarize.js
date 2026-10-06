function testCases(report) {
  return (report.suites || []).flatMap((suite) => walk(suite));
}
function walk(suite) {
  return [...(suite.specs || []).flatMap((spec) => (spec.tests || []).map((test) => ({ title: spec.title, ...test }))), ...(suite.suites || []).flatMap(walk)];
}
function summarizeReports(initial, outcomes, readFile) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, notRun: 0 };
  const issues = [];
  for (const project of initial.expectedProjects) {
    const outcome = outcomes.find((o) => o.project === project);
    if (!outcome) { issues.push(`${project}: not executed`); continue; }
    let report;
    try { report = JSON.parse(readFile(outcome.report, 'utf8')); }
    catch { issues.push(`${project}: missing or invalid report`); continue; }
    if (outcome.exitCode !== 0 || report.errors?.length) issues.push(`${project}: runner failed`);
    const cases = testCases(report);
    for (const test of cases) {
      if (test.status === 'expected' && test.results?.some((r) => r.status === 'passed')) counts.passed++;
      else if (test.status === 'flaky') counts.flaky++;
      else if (test.status === 'unexpected') counts.failed++;
      else if (test.results?.length) counts.skipped++;
      else counts.notRun++;
    }
    const required = project === 'setup' ? [/signup:/, /delete the test user/] : [/signup:/, /delete the test user/, /places a COD order/];
    for (const pattern of required) {
      if (!cases.some((t) => pattern.test(t.title) && t.status === 'expected' && t.results?.some((r) => r.status === 'passed'))) issues.push(`${project}: critical test ${pattern.source} did not pass on first attempt`);
    }
  }
  const status = issues.length || counts.failed || counts.flaky || counts.notRun ? 'failed' : 'passed';
  return { ...initial, outcomes, counts, issues, status };
}
module.exports = { summarizeReports, testCases };
