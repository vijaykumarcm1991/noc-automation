'use strict';

// Minimal Docker Engine API client over the unix socket (no dependencies).
// Everything returned to views goes through sanitize*(), which drops command
// lines and environment values — those often contain tokens and passwords.

const http = require('http');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause'];
const DEFAULT_TIMEOUT_MS = 15_000;

function socketPath() {
  return process.env.DOCKER_SOCKET || '/var/run/docker.sock';
}

class DockerError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function friendlyError(err) {
  if (err instanceof DockerError) return err;
  const p = socketPath();
  if (err.code === 'ENOENT') return new DockerError(`Docker socket not found at ${p}. Is Docker installed and running?`, 503);
  if (err.code === 'EACCES') return new DockerError(`Permission denied on ${p}. The app's user must be in the "docker" group.`, 503);
  if (err.code === 'ECONNREFUSED') return new DockerError('The Docker daemon is not running.', 503);
  if (err.code === 'ETIMEDOUT') return new DockerError('Docker did not respond in time.', 504);
  return new DockerError(err.message, 500);
}

function validId(id) {
  if (!ID_RE.test(String(id || ''))) throw new DockerError('Invalid container id or name.', 400);
  return encodeURIComponent(id);
}

// Raw request. Resolves with the response stream when `stream` is set,
// otherwise with { status, body } where body is parsed JSON when possible.
function request(method, path, { body, timeoutMs = DEFAULT_TIMEOUT_MS, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: socketPath(),
        method,
        path,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        if (stream && res.statusCode < 300) {
          req.setTimeout(0);
          return resolve(res);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // Not JSON (e.g. plain-text errors); keep the text.
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => reject(friendlyError(err)));
    if (payload) req.write(payload);
    req.end();
  });
}

function apiError(res, fallback) {
  const msg = res.body && typeof res.body === 'object' && res.body.message ? res.body.message : fallback;
  return new DockerError(msg, res.status === 404 ? 404 : res.status >= 500 ? 502 : 400);
}

async function getJSON(path, opts) {
  const res = await request('GET', path, opts);
  if (res.status !== 200) throw apiError(res, `Docker returned HTTP ${res.status}`);
  return res.body;
}

// --- Sanitizing ------------------------------------------------------------------

function envNames(env) {
  return (env || []).map((e) => String(e).split('=')[0]).filter(Boolean).sort();
}

function containerName(c) {
  const n = (c.Names && c.Names[0]) || c.Name || c.Id;
  return String(n).replace(/^\//, '');
}

function healthOf(status) {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status || '');
  return m ? m[1].replace('health: ', '') : null;
}

// Container from /containers/json -> safe summary for views.
function sanitizeSummary(c) {
  const labels = c.Labels || {};
  const ports = [];
  const seen = new Set();
  for (const p of c.Ports || []) {
    if (!p.PublicPort) continue;
    const key = `${p.PublicPort}/${p.PrivatePort}/${p.Type}`;
    if (seen.has(key)) continue; // IPv4 and IPv6 bindings of the same port
    seen.add(key);
    ports.push({ public: p.PublicPort, private: p.PrivatePort, type: p.Type });
  }
  ports.sort((a, b) => a.public - b.public);
  return {
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name: containerName(c),
    image: c.Image,
    state: c.State, // running | exited | paused | restarting | created | dead
    status: c.Status, // "Up 6 days (healthy)"
    health: healthOf(c.Status),
    created: c.Created ? new Date(c.Created * 1000) : null,
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    ports,
  };
}

// /containers/{id}/json -> safe details for the detail page.
function sanitizeInspect(d) {
  const s = d.State || {};
  const hc = d.HostConfig || {};
  const cfg = d.Config || {};
  const labels = cfg.Labels || {};
  const ports = [];
  for (const [priv, binds] of Object.entries((d.NetworkSettings && d.NetworkSettings.Ports) || {})) {
    for (const b of binds || []) {
      if (!ports.some((p) => p.public === Number(b.HostPort) && p.private === priv)) {
        ports.push({ public: Number(b.HostPort), private: priv });
      }
    }
  }
  const date = (v) => (v && !v.startsWith('0001-') ? new Date(v) : null);
  return {
    id: d.Id,
    shortId: d.Id.slice(0, 12),
    name: containerName(d),
    image: cfg.Image,
    imageId: (d.Image || '').replace('sha256:', '').slice(0, 12),
    state: s.Status,
    running: !!s.Running,
    paused: !!s.Paused,
    exitCode: s.ExitCode,
    error: s.Error || null,
    oomKilled: !!s.OOMKilled,
    health: s.Health ? s.Health.Status : null,
    healthLog: s.Health && s.Health.Log ? s.Health.Log.slice(-3).map((l) => ({ at: date(l.End), exitCode: l.ExitCode })) : [],
    created: date(d.Created),
    startedAt: date(s.StartedAt),
    finishedAt: date(s.FinishedAt),
    restartCount: d.RestartCount || 0,
    restartPolicy: (hc.RestartPolicy && hc.RestartPolicy.Name) || 'no',
    tty: !!cfg.Tty,
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    ports: ports.sort((a, b) => a.public - b.public),
    mounts: (d.Mounts || []).map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW })),
    networks: Object.keys((d.NetworkSettings && d.NetworkSettings.Networks) || {}),
    envNames: envNames(cfg.Env), // names only — values are never sent to the browser
    memoryLimit: hc.Memory || 0,
  };
}

// --- Containers --------------------------------------------------------------------

async function ping() {
  const res = await request('GET', '/_ping', { timeoutMs: 3000 });
  if (res.status !== 200) throw apiError(res, 'Docker is not responding.');
  return true;
}

async function listContainers(opts) {
  const list = await getJSON('/containers/json?all=1', opts);
  return list.map(sanitizeSummary).sort((a, b) => a.name.localeCompare(b.name));
}

// Containers grouped by Compose project; standalone containers last.
function groupByProject(containers) {
  const groups = new Map();
  for (const c of containers) {
    const key = c.project || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([project, items]) => ({ project: project || null, containers: items }));
}

async function inspect(id) {
  return sanitizeInspect(await getJSON(`/containers/${validId(id)}/json`));
}

async function summary(timeoutMs = 1000) {
  const list = await listContainers({ timeoutMs });
  return {
    total: list.length,
    running: list.filter((c) => c.state === 'running').length,
    stopped: list.filter((c) => c.state !== 'running').length,
    unhealthy: list.filter((c) => c.health === 'unhealthy').length,
  };
}

function cpuPercent(s) {
  const cpu = s.cpu_stats || {};
  const pre = s.precpu_stats || {};
  const cpuDelta = ((cpu.cpu_usage || {}).total_usage || 0) - ((pre.cpu_usage || {}).total_usage || 0);
  const sysDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  const cpus = cpu.online_cpus || ((cpu.cpu_usage || {}).percpu_usage || []).length || 1;
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  return (cpuDelta / sysDelta) * cpus * 100;
}

function memoryUsage(s) {
  const m = s.memory_stats || {};
  const st = m.stats || {};
  // cgroup v2 reports inactive_file, v1 reports cache; both are reclaimable page cache.
  const used = Math.max(0, (m.usage || 0) - (st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0));
  return { used, limit: m.limit || 0, percent: m.limit ? (used / m.limit) * 100 : 0 };
}

async function stats(id) {
  const s = await getJSON(`/containers/${validId(id)}/stats?stream=false`, { timeoutMs: 8000 });
  const mem = memoryUsage(s);
  return { cpu: Math.round(cpuPercent(s) * 10) / 10, memUsed: mem.used, memLimit: mem.limit, memPercent: Math.round(mem.percent * 10) / 10 };
}

// Run an action. Resolves with a short human message.
async function action(id, name) {
  if (!ACTIONS.includes(name)) throw new DockerError('Unknown action.', 400);
  const query = name === 'stop' || name === 'restart' ? '?t=10' : '';
  const res = await request('POST', `/containers/${validId(id)}/${name}${query}`, { timeoutMs: 60_000 });
  const done = { start: 'started', stop: 'stopped', restart: 'restarted', pause: 'paused', unpause: 'resumed' };
  if (res.status === 204) return done[name];
  if (res.status === 304) return name === 'start' ? 'was already running' : 'was already stopped';
  throw apiError(res, `Could not ${name} the container (HTTP ${res.status}).`);
}

async function remove(id) {
  const details = await inspect(id);
  if (details.running || details.paused) throw new DockerError('Stop the container before removing it.', 409);
  const res = await request('DELETE', `/containers/${validId(id)}?v=false&force=false`);
  if (res.status !== 204) throw apiError(res, `Could not remove the container (HTTP ${res.status}).`);
  return details;
}

// --- Logs ----------------------------------------------------------------------------

// Opens the log stream. `since` is seconds back from now (0 = everything).
async function logs(id, { tail = 500, since = 0, timestamps = true, follow = false } = {}) {
  const q = new URLSearchParams({
    stdout: '1',
    stderr: '1',
    timestamps: timestamps ? '1' : '0',
    follow: follow ? '1' : '0',
    tail: tail === 'all' ? 'all' : String(Math.max(1, Math.min(Number(tail) || 500, 100_000))),
  });
  if (since > 0) q.set('since', String(Math.floor(Date.now() / 1000) - since));
  const res = await request('GET', `/containers/${validId(id)}/logs?${q}`, { stream: true, timeoutMs: 10_000 });
  if (!res.pipe) throw apiError(res, `Could not read logs (HTTP ${res.status}).`);
  return res;
}

// Turns a Docker log stream into lines: onLine({ stream: 'out'|'err', text }).
// Non-TTY containers use 8-byte frame headers (stream type + length); TTY ones send raw text.
function lineReader(tty, onLine) {
  let buf = Buffer.alloc(0);
  const partial = { out: '', err: '' };
  const emitText = (stream, text) => {
    const parts = (partial[stream] + text).split('\n');
    partial[stream] = parts.pop();
    for (const line of parts) onLine({ stream, text: line.replace(/\r$/, '') });
  };
  return {
    push(chunk) {
      if (tty) return emitText('out', chunk.toString('utf8'));
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const size = buf.readUInt32BE(4);
        if (buf.length < 8 + size) break;
        const stream = buf[0] === 2 ? 'err' : 'out';
        emitText(stream, buf.subarray(8, 8 + size).toString('utf8'));
        buf = buf.subarray(8 + size);
      }
    },
    end() {
      for (const stream of ['out', 'err']) {
        if (partial[stream]) onLine({ stream, text: partial[stream] });
        partial[stream] = '';
      }
    },
  };
}

// "2026-10-29T10:01:02.123456789Z message" -> { ts: Date, text }
function splitTimestamp(line) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/.exec(line);
  if (!m) return { ts: null, text: line };
  return { ts: new Date(m[1].replace(/(\.\d{3})\d+Z$/, '$1Z')), text: m[2] };
}

// --- Images --------------------------------------------------------------------------

async function listImages() {
  const [images, containers] = await Promise.all([getJSON('/images/json'), getJSON('/containers/json?all=1')]);
  return images
    .map((img) => ({
      id: img.Id.replace('sha256:', '').slice(0, 12),
      tags: (img.RepoTags || []).filter((t) => t !== '<none>:<none>'),
      size: img.Size,
      created: new Date(img.Created * 1000),
      containers: containers.filter((c) => c.ImageID === img.Id).length,
      dangling: !(img.RepoTags || []).some((t) => t !== '<none>:<none>'),
    }))
    .sort((a, b) => b.created - a.created);
}

async function pruneDanglingImages() {
  const filters = encodeURIComponent(JSON.stringify({ dangling: ['true'] }));
  const res = await request('POST', `/images/prune?filters=${filters}`, { timeoutMs: 120_000 });
  if (res.status !== 200) throw apiError(res, `Prune failed (HTTP ${res.status}).`);
  return { deleted: (res.body.ImagesDeleted || []).length, reclaimed: res.body.SpaceReclaimed || 0 };
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

module.exports = {
  ID_RE,
  ACTIONS,
  DockerError,
  socketPath,
  validId,
  ping,
  listContainers,
  groupByProject,
  inspect,
  summary,
  stats,
  cpuPercent,
  memoryUsage,
  action,
  remove,
  logs,
  lineReader,
  splitTimestamp,
  listImages,
  pruneDanglingImages,
  formatBytes,
  sanitizeSummary,
  sanitizeInspect,
};
