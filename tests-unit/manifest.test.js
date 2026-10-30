const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { exportManifest } = require('../utils/manifest');

test('identity journal is durable before access, monotonic, and legacy manifests remain unknown', () => {
  const filename = path.resolve(__dirname, '../utils/manifest.js');
  const files = new Map();
  let rejectRename = false;
  const mockFS = {
    existsSync(file) { return files.has(file); }, mkdirSync() {},
    readFileSync(file) { if (!files.has(file)) throw new Error('missing file'); return files.get(file); },
    writeFileSync(file, value) { files.set(file, value); },
    renameSync(from, to) { if (rejectRename) throw new Error('journal write failed'); files.set(to, files.get(from)); files.delete(from); },
  };
  const env = { E2E_RUN_ID: 'unit-journal', E2E_LEASE_OWNER: 'unit-owner', BASE_URL: 'https://automations-store.hyperzod.me', TEST_USER_EMAIL: 'private@example.invalid' };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require(name) { return name === 'node:fs' ? mockFS : name === './policy' ? require('../utils/policy') : require(name); },
    module, __dirname: path.dirname(filename), process: { env },
  }, { filename });
  const manifest = module.exports;
  let saved = manifest.startSetupManifest();
  assert.equal(saved.identityAccessJournalVersion, 1);
  assert.equal(saved.identityAccessStarted, false);
  saved = manifest.startSetupManifest();
  assert.equal(saved.identityAccessStarted, false);
  rejectRename = true;
  assert.throws(() => manifest.markIdentityAccessStarted(), /journal write failed/);
  assert.equal(manifest.readManifest().identityAccessStarted, false);
  rejectRename = false;
  assert.equal(manifest.markIdentityAccessStarted().identityAccessStarted, true);
  assert.equal(manifest.startSetupManifest().identityAccessStarted, true);
  assert.throws(() => manifest.updateManifest({ identityAccessStarted: false }), /cannot be reset/);
  const exported = manifest.exportManifest(env.E2E_RUN_ID, 'exported');
  assert.equal(exported.identityAccessJournalVersion, 1);
  assert.equal(exported.identityAccessStarted, true);
  assert.equal(exported.email, undefined);
  const source = path.join(manifest.runDir(), 'manifest.json');
  const legacy = { ...manifest.readManifest() };
  delete legacy.identityAccessJournalVersion;
  delete legacy.identityAccessStarted;
  files.set(source, JSON.stringify(legacy));
  assert.equal(manifest.startSetupManifest().identityAccessStarted, undefined);
  assert.equal(manifest.markIdentityAccessStarted().identityAccessStarted, true);
});

test('uploaded lifecycle evidence preserves an ambiguous order and excludes auth data', () => {
  const id = `evidence-${crypto.randomUUID()}`;
  const source = path.resolve(__dirname, '..', '.auth', id);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ordering-evidence-'));
  const sourceFile = path.join(source, 'manifest.json');
  const outputFile = path.join(output, 'resource-lifecycle.json');
  fs.mkdirSync(source, { recursive: true });
  try {
    fs.writeFileSync(sourceFile, JSON.stringify({ runId: id, origin: 'https://automations-store.hyperzod.me', email: 'private@example.invalid', password: 'private-password', access_token: 'private-token', lifecycle: 'cleanup-unresolved', submissionAttempted: { cartId: 42, userId: 7 }, orders: [] }));
    exportManifest(id, output);
    const evidence = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(evidence.submissionAttempted.cartId, 42);
    assert.equal(evidence.lifecycle, 'cleanup-unresolved');
    assert.equal(evidence.email, undefined);
    assert.equal(evidence.password, undefined);
    assert.equal(evidence.access_token, undefined);
    assert.throws(() => exportManifest('../escape', output), /Invalid run identifier/);
    fs.writeFileSync(sourceFile, JSON.stringify({ runId: 'another-run' }));
    assert.throws(() => exportManifest(id, output), /another run/);
  } finally {
    fs.unlinkSync(sourceFile);
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    fs.rmdirSync(source);
    fs.rmdirSync(output);
  }
});
