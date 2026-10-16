const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SCHEDULES, timestamp, mostRecentDue, recentSlots, runMatchesSlot } = require('../utils/schedule');
const { readClaim } = require('../utils/schedule-claims');
const { githubAPI, workflowRuns, readClaimOwner } = require('../utils/schedule-api');
function assessSchedule({ crons, now, enabledAt, runs, graceMinutes = 45, kind, scheduledDue, owned = false }) {
  now = timestamp(now);
  enabledAt = timestamp(enabledAt);
  const due = scheduledDue ? timestamp(scheduledDue) : mostRecentDue(crons, now);
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) throw new Error('Invalid schedule grace period');
  if (due < enabledAt || Number(now) - Number(due) < graceMinutes * 60_000) return null;
  const matching = kind ? runs.filter((r) => (owned || runMatchesSlot(r, kind, due.toISOString())) && new Date(r.created_at) <= now) : runs.filter((r) => r.event === 'schedule' && new Date(r.created_at) >= due && new Date(r.created_at) <= now);
  // Execution freshness does not assess test success. Completed failures have
  // their own E2E result notification; do not report them again as missing runs.
  if ((!kind || owned) && matching.some((r) => r.status === 'completed' && ['success', 'failure', 'neutral'].includes(r.conclusion))) return null;
  const run = matching.sort((a,b) => Number(new Date(b.created_at)) - Number(new Date(a.created_at)))[0];
  if (run && run.status !== 'completed' && Number(now) - Number(new Date(run.created_at)) < 100 * 60_000) return null;
  const reason = !run ? 'missing' : run.status !== 'completed' ? 'overdue' : kind && !owned ? 'not-admitted' : run.conclusion || 'incomplete';
  const time = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(due);
  return { status: 'infrastructure-failed', suite: 'schedule freshness', reason,
    issues: [`Scheduled for ${time} IST: ${reason === 'missing' ? 'GitHub has not created a scheduled run yet (delayed or dropped trigger)' : reason === 'not-admitted' ? 'the run finished without acquiring permission to execute this scheduled slot; inspect its admission job' : `execution is ${reason}`}. This is a schedule alert, not a storefront test result.`],
    due: due.toISOString(), runId: run?.id };
}
function notificationPlan(incidents, previous = {}, now = new Date()) {
  const cutoff = Number(now) - 14 * 24 * 60 * 60_000;
  const acknowledged = Object.fromEntries(Object.entries(previous.acknowledged || {}).filter(([, due]) => Number(new Date(due)) >= cutoff));
  const key = (incident) => `${incident.file}:${incident.due}`;
  // Migrate an exactly matching acknowledged legacy fingerprint without
  // delivering the same alert once more when this correction is deployed.
  const legacy = crypto.createHash('sha256').update(JSON.stringify(incidents.map((i) => [i.file, i.due, i.runId || 'missing']))).digest('hex');
  if (previous.fingerprint === legacy) {
    for (const incident of incidents) acknowledged[key(incident)] = incident.due;
  }
  const fresh = incidents.filter((incident) => !Object.hasOwn(acknowledged, key(incident)));
  // Keep acknowledgement after recovery. A run ID/status change or recovery of
  // another workflow must not resend the same due-slot incident.
  const pending = { acknowledged: { ...acknowledged, ...Object.fromEntries(fresh.map((incident) => [key(incident), incident.due])) } };
  return { fresh, current: { acknowledged }, pending };
}
async function main() {
  fs.mkdirSync('.monitor', { recursive: true });
  if (process.argv.includes('--ack')) {
    fs.copyFileSync('.monitor/pending.json', '.monitor/state.json');
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY || 'Shailu016/hyperzod-ordering-e2e';
  const api = githubAPI({ repository, token: process.env.GITHUB_TOKEN });
  const incidents = [];
  const now = new Date();
  for (const [kind, config] of Object.entries(SCHEDULES)) {
    const commits = await api(`commits?path=.github/workflows/${config.workflow}&per_page=1`);
    const enabledAt = timestamp(process.env.E2E_SCHEDULE_ENABLED_AT || commits[0].commit.committer.date);
    const history = await workflowRuns(api, config.workflow, new Date(Number(now) - 24 * 60 * 60_000));
    for (const due of recentSlots(config.crons, now, 24 * 60 * 60_000)) {
      if (new Date(due) < new Date(enabledAt) || Number(now) - Date.parse(due) < 45 * 60_000) continue;
      const claim = await readClaim(api, kind, due);
      let runs = history;
      if (claim) {
        const owner = await readClaimOwner(api, claim, config.workflow);
        runs = [owner];
      }
      const incident = assessSchedule({ crons: config.crons, now, enabledAt, runs, kind, scheduledDue: due, owned: Boolean(claim) });
      if (incident) incidents.push({ ...incident, file: config.workflow });
    }
  }
  const previous = fs.existsSync('.monitor/state.json') ? JSON.parse(fs.readFileSync('.monitor/state.json', 'utf8')) : {};
  const plan = notificationPlan(incidents, previous);
  const notify = plan.fresh.length > 0;
  fs.writeFileSync('.monitor/pending.json', JSON.stringify(plan.pending));
  fs.writeFileSync('.monitor/outcome.json', JSON.stringify({ githubRunId: process.env.GITHUB_RUN_ID, reportType: 'schedule-monitor', checkedAt: new Date().toISOString(), status: 'infrastructure-failed', suite: 'schedule freshness',
    issues: plan.fresh.flatMap((i) => i.issues.map((issue) => `${i.file}: ${issue}`)) }));
  if (!notify) fs.writeFileSync('.monitor/state.json', JSON.stringify(plan.current));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `notify=${notify}\n`);
  console.log(notify ? 'New schedule freshness incident' : 'No new actionable schedule change');
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { mostRecentDue, assessSchedule, notificationPlan };
