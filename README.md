# hyperzod-ordering-e2e

Playwright tests for the Hyperzod ordering storefront on the isolated automation tenant.
See [HARDENING.md](HARDENING.md) for safety, leases, reporting, scheduling and acceptance requirements.

## Install and configure

Run `npm ci` and copy `.env.example` to `.env`. GitHub uses the repository's existing `E2E_*` secrets.
The default allowed target is `https://automations-store.hyperzod.me`; other test origins require explicit `E2E_ALLOWED_ORIGINS`.
Run `npm run check:env` before live execution. Local live runs require an authenticated `gh` CLI;
Bitbucket requires `E2E_LEASE_TOKEN` with repository contents read/write. All runners coordinate the shared identity.
If a runner crashes, inspect and recover its exact lease only by following [docs/LEASE-RECOVERY.md](docs/LEASE-RECOVERY.md).

## Offline verification

`npm run lint` checks syntax, YAML, imports, focused tests, image alignment and critical module types.
`npm run test:unit` and `python -m unittest discover -s tests-unit -p '*_test.py'` use mocks and do not contact the storefront or Slack.
`npm run test:diagnostics:browser` verifies navigation diagnostics in Chromium and WebKit against loopback fixtures only. Install them with `npx playwright install --with-deps chromium webkit`; PR static checks run these regressions too.

## Authorized storefront execution

`npm run test:smoke`, `test:web`, `test:android`, `test:ios`, `test:mobile` and `npm test` use the serial managed runner.
The full suite continues through all requested devices, preserves their reports, and returns aggregate failure status.
Use `npm run report -- web` to inspect one device's report. Direct unmanaged live Playwright runs are blocked.

To validate locally with a distinct test email/phone while preserving `.env`:

```powershell
$env:E2E_ISOLATED_IDENTITY = 'true'
$env:E2E_NOTIFICATIONS_DISABLED = 'true'
npm run test:smoke
# npm test runs the complete web / Android / iOS emulation matrix.
```

The runner does not send notifications. `E2E_NOTIFICATIONS_DISABLED=true` also blocks the standalone notifier.
`E2E_ENV_FILE` can select an existing private env file without copying it into another checkout.
Missing cleanup proof or an ambiguous order stops subsequent devices and retains the lease for audited reconciliation.
HTTP 429 cooldowns honor `Retry-After` and persist across workers/devices; no cart, account or order mutation is replayed.
When the server reports half or less of its per-minute request allowance remaining, the next scenario waits for the reset (or a full minute when no reset is supplied). This pacing preserves capacity for a complete user journey without hiding API failures. Invalid cooldown evidence stops the next scenario.

## Email reporting

Scheduled runs email one plain-text report (status, aggregate and per-device
counts, issues, failed tests, IST completion time) to the owner's address.
Set repository secrets `MAIL_TO`, `MAIL_USERNAME` and `MAIL_PASSWORD`
(Gmail: full address plus an app password; optional `MAIL_SMTP_HOST`,
`MAIL_SMTP_PORT`, `MAIL_SMTP_SECURITY`, `MAIL_FROM`). Without them the step
logs a skip notice and stays green. Slack incoming-webhook notifications are
unwired for now; `scripts/notify-slack.py` is retained for later restoration.

## Automatic schedules (IST)

Smoke: 1 AM, 3 AM, 5 AM and 1 PM daily. Full suite: 6 PM daily.
GitHub schedules may be delayed or dropped; a separate freshness check alerts on new overdue/missing outcomes.
Notifications report completed run outcomes, not scheduled start times. No exact-clock guarantee is implied.

## Scope

This personal GitHub repository owns the test runner, tests, diagnostics, reports and scheduling. Storefront application source, backend repositories, Bitbucket changes and application deployments are outside its scope. Application defects observed by the suite remain visible failures; they are not corrected by changing this test project.

COD/cash only; gateway document navigation is blocked. Run-owned account cleanup is positively verified.
Created orders are recorded and retained on the isolated test tenant; account deletion is not an order purge.
Critical fixture capabilities must be maintained. Optional product deep links are declared through `E2E_PRODUCT_DEEP_LINK`.
Custom order forms are optional on this tenant. Set `E2E_ORDER_FORMS=true` when the fixture requires them;
known loaded forms also promote form API failures to critical diagnostics. Required custom-field entry needs its own scenario.
Search, cart and bill assertions are intentionally strict; failures expose defects rather than being silently skipped. Accessibility, address-persistence, service-area-map and address-page scenarios were removed by owner decision and are no longer asserted here; known defects in those areas (including the address-page `getLoggedInUser` crash) are tracked outside this suite.
