function testCases(report) {
  return (report.suites || []).flatMap((suite) => walk(suite));
}
function walk(suite) {
  return [...(suite.specs || []).flatMap((spec) => (spec.tests || []).map((test) => ({ title: spec.title, ...test }))), ...(suite.suites || []).flatMap(walk)];
}
function declaredSkip(test) {
  const annotations = [...(test.annotations || []), ...(test.results || []).flatMap((result) => result.annotations || [])];
  return annotations.some((annotation) => annotation.type === 'skip' && (
    (test.title === 'product deep link displays product content @catalog' && annotation.description === 'Declared fixture capability: product deep links disabled') ||
    (test.title === 'address selection persists for delivery orders' && annotation.description === 'declared pickup fixture has no delivery address')
  ));
}
function summarizeReports(initial, outcomes, readFile) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, notRun: 0 };
  const issues = [];
  const projects = [], failedTests = [];
  for (const project of initial.expectedProjects) {
    const device = { project, counts: { passed: 0, failed: 0, flaky: 0, skipped: 0, notRun: 0 }, warnings: 0, status: 'failed', critical: {} };
    projects.push(device);
    const outcome = outcomes.find((o) => o.project === project);
    if (!outcome) { issues.push(`${project}: not executed`); continue; }
    let report;
    try { report = JSON.parse(readFile(outcome.report, 'utf8')); }
    catch { issues.push(`${project}: missing or invalid report`); continue; }
    if (outcome.exitCode !== 0 || report.errors?.length) issues.push(`${project}: runner failed`);
    device.durationMs = report.stats?.duration || 0;
    const cases = testCases(report);
    for (const test of cases) {
      let key;
      if (test.status === 'expected' && test.results?.some((r) => r.status === 'passed')) key = 'passed';
      else if (test.status === 'flaky') key = 'flaky';
      else if (test.status === 'unexpected') key = 'failed';
      else if (test.status === 'skipped') {
        const skip = declaredSkip(test);
        const annotated = [...(test.annotations || []), ...(test.results || []).flatMap((r) => r.annotations || [])].some((a) => a.type === 'skip');
        key = skip || annotated ? 'skipped' : 'notRun';
        if (!skip) issues.push(`${project}: ${annotated ? 'undeclared skipped coverage' : 'not executed'}: ${test.title}`);
      }
      else if (test.results?.length) { key = 'failed'; issues.push(`${project}: test did not pass: ${test.title}`); }
      else key = 'notRun';
      counts[key]++; device.counts[key]++;
      const annotations = [...(test.annotations || []), ...(test.results || []).flatMap((r) => r.annotations || [])];
      if (annotations.some((a) => a.type === 'warning')) device.warnings++;
      if (key === 'failed' || key === 'flaky') {
        let error = (test.results || []).flatMap((r) => r.errors || []).map((e) => e.message || '').find(Boolean) || 'See trace and diagnostics';
        const attachment = (test.results || []).flatMap((r) => r.attachments || []).find((a) => a.name === 'api-diagnostics' && (a.path || a.body));
        if (attachment) {
          try {
            const diagnostics = JSON.parse(attachment.body ? Buffer.from(attachment.body, 'base64').toString('utf8') : readFile(attachment.path, 'utf8'));
            if (diagnostics.critical?.length) error = diagnostics.critical.slice(0, 3).map((event) => event.message).join('; ');
          } catch { /* Keep the original assertion when diagnostic evidence is unavailable. */ }
        }
        failedTests.push({ project, title: test.title, error: require('../utils/policy').redact(error).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 600) });
      }
    }
    const required = project === 'setup' ? [/signup:/, /delete the test user/] : [/signup:/, /delete the test user/, /places a COD order/];
    for (const pattern of required) {
      const passed = cases.some((t) => pattern.test(t.title) && t.status === 'expected' && t.results?.some((r) => r.status === 'passed'));
      device.critical[pattern.source] = passed ? 'passed' : 'failed';
      if (!passed) issues.push(`${project}: critical test ${pattern.source} did not pass on first attempt`);
    }
    device.status = issues.some((issue) => issue.startsWith(`${project}:`)) || device.counts.failed || device.counts.flaky || device.counts.notRun ? 'failed' : 'passed';
  }
  const status = issues.length || counts.failed || counts.flaky || counts.notRun ? 'failed' : 'passed';
  failedTests.sort((a, b) => Number(/signup:|places a COD order|delete the test user/.test(b.title)) - Number(/signup:|places a COD order|delete the test user/.test(a.title)));
  return { ...initial, outcomes, counts, issues, projects, failedTests, status };
}
module.exports = { summarizeReports, testCases };
