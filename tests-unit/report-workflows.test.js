const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { SCHEDULES } = require('../utils/schedule');
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

test('both clocks share slot identity and admission runs before the shared test queue', () => {
  for (const [kind, config] of Object.entries(SCHEDULES)) {
    const workflow = load(config.workflow);
    assert.deepEqual(workflow.on.schedule.map((item) => item.cron).sort(), [...config.crons].sort());
    assert.equal(workflow.env.E2E_SCHEDULE_PROTOCOL, 'slots-v1');
    assert.ok(workflow.on.workflow_dispatch.inputs.schedule_slot);
    assert.match(workflow['run-name'], /inputs\.schedule_slot/);
    assert.equal(workflow.jobs.admission.steps.find((step) => step.id === 'claim').env.E2E_SCHEDULE_KIND, kind);
    assert.equal(workflow.jobs.admission.steps.find((step) => step.id === 'claim').env.E2E_SCHEDULE_ENABLED_AT, '${{ vars.E2E_SCHEDULE_ENABLED_AT }}');
    assert.equal(workflow.jobs.e2e.needs, 'admission');
    assert.match(workflow.jobs.e2e.if, /admission\.outputs\.admitted == 'true'/);
    assert.equal(workflow.jobs.e2e.concurrency.group, 'ordering-e2e-suite');
    assert.equal(workflow.concurrency, undefined);
  }
  const publisher = load('publish-reports.yml');
  const receipt = publisher.jobs.publish.steps.find((step) => step.id === 'admission');
  assert.match(receipt.run, /report_admission\.py/);
  const notification = publisher.jobs.publish.steps.find((step) => step.run?.includes('notify-slack.py'));
  assert.match(notification.if, /admission\.outputs\.publish != 'false'/);
  assert.equal(notification.env.E2E_EXECUTION_BLOCKED, '${{ steps.admission.outputs.blocked }}');
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
  assert.equal(notify.env.E2E_REPORT_DEPLOY_STATUS, '${{ steps.deployment.outcome }}');
  assert.equal(notify.env.E2E_REPORT_VERIFY_STATUS, '${{ steps.verify.outputs.status }}');
  assert.equal(notify.env.E2E_REPORT_ARTIFACT_STATUS, '${{ steps.retained.outcome }}');
  assert.equal(notify.env.E2E_REPORT_ARTIFACT_RUN_ID, '${{ github.run_id }}');
  assert.equal(job.steps.find(step => step.id === 'verify')['timeout-minutes'], 6);
  assert.ok(job.steps.find(step => step.id === 'retained').uses.startsWith('actions/upload-artifact@'));
  assert.equal(notify.env.E2E_SOURCE_RUN_ATTEMPT, '${{ steps.source.outputs.attempt }}');
  assert.equal(notify.env.E2E_REPORT_BASE_URL, '${{ steps.deployment.outputs.page_url }}');
  assert.ok(job.steps.findIndex((step) => step.id === 'verify') < job.steps.indexOf(notify));
});


test('static browser checks use the accepted pinned image with both checks and bounded setup', () => {
  const workflow = load('verify-pr.yml');
  const browser = workflow.jobs.static.steps.find(step => step.name === 'Check loopback browsers in the pinned Playwright image');
  assert.ok(browser);
  const image = browser.run.match(/mcr\.microsoft\.com\/playwright:v[\d.]+-noble/)[0];
  assert.equal(image, workflow.jobs.acceptance.container.image);
  assert.ok(browser.run.includes('npm run test:diagnostics:browser && npm run test:location:browser && npm run test:reports:browser'));
  assert.match(browser.run, /docker run --rm --init --ipc=host/);
  assert.match(browser.run, /-v "\$PWD:\/work" -w \/work/);
  assert.ok(!workflow.jobs.static.steps.some(step => step.run?.includes('playwright install --with-deps')));
  assert.equal(browser['timeout-minutes'], 5);
  assert.equal(workflow.jobs.static['timeout-minutes'], 15);
  assert.ok(workflow.jobs.static.steps.some(step => step.shell === 'pwsh'));
});
