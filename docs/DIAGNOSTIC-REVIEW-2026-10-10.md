# Navigation and diagnostic review — 10 October 2026

Scope: only the personal E2E project changes. The storefront source was inspected read-only. No Slack notifications are sent during validation.

## Historical evidence

Run `1791572098540-6c59c4e9-1ad5-4dee-9ec2-06386f251e9c`, source `a829926`: 69 passed, 30 failed, 3 declared skips. Those raw reports remain unchanged.

- Seven failed device results contain direct storefront-defect evidence: address getter TypeErrors on three profiles, actual axe accessibility violations on three profiles, and an iOS GPS/coordinates TypeError. These are not ignored.
- Android merchant search was interrupted by Windows sleep (00:40–09:47 IST), lost its network, timed out and needed its stuck worker stopped. It cannot establish a storefront defect.
- Twenty-one other failures arose only in the diagnostic guard after the scenario assertions completed. One additional iOS scenario timed out entering the merchant. These historical results alone cannot prove a user-visible failure or a harmless cancellation.

## Causes established by code and evidence

The navigation wrapper previously drained response-body inspections but not active API requests. Startup asynchronously retrieves the user, addresses and coupons after the initial UI is visible. A fast test can navigate away while these requests are running. The UI user action dispatches logout after an unsuccessful user read, so an interrupted startup read can also initiate a logout request as the old document is discarded. A WebKit access-control-shaped rejection during this sequence is not enough to diagnose a server CORS configuration problem. Unexplained logout/CORS errors remain critical.

The coupon action logs `listAvailableCoupons response` when its response has no usable data. In the historical iOS language-page evidence, a proven navigation-discarded coupon GET is sequence 55 and the exact `listAvailableCoupons response {data: undefined}` console echo is sequence 56. Treating that echo as a second independent application defect is a classification error. Missing coupon data without this evidence can affect coupon discovery and remains a failure.

The report summarizer previously replaced specific assertions with the first diagnostic message. This obscured real accessibility violations with coupon errors and replaced the Android execution timeout with a transport message.

## E2E corrections

- Settle tracked first-party API calls and response bodies before explicit navigation and after application boot. Bound the wait; an incomplete wait blocks navigation and records failure instead of cancelling an in-flight mutation.
- Recognize a cancelled read as recovered only after a later successful identical method, URL and body fingerprint. Earlier or unrelated successes and mutations cannot satisfy this rule.
- Downgrade only the exact coupon console echo immediately following a proven navigation-discarded coupon GET. Preserve the warning; missing cancellation proof, HTTP/application failures, different messages and coupon-dependent scenarios remain critical.
- Preserve original UI, accessibility, navigation and execution assertions in summaries. Expand API diagnostics only when the assertion is the generic diagnostic guard.

No blanket console-error, CORS, coupon endpoint or timeout exception was introduced. The merchant-navigation timeout is not suppressed or automatically replayed.

## Verification

Offline regression tests cover bounded settlement, blocking unresolved writes, proof requirements, read recovery and preservation of genuine failures. `npm run test:diagnostics:browser` exercises actual Chromium and WebKit against loopback-only fixtures: successful delayed startup reads are not cancelled, HTTP 503 remains critical, and application-initiated cancellation without navigation remains critical.

Live post-change results are recorded below when complete; the historical report above is not reclassified into passes.
