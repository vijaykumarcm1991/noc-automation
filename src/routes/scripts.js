'use strict';

const fs = require('fs');
const express = require('express');
const { getDb } = require('../db');
const scripts = require('../scripts');
const { decryptSecrets } = require('../scheduler');
const { startTask } = require('../tasks');
const { diffLines } = require('../diff');

const router = express.Router();
const MAX_TEST_TIMEOUT_SEC = 3600;

function loadScript(req, res) {
  const script = scripts.getScript(req.params.id);
  if (!script) res.status(404).send('Script not found');
  return script;
}

function allSecrets() {
  return getDb().prepare('SELECT id, name FROM secrets ORDER BY name').all();
}

// Library.
router.get('/', (req, res) => {
  res.render('scripts/index', {
    scripts: scripts.listScripts(),
    activity: scripts.recentActivity(10),
    scriptsDir: scripts.scriptsDir(),
    error: null,
    form: { filename: '', description: '' },
  });
});

// Create from template.
router.post('/', (req, res) => {
  const body = req.body || {};
  let filename = String(body.filename || '').trim();
  // Friendly: add the extension from the language picker if it was left off.
  if (filename && !/\.(py|sh)$/.test(filename)) filename += body.language === 'bash' ? '.sh' : '.py';
  const result = scripts.createScript({ filename, description: body.description });
  if (result.error) {
    return res.status(400).render('scripts/index', {
      scripts: scripts.listScripts(),
      activity: scripts.recentActivity(10),
      scriptsDir: scripts.scriptsDir(),
      error: result.error,
      form: { filename, description: body.description || '' },
    });
  }
  res.redirect(`/scripts/${result.script.id}`);
});

// Editor.
router.get('/:id', (req, res) => {
  const script = loadScript(req, res);
  if (!script) return;
  scripts.syncFromDisk(script);
  const latest = scripts.latestVersion(script.id);
  res.render('scripts/edit', {
    script: scripts.getScript(script.id),
    content: scripts.readFile(script) ?? (latest ? latest.content : ''),
    versionCount: scripts.listVersions(script.id).length,
    jobs: scripts.jobsUsing(script.id),
    tests: scripts.recentTests(script.id),
    secrets: allSecrets(),
    pythonBin: scripts.pythonBin(),
    filePath: scripts.filePath(script),
    notice: req.query.notice || null,
  });
});

// Save (JSON). Syntax errors are returned with a line number and nothing is saved.
router.post('/:id/save', async (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });
  const { content, note } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'Missing content.' });
  const result = await scripts.saveScript(script.id, content, { note: String(note || '').trim().slice(0, 200) || null });
  if (result.error) return res.status(422).json(result);
  res.json({ ...result, versionCount: scripts.listVersions(script.id).length });
});

// Syntax check without saving (JSON).
router.post('/:id/check', async (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });
  res.json(await scripts.syntaxCheck(script.language, String((req.body && req.body.content) ?? '')));
});

router.post('/:id/description', (req, res) => {
  const script = loadScript(req, res);
  if (!script) return;
  scripts.updateDescription(script.id, req.body && req.body.description);
  res.redirect(`/scripts/${script.id}`);
});

// Start a test run of the current editor contents (saved or not). Returns { taskId, testId }.
router.post('/:id/test', (req, res) => {
  const script = scripts.getScript(req.params.id);
  if (!script) return res.status(404).json({ error: 'Script not found.' });
  const body = req.body || {};
  const content = typeof body.content === 'string' ? body.content : scripts.readFile(script) || '';
  if (Buffer.byteLength(content) > scripts.MAX_SCRIPT_BYTES) return res.status(400).json({ error: 'Script is too large.' });
  const args = String(body.args || '').trim().slice(0, 1000);
  const timeoutSec = Math.min(Math.max(parseInt(body.timeout_sec, 10) || 300, 1), MAX_TEST_TIMEOUT_SEC);
  const { env, errors } = decryptSecrets(Array.isArray(body.secret_ids) ? body.secret_ids : []);

  const db = getDb();
  const testId = Number(
    db.prepare("INSERT INTO script_tests (script_id, args, status) VALUES (?, ?, 'running')").run(script.id, args || null)
      .lastInsertRowid
  );
  const tmp = scripts.writeTempCopy(script, content);
  const header = `[test] ${scripts.displayCommand(script, args)}${errors.length ? `\n[test] warning: could not decrypt ${errors.join(', ')}` : ''}\n`;

  const taskId = startTask({
    kind: 'script-test',
    label: script.filename,
    command: `printf '%s' ${scripts.shQuote(header)}; exec ${scripts.buildCommand(script, args, tmp)}`,
    cwd: scripts.scriptsDir(),
    env,
    timeoutSec,
    onFinish: (result) => {
      fs.rm(tmp, { force: true }, () => {});
      db.prepare(
        "UPDATE script_tests SET status = ?, finished_at = datetime('now'), exit_code = ?, output = ? WHERE id = ?"
      ).run(result.status, result.exitCode, result.output, testId);
    },
  });
  res.json({ taskId, testId });
});

// A past test run's output.
router.get('/:id/tests/:testId', (req, res) => {
  const script = loadScript(req, res);
  if (!script) return;
  const test = getDb().prepare('SELECT * FROM script_tests WHERE id = ? AND script_id = ?').get(req.params.testId, script.id);
  if (!test) return res.status(404).send('Test run not found');
  res.render('scripts/test', { script, test });
});

// Version history, with a diff of the selected version against the one before it.
router.get('/:id/history', (req, res) => {
  const script = loadScript(req, res);
  if (!script) return;
  scripts.syncFromDisk(script);
  const versions = scripts.listVersions(script.id);
  const selectedId = Number(req.query.v) || (versions[0] && versions[0].id);
  const selected = selectedId ? scripts.getVersion(script.id, selectedId) : null;
  let diff = null;
  let previous = null;
  if (selected) {
    previous = scripts.previousVersion(script.id, selected.id);
    diff = diffLines(previous ? previous.content : '', selected.content);
  }
  res.render('scripts/history', { script, versions, selected, previous, diff, isLatest: versions[0] && selected && versions[0].id === selected.id });
});

router.post('/:id/versions/:versionId/restore', async (req, res) => {
  const script = loadScript(req, res);
  if (!script) return;
  const result = await scripts.restoreVersion(script.id, Number(req.params.versionId));
  if (result.error) return res.status(400).send(result.error);
  res.redirect(`/scripts/${script.id}`);
});

router.post('/:id/delete', (req, res) => {
  const script = loadScript(req, res);
  if (!script) return;
  const result = scripts.deleteScript(script.id);
  if (result.error) {
    return res.redirect(`/scripts/${script.id}?notice=${encodeURIComponent(result.error)}`);
  }
  res.redirect('/scripts');
});

module.exports = router;
