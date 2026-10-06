const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { exportManifest } = require('../utils/manifest');

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
