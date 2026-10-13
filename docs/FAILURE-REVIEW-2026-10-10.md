# Review of the two desktop smoke failures — 10 October 2026

Scope: study the ordering UI source without changing it; all implementation changes belong to this personal E2E repository. No Bitbucket writes, application deployment, Slack delivery or live storefront rerun was performed for this review.

## Evidence and verdict

The reviewed report is run `1791569779958-2b8ca88a-79cc-48e8-b258-bb9e08132eec`, on automation commit `e1cb9da`, finished at `2026-10-09T18:20:48.788Z`: **16 passed, 2 failed**. These historical results remain unchanged.

| Failed test | Verdict | Evidence |
| --- | --- | --- |
| `addresses page renders` | Confirmed application JavaScript defect; keep failing | The page maps `getLoggedInUser` as a computed getter value, then calls it as a function in `fetchAddresses`. The captured TypeError matches execution of the unedited component method. |
| `welcome redirects away once a serviceable location is stored` | Redirect/persistence assertions passed; application-defect classification is inconclusive | The failure comes from the diagnostic fixture: `/store/v1/address` and `/auth/v1/me` were aborted without proven navigation attribution. There were no captured console or page errors in this scenario. |

The original UI checkout is `dev` at `b13d0bea114de5690da1d02e8526b949cc14d308`. The locally cached master source at `e2d21bb9c04fa77589a6cc9d15777eee1db91fdf` contains the same invalid address getter call and asynchronous startup reads. No fetch or checkout change was needed to inspect it. Repository status was checked before and after the review.

## Address failure

The UI getter returns the logged-in user object (or null). The address component's `created` hook calls `fetchAddresses` when its address list is empty. That method invokes the getter as a callable and throws before the component dispatches its own address request. A prefetched, nonempty address list can bypass this path, which explains why manual reproduction may vary.

An isolated execution of the actual unedited Vue component, with a valid user object and unrelated imports stubbed, reproduced `this.getLoggedInUser is not a function`. The request spy remained untouched. This was a local source-contract check, not a live application test. The page container can still render despite this error; its presence alone is insufficient for acceptance. No exception was added to the E2E diagnostic policy for this error.

## Welcome failure

The router redirects a visitor with an existing selected location away from welcome. Startup separately dispatches user and address reads without awaiting their completion. A visible route and cached Vuex location therefore do not establish that those reads have completed.

The old test entered the root route, checked its landing URL and immediately reloaded. It could interrupt startup traffic, while checking location persistence from the mounted store without checking the final authenticated identity. Its recorded aborted requests lack enough timing/document evidence to prove that this specific failure was caused by the reload. They also do not establish an HTTP outage or a broken redirect.

A controlled loopback-only Chromium fixture reproduced the asynchronous startup/reload pattern over 12 rounds. Reads were cancelled by reload while redirect and location persistence remained correct; the recorder classified those proven cancellations as warnings in all 12 rounds. This demonstrates that cancellation alone is insufficient evidence of a functional failure. It does **not** reproduce the original unproven cancellation classification or establish that the historical failure was harmless.

[Playwright's load-state documentation](https://playwright.dev/docs/api/class-page#page-wait-for-load-state) distinguishes DOM load events from application readiness and recommends application assertions rather than a global network-idle wait.

## E2E-only correction and validation

- Expose the existing capture as the `apiDiagnostics` fixture for scenarios needing explicit API settlement.
- Allow bounded request/JSON drainage before deliberate document navigation. The welcome scenario settles its tracked first-party API reads before leaving the initial page, before reload and after reload. It waits for neither WebSockets nor unrelated third-party traffic.
- Verify the same run-owned authenticated user before redirect and after reload, alongside landing URL and exact location persistence. No automatic login is performed after reload.
- Keep unexpected cancellation, HTTP/application failure, incomplete inspection and the address TypeError critical. A settlement timeout records incomplete evidence; successful UI rendering does not erase it.

Validation: **69 JavaScript offline regression tests passed**. The actual revised welcome test callback was also executed against controlled local browser fixtures: a healthy case passed with exactly one user/address request per document and no cancelled reads; a wrong-user response failed the identity assertion; simulated HTTP 503 responses remained critical diagnostics. These controlled cases contact only a loopback HTTP server and are not live acceptance results.

The live smoke report must not be relabelled as passing. A new authorized live run is needed to determine how the corrected scenario behaves against the deployed store. The application source remains outside the change scope.
