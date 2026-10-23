const fs = require('node:fs');
const { admissionSlot, SCHEDULES } = require('../utils/schedule');
const { claimSlot, pruneClaims } = require('../utils/schedule-claims');
const { githubAPI, verifyWorkflowRun } = require('../utils/schedule-api');

async function admit({ environment = process.env, event, api, now = new Date() }) {
  const kind = environment.E2E_SCHEDULE_KIND;
  const identity = { protocol: 'slots-v1', runId: String(environment.GITHUB_RUN_ID), attempt: String(environment.GITHUB_RUN_ATTEMPT), sha: environment.GITHUB_SHA, kind };
  const source = await api(`actions/runs/${identity.runId}`);
  if (String(source.id) !== identity.runId || String(source.run_attempt) !== identity.attempt || source.head_sha !== identity.sha || source.event !== environment.GITHUB_EVENT_NAME) throw new Error('Scheduled run identity mismatch');
  await verifyWorkflowRun(api, source, SCHEDULES[kind]?.workflow);
  const slot = admissionSlot({ kind, event: environment.GITHUB_EVENT_NAME, eventSchedule: event.schedule,
    requestedSlot: event.inputs?.schedule_slot, suite: event.inputs?.suite, baseUrl: event.inputs?.base_url,
    createdAt: source.created_at, now, enabledAt: environment.E2E_SCHEDULE_ENABLED_AT });
  if (slot.mode === 'manual') return { ...identity, status: 'manual', admitted: true, due: null };
  if (source.head_branch !== 'main' || environment.GITHUB_REF !== 'refs/heads/main') throw new Error('Scheduled slots can execute only on main');
  if (slot.mode === 'expired') return { ...identity, due: slot.due, status: 'expired', admitted: false };
  const result = await claimSlot(api, { ...identity, due: slot.due });
  return { ...identity, due: slot.due, status: result.admitted ? 'claimed' : 'duplicate', admitted: result.admitted,
    ownerRunId: String(result.claim.runId), ownerAttempt: String(result.claim.attempt) };
}

async function main() {
  const env = process.env;
  fs.mkdirSync('.schedule', { recursive: true });
  const identity = { protocol: 'slots-v1', runId: String(env.GITHUB_RUN_ID), attempt: String(env.GITHUB_RUN_ATTEMPT), sha: env.GITHUB_SHA, kind: env.E2E_SCHEDULE_KIND };
  let receipt = { ...identity, status: 'error', admitted: false };
  try {
    if (!SCHEDULES[identity.kind]) throw new Error('Unknown schedule kind');
    const api = githubAPI({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN });
    receipt = await admit({ environment: env, event: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')), api });
    // Cleanup is metadata-only. Its failure must never replay or block an owned test.
    try { await pruneClaims(api, new Date()); } catch { console.warn('Schedule-claim cleanup failed; execution ownership remains intact'); }
    console.log(`Schedule admission: ${receipt.status}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally {
    fs.writeFileSync('.schedule/admission.json', JSON.stringify(receipt));
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `admitted=${receipt.admitted}\nstatus=${receipt.status}\n`);
  }
}

if (require.main === module) main();
module.exports = { githubAPI, admit };
