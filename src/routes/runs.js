'use strict';

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// Run history for all jobs.
router.get('/', (req, res) => {
  const runs = getDb()
    .prepare(
      `SELECT r.*, j.name AS job_name
         FROM runs r
         JOIN jobs j ON j.id = r.job_id
        ORDER BY r.id DESC
        LIMIT 200`
    )
    .all();
  res.render('runs/index', { runs });
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

module.exports = router;
