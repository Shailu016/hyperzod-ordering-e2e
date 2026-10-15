# Slack evidence delivery

The existing Slack incoming webhook posts the result after a separate publisher
has deployed and verified its public GitHub Pages report. No bot token or paid
storage service is required.

## What the message contains

- Overall result, per-device counts, lifecycle checks and IST completion time.
- Up to three failed/flaky case summaries, with screenshot thumbnails for the first two.
- Per-case links to the failure page, original screenshot and a page with a playable video.
- **Open full report**, **View failed cases** and **GitHub run** buttons.

The full report includes all captured failure details and the original interactive
Playwright HTML report for each device. These are actual run artifacts. Missing
screenshots or videos are stated explicitly; no placeholder evidence is generated.
Browser video playback depends on browser codec support; a download link is also available.
The offline browser regression requires playback in Chromium and Linux WebKit.
Windows WebKit stalls on the original raw WebM in local checks; on that platform
the regression verifies screenshots, native reports and a byte-for-byte video download.
These browser emulations do not establish compatibility with every physical device.

## Hosting setup and rollout

In this repository's **Settings → Pages**, select **GitHub Actions** as the build
source. The publisher uses `pages: write`, `id-token: write`, `actions: read`,
`contents: read` and the `github-pages` environment. Allow `main` to deploy to that
environment. Keep the existing `SLACK_WEBHOOK_URL` secret.

Merge the publisher and both scheduled workflow changes together. Completed
`scheduled-e2e-smoke` and `scheduled-e2e-full` runs from this repository's `main`
trigger publication. Source workflows mark their delivery version; older runs keep
their original notifier and are ignored by the new publisher to avoid duplicate
notifications during rollout. A manual rerun is a distinct attempt and may send a
new result. Webhook acknowledgement retries cannot guarantee exactly-once delivery.

Source artifacts include both the run number and attempt. An identity sidecar and
the deployed manifest must match the source run, attempt and commit. The publisher
checks out trusted `main` code and never executes downloaded artifact content.

The initial site appears after the first eligible completed run. The publisher's
manual dispatch only rebuilds retained history; it does not run tests or send Slack.
It cannot produce a report before any eligible evidence exists.

## Public evidence and storage

GitHub Pages is public for this project. Anyone with the URL can view the report,
screenshots, videos and test diagnostics embedded in the native Playwright HTML.
Use only the isolated automation tenant and test identities. `noindex` is a search
hint, not access control. Slack may cache previews independently of site retention.

The bundle copies native HTML assets and selected screenshots/videos. Media already
present in the native report is reused without a duplicate copy. `.env`, authentication
state and raw result folders are not copied. Trace ZIP archives
are rejected from public bundles because they can contain request and session
data. Enabling `E2E_RETAIN_SENSITIVE_TRACES` requires a separate review of private
evidence hosting; it will currently stop public publication and use the GitHub fallback.
Native reports themselves contain diagnostics: this is not a general data redaction service.

Reports have immutable URLs per source run and attempt:
`<Pages URL>/runs/<run-id>-<attempt>/`. History is restored from generated Actions
artifacts before each deployment. No `gh-pages` branch or committed media is used.

- Passing bundles and raw evidence: 3 days.
- Failed/infrastructure bundles and raw evidence: 14 days.
- Expired site content: removed on the next successful publication or the daily
  cleanup workflow (23:47 IST). GitHub schedules are best effort.
- Site size budget: 850 MiB; an oversized deployment fails visibly rather than
  silently removing evidence that is still within retention.
- Per-run public bundle limit: 250 MiB, including native assets and failure media.
  Larger evidence remains in the source GitHub artifact and is reported as a delivery error.

Publication is serialized so concurrent completions preserve each other's report
links. A history download error preserves the existing live deployment. If the
current report cannot be published or verified, Slack identifies a report-delivery
infrastructure error and links to the source GitHub run's evidence instead of
advertising an unavailable report. Inspect the `publish-ordering-reports` workflow
for delivery failures. The source workflow remains the authority for test execution.

## Offline verification

```powershell
npm run lint
npm run test:unit
python -m unittest discover -s tests-unit -p '*_test.py'
npm run test:diagnostics:browser
npm run test:reports:browser
```

These checks use mocks or loopback pages. They do not run storefront tests or
send Slack messages. Never test the webhook just to check layout.

`python scripts/preview-slack.py test-results/slack-preview.html` renders clearly
labelled example messages locally. For an existing summary and publication context:

```powershell
python scripts/preview-slack.py test-results/slack-preview.html <summary.json> <context.json>
```

The optional context contains `GITHUB_REPOSITORY`, source `GITHUB_RUN_ID`,
`GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`,
`E2E_REPORT_PUBLISH_STATUS=success`, `E2E_REPORT_BASE_URL` and
`E2E_PUBLICATION_FILE`. It needs no secret and does not call the delivery function.
