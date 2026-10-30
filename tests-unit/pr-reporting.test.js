const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

test('storefront verification stays observable without a release gate or failure waiver', () => {
  const workflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/verify-pr.yml'), 'utf8'));
  assert.ok(workflow.jobs.static);
  assert.equal(workflow.jobs['release-gate'], undefined);
  const live = workflow.jobs.acceptance;
  assert.match(live.if, /head.repo.full_name == github.repository/);
  assert.equal(live.env.E2E_ISOLATED_IDENTITY, 'true');
  const suite = live.steps.find(step => step.run === 'npm test');
  assert.ok(suite);
  assert.equal(suite['continue-on-error'], undefined);
  assert.ok(live.steps.some(step => step.if === 'always()' && step.uses?.startsWith('actions/upload-artifact@')));
  assert.ok(live.steps.every(step => !step.run?.includes('check-pr-acceptance')));
});
