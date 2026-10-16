import schedule from '../utils/schedule.js';
import claims from '../utils/schedule-claims.js';
import client from '../utils/schedule-api.js';

const { SCHEDULES, MAX_RECOVERY_MS, recoveryPlan, slotTitle } = schedule;
const { readClaim } = claims;
const { githubAPI, workflowRuns } = client;

function base64url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function appToken(env, { request = fetch, now = new Date(), subtle = crypto.subtle } = {}) {
  if (!/^\d+$/.test(env.GITHUB_APP_ID || '') || !/^\d+$/.test(env.GITHUB_INSTALLATION_ID || '') || !/^\d+$/.test(env.GITHUB_REPOSITORY_ID || '')) throw new Error('Missing GitHub App scheduler identity');
  const pem = env.GITHUB_APP_PRIVATE_KEY || '';
  if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('GitHub App key must be PKCS8 PEM');
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), (char) => char.charCodeAt(0));
  const key = await subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const seconds = Math.floor(Number(now) / 1000);
  const unsigned = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + base64url(JSON.stringify({ iss: env.GITHUB_APP_ID, iat: seconds - 60, exp: seconds + 540 }));
  const signature = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const response = await request(`https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: 'Bearer ' + unsigned + '.' + base64url(signature), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'ordering-e2e-scheduler' },
    body: JSON.stringify({ repository_ids: [Number(env.GITHUB_REPOSITORY_ID)], permissions: { actions: 'write', contents: 'read' } }),
  });
  if (!response.ok) throw new Error(`GitHub scheduler authentication failed (HTTP ${response.status})`);
  const document = await response.json();
  if (typeof document.token !== 'string' || !document.token || !(Date.parse(document.expires_at) > Number(now))) throw new Error('Invalid GitHub installation token');
  return document.token;
}

export async function tick(env, { now = new Date(), api, request = fetch, tokenProvider = appToken } = {}) {
  // Deploy disabled, validate the cutover, then explicitly activate it. No network
  // calls or dispatches occur while disabled.
  if (env.SCHEDULER_ENABLED !== 'true') return { enabled: false, dispatched: [], existing: [] };
  const enabledAt = new Date(env.SCHEDULER_ENABLED_AT);
  if (!Number.isFinite(Number(enabledAt)) || enabledAt > now || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Error('Invalid independent scheduler cutover configuration');
  api ||= githubAPI({ repository: env.GITHUB_REPOSITORY, token: await tokenProvider(env, { request, now }), request });
  // Refuse activation against an older main that cannot suppress duplicates.
  const source = await api('contents/.github/workflows/scheduled-e2e-smoke.yml?ref=main');
  const full = await api('contents/.github/workflows/scheduled-e2e.yml?ref=main');
  for (const file of [source, full]) {
    if (!file.content || !/^\s*E2E_SCHEDULE_PROTOCOL: slots-v1\s*$/m.test(atob(file.content.replace(/\s/g, '')))) throw new Error('Main is missing scheduled-slot admission; dispatch disabled');
  }
  const result = { enabled: true, dispatched: [], existing: [] };
  for (const [kind, config] of Object.entries(SCHEDULES)) {
    const runs = await workflowRuns(api, config.workflow, new Date(Number(now) - MAX_RECOVERY_MS));
    const slots = recoveryPlan({ kind, now, enabledAt, runs });
    for (const due of slots) {
      const existing = await readClaim(api, kind, due);
      if (existing) { result.existing.push({ kind, due, runId: existing.runId }); continue; }
      // Dispatch POST is never blindly retried. The next tick reconciles run
      // history; workflow admission remains the final atomic duplicate guard.
      await api(`actions/workflows/${config.workflow}/dispatches`, 'POST', { ref: 'main', inputs: { suite: config.suite, schedule_slot: due } });
      result.dispatched.push({ kind, due, title: slotTitle(kind, due) });
    }
  }
  return result;
}

export default {
  async fetch() { return new Response('Not found', { status: 404 }); },
  async scheduled(_event, env) {
    try { console.log(JSON.stringify(await tick(env))); }
    catch (error) {
      // Do not print request objects, tokens, PEM contents, or raw API bodies.
      console.error('Independent schedule tick failed: ' + error.message);
      throw new Error('Independent schedule tick failed; inspect configuration and GitHub availability');
    }
  },
};
