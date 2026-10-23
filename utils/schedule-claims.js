const { slotRef, validateSlot, CLAIM_RETENTION_MS } = require('./schedule');

function validateClaim(data, kind, due) {
  validateSlot(kind, due, { historical: true });
  if (!data || data.protocol !== 'slots-v1' || data.kind !== kind || data.due !== due || !/^\d+$/.test(String(data.runId)) || !/^[1-9]\d*$/.test(String(data.attempt)) || !/^[a-f0-9]{40}$/.test(data.sha || '')) throw new Error('Invalid scheduled-slot ownership record');
  return data;
}

async function readClaim(api, kind, due) {
  let ref;
  try { ref = await api(`git/ref/tags/${slotRef(kind, due)}`); }
  catch (error) { if (error.status === 404) return null; throw error; }
  if (ref.object?.type !== 'tag' || !/^[a-f0-9]{40}$/.test(ref.object.sha || '')) throw new Error('Unexpected scheduled-slot reference type');
  const tag = await api(`git/tags/${ref.object.sha}`);
  const claim = validateClaim(JSON.parse(tag.message), kind, due);
  if (tag.object?.type !== 'commit' || tag.object.sha !== claim.sha || tag.tag !== slotRef(kind, due)) throw new Error('Scheduled-slot tag identity mismatch');
  return { ...claim, refSha: ref.object.sha };
}

async function claimSlot(api, proposed) {
  validateSlot(proposed.kind, proposed.due);
  validateClaim(proposed, proposed.kind, proposed.due);
  let existing = await readClaim(api, proposed.kind, proposed.due);
  if (!existing) {
    const tag = await api('git/tags', 'POST', {
      tag: slotRef(proposed.kind, proposed.due), message: JSON.stringify(proposed), object: proposed.sha, type: 'commit',
      tagger: { name: 'Ordering schedule admission', email: 'scheduler@users.noreply.github.com', date: new Date().toISOString() },
    });
    if (!/^[a-f0-9]{40}$/.test(tag.sha || '')) throw new Error('GitHub did not return a slot-tag identity');
    try {
      await api('git/refs', 'POST', { ref: 'refs/tags/' + slotRef(proposed.kind, proposed.due), sha: tag.sha });
      return { admitted: true, claim: proposed };
    } catch (error) {
      // A timeout can occur after GitHub committed the claim. Reconcile ownership
      // before allowing execution; never replay a test based on an uncertain POST.
      existing = await readClaim(api, proposed.kind, proposed.due);
      if (!existing) throw error;
    }
  }
  const sameOwner = String(existing.runId) === String(proposed.runId) && String(existing.attempt) === String(proposed.attempt);
  if (sameOwner && existing.sha !== proposed.sha) throw new Error('Scheduled-slot owner revision changed');
  return { admitted: sameOwner, claim: existing };
}

async function pruneClaims(api, now) {
  const refs = await api('git/matching-refs/tags/e2e-schedule-');
  if (!Array.isArray(refs)) throw new Error('Invalid scheduled-slot reference listing');
  let removed = 0;
  for (const ref of refs) {
    const match = /^refs\/tags\/e2e-schedule-(smoke|full)-(\d{8}T\d{6}000Z)$/.exec(ref.ref || '');
    if (!match || ref.object?.type !== 'tag') continue;
    const stamp = match[2];
    const due = `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(9,11)}:${stamp.slice(11,13)}:${stamp.slice(13,15)}.000Z`;
    validateSlot(match[1], due, { historical: true });
    if (Number(now) - Date.parse(due) <= CLAIM_RETENTION_MS) continue;
    const claim = await readClaim(api, match[1], due);
    if (claim.refSha !== ref.object.sha) throw new Error('Scheduled-slot ownership changed during pruning');
    const run = await api(`actions/runs/${claim.runId}`);
    if (run.status !== 'completed') continue;
    // Compare and delete atomically; never touch identity leases or release tags.
    await api.deleteRefExact(`refs/tags/${slotRef(match[1], due)}`, claim.refSha);
    removed++;
  }
  return removed;
}

module.exports = { validateClaim, readClaim, claimSlot, pruneClaims };
