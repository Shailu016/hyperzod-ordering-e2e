const { identityKey } = require('./policy');
const { execFileSync } = require('node:child_process');
function resolveToken() {
  if (process.env.E2E_LEASE_TOKEN) return process.env.E2E_LEASE_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('An E2E_LEASE_TOKEN or authenticated gh CLI is required to coordinate live test identities'); }
}
async function acquireLease({ origin, email, owner, repository = 'Shailu016/hyperzod-ordering-e2e', token = resolveToken(), request = fetch }) {
  const ref = `tags/e2e-lease-${identityKey(origin, email)}`;
  const api = async (endpoint, method = 'GET', body) => {
    const response = await request(`https://api.github.com/repos/${repository}/git/${endpoint}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Identity lease ${method} failed (HTTP ${response.status}); ${endpoint === 'refs' && response.status === 422 ? 'another runner may own this test account' : 'inspect token permissions and API availability'}`);
    return response.status === 204 ? null : response.json();
  };
  const head = await api('ref/heads/main');
  const base = await api(`commits/${head.object.sha}`);
  const commit = await api('commits', 'POST', { tree: base.tree.sha, parents: [head.object.sha], message: JSON.stringify({ owner, acquiredAt: new Date().toISOString() }) });
  await api('refs', 'POST', { ref: `refs/${ref}`, sha: commit.sha });
  let released = false;
  return async () => {
    if (released) return;
    const current = await api(`ref/${ref}`);
    if (current.object.sha !== commit.sha) throw new Error('Identity lease owner changed; refusing to release another run\'s lease');
    await api(`refs/${ref}`, 'DELETE');
    released = true;
  };
}
module.exports = { acquireLease };
