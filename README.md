# hyperzod-ordering-e2e

Playwright tests for the Hyperzod ordering storefront on the isolated automation tenant.
See [HARDENING.md](HARDENING.md) for safety, leases, reporting, scheduling and acceptance requirements.

## Install and configure

Run `npm ci` and copy `.env.example` to `.env`. GitHub uses the repository's existing `E2E_*` secrets.
The default allowed target is `https://automations-store.hyperzod.me`; other test origins require explicit `E2E_ALLOWED_ORIGINS`.
Run `npm run check:env` before live execution. Local live runs require an authenticated `gh` CLI;
Bitbucket requires `E2E_LEASE_TOKEN` with repository contents read/write. Every runner leases its selected identity.
Local managed runs generate a distinct email/phone by default. Trusted pull-request acceptance explicitly uses a fresh identity per invocation; scheduled GitHub runs keep the configured scheduled identity. A failed PR cleanup retains only that PR identity's lease, without blocking scheduled monitoring. Isolation does not replace cleanup or order reconciliation.
If a runner crashes, inspect and recover its exact lease only by following [docs/LEASE-RECOVERY.md](docs/LEASE-RECOVERY.md).

## Offline verification

`npm run lint` checks syntax, YAML, imports, focused tests, image alignment and critical module types.
`npm run test:unit` and `python -m unittest discover -s tests-unit -p '*_test.py'` use mocks and do not contact the storefront or Slack.
`npm run test:diagnostics:browser` verifies navigation diagnostics in Chromium and WebKit against loopback fixtures only. Install them with `npx playwright install --with-deps chromium webkit`; PR static checks run these regressions too.
`npm run test:reports:browser` verifies generated reports, real fixture screenshots, recordings and video downloads locally. The controlled fixture failures exercise reporting; they are not storefront failures.

Only `static` is a required CI check for merging this personal E2E tool. Live storefront verification is informational: failures stay red in its job and artifacts but do not block releasing the automation tool. PR protection and an up-to-date branch remain required. See [docs/PR-ACCEPTANCE.md](docs/PR-ACCEPTANCE.md).

The local-expiry-hint scenario follows the current storefront policy: only a backend 401 logs out a session; editing `token_expires_in` alone must not log out a backend-valid user. It verifies the same user and unchanged token survive reload. It does not claim to test actual backend token expiration or 401 handling.

## Authorized storefront execution

`npm run test:smoke`, `test:web`, `test:android`, `test:ios`, `test:mobile` and `npm test` use the serial managed runner.
The full suite continues through all requested devices, preserves their reports, and returns aggregate failure status.
Use `npm run report -- web` to inspect one device's report. Direct unmanaged live Playwright runs are blocked.

Local validation uses a distinct test email/phone while preserving `.env`:

```powershell
$env:E2E_ISOLATED_IDENTITY = 'true'
$env:E2E_NOTIFICATIONS_DISABLED = 'true'
npm run test:smoke
# npm test runs the complete web / Android / iOS emulation matrix.
```

The runner does not send notifications. `E2E_NOTIFICATIONS_DISABLED=true` also blocks the standalone notifier.
`E2E_ENV_FILE` can select an existing private env file without copying it into another checkout.
Missing cleanup proof or an ambiguous order stops subsequent devices and retains the lease for audited reconciliation.
The narrow exception is a completed setup failure proven to precede all identity access, with matching scope and an explicit untouched access journal. It stops the suite, preserves the failure, and releases only its own lease without claiming account absence. Location readiness also requires dismissing an optional location drawer through its own header close control before auth navigation; a mandatory picker is never dismissed without a selected location.
Set `E2E_ISOLATED_IDENTITY=false` locally only when deliberately testing the shared account; an interrupted run can block scheduled executions until recovery. Isolation does not replace cleanup: inspect an interrupted local run's `.auth/<runId>-<project>/manifest.json`, reconcile any account/orders, and recover its exact lease through the runbook. Never delete a lock merely because it is old.
HTTP 429 cooldowns honor `Retry-After` and persist across workers/devices; no cart, account or order mutation is replayed.
When the server reports half or less of its per-minute request allowance remaining, the next scenario waits for the reset (or a full minute when no reset is supplied). This pacing preserves capacity for a complete user journey without hiding API failures. Invalid cooldown evidence stops the next scenario.

A missing Google Places key remains a visible diagnostic. It becomes a recovered
warning only after a successful Mapbox response for the same query and document,
selection of one of its valid coordinates, navigation to the store, and matching
live/persisted location proof. Unrecovered geocoding errors and order/cart/auth
failures remain critical. Provider tokens and coordinates are excluded from the
recovery evidence; only fingerprints and sequence proof are retained.

## Slack reporting

After a scheduled run completes, the report publisher deploys its Playwright
reports to GitHub Pages, verifies the exact source run/attempt, then sends the
existing Slack webhook a summary, failure thumbnails and links to screenshots,
videos and the full report. Pages verification retries for up to roughly five minutes,
with cache-busting probes and safe error reasons. If deployment succeeds but the URL
is still unavailable, Slack includes a report link marked verification pending and
a saved-artifact fallback, without unverified thumbnails. Publication errors appear
separately from test outcomes and never turn a failed or passed test result into a
reporting infrastructure result. Passing evidence is retained for 3 days; failed evidence for 14.
Generated reports use Actions storage and Pages deployments; no report files enter Git history.
Pages evidence is public. See [docs/REPORT-DELIVERY.md](docs/REPORT-DELIVERY.md)
for setup, retention, exposure, rollout and local previews.
Without `SLACK_WEBHOOK_URL` delivery fails visibly. `DRY_RUN=1` prints the
payload without posting; `E2E_NOTIFICATIONS_DISABLED=true` blocks delivery entirely.

Optional Gemini explanations run only after failed/flaky cases are recorded.
Add `GEMINI_API_KEY` as a repository Actions secret to enable them; the publisher
uses `gemini-3.5-flash-lite` unless repository variable `GEMINI_MODEL` overrides it.
Analysis has a hard **120-second** process deadline and one API request per report.
Timeouts, quota errors and invalid output preserve the original results and report
delivery. Only allowlisted technical facts are sent, never raw logs, screenshots,
recordings, credentials, request bodies or personal details. Explanations label
possible causes as unconfirmed and never change pass/fail status. Set repository
variable `E2E_AI_ANALYSIS_DISABLED=true` to disable calls without removing the key.
See [docs/REPORT-DELIVERY.md](docs/REPORT-DELIVERY.md) for privacy and local use.

## Automatic schedules (IST)

Full web/Android/iOS emulation suite: **every two hours: 1 AM, 3 AM, 5 AM, 7 AM, 9 AM, 11 AM, 1 PM, 3 PM, 5 PM, 7 PM, 9 PM and 11 PM IST** (12 runs daily).
All scheduled runs use `all`; smoke remains available only as an explicit manual/local suite.
GitHub native cron remains a fallback. The optional Cloudflare clock checks every five minutes and recovers missing slots, with atomic admission preventing duplicate test execution. Activation requires its GitHub App, encrypted key and explicit cutover. A separate freshness check alerts on new overdue/missing outcomes. See [docs/INDEPENDENT-SCHEDULER.md](docs/INDEPENDENT-SCHEDULER.md) for deployment, verification and rollback.
Notifications report completed run outcomes, not scheduled start times. No exact-clock guarantee is implied.

## Scope

This personal GitHub repository owns the test runner, tests, diagnostics, reports and scheduling. Storefront application source, backend repositories, Bitbucket changes and application deployments are outside its scope. Application defects observed by the suite remain visible failures; they are not corrected by changing this test project.

COD/cash only; gateway document navigation is blocked. Run-owned account cleanup is positively verified.
Created orders are recorded and retained on the isolated test tenant; account deletion is not an order purge.
Critical fixture capabilities must be maintained. Optional product deep links are declared through `E2E_PRODUCT_DEEP_LINK`.
Custom order forms are optional on this tenant. Set `E2E_ORDER_FORMS=true` when the fixture requires them;
known loaded forms also promote form API failures to critical diagnostics. Required custom-field entry needs its own scenario.
Search, cart and bill assertions are intentionally strict; failures expose defects rather than being silently skipped. Accessibility, address-persistence, service-area-map and address-page scenarios were removed by owner decision and are no longer asserted here; known defects in those areas (including the address-page `getLoggedInUser` crash) are tracked outside this suite.
