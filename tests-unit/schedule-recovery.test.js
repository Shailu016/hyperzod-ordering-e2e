const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SCHEDULES, recentSlots, mostRecentDue, admissionSlot, recoveryPlan, slotRef, slotTitle } = require('../utils/schedule');
const { claimSlot, pruneClaims } = require('../utils/schedule-claims');
const { githubAPI, workflowRuns, verifyWorkflowRun, readClaimOwner } = require('../utils/schedule-api');
const { admit, rejectionReason } = require('../scripts/admit-schedule');

const due = '2026-10-15T07:30:00.000Z';
const now = new Date('2026-10-15T10:00:00Z');
const sha = 'a'.repeat(40);
const claim = (runId = '100', attempt = '1', slot = due) => ({ protocol: 'slots-v1', kind: 'smoke', due: slot, runId, attempt, sha });
const httpError = (status) => Object.assign(new Error('HTTP ' + status), { status });

test('admission rejection codes never forward arbitrary API errors or credentials', () => {
  assert.equal(rejectionReason(new Error('Slot does not match this workflow schedule')), 'invalid-slot');
  assert.equal(rejectionReason(new Error('Scheduled recovery cannot override suite or target')), 'invalid-overrides');
  assert.equal(rejectionReason(new Error('A future scheduled slot cannot execute')), 'future-slot');
  assert.equal(rejectionReason(new Error('Scheduled run identity mismatch')), 'identity-mismatch');
  assert.equal(rejectionReason(Object.assign(new Error('Bearer private'), {status: 503})), 'github-api');
  assert.equal(rejectionReason(new Error('token=private\nrejected=true')), 'unknown');
});

test('old Worker 6 PM dispatch expires before creating any ownership claim or tests', async () => {
  const source = {id: 40193767998, run_attempt: 1, head_sha: sha, workflow_id: 375425968,
    path: '.github/workflows/scheduled-e2e.yml', event: 'workflow_dispatch', head_branch: 'main', created_at: '2026-10-25T12:35:17Z'};
  const environment = {E2E_SCHEDULE_KIND: 'full', GITHUB_RUN_ID: String(source.id), GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main'};
  const calls = [];
  const api = async (route, method = 'GET') => {
    calls.push({route, method});
    if (route === 'actions/runs/' + source.id) return source;
    if (route === 'actions/workflows/scheduled-e2e.yml') return {id: source.workflow_id, path: source.path};
    throw new Error('A retired slot must not claim execution: ' + route);
  };
  const result = await admit({environment, event: {inputs: {suite: 'all', schedule_slot: '2026-10-25T12:30:00.000Z'}}, api, now: new Date('2026-10-25T12:35:24Z')});
  assert.equal(result.status, 'expired');
  assert.equal(result.admitted, false);
  assert.ok(calls.every(call => call.method === 'GET' && call.route.startsWith('actions/')));
  await assert.rejects(admit({environment: {...environment, GITHUB_REF: 'refs/heads/feature'}, event: {inputs: {suite: 'all', schedule_slot: result.due}}, api, now: new Date('2026-10-25T12:35:24Z')}), /only on main/);
});
function fakeClaims() {
  const refs = new Map(), tags = new Map();
  let counter = 1;
  const api = async (path, method = 'GET', body) => {
    if (path === 'git/tags' && method === 'POST') {
      const id = String(counter++).padStart(40, '0');
      tags.set(id, { tag: body.tag, message: body.message, object: { sha: body.object, type: 'commit' } });
      return { sha: id };
    }
    if (path === 'git/refs' && method === 'POST') {
      if (refs.has(body.ref)) throw httpError(422);
      refs.set(body.ref, body.sha);
      return { ref: body.ref };
    }
    if (path.startsWith('git/ref/tags/')) {
      const key = 'refs/tags/' + path.slice('git/ref/tags/'.length);
      if (!refs.has(key)) throw httpError(404);
      return { ref: key, object: { type: 'tag', sha: refs.get(key) } };
    }
    if (path.startsWith('git/tags/')) return tags.get(path.slice('git/tags/'.length));
    if (path === 'git/matching-refs/tags/e2e-schedule-') return [...refs].map(([ref, sha]) => ({ ref, object: { type: 'tag', sha } }));
    if (path.startsWith('actions/runs/')) return { status: 'completed' };
    throw new Error('Unexpected fake API path: ' + path);
  };
  api.deleteRefExact = async (ref, expected) => {
    assert.equal(refs.get(ref), expected);
    refs.delete(ref);
  };
  return { api, refs, tags };
}

test('shared schedule preserves the four original odd-hour claims and UTC date rollover', () => {
  assert.equal(SCHEDULES.smoke.crons.length, 4);
  assert.equal(mostRecentDue(SCHEDULES.smoke.crons, new Date('2026-10-14T20:00:00Z')).toISOString(), '2026-10-14T19:30:00.000Z');
  assert.deepEqual(recentSlots(SCHEDULES.smoke.crons, new Date('2026-10-15T01:00:00Z')), [
    '2026-10-14T19:30:00.000Z', '2026-10-14T21:30:00.000Z', '2026-10-14T23:30:00.000Z',
  ]);
});

test('independent recovery catches the screenshot incident without treating a morning manual pass as coverage', () => {
  const plan = recoveryPlan({ kind: 'smoke', now, enabledAt: '2026-10-14T00:00:00Z', runs: [
    { event: 'workflow_dispatch', head_branch: 'main', created_at: '2026-10-15T05:02:48Z', display_title: 'Ordering smoke · manual', status: 'completed', conclusion: 'success' },
  ] });
  assert.deepEqual(plan, [due]);
});

test('queued, running, passed and failed executions of the exact slot all prevent replays', () => {
  for (const status of ['queued', 'in_progress', 'completed']) {
    for (const conclusion of [null, 'success', 'failure']) {
      const runs = [{ event: 'workflow_dispatch', head_branch: 'main', display_title: slotTitle('smoke', due), status, conclusion }];
      assert.deepEqual(recoveryPlan({ kind: 'smoke', now, enabledAt: due, runs }), []);
    }
  }
});

test('a different slot, device, branch or legacy title never satisfies missing scheduled coverage', () => {
  for (const change of [{ display_title: slotTitle('full', '2026-10-15T13:30:00.000Z') }, { head_branch: 'feature' }, { display_title: 'scheduled-e2e-smoke' }]) {
    const run = { event: 'workflow_dispatch', head_branch: 'main', display_title: slotTitle('smoke', due), ...change };
    assert.deepEqual(recoveryPlan({ kind: 'smoke', now, enabledAt: due, runs: [run] }), [due]);
  }
});

test('native fallback matches its specific cron rather than borrowing another delayed slot', () => {
  const run = { event: 'schedule', head_branch: 'main', created_at: '2026-10-15T09:00:00Z', display_title: 'Ordering smoke · native 30 7 * * *' };
  assert.deepEqual(recoveryPlan({ kind: 'smoke', now, enabledAt: due, runs: [run] }), []);
  assert.deepEqual(recoveryPlan({ kind: 'smoke', now, enabledAt: due, runs: [{ ...run, display_title: 'Ordering smoke · native 30 23 * * *' }] }), [due]);
});

test('cutover, a two-minute native grace, and six-hour recovery bounds prevent startup bursts', () => {
  assert.deepEqual(recoveryPlan({ kind: 'smoke', now, enabledAt: '2026-10-15T09:00:00Z', runs: [] }), []);
  assert.deepEqual(recoveryPlan({ kind: 'smoke', now: new Date('2026-10-15T07:31:00Z'), enabledAt: due, runs: [] }), []);
  assert.deepEqual(recoveryPlan({ kind: 'smoke', now: new Date('2026-10-15T14:00:00Z'), enabledAt: due, runs: [] }), []);
});

test('scheduled admission validates suite, target, timestamp and event before touching the store', () => {
  const base = { kind: 'smoke', event: 'workflow_dispatch', requestedSlot: due, suite: 'smoke', baseUrl: '', now, createdAt: now };
  assert.deepEqual(admissionSlot(base), { mode: 'scheduled', due });
  for (const change of [{ suite: 'android' }, { baseUrl: 'https://other.invalid' }, { requestedSlot: '../escape' }, { requestedSlot: '2026-10-15T08:30:00.000Z' }, { now: new Date('2026-10-15T07:00:00Z') }, { event: 'pull_request' }]) {
    assert.throws(() => admissionSlot({ ...base, ...change }));
  }
  assert.equal(admissionSlot({ ...base, now: new Date('2026-10-15T15:00:00Z') }).mode, 'expired');
  assert.equal(admissionSlot({ ...base, requestedSlot: '' }).mode, 'manual');
  assert.equal(admissionSlot({ ...base, event: 'schedule', eventSchedule: '30 7 * * *', createdAt: new Date('2026-10-15T09:00:00Z') }).due, due);
});

test('two simultaneous clocks admit exactly one scheduled execution', async () => {
  const { api } = fakeClaims();
  const results = await Promise.all([claimSlot(api, claim('100')), claimSlot(api, claim('200'))]);
  assert.equal(results.filter((item) => item.admitted).length, 1);
  assert.equal(results[0].claim.runId, results[1].claim.runId);
});

test('late GitHub cron, worker retries and rerun attempts cannot replay an owned slot', async () => {
  const { api } = fakeClaims();
  assert.equal((await claimSlot(api, claim())).admitted, true);
  assert.equal((await claimSlot(api, claim())).admitted, true, 'same owner can reconcile a lost API acknowledgement');
  assert.equal((await claimSlot(api, claim('200'))).admitted, false);
  assert.equal((await claimSlot(api, claim('100', '2'))).admitted, false);
});

test('ambiguous claim POST reconciles an accepted ref and otherwise fails closed', async () => {
  const { api } = fakeClaims();
  const uncertain = async (...args) => {
    const result = await api(...args);
    if (args[0] === 'git/refs') throw new Error('Connection lost after acceptance');
    return result;
  };
  assert.equal((await claimSlot(uncertain, claim())).admitted, true);
  const empty = fakeClaims();
  const failed = async (...args) => { if (args[0] === 'git/refs') throw new Error('Connection unavailable'); return empty.api(...args); };
  await assert.rejects(claimSlot(failed, claim()), /Connection unavailable/);
});

test('claim pruning affects only validated expired scheduler refs and uses compare-and-delete', async () => {
  const { api, refs } = fakeClaims();
  await claimSlot(api, claim('100', '1', '2026-09-30T07:30:00.000Z'));
  await claimSlot(api, claim('200'));
  refs.set('refs/tags/release-v1', 'b'.repeat(40));
  refs.set('refs/tags/e2e-lease-' + 'a'.repeat(24), 'c'.repeat(40));
  assert.equal(await pruneClaims(api, now), 1);
  assert.equal(refs.size, 3);
  assert.ok(refs.has('refs/tags/' + slotRef('smoke', due)));
});

test('admission verifies the workflow source identity and rejects non-main scheduled execution', async () => {
  const { api } = fakeClaims();
  const source = { id: 100, run_attempt: 1, head_sha: sha, name: 'Ordering smoke · slot ' + due, workflow_id: 375425965, path: '.github/workflows/scheduled-e2e-smoke.yml', event: 'workflow_dispatch', head_branch: 'main', created_at: '2026-10-15T09:00:00Z' };
  const combined = (path, ...rest) => path === 'actions/runs/100' ? source : path === 'actions/workflows/scheduled-e2e-smoke.yml' ? { id: 375425965, path: source.path } : api(path, ...rest);
  const environment = { E2E_SCHEDULE_KIND: 'smoke', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' };
  const event = { inputs: { suite: 'smoke', schedule_slot: due } };
  const result = await admit({ environment, event, api: combined, now });
  assert.equal(result.status, 'claimed');
  await assert.rejects(admit({ environment: { ...environment, GITHUB_REF: 'refs/heads/feature' }, event, api: combined, now }), /only on main/);
  await assert.rejects(admit({ environment: { ...environment, GITHUB_RUN_ATTEMPT: '2' }, event, api: combined, now }), /identity mismatch/);
});

test('scheduler API refuses redirects and never dispatches after incomplete history', async () => {
  const observed = [];
  const api = githubAPI({ repository: 'Owner/Repo', token: 'fixture-only', request: async (url, options) => {
    observed.push({ url, options });
    return { ok: true, json: async () => ({ workflow_runs: [] }) };
  } });
  assert.deepEqual(await workflowRuns(api, 'scheduled-e2e-smoke.yml', now), []);
  assert.equal(observed[0].options.redirect, 'manual');
  assert.throws(() => api('../escape'));
  let pages = 0;
  await assert.rejects(workflowRuns(async () => { pages++; return { workflow_runs: Array.from({ length: 100 }, () => ({ created_at: now.toISOString() })) }; }, 'scheduled-e2e-smoke.yml', now), /inspection budget/);
  assert.equal(pages, 5);
});

test('real GitHub dynamic run names never determine execution identity', async () => {
  const source = { workflow_id: 375425965, path: '.github/workflows/scheduled-e2e-smoke.yml', name: 'Ordering smoke · native 30 21 * * *' };
  const definition = { id: 375425965, path: source.path };
  const api = async (route) => { assert.equal(route, 'actions/workflows/scheduled-e2e-smoke.yml'); return definition; };
  await verifyWorkflowRun(api, source, 'scheduled-e2e-smoke.yml');
  for (const change of [{ workflow_id: 375425968 }, { path: '.github/workflows/evil.yml' }, { workflow_id: '375425965' }]) {
    await assert.rejects(verifyWorkflowRun(api, { ...source, ...change }, 'scheduled-e2e-smoke.yml'), /identity mismatch/);
  }
  await assert.rejects(verifyWorkflowRun(api, source, '../scheduled-e2e-smoke.yml'), /Unknown scheduled workflow/);
});

test('manual and native admission accept descriptive titles but reject a spoofed workflow ID', async () => {
  const environment = { E2E_SCHEDULE_KIND: 'smoke', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main' };
  const source = { id: 100, run_attempt: 1, head_sha: sha, name: 'Ordering smoke · native 30 7 * * *', workflow_id: 375425965, path: '.github/workflows/scheduled-e2e-smoke.yml', event: 'schedule', head_branch: 'main', created_at: '2026-10-15T09:00:00Z' };
  const { api } = fakeClaims();
  const combined = (route, ...rest) => route === 'actions/runs/100' ? source : route === 'actions/workflows/scheduled-e2e-smoke.yml' ? { id: 375425965, path: source.path } : api(route, ...rest);
  assert.equal((await admit({ environment, event: { schedule: '30 7 * * *' }, api: combined, now })).status, 'claimed');
  source.event = 'workflow_dispatch'; source.name = 'Ordering smoke · manual';
  assert.equal((await admit({ environment: { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' }, event: { inputs: {} }, api: combined, now })).status, 'manual');
  source.workflow_id = 999;
  await assert.rejects(admit({ environment: { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' }, event: { inputs: {} }, api: combined, now }), /identity mismatch/);
});

test('scheduler API rejects redirect responses without following or retrying them', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const api = githubAPI({ repository: 'Owner/Repo', token: 'fixture-only', request: async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return { ok: false, status };
    } });
    await assert.rejects(api('actions/workflows/scheduled-e2e-smoke.yml/dispatches', 'POST', { ref: 'main' }), /HTTP 30/);
    assert.equal(calls, 1);
  }
});

test('monitor verifies the exact claimed attempt, independent of dynamic titles and later reruns', async () => {
  const source = { id: 100, run_attempt: 1, head_sha: sha, head_branch: 'main', workflow_id: 375425965, path: '.github/workflows/scheduled-e2e-smoke.yml', name: 'Ordering smoke · native 30 21 * * *' };
  const api = async route => {
    if (route === 'actions/runs/100/attempts/1') return source;
    assert.equal(route, 'actions/workflows/scheduled-e2e-smoke.yml');
    return { id: 375425965, path: source.path };
  };
  assert.equal(await readClaimOwner(api, claim(), 'scheduled-e2e-smoke.yml'), source);
  for (const [field, value] of [['id', 101], ['run_attempt', 2], ['head_sha', 'b'.repeat(40)], ['head_branch', 'feature']]) {
    const old = source[field]; source[field] = value;
    await assert.rejects(readClaimOwner(api, claim(), 'scheduled-e2e-smoke.yml'), /verifiable workflow owner/);
    source[field] = old;
  }
});


test('retired 6 PM ownership stays verifiable and can expire without authorizing another execution', async () => {
  const { readClaim } = require('../utils/schedule-claims');
  const { api, refs } = fakeClaims();
  const record = { protocol: 'slots-v1', kind: 'full', due: '2026-09-30T12:30:00.000Z', runId: '321', attempt: '1', sha };
  const name = slotRef(record.kind, record.due);
  const tag = await api('git/tags', 'POST', { tag: name, message: JSON.stringify(record), object: sha });
  await api('git/refs', 'POST', { ref: 'refs/tags/' + name, sha: tag.sha });
  assert.equal((await readClaim(api, record.kind, record.due)).runId, '321');
  await assert.rejects(claimSlot(api, record), /Slot does not match/);
  assert.equal(await pruneClaims(api, now), 1);
  assert.equal(refs.size, 0);
});
