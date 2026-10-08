'use strict';

const express = require('express');
const { verifyCredentials } = require('../auth');

const router = express.Router();

// Login form. If already authenticated, go straight to the dashboard.
router.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.render('auth/login', { error: null });
});

// Verify credentials and start an authenticated session.
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (verifyCredentials(username, password)) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.status(401).render('auth/login', { error: 'Invalid username or password.' });
});

// End the session.
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
