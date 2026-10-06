const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mostRecentDue, assessSchedule } = require('../scripts/check-schedule');
test('UTC schedule converts to the correct 1 PM IST instant', () => {
  assert.equal(mostRecentDue(['30 7 * * *'], new Date('2026-10-06T09:00:00Z')).toISOString(), '2026-10-06T07:30:00.000Z');
});
test('freshness grace, rollout and completed runs suppress unnecessary alerts', () => {
  const base = { crons: ['30 7 * * *'], now: new Date('2026-10-06T09:00:00Z'), enabledAt: '2026-10-05T00:00:00Z', runs: [] };
  assert.ok(assessSchedule(base));
  assert.equal(assessSchedule({ ...base, now: new Date('2026-10-06T07:35:00Z') }), null);
  assert.equal(assessSchedule({ ...base, enabledAt: '2026-10-06T08:00:00Z' }), null);
  assert.equal(assessSchedule({ ...base, runs: [{ event: 'schedule', created_at: '2026-10-06T07:40:00Z', status: 'completed', conclusion: 'success' }] }), null);
});
