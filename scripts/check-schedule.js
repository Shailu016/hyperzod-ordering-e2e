const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function mostRecentDue(crons, now) {
  const dates = [];
  for (const cron of crons) {
    const match = /^(\d+) (\d+) \* \* \*$/.exec(cron);
    if (!match) throw new Error('Freshness monitor supports the configured daily UTC schedules only');
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
  const run = runs.filter((r) => r.event === 'schedule' && new Date(r.created_at) >= due).sort((a,b) => Number(new Date(b.created_at)) - Number(new Date(a.created_at)))[0];
  if (run?.status === 'completed' && run.conclusion === 'success') return null;
  if (run && run.status !== 'completed' && Number(now) - Number(new Date(run.created_at)) < 100 * 60_000) return null;
  return { status: 'infrastructure-failed', suite: 'schedule freshness', issues: [`Scheduled run due ${due.toISOString()} is ${run ? run.conclusion || 'overdue' : 'missing'}`], due: due.toISOString(), runId: run?.id };
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
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(incidents.map((i) => [i.file, i.due, i.runId || 'missing']))).digest('hex');
  const previous = fs.existsSync('.monitor/state.json') ? JSON.parse(fs.readFileSync('.monitor/state.json', 'utf8')) : {};
  const notify = incidents.length > 0 && previous.fingerprint !== fingerprint;
  fs.writeFileSync('.monitor/pending.json', JSON.stringify({ fingerprint }));
  fs.writeFileSync('.monitor/outcome.json', JSON.stringify({ githubRunId: process.env.GITHUB_RUN_ID, status: 'infrastructure-failed', suite: 'schedule freshness', issues: incidents.flatMap((i) => i.issues.map((issue) => `${i.file}: ${issue}`)) }));
  if (!incidents.length) fs.copyFileSync('.monitor/pending.json', '.monitor/state.json');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `notify=${notify}\n`);
  console.log(notify ? 'New schedule freshness incident' : 'No new actionable schedule change');
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { mostRecentDue, assessSchedule };
