# PR acceptance and storefront health

The E2E tool's release decision is distinct from the storefront's health. Live tests still run unchanged and their JSON, HTML and scheduled Slack results retain failures.

The owner authorized a narrow baseline exception for `address-getter-call`: the address-book test raises the page error `this.getLoggedInUser is not a function`. The observed failed run is https://github.com/Shailu016/hyperzod-ordering-e2e/actions/runs/40889329902. The matching storefront component maps the user getter as a computed property but calls it as a function. The test remains enabled. This exception expires **12 November 2026, 00:00 UTC**; renewing or expanding it requires an explicit reviewed policy change.

`scripts/check-pr-acceptance.js` verifies raw reports and lifecycle evidence from this CI run. It permits only the exact case/title, diagnostic-guard failure and matching captured page-error signature, with no additional critical events or errors. All devices must execute, signup/COD/cleanup must pass on their first attempts, counts must agree with reconstructed raw reports, optional skips must be declared, and resources must be reconciled. New failures, missing/invalid diagnostics, expired exceptions, unexpected process exits, failed cleanup, ambiguous orders, missing devices and flaky results block acceptance.

The raw suite step may fail, but a separate mandatory policy step always runs and must pass. The decision is saved as `test-results/pr-acceptance-decision.json` and described in the GitHub job summary. `accepted-with-known-storefront-issue` means the automation may be released despite this recorded storefront defect; it does not mean the storefront is healthy. No test summary is rewritten, no assertion is skipped, and scheduled monitoring/reporting is unchanged.

Once the storefront correction is deployed, the test must pass normally; remove the baseline entry through a reviewed PR. Do not add broad error-pattern exemptions or repeatedly rerun account/order mutations to chase a green result.
