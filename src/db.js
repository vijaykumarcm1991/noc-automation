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

    -- Scripts managed from the UI. The file in SCRIPTS_DIR is the live copy;
    -- every save is also kept in script_versions.
    CREATE TABLE IF NOT EXISTS scripts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      filename    TEXT NOT NULL UNIQUE,
      language    TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS script_versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_versions_script ON script_versions(script_id, id);

    -- Test runs started from the script editor (kept apart from job runs).
    CREATE TABLE IF NOT EXISTS script_tests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id   INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      args        TEXT,
      status      TEXT NOT NULL,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      exit_code   INTEGER,
      output      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tests_script ON script_tests(script_id, id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      TEXT NOT NULL DEFAULT (datetime('now')),
      action  TEXT NOT NULL,
      target  TEXT,
      detail  TEXT
    );
  `);

  // Columns added after the first release.
  addColumn('jobs', 'script_id', 'INTEGER REFERENCES scripts(id)');
  addColumn('jobs', 'args', 'TEXT');

  // A crash mid-test leaves 'running' rows behind too.
  db.exec(
    "UPDATE script_tests SET status = 'interrupted', finished_at = datetime('now') WHERE status = 'running'"
  );

  return db;
}

function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Record an action in the audit log.
function audit(action, target, detail = null) {
  getDb().prepare('INSERT INTO audit_log (action, target, detail) VALUES (?, ?, ?)').run(action, target, detail);
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

module.exports = { initDb, getDb, markInterruptedRuns, pruneRuns, audit };
