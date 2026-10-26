const { identityKey } = require('./policy');
const { execFileSync } = require('node:child_process');
function resolveToken() {
  if (process.env.E2E_LEASE_TOKEN) return process.env.E2E_LEASE_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('An E2E_LEASE_TOKEN or authenticated gh CLI is required to coordinate live test identities'); }
}
function leaseAPI({ repository = 'Shailu016/hyperzod-ordering-e2e', token = resolveToken(), request = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Invalid lease repository or missing token');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
  const api = async (endpoint, method = 'GET', body) => {
    const response = await request(`https://api.github.com/repos/${repository}${endpoint ? '/' + endpoint : ''}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const error = Object.assign(new Error(`Identity lease ${method} failed (HTTP ${response.status}); inspect token permissions, API availability and lease state`), { status: response.status });
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
  return Object.assign(api, { updateRefs: async (refUpdates) => {
    const repositoryInfo = await api('');
    if (!repositoryInfo.node_id) throw new Error('Cannot resolve identity lease repository');
    const response = await request('https://api.github.com/graphql', {
      method: 'POST', headers, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ query: 'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }', variables: { input: { repositoryId: repositoryInfo.node_id, refUpdates } } }),
    });
    if (!response.ok) throw new Error(`Atomic identity lease update failed (HTTP ${response.status}); inspect lock state before retrying`);
    const result = await response.json();
    if (result.errors?.length || !result.data?.updateRefs) throw new Error('Atomic identity lease update rejected; owner may have changed or token permissions are insufficient; inspect the lease');
  } });
}
async function acquireLease({ origin, email, owner, ...options }) {
  const ref = `tags/e2e-lease-${identityKey(origin, email)}`;
  const api = leaseAPI(options);
  const head = await api('git/ref/heads/main');
  const base = await api(`git/commits/${head.object.sha}`);
  const metadata = { owner, acquiredAt: new Date().toISOString(), source: process.env.GITHUB_ACTIONS === 'true' ? 'github' : 'local', githubRunId: process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_RUN_ID : undefined };
  const commit = await api('git/commits', 'POST', { tree: base.tree.sha, parents: [head.object.sha], message: JSON.stringify(metadata) });
  try { await api('git/refs', 'POST', { ref: `refs/${ref}`, sha: commit.sha }); }
  catch (error) {
    // A POST can succeed even if its acknowledgement is lost. Only an exact SHA
    // match proves that this invocation acquired ownership; never retry mutations.
    let current;
    try { current = await api(`git/ref/${ref}`); } catch { /* preserve the original acquisition failure */ }
    if (current?.object?.sha !== commit.sha) {
      const failure = Object.assign(new Error(`${error.message}. Lease: ${ref.slice(5)}; see docs/LEASE-RECOVERY.md`), { code: '', leaseConflict: undefined });
      if (/^[a-f0-9]{40}$/.test(current?.object?.sha || '')) {
        let held;
        try { held = JSON.parse((await api(`git/commits/${current.object.sha}`)).message); } catch { /* unverified ownership */ }
        if (/^[A-Za-z0-9_-]{1,100}$/.test(held?.owner || '') && ['local', 'github'].includes(held.source) && Number.isFinite(Date.parse(held.acquiredAt)) && (held.source !== 'github' || /^\d{1,30}$/.test(held.githubRunId || ''))) {
          failure.code = 'identity-lease-conflict';
          failure.leaseConflict = { ref: ref.slice(5), sha: current.object.sha, owner: held.owner, source: held.source, acquiredAt: new Date(held.acquiredAt).toISOString(), ...(held.source === 'github' ? { githubRunId: held.githubRunId } : {}) };
          failure.message = 'Tests did not start: another runner holds the test account lock. Verify the owner is inactive and reconcile resources before recovery; see docs/LEASE-RECOVERY.md';
        }
      }
      throw failure;
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    // Server-side compare-and-delete closes the race between GET and DELETE.
    await api.updateRefs([{ name: `refs/${ref}`, beforeOid: commit.sha, afterOid: '0'.repeat(40) }]);
    released = true;
  };
}
module.exports = { acquireLease, leaseAPI };
