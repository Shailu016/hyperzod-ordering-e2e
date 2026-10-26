const crypto = require('node:crypto');
function useIsolatedIdentity(env = process.env) {
  const value = env.E2E_ISOLATED_IDENTITY;
  if (value !== undefined && value !== '' && !['true', 'false'].includes(value)) throw new Error('E2E_ISOLATED_IDENTITY must be true or false');
  if (env.GITHUB_ACTIONS === 'true') {
    if (value === 'true') throw new Error('Isolated identity is a local validation option');
    return false;
  }
  return value !== 'false';
}
/** Generate a distinct local test email and phone without changing the shared .env. */
function isolatedIdentity(email) {
  const match = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(email || '');
  if (!match) throw new Error('Valid TEST_USER_EMAIL required for an isolated identity');
  const suffix = crypto.randomBytes(8).toString('hex');
  const local = match[1].split('+')[0].slice(0, 40);
  return { email: `${local}.e2e${suffix}@${match[2]}`, phone: `9${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}` };
}
module.exports = { isolatedIdentity, useIsolatedIdentity };
