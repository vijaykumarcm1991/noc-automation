'use strict';

// Python packages for scripts, installed into a managed virtualenv.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const { getDb, audit } = require('../db');
const scripts = require('../scripts');
const { startTask, getTask } = require('../tasks');

const router = express.Router();
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_REQUIREMENTS_BYTES = 64 * 1024;
let activeTaskId = null; // one pip/venv operation at a time

function requirementsPath() {
  return path.join(scripts.scriptsDir(), 'requirements.txt');
}

function readRequirements() {
  try {
    return fs.readFileSync(requirementsPath(), 'utf8');
  } catch {
    return '';
  }
}

function busy() {
  const task = activeTaskId && getTask(activeTaskId);
  return task && task.status === 'running' ? task : null;
}

function run(res, { label, command, action, target }) {
  const running = busy();
  if (running) return res.status(409).json({ error: `Another package operation is running (${running.label}).`, taskId: running.id });
  audit(action, target);
  activeTaskId = startTask({ kind: 'packages', label, command, cwd: scripts.scriptsDir(), timeoutSec: 1800 });
  res.json({ taskId: activeTaskId });
}

function exec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20_000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

router.get('/', async (req, res) => {
  const venvExists = fs.existsSync(scripts.venvPython());
  let pythonVersion = null;
  let installed = [];
  let listError = null;
  if (venvExists) {
    const v = await exec(scripts.venvPython(), ['--version']);
    pythonVersion = (v.stdout || v.stderr).trim();
    const list = await exec(scripts.venvPython(), ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check']);
    try {
      installed = JSON.parse(list.stdout);
    } catch {
      listError = (list.stderr || (list.err && list.err.message) || 'Could not list packages.').trim();
    }
  }
  const sys = await exec(process.env.PYTHON_BIN || 'python3', ['--version']);
  res.render('packages/index', {
    venvExists,
    venvDir: scripts.venvDir(),
    pythonVersion,
    systemPython: (sys.stdout || sys.stderr || '').trim() || 'not found',
    installed,
    listError,
    requirements: readRequirements(),
    requirementsPath: requirementsPath(),
    activeTask: busy(),
    activity: getDb()
      .prepare("SELECT * FROM audit_log WHERE action LIKE 'packages.%' ORDER BY id DESC LIMIT 8")
      .all(),
  });
});

// Create the virtualenv (and upgrade pip inside it).
router.post('/venv', (req, res) => {
  const dir = scripts.venvDir();
  const base = process.env.PYTHON_BIN || 'python3';
  run(res, {
    label: 'Create virtualenv',
    action: 'packages.create_venv',
    target: dir,
    command: `${scripts.shQuote(base)} -m venv ${scripts.shQuote(dir)} && ${scripts.shQuote(path.join(dir, 'bin', 'python'))} -m pip install --upgrade pip`,
  });
});

// Save requirements.txt (JSON).
router.post('/requirements', (req, res) => {
  const content = String((req.body && req.body.content) ?? '');
  if (Buffer.byteLength(content) > MAX_REQUIREMENTS_BYTES) return res.status(400).json({ error: 'requirements.txt is too large.' });
  fs.mkdirSync(scripts.scriptsDir(), { recursive: true });
  fs.writeFileSync(requirementsPath(), content.endsWith('\n') || !content ? content : content + '\n');
  audit('packages.save_requirements', 'requirements.txt');
  res.json({ ok: true });
});

// pip install -r requirements.txt
router.post('/install', (req, res) => {
  if (!fs.existsSync(scripts.venvPython())) return res.status(400).json({ error: 'Create the virtualenv first.' });
  if (!readRequirements().trim()) return res.status(400).json({ error: 'requirements.txt is empty.' });
  run(res, {
    label: 'Install requirements',
    action: 'packages.install',
    target: 'requirements.txt',
    command: `${scripts.shQuote(scripts.venvPython())} -m pip install --disable-pip-version-check -r ${scripts.shQuote(requirementsPath())}`,
  });
});

router.post('/uninstall', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!PACKAGE_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid package name.' });
  if (!fs.existsSync(scripts.venvPython())) return res.status(400).json({ error: 'No virtualenv.' });
  run(res, {
    label: `Uninstall ${name}`,
    action: 'packages.uninstall',
    target: name,
    command: `${scripts.shQuote(scripts.venvPython())} -m pip uninstall -y ${scripts.shQuote(name)}`,
  });
});

module.exports = router;
