# Independent schedule recovery

This clock belongs to the personal `Shailu016/hyperzod-ordering-e2e` project.
It dispatches existing GitHub workflows on `main`. It does not change the
storefront, send Slack requests, hold test credentials or store report media.
GitHub remains responsible for runners and the existing report publisher.

## Execution and duplicate prevention

Full web/Android/iOS emulation runs **every two hours, at each odd hour from
1 AM through 11 PM IST** (12 runs daily). The former 6 PM slot is retired;
the full workflow now supplies the other eight odd-hour slots.
The four former smoke slots now run the same complete `all` suite. Their legacy
workflow names/paths, receipt kinds and slot tags remain unchanged to preserve
ownership and prevent replays during migration. The Worker recognizes both old
smoke titles and new full titles; an old Worker dispatch is also upgraded to full
coverage by the workflow. Ordinary manual runs may still select a smaller suite.

`utils/schedule.js` defines the UTC schedule shared by
the worker, workflow admission and freshness monitor. Workflow contract tests
reject mismatched cron definitions.

Cloudflare invokes `scheduler/worker.mjs` every five minutes. After a two-minute
native-trigger grace period, it recovers missing slots up to six hours old,
starting at the explicit activation cutover. A matching queued, active, failed,
cancelled or completed execution is never automatically retried. Manual runs
without a scheduled slot do not satisfy scheduled coverage.

Native GitHub cron remains a fallback. Before entering the existing shared test
queue, both trigger types atomically claim the same slot through an annotated
`e2e-schedule-*` tag. Only the owner can execute. Late duplicates and expired
slots produce an admission receipt and no test-result Slack message. Admission
errors remain visible infrastructure failures. A skipped duplicate cannot make
the freshness monitor report that tests executed successfully.

Claims contain only suite, slot, run/attempt and source commit identifiers.
Completed claims older than 14 days are deleted with an atomic compare-and-delete;
identity leases and release tags are excluded. Cleanup errors retain ownership.
These small metadata refs contain no screenshots, videos or test output.

The existing `ordering-e2e-suite` queue and identity lease continue to serialize
test-account use, including PR acceptance. Admission precedes this queue, so a
late native duplicate cannot replace its rightful owner in the test queue.

## Changing cadence without backfilling

For the two-hour cadence rollout, merge both workflow definitions and the shared
schedule first. Immediately before deploying the updated Worker, record the
current UTC time and set both the repository variable `E2E_SCHEDULE_ENABLED_AT`
and the ignored production config's `SCHEDULER_ENABLED_AT` to that same time.
Keep the existing account, App installation and encrypted key. This starts at
the next due slot and prevents a burst of historical runs or freshness alerts
for newly added times. Record the previous cutover in the rollout audit.

The four existing odd-hour slots keep their workflow and claim identities.
Retired 6 PM ownership records remain readable and eligible for normal expiry
cleanup, but cannot be used to admit a new execution. A late native trigger
for the retired time is suppressed as expired, without a test-result notification.
Current in-flight runs
finish normally under the existing account queue.

## GitHub App and Cloudflare setup

1. Run `npm ci --prefix scheduler`. Run offline checks below before deployment.
2. Create a **private GitHub App owned by Shailu016**, with **Actions: read/write**,
   **Contents: read-only**, automatic metadata read, no webhooks and no subscribed
   events. Install it with **Only select repositories**, selecting only
   `hyperzod-ordering-e2e`. Do not reuse a personal OAuth token or install it on
   a company organization. Record its numeric App and installation IDs.
3. Generate its private key. Convert PKCS1 keys to PKCS8 PEM locally using
   `crypto.createPrivateKey(pem).export({type:'pkcs8',format:'pem'})` if needed.
   Keep key material out of Git, report artifacts, command arguments and logs.
   Cloudflare stores it as the encrypted `GITHUB_APP_PRIVATE_KEY` secret.
4. Choose a canonical UTC cutover, for example `2026-10-16T00:00:00.000Z`.
   This is an example, **not a production setting**. Slots before the cutover
   are not replayed. Configure the selected account and numeric App IDs:

   ```text
   npm --prefix scheduler run configure -- ACCOUNT_ID APP_ID INSTALLATION_ID CUTOVER false
   npm --prefix scheduler run deploy
   ```

   Configuration is written to ignored `.schedule/worker.production.json`.
   The checked-in template is disabled. Production deploy/tail explicitly require
   the ignored config, preventing accidental deployment with template defaults.
   Before first deployment, verify that `ordering-e2e-scheduler` is a new Worker
   in the selected account. Do not overwrite an unrelated existing service.
5. Use Wrangler `secret put GITHUB_APP_PRIVATE_KEY --config
   .schedule/worker.production.json` from the repository root, piping the PKCS8
   key through stdin. Do not paste it into chat or a shell command. Authenticate
   Wrangler with the account explicitly approved for this scheduler.
6. Merge the admission-enabled workflows and publisher together. The worker
   refuses dispatch unless both workflows on `main` contain `slots-v1`.
7. Set GitHub repository variable **`E2E_SCHEDULE_ENABLED_AT`** to the exact same
   cutover. Set it before the first post-cutover slot. This keeps freshness stable
   across workflow edits and avoids historical rollout alerts.
8. Once cutover is no longer in the future, rerun configure with the same values
   and `true`, then deploy. Deploying an enabled worker activates recurring live
   tests and their existing public reports and Slack summaries. Verify this is
   authorized before activation. Cloudflare cron changes can take time to propagate.

The App exchanges a signed JWT for a short-lived installation token limited to
this repository and the two permissions. Its private key is never sent to GitHub
on each tick. The Worker exposes no public HTTP endpoint (`workers_dev` and
preview URLs are disabled; fetch returns 404). No KV or Durable Object is used.

## Verification, operation and recovery

Offline validation contacts neither the storefront nor Slack:

```text
npm run lint
npm run test:unit
python -m unittest discover -s tests-unit -p "*_test.py"
npm --prefix scheduler run check
npm --prefix scheduler run test:runtime
```

Tests cover due times, midnight boundaries, native/recovery races, lost POST
acknowledgements, conflicting owners, invalid receipts, authentication signatures,
cutover, expiry, cleanup and publisher suppression. The Wrangler check only bundles
the worker; it does not deploy or dispatch. The runtime test runs the bundled
production code in workerd (the Workers runtime), with a generated fixture key and
all outbound traffic intercepted locally. It checks signed authentication, missing
slot recovery, duplicate suppression and rejected redirects. No production secrets
or live GitHub/storefront/Slack requests are used.

GitHub run titles and the API's run name field can change with run-name.
Admission, claimed-owner checks and report publication instead verify the exact
allowlisted workflow file and its GitHub workflow ID. Report display labels are
derived from that verified identity. The monitor reads the claimed attempt rather
than a newer rerun. HTTP calls use redirect: manual and reject non-success
responses, keeping credentials at GitHub while remaining compatible with Workers.

Use `npm --prefix scheduler run tail` or Cloudflare Workers Observability to verify
cron invocations. An enabled tick records only slot/run metadata. Disabled ticks
perform no network activity. Authentication, missing main protocol or GitHub API
errors fail the invocation visibly. Review Cron Trigger execution history after
activation; a successful bundle/deploy is not proof of recurring execution.

At the first normal due slot, verify one source run claims it, the test job runs,
and the publisher links the exact run/attempt. A later native duplicate should
skip tests and produce no extra Slack result. Do not dispatch extra test runs just
to check the timer. Inspect run history and admission artifacts instead.

`schedule-freshness` remains a separate GitHub-based monitor with a 45-minute
grace and acknowledged-incident deduplication. It checks actual claimed owners
over the preceding 24 hours, not just the latest due slot. It can itself be delayed
by GitHub; Cloudflare execution failures need review in Cloudflare Observability.
This implementation does not promise exact-clock starts or an independent alert
channel. GitHub outages, runner queue capacity and Cloudflare failures can still
delay execution. No timer can force GitHub to allocate a runner.

If an owner is cancelled, fails admission after claiming, or becomes overdue,
inspect its admission receipt, run logs and identity lease. Do not delete the slot
claim or rerun its attempt to replay mutations. Follow `docs/LEASE-RECOVERY.md`
for ambiguous test resources; after reconciliation, use an explicitly authorized
ordinary manual run. A rerun/new attempt cannot silently take an existing slot.

For rollback, configure the same cutover with `false` and deploy. Verify disabled
ticks; GitHub native cron continues as fallback. Keep admission/publisher protocol
enabled while late dispatched runs exist. To revoke access, suspend/uninstall the
GitHub App installation, then remove its Cloudflare secret. Rotate keys by adding
a new App key, replacing the encrypted secret, verifying authentication and then
revoking the old key. Never broaden installation permissions to fix an auth error.
