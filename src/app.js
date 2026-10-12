'use strict';

const path = require('path');
const express = require('express');
const { getDb } = require('./db');
const { initAuth, requireAuth, csrfProtection } = require('./auth');
const { getNextRun, isJobRunning } = require('./scheduler');
const time = require('./time');
const { icon, statusBadge } = require('./ui');
const { describe: describeSchedule } = require('./schedule');

const ROOT = path.join(__dirname, '..');

// Builds the Express app. Expects the DB and vault master key to be initialized.
function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(ROOT, 'public')));

  // Set up the authenticated session store before any routes.
  initAuth(app);

  // Navigation context and formatting helpers for templates.
  app.use((req, res, next) => {
    const section = req.path.split('/')[1];
    res.locals.active = ['jobs', 'secrets', 'runs'].includes(section) ? section : section === '' ? 'dashboard' : '';
    res.locals.fmtTime = time.formatTime;
    res.locals.fmtClock = time.formatClock;
    res.locals.fromNow = time.relativeTime;
    res.locals.duration = time.formatDuration;
    res.locals.tz = time.zoneLabel();
    res.locals.appTz = time.APP_TZ;
    res.locals.icon = icon;
    res.locals.statusBadge = statusBadge;
    res.locals.describeSchedule = describeSchedule;
    res.locals.adminUser = process.env.ADMIN_USERNAME || 'admin';
    res.locals.authed = !!(req.session && req.session.authenticated);
    res.locals.csrfToken = (req.session && req.session.csrfToken) || '';
    next();
  });

  // Public routes: login and logout.
  app.use('/', require('./routes/auth'));

  // Everything below requires an authenticated admin session and a valid CSRF token on writes.
  app.use(requireAuth);
  app.use(csrfProtection);

  app.use('/jobs', require('./routes/jobs'));
  app.use('/secrets', require('./routes/secrets'));
  app.use('/runs', require('./routes/runs'));

  app.get('/', (req, res) => {
    const db = getDb();
    const count = (sql) => db.prepare(sql).get().n;
    res.render('dashboard', {
      jobCount: count('SELECT COUNT(*) AS n FROM jobs'),
      secretCount: count('SELECT COUNT(*) AS n FROM secrets'),
      runCount: count('SELECT COUNT(*) AS n FROM runs'),
      runningCount: count("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'"),
      failedCount: count(
        "SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('success', 'running') AND started_at >= datetime('now', '-1 day')"
      ),
      recentRuns: db
        .prepare(
          `SELECT r.id, r.status, r.started_at, r.finished_at, j.name AS job_name
             FROM runs r JOIN jobs j ON j.id = r.job_id
            ORDER BY r.id DESC LIMIT 8`
        )
        .all(),
      upcoming: db
        .prepare("SELECT id, name, cron_schedule FROM jobs WHERE enabled = 1 AND cron_schedule IS NOT NULL")
        .all()
        .map((job) => ({ ...job, next_run: getNextRun(job.id), running: isJobRunning(job.id) }))
        .filter((job) => job.next_run)
        .sort((a, b) => a.next_run - b.next_run)
        .slice(0, 6),
      successRate: (() => {
        const row = db
          .prepare(
            `SELECT SUM(status = 'success') AS ok, COUNT(*) AS n FROM runs
              WHERE status != 'running' AND started_at >= datetime('now', '-7 days')`
          )
          .get();
        return row.n ? Math.round((row.ok / row.n) * 100) : null;
      })(),
    });
  });

  app.use((req, res) => res.status(404).send('Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[app] ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    res.status(err.status || 500).send('Something went wrong. Check the server log for details.');
  });

  return app;
}

module.exports = { createApp };
