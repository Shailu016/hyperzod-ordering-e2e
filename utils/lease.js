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
    if (!response.ok) throw new Error(`Identity lease ${method} failed (HTTP ${response.status}); ${endpoint === 'git/refs' && response.status === 422 ? 'another runner may own this test account; inspect the lease before recovering it' : 'inspect token permissions and API availability'}`);
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
  catch (error) { throw new Error(`${error.message}. Lease: ${ref.slice(5)}; see docs/LEASE-RECOVERY.md`); }
  let released = false;
  return async () => {
    if (released) return;
    // Server-side compare-and-delete closes the race between GET and DELETE.
    await api.updateRefs([{ name: `refs/${ref}`, beforeOid: commit.sha, afterOid: '0'.repeat(40) }]);
    released = true;
  };
}
module.exports = { acquireLease, leaseAPI };
