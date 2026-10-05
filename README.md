# hyperzod-ordering-e2e

Playwright end-to-end test suite for the Hyperzod consumer ordering UI
(`hyperzod-ui-ordering`, Vue 3 + Vite storefront; test target is given by
`BASE_URL` - local dev server or a live store deployment).

## What it covers

| Stage | File | Flow |
| --- | --- | --- |
| setup | `tests/signup.setup.js` | Selects a delivery location, signs the test user up through the real UI (email intent -> signup form -> OTP), persists the session to `.auth/user-{web,android,ios}.json`. Falls back to login if the user already exists. |
| e2e | `tests/01-login.spec.js` | Fresh-browser login with password, logout, wrong-password rejection. |
| e2e | `tests/02-pages.spec.js` | Smoke sweep of every reachable page: home, search, merchant menu, checkout, profile, orders, addresses, language, help. |
| e2e | `tests/03-place-order.spec.js` | Full order: pick merchant -> add product -> checkout -> address -> COD payment -> place order -> verify on success page + order history. |
| e2e | `tests/auth/session.spec.js` | Session survives reload; profile sidebar with stored session. |
| e2e | `tests/location/location.spec.js` | Location gate persistence, service-area map, search input. |
| e2e | `tests/cart/cart.spec.js` | Cart API sync, persistence across reload, quantity stepper. |
| e2e | `tests/catalog/merchant.spec.js` | In-store search, global search, product detail deep-link. |
| e2e | `tests/checkout/checkout.spec.js` | Bill summary, address persistence, COD method listing. |
| e2e | `tests/profile/profile.spec.js` | Orders history, address book, language list. |
| e2e | `tests/errors/errors.spec.js` | CMS page shell stability. |
| e2e (mobile only) | `tests/mobile/home.mobile.spec.js` | Mobile viewport: no overflow, merchant open via tap, bottom-sheet cart. |
| e2e | `tests/a11y/a11y.spec.js` | `lang`/title/headings per route, image alt sampling, keyboard focus. |
| cleanup | `tests/delete-user.teardown.js` | Deletes the account via profile -> edit profile -> delete account, then proves `user_exists=false` on `/login/intent`. |

Stages are wired with Playwright project dependencies:
`setup` ➜ `web` / `android` / `ios` ➜ `cleanup` (teardown always runs, even when e2e fails).

## Device matrix

| Project | Device | Storage state |
| --- | --- | --- |
| `web` | Desktop Chrome 1440x900 | `.auth/user-web.json` |
| `android` | Pixel 7 emulation | `.auth/user-android.json` |
| `ios` | iPhone 14 emulation | `.auth/user-ios.json` |

`01-login.spec.js` runs on `web` only (single session owner); `*.mobile.spec.js`
runs on `android`/`ios` only; everything else runs on all three.

## Structure (modular)

```
playwright.config.js      # setup -> web/android/ios -> cleanup, JUnit + HTML reports
fixtures/test.fixture.js  # console/network capture + plain-language failure report
pages/ordering.pages.js   # POMs: Welcome / Home / Merchant / Checkout / Profile
flows/order.flow.js       # shared COD order steps (no copy-paste across specs)
utils/app.js              # auth + location flows, API paths, boot wait
utils/env.js              # env validation + per-project storage states
utils/reporting.js        # plain-language failure summary + console log attach
tests/auth|location|cart|catalog|checkout|profile|errors|mobile|a11y/
```

## Test target
One variable decides everything — no code changes needed.
All testing happens against the store deployment:

```powershell
$env:BASE_URL="https://automations-store.hyperzod.me/"
```

Or set `BASE_URL` permanently in `.env` (already the default). Rules:
- `TEST_LOCATION_QUERY` must be inside that store's service area.
- The run registers its own user on that tenant and deletes it afterwards,
  so every run pushes fresh testing data and leaves nothing behind.
- The setup project fails fast with a plain message if the URL is unreachable.

## Prerequisites

- Node 18+
- `hyperzod-ui-ordering` checked out next to this folder with its
  `node_modules` installed (`npm install` inside that repo once).

## Setup

```powershell
cd C:\Hyperzod_repo\hyperzod-ordering-e2e
npm install
npx playwright install chromium webkit
```

Copy `.env.example` to `.env` and adjust if needed:

- `TEST_USER_EMAIL` / `TEST_USER_PHONE` / `TEST_USER_PASSWORD` – account that
  will be created and deleted by the run.
- `TEST_LOCATION_QUERY` – text typed into the welcome-page location box
  (first suggestion is picked); must be inside the tenant's service area.
- `BASE_URL` – the store under test (default: https://automations-store.hyperzod.me/).
  Only localhost targets auto-start the dev server; remote deployments are
  tested as-is.
- `AUTO_START_SERVER=false` – skip auto-start when you already have the dev
  server running (local targets only).

## Run

```powershell
npm test                 # everything: setup -> web+android+ios -> cleanup
npm run test:web         # desktop suite only
npm run test:android     # android emulation only
npm run test:ios         # iOS emulation only
npm run test:mobile      # both mobile emulations
npm run test:smoke       # @smoke subset on web (fast gate)
npm run test:headed      # watch it happen
npx playwright test --project=setup          # only signup
npx playwright test tests/03-place-order.spec.js --project=web
npm run report           # open the HTML report
```

> Timings (headless, real backend): smoke ~3 min, web ~8 min,
> android ~10 min, iOS ~18 min. `npm test` runs all three projects
> back-to-back (~35 min) because they share one test user and must stay
> serial - do not parallelize projects against the same `TEST_USER_EMAIL`.

## Scheduled runs (automatic, at fixed intervals)

Two free options — same rule for both: **never let two runs overlap**
(shared user/cart), so each is strictly serial end-to-end.

**Option A — GitHub Actions (recommended, free).**
Two workflows (same concurrency group, so they never overlap):
`scheduled-e2e.yml` runs the full matrix at 6 PM IST,
`scheduled-e2e-smoke.yml` runs smoke at 5 AM, 3 AM, 1 PM + 1 AM IST.
Manual runs: `Actions → scheduled-e2e* → Run workflow` (schedule-triggered
runs always use their fixed suite; manual runs use your pick).
Public repos: unlimited free minutes; private: 2,000 min/month.
Setup: push this folder to GitHub, then add repository secrets —
`E2E_BASE_URL`, `E2E_USER_FIRST_NAME`, `E2E_USER_EMAIL`, `E2E_USER_PHONE`,
`E2E_USER_COUNTRY`, `E2E_USER_PASSWORD`, `E2E_LOCATION_QUERY`,
`E2E_FALLBACK_OTP`, plus `SLACK_WEBHOOK_URL` for the per-run Slack summary.
Evidence (report + traces + videos) uploads as
artifacts, kept 14 days. (Bitbucket's free tier is only ~50 min/month while
one full matrix costs ~35 min — that's why scheduling lives on GitHub;
Bitbucket keeps the PR smoke gate.)

**Option B — this machine (fully free, no cloud).**
`scripts/nightly-run.ps1` runs any suite headless with timestamped logs
(`scheduled-logs/`, last 30 kept) and a console scoreboard:

```powershell
.\scripts\nightly-run.ps1 -Suite smoke    # quick nightly gate (~3 min)
.\scripts\nightly-run.ps1 -Suite all      # full matrix (~35 min)
```

Register it in Windows Task Scheduler for true intervals (elevated
PowerShell once):

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -File `"C:\Hyperzod_repo\hyperzod-ordering-e2e\scripts\nightly-run.ps1`" -Suite all"
$trigger = New-ScheduledTaskTrigger -Daily -At 02:00
Register-ScheduledTask -TaskName "OrderingE2E-Nightly" `
  -Action $action -Trigger $trigger -Description "Nightly ordering E2E"
```

The machine must be on at run time; use "Run whether user is logged on or
not" with stored credentials for overnight runs.

## Failure reports (plain language)
Every failure prints to the console:

```
================ FAILED TEST (plain language) ================
What happened : "..." did not finish.
Which feature : Cart (add / update) is broken or blocked the flow.
Where         : tests/... @ <url>
Technical hint: ...
App showed    : "<toast text the user saw>"
Failed calls  : 500 POST .../store/v1/cart ...
Evidence      : trace + video + screenshot in test-results, console log attached
============================================================
```

Plus attachments in the HTML report: `console-log` (console errors, page
errors, failed API calls) and `console-state` (screenshot as the user saw it).
Config keeps `trace/video/screenshot: retain/on-failure`.

### Slack alerts (latest report per scheduled run)
Every scheduled run posts a one-block summary to Slack (✅/❌ counts,
failing test names, run link). One-time setup:
1. Slack workspace → create an app (api.slack.com/apps) → **Incoming
   Webhooks** → add one to your channel → copy the URL.
2. GitHub repo → **Settings → Secrets and variables → Actions** → add
   `SLACK_WEBHOOK_URL` (plus the 8 `E2E_*` secrets).
3. Done — `scripts/notify-slack.py` runs at the end of both workflows
   (`if: always()`), parses `test-results/junit.xml`, and posts.
   No webhook configured → it exits silently; notifications can never
   fail a test run.

## Policy

- **Payments: COD/Cash only.** Specs must `test.skip()` with `SKIP-BY-POLICY`
  when a tenant offers no COD method — never click an external gateway.
- Tests run serially (`workers: 1`) per project because they share one user
  account and one cart.
- The delete teardown is self-healing: it re-logs-in if the session died and
  skips gracefully when the user is already gone.
- **One shared test user.** All projects use the same `TEST_USER_EMAIL`
  (server-side cart persists between projects), so projects must run serially
  (`workers: 1`, chained npm scripts). Never run two projects concurrently
  against the same email - sessions and carts will clobber each other.
- **Backend throttle:** the dev boot API rate-limits (`429 Too Many Attempts`
  on `/store/v1/boot`, surfacing as CORS blocks on WebKit). The suite backs
  off (20s/45s/75s + reload, boot) and retries checkout navigation (3x),
  cart sync (3 rounds) and session restore (3 reloads) before failing. A
  failure whose `console-log` shows 429s is infra noise, not an app bug —
  the plain-language report labels it as such.

## Notes / assumptions

- The dev auth API echoes the OTP code in the register/verify responses
  (`data.otp.code`); the suite reads it from the network. If your backend
  does not echo it, set `TEST_FALLBACK_OTP` to the static dev OTP.
- The order test prefers a Cash/COD payment method so no external payment
  gateway is opened; if none exists it skips by policy (see above).
- CI: `bitbucket-pipelines.yml` runs the `@smoke` gate on PRs; full
  `e2e-web` / `e2e-mobile` run as custom pipelines.
