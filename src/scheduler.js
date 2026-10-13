'use strict';

const cron = require('node-cron');
const { getDb } = require('./db');
const { decrypt } = require('./vault');
const { runCommand } = require('./runner');
const { APP_TZ } = require('./time');
const scripts = require('./scripts');

const scheduledTasks = new Map();
// jobId -> { runId, controller } for runs currently executing in this process.
const activeRuns = new Map();

class JobAlreadyRunningError extends Error {
  constructor(jobId, runId) {
    super(`Job ${jobId} is already running (run #${runId})`);
    this.code = 'ALREADY_RUNNING';
    this.runId = runId;
  }
}

// Resolve the env vars for a job by decrypting its linked secrets.
// Returns { env, errors } where errors lists secrets that failed to decrypt.
function resolveJobEnv(jobId) {
  const secretRows = getDb()
    .prepare(
      `SELECT s.name AS name, s.encrypted_value AS enc
         FROM job_secrets js
         JOIN secrets s ON s.id = js.secret_id
        WHERE js.job_id = ?`
    )
    .all(jobId);
  return decryptRows(secretRows);
}

// Decrypt the given secret ids into env vars (used by script test runs).
function decryptSecrets(secretIds) {
  const ids = (secretIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return { env: {}, errors: [] };
  const rows = getDb()
    .prepare(`SELECT name, encrypted_value AS enc FROM secrets WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  return decryptRows(rows);
}

function decryptRows(secretRows) {
  const env = {};
  const errors = [];
  for (const row of secretRows) {
    try {
      env[row.name] = decrypt(row.enc);
    } catch (e) {
      // Keep going; the secret simply won't be injected for this run.
      errors.push(row.name);
    }
  }
  return { env, errors };
}

// Execute a job once, record the run, and return { runId, jobId, done }.
// `done` resolves with the finished run's status. Throws JobAlreadyRunningError
// if the job already has a run in progress, so runs never overlap.
function runJobNow(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const active = activeRuns.get(job.id);
  if (active) throw new JobAlreadyRunningError(job.id, active.runId);

  const info = db
    .prepare("INSERT INTO runs (job_id, status, started_at) VALUES (?, 'running', datetime('now'))")
    .run(job.id);
  const runId = Number(info.lastInsertRowid);
  const controller = new AbortController();
  activeRuns.set(job.id, { runId, controller });

  const done = (async () => {
    let result;
    // Periodically save partial output so the run page can show live progress.
    let pending = null;
    const saveProgress = db.prepare("UPDATE runs SET output = ? WHERE id = ? AND status = 'running'");
    const flush = setInterval(() => {
      if (pending === null) return;
      try {
        saveProgress.run(pending, runId);
      } catch {
        // Best effort; the final output is written when the run ends.
      }
      pending = null;
    }, 2000);
    try {
      const { env, errors } = resolveJobEnv(job.id);
      // Script jobs build their command from the script at run time, so they
      // always use the current file and interpreter (e.g. the managed venv).
      let command = job.command;
      let cwd = job.working_dir || undefined;
      if (job.script_id) {
        const script = scripts.getScript(job.script_id);
        if (!script) throw new Error(`script #${job.script_id} no longer exists`);
        command = scripts.buildCommand(script, job.args);
        cwd = job.working_dir || scripts.scriptsDir();
      }
      result = await runCommand(command, {
        cwd,
        env,
        timeoutSec: job.timeout_sec,
        signal: controller.signal,
        onOutput: (output) => {
          pending = output;
        },
      });
      if (errors.length) {
        result.output = `[runner] warning: could not decrypt secret(s): ${errors.join(', ')}\n` + result.output;
      }
    } catch (err) {
      result = { status: 'failed', exitCode: null, output: `[runner] error: ${err.message}` };
    } finally {
      clearInterval(flush);
      activeRuns.delete(job.id);
    }
    try {
      db.prepare(
        `UPDATE runs
            SET status = ?, finished_at = datetime('now'), exit_code = ?, output = ?
          WHERE id = ?`
      ).run(result.status, result.exitCode, result.output, runId);
    } catch (err) {
      console.error(`[scheduler] failed to record run #${runId}: ${err.message}`);
    }
    return result.status;
  })();

  return { runId, jobId: job.id, done };
}

// Cancel an in-progress run. Returns true if a matching run was found.
function cancelRun(runId) {
  for (const active of activeRuns.values()) {
    if (active.runId === Number(runId)) {
      active.controller.abort();
      return true;
    }
  }
  return false;
}

// Cancel every in-progress run (used on shutdown).
function cancelAll() {
  for (const active of activeRuns.values()) active.controller.abort();
}

function isJobRunning(jobId) {
  return activeRuns.has(Number(jobId));
}

function scheduleJob(job) {
  unscheduleJob(job.id);
  if (!job.enabled || !job.cron_schedule) return;

  if (!cron.validate(job.cron_schedule)) {
    console.warn(`[scheduler] invalid cron expression for job #${job.id}: ${job.cron_schedule}`);
    return;
  }

  const options = { name: `job-${job.id}`, timezone: APP_TZ };

  const task = cron.schedule(
    job.cron_schedule,
    () => {
      try {
        runJobNow(job.id);
      } catch (err) {
        console.warn(`[scheduler] skipped scheduled run of job #${job.id}: ${err.message}`);
      }
    },
    options
  );
  scheduledTasks.set(job.id, task);
}

function unscheduleJob(jobId) {
  const id = Number(jobId);
  const task = scheduledTasks.get(id);
  if (task) {
    task.destroy();
    scheduledTasks.delete(id);
  }
}

// Remove every cron task (used on shutdown).
function unscheduleAll() {
  for (const id of [...scheduledTasks.keys()]) unscheduleJob(id);
}

// Next scheduled run time for a job, or null if it isn't scheduled.
function getNextRun(jobId) {
  const task = scheduledTasks.get(Number(jobId));
  return task ? task.getNextRun() : null;
}

// (Re)load all enabled scheduled jobs from the DB into the scheduler.
function rescheduleAll() {
  const jobs = getDb().prepare('SELECT * FROM jobs').all();
  for (const job of jobs) scheduleJob(job);
}

module.exports = {
  runJobNow,
  decryptSecrets,
  cancelRun,
  cancelAll,
  isJobRunning,
  scheduleJob,
  unscheduleJob,
  unscheduleAll,
  getNextRun,
  rescheduleAll,
  JobAlreadyRunningError,
};
