'use strict';

const { spawn } = require('child_process');
const { APP_TZ } = require('./time');

const MAX_OUTPUT = 1_000_000;

// Kill the whole process group so programs started by the shell (e.g. the
// python3 behind `cd x && python3 y.py`) die too, not just the shell itself.
function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

// Runs a shell command with the given env vars, working dir, and timeout.
// Returns a promise resolving to { status, exitCode, output }.
// status is one of: 'success' | 'failed' | 'timed_out' | 'cancelled'
// Pass an AbortSignal as `signal` to cancel the run, and `onOutput` to receive
// the output captured so far each time more arrives.
function runCommand(command, { cwd, env = {}, timeoutSec = 300, signal, onOutput } = {}) {
  return new Promise((resolve) => {
    const timeoutMs = timeoutSec * 1000;
    let output = '';
    let truncated = false;
    let stopReason = null; // 'timed_out' | 'cancelled'

    let child;
    try {
      child = spawn(command, {
        cwd: cwd || process.cwd(),
        // Unbuffered Python output so live progress shows up while the job runs,
        // and the app's time zone so scripts' local time matches the UI.
        env: { PYTHONUNBUFFERED: '1', ...process.env, TZ: APP_TZ, ...env },
        shell: true,
        detached: true, // own process group, so killTree() reaches grandchildren
      });
    } catch (err) {
      resolve({ status: 'failed', exitCode: null, output: `[runner] error: ${err.message}` });
      return;
    }

    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      killTree(child);
    };

    const timer = setTimeout(() => stop('timed_out'), timeoutMs);
    const onAbort = () => stop('cancelled');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const append = (chunk) => {
      if (truncated) return;
      const text = chunk.toString();
      const room = MAX_OUTPUT - output.length;
      if (text.length <= room) {
        output += text;
      } else {
        output += text.slice(0, room);
        truncated = true;
      }
      if (onOutput) onOutput(output);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (result) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (truncated) result.output += `\n[runner] output truncated at ${MAX_OUTPUT} characters`;
      resolve(result);
    };

    child.on('error', (err) => {
      finish({ status: 'failed', exitCode: null, output: output + `\n[runner] error: ${err.message}` });
    });

    child.on('close', (code) => {
      if (stopReason === 'timed_out') {
        finish({ status: 'timed_out', exitCode: null, output: output + `\n[runner] timed out after ${timeoutSec}s` });
      } else if (stopReason === 'cancelled') {
        finish({ status: 'cancelled', exitCode: null, output: output + '\n[runner] cancelled by user' });
      } else {
        finish({ status: code === 0 ? 'success' : 'failed', exitCode: code, output });
      }
    });
  });
}

module.exports = { runCommand };
