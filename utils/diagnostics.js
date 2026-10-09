// Narrow endpoint exceptions; dependencies opt the same endpoint back into failure.
const BACKGROUND = [
  { feature: 'chat', host: 'chat.apps.hyperzod.com', path: /^\/api\/v1\/embed\/notifications\/connection$/, methods: ['GET', 'HEAD', 'OPTIONS', 'POST'] },
  { feature: 'recommendations', path: /^\/store\/v1\/recommend\/(products(?:\/merchant)?|merchants|similarItems)$/, methods: ['GET', 'HEAD', 'OPTIONS', 'POST'] },
  { feature: 'wallet', path: /^\/store\/v1\/wallet\/(wallet-info|transaction-history|refer-earn)$/ },
  { feature: 'geocoding', path: /\/reverseGeocode$/ },
  { feature: 'analytics', path: /^\/store\/v1\/search\/analytics\/batch$/, methods: ['POST'] },
  { feature: 'orderForms', path: /^\/store\/v1\/form-builder\/order\/(delivery|pickup|dine_in)$/ },
];
const dependenciesByPage = new WeakMap();
const recoveredSessions = new WeakSet();
// These SDK POST endpoints perform searches/validation, never create or change resources.
const READ_ONLY_POST = /^\/store\/v1\/(home|merchant\/(nearby|nearest|check-delivering)|search\/merchant\/nearby|isStoreServiceable|cart\/validate\/product)$/;
function isReadRequest(event) { return ['GET', 'HEAD'].includes(event.method) || (event.method === 'POST' && READ_ONLY_POST.test(endpoint(event.url))); }
function markSessionRecovered(page) { recoveredSessions.add(page); }
function requireDependency(page, feature) {
  let features = dependenciesByPage.get(page);
  if (!features) { features = new Set(); dependenciesByPage.set(page, features); }
  features.add(feature);
}
function endpoint(url) { try { return new URL(url).pathname; } catch { return ''; } }
function optionalFailure(event, dependencies) {
  const rule = BACKGROUND.find((rule) => rule.path.test(endpoint(event.url)) && (!rule.host || new URL(event.url).hostname === rule.host));
  return !!rule && !dependencies.has(rule.feature) && (rule.methods || ['GET', 'HEAD', 'OPTIONS']).includes(event.method);
}
function rejection(event, expectedAuthRejection) {
  return expectedAuthRejection && event.method === 'POST' && /^\/auth\/v1\/user\/(login|otp\/verify)$/.test(endpoint(event.url)) &&
    ((event.kind === 'http' && [400, 401, 422].includes(event.status)) || event.kind === 'application');
}
/** @param {{events: Array<any>, successfulReads: Record<string, number>, successfulAccountDeletions?: Array<{userId: string, sequence: number}>}} capture @param {{page?: object, dependencies?: string[], expectedAuthRejection?: boolean, expectedMissingPage?: boolean, deletedUserId?: string | number}} [options] */
function assessDiagnostics(capture, { page, dependencies = [], expectedAuthRejection = false, expectedMissingPage = false, deletedUserId } = {}) {
  const required = new Set([...dependencies, ...(dependenciesByPage.get(page) || [])]);
  const failures = capture.events.filter((event) => ['http', 'transport', 'application', 'inspection', 'cancelled'].includes(event.kind));
  const critical = [], warnings = [];
  const revokedAddressRead = (event) => deletedUserId != null && event.kind === 'http' && event.status === 401 && ['GET', 'HEAD'].includes(event.method) &&
    endpoint(event.url) === '/store/v1/address' && (capture.successfulAccountDeletions || []).some((deletion) => deletion.userId === String(deletedUserId) && deletion.sequence < event.sequence);
  for (const event of capture.events) {
    // Browsers cancel image downloads when an image is unmounted or its source
    // changes. Preserve those as warnings; API/script/document failures still
    // require navigation or recovery evidence.
    const discardedImage = event.kind === 'cancelled' && event.method === 'GET' && event.resourceType === 'image';
    let warning = discardedImage || (event.kind === 'cancelled' && event.navigationDiscarded && isReadRequest(event)) || optionalFailure(event, required) || rejection(event, expectedAuthRejection);
    if (expectedMissingPage && event.kind === 'application' && event.method === 'GET' && endpoint(event.url) === '/store/v1/page' && /"Page not found"$/.test(event.message)) warning = true;
    // A later successful response can recover a read, never a cart/order mutation.
    const read = isReadRequest(event);
    const transient = event.kind === 'transport' || (event.kind === 'http' && [429, 500, 502, 503, 504].includes(event.status));
    if (read && transient && (capture.successfulReads[event.key] || 0) > event.sequence) warning = true;
    if (read && event.kind === 'http' && event.status === 401 && recoveredSessions.has(page) && (capture.successfulReads[event.key] || 0) > event.sequence) warning = true;
    // Only a positively deleted-and-proven owned account can explain a late address 401.
    if (revokedAddressRead(event)) warning = true;
    if (event.kind === 'console' || event.kind === 'page') {
      const resourceError = /Failed to load resource|Access to .*blocked by CORS policy|net::ERR_FAILED|due to access control checks/i.test(event.message);
      const related = failures.filter((failure) => event.url ? failure.url === event.url : event.kind === 'console' && resourceError);
      // Deduplicate browser network messages only when every corresponding failure is allowed.
      warning = resourceError && related.length > 0 && related.every((failure) =>
        optionalFailure(failure, required) || rejection(failure, expectedAuthRejection) || revokedAddressRead(failure) ||
        (failure.kind === 'cancelled' && failure.navigationDiscarded && isReadRequest(failure)) ||
        (isReadRequest(failure) && (capture.successfulReads[failure.key] || 0) > failure.sequence));
      // WebKit can emit only a page rejection for this cross-origin credential read.
      if (resourceError && event.url && new URL(event.url).hostname === 'chat.apps.hyperzod.com' && endpoint(event.url) === '/api/v1/embed/notifications/connection' && !required.has('chat')) warning = true;
      const socket = event.message?.match(/\bwss?:\/\/[^\s'"<>]+/)?.[0];
      if (socket && /WebSocket is closed before the connection is established/i.test(event.message) && new URL(socket).hostname === 'chat.apps.hyperzod.com' && endpoint(socket) === '/connection/websocket' && !required.has('chat')) warning = true;
      if (event.url && /^(https:\/\/fonts\.(googleapis|gstatic)\.com\/|.*\/favicon\.ico$)/.test(event.url) && resourceError) warning = true;
      if (event.url && /^https:\/\/[a-z0-9.-]+\.ingest(?:\.us)?\.sentry\.io\/api\/\d+\/envelope\//.test(event.url) && resourceError) warning = true;
    }
    (warning ? warnings : critical).push(event);
  }
  return { critical, warnings };
}
module.exports = { BACKGROUND, requireDependency, markSessionRecovered, assessDiagnostics, isReadRequest };
