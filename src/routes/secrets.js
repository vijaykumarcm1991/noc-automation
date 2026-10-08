'use strict';

const express = require('express');
const { getDb } = require('../db');
const { encrypt } = require('../vault');

const router = express.Router();

// List all secrets (names only, never values).
router.get('/', (req, res) => {
  const secrets = getDb()
    .prepare('SELECT id, name, created_at, updated_at FROM secrets ORDER BY name')
    .all();
  res.render('secrets/index', { secrets });
});

// New secret form.
router.get('/new', (req, res) => {
  res.render('secrets/new');
});

// Create a secret (value encrypted before hitting disk).
router.post('/', (req, res) => {
  const { name, value } = req.body;
  if (!name || !value) {
    return res.status(400).send('Name and value are required.');
  }
  const enc = encrypt(value);
  try {
    getDb().prepare('INSERT INTO secrets (name, encrypted_value) VALUES (?, ?)').run(name, enc);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).send(`A secret named "${name}" already exists.`);
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

// Edit secret form (change its value; name stays fixed).
router.get('/:id/edit', (req, res) => {
  const secret = getDb()
    .prepare('SELECT id, name, updated_at FROM secrets WHERE id = ?')
    .get(req.params.id);
  if (!secret) return res.status(404).send('Secret not found');
  res.render('secrets/edit', { secret });
});

// Update a secret's value (re-encrypted before hitting disk).
router.post('/:id/edit', (req, res) => {
  const { value } = req.body;
  if (!value) {
    return res.status(400).send('Value is required.');
  }
  const enc = encrypt(value);
  getDb()
    .prepare("UPDATE secrets SET encrypted_value = ?, updated_at = datetime('now') WHERE id = ?")
    .run(enc, req.params.id);
  res.redirect('/secrets');
});

module.exports = router;
