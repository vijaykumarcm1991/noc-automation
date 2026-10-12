'use strict';

const express = require('express');
const {
  verifyCredentials,
  issueCsrfToken,
  csrfProtection,
  loginRetryAfterSec,
  recordFailedLogin,
  clearFailedLogins,
} = require('../auth');

const router = express.Router();

// Login form. If already authenticated, go straight to the dashboard.
router.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.render('auth/login', { error: null });
});

// Verify credentials and start an authenticated session.
router.post('/login', (req, res, next) => {
  const { username, password } = req.body || {};
  const key = req.ip;

  const retryAfter = loginRetryAfterSec(key);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).render('auth/login', {
      error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
  }

  if (!verifyCredentials(username, password)) {
    recordFailedLogin(key);
    return res.status(401).render('auth/login', { error: 'Invalid username or password.' });
  }

  clearFailedLogins(key);
  // New session id on login to prevent session fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.authenticated = true;
    issueCsrfToken(req);
    req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/')));
  });
});

// End the session.
router.post(
  '/logout',
  (req, res, next) => (req.session && req.session.authenticated ? next() : res.redirect('/login')),
  csrfProtection,
  (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('noc.sid');
      res.redirect('/login');
    });
  }
);

module.exports = router;
