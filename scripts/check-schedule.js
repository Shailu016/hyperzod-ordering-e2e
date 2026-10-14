const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function mostRecentDue(crons, now) {
  if (!Array.isArray(crons) || !crons.length || !Number.isFinite(Number(new Date(now)))) throw new Error('Missing or invalid schedule configuration');
  const dates = [];
  for (const cron of crons) {
    const match = /^(\d+) (\d+) \* \* \*$/.exec(cron);
    if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) throw new Error('Freshness monitor supports valid daily UTC schedules only');
    const date = new Date(now);
    date.setUTCHours(Number(match[2]), Number(match[1]), 0, 0);
    if (date > now) date.setUTCDate(date.getUTCDate() - 1);
    dates.push(date);
  }
  return new Date(Math.max(...dates.map(Number)));
}
function assessSchedule({ crons, now, enabledAt, runs, graceMinutes = 45 }) {
  const due = mostRecentDue(crons, now);
  if (due < new Date(enabledAt) || Number(now) - Number(due) < graceMinutes * 60_000) return null;
  const matching = runs.filter((r) => r.event === 'schedule' && new Date(r.created_at) >= due && new Date(r.created_at) <= now);
  // Execution freshness does not assess test success. Completed failures have
  // their own E2E result notification; do not report them again as missing runs.
  if (matching.some((r) => r.status === 'completed' && ['success', 'failure', 'neutral'].includes(r.conclusion))) return null;
  const run = matching.sort((a,b) => Number(new Date(b.created_at)) - Number(new Date(a.created_at)))[0];
  if (run && run.status !== 'completed' && Number(now) - Number(new Date(run.created_at)) < 100 * 60_000) return null;
  const reason = !run ? 'missing' : run.status !== 'completed' ? 'overdue' : run.conclusion || 'incomplete';
  const time = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(due);
  return { status: 'infrastructure-failed', suite: 'schedule freshness', reason,
    issues: [`Scheduled for ${time} IST: ${reason === 'missing' ? 'GitHub has not created a scheduled run yet (delayed or dropped trigger)' : `execution is ${reason}`}. This is a schedule alert, not a storefront test result.`],
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
  const get = async (url) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${url}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Schedule inspection failed: HTTP ${response.status}`);
    return response.json();
  };
  const incidents = [];
  for (const file of ['scheduled-e2e-smoke.yml', 'scheduled-e2e.yml']) {
    const source = fs.readFileSync(path.join('.github/workflows', file), 'utf8');
    const crons = [...source.matchAll(/cron:\s*"([^"]+)"/g)].map((m) => m[1]);
    const commits = await get(`commits?path=.github/workflows/${file}&per_page=1`);
    const history = await get(`actions/workflows/${file}/runs?event=schedule&per_page=30`);
    const incident = assessSchedule({ crons, now: new Date(), enabledAt: commits[0].commit.committer.date, runs: history.workflow_runs });
    if (incident) incidents.push({ ...incident, file });
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
