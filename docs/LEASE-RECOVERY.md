# Lease recovery runbook

The identity lease is a Git tag named `e2e-lease-<24 hex characters>`. A failed process can leave it behind. Never delete a lease by age alone: the owner may still be mutating the shared account.

First inspect the exact tag. This is read-only and requires an authenticated `gh` CLI or `E2E_LEASE_TOKEN`:

```powershell
$env:E2E_LEASE_TOKEN = gh auth token
npm run lease:inspect -- --ref e2e-lease-<24-hex-characters>
```

Use the returned owner, commit SHA, source, GitHub run ID, and acquisition time to confirm the owner is inactive. Reconcile the uploaded `resource-lifecycle.json` and any retained order IDs before removing the lock. For a GitHub owner, the recovery command independently checks that the recorded run is completed. Local owners require operator confirmation from the runner host.

Only after those checks, recover with the exact values returned by inspection. GitHub's `updateRefs` transaction publishes the audit tag and deletes the inspected lock atomically, conditional on its exact SHA. If either operation fails, neither ref changes:

```powershell
$env:E2E_LEASE_TOKEN = gh auth token
node scripts/recover-lease.js --recover `
  --ref e2e-lease-<24-hex-characters> `
  --expected-sha <40-hex-commit-sha> `
  --expected-owner <owner-from-inspection> `
  --owner-inactive `
  --resources-reconciled `
  --reason "runner crash confirmed" `
  --evidence "run URL and resource-lifecycle artifact reviewed"
```

If inspection shows a changed SHA, an active GitHub run, invalid metadata, or missing reconciliation evidence, stop. Do not use a broad `git push --delete` command and do not bypass the owner check. The original lease remains in place when audit storage or the final compare-and-delete check fails.
