const fs = require('node:fs');
const path = require('node:path');
const { assertAllowedTarget, identityKey } = require('./policy');
const ROOT = path.resolve(__dirname, '..');
function runDir() {
  const id = process.env.E2E_RUN_ID || 'standalone';
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid run identifier');
  return path.join(ROOT, '.auth', id);
}
function scope() {
  const origin = assertAllowedTarget(process.env.BASE_URL, process.env.E2E_ALLOWED_ORIGINS);
  const email = (process.env.TEST_USER_EMAIL || '').trim().toLowerCase();
  if (!email) throw new Error('Test identity is missing');
  return { origin, email, key: identityKey(origin, email), runId: process.env.E2E_RUN_ID || 'standalone' };
}
function readManifest() {
  const file = path.join(runDir(), 'manifest.json');
  if (!fs.existsSync(file)) return { ...scope(), orders: [], createdAt: new Date().toISOString() };
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const current = scope();
  if (saved.key !== current.key || saved.runId !== current.runId) throw new Error('Manifest target, identity, or run ownership mismatch');
  return saved;
}
function updateManifest(patch) {
  const data = { ...readManifest(), ...patch };
  const file = path.join(runDir(), 'manifest.json');
  fs.mkdirSync(runDir(), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, file);
  return data;
}
function recordOrder(order) {
  const manifest = readManifest();
  updateManifest({ orders: [...manifest.orders, { ...order, createdAt: new Date().toISOString() }] });
}
function assertManagedRun() {
  if (!process.env.E2E_RUN_ID || !process.env.E2E_LEASE_OWNER) throw new Error('Run through npm suite scripts; direct live Playwright runs are blocked without an identity lease');
  scope();
}
module.exports = { runDir, scope, readManifest, updateManifest, recordOrder, assertManagedRun };
