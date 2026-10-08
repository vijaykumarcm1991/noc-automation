'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const vault = require('../src/vault');
const runner = require('../src/runner');
const { initDb, getDb } = require('../src/db');
const scheduler = require('../src/scheduler');

// --- Vault tests -----------------------------------------------------------

test('vault: encrypt/decrypt round-trip', () => {
  const keyHex = crypto.randomBytes(32).toString('hex');
  vault.setMasterKey(keyHex);
  const secret = 'super-secret-value';
  const payload = vault.encrypt(secret);
  assert.notStrictEqual(payload, secret, 'ciphertext must differ from plaintext');
  assert.strictEqual(vault.decrypt(payload), secret);
});

test('vault: each encryption uses a fresh IV (non-deterministic)', () => {
  const keyHex = crypto.randomBytes(32).toString('hex');
  vault.setMasterKey(keyHex);
  const a = vault.encrypt('same-value');
  const b = vault.encrypt('same-value');
  assert.notStrictEqual(a, b);
});

test('vault: rejects a bad master key length', () => {
  assert.throws(() => vault.setMasterKey('too-short'));
});

test('vault: tampering with ciphertext fails authentication', () => {
  const keyHex = crypto.randomBytes(32).toString('hex');
  vault.setMasterKey(keyHex);
  const payload = vault.encrypt('important-secret');
  const [iv, tag, data] = payload.split(':');
  const corrupted = [iv, tag, 'AAAA' + data.slice(4)].join(':');
  assert.throws(() => vault.decrypt(corrupted));
});

// --- Runner tests ----------------------------------------------------------

test('runner: returns success for exit code 0', async () => {
  const out = await runner.runCommand('echo hello', { timeoutSec: 10 });
  assert.strictEqual(out.status, 'success');
  assert.strictEqual(out.exitCode, 0);
  assert.match(out.output, /hello/);
});

test('runner: returns failed for non-zero exit code', async () => {
  const out = await runner.runCommand('exit 3', { timeoutSec: 10 });
  assert.strictEqual(out.status, 'failed');
  assert.strictEqual(out.exitCode, 3);
});

test('runner: times out and kills long-running commands', async () => {
  const out = await runner.runCommand('sleep 30', { timeoutSec: 1 });
  assert.strictEqual(out.status, 'timed_out');
  assert.match(out.output, /timed out/);
});

test('runner: injects env vars into the child process', async () => {
  const out = await runner.runCommand('echo $MY_SECRET', { env: { MY_SECRET: 'abc123' }, timeoutSec: 10 });
  assert.match(out.output, /abc123/);
});

// --- End-to-end job run (scheduler + DB + vault + runner) ------------------

test('job: runs a command, resolves linked secret, records a run', async () => {
  // Isolated temp DB + key.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  initDb(dbPath);
  vault.setMasterKey(crypto.randomBytes(32).toString('hex'));

  const db = getDb();
  const jobId = db
    .prepare('INSERT INTO jobs (name, command, enabled, timeout_sec) VALUES (?, ?, 1, 10)')
    .run('test-job', 'echo SECRET_IS:$MY_TOKEN').lastInsertRowid;

  const secretId = db
    .prepare('INSERT INTO secrets (name, encrypted_value) VALUES (?, ?)')
    .run('MY_TOKEN', vault.encrypt('topsecret')).lastInsertRowid;

  db.prepare('INSERT INTO job_secrets (job_id, secret_id) VALUES (?, ?)').run(jobId, secretId);

  const { runId } = scheduler.runJobNow(jobId);
  assert.ok(runId);

  // Wait for the async completion.
  await new Promise((r) => setTimeout(r, 500));

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  assert.strictEqual(run.status, 'success');
  assert.match(run.output, /SECRET_IS:topsecret/, 'secret value must be injected via env');
});

test('cron: invalid schedule is skipped, not fatal', () => {
  const db = getDb();
  const badId = db
    .prepare('INSERT INTO jobs (name, command, cron_schedule, enabled, timeout_sec) VALUES (?, ?, ?, 1, 10)')
    .run('bad-cron', 'echo hi', 'not-a-cron').lastInsertRowid;
  assert.doesNotThrow(() => scheduler.scheduleJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(badId)));
});
