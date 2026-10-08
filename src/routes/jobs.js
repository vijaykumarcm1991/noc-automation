'use strict';

const express = require('express');
const { getDb } = require('../db');
const { scheduleJob, unscheduleJob, runJobNow } = require('../scheduler');

const router = express.Router();

// List all jobs.
router.get('/', (req, res) => {
  const jobs = getDb().prepare('SELECT * FROM jobs ORDER BY id DESC').all();
  res.render('jobs/index', { jobs });
});

// New job form.
router.get('/new', (req, res) => {
  const secrets = getDb().prepare('SELECT id, name FROM secrets ORDER BY name').all();
  res.render('jobs/new', { secrets });
});

// Create a job.
router.post('/', (req, res) => {
  const { name, command, working_dir, cron_schedule, enabled, timeout_sec, secret_ids } = req.body;
  if (!name || !command) {
    return res.status(400).send('Name and command are required.');
  }
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO jobs (name, command, working_dir, cron_schedule, enabled, timeout_sec)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = insert.run(
    name,
    command,
    working_dir || null,
    cron_schedule || null,
    enabled ? 1 : 0,
    Number(timeout_sec) || 300
  );
  const jobId = info.lastInsertRowid;

  linkSecrets(db, jobId, secret_ids);
  scheduleJob(getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId));
  res.redirect('/jobs');
});

// Edit form.
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).send('Job not found');
  const secrets = db.prepare('SELECT id, name FROM secrets ORDER BY name').all();
  const linked = db.prepare('SELECT secret_id AS id FROM job_secrets WHERE job_id = ?').all(job.id);
  const linkedIds = new Set(linked.map((r) => r.id));
  res.render('jobs/edit', { job, secrets, linkedIds });
});

// Update a job.
router.post('/:id', (req, res) => {
  const db = getDb();
  const { name, command, working_dir, cron_schedule, enabled, timeout_sec, secret_ids } = req.body;
  db.prepare(
    `UPDATE jobs
        SET name = ?, command = ?, working_dir = ?, cron_schedule = ?,
            enabled = ?, timeout_sec = ?
      WHERE id = ?`
  ).run(
    name,
    command,
    working_dir || null,
    cron_schedule || null,
    enabled ? 1 : 0,
    Number(timeout_sec) || 300,
    req.params.id
  );
  db.prepare('DELETE FROM job_secrets WHERE job_id = ?').run(req.params.id);
  linkSecrets(db, req.params.id, secret_ids);
  scheduleJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id));
  res.redirect('/jobs');
});

// Manually trigger a job.
router.post('/:id/run', (req, res) => {
  runJobNow(Number(req.params.id));
  res.redirect('/jobs');
});

// Delete a job.
router.post('/:id/delete', (req, res) => {
  unscheduleJob(Number(req.params.id));
  getDb().prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.redirect('/jobs');
});

function linkSecrets(db, jobId, secretIds) {
  const link = db.prepare('INSERT OR IGNORE INTO job_secrets (job_id, secret_id) VALUES (?, ?)');
  const ids = Array.isArray(secretIds) ? secretIds : secretIds ? [secretIds] : [];
  for (const id of ids) link.run(jobId, Number(id));
}

module.exports = router;
