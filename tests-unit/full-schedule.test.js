const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { SCHEDULES, executionSuite, admissionSlot, recoveryPlan, slotRef, slotTitle } = require('../utils/schedule');
const due = '2026-10-17T07:30:00.000Z';

test('all twelve daily slots use the full suite at exact two-hour IST intervals', () => {
  const times = [];
  for (const config of Object.values(SCHEDULES)) {
    assert.equal(config.suite, 'all');
    for (const cron of config.crons) {
      const [minute, hour] = cron.split(' ').map(Number);
      times.push((hour * 60 + minute + 330) % 1440);
    }
  }
  assert.deepEqual(times.sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => 60 + index * 120));
});

test('native and recovered slots always execute full coverage, including old Worker input', () => {
  for (const kind of Object.keys(SCHEDULES)) {
    assert.equal(executionSuite({ kind, event: 'schedule' }), 'all');
    const requestedSlot = kind === 'smoke' ? due : '2026-10-17T13:30:00.000Z';
    assert.equal(executionSuite({ kind, event: 'workflow_dispatch', requestedSlot, requestedSuite: 'all' }), 'all');
  }
  const legacy = { kind: 'smoke', event: 'workflow_dispatch', requestedSlot: due, suite: 'smoke', now: '2026-10-17T07:35:00.000Z' };
  assert.equal(admissionSlot(legacy).mode, 'scheduled');
  assert.equal(admissionSlot({ ...legacy, suite: 'all' }).mode, 'scheduled');
  assert.equal(executionSuite({ ...legacy, requestedSuite: legacy.suite }), 'all');
  assert.throws(() => admissionSlot({ ...legacy, kind: 'full', requestedSlot: '2026-10-17T13:30:00.000Z', now: '2026-10-17T13:35:00.000Z' }));
});

test('explicit manual suites remain available and invalid executions fail closed', () => {
  for (const requestedSuite of ['all', 'smoke', 'web', 'android', 'ios', 'mobile']) {
    assert.equal(executionSuite({ kind: 'smoke', event: 'workflow_dispatch', requestedSuite }), requestedSuite);
  }
  for (const input of [{ kind: 'unknown', event: 'schedule' }, { kind: 'full', event: 'push' }, { kind: 'full', event: 'workflow_dispatch', requestedSuite: 'typo' }]) {
    assert.throws(() => executionSuite(input));
  }
});

test('coverage migration retains slot claims and recognizes both old and new run titles', () => {
  assert.equal(slotRef('smoke', due), 'e2e-schedule-smoke-20261017T073000000Z');
  assert.equal(slotTitle('smoke', due), 'Ordering full · slot ' + due);
  for (const label of ['smoke', 'full']) {
    for (const status of ['queued', 'in_progress', 'completed']) {
      for (const event of ['schedule', 'workflow_dispatch']) {
        const run = { head_branch: 'main', created_at: '2026-10-17T07:35:00.000Z', event, status,
          display_title: 'Ordering ' + label + (event === 'schedule' ? ' · native 30 7 * * *' : ' · slot ' + due) };
        assert.deepEqual(recoveryPlan({ kind: 'smoke', now: '2026-10-17T07:40:00.000Z', enabledAt: due, runs: [run] }), []);
      }
    }
  }
});

test('both workflows resolve automatic coverage before execution with full defaults and timeouts', () => {
  for (const [kind, config] of Object.entries(SCHEDULES)) {
    const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows', config.workflow), 'utf8'));
    assert.equal(workflow.on.workflow_dispatch.inputs.suite.default, 'all');
    assert.ok(workflow.jobs.e2e['timeout-minutes'] >= 90);
    const steps = workflow.jobs.e2e.steps;
    const resolver = steps.find(step => step.id === 'suite');
    assert.equal(resolver.run, 'node scripts/resolve-scheduled-suite.js');
    assert.equal(resolver.env.E2E_SCHEDULE_KIND, kind);
    assert.equal(resolver.env.E2E_SCHEDULE_SLOT, '${{ inputs.schedule_slot }}');
    assert.equal(resolver.env.E2E_REQUESTED_SUITE, '${{ inputs.suite }}');
    const run = steps.find(step => step.run?.includes('run-suite.js'));
    assert.equal(run.env.E2E_SUITE, '${{ steps.suite.outputs.name }}');
    assert.ok(steps.indexOf(resolver) < steps.indexOf(run));
    assert.match(workflow['run-name'], /Ordering full · slot/);
  }
});

test('suite resolution CLI emits a real Actions output for a legacy recovery dispatch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-full-suite-'));
  try {
    const output = path.join(directory, 'output');
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/resolve-scheduled-suite.js')], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', E2E_SCHEDULE_KIND: 'smoke',
        E2E_SCHEDULE_SLOT: due, E2E_REQUESTED_SUITE: 'smoke', GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), 'name=all\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('two-hour cadence stays continuous across UTC/IST midnight with one owner per slot', () => {
  const { recentSlots } = require('../utils/schedule');
  const now = new Date('2026-10-24T00:00:00Z');
  const slots = Object.entries(SCHEDULES).flatMap(([kind, config]) => recentSlots(config.crons, now, 48 * 60 * 60_000).map(due => ({ kind, due }))).sort((a, b) => a.due.localeCompare(b.due));
  assert.equal(slots.length, 24);
  assert.equal(new Set(slots.map(slot => slot.due)).size, slots.length);
  for (let index = 1; index < slots.length; index++) assert.equal(Date.parse(slots[index].due) - Date.parse(slots[index - 1].due), 2 * 60 * 60_000);
  for (const { kind, due } of slots) {
    const eventSchedule = `${new Date(due).getUTCMinutes()} ${new Date(due).getUTCHours()} * * *`;
    const base = { kind, suite: 'all', now: new Date(Date.parse(due) + 5 * 60_000), createdAt: due };
    const native = admissionSlot({ ...base, event: 'schedule', eventSchedule });
    const recovery = admissionSlot({ ...base, event: 'workflow_dispatch', requestedSlot: due });
    assert.equal(native.due, recovery.due);
    assert.equal(slotRef(kind, native.due), slotRef(kind, recovery.due));
  }
});

test('cadence rollout starts with the next new slot rather than backfilling earlier hours', () => {
  const base = { kind: 'full', enabledAt: '2026-10-23T12:45:00.000Z', runs: [] };
  assert.deepEqual(recoveryPlan({ ...base, now: '2026-10-23T13:00:00.000Z' }), []);
  assert.deepEqual(recoveryPlan({ ...base, now: '2026-10-23T13:31:00.000Z' }), []);
  const next = '2026-10-23T13:30:00.000Z';
  assert.deepEqual(recoveryPlan({ ...base, now: '2026-10-23T13:35:00.000Z' }), [next]);
  const runs = [{ event: 'workflow_dispatch', head_branch: 'main', display_title: slotTitle('full', next), status: 'queued' }];
  assert.deepEqual(recoveryPlan({ ...base, runs, now: '2026-10-23T13:40:00.000Z' }), []);
});

test('retired 6 PM cron and dispatch cannot admit a new run', () => {
  const base = { kind: 'full', suite: 'all', now: '2026-10-23T12:35:00.000Z', createdAt: '2026-10-23T12:35:00.000Z' };
  assert.deepEqual(admissionSlot({ ...base, event: 'schedule', eventSchedule: '30 12 * * *' }), { mode: 'expired', due: '2026-10-23T12:30:00.000Z' });
  assert.throws(() => admissionSlot({ ...base, event: 'workflow_dispatch', requestedSlot: '2026-10-23T12:30:00.000Z' }), /Slot does not match/);
});


test('both clocks suppress pre-cutover slots while post-cutover and manual runs remain available', () => {
  const due = '2026-10-23T13:30:00.000Z';
  const base = { kind: 'full', suite: 'all', now: '2026-10-23T13:35:00.000Z', createdAt: '2026-10-23T13:35:00.000Z' };
  for (const event of [{ event: 'schedule', eventSchedule: '30 13 * * *' }, { event: 'workflow_dispatch', requestedSlot: due }]) {
    assert.deepEqual(admissionSlot({ ...base, ...event, enabledAt: '2026-10-23T13:31:00.000Z' }), { mode: 'expired', due });
    assert.equal(admissionSlot({ ...base, ...event, enabledAt: due }).mode, 'scheduled');
    assert.throws(() => admissionSlot({ ...base, ...event, enabledAt: 'invalid' }), /Invalid schedule timestamp/);
  }
  assert.equal(admissionSlot({ ...base, event: 'workflow_dispatch', enabledAt: '2026-10-23T13:31:00.000Z' }).mode, 'manual');
});
