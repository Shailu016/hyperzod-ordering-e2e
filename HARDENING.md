**Production automation hardening**

Credential/example changes are intentionally excluded at the user's request. No storefront execution or manual Slack notification was used to validate these changes.

**Runner and reports**

Use the existing `npm run test:smoke`, `test:web`, `test:android`, `test:ios`, `test:mobile`, or `npm test` commands. They now use one serial Node runner. Every project has its own artifacts, HTML, JSON and JUnit output under `test-results/<run>/<project>/`. `test-results/summary.json` aggregates every requested project and records missing, failed, flaky and skipped coverage. Signup, account cleanup and COD order placement must pass for each requested device; incomplete coverage is never green. `npm run report -- web` selects a device report.

No storefront tests run on a draft PR. Static and mocked regression checks can run without a storefront or webhook. A trusted, non-draft PR additionally runs smoke as an automatic gate. GitHub branch protection must require `static` and `release-gate` checks before merging; repository code cannot enforce branch protection by itself. The release gate requires successful trusted smoke execution, including for fork PRs, which need a trusted integration branch before approval.

The repository's `main` protection is configured to require a pull request, an up-to-date branch, `static` and `release-gate`, and resolved review conversations, including for administrators. Force pushes and branch deletion are disabled. Zero approving reviews are required so the repository owner can use the PR workflow without needing a second account; CI and the draft/ready state still gate promotion. These settings are applied through GitHub and must also be configured if this project is copied to another repository.

**Identity coordination**

All live invocations acquire an atomic GitHub tag ref `e2e-lease-<identity hash>` before touching the store. The lease is shared by local, Bitbucket and GitHub runners using the same target/email. GitHub uses its job token with `contents: write` solely for creating/releasing the ref and its ownership commit. Local runs use an authenticated `gh` CLI; Bitbucket requires `E2E_LEASE_TOKEN` with repository contents read/write. The main branch is not changed by lease acquisition.

A conflicting lease blocks the run and reports infrastructure failure. Lease release verifies its owner. A runner killed before `finally` may leave a lease behind; do not remove it until the owner is confirmed inactive and its recorded resources are reconciled. There is deliberately no timeout-based lease stealing while a run could still be mutating the shared test account. Direct unmanaged Playwright executions are blocked by lifecycle fixtures; use the npm runners.

Targets are restricted to `https://automations-store.hyperzod.me` by default. To authorize another isolated tenant or local origin, set `E2E_ALLOWED_ORIGINS` to comma-separated complete origins. A syntactically valid URL alone no longer authorizes destructive lifecycle operations. Metadata and auth state are scoped per run, target and configured identity. Unknown authenticated identity or unresolved cleanup is an error.

**Mutation policy and fixtures**

Automatic Playwright retries are disabled for real account/cart/order mutations. Navigation retries are bounded and restricted to transient navigation errors. Cart setup clears the fixture via UI and verifies emptiness after reload. Cart addition is submitted once; no blind replay occurs if the observation fails. Order interception verifies account, cart and selected offline payment ID and allows only one submission. Order IDs and expected bill/lines are recorded before checking navigation/history.

The selected fixture must provide a working quantity stepper, serviceable delivery location, orderable merchant and supported offline Cash/COD method. Missing core capabilities fail visibly. Product deep links are optional only when explicitly declared with `E2E_PRODUCT_DEEP_LINK=true`; absence when enabled fails. Keep tenant fixture data maintained. The stricter assertions may expose existing storefront defects, especially accessibility, billing, maps and persistence, rather than silently accepting them.

Orders are deliberately retained on the isolated automation tenant and recorded as `test-tenant-order-retained`; account deletion is not described as order deletion. A backend administrative cancellation/purge integration needs documented supported semantics before automating it. Never retry an ambiguous recorded submission. Each project's `resource-lifecycle.json` preserves submission attempts and cleanup outcomes in uploaded evidence; auth state and the credential fields are excluded. An operator must reconcile ambiguous submissions before rerunning.

Cash/COD selection uses `payment_mode.name`, `is_offline_mode`, support/eligibility flags, selected payment ID and the outgoing order request. External payment document navigation is blocked. Bill checks compare line subtotals, explicit taxes/fees/discounts/adjustments, currency and formatted values displayed in checkout. Confirm these contracts against the deployed backend in an authorized live verification run before promotion; no such run was performed during this work.

**Notifications and freshness**

The notification script consumes the aggregate summary. Missing or invalid reports produce infrastructure-failure messages; missing webhooks, non-acknowledged responses and exhausted delivery attempts fail the notification step. HTTP 429/temporary server failures retry with bounded waits, respecting `Retry-After`. Flaky/incomplete/critical-skipped coverage cannot be presented as healthy. No notification command was executed against a real webhook during validation.

The independent `schedule-freshness` workflow checks due scheduled runs every 15 minutes, with a 45-minute grace period, and alerts only on a new actionable incident. Delivery acknowledgement is persisted before suppressing repeat alerts. Monitor activation uses the workflow's last change time so historical missed runs do not alert immediately at rollout. It does not run storefront tests. Because GitHub can delay both schedules, it cannot guarantee exact-clock execution or notification; run `scripts/check-schedule.js` from an independently operated scheduler if availability guarantees require independence from GitHub. The script itself is scheduler-neutral; provide read access through `GITHUB_TOKEN`.

**Diagnostics and offline verification**

HTTP, application-level and transport errors are captured for first-party APIs. Unexpected page/network failures invalidate critical UI checks; the negative-login test explicitly permits its expected rejection. Text logs redact credentials, tokens and personal identifiers. Network traces are disabled by default; enable `E2E_RETAIN_SENSITIVE_TRACES=true` only when artifact access and retention are appropriate. Screenshots/video still show the test UI.

`npm run lint` validates JavaScript syntax, rejects focused tests, parses workflow YAML, checks Playwright image/package alignment, lists tests without executing them, and type-checks the critical policy/lease/manifest/report/scheduler modules. `npm run test:unit` uses local mocks only. Python notifier checks use mock responses: `python -m unittest discover -s tests-unit -p '*_test.py'`. The PowerShell runner invokes Node directly and preserves the aggregate exit code. Playwright package/image versions are pinned to 1.61.1.

The implementation is reviewable and statically verified. Live multi-device execution, backend billing/order contracts and API identity behavior remain deployment acceptance checks; they cannot be honestly claimed verified from offline tests.
