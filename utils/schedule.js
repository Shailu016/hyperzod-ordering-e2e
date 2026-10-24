// Shared by the independent clock, workflow admission and freshness monitor.
// Keep this module free of Node-only imports so Wrangler can bundle it unchanged.
const SCHEDULES = Object.freeze({
  smoke: Object.freeze({ workflow: 'scheduled-e2e-smoke.yml', suite: 'all', label: 'full', legacySuites: ['smoke'], crons: ['30 19 * * *', '30 21 * * *', '30 23 * * *', '30 7 * * *'] }),
  full: Object.freeze({ workflow: 'scheduled-e2e.yml', suite: 'all', crons: ['30 1 * * *', '30 3 * * *', '30 5 * * *', '30 9 * * *', '30 11 * * *', '30 13 * * *', '30 15 * * *', '30 17 * * *'], legacyCrons: ['30 12 * * *'] }),
});
const MAX_RECOVERY_MS = 6 * 60 * 60_000;
const CLAIM_RETENTION_MS = 14 * 24 * 60 * 60_000;

function timestamp(value) {
  const date = new Date(value);
  if (value == null || !Number.isFinite(Number(date))) throw new Error('Invalid schedule timestamp');
  return date;
}

function cronTime(cron) {
  const match = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) throw new Error('Expected a valid daily UTC schedule');
  return [Number(match[2]), Number(match[1])];
}

function recentSlots(crons, now, lookback = MAX_RECOVERY_MS) {
  now = timestamp(now);
  if (!Array.isArray(crons) || !crons.length || !Number.isFinite(lookback) || lookback < 0 || lookback > CLAIM_RETENTION_MS) throw new Error('Missing or invalid schedule configuration');
  const dates = new Set();
  for (const cron of crons) {
    const [hour, minute] = cronTime(cron);
    const date = new Date(now);
    date.setUTCHours(hour, minute, 0, 0);
    if (date > now) date.setUTCDate(date.getUTCDate() - 1);
    while (Number(now) - Number(date) <= lookback) {
      dates.add(date.toISOString());
      date.setUTCDate(date.getUTCDate() - 1);
    }
  }
  return [...dates].sort();
}

function mostRecentDue(crons, now) {
  const slots = recentSlots(crons, now, 24 * 60 * 60_000);
  if (!slots.length) throw new Error('No valid daily schedule');
  return new Date(slots[slots.length - 1]);
}

function validateSlot(kind, value, { historical = false } = {}) {
  const config = SCHEDULES[kind];
  if (!config || typeof value !== 'string') throw new Error('Unknown scheduled slot');
  const due = timestamp(value);
  // Retired times are valid only when reading/pruning historical ownership.
  const crons = historical ? [...config.crons, ...(config.legacyCrons || [])] : config.crons;
  if (due.toISOString() !== value || due.getUTCSeconds() || due.getUTCMilliseconds() || !crons.some((cron) => {
    const [hour, minute] = cronTime(cron);
    return hour === due.getUTCHours() && minute === due.getUTCMinutes();
  })) throw new Error('Slot does not match this workflow schedule');
  return due;
}

function slotRef(kind, value) {
  validateSlot(kind, value, { historical: true });
  return `e2e-schedule-${kind}-${value.replace(/[-:.]/g, '')}`;
}

function slotTitle(kind, value) {
  validateSlot(kind, value);
  return `Ordering ${SCHEDULES[kind].label || kind} · slot ${value}`;
}

function runMatchesSlot(run, kind, due) {
  const config = SCHEDULES[kind];
  if (!config || run.head_branch !== 'main') return false;
  const labels = [...new Set([kind, config.label || kind])];
  // Preserve pre-migration history and slot claims: changing coverage must not replay a completed slot.
  if (run.event === 'workflow_dispatch') return labels.some(label => run.display_title === `Ordering ${label} · slot ${due}`);
  if (run.event !== 'schedule') return false;
  const cron = config.crons.find((value) => labels.some(label => run.display_title === `Ordering ${label} · native ${value}`));
  return Boolean(cron && mostRecentDue([cron], timestamp(run.created_at)).toISOString() === due);
}

function admissionSlot({ kind, event, eventSchedule, requestedSlot, suite, baseUrl, createdAt, now, enabledAt }) {
  const config = SCHEDULES[kind];
  if (!config) throw new Error('Unknown workflow schedule');
  if (event === 'workflow_dispatch' && !requestedSlot) return { mode: 'manual', due: null };
  let due;
  if (event === 'schedule') {
    // A native trigger queued before cadence migration must be suppressed quietly.
    if (config.legacyCrons?.includes(eventSchedule)) return { mode: 'expired', due: mostRecentDue([eventSchedule], timestamp(createdAt)).toISOString() };
    if (!config.crons.includes(eventSchedule)) throw new Error('Unexpected native schedule');
    due = mostRecentDue([eventSchedule], timestamp(createdAt)).toISOString();
  } else if (event === 'workflow_dispatch') {
    if (![config.suite, ...(config.legacySuites || [])].includes(suite) || baseUrl) throw new Error('Scheduled recovery cannot override suite or target');
    due = validateSlot(kind, requestedSlot).toISOString();
  } else throw new Error('Unsupported scheduled event');
  if (enabledAt && timestamp(due) < timestamp(enabledAt)) return { mode: 'expired', due };
  const age = Number(timestamp(now)) - Number(validateSlot(kind, due));
  if (age < 0) throw new Error('A future scheduled slot cannot execute');
  return { mode: age > MAX_RECOVERY_MS ? 'expired' : 'scheduled', due };
}

function recoveryPlan({ kind, now, enabledAt, runs, minimumDelayMs = 2 * 60_000 }) {
  if (!SCHEDULES[kind]) throw new Error('Unknown workflow schedule');
  const enabled = timestamp(enabledAt);
  now = timestamp(now);
  return recentSlots(SCHEDULES[kind].crons, now).filter((due) => timestamp(due) >= enabled && Number(now) - Number(timestamp(due)) >= minimumDelayMs && !runs.some((run) => runMatchesSlot(run, kind, due)));
}

// A scheduled slot always uses its configured coverage, including dispatches from
// the previous Worker version. Ordinary manual runs keep the selected suite.
function executionSuite({ kind, event, requestedSlot, requestedSuite }) {
  const config = SCHEDULES[kind];
  if (!config || !['schedule', 'workflow_dispatch'].includes(event)) throw new Error('Unknown scheduled execution');
  if (event === 'schedule' || requestedSlot) return config.suite;
  if (!['smoke', 'web', 'android', 'ios', 'mobile', 'all'].includes(requestedSuite)) throw new Error('Unknown manual suite');
  return requestedSuite;
}

module.exports = { executionSuite, SCHEDULES, MAX_RECOVERY_MS, CLAIM_RETENTION_MS, timestamp, cronTime, recentSlots, mostRecentDue, validateSlot, slotRef, slotTitle, runMatchesSlot, admissionSlot, recoveryPlan };
