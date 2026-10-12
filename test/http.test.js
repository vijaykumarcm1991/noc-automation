'use strict';

// End-to-end HTTP tests: boots the real Express app on an ephemeral port.

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { initDb, getDb } = require('../src/db');
const { setMasterKey } = require('../src/vault');
const { createApp } = require('../src/app');
const { unscheduleAll } = require('../src/scheduler');

process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'http-test-pw';
process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
setMasterKey(process.env.MASTER_KEY);
initDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noc-http-')), 'test.db'));

let server;
let base;

test.before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  unscheduleAll();
  server.close();
});

// Minimal cookie-keeping client.
function client() {
  let cookie = '';
  return async function request(method, url, form) {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  };
}

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([0-9a-f]+)"/);
  assert.ok(m, 'page should contain a CSRF token');
  return m[1];
}

async function loggedIn() {
  const req = client();
  const res = await req('POST', '/login', { username: 'admin', password: 'http-test-pw' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/');
  const home = await req('GET', '/');
  assert.strictEqual(home.status, 200);
  return { req, csrf: csrfFrom(home.body) };
}

test('http: unauthenticated pages redirect to /login', async () => {
  const res = await client()('GET', '/jobs');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.location, '/login');
});

test('http: every page renders after login', async () => {
  const { req } = await loggedIn();
  for (const url of ['/', '/jobs', '/jobs/new', '/secrets', '/secrets/new', '/runs']) {
    const res = await req('GET', url);
    assert.strictEqual(res.status, 200, url);
  }
});

test('http: writes without a valid CSRF token are rejected', async () => {
  const { req } = await loggedIn();
  const missing = await req('POST', '/secrets', { name: 'X', value: 'y' });
  assert.strictEqual(missing.status, 403);
  const wrong = await req('POST', '/secrets', { name: 'X', value: 'y', _csrf: 'deadbeef' });
  assert.strictEqual(wrong.status, 403);
  assert.strictEqual(getDb().prepare("SELECT COUNT(*) AS n FROM secrets WHERE name = 'X'").get().n, 0);
});

test('http: invalid job and secret input re-renders the form with an error', async () => {
  const { req, csrf } = await loggedIn();

  const badJob = await req('POST', '/jobs', { name: 'j', command: 'echo', cron_schedule: 'bogus', _csrf: csrf });
  assert.strictEqual(badJob.status, 400);
  assert.match(badJob.body, /not a valid cron expression/);

  const badSecret = await req('POST', '/secrets', { name: 'BAD-NAME', value: 'v', _csrf: csrf });
  assert.strictEqual(badSecret.status, 400);
  assert.match(badSecret.body, /letters, digits and underscores/);

  const noDays = await req('POST', '/jobs', { name: 'j', command: 'echo', schedule_type: 'weekly', time: '09:00', _csrf: csrf });
  assert.strictEqual(noDays.status, 400);
  assert.match(noDays.body, /at least one day/);

  const missing = await req('POST', '/jobs/999999', { name: 'x', command: 'y', _csrf: csrf });
  assert.strictEqual(missing.status, 404);
});

test('http: create a secret and job, run it, and see the output', async () => {
  const { req, csrf } = await loggedIn();

  assert.strictEqual((await req('POST', '/secrets', { name: 'HTTP_TOKEN', value: 'tok-123', _csrf: csrf })).status, 302);
  const secretId = getDb().prepare("SELECT id FROM secrets WHERE name = 'HTTP_TOKEN'").get().id;

  const created = await req('POST', '/jobs', {
    name: 'http-job',
    command: 'echo "token=$HTTP_TOKEN"',
    timeout_sec: '10',
    secret_ids: String(secretId),
    _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  const jobId = getDb().prepare("SELECT id FROM jobs WHERE name = 'http-job'").get().id;

  const run = await req('POST', `/jobs/${jobId}/run`, { _csrf: csrf });
  assert.strictEqual(run.status, 302);
  assert.match(run.location, /^\/runs\/\d+$/);

  let page;
  for (let i = 0; i < 20; i++) {
    page = await req('GET', run.location);
    if (!/live · refreshing/.test(page.body)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(page.body, /token=tok-123/);

  const jobs = await req('GET', '/jobs');
  assert.match(jobs.body, /<\/span>success<\/span>/);
});

test('http: logout ends the session', async () => {
  const { req, csrf } = await loggedIn();
  const out = await req('POST', '/logout', { _csrf: csrf });
  assert.strictEqual(out.status, 302);
  assert.strictEqual((await req('GET', '/jobs')).location, '/login');
});

test('http: friendly schedule is saved as cron and previewed in IST', async () => {
  const { req, csrf } = await loggedIn();
  const body = new URLSearchParams({ name: 'weekday-report', command: 'true', schedule_type: 'weekly', time: '18:45', enabled: '1', _csrf: csrf });
  body.append('days', '1');
  body.append('days', '5');
  assert.strictEqual((await req('POST', '/jobs', body)).status, 302); // repeated `days` keys
  const job = getDb().prepare("SELECT * FROM jobs WHERE name = 'weekday-report'").get();
  assert.strictEqual(job.cron_schedule, '45 18 * * 1,5');

  const edit = await req('GET', `/jobs/${job.id}/edit`);
  assert.match(edit.body, /value="weekly" checked/);
  assert.match(edit.body, /Mon, Fri at 18:45/);

  const list = await req('GET', '/jobs');
  assert.match(list.body, /Mon, Fri at 18:45/);

  const preview = JSON.parse((await req('GET', '/jobs/schedule-preview?schedule_type=daily&time=07:15')).body);
  assert.strictEqual(preview.cron, '15 7 * * *');
  assert.strictEqual(preview.description, 'Every day at 07:15');
  assert.strictEqual(preview.next.length, 3);
  assert.match(preview.next[0], /07:15:00/);
});

// Runs last: it locks out this client IP for the rest of the file.
test('http: login is rate limited after repeated failures', async () => {
  const req = client();
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await req('POST', '/login', { username: 'admin', password: 'nope' })).status, 401);
  }
  const locked = await req('POST', '/login', { username: 'admin', password: 'http-test-pw' });
  assert.strictEqual(locked.status, 429);
  assert.match(locked.body, /Too many failed attempts/);
});
