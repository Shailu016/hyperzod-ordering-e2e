const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration } = require('../scheduler/configure.cjs');

test('deployment configuration requires explicit account, App identity and cutover', () => {
  const values = ['a'.repeat(32), '123', '456', '2026-10-15T10:00:00.000Z'];
  const config = configuration(values);
  assert.equal(config.account_id, values[0]);
  assert.equal(config.vars.SCHEDULER_ENABLED, 'false');
  assert.equal(config.vars.GITHUB_APP_ID, '123');
  assert.equal(config.vars.GITHUB_INSTALLATION_ID, '456');
  assert.equal(config.vars.SCHEDULER_ENABLED_AT, values[3]);
  assert.match(config.main, /worker\.mjs$/);
  for (const change of [[undefined, ...values.slice(1)], [values[0], 'bad', ...values.slice(2)], [...values.slice(0, 3), 'invalid'], [...values, 'yes']]) {
    assert.throws(() => configuration(change));
  }
  assert.throws(() => configuration([...values, 'true'], new Date('2026-10-14T00:00:00Z')));
  assert.equal(configuration([...values, 'true'], new Date('2026-10-16T00:00:00Z')).vars.SCHEDULER_ENABLED, 'true');
});
