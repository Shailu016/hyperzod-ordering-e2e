/** Missing cleanup proof or an ambiguous order keeps the identity locked for reconciliation. */
function requiresReconciliation(resource) {
  if (!resource) return true;
  if (resource.submissionAttempted && !resource.orders?.length) return true;
  return !['absent-proven', 'deleted-and-proven'].includes(resource.lifecycle);
}
/** A failed public-navigation setup can release its lease without asserting account absence. */
function identityAccessNeverStarted(resource, expected, report, project) {
  if (!resource || !expected || !report || !Array.isArray(report.suites) || !Array.isArray(report.errors) || report.errors.length) return false;
  if (!Number.isFinite(report.stats?.duration) || report.stats.duration < 0 || !Number.isFinite(Date.parse(report.stats?.startTime))) return false;
  if (!['setup-started', 'cleanup-unresolved'].includes(resource.lifecycle) || resource.identityAccessJournalVersion !== 1 || !Object.hasOwn(resource, 'identityAccessStarted') || resource.identityAccessStarted !== false) return false;
  if (!expected.runId || !expected.origin || !expected.key || ['runId', 'origin', 'key'].some((key) => resource[key] !== expected[key])) return false;
  if (Object.hasOwn(resource, 'userId') || Object.hasOwn(resource, 'submissionAttempted') || !Array.isArray(resource.orders) || resource.orders.length) return false;
  const cases = [];
  const walk = (suite) => {
    if (!suite || !Array.isArray(suite.specs || []) || !Array.isArray(suite.suites || [])) return false;
    for (const spec of suite.specs || []) {
      if (typeof spec.file !== 'string' || !Array.isArray(spec.tests) || !spec.tests.length) return false;
      for (const item of spec.tests) cases.push({ file: spec.file.replace(/\\/g, '/'), test: item });
    }
    return (suite.suites || []).every(walk);
  };
  if (!report.suites.every(walk) || !cases.length) return false;
  let failedSetup = 0, cleanup = 0;
  for (const { file, test } of cases) {
    if (!test || !Array.isArray(test.results) || !['setup', 'cleanup', project].includes(test.projectName) || test.projectId !== test.projectName) return false;
    const failedOnce = test.status === 'unexpected' && test.results.length === 1 && ['failed', 'timedOut'].includes(test.results[0].status) && (test.results[0].retry ?? 0) === 0;
    // Dependency-blocked cases have no attempts. A runtime test.skip() can
    // follow executed code, so a skipped result is not proof of non-execution.
    const notExecuted = test.status === 'skipped' && test.results.length === 0;
    if (test.projectName === 'setup' && /(^|\/)signup\.setup\.js$/.test(file)) {
      if (!failedOnce) return false;
      failedSetup++;
    } else if (test.projectName === 'cleanup' && /(^|\/)delete-user\.teardown\.js$/.test(file)) {
      if (!failedOnce && !notExecuted) return false;
      cleanup++;
    } else if (test.projectName !== project || !notExecuted) return false;
  }
  return failedSetup === 1 && cleanup === 1;
}
module.exports = { requiresReconciliation, identityAccessNeverStarted };
