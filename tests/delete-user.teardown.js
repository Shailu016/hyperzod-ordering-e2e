const { test, expect } = require('../fixtures/test.fixture');
const { testUser } = require('../utils/env');
const { assertManagedRun, readManifest, updateManifest } = require('../utils/manifest');
const { assertIdentity, intentState, redact } = require('../utils/policy');
const { ensureLocation, openAuthPanel, submitLoginIntent, completeLogin, gotoWithRetry, isLoggedIn, expectLoggedInUser, waitForAppBoot } = require('../utils/app');
const { deleteCurrentUserViaUI, proveUserGone } = require('../flows/user.flow');
test('delete the test user account via UI @smoke', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  assertManagedRun();
  const manifest = readManifest();
  try {
    await gotoWithRetry(page, '/');
    expect(await isLoggedIn(page), 'cleanup must start in its fresh logged-out context').toBe(false);
    await ensureLocation(page);
    await openAuthPanel(page);
    const intent = await submitLoginIntent(page, testUser.email);
    if (intentState(intent) === 'absent') {
      updateManifest({ lifecycle: 'absent-proven', cleanedAt: new Date().toISOString() });
      return;
    }
    await completeLogin(page, { password: testUser.password, intentBody: intent });
    const user = await expectLoggedInUser(page, testUser.email);
    assertIdentity(user, testUser.email, manifest.userId);
    await gotoWithRetry(page, '/en/profile');
    await waitForAppBoot(page);
    await deleteCurrentUserViaUI(page, 'cleanup');
    await proveUserGone(page, testUser.email, 'cleanup');
    updateManifest({ lifecycle: 'deleted-and-proven', cleanedAt: new Date().toISOString() });
    expect(readManifest().lifecycle).toBe('deleted-and-proven');
  } catch (error) {
    updateManifest({ lifecycle: 'cleanup-unresolved', cleanupError: redact(error.message) });
    throw error;
  } finally {
    const current = readManifest();
    await testInfo.attach('resource-lifecycle', { body: Buffer.from(JSON.stringify({ runId: current.runId, origin: current.origin, lifecycle: current.lifecycle, userId: current.userId, orders: current.orders })), contentType: 'application/json' });
  }
});
