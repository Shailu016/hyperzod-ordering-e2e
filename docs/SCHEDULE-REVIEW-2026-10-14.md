# Schedule freshness incident — 14 October 2026

## Evidence and cause

The screenshot's successful smoke report is scheduled run [38567995745](https://github.com/Shailu016/hyperzod-ordering-e2e/actions/runs/38567995745), created at 18:28:38 IST and finished around 18:33. The full workflow is a separate schedule due at 18:00 IST. At the [20:19 monitor check](https://github.com/Shailu016/hyperzod-ordering-e2e/actions/runs/38583878737), GitHub had not created the October 14 full run. A smoke pass does not provide full-device coverage.

The previous full scheduled run [38454937597](https://github.com/Shailu016/hyperzod-ordering-e2e/actions/runs/38454937597) was created at 00:57:11 IST on October 14, almost seven hours after its October 13 due time, then completed successfully in about 28 minutes. The October 12 scheduled full run was created at 02:51 IST on October 13. The full workflow is active. Delays occur before a workflow run is created, so neither test code nor runner startup explains them. The freshness workflow also ran hours apart despite its 15-minute cron. This is delayed GitHub schedule dispatch, with possible dropped triggers, rather than evidence of failed storefront tests. [GitHub documents that scheduled events may be delayed or dropped under load](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows).

The monitor correctly detected missing scheduled coverage. Its message was misleading: generic `Infrastructure Failed`, `Results`, and `No complete test report available` looked like a failing test report. Its aggregate fingerprint could also re-alert an already acknowledged slot when a run ID appeared or a different workflow recovered. It assessed completed failing E2E jobs as freshness incidents even though the E2E workflow already owns those result notifications.

## Local corrections

- Dedicated schedule-alert wording, IST due/check times, and a monitor-details link. Missing or cancelled execution stays actionable; it is never presented as a test pass.
- Acknowledgement per workflow and scheduled slot, retained through recovery/status changes and pruned after 14 days. Only new slots appear in an alert. State is acknowledged after successful delivery, preserving retry behavior. Matching legacy fingerprints migrate without repeating delivery.
- Completed E2E successes/failures count as executed for freshness. Cancelled/skipped or overdue execution still alerts. Future timestamps and manual dispatch do not satisfy a scheduled slot. Invalid daily cron values fail explicitly.

No schedule time or 45-minute grace was loosened to hide missing coverage. No workflow was dispatched, storefront test run, or Slack message sent during validation. The correction was initially prepared locally; the user subsequently authorized pushing it for review.

These changes improve monitor correctness and reporting; they cannot repair GitHub's scheduler. Exact-time execution requires an independently operated scheduler to dispatch the existing workflow. The same delayed GitHub cron is not an independent watchdog. An external scheduler and credentials have not been configured as part of this monitor correction.

## Verification

Local lint passed, all 82 JavaScript offline regressions passed, and all 13 mocked Python notification tests passed. The screenshot, delayed/active/cancelled execution, completed test failures, repeated-alert transitions, legacy state migration, invalid cron input, and Slack presentation are covered. No storefront tests or real notification delivery were invoked.
