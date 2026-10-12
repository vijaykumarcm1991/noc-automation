'use strict';

const express = require('express');
const { getDb } = require('../db');
const { cancelRun } = require('../scheduler');

const router = express.Router();

// Run history for all jobs, optionally filtered by ?job=<id> and/or ?status=<status>
// (status 'problems' matches every finished run that did not succeed).
router.get('/', (req, res) => {
  const db = getDb();
  const jobFilter = Number(req.query.job) || null;
  const statusFilter = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;

  const where = [];
  const params = [];
  if (jobFilter) {
    where.push('r.job_id = ?');
    params.push(jobFilter);
  }
  if (statusFilter === 'problems') {
    where.push("r.status NOT IN ('success', 'running')");
  } else if (statusFilter) {
    where.push('r.status = ?');
    params.push(statusFilter);
  }

  const runs = db
    .prepare(
      `SELECT r.id, r.job_id, r.status, r.started_at, r.finished_at, r.exit_code, j.name AS job_name
         FROM runs r
         JOIN jobs j ON j.id = r.job_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.id DESC
        LIMIT 200`
    )
    .all(...params);
  const jobs = db.prepare('SELECT id, name FROM jobs ORDER BY name').all();
  res.render('runs/index', { runs, jobs, jobFilter, statusFilter });
});

// Individual run detail (full output log).
router.get('/:id', (req, res) => {
  const run = getDb()
    .prepare(
      `SELECT r.*, j.name AS job_name
         FROM runs r
         JOIN jobs j ON j.id = r.job_id
        WHERE r.id = ?`
    )
    .get(req.params.id);
  if (!run) return res.status(404).send('Run not found');
  res.render('runs/show', { run });
});

// Cancel an in-progress run.
router.post('/:id/cancel', (req, res) => {
  cancelRun(Number(req.params.id));
  res.redirect(`/runs/${Number(req.params.id)}`);
});

module.exports = router;
