# Tool merge policy and storefront results

The owner chose to separate personal E2E tool releases from live storefront health.

Only the `static` check is required by main branch protection. It verifies syntax, types, mocked regression tests and loopback browser tests. Pull requests, an up-to-date branch and resolved review conversations remain required; force pushes and branch deletion remain disabled.

Trusted non-draft PRs still run live desktop, Android and iOS verification using an isolated test identity. The job remains failed when tests fail and always uploads available evidence. It is informational for merging. Scheduled tests and Slack reports continue reporting real failures. Existing live runs are allowed to finish cleanup.

The `release-gate` job and the address-defect waiver were removed. No failure is reclassified as passed, no assertion is skipped and no lifecycle or lease-safety rule is relaxed. Removing the merge gate does not fix storefront bugs or recover abandoned test-account locks.

GitHub required status checks are repository settings; updating this YAML alone cannot remove an existing required `release-gate` check. The main branch setting must require only `static`.
