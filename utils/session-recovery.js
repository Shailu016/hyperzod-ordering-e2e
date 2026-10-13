const SESSION_RENEWED = 'SESSION-RENEWED';
class SessionRenewedError extends Error {
  constructor() { super('Checkout session needs recovery'); this.code = SESSION_RENEWED; }
}
function isSessionRenewed(error) { return error instanceof SessionRenewedError; }
function hasSessionBudget(expiresAt, minimumValidityMs, now = Date.now()) {
  return Number.isFinite(Number(expiresAt)) && Number(expiresAt) - now > minimumValidityMs;
}
async function recoverBeforeSubmission({ prepare, recover, assertNoSubmission }) {
  assertNoSubmission();
  try { return await prepare(); }
  catch (error) {
    if (!isSessionRenewed(error)) throw error;
    assertNoSubmission();
    await recover();
    assertNoSubmission();
    // Exactly one recovery. A second expiry or any other failure propagates.
    return prepare();
  }
}
module.exports = { SESSION_RENEWED, SessionRenewedError, isSessionRenewed, hasSessionBudget, recoverBeforeSubmission };
