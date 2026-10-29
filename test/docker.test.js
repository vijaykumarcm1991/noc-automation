'use strict';

// Docker management tests against a fake Docker Engine API on a unix socket.

const crypto = require('crypto');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Unix socket paths are limited to ~107 bytes, so keep this one short.
let sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-'));
if (sockDir.length > 90) sockDir = fs.mkdtempSync('/tmp/nd-');
const SOCKET = path.join(sockDir, 'd.sock');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-docker-'));

process.env.DOCKER_SOCKET = SOCKET;
process.env.SCRIPTS_DIR = path.join(tmp, 'scripts');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'docker-pw';
process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');

// Fake `docker` CLI for exec: echoes its arguments.
const fakeBin = path.join(tmp, 'fake-docker');
fs.writeFileSync(fakeBin, '#!/bin/sh\necho "fake-docker $*"\n', { mode: 0o755 });
process.env.DOCKER_BIN = fakeBin;

const { initDb, getDb } = require('../src/db');
const { setMasterKey } = require('../src/vault');
const { createApp } = require('../src/app');
const docker = require('../src/docker');

setMasterKey(process.env.MASTER_KEY);
initDb(path.join(tmp, 'test.db'));

const SECRET = 'glc_SUPER_SECRET_TOKEN_123';
const calls = [];

function frame(stream, text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream === 'err' ? 2 : 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const containers = {
  web: {
    Id: 'a'.repeat(64),
    Names: ['/web'],
    Image: 'nginx:1.27',
    ImageID: 'sha256:img1',
    Command: `/entrypoint --token ${SECRET}`,
    State: 'running',
    Status: 'Up 2 hours (healthy)',
    Created: 1761700000,
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
      { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
    ],
    Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' },
  },
  worker: {
    Id: 'b'.repeat(64),
    Names: ['/worker'],
    Image: 'busybox',
    ImageID: 'sha256:img2',
    Command: 'sleep 1',
    State: 'exited',
    Status: 'Exited (0) 5 minutes ago',
    Created: 1761700000,
    Ports: [],
    Labels: {},
  },
};

function inspectOf(c) {
  const running = c.State === 'running';
  return {
    Id: c.Id,
    Name: c.Names[0],
    Image: c.ImageID,
    Created: '2026-10-29T08:00:00Z',
    RestartCount: 1,
    State: { Status: c.State, Running: running, Paused: false, ExitCode: 0, StartedAt: '2026-10-29T08:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', Health: running ? { Status: 'healthy', Log: [] } : undefined },
    Config: { Image: c.Image, Tty: false, Env: [`API_TOKEN=${SECRET}`, 'PATH=/usr/bin'], Cmd: ['--token', SECRET], Labels: c.Labels },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, Memory: 0 },
    NetworkSettings: { Ports: running ? { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } : {}, Networks: { shop_default: {} } },
    Mounts: [{ Type: 'volume', Source: '/var/lib/docker/volumes/x', Destination: '/data', RW: true }],
  };
}

const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://docker');
  calls.push(`${req.method} ${url.pathname}`);
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const m = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
  if (url.pathname === '/_ping') return res.end('OK');
  if (url.pathname === '/containers/json') return json(200, Object.values(containers));
  if (url.pathname === '/images/json') {
    return json(200, [
      { Id: 'sha256:img1', RepoTags: ['nginx:1.27'], Size: 200 * 1024 * 1024, Created: 1761700000 },
      { Id: 'sha256:img3', RepoTags: ['<none>:<none>'], Size: 50 * 1024 * 1024, Created: 1761600000 },
    ]);
  }
  if (url.pathname === '/images/prune') return json(200, { ImagesDeleted: [{ Deleted: 'sha256:img3' }], SpaceReclaimed: 50 * 1024 * 1024 });
  if (m) {
    const c = Object.values(containers).find((x) => x.Names[0] === `/${m[1]}` || x.Id === m[1]);
    if (!c) return json(404, { message: `No such container: ${m[1]}` });
    const sub = m[2];
    if (req.method === 'GET' && sub === 'json') return json(200, inspectOf(c));
    if (req.method === 'DELETE' && !sub) return c.State === 'running' ? json(409, { message: 'container is running' }) : json(204);
    if (req.method === 'GET' && sub === 'stats') {
      return json(200, {
        cpu_stats: { cpu_usage: { total_usage: 1200 }, system_cpu_usage: 11000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 },
        memory_stats: { usage: 300 * 1024 * 1024, limit: 1000 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
      });
    }
    if (req.method === 'GET' && sub === 'logs') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      // Split a frame across writes to exercise reassembly.
      const ts = url.searchParams.get('timestamps') === '1';
      const all = Buffer.concat([
        frame('out', `${ts ? '2026-10-29T10:00:00.123456789Z ' : ''}hello world\n`),
        frame('err', `${ts ? '2026-10-29T10:00:01.000000000Z ' : ''}oops <b>bad</b>\n`),
      ]);
      res.write(all.subarray(0, 13));
      setTimeout(() => res.end(all.subarray(13)), 20);
      return;
    }
    if (req.method === 'POST' && ['start', 'stop', 'restart', 'pause', 'unpause'].includes(sub)) {
      if (sub === 'start' && c.State === 'running') return json(304);
      return json(204);
    }
  }
  json(404, { message: 'not found' });
});

let server;
let base;
let req;
let csrf;

test.before(async () => {
  await new Promise((r) => fake.listen(SOCKET, r));
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
      payload = new URLSearchParams({ _csrf: csrf, ...body }).toString();
    }
    const res = await fetch(base + url, { method, redirect: 'manual', headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, body: text, json: () => JSON.parse(text) };
  };
  await req('POST', '/login', { username: 'admin', password: 'docker-pw' });
  csrf = (await req('GET', '/')).body.match(/name="csrf-token" content="([0-9a-f]+)"/)[1];
});

test.after(() => {
  server.close();
  fake.close();
});

// --- Unit -------------------------------------------------------------------------------

test('docker unit: CPU and memory maths', () => {
  const s = {
    cpu_stats: { cpu_usage: { total_usage: 1200 }, system_cpu_usage: 11000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000 },
    memory_stats: { usage: 300, limit: 1000, stats: { inactive_file: 100 } },
  };
  assert.strictEqual(docker.cpuPercent(s), 40);
  assert.deepStrictEqual(docker.memoryUsage(s), { used: 200, limit: 1000, percent: 20 });
  assert.strictEqual(docker.cpuPercent({}), 0);
});

test('docker unit: multiplexed log frames are reassembled into stdout/stderr lines', () => {
  const lines = [];
  const r = docker.lineReader(false, (l) => lines.push(l));
  const data = Buffer.concat([frame('out', 'one\ntw'), frame('out', 'o\n'), frame('err', 'bad\n'), frame('out', 'tail')]);
  for (let i = 0; i < data.length; i += 5) r.push(data.subarray(i, i + 5)); // tiny chunks
  r.end();
  assert.deepStrictEqual(lines, [
    { stream: 'out', text: 'one' },
    { stream: 'out', text: 'two' },
    { stream: 'err', text: 'bad' },
    { stream: 'out', text: 'tail' },
  ]);

  const tty = [];
  const t = docker.lineReader(true, (l) => tty.push(l.text));
  t.push(Buffer.from('a\r\nb\n'));
  assert.deepStrictEqual(tty, ['a', 'b']);
});

test('docker unit: timestamps are parsed and ids validated', () => {
  const { ts, text } = docker.splitTimestamp('2026-10-29T10:00:00.123456789Z hello');
  assert.strictEqual(ts.toISOString(), '2026-10-29T10:00:00.123Z');
  assert.strictEqual(text, 'hello');
  assert.strictEqual(docker.splitTimestamp('no stamp').ts, null);
  for (const bad of ['../etc', 'a/b', '', 'x?y=1', ' web']) assert.throws(() => docker.validId(bad), /Invalid container/);
  assert.strictEqual(docker.validId('mail_jira-mongo.1'), 'mail_jira-mongo.1');
});

// --- HTTP -------------------------------------------------------------------------------

test('docker http: list groups by project and never exposes commands or env values', async () => {
  const page = await req('GET', '/docker');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /shop/);
  assert.match(page.body, /Standalone containers/);
  assert.match(page.body, />web</);
  assert.match(page.body, /8080:80/);
  assert.strictEqual((page.body.match(/8080:80/g) || []).length, 1, 'IPv4/IPv6 duplicates collapsed');
  assert.ok(!page.body.includes(SECRET), 'token must not appear in the list page');

  const detail = await req('GET', '/docker/containers/web');
  assert.strictEqual(detail.status, 200);
  assert.match(detail.body, /API_TOKEN/);
  assert.ok(!detail.body.includes(SECRET), 'token must not appear on the detail page');
  assert.match(detail.body, /unless-stopped/);

  assert.strictEqual((await req('GET', '/docker/containers/nope')).status, 404);
  assert.strictEqual((await req('GET', '/docker/containers/..%2Fetc')).status, 400);
});

test('docker http: actions call the API, are audited, and remove is refused while running', async () => {
  calls.length = 0;
  const r = await req('POST', '/docker/containers/web/restart', { return: 'list' });
  assert.strictEqual(r.status, 302);
  assert.match(decodeURIComponent(r.location), /^\/docker\?notice=web restarted\./);
  assert.ok(calls.includes(`POST /containers/web/restart`));
  assert.ok(getDb().prepare("SELECT * FROM audit_log WHERE action = 'docker.restart' AND target = 'web'").get());

  const already = await req('POST', '/docker/containers/web/start', {});
  assert.match(decodeURIComponent(already.location), /was already running/);

  const refused = await req('POST', '/docker/containers/web/remove', {});
  assert.match(decodeURIComponent(refused.location), /Stop the container before removing it/);
  assert.ok(!calls.some((c) => c.startsWith('DELETE')));

  const removed = await req('POST', '/docker/containers/worker/remove', {});
  assert.match(decodeURIComponent(removed.location), /Removed container worker/);
  assert.ok(calls.includes('DELETE /containers/worker'));

  assert.strictEqual((await req('POST', '/docker/containers/web/kill', {})).status, 404, 'unknown actions rejected');
  // A logged-in POST with a wrong CSRF token is rejected and never reaches Docker.
  calls.length = 0;
  const realCsrf = csrf;
  csrf = 'deadbeef';
  const noCsrf = await req('POST', '/docker/containers/web/stop', {});
  csrf = realCsrf;
  assert.strictEqual(noCsrf.status, 403);
  assert.ok(!calls.some((c) => c.includes('/stop')));
});

test('docker http: project actions only touch containers that need it', async () => {
  calls.length = 0;
  const r = await req('POST', '/docker/projects/shop/restart', {});
  assert.match(decodeURIComponent(r.location), /Project shop: restart done for 1 container/);
  assert.deepStrictEqual(calls.filter((c) => c.startsWith('POST')), ['POST /containers/' + 'a'.repeat(64) + '/restart']);

  calls.length = 0;
  const start = await req('POST', '/docker/projects/shop/start', {});
  assert.match(decodeURIComponent(start.location), /nothing to start/);
  assert.strictEqual(calls.filter((c) => c.startsWith('POST')).length, 0);
  assert.strictEqual((await req('POST', '/docker/projects/Bad%20Name/stop', {})).status, 400);
});

test('docker http: logs stream as SSE with IST timestamps and stderr marked; download works', async () => {
  const sse = await req('GET', '/docker/containers/web/logs/stream?tail=100&follow=0');
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  const events = sse.body.split('\n\n').filter(Boolean);
  const lines = events.filter((e) => e.startsWith('event: lines')).flatMap((e) => JSON.parse(e.split('data: ')[1]));
  assert.deepStrictEqual(
    lines.map((l) => [l.s, l.t]),
    [
      ['out', 'hello world'],
      ['err', 'oops <b>bad</b>'],
    ]
  );
  assert.match(lines[0].ts, /15:30:00\.123/, '10:00 UTC shown as 15:30 IST');
  assert.match(events[events.length - 1], /^event: end/);

  const file = await req('GET', '/docker/containers/web/logs.txt?tail=100');
  assert.match(file.headers.get('content-disposition'), /attachment; filename="web-\d{12}\.log"/);
  assert.match(file.body, /15:30:00\.123 hello world/);
  assert.match(file.body, /\[stderr\] oops/);

  const noTs = await req('GET', '/docker/containers/web/logs.txt?timestamps=0');
  assert.match(noTs.body, /^hello world$/m);
});

test('docker http: stats, images and prune', async () => {
  const stats = (await req('GET', '/docker/stats.json')).json();
  assert.deepStrictEqual(stats['a'.repeat(64)], { cpu: 40, memUsed: 200 * 1024 * 1024, memLimit: 1000 * 1024 * 1024, memPercent: 20 });
  assert.ok(!stats['b'.repeat(64)], 'stopped containers have no stats');

  const images = await req('GET', '/docker/images');
  assert.match(images.body, /nginx:1\.27/);
  assert.match(images.body, /dangling/);
  assert.match(images.body, /Prune dangling images \(1\)/);

  const pruned = await req('POST', '/docker/images/prune', {});
  assert.match(decodeURIComponent(pruned.location), /Removed 1 dangling image\(s\), reclaimed 50\.0 MB/);
  assert.ok(getDb().prepare("SELECT * FROM audit_log WHERE action = 'docker.image_prune'").get());
});

test('docker http: shell runs through docker exec, streams output, and is audited', async () => {
  const start = await req('POST', '/docker/containers/web/exec', { command: "echo 'hi there'", timeout_sec: 10 }, { json: true });
  assert.strictEqual(start.status, 200, start.body);
  const stream = await req('GET', `/tasks/${start.json().taskId}/stream`);
  assert.match(stream.body, /fake-docker exec a{64} sh -c echo 'hi there'/);
  assert.match(stream.body, /"status":"success"/);
  const row = getDb().prepare("SELECT * FROM audit_log WHERE action = 'docker.exec' ORDER BY id DESC").get();
  assert.strictEqual(row.target, 'web');
  assert.strictEqual(row.detail, "echo 'hi there'");

  const stopped = await req('POST', '/docker/containers/worker/exec', { command: 'ls' }, { json: true });
  assert.strictEqual(stopped.status, 409);
  assert.strictEqual((await req('POST', '/docker/containers/web/exec', { command: '  ' }, { json: true })).status, 400);
});

test('docker http: dashboard tile appears, and pages degrade cleanly when Docker is down', async () => {
  const dash = await req('GET', '/');
  assert.match(dash.body, /Manage containers/);

  process.env.DOCKER_SOCKET = path.join(sockDir, 'missing.sock');
  try {
    const page = await req('GET', '/docker');
    assert.strictEqual(page.status, 503);
    assert.match(page.body, /Docker is unavailable/);
    assert.match(page.body, /Docker socket not found/);
    const home = await req('GET', '/');
    assert.strictEqual(home.status, 200);
    assert.doesNotMatch(home.body, /Manage containers/);
  } finally {
    process.env.DOCKER_SOCKET = SOCKET;
  }
});
