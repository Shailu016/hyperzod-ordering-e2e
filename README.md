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

## Slack reporting

Reports use one Block Kit heading, aggregate counts, per-device outcomes, critical lifecycle checks, failure details,
IST completion time and evidence/store buttons. `not run` is distinct from a declared optional skip.
Run `python scripts/preview-slack.py` to render examples locally, or append a summary path after the output filename
to preview a real run. This preview has no delivery path. `DRY_RUN=1` on the notifier prints its JSON without posting.
The Slack app's name and avatar are managed in its Slack configuration; incoming-webhook payloads cannot override them.

## Automatic schedules (IST)

Smoke: 1 AM, 3 AM, 5 AM and 1 PM daily. Full suite: 6 PM daily.
GitHub schedules may be delayed or dropped; a separate freshness check alerts on new overdue/missing outcomes.
Notifications report completed run outcomes, not scheduled start times. No exact-clock guarantee is implied.

## Scope

COD/cash only; gateway document navigation is blocked. Run-owned account cleanup is positively verified.
Created orders are recorded and retained on the isolated test tenant; account deletion is not an order purge.
Critical fixture capabilities must be maintained. Optional product deep links are declared through `E2E_PRODUCT_DEEP_LINK`.
Custom order forms are optional on this tenant. Set `E2E_ORDER_FORMS=true` when the fixture requires them;
known loaded forms also promote form API failures to critical diagnostics. Required custom-field entry needs its own scenario.
Accessibility, search, persistence and bill assertions are intentionally strict; failures expose defects rather than being silently skipped.
