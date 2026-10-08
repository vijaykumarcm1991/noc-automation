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
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

module.exports = { initDb, getDb };
