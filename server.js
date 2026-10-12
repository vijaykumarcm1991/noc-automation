'use strict';

require('dotenv').config({ quiet: true });
// Run the whole process (logs, child jobs) in the app's time zone (IST by default).
const { APP_TZ, zoneLabel } = require('./src/time');
process.env.TZ = APP_TZ;
const path = require('path');
const { initDb, markInterruptedRuns, pruneRuns } = require('./src/db');
const { setMasterKey } = require('./src/vault');
const { rescheduleAll, cancelAll, unscheduleAll } = require('./src/scheduler');
const { createApp } = require('./src/app');

const PORT = process.env.APP_PORT || 3000;
const HOST = process.env.APP_HOST || undefined;
const DB_PATH = process.env.DB_PATH || './data/automation.db';
const RUN_RETENTION_DAYS = Number(process.env.RUN_RETENTION_DAYS || 0);

// Initialize master key for the vault.
setMasterKey(process.env.MASTER_KEY);

// Initialize the database, close out runs a previous process left behind,
// and (re)register scheduled jobs.
initDb(path.resolve(process.cwd(), DB_PATH));
const interrupted = markInterruptedRuns();
if (interrupted) console.log(`[startup] marked ${interrupted} unfinished run(s) as interrupted`);
rescheduleAll();

// Optional run-history retention: prune at startup and once a day.
if (RUN_RETENTION_DAYS > 0) {
  const prune = () => {
    const n = pruneRuns(RUN_RETENTION_DAYS);
    if (n) console.log(`[retention] deleted ${n} run(s) older than ${RUN_RETENTION_DAYS} days`);
  };
  prune();
  setInterval(prune, 24 * 60 * 60 * 1000).unref();
}

const server = createApp().listen(PORT, HOST, () => {
  console.log(`Automation tool running at http://${HOST || 'localhost'}:${PORT} (times in ${zoneLabel()}, ${APP_TZ})`);
});

// On shutdown, kill running jobs so they don't outlive the server as orphans.
function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, stopping running jobs`);
  unscheduleAll();
  cancelAll();
  server.close();
  // Give cancelled runs a moment to record their final status.
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
