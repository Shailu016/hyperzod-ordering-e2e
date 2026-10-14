const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mostRecentDue, assessSchedule, notificationPlan } = require('../scripts/check-schedule');
test('UTC schedule converts to the correct 1 PM IST instant', () => {
  assert.equal(mostRecentDue(['30 7 * * *'], new Date('2026-10-06T09:00:00Z')).toISOString(), '2026-10-06T07:30:00.000Z');
});

test('the screenshot is a delayed full schedule, not failed test evidence', () => {
  const result = assessSchedule({ crons: ['30 12 * * *'], now: new Date('2026-10-14T14:49:07Z'), enabledAt: '2026-10-13T00:00:00Z',
    runs: [{ id: 38454937597, event: 'schedule', created_at: '2026-10-13T19:27:11Z', status: 'completed', conclusion: 'success' }] });
  assert.equal(result.reason, 'missing');
  assert.equal(result.due, '2026-10-14T12:30:00.000Z');
  assert.match(result.issues[0], /IST.*GitHub has not created/);
  assert.match(result.issues[0], /not a storefront test result/);
});

test('completed failed tests are reported by the E2E workflow, not repeated as freshness failures', () => {
  const base = { crons: ['30 12 * * *'], now: new Date('2026-10-14T15:00:00Z'), enabledAt: '2026-10-13T00:00:00Z' };
  const run = { id: 1, event: 'schedule', created_at: '2026-10-14T13:00:00Z', status: 'completed', conclusion: 'failure' };
  assert.equal(assessSchedule({ ...base, runs: [run] }), null);
  assert.equal(assessSchedule({ ...base, runs: [{ ...run, conclusion: 'cancelled' }] }).reason, 'cancelled');
  assert.equal(assessSchedule({ ...base, runs: [{ ...run, event: 'workflow_dispatch' }] }).reason, 'missing');
  assert.equal(assessSchedule({ ...base, runs: [{ ...run, created_at: '2026-10-14T16:00:00Z' }] }).reason, 'missing');
});

test('active runs have an execution allowance and become overdue instead of missing', () => {
  const base = { crons: ['30 12 * * *'], now: new Date('2026-10-14T15:00:00Z'), enabledAt: '2026-10-13T00:00:00Z' };
  const run = { id: 1, event: 'schedule', created_at: '2026-10-14T14:00:00Z', status: 'in_progress' };
  assert.equal(assessSchedule({ ...base, runs: [run] }), null);
  assert.equal(assessSchedule({ ...base, runs: [{ ...run, created_at: '2026-10-14T13:00:00Z' }] }).reason, 'overdue');
});

test('one acknowledged slot never repeats when its run ID or another workflow changes', () => {
  const now = new Date('2026-10-14T15:00:00Z');
  const full = { file: 'full.yml', due: '2026-10-14T12:30:00Z' };
  const smoke = { file: 'smoke.yml', due: '2026-10-14T07:30:00Z' };
  const first = notificationPlan([full, smoke], {}, now);
  assert.equal(first.fresh.length, 2);
  // No delivery acknowledgement: retain both for a later delivery attempt.
  assert.equal(notificationPlan([full, smoke], first.current, now).fresh.length, 2);
  assert.equal(notificationPlan([{ ...full, runId: 123 }], first.pending, now).fresh.length, 0);
  const recovered = notificationPlan([], first.pending, now).current;
  assert.equal(notificationPlan([full], recovered, now).fresh.length, 0);
  const next = { ...full, due: '2026-10-15T12:30:00Z' };
  assert.equal(notificationPlan([next], recovered, new Date('2026-10-15T15:00:00Z')).fresh.length, 1);
});

test('expired deduplication history is bounded and invalid cron inputs fail', () => {
  assert.deepEqual(notificationPlan([], { acknowledged: { old: '2026-09-01T00:00:00Z' } }, new Date('2026-10-14T15:00:00Z')).current.acknowledged, {});
  for (const crons of [[], ['60 12 * * *'], ['30 24 * * *'], ['not a cron']]) assert.throws(() => mostRecentDue(crons, new Date()));
});

test('matching legacy acknowledgement migrates without another notification', () => {
  const incidents = [{ file: 'full.yml', due: '2026-10-14T12:30:00Z' }];
  const fingerprint = require('node:crypto').createHash('sha256').update(JSON.stringify([['full.yml', incidents[0].due, 'missing']])).digest('hex');
  const plan = notificationPlan(incidents, { fingerprint }, new Date('2026-10-14T15:00:00Z'));
  assert.equal(plan.fresh.length, 0);
  assert.equal(Object.keys(plan.current.acknowledged).length, 1);
});
test('freshness grace, rollout and completed runs suppress unnecessary alerts', () => {
  const base = { crons: ['30 7 * * *'], now: new Date('2026-10-06T09:00:00Z'), enabledAt: '2026-10-05T00:00:00Z', runs: [] };
  assert.ok(assessSchedule(base));
  assert.equal(assessSchedule({ ...base, now: new Date('2026-10-06T07:35:00Z') }), null);
  assert.equal(assessSchedule({ ...base, enabledAt: '2026-10-06T08:00:00Z' }), null);
  assert.equal(assessSchedule({ ...base, runs: [{ event: 'schedule', created_at: '2026-10-06T07:40:00Z', status: 'completed', conclusion: 'success' }] }), null);
});
