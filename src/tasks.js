'use strict';

// In-memory registry of interactive processes (script test runs, pip installs)
// whose output is streamed live to the browser over Server-Sent Events.

const crypto = require('crypto');
const { runCommand } = require('./runner');

const tasks = new Map(); // id -> task
const FINISHED_TTL_MS = 10 * 60 * 1000; // keep finished tasks around for late viewers

// Starts a command and returns the task id. `onFinish(result)` runs once it ends.
function startTask({ kind, label, command, cwd, env, timeoutSec = 300, onFinish }) {
  const id = crypto.randomBytes(12).toString('hex');
  const controller = new AbortController();
  const task = {
    id,
    kind,
    label,
    output: '',
    status: 'running',
    exitCode: null,
    startedAt: new Date(),
    listeners: new Set(),
    controller,
  };
  tasks.set(id, task);

  const emit = (event, data) => {
    for (const fn of task.listeners) fn(event, data);
  };

  runCommand(command, {
    cwd,
    env,
    timeoutSec,
    signal: controller.signal,
    onOutput: (output) => {
      const chunk = output.slice(task.output.length);
      task.output = output;
      if (chunk) emit('output', chunk);
    },
  }).then(async (result) => {
    // The runner may append a trailer ("[runner] timed out ...") at the end.
    const tail = result.output.slice(task.output.length);
    task.output = result.output;
    if (tail) emit('output', tail);
    task.status = result.status;
    task.exitCode = result.exitCode;
    try {
      if (onFinish) await onFinish(result);
    } catch (err) {
      console.error(`[tasks] onFinish failed for ${kind} ${id}: ${err.message}`);
    }
    emit('end', { status: result.status, exitCode: result.exitCode });
    task.listeners.clear();
    setTimeout(() => tasks.delete(id), FINISHED_TTL_MS).unref();
  });

  return id;
}

function getTask(id) {
  return tasks.get(id) || null;
}

function cancelTask(id) {
  const task = tasks.get(id);
  if (!task || task.status !== 'running') return false;
  task.controller.abort();
  return true;
}

function cancelAllTasks() {
  for (const task of tasks.values()) if (task.status === 'running') task.controller.abort();
}

// Express handler body: streams a task as SSE (`output` chunks, then `end`).
function streamTask(task, req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (task.output) send('output', task.output);
  if (task.status !== 'running') {
    send('end', { status: task.status, exitCode: task.exitCode });
    return res.end();
  }

  const listener = (event, data) => {
    send(event, data);
    if (event === 'end') res.end();
  };
  task.listeners.add(listener);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  // 'close' fires both when the stream ends and when the browser disconnects.
  res.on('close', () => {
    clearInterval(ping);
    task.listeners.delete(listener);
  });
}

module.exports = { startTask, getTask, cancelTask, cancelAllTasks, streamTask };
