const assert = require('node:assert/strict');
const ref = 'e2e-lease-' + 'a'.repeat(24), sha = 'b'.repeat(40), mine = 'd'.repeat(40);
function fixture({ active = false, changed = false, contend = false, rejectUpdate = false } = {}) {
  const calls = [], refs = new Map();
  const request = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, body });
    let data = {};
    if (url.endsWith('/graphql')) {
      const updates = body.variables.input.refUpdates;
      if (changed) refs.set(updates.at(-1).name, 'c'.repeat(40));
      if (rejectUpdate || updates.some((r) => (refs.get(r.name) || '0'.repeat(40)) !== r.beforeOid)) return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'compare rejected' }] }) };
      for (const r of updates) { if (r.afterOid === '0'.repeat(40)) refs.delete(r.name); else refs.set(r.name, r.afterOid); }
      data = { data: { updateRefs: { clientMutationId: null } } };
    } else if (url.endsWith('git/ref/heads/main')) data = { object: { sha } };
    else if (url.endsWith(`git/ref/tags/${ref}`)) { refs.set(`refs/tags/${ref}`, sha); data = { object: { sha } }; }
    else if (url.endsWith(`git/commits/${sha}`)) data = { tree: { sha: 'tree' }, message: JSON.stringify({ owner: 'run-123', acquiredAt: '2026-10-06T01:00:00Z', source: 'github', githubRunId: '123' }) };
    else if (url.endsWith('actions/runs/123')) data = { status: active ? 'in_progress' : 'completed' };
    else if (url.endsWith('git/commits') && options.method === 'POST') data = { sha: mine };
    else if (url.endsWith('git/refs') && options.method === 'POST') {
      if (contend) return { ok: false, status: 422 };
      refs.set(body.ref, body.sha);
    } else if (url.endsWith('/hyperzod-ordering-e2e')) data = { node_id: 'repository-id' };
    else assert.fail(`Unexpected API call: ${options.method} ${url}`);
    return { ok: true, status: 200, json: async () => data };
  };
  return { calls, refs, options: { ref, expectedSha: sha, expectedOwner: 'run-123', ownerInactive: true, resourcesReconciled: true, reason: 'runner crash', evidence: 'resource artifact and order IDs inspected', token: 'fake', request } };
}
module.exports = { fixture, ref, sha };
