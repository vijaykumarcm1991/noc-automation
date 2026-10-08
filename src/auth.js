'use strict';

const crypto = require('crypto');
const session = require('express-session');

function initAuth(app) {
  const secret = process.env.SESSION_SECRET || process.env.MASTER_KEY;
  app.use(
    session({
      secret,
      resave: false,
      saveUninitialized: false,
      name: 'noc.sid',
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false, // set to true when serving over HTTPS
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
      },
    })
  );
}

function getAdminUser() {
  return {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  };
}

// Constant-time comparison to avoid timing attacks on the admin password.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyCredentials(username, password) {
  const admin = getAdminUser();
  if (!admin.password) return false; // auth not configured yet
  return safeEqual(username, admin.username) && safeEqual(password, admin.password);
}

// Protects a route: requires an authenticated session, otherwise redirects to /login.
function requireAuth(req, res, next) {
  if (!getAdminUser().password) {
    return res
      .status(500)
      .send('Admin password is not configured. Set ADMIN_PASSWORD in .env and restart the server.');
  }
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.redirect('/login');
}

module.exports = { initAuth, getAdminUser, verifyCredentials, requireAuth, safeEqual };
