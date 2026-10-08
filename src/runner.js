'use strict';

const { spawn } = require('child_process');

// Runs a shell command with the given env vars, working dir, and timeout.
// Returns a promise resolving to { status, exitCode, output }.
// status is one of: 'success' | 'failed' | 'timed_out'
function runCommand(command, { cwd, env = {}, timeoutSec = 300 } = {}) {
  return new Promise((resolve) => {
    const timeoutMs = timeoutSec * 1000;
    let output = '';
    let timedOut = false;

    const child = spawn(command, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      shell: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const append = (chunk) => {
      if (output.length < 1_000_000) {
        output += chunk.toString();
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'failed', exitCode: null, output: output + `\n[runner] error: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ status: 'timed_out', exitCode: null, output: output + `\n[runner] timed out after ${timeoutSec}s` });
      } else {
        resolve({ status: code === 0 ? 'success' : 'failed', exitCode: code, output });
      }
    });
  });
}

module.exports = { runCommand };
