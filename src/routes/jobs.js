'use strict';

const express = require('express');
const { getDb } = require('../db');
const { scheduleJob, unscheduleJob, runJobNow, isJobRunning, getNextRun } = require('../scheduler');
const { validateJob } = require('../validate');
const schedule = require('../schedule');
const { formatTime, relativeTime } = require('../time');

const router = express.Router();

// List all jobs with their latest run and next scheduled time.
router.get('/', (req, res) => {
  const jobs = getDb()
    .prepare(
      `SELECT j.*, r.id AS last_run_id, r.status AS last_status, r.started_at AS last_started_at,
              s.filename AS script_filename
         FROM jobs j
         LEFT JOIN runs r ON r.id = (SELECT MAX(id) FROM runs WHERE job_id = j.id)
         LEFT JOIN scripts s ON s.id = j.script_id
        ORDER BY j.id DESC`
    )
    .all()
    .map((job) => ({
      ...job,
      running: isJobRunning(job.id),
      next_run: getNextRun(job.id),
      schedule_text: schedule.describe(job.cron_schedule),
    }));
  res.render('jobs/index', { jobs, notice: req.query.notice || null });
});

function allSecrets(db) {
  return db.prepare('SELECT id, name FROM secrets ORDER BY name').all();
}

function allScripts(db) {
  return db.prepare('SELECT id, filename, language, description FROM scripts ORDER BY filename').all();
}

function renderForm(res, view, { job, linkedIds, errors = [], status = 200 }) {
  const db = getDb();
  res.status(status).render(view, { job, secrets: allSecrets(db), scripts: allScripts(db), linkedIds, errors });
}

// New job form. Accepts ?script_id=&args=&secret_ids= to prefill from the script editor.
router.get('/new', (req, res) => {
  const db = getDb();
  const script = req.query.script_id ? db.prepare('SELECT * FROM scripts WHERE id = ?').get(Number(req.query.script_id)) : null;
  const ids = [].concat(req.query.secret_ids || []).map(Number).filter(Number.isInteger);
  const job = {
    name: script ? script.filename.replace(/\.(py|sh)$/, '').replace(/[_-]+/g, ' ') : '',
    run_type: script || (allScripts(db).length && !req.query.command) ? 'script' : 'command',
    script_id: script ? script.id : null,
    args: String(req.query.args || ''),
    command: '',
    working_dir: '',
    enabled: 1,
    timeout_sec: 300,
    schedule: schedule.defaultFields(),
  };
  renderForm(res, 'jobs/new', { job, linkedIds: new Set(ids) });
});

// Create a job.
router.post('/', (req, res) => {
  const db = getDb();
  const { values, errors } = validateJob(req.body);
  if (errors.length) {
    return renderForm(res, 'jobs/new', { job: values, linkedIds: new Set(values.secret_ids), errors, status: 400 });
  }
  const info = db
    .prepare(
      `INSERT INTO jobs (name, command, working_dir, cron_schedule, enabled, timeout_sec, script_id, args)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      values.name,
      values.command,
      values.working_dir,
      values.cron_schedule,
      values.enabled,
      values.timeout_sec,
      values.script_id,
      values.args
    );
  const jobId = Number(info.lastInsertRowid);

  linkSecrets(db, jobId, values.secret_ids);
  scheduleJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId));
  res.redirect('/jobs');
});

// Live preview for the schedule builder: { cron, description, next: [IST strings], error }.
router.get('/schedule-preview', (req, res) => {
  const built = schedule.buildFromForm(req.query);
  if (built.error) return res.json({ error: built.error });
  res.json({
    cron: built.cron,
    description: schedule.describe(built.cron),
    next: schedule.nextRuns(built.cron, 3).map((d) => `${formatTime(d)} (${relativeTime(d)})`),
  });
});

// Edit form.
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).send('Job not found');
  const linked = db.prepare('SELECT secret_id AS id FROM job_secrets WHERE job_id = ?').all(job.id);
  const linkedIds = new Set(linked.map((r) => r.id));
  job.schedule = schedule.parseToFields(job.cron_schedule);
  job.run_type = job.script_id ? 'script' : 'command';
  renderForm(res, 'jobs/edit', { job, linkedIds });
});

// Update a job.
router.post('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).send('Job not found');

  const { values, errors } = validateJob(req.body);
  if (errors.length) {
    return renderForm(res, 'jobs/edit', {
      job: { ...values, id: existing.id },
      linkedIds: new Set(values.secret_ids),
      errors,
      status: 400,
    });
  }

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE jobs
          SET name = ?, command = ?, working_dir = ?, cron_schedule = ?,
              enabled = ?, timeout_sec = ?, script_id = ?, args = ?
        WHERE id = ?`
    ).run(
      values.name,
      values.command,
      values.working_dir,
      values.cron_schedule,
      values.enabled,
      values.timeout_sec,
      values.script_id,
      values.args,
      existing.id
    );
    db.prepare('DELETE FROM job_secrets WHERE job_id = ?').run(existing.id);
    linkSecrets(db, existing.id, values.secret_ids);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  scheduleJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(existing.id));
  res.redirect('/jobs');
});

// Manually trigger a job.
router.post('/:id/run', (req, res) => {
  try {
    const { runId } = runJobNow(Number(req.params.id));
    res.redirect(`/runs/${runId}`);
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') {
      return res.redirect(`/jobs?notice=${encodeURIComponent(err.message)}`);
    }
    if (/not found/.test(err.message)) return res.status(404).send('Job not found');
    throw err;
  }
});

// Delete a job.
router.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  if (isJobRunning(id)) {
    return res.redirect(`/jobs?notice=${encodeURIComponent('Cancel the running job before deleting it.')}`);
  }
  unscheduleJob(id);
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id);
  res.redirect('/jobs');
});

function linkSecrets(db, jobId, secretIds) {
  const link = db.prepare(
    'INSERT OR IGNORE INTO job_secrets (job_id, secret_id) SELECT ?, id FROM secrets WHERE id = ?'
  );
  for (const id of secretIds) link.run(jobId, id);
}

module.exports = router;
