'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

let db;

function initDb(dbPath) {
  if (db) return db;

  // Ensure the containing directory exists.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      command       TEXT NOT NULL,
      working_dir   TEXT,
      cron_schedule TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      timeout_sec   INTEGER NOT NULL DEFAULT 300,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS secrets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      encrypted_value TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_secrets (
      job_id    INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      secret_id INTEGER NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
      PRIMARY KEY (job_id, secret_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status      TEXT NOT NULL,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      exit_code   INTEGER,
      output      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, id);

    CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      sess    TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);

  return db;
}

// Runs left in 'running' belong to a previous process that died mid-run;
// nothing will ever finish them, so close them out at startup.
function markInterruptedRuns() {
  return getDb()
    .prepare(
      `UPDATE runs
          SET status = 'interrupted', finished_at = datetime('now'),
              output = COALESCE(output, '') || '\n[runner] interrupted: server stopped before the run finished'
        WHERE status = 'running'`
    )
    .run().changes;
}

// Delete runs older than the given number of days (0 or less keeps everything).
function pruneRuns(retentionDays) {
  const days = Number(retentionDays);
  if (!(days > 0)) return 0;
  return getDb()
    .prepare("DELETE FROM runs WHERE status != 'running' AND started_at < datetime('now', ?)")
    .run(`-${days} days`).changes;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

module.exports = { initDb, getDb, markInterruptedRuns, pruneRuns };
