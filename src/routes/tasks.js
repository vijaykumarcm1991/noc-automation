'use strict';

const express = require('express');
const { getTask, cancelTask, streamTask } = require('../tasks');

const router = express.Router();

// Live output of a script test or package install (Server-Sent Events).
router.get('/:id/stream', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found or expired.' });
  streamTask(task, req, res);
});

router.post('/:id/cancel', (req, res) => {
  res.json({ cancelled: cancelTask(req.params.id) });
});

module.exports = router;
