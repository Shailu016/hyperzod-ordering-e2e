# Acceptance failure review — 9 November 2026

## Repeated test-account lock

The Slack lock alert pointed to completed GitHub run `41332237276`. Its saved lifecycle evidence showed that cleanup lost the authenticated session after `GET /store/v1/order/getOrdersByUserId` returned HTTP 401. The run could not prove account deletion, so retaining the lease was the correct fail-closed behavior. The exact stale lease was later reconciled only after confirming the owner run had stopped, checking the recorded resource/order evidence, and proving the owned test account absent. Age alone was not used to unlock it.

PR #18 retries cleanup once after that exact order-history 401: it signs in through the UI as the same test identity, verifies the identity matches the manifest, and then retries deletion. The 401 stays a critical test diagnostic. Another logout, an identity mismatch, or missing deletion proof still leaves cleanup unresolved and retains the lease.

## Android location sheet click interception

The saved Android screenshot shows the full-screen `Select your location` sheet covering the merchant page. Its visible contents live inside Vuetify's `.v-overlay-container`, but that wrapper may have no visible bounding box. Requiring the wrapper itself to be `:visible` therefore missed the active sheet. The detector now finds the visible sheet content and scopes to its portal wrapper without the incorrect visibility condition. It only closes the sheet through its own header when the selected location is already persisted; a required picker remains open. A loopback browser regression exercises a `display: contents` portal in Chromium and WebKit.

## iOS analytics CORS diagnostic

The failed iOS COD scenario had already placed order `1455` and rendered it in order history. Its only critical diagnostic was a WebKit page-level access-control rejection for `https://api.hyperzod.app/store/v1/search/analytics/batch`; no request event was emitted. This is optional search telemetry. The reporter now preserves that exact page error as a warning when analytics is not a scenario dependency. Other origins, paths, error messages, and required analytics scenarios remain critical.

## Merchant search

The saved web and Android evidence does not show the expected merchant results: web has an empty search main area while the location sheet is open, and Android opens the Shopping Assistant with no merchant tab/results. This is not explained by a Playwright locator mismatch. The catalog assertion remains failing and no diagnostic exception was added. It needs investigation in the storefront, which is outside this personal E2E repository's edit scope.

## Offline verification

The E2E project's unit tests, lint, type check, and loopback Chromium/WebKit location and diagnostics fixtures passed for the changes in this review. These results do not replace the queued CI acceptance run against the live test store.
