'use strict';

// Docker containers, logs, shell (exec) and images.

const express = require('express');
const docker = require('../docker');
const { audit } = require('../db');
const { startTask } = require('../tasks');
const { shQuote } = require('../scripts');
const { APP_TZ } = require('../time');

const router = express.Router();
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MAX_EXEC_TIMEOUT_SEC = 600;

const logTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: APP_TZ,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});

function unavailable(res, err) {
  const status = err.status || 500;
  if (status === 400 || status === 404) return res.status(status).send(err.message);
  res.status(status).render('docker/unavailable', { message: err.message, socket: docker.socketPath() });
}

function back(res, path, notice, kind = 'ok') {
  res.redirect(`${path}${path.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}&kind=${kind}`);
}

// Parse logs query options shared by the stream and the download.
function logOptions(q) {
  const tailRaw = String(q.tail || '500');
  return {
    tail: tailRaw === 'all' ? 'all' : Math.max(1, Math.min(parseInt(tailRaw, 10) || 500, 100_000)),
    since: Math.max(0, parseInt(q.since, 10) || 0),
    timestamps: q.timestamps !== '0',
  };
}

function formatLine(line, timestamps) {
  if (!timestamps) return { s: line.stream, t: line.text, ts: null };
  const { ts, text } = docker.splitTimestamp(line.text);
  return { s: line.stream, t: text, ts: ts ? logTimeFmt.format(ts) : null };
}

// --- Containers list ------------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const containers = await docker.listContainers();
    res.render('docker/index', {
      groups: docker.groupByProject(containers),
      counts: {
        total: containers.length,
        running: containers.filter((c) => c.state === 'running').length,
        unhealthy: containers.filter((c) => c.health === 'unhealthy').length,
      },
      host: req.hostname,
      notice: req.query.notice || null,
      kind: req.query.kind || 'ok',
    });
  } catch (err) {
    unavailable(res, err);
  }
});

// CPU/memory for every running container (polled by the list page).
router.get('/stats.json', async (req, res) => {
  try {
    const running = (await docker.listContainers()).filter((c) => c.state === 'running');
    const results = await Promise.allSettled(running.map((c) => docker.stats(c.id)));
    const out = {};
    running.forEach((c, i) => {
      if (results[i].status === 'fulfilled') out[c.id] = results[i].value;
    });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Images ----------------------------------------------------------------------------

router.get('/images', async (req, res) => {
  try {
    const images = await docker.listImages();
    res.render('docker/images', {
      images,
      totalSize: images.reduce((n, i) => n + i.size, 0),
      danglingCount: images.filter((i) => i.dangling).length,
      notice: req.query.notice || null,
      kind: req.query.kind || 'ok',
    });
  } catch (err) {
    unavailable(res, err);
  }
});

router.post('/images/prune', async (req, res) => {
  try {
    const result = await docker.pruneDanglingImages();
    audit('docker.image_prune', 'dangling images', `${result.deleted} deleted, ${docker.formatBytes(result.reclaimed)} reclaimed`);
    back(res, '/docker/images', `Removed ${result.deleted} dangling image(s), reclaimed ${docker.formatBytes(result.reclaimed)}.`);
  } catch (err) {
    back(res, '/docker/images', err.message, 'error');
  }
});

// --- Compose project actions -------------------------------------------------------------

router.post('/projects/:project/:action', async (req, res) => {
  const { project, action } = req.params;
  if (!PROJECT_RE.test(project) || !['start', 'stop', 'restart'].includes(action)) return res.status(400).send('Invalid request');
  try {
    const members = (await docker.listContainers()).filter((c) => c.project === project);
    if (!members.length) return back(res, '/docker', `No containers found for project ${project}.`, 'error');
    const targets = members.filter((c) =>
      action === 'start' ? c.state !== 'running' : action === 'stop' ? c.state === 'running' || c.state === 'paused' : true
    );
    const failures = [];
    for (const c of targets) {
      try {
        await docker.action(c.id, action);
      } catch (err) {
        failures.push(`${c.name}: ${err.message}`);
      }
    }
    audit(`docker.project_${action}`, project, targets.map((c) => c.name).join(', ') || 'nothing to do');
    if (failures.length) return back(res, '/docker', `Project ${project}: ${failures.join('; ')}`, 'error');
    back(res, '/docker', targets.length ? `Project ${project}: ${action} done for ${targets.length} container(s).` : `Project ${project}: nothing to ${action}.`);
  } catch (err) {
    back(res, '/docker', err.message, 'error');
  }
});

// --- Single container -------------------------------------------------------------------

router.get('/containers/:id', async (req, res) => {
  try {
    const container = await docker.inspect(req.params.id);
    res.render('docker/container', {
      c: container,
      tab: ['overview', 'logs', 'shell'].includes(req.query.tab) ? req.query.tab : 'overview',
      host: req.hostname,
      notice: req.query.notice || null,
      kind: req.query.kind || 'ok',
    });
  } catch (err) {
    unavailable(res, err);
  }
});

router.get('/containers/:id/stats.json', async (req, res) => {
  try {
    res.json(await docker.stats(req.params.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/containers/:id/remove', async (req, res) => {
  const id = req.params.id;
  try {
    const removed = await docker.remove(id);
    audit('docker.remove', removed.name);
    back(res, '/docker', `Removed container ${removed.name}.`);
  } catch (err) {
    if (err.status === 400) return res.status(400).send(err.message);
    back(res, `/docker/containers/${encodeURIComponent(id)}`, err.message, 'error');
  }
});

router.post('/containers/:id/:action', async (req, res, next) => {
  const { id, action } = req.params;
  if (!docker.ACTIONS.includes(action)) return next(); // e.g. /exec, or unknown → 404
  const returnTo = req.body && req.body.return === 'list' ? '/docker' : `/docker/containers/${encodeURIComponent(id)}`;
  try {
    docker.validId(id);
    const message = await docker.action(id, action);
    audit(`docker.${action}`, id);
    back(res, returnTo, `${id} ${message}.`);
  } catch (err) {
    if (err.status === 400) return res.status(400).send(err.message);
    back(res, returnTo, err.message, 'error');
  }
});

// --- Logs ------------------------------------------------------------------------------------

// Live logs as Server-Sent Events: `lines` events carry [{ s, t, ts }], then `end`.
router.get('/containers/:id/logs/stream', async (req, res) => {
  const opts = logOptions(req.query);
  const follow = req.query.follow !== '0';
  let details;
  let stream;
  try {
    details = await docker.inspect(req.params.id);
    stream = await docker.logs(details.id, { ...opts, follow });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Batch lines so a burst of output doesn't become thousands of events.
  let batch = [];
  const flush = () => {
    if (batch.length) send('lines', batch);
    batch = [];
  };
  const timer = setInterval(flush, 150);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const reader = docker.lineReader(details.tty, (line) => {
    batch.push(formatLine(line, opts.timestamps));
    if (batch.length >= 500) flush();
  });

  let finished = false;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    clearInterval(ping);
    reader.end();
    flush();
    send('end', { reason });
    res.end();
  };
  stream.on('data', (chunk) => reader.push(chunk));
  stream.on('end', () => finish(follow ? 'container stopped' : 'done'));
  stream.on('error', (err) => finish(err.message));
  res.on('close', () => {
    finished = true;
    clearInterval(timer);
    clearInterval(ping);
    stream.destroy();
  });
});

// Logs as a downloadable text file (no follow).
router.get('/containers/:id/logs.txt', async (req, res) => {
  const opts = logOptions(req.query);
  try {
    const details = await docker.inspect(req.params.id);
    const stream = await docker.logs(details.id, { ...opts, follow: false });
    const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: APP_TZ, dateStyle: 'short', timeStyle: 'short' })
      .format(new Date())
      .replace(/[^0-9]/g, '')
      .slice(0, 12);
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${details.name}-${stamp}.log"`,
    });
    const reader = docker.lineReader(details.tty, (line) => {
      const l = formatLine(line, opts.timestamps);
      res.write(`${l.ts ? l.ts + ' ' : ''}${l.s === 'err' ? '[stderr] ' : ''}${l.t}\n`);
    });
    stream.on('data', (chunk) => reader.push(chunk));
    stream.on('end', () => {
      reader.end();
      res.end();
    });
    stream.on('error', () => res.end());
    res.on('close', () => stream.destroy());
  } catch (err) {
    res.status(err.status || 500).send(err.message);
  }
});

// --- Shell (exec) ---------------------------------------------------------------------------

// Runs `sh -c <command>` in the container; output streams via /tasks/:taskId/stream.
router.post('/containers/:id/exec', async (req, res) => {
  const command = String((req.body && req.body.command) || '').trim();
  if (!command) return res.status(400).json({ error: 'Enter a command.' });
  if (command.length > 2000) return res.status(400).json({ error: 'Command is too long.' });
  const timeoutSec = Math.min(Math.max(parseInt(req.body.timeout_sec, 10) || 60, 1), MAX_EXEC_TIMEOUT_SEC);
  try {
    const c = await docker.inspect(req.params.id);
    if (!c.running || c.paused) return res.status(409).json({ error: 'The container must be running to run commands in it.' });
    audit('docker.exec', c.name, command);
    const bin = process.env.DOCKER_BIN || 'docker';
    const taskId = startTask({
      kind: 'docker-exec',
      label: `${c.name}: ${command}`,
      command: `${shQuote(bin)} exec ${shQuote(c.id)} sh -c ${shQuote(command)}`,
      timeoutSec,
    });
    res.json({ taskId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
