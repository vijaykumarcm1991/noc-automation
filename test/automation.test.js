'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const vault = require('../src/vault');
const runner = require('../src/runner');
const { initDb, getDb, markInterruptedRuns, pruneRuns } = require('../src/db');
const scheduler = require('../src/scheduler');
const {
  verifyCredentials,
  getAdminUser,
  loginRetryAfterSec,
  recordFailedLogin,
  clearFailedLogins,
  SqliteSessionStore,
  LOGIN_MAX_ATTEMPTS,
} = require('../src/auth');
const { validateJob, validateSecretName } = require('../src/validate');

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

test('runner: timeout kills grandchild processes, not just the shell', async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noc-kill-')), 'leaked');
  const out = await runner.runCommand(`(sleep 2; touch ${marker}) & wait`, { timeoutSec: 1 });
  assert.strictEqual(out.status, 'timed_out');
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!fs.existsSync(marker), 'background child should have been killed with the group');
});

test('runner: AbortSignal cancels the run', async () => {
  const controller = new AbortController();
  const pending = runner.runCommand('sleep 30', { timeoutSec: 60, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const out = await pending;
  assert.strictEqual(out.status, 'cancelled');
  assert.match(out.output, /cancelled/);
});

test('runner: output is capped and marked as truncated', async () => {
  const out = await runner.runCommand("head -c 1100000 /dev/zero | tr '\\0' a", { timeoutSec: 10 });
  assert.strictEqual(out.status, 'success');
  assert.match(out.output, /output truncated/);
  assert.ok(out.output.length < 1_000_100);
});

test('runner: reports partial output through onOutput', async () => {
  const seen = [];
  await runner.runCommand('echo one; sleep 0.2; echo two', { timeoutSec: 10, onOutput: (o) => seen.push(o) });
  assert.ok(seen.length >= 2);
  assert.match(seen[seen.length - 1], /one\s+two/);
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

  const { runId, done } = scheduler.runJobNow(jobId);
  assert.ok(runId);
  assert.strictEqual(await done, 'success');

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

test('scheduler: a job cannot run twice at once, and a run can be cancelled', async () => {
  const db = getDb();
  const jobId = db
    .prepare('INSERT INTO jobs (name, command, enabled, timeout_sec) VALUES (?, ?, 1, 60)')
    .run('slow-job', 'sleep 30').lastInsertRowid;

  const first = scheduler.runJobNow(jobId);
  assert.ok(scheduler.isJobRunning(jobId));
  assert.throws(() => scheduler.runJobNow(jobId), (err) => err.code === 'ALREADY_RUNNING');

  assert.ok(scheduler.cancelRun(first.runId));
  assert.strictEqual(await first.done, 'cancelled');
  assert.ok(!scheduler.isJobRunning(jobId));
  assert.strictEqual(db.prepare('SELECT status FROM runs WHERE id = ?').get(first.runId).status, 'cancelled');
});

test('scheduler: valid cron job reports a next run time; unscheduling clears it', () => {
  const db = getDb();
  const id = db
    .prepare('INSERT INTO jobs (name, command, cron_schedule, enabled, timeout_sec) VALUES (?, ?, ?, 1, 10)')
    .run('nightly', 'echo hi', '0 2 * * *').lastInsertRowid;
  scheduler.scheduleJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  assert.ok(scheduler.getNextRun(id) instanceof Date);
  scheduler.unscheduleJob(id);
  assert.strictEqual(scheduler.getNextRun(id), null);
});

test('db: unfinished runs from a previous process are marked interrupted', () => {
  const db = getDb();
  const jobId = db.prepare("INSERT INTO jobs (name, command) VALUES ('j', 'true')").run().lastInsertRowid;
  const runId = db.prepare("INSERT INTO runs (job_id, status) VALUES (?, 'running')").run(jobId).lastInsertRowid;
  assert.ok(markInterruptedRuns() >= 1);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  assert.strictEqual(run.status, 'interrupted');
  assert.ok(run.finished_at);
  assert.match(run.output, /interrupted/);
});

test('db: pruneRuns deletes only runs older than the retention window', () => {
  const db = getDb();
  const jobId = db.prepare("INSERT INTO jobs (name, command) VALUES ('p', 'true')").run().lastInsertRowid;
  const oldId = db
    .prepare("INSERT INTO runs (job_id, status, started_at) VALUES (?, 'success', datetime('now', '-40 days'))")
    .run(jobId).lastInsertRowid;
  const newId = db.prepare("INSERT INTO runs (job_id, status) VALUES (?, 'success')").run(jobId).lastInsertRowid;
  assert.strictEqual(pruneRuns(0), 0, 'retention 0 keeps everything');
  pruneRuns(30);
  assert.strictEqual(db.prepare('SELECT id FROM runs WHERE id = ?').get(oldId), undefined);
  assert.ok(db.prepare('SELECT id FROM runs WHERE id = ?').get(newId));
});

// --- Validation tests --------------------------------------------------------

test('validate: job form requires name/command and a valid cron and timeout', () => {
  assert.deepStrictEqual(validateJob({ name: 'a', command: 'b' }).errors, []);
  assert.strictEqual(validateJob({ name: 'a', command: 'b' }).values.timeout_sec, 300);
  assert.strictEqual(validateJob({ name: ' ', command: '' }).errors.length, 2);
  assert.strictEqual(validateJob({ name: 'a', command: 'b', cron_schedule: 'nope' }).errors.length, 1);
  assert.strictEqual(validateJob({ name: 'a', command: 'b', timeout_sec: '0' }).errors.length, 1);
  assert.strictEqual(validateJob({ name: 'a', command: 'b', timeout_sec: '1.5' }).errors.length, 1);
  assert.deepStrictEqual(validateJob({ name: 'a', command: 'b', secret_ids: ['1', 'x', '3'] }).values.secret_ids, [1, 3]);
  assert.deepStrictEqual(validateJob({ name: 'a', command: 'b', secret_ids: '2' }).values.secret_ids, [2]);
});

test('validate: secret names must be valid env var names', () => {
  assert.strictEqual(validateSecretName('API_KEY').error, null);
  assert.strictEqual(validateSecretName('_x1').error, null);
  assert.ok(validateSecretName('').error);
  assert.ok(validateSecretName('1ABC').error);
  assert.ok(validateSecretName('MY-KEY').error);
  assert.ok(validateSecretName('A B').error);
});

// --- Auth tests ------------------------------------------------------------

function withAdmin(user = 'admin', pass = 'secret-pw') {
  process.env.ADMIN_USERNAME = user;
  process.env.ADMIN_PASSWORD = pass;
  return () => {
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  };
}

test('auth: accepts correct credentials, rejects wrong ones (constant-time)', () => {
  const cleanup = withAdmin('admin', 's3cret-pass');
  try {
    assert.ok(verifyCredentials('admin', 's3cret-pass'), 'correct creds should pass');
    assert.ok(!verifyCredentials('admin', 'wrong-pass'), 'wrong password should fail');
    assert.ok(!verifyCredentials('nobody', 's3cret-pass'), 'wrong username should fail');
    assert.ok(!verifyCredentials('admin', ''), 'empty password should fail');
  } finally {
    cleanup();
  }
});

test('auth: default username is admin when unset', () => {
  const u = getAdminUser();
  assert.strictEqual(u.username, 'admin');
});

test('auth: verifyCredentials fails when no password is configured', () => {
  const cleanup = withAdmin('admin', '');
  try {
    assert.ok(!verifyCredentials('admin', 'anything'));
  } finally {
    cleanup();
  }
});

// --- Secret edit round-trip ------------------------------------------------

test('secret edit: updating a value re-encrypts and decrypts to the new value', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-edit-'));
  initDb(path.join(tmpDir, 'test.db'));
  vault.setMasterKey(crypto.randomBytes(32).toString('hex'));

  const db = getDb();
  const secretId = db
    .prepare('INSERT INTO secrets (name, encrypted_value) VALUES (?, ?)')
    .run('TOKEN', vault.encrypt('old-value')).lastInsertRowid;

  // Simulate the edit route: replace with a freshly encrypted value.
  db.prepare("UPDATE secrets SET encrypted_value = ?, updated_at = datetime('now') WHERE id = ?")
    .run(vault.encrypt('new-value'), secretId);

  const stored = db.prepare('SELECT encrypted_value FROM secrets WHERE id = ?').get(secretId);
  assert.strictEqual(vault.decrypt(stored.encrypted_value), 'new-value');
  assert.notStrictEqual(stored.encrypted_value, 'old-value');
});

// --- Login rate limiting + session store -------------------------------------

test('auth: login is locked out after too many failures, then recovers', () => {
  const key = 'test-client';
  const t0 = 1_000_000;
  for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 1; i++) recordFailedLogin(key, t0);
  assert.strictEqual(loginRetryAfterSec(key, t0), 0, 'still allowed below the limit');
  recordFailedLogin(key, t0);
  assert.ok(loginRetryAfterSec(key, t0) > 0, 'locked out at the limit');
  assert.strictEqual(loginRetryAfterSec(key, t0 + 16 * 60 * 1000), 0, 'lock expires after the window');
  recordFailedLogin(key, t0);
  clearFailedLogins(key);
  assert.strictEqual(loginRetryAfterSec(key, t0), 0);
});

test('session store: persists, expires, and destroys sessions', async () => {
  const store = new SqliteSessionStore();
  clearInterval(store.sweeper);
  const get = (sid) => new Promise((res, rej) => store.get(sid, (e, s) => (e ? rej(e) : res(s))));
  const set = (sid, s) => new Promise((res, rej) => store.set(sid, s, (e) => (e ? rej(e) : res())));

  const future = new Date(Date.now() + 60_000).toISOString();
  await set('abc', { cookie: { expires: future }, authenticated: true });
  assert.strictEqual((await get('abc')).authenticated, true);

  await set('old', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
  assert.strictEqual(await get('old'), null, 'expired session is not returned');

  await new Promise((res) => store.destroy('abc', res));
  assert.strictEqual(await get('abc'), null);
});

// --- Time zone helpers ---------------------------------------------------------

test('time: UTC database timestamps are shown in IST', () => {
  const time = require('../src/time');
  assert.strictEqual(time.APP_TZ, 'Asia/Kolkata');
  assert.strictEqual(time.zoneLabel(), 'IST');
  // 10:12:50 UTC == 15:42:50 IST (+05:30)
  assert.strictEqual(time.formatTime('2026-10-12 10:12:50'), '12 Oct 2026, 15:42:50');
  assert.strictEqual(time.formatClock('2026-10-12 20:00:00'), '01:30');
  assert.strictEqual(time.formatDuration('2026-10-12 10:00:00', '2026-10-12 10:01:05'), '1m 05s');
  assert.strictEqual(time.relativeTime(new Date(Date.now() - 2 * 3600e3)), '2h ago');
});

test('time: child jobs run with TZ set to IST', async () => {
  const out = await runner.runCommand('echo "tz=$TZ"; date +%Z', { timeoutSec: 10 });
  assert.match(out.output, /tz=Asia\/Kolkata/);
  assert.match(out.output, /IST/);
});

// --- Friendly schedule builder ---------------------------------------------------

test('schedule: builder fields produce the right cron expressions', () => {
  const { buildFromForm } = require('../src/schedule');
  const cronOf = (body) => buildFromForm(body).cron;
  assert.strictEqual(cronOf({ schedule_type: 'manual' }), null);
  assert.strictEqual(cronOf({ schedule_type: 'minutes', interval_min: '15' }), '*/15 * * * *');
  assert.strictEqual(cronOf({ schedule_type: 'minutes', interval_min: '1' }), '* * * * *');
  assert.strictEqual(cronOf({ schedule_type: 'hourly', interval_hours: '1', at_minute: '30' }), '30 * * * *');
  assert.strictEqual(cronOf({ schedule_type: 'hourly', interval_hours: '6', at_minute: '0' }), '0 */6 * * *');
  assert.strictEqual(cronOf({ schedule_type: 'daily', time: '00:30' }), '30 0 * * *');
  assert.strictEqual(cronOf({ schedule_type: 'weekly', time: '10:05', days: ['5', '1', '3'] }), '5 10 * * 1,3,5');
  assert.strictEqual(cronOf({ schedule_type: 'monthly', time: '06:00', month_day: 'L' }), '0 6 L * *');
  assert.strictEqual(cronOf({ schedule_type: 'custom', schedule_custom: '0 9 * * 1-5' }), '0 9 * * 1-5');
  // Legacy/API posts with only cron_schedule still work.
  assert.strictEqual(cronOf({ cron_schedule: '0 2 * * *' }), '0 2 * * *');
  assert.strictEqual(cronOf({}), null);
});

test('schedule: invalid builder input is rejected with a clear message', () => {
  const { buildFromForm } = require('../src/schedule');
  assert.match(buildFromForm({ schedule_type: 'weekly', time: '09:00' }).error, /at least one day/);
  assert.match(buildFromForm({ schedule_type: 'daily', time: '25:00' }).error, /valid time/);
  assert.match(buildFromForm({ schedule_type: 'minutes', interval_min: '7' }).error, /interval/);
  assert.match(buildFromForm({ schedule_type: 'monthly', time: '09:00', month_day: '32' }).error, /day of the month/);
  assert.match(buildFromForm({ schedule_type: 'custom', schedule_custom: 'nope' }).error, /not a valid cron/);
});

test('schedule: stored cron expressions round-trip into the builder and describe in English', () => {
  const { parseToFields, buildFromForm, describe } = require('../src/schedule');
  const cases = {
    '*/15 * * * *': 'Every 15 minutes',
    '0 * * * *': 'Every hour, on the hour',
    '30 */2 * * *': 'Every 2 hours at :30',
    '30 0 * * *': 'Every day at 00:30',
    '0 10 * * 1-5': 'Weekdays at 10:00',
    '0 8 * * 1': 'Mon at 08:00',
    '0 9 * * 0,6': 'Weekends at 09:00',
    '15 6 L * *': 'Monthly on the last day at 06:15',
    '0 6 2 * *': 'Monthly on the 2nd at 06:00',
    '5 4 * 1 *': 'Custom: 5 4 * 1 *',
  };
  for (const [expr, text] of Object.entries(cases)) {
    assert.strictEqual(describe(expr), text, expr);
    const f = parseToFields(expr);
    const body = {
      schedule_type: f.type,
      interval_min: f.interval_min,
      interval_hours: f.interval_hours,
      at_minute: f.at_minute,
      time: f.time,
      days: f.days.map(String),
      month_day: f.month_day,
      schedule_custom: f.custom,
    };
    const rebuilt = buildFromForm(body).cron;
    assert.strictEqual(describe(rebuilt), text, `round-trip of ${expr} gave ${rebuilt}`);
  }
  assert.strictEqual(describe(null), 'Manual only');
});

test('schedule: next runs are computed in IST', () => {
  const { nextRuns } = require('../src/schedule');
  const time = require('../src/time');
  const runs = nextRuns('30 9 * * *', 2);
  assert.strictEqual(runs.length, 2);
  for (const d of runs) assert.match(time.formatTime(d), /, 09:30:00$/);
});
