'use strict';

// Script library: the live copy of each script is a file in SCRIPTS_DIR (so it
// can still be edited or backed up outside the tool); every save is also kept
// in script_versions for history and restore.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getDb, audit } = require('./db');

const ROOT = path.join(__dirname, '..');
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.(py|sh)$/;
const MAX_SCRIPT_BYTES = 512 * 1024;

function scriptsDir() {
  return path.resolve(ROOT, process.env.SCRIPTS_DIR || 'scripts');
}

function venvDir() {
  return path.resolve(ROOT, process.env.VENV_DIR || 'data/venv');
}

function venvPython() {
  return path.join(venvDir(), 'bin', 'python');
}

// Python used for scripts: the managed virtualenv if it exists, else PYTHON_BIN/python3.
function pythonBin() {
  return fs.existsSync(venvPython()) ? venvPython() : process.env.PYTHON_BIN || 'python3';
}

function languageOf(filename) {
  return filename.endsWith('.sh') ? 'bash' : 'python';
}

function validateFilename(filename) {
  const value = String(filename || '').trim();
  if (!value) return { value, error: 'File name is required.' };
  if (!FILENAME_RE.test(value) || value.includes('..')) {
    return {
      value,
      error: 'Use a file name like report.py or check_disk.sh: letters, digits, dot, dash and underscore, ending in .py or .sh.',
    };
  }
  return { value, error: null };
}

function filePath(script) {
  const full = path.join(scriptsDir(), script.filename);
  // Belt and braces: never touch anything outside the scripts folder.
  if (path.dirname(full) !== scriptsDir()) throw new Error('Invalid script path');
  return full;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Shell command that runs a script with optional extra arguments.
// `fullPath` overrides the file (used for test runs of unsaved content).
function buildCommand(script, args, fullPath = filePath(script)) {
  const interp = script.language === 'bash' ? 'bash' : shQuote(pythonBin());
  const extra = String(args || '').trim();
  return `${interp} ${shQuote(fullPath)}${extra ? ' ' + extra : ''}`;
}

// Short human-readable form for job lists: "python3 jsm_daily.py --flag".
function displayCommand(script, args) {
  const extra = String(args || '').trim();
  return `${script.language === 'bash' ? 'bash' : 'python3'} ${script.filename}${extra ? ' ' + extra : ''}`;
}

function writeFileAtomic(full, content) {
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, content, { mode: 0o755 });
  fs.renameSync(tmp, full);
}

function readFile(script) {
  try {
    return fs.readFileSync(filePath(script), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// --- Queries -------------------------------------------------------------------

function listScripts() {
  return getDb()
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM jobs j WHERE j.script_id = s.id) AS job_count,
              (SELECT COUNT(*) FROM script_versions v WHERE v.script_id = s.id) AS version_count,
              (SELECT t.status FROM script_tests t WHERE t.script_id = s.id ORDER BY t.id DESC LIMIT 1) AS last_test_status,
              (SELECT t.started_at FROM script_tests t WHERE t.script_id = s.id ORDER BY t.id DESC LIMIT 1) AS last_test_at
         FROM scripts s
        ORDER BY s.filename`
    )
    .all();
}

function getScript(id) {
  return getDb().prepare('SELECT * FROM scripts WHERE id = ?').get(id) || null;
}

function listVersions(scriptId) {
  // Oldest first gets v1; returned newest first.
  const rows = getDb()
    .prepare('SELECT id, note, created_at, length(content) AS size FROM script_versions WHERE script_id = ? ORDER BY id')
    .all(scriptId);
  return rows.map((r, i) => ({ ...r, number: i + 1 })).reverse();
}

function getVersion(scriptId, versionId) {
  const v = getDb()
    .prepare('SELECT * FROM script_versions WHERE script_id = ? AND id = ?')
    .get(scriptId, versionId);
  if (!v) return null;
  v.number = getDb()
    .prepare('SELECT COUNT(*) AS n FROM script_versions WHERE script_id = ? AND id <= ?')
    .get(scriptId, versionId).n;
  return v;
}

function latestVersion(scriptId) {
  return getDb().prepare('SELECT * FROM script_versions WHERE script_id = ? ORDER BY id DESC LIMIT 1').get(scriptId) || null;
}

function previousVersion(scriptId, versionId) {
  return (
    getDb()
      .prepare('SELECT * FROM script_versions WHERE script_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
      .get(scriptId, versionId) || null
  );
}

function jobsUsing(scriptId) {
  return getDb().prepare('SELECT id, name, cron_schedule, enabled FROM jobs WHERE script_id = ? ORDER BY name').all(scriptId);
}

function recentTests(scriptId, limit = 8) {
  return getDb()
    .prepare('SELECT id, status, args, started_at, finished_at, exit_code FROM script_tests WHERE script_id = ? ORDER BY id DESC LIMIT ?')
    .all(scriptId, limit);
}

function recentActivity(limit = 12) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

// --- Syntax check ----------------------------------------------------------------

// Resolves { ok, error, line } without running the script.
function syntaxCheck(language, content) {
  return new Promise((resolve) => {
    const [cmd, args] =
      language === 'bash'
        ? ['bash', ['-n']]
        : [pythonBin(), ['-c', "import sys; compile(sys.stdin.read(), 'script', 'exec')"]];
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: true, skipped: err.message });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      // Interpreter missing: don't block saving, just report it.
      resolve({ ok: true, skipped: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      const text = out.trim();
      let line = null;
      let error = text;
      if (language === 'bash') {
        const m = /line (\d+): (.*)/.exec(text);
        if (m) {
          line = Number(m[1]);
          error = `Line ${m[1]}: ${m[2]}`;
        }
      } else {
        const lm = /File "script", line (\d+)/.exec(text);
        const em = text.split('\n').filter(Boolean).pop() || text;
        if (lm) line = Number(lm[1]);
        error = line ? `Line ${line}: ${em}` : em;
      }
      resolve({ ok: false, error, line });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(content);
  });
}

// --- Mutations -------------------------------------------------------------------

function addVersion(scriptId, content, note) {
  getDb().prepare('INSERT INTO script_versions (script_id, content, note) VALUES (?, ?, ?)').run(scriptId, content, note);
  getDb().prepare("UPDATE scripts SET updated_at = datetime('now') WHERE id = ?").run(scriptId);
}

function template(language, filename) {
  if (language === 'bash') {
    return `#!/usr/bin/env bash
# ${filename}
set -euo pipefail

# Secrets linked to the job (or ticked in the test panel) are environment
# variables, e.g. "$API_KEY". Arguments are available as "$@".

echo "Hello from ${filename} at $(date '+%Y-%m-%d %H:%M:%S %Z')"
`;
  }
  return `#!/usr/bin/env python3
"""${filename}"""
import os
import sys
from datetime import datetime


def main(args):
    # Secrets linked to the job (or ticked in the test panel) are environment
    # variables, e.g.: api_key = os.environ["API_KEY"]
    print(f"Hello from ${filename} at {datetime.now():%Y-%m-%d %H:%M:%S}")
    print(f"Arguments: {args}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;
}

// Create a new script file. Returns { script } or { error }.
function createScript({ filename, description }) {
  const { value, error } = validateFilename(filename);
  if (error) return { error };
  const db = getDb();
  if (db.prepare('SELECT id FROM scripts WHERE filename = ?').get(value)) {
    return { error: `A script named "${value}" already exists.` };
  }
  fs.mkdirSync(scriptsDir(), { recursive: true });
  const language = languageOf(value);
  const content = template(language, value);
  try {
    fs.writeFileSync(path.join(scriptsDir(), value), content, { flag: 'wx', mode: 0o755 });
  } catch (err) {
    if (err.code === 'EEXIST') return { error: `A file named "${value}" already exists in the scripts folder.` };
    throw err;
  }
  const id = Number(
    db
      .prepare('INSERT INTO scripts (filename, language, description) VALUES (?, ?, ?)')
      .run(value, language, String(description || '').trim() || null).lastInsertRowid
  );
  addVersion(id, content, 'Created from template');
  audit('script.create', value);
  return { script: getScript(id) };
}

// Save new content. Resolves { ok } / { unchanged } / { error, line }.
async function saveScript(id, content, { note, skipSyntaxCheck = false } = {}) {
  const script = getScript(id);
  if (!script) return { error: 'Script not found.' };
  const text = String(content ?? '');
  if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) {
    return { error: `Script is too large (limit ${MAX_SCRIPT_BYTES / 1024} KB).` };
  }
  if (!skipSyntaxCheck) {
    const check = await syntaxCheck(script.language, text);
    if (!check.ok) return { error: check.error, line: check.line };
  }
  const latest = latestVersion(id);
  const onDisk = readFile(script);
  if (latest && latest.content === text && onDisk === text) return { unchanged: true };

  writeFileAtomic(filePath(script), text);
  addVersion(id, text, note || null);
  audit('script.save', script.filename, note || null);
  return { ok: true };
}

async function restoreVersion(id, versionId) {
  const version = getVersion(id, versionId);
  if (!version) return { error: 'Version not found.' };
  return saveScript(id, version.content, { note: `Restored version ${version.number}`, skipSyntaxCheck: true });
}

function updateDescription(id, description) {
  getDb()
    .prepare('UPDATE scripts SET description = ? WHERE id = ?')
    .run(String(description || '').trim() || null, id);
}

// Delete a script and its file. Refused while jobs still use it.
function deleteScript(id) {
  const script = getScript(id);
  if (!script) return { error: 'Script not found.' };
  const jobs = jobsUsing(id);
  if (jobs.length) {
    return { error: `This script is used by ${jobs.length} job(s): ${jobs.map((j) => j.name).join(', ')}. Change or delete those jobs first.` };
  }
  try {
    fs.unlinkSync(filePath(script));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  getDb().prepare('DELETE FROM scripts WHERE id = ?').run(id);
  audit('script.delete', script.filename);
  return { ok: true };
}

// Reconcile one script with its file: record edits made outside the tool, and
// recreate the file from the latest version if it was removed.
function syncFromDisk(script) {
  const onDisk = readFile(script);
  const latest = latestVersion(script.id);
  if (onDisk === null) {
    if (latest) {
      fs.mkdirSync(scriptsDir(), { recursive: true });
      writeFileAtomic(filePath(script), latest.content);
      audit('script.restore_file', script.filename, 'File was missing; recreated from the latest version');
    }
    return;
  }
  if (!latest || latest.content !== onDisk) {
    addVersion(script.id, onDisk, latest ? 'Changed outside the tool' : 'Imported from disk');
    audit('script.external_change', script.filename);
  }
}

// Import .py/.sh files in SCRIPTS_DIR that aren't in the library yet, and sync the rest.
function importExisting() {
  const dir = scriptsDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = getDb();
  let imported = 0;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!FILENAME_RE.test(name) || !fs.statSync(path.join(dir, name)).isFile()) continue;
    if (db.prepare('SELECT id FROM scripts WHERE filename = ?').get(name)) continue;
    const id = Number(
      db.prepare('INSERT INTO scripts (filename, language) VALUES (?, ?)').run(name, languageOf(name)).lastInsertRowid
    );
    addVersion(id, fs.readFileSync(path.join(dir, name), 'utf8'), 'Imported from disk');
    audit('script.import', name);
    imported++;
  }
  for (const script of db.prepare('SELECT * FROM scripts').all()) syncFromDisk(script);
  return imported;
}

// Write unsaved editor content to a hidden temp file next to the script (so
// relative imports still work) for a test run. Returns its path.
function writeTempCopy(script, content) {
  const tmp = path.join(scriptsDir(), `.~test-${crypto.randomBytes(4).toString('hex')}-${script.filename}`);
  fs.writeFileSync(tmp, String(content ?? ''), { mode: 0o700 });
  return tmp;
}

module.exports = {
  FILENAME_RE,
  MAX_SCRIPT_BYTES,
  scriptsDir,
  venvDir,
  venvPython,
  pythonBin,
  languageOf,
  validateFilename,
  filePath,
  shQuote,
  buildCommand,
  displayCommand,
  readFile,
  listScripts,
  getScript,
  listVersions,
  getVersion,
  latestVersion,
  previousVersion,
  jobsUsing,
  recentTests,
  recentActivity,
  syntaxCheck,
  template,
  createScript,
  saveScript,
  restoreVersion,
  updateDescription,
  deleteScript,
  syncFromDisk,
  importExisting,
  writeTempCopy,
};
