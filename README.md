# hyperzod-ordering-e2e

Playwright tests for the Hyperzod ordering storefront on the isolated automation tenant.
See [HARDENING.md](HARDENING.md) for safety, leases, reporting, scheduling and acceptance requirements.

## Install and configure

Run `npm ci` and copy `.env.example` to `.env`. GitHub uses the repository's existing `E2E_*` secrets.
The default allowed target is `https://automations-store.hyperzod.me`; other test origins require explicit `E2E_ALLOWED_ORIGINS`.
Run `npm run check:env` before live execution. Local live runs require an authenticated `gh` CLI;
Bitbucket requires `E2E_LEASE_TOKEN` with repository contents read/write. All runners coordinate the shared identity.

## Offline verification

`npm run lint` checks syntax, YAML, imports, focused tests, image alignment and critical module types.
`npm run test:unit` and `python -m unittest discover -s tests-unit -p '*_test.py'` use mocks and do not contact the storefront or Slack.

## Authorized storefront execution

`npm run test:smoke`, `test:web`, `test:android`, `test:ios`, `test:mobile` and `npm test` use the serial managed runner.
The full suite continues through all requested devices, preserves their reports, and returns aggregate failure status.
Use `npm run report -- web` to inspect one device's report. Direct unmanaged live Playwright runs are blocked.

## Automatic schedules (IST)

Smoke: 1 AM, 3 AM, 5 AM and 1 PM daily. Full suite: 6 PM daily.
GitHub schedules may be delayed or dropped; a separate freshness check alerts on new overdue/missing outcomes.
Notifications report completed run outcomes, not scheduled start times. No exact-clock guarantee is implied.

## Scope

COD/cash only; gateway document navigation is blocked. Run-owned account cleanup is positively verified.
Created orders are recorded and retained on the isolated test tenant; account deletion is not an order purge.
Critical fixture capabilities must be maintained. Optional product deep links are declared through `E2E_PRODUCT_DEEP_LINK`.
Accessibility, search, persistence and bill assertions are intentionally strict; failures expose defects rather than being silently skipped.
