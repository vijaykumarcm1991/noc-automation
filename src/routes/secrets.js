'use strict';

const express = require('express');
const { getDb } = require('../db');
const { encrypt } = require('../vault');
const { validateSecretName } = require('../validate');

const router = express.Router();

// List all secrets (names only, never values) with how many jobs use each.
router.get('/', (req, res) => {
  const secrets = getDb()
    .prepare(
      `SELECT s.id, s.name, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM job_secrets js WHERE js.secret_id = s.id) AS job_count
         FROM secrets s
        ORDER BY s.name`
    )
    .all();
  res.render('secrets/index', { secrets });
});

// New secret form.
router.get('/new', (req, res) => {
  res.render('secrets/new', { name: '', error: null });
});

// Create a secret (value encrypted before hitting disk).
router.post('/', (req, res) => {
  const { value: name, error } = validateSecretName(req.body && req.body.name);
  const value = (req.body && req.body.value) || '';
  if (error || !value) {
    return res.status(400).render('secrets/new', { name, error: error || 'Value is required.' });
  }
  try {
    getDb().prepare('INSERT INTO secrets (name, encrypted_value) VALUES (?, ?)').run(name, encrypt(value));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).render('secrets/new', { name, error: `A secret named "${name}" already exists.` });
    }
    throw err;
  }
  res.redirect('/secrets');
});

// Delete a secret.
router.post('/:id/delete', (req, res) => {
  getDb().prepare('DELETE FROM secrets WHERE id = ?').run(req.params.id);
  res.redirect('/secrets');
});

function findSecret(id) {
  return getDb().prepare('SELECT id, name, updated_at FROM secrets WHERE id = ?').get(id);
}

// Edit secret form (change its value; name stays fixed).
router.get('/:id/edit', (req, res) => {
  const secret = findSecret(req.params.id);
  if (!secret) return res.status(404).send('Secret not found');
  res.render('secrets/edit', { secret, error: null });
});

// Update a secret's value (re-encrypted before hitting disk).
router.post('/:id/edit', (req, res) => {
  const secret = findSecret(req.params.id);
  if (!secret) return res.status(404).send('Secret not found');
  const value = (req.body && req.body.value) || '';
  if (!value) {
    return res.status(400).render('secrets/edit', { secret, error: 'Value is required.' });
  }
  getDb()
    .prepare("UPDATE secrets SET encrypted_value = ?, updated_at = datetime('now') WHERE id = ?")
    .run(encrypt(value), secret.id);
  res.redirect('/secrets');
});

module.exports = router;
