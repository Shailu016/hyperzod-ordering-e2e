// Writes ignored, non-secret deployment settings. Private keys belong only in
// Cloudflare's encrypted secret store, never in this JSON or command arguments.
const fs = require('node:fs');
const path = require('node:path');
function configuration(values, now = new Date()) {
  const [account, app, installation, cutover, enabled = 'false'] = values;
  if (!/^[a-f0-9]{32}$/.test(account || '') || !/^\d+$/.test(app || '') || !/^\d+$/.test(installation || '')) throw new Error('Expected account ID, GitHub App ID and installation ID');
  const date = new Date(cutover);
  if (!Number.isFinite(Number(date)) || date.toISOString() !== cutover || !['true', 'false'].includes(enabled) || (enabled === 'true' && date > now)) throw new Error('Expected canonical UTC cutover and enabled=true/false; active cutover cannot be future');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8'));
  delete config.$schema;
  return { ...config, account_id: account, main: path.join(__dirname, 'worker.mjs'),
    vars: { ...config.vars, GITHUB_APP_ID: app, GITHUB_INSTALLATION_ID: installation, SCHEDULER_ENABLED_AT: cutover, SCHEDULER_ENABLED: enabled } };
}
if (require.main === module) {
  try {
    const config = configuration(process.argv.slice(2));
    const destination = path.join(__dirname, '../.schedule/worker.production.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(config, null, 2) + '\n');
    console.log(`Production config saved (enabled=${config.vars.SCHEDULER_ENABLED}). No secrets stored.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { configuration };
