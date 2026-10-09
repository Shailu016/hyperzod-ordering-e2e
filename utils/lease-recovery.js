const crypto = require('node:crypto');
const { leaseAPI } = require('./lease');
const { redact } = require('./policy');
function validateRef(ref) {
  if (!/^e2e-lease-[a-f0-9]{24}$/.test(ref || '')) throw new Error('Expected an exact e2e-lease-<24 hex characters> tag');
}
async function inspectLease({ ref, ...options }) {
  validateRef(ref);
  const api = leaseAPI(options);
  const current = await api(`git/ref/tags/${ref}`);
  const commit = await api(`git/commits/${current.object.sha}`);
  const metadata = JSON.parse(commit.message);
  if (typeof metadata.owner !== 'string' || !metadata.owner || !Number.isFinite(Date.parse(metadata.acquiredAt))) throw new Error('Lease ownership metadata is invalid; inspect the commit manually');
  return { ref, sha: current.object.sha, owner: metadata.owner, acquiredAt: metadata.acquiredAt, source: metadata.source || 'legacy', githubRunId: metadata.githubRunId, tree: commit.tree.sha };
}
async function recoverLease({ ref, expectedSha, expectedOwner, ownerInactive, resourcesReconciled, reason, evidence, ...options }) {
  if (!ownerInactive || !resourcesReconciled || !reason?.trim() || !evidence?.trim()) throw new Error('Recovery requires explicit inactive-owner and reconciled-resource confirmations, reason and evidence');
  if (!/^[a-f0-9]{40}$/.test(expectedSha || '') || !expectedOwner) throw new Error('Supply the SHA and owner from lease inspection');
  const snapshot = await inspectLease({ ref, ...options });
  if (snapshot.sha !== expectedSha || snapshot.owner !== expectedOwner) throw new Error('Lease changed; refusing recovery');
  const api = leaseAPI(options);
  if (snapshot.source === 'github') {
    if (!/^\d+$/.test(snapshot.githubRunId || '')) throw new Error('GitHub owner has no verifiable run ID');
    const run = await api(`actions/runs/${snapshot.githubRunId}`);
    if (run.status !== 'completed') throw new Error('GitHub owner is still active; refusing recovery');
  }
  // Publish the audit and delete the exact inspected owner in one atomic transaction.
  const audit = await api('git/commits', 'POST', {
    tree: snapshot.tree, parents: [snapshot.sha],
    message: JSON.stringify({ action: 'operator-lease-recovery', previous: snapshot, recoveredAt: new Date().toISOString(), reason: redact(reason), evidence: redact(evidence) }),
  });
  const auditRef = `e2e-lease-recovered-${ref.slice(10)}-${crypto.randomUUID()}`;
  await api.updateRefs([
    { name: `refs/tags/${auditRef}`, beforeOid: '0'.repeat(40), afterOid: audit.sha },
    { name: `refs/tags/${ref}`, beforeOid: expectedSha, afterOid: '0'.repeat(40) },
  ]);
  return { recovered: ref, previousSha: expectedSha, auditRef };
}
module.exports = { inspectLease, recoverLease };
