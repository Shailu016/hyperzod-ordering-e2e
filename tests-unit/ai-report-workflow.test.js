const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const root = path.resolve(__dirname, '..');

test('Gemini secret is isolated to trusted report preparation, outside test execution and Slack delivery', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/publish-reports.yml'), 'utf8'));
  const job = workflow.jobs.publish;
  assert.match(job.if, /head_branch == 'main'/);
  assert.match(job.if, /head_repository.full_name == github.repository/);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, 'main');
  assert.equal(checkout.with['persist-credentials'], false);
  const consumers = job.steps.filter(step => JSON.stringify(step).includes('secrets.GEMINI_API_KEY'));
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].id, 'prepare');
  assert.match(consumers[0].run, /report_site.py prepare/);
  const notify = job.steps.find(step => step.run?.includes('notify-slack.py'));
  assert.match(notify.if, /^always\(\)/);
  assert.equal(notify.env.GEMINI_API_KEY, undefined);
  for (const file of ['scheduled-e2e.yml', 'scheduled-e2e-smoke.yml', 'verify-pr.yml', 'schedule-freshness.yml']) {
    assert.ok(!fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8').includes('GEMINI_API_KEY'));
  }
});
