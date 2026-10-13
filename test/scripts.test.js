'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noc-scripts-'));
process.env.SCRIPTS_DIR = path.join(tmp, 'scripts');
process.env.VENV_DIR = path.join(tmp, 'venv'); // never created: system python is used

const { initDb, getDb } = require('../src/db');
const vault = require('../src/vault');
const scripts = require('../src/scripts');
const scheduler = require('../src/scheduler');
const tasks = require('../src/tasks');
const { diffLines } = require('../src/diff');

initDb(path.join(tmp, 'test.db'));
vault.setMasterKey(crypto.randomBytes(32).toString('hex'));
const dir = process.env.SCRIPTS_DIR;

test('scripts: file names are validated and cannot escape the scripts folder', () => {
  for (const ok of ['report.py', 'check_disk.sh', 'a-b.c_d.py']) assert.strictEqual(scripts.validateFilename(ok).error, null, ok);
  for (const bad of ['', '../x.py', 'x/y.py', '.hidden.py', 'run.txt', 'a..b.py', 'spa ce.py']) {
    assert.ok(scripts.validateFilename(bad).error, bad);
  }
});

test('scripts: create from template writes the file and version 1', () => {
  const { script, error } = scripts.createScript({ filename: 'hello.py', description: 'demo' });
  assert.ifError(error);
  assert.strictEqual(script.language, 'python');
  const content = fs.readFileSync(path.join(dir, 'hello.py'), 'utf8');
  assert.match(content, /def main/);
  assert.strictEqual(scripts.listVersions(script.id).length, 1);
  assert.match(scripts.createScript({ filename: 'hello.py' }).error, /already exists/);
});

test('scripts: syntax errors block saving and report the line', async () => {
  const script = scripts.createScript({ filename: 'broken.py' }).script;
  const before = fs.readFileSync(path.join(dir, 'broken.py'), 'utf8');
  const result = await scripts.saveScript(script.id, 'print("ok")\ndef f(:\n    pass\n');
  assert.strictEqual(result.line, 2);
  assert.match(result.error, /SyntaxError/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'broken.py'), 'utf8'), before, 'file must be untouched');
  assert.strictEqual(scripts.listVersions(script.id).length, 1);

  const sh = scripts.createScript({ filename: 'broken.sh' }).script;
  const bad = await scripts.saveScript(sh.id, 'echo hi\nif true; then\n  echo x\n');
  assert.ok(bad.error && bad.line, 'bash syntax error detected');
});

test('scripts: saves add versions, unchanged saves do not, restore brings content back', async () => {
  const script = scripts.createScript({ filename: 'ver.py' }).script;
  const v1 = fs.readFileSync(path.join(dir, 'ver.py'), 'utf8');
  assert.deepStrictEqual(await scripts.saveScript(script.id, 'print("two")\n', { note: 'second' }), { ok: true });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ver.py'), 'utf8'), 'print("two")\n');
  assert.deepStrictEqual(await scripts.saveScript(script.id, 'print("two")\n'), { unchanged: true });

  const versions = scripts.listVersions(script.id);
  assert.strictEqual(versions.length, 2);
  assert.strictEqual(versions[0].note, 'second');
  assert.strictEqual(versions[0].number, 2);

  const first = versions[1];
  assert.ok((await scripts.restoreVersion(script.id, first.id)).ok);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ver.py'), 'utf8'), v1);
  assert.strictEqual(scripts.listVersions(script.id)[0].note, 'Restored version 1');
});

test('scripts: edits made outside the tool are recorded; a deleted file is recreated', () => {
  const script = scripts.createScript({ filename: 'ext.sh' }).script;
  fs.writeFileSync(path.join(dir, 'ext.sh'), 'echo edited outside\n');
  scripts.syncFromDisk(script);
  const latest = scripts.latestVersion(script.id);
  assert.strictEqual(latest.content, 'echo edited outside\n');
  assert.strictEqual(latest.note, 'Changed outside the tool');

  fs.unlinkSync(path.join(dir, 'ext.sh'));
  scripts.syncFromDisk(script);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ext.sh'), 'utf8'), 'echo edited outside\n');
});

test('scripts: importExisting picks up new .py/.sh files only', () => {
  fs.writeFileSync(path.join(dir, 'legacy.py'), 'print("legacy")\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
  fs.writeFileSync(path.join(dir, '.~test-abc-x.py'), 'temp');
  assert.strictEqual(scripts.importExisting(), 1);
  const row = getDb().prepare("SELECT * FROM scripts WHERE filename = 'legacy.py'").get();
  assert.ok(row);
  assert.strictEqual(scripts.latestVersion(row.id).note, 'Imported from disk');
  assert.strictEqual(scripts.importExisting(), 0, 'second import is a no-op');
});

test('scripts: a job that uses a script runs the saved file with args and secrets', async () => {
  const script = scripts.createScript({ filename: 'job_target.py' }).script;
  await scripts.saveScript(script.id, 'import os, sys\nprint("args=" + " ".join(sys.argv[1:]))\nprint("token=" + os.environ.get("TOK", ""))\n');
  const db = getDb();
  const secretId = db.prepare('INSERT INTO secrets (name, encrypted_value) VALUES (?, ?)').run('TOK', vault.encrypt('s3cr3t')).lastInsertRowid;
  const jobId = db
    .prepare("INSERT INTO jobs (name, command, script_id, args, timeout_sec) VALUES ('j', 'python3 job_target.py', ?, '--one two', 20)")
    .run(script.id).lastInsertRowid;
  db.prepare('INSERT INTO job_secrets (job_id, secret_id) VALUES (?, ?)').run(jobId, secretId);

  const { runId, done } = scheduler.runJobNow(jobId);
  assert.strictEqual(await done, 'success');
  const run = db.prepare('SELECT output FROM runs WHERE id = ?').get(runId);
  assert.match(run.output, /args=--one two/);
  assert.match(run.output, /token=s3cr3t/);

  // A script in use can't be deleted; once unused it can.
  assert.match(scripts.deleteScript(script.id).error, /used by 1 job/);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  assert.ok(scripts.deleteScript(script.id).ok);
  assert.ok(!fs.existsSync(path.join(dir, 'job_target.py')));
});

test('scripts: buildCommand quotes the path and prefers the venv python when present', () => {
  const s = { filename: "it's.py", language: 'python' };
  assert.match(scripts.buildCommand(s, '-v'), /'python3' '.*it'\\''s\.py' -v$/);
  fs.mkdirSync(path.join(process.env.VENV_DIR, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(process.env.VENV_DIR, 'bin', 'python'), '');
  try {
    assert.strictEqual(scripts.pythonBin(), path.join(process.env.VENV_DIR, 'bin', 'python'));
  } finally {
    fs.rmSync(process.env.VENV_DIR, { recursive: true, force: true });
  }
  assert.strictEqual(scripts.pythonBin(), 'python3');
});

test('diff: reports added and removed lines and collapses unchanged runs', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 10', 'line ten').concat('\nline 20');
  const d = diffLines(a, b);
  assert.strictEqual(d.added, 2);
  assert.strictEqual(d.removed, 1);
  assert.ok(d.lines.some((l) => l.type === 'skip'));
  assert.deepStrictEqual(
    d.lines.filter((l) => l.type !== 'same' && l.type !== 'skip').map((l) => `${l.type}:${l.text}`),
    ['del:line 10', 'add:line ten', 'add:line 20']
  );
});

test('tasks: output streams to listeners and the task can be cancelled', async () => {
  let finished = null;
  const id = tasks.startTask({ kind: 't', label: 'echo', command: 'echo one; sleep 0.3; echo two', onFinish: (r) => (finished = r) });
  const events = [];
  await new Promise((resolve) => {
    tasks.getTask(id).listeners.add((event, data) => {
      events.push([event, data]);
      if (event === 'end') resolve();
    });
  });
  const text = events.filter(([e]) => e === 'output').map(([, d]) => d).join('');
  assert.match(text, /two/);
  assert.deepStrictEqual(events[events.length - 1], ['end', { status: 'success', exitCode: 0 }]);
  assert.strictEqual(finished.status, 'success');

  const slow = tasks.startTask({ kind: 't', label: 'sleep', command: 'sleep 30' });
  const ended = new Promise((r) => tasks.getTask(slow).listeners.add((e, d) => e === 'end' && r(d)));
  assert.ok(tasks.cancelTask(slow));
  assert.strictEqual((await ended).status, 'cancelled');
});
