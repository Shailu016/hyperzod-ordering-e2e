// GitHub API client usable in Node and Workers. Credentials never leave api.github.com.
function githubAPI({ repository, token, request = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token) throw new Error('Missing scheduler repository or token');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ordering-e2e-scheduler' };
  const send = async (url, method, body) => {
    const response = await request(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000), body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw Object.assign(new Error(`Scheduler API failed (HTTP ${response.status})`), { status: response.status });
    return response.status === 204 ? null : response.json();
  };
  const api = (path = '', method = 'GET', body) => {
    if (path.includes('..') || path.startsWith('/') || !/^[\w./?=&%-]*$/.test(path)) throw new Error('Invalid scheduler API path');
    return send(`https://api.github.com/repos/${repository}${path ? '/' + path : ''}`, method, body);
  };
  api.deleteRefExact = async (ref, sha) => {
    if (!/^refs\/tags\/e2e-schedule-(smoke|full)-\d{8}T\d{9}Z$/.test(ref) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid expired schedule reference');
    const info = await api();
    if (!info.node_id) throw new Error('Cannot resolve scheduler repository');
    const result = await send('https://api.github.com/graphql', 'POST', {
      query: 'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
      variables: { input: { repositoryId: info.node_id, refUpdates: [{ name: ref, beforeOid: sha, afterOid: '0'.repeat(40) }] } },
    });
    if (result.errors?.length || !result.data?.updateRefs) throw new Error('Atomic schedule-claim cleanup rejected; ownership may have changed');
  };
  return api;
}

async function workflowRuns(api, workflow, since) {
  if (!/^[\w.-]+\.yml$/.test(workflow)) throw new Error('Invalid workflow identity');
  const result = [];
  for (let page = 1; page <= 5; page++) {
    const document = await api(`actions/workflows/${workflow}/runs?branch=main&per_page=100&page=${page}`);
    if (!Array.isArray(document.workflow_runs)) throw new Error('Invalid workflow history');
    result.push(...document.workflow_runs);
    if (document.workflow_runs.length < 100 || document.workflow_runs.some((run) => Date.parse(run.created_at) < Number(since))) return result;
  }
  throw new Error('Workflow history exceeds the inspection budget; do not dispatch blindly');
}

module.exports = { githubAPI, workflowRuns };
