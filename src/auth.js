'use strict';

const crypto = require('crypto');
const session = require('express-session');
const { getDb } = require('./db');

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 8; // 8 hours

// express-session store backed by the app's SQLite database, so sessions
// survive a server restart (the default MemoryStore does not).
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    // Sweep expired sessions hourly; unref so it never keeps the process alive.
    this.sweeper = setInterval(() => this.clearExpired(), 60 * 60 * 1000);
    this.sweeper.unref();
  }

  expiryOf(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + SESSION_MAX_AGE_MS;
  }

  get(sid, cb) {
    try {
      const row = getDb().prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      getDb()
        .prepare(
          `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`
        )
        .run(sid, JSON.stringify(sess), this.expiryOf(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      getDb().prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this.expiryOf(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  clearExpired() {
    try {
      getDb().prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    } catch {
      // DB not available (e.g. during shutdown); try again next sweep.
    }
  }
}

function initAuth(app) {
  const secret = process.env.SESSION_SECRET || process.env.MASTER_KEY;
  app.use(
    session({
      secret,
      store: new SqliteSessionStore(),
      resave: false,
      saveUninitialized: false,
      name: 'noc.sid',
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true', // set COOKIE_SECURE=true when serving over HTTPS
        maxAge: SESSION_MAX_AGE_MS,
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

// --- CSRF ------------------------------------------------------------------
// Synchronizer token stored in the session. Every state-changing form posts it
// back as `_csrf`; templates read it from res.locals.csrfToken.

function issueCsrfToken(req) {
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (req.session && req.session.authenticated && !req.session.csrfToken) {
    issueCsrfToken(req);
  }
  res.locals.csrfToken = (req.session && req.session.csrfToken) || '';

  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  if (res.locals.csrfToken && safeEqual(sent, res.locals.csrfToken)) {
    return next();
  }
  return res.status(403).send('Invalid or missing CSRF token. Reload the page and try again.');
}

// --- Login rate limiting ---------------------------------------------------
// Allow LOGIN_MAX_ATTEMPTS failed logins per client per LOGIN_WINDOW_MS.

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map(); // key -> { count, resetAt }

function loginRetryAfterSec(key, now = Date.now()) {
  const entry = failedLogins.get(key);
  if (!entry || entry.resetAt <= now) {
    failedLogins.delete(key);
    return 0;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS ? Math.ceil((entry.resetAt - now) / 1000) : 0;
}

function recordFailedLogin(key, now = Date.now()) {
  if (failedLogins.size > 10_000) {
    for (const [k, e] of failedLogins) if (e.resetAt <= now) failedLogins.delete(k);
  }
  const entry = failedLogins.get(key);
  if (!entry || entry.resetAt <= now) {
    failedLogins.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailedLogins(key) {
  failedLogins.delete(key);
}

module.exports = {
  initAuth,
  getAdminUser,
  verifyCredentials,
  requireAuth,
  safeEqual,
  issueCsrfToken,
  csrfProtection,
  loginRetryAfterSec,
  recordFailedLogin,
  clearFailedLogins,
  SqliteSessionStore,
  LOGIN_MAX_ATTEMPTS,
};
