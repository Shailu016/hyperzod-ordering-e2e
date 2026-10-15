const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const root = path.resolve(__dirname, '..');
const load = (file) => YAML.parse(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'));

test('source workflows retain evidence for the exact attempt and delegate notification', () => {
  for (const file of ['scheduled-e2e.yml', 'scheduled-e2e-smoke.yml']) {
    const workflow = load(file);
    const job = Object.values(workflow.jobs).find((value) => value.steps?.some((step) => step.id === 'retention'));
    assert.equal(job.env.REPORT_DELIVERY, 'pages-v1');
    assert.ok(!job.steps.some((step) => step.run?.includes('notify-slack.py')));
    const retention = job.steps.find((step) => step.id === 'retention');
    assert.equal(retention.if, 'always()');
    assert.equal(retention.shell, 'python3 {0}');
    assert.match(retention.run, /source\.json/);
    assert.match(retention.run, /GITHUB_RUN_ATTEMPT/);
    const evidence = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.match(evidence.with.name, /github\.run_attempt/);
    assert.match(evidence.with['retention-days'], /retention\.outputs\.days/);
  }
});

test('privileged publisher executes trusted main code and verifies before sending links', () => {
  const workflow = load('publish-reports.yml');
  assert.deepEqual(workflow.on.workflow_run.workflows.sort(), ['scheduled-e2e-full', 'scheduled-e2e-smoke']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.publish;
  assert.match(job.if, /head_repository\.full_name == github\.repository/);
  assert.equal(job.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with.ref, 'main');
  assert.ok(job.steps.every((step) => !step.run?.match(/npm test|run-suite\.js/)));
  const notify = job.steps.find((step) => step.run?.includes('notify-slack.py'));
  assert.match(notify.if, /source\.outputs\.delivery == 'pages-v1'/);
  assert.equal(notify.env.E2E_REPORT_PUBLISH_STATUS, '${{ steps.verify.outcome }}');
  assert.equal(notify.env.E2E_SOURCE_RUN_ATTEMPT, '${{ steps.source.outputs.attempt }}');
  assert.equal(notify.env.E2E_REPORT_BASE_URL, '${{ steps.deployment.outputs.page_url }}');
  assert.ok(job.steps.findIndex((step) => step.id === 'verify') < job.steps.indexOf(notify));
});
