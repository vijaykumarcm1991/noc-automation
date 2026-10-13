'use strict';

// HTTP tests for the script editor, test runs (SSE), scheduling and packages.

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-scripts-http-'));
process.env.SCRIPTS_DIR = path.join(tmp, 'scripts');
process.env.VENV_DIR = path.join(tmp, 'venv');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'scripts-pw';

const { initDb, getDb } = require('../src/db');
const { setMasterKey, encrypt } = require('../src/vault');
const { createApp } = require('../src/app');
const { unscheduleAll } = require('../src/scheduler');

process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
setMasterKey(process.env.MASTER_KEY);
initDb(path.join(tmp, 'test.db'));

let server;
let base;
let req;
let csrf;

test.before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  let cookie = '';
  req = async (method, url, body, { json = false } = {}) => {
    const headers = { ...(cookie ? { cookie } : {}) };
    let payload;
    if (body && json) {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrf;
      payload = JSON.stringify(body);
    } else if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    }
    const res = await fetch(base + url, { method, redirect: 'manual', headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), body: text, json: () => JSON.parse(text) };
  };
  await req('POST', '/login', { username: 'admin', password: 'scripts-pw' });
  csrf = (await req('GET', '/')).body.match(/name="csrf-token" content="([0-9a-f]+)"/)[1];
});

test.after(() => {
  unscheduleAll();
  server.close();
});

async function createScript(filename, language = 'python') {
  const res = await req('POST', '/scripts', { filename, language, _csrf: csrf });
  assert.strictEqual(res.status, 302, res.body.slice(0, 300));
  return Number(res.location.split('/').pop());
}

test('scripts http: library and editor pages render; bad names are rejected', async () => {
  assert.strictEqual((await req('GET', '/scripts')).status, 200);
  const bad = await req('POST', '/scripts', { filename: '../evil', language: 'python', _csrf: csrf });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body, /Use a file name like/);

  const id = await createScript('health_check', 'bash'); // extension added from language
  const page = await req('GET', `/scripts/${id}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /health_check\.sh/);
  assert.match(page.body, /\/vendor\/editor\.js/);
  assert.ok(fs.existsSync(path.join(process.env.SCRIPTS_DIR, 'health_check.sh')));
});

test('scripts http: JSON save requires CSRF, rejects syntax errors, and records versions', async () => {
  const id = await createScript('saver.py');
  // Logged-in session but a wrong CSRF token → rejected, nothing saved.
  const realCsrf = csrf;
  csrf = 'deadbeef';
  const noCsrf = await req('POST', `/scripts/${id}/save`, { content: 'print(1)\n' }, { json: true });
  csrf = realCsrf;
  assert.strictEqual(noCsrf.status, 403);

  const broken = await req('POST', `/scripts/${id}/save`, { content: 'def x(:\n' }, { json: true });
  assert.strictEqual(broken.status, 422);
  assert.strictEqual(broken.json().line, 1);

  const ok = await req('POST', `/scripts/${id}/save`, { content: 'print("v2")\n', note: 'second' }, { json: true });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json().versionCount, 2);

  const history = await req('GET', `/scripts/${id}/history`);
  assert.match(history.body, /Version 2/);
  assert.match(history.body, /second/);
  assert.match(history.body, /print\(&#34;v2&#34;\)/);
});

test('scripts http: a test run streams live output of unsaved content with secrets', async () => {
  const id = await createScript('tester.py');
  const secretId = getDb().prepare('INSERT INTO secrets (name, encrypted_value) VALUES (?, ?)').run('API_KEY', encrypt('k-123')).lastInsertRowid;

  const start = await req(
    'POST',
    `/scripts/${id}/test`,
    { content: 'import os, sys\nprint("unsaved", sys.argv[1:], os.environ["API_KEY"])\nprint("tz", os.environ["TZ"])\n', args: '--x 1', secret_ids: [String(secretId)] },
    { json: true }
  );
  assert.strictEqual(start.status, 200, start.body);
  const { taskId, testId } = start.json();

  const stream = await req('GET', `/tasks/${taskId}/stream`);
  assert.match(stream.body, /event: output/);
  assert.match(stream.body, /unsaved \['--x', '1'\] k-123/);
  assert.match(stream.body, /tz Asia\/Kolkata/);
  assert.match(stream.body, /event: end\ndata: \{"status":"success","exitCode":0\}/);

  // Recorded in test history, and the temp copy is cleaned up.
  await new Promise((r) => setTimeout(r, 100));
  const row = getDb().prepare('SELECT * FROM script_tests WHERE id = ?').get(testId);
  assert.strictEqual(row.status, 'success');
  assert.ok(!fs.readdirSync(process.env.SCRIPTS_DIR).some((f) => f.startsWith('.~test-')));
  assert.match((await req('GET', `/scripts/${id}/tests/${testId}`)).body, /k-123/);
});

test('scripts http: schedule a script as a job; script jobs run the saved file', async () => {
  const id = await createScript('scheduled.py');
  await req('POST', `/scripts/${id}/save`, { content: 'import sys\nprint("ran with", *sys.argv[1:])\n' }, { json: true });

  const prefill = await req('GET', `/jobs/new?script_id=${id}&args=--fast`);
  assert.match(prefill.body, new RegExp(`<option value="${id}" selected>scheduled.py`));
  assert.match(prefill.body, /value="--fast"/);

  const created = await req('POST', '/jobs', {
    name: 'scheduled job',
    run_type: 'script',
    script_id: String(id),
    args: '--fast',
    schedule_type: 'daily',
    time: '06:00',
    enabled: '1',
    _csrf: csrf,
  });
  assert.strictEqual(created.status, 302);
  const job = getDb().prepare("SELECT * FROM jobs WHERE name = 'scheduled job'").get();
  assert.strictEqual(job.script_id, id);
  assert.strictEqual(job.args, '--fast');
  assert.strictEqual(job.cron_schedule, '0 6 * * *');

  const missing = await req('POST', '/jobs', { name: 'x', run_type: 'script', _csrf: csrf });
  assert.strictEqual(missing.status, 400);
  assert.match(missing.body, /Choose a script/);

  const run = await req('POST', `/jobs/${job.id}/run`, { _csrf: csrf });
  const runId = Number(run.location.split('/').pop());
  for (let i = 0; i < 30; i++) {
    const r = getDb().prepare('SELECT status FROM runs WHERE id = ?').get(runId);
    if (r.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.match(getDb().prepare('SELECT output FROM runs WHERE id = ?').get(runId).output, /ran with --fast/);

  // In use → can't delete.
  const del = await req('POST', `/scripts/${id}/delete`, { _csrf: csrf });
  assert.match(decodeURIComponent(del.location), /used by 1 job/);
  assert.match((await req('GET', '/jobs')).body, /scheduled\.py --fast/);
});

test('packages http: page renders without a venv; requirements save; bad names rejected', async () => {
  const page = await req('GET', '/packages');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /No virtualenv yet/);

  const save = await req('POST', '/packages/requirements', { content: 'requests==2.32.3' }, { json: true });
  assert.deepStrictEqual(save.json().ok, true);
  assert.strictEqual(fs.readFileSync(path.join(process.env.SCRIPTS_DIR, 'requirements.txt'), 'utf8'), 'requests==2.32.3\n');

  assert.strictEqual((await req('POST', '/packages/install', {}, { json: true })).status, 400, 'no venv yet');
  assert.strictEqual((await req('POST', '/packages/uninstall', { name: 'x; rm -rf /' }, { json: true })).status, 400);
});
