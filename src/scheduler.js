'use strict';

const cron = require('node-cron');
const { getDb } = require('./db');
const { decrypt } = require('./vault');
const { runCommand } = require('./runner');

const scheduledTasks = new Map();

// Resolve the env vars for a job by decrypting its linked secrets.
function resolveJobEnv(jobId) {
  const secretRows = getDb()
    .prepare(
      `SELECT s.name AS name, s.encrypted_value AS enc
         FROM job_secrets js
         JOIN secrets s ON s.id = js.secret_id
        WHERE js.job_id = ?`
    )
    .all(jobId);

  const env = {};
  for (const row of secretRows) {
    try {
      env[row.name] = decrypt(row.enc);
    } catch (e) {
      // Keep going; the secret simply won't be injected for this run.
      continue;
    }
  }
  return env;
}

// Execute a job once, record the run, and return the run record.
function runJobNow(jobId) {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const insert = db.prepare(
    'INSERT INTO runs (job_id, status, started_at) VALUES (?, ?, datetime(\'now\'))'
  );
  const info = insert.run(jobId, 'running');
  const runId = info.lastInsertRowid;

  // Kick off the async execution; record the result when it finishes.
  (async () => {
    const env = resolveJobEnv(jobId);
    const result = await runCommand(job.command, {
      cwd: job.working_dir || undefined,
      env,
      timeoutSec: job.timeout_sec,
    });
    db.prepare(
      `UPDATE runs
          SET status = ?, finished_at = datetime('now'), exit_code = ?, output = ?
        WHERE id = ?`
    ).run(result.status, result.exitCode, result.output, runId);
  })();

  return { runId, jobId };
}

function scheduleJob(job) {
  unscheduleJob(job.id);
  if (!job.enabled || !job.cron_schedule) return;

  if (!cron.validate(job.cron_schedule)) {
    console.warn(`[scheduler] invalid cron expression for job #${job.id}: ${job.cron_schedule}`);
    return;
  }

  const task = cron.schedule(job.cron_schedule, () => {
    runJobNow(job.id);
  });
  scheduledTasks.set(job.id, task);
}

function unscheduleJob(jobId) {
  const task = scheduledTasks.get(jobId);
  if (task) {
    task.stop();
    scheduledTasks.delete(jobId);
  }
}

// (Re)load all enabled scheduled jobs from the DB into the scheduler.
function rescheduleAll() {
  const jobs = getDb().prepare('SELECT * FROM jobs').all();
  for (const job of jobs) scheduleJob(job);
}

module.exports = { runJobNow, scheduleJob, unscheduleJob, rescheduleAll };
