'use strict';

const { buildFromForm } = require('./schedule');
const scripts = require('./scripts');

// Secret names become env var names, so they must be valid shell identifiers.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TIMEOUT_SEC = 24 * 60 * 60;

function toIdList(value) {
  const ids = Array.isArray(value) ? value : value ? [value] : [];
  return ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// Normalizes a submitted job form. Returns { values, errors }; errors is empty when valid.
// The schedule comes from the friendly builder fields (or a raw cron_schedule).
// A job runs either a library script (run_type=script) or a shell command.
function validateJob(body = {}) {
  const schedule = buildFromForm(body);
  const runType = body.run_type === 'script' || (!body.run_type && body.script_id && !body.command) ? 'script' : 'command';
  const script = runType === 'script' ? scripts.getScript(Number(body.script_id)) : null;
  const args = runType === 'script' ? String(body.args || '').trim() : '';
  const values = {
    name: String(body.name || '').trim(),
    run_type: runType,
    script_id: script ? script.id : null,
    args: args || null,
    // For script jobs this is a display form; the real command is built at run time.
    command: script ? scripts.displayCommand(script, args) : runType === 'command' ? String(body.command || '').trim() : '',
    working_dir: String(body.working_dir || '').trim() || null,
    cron_schedule: schedule.cron,
    schedule: schedule.fields,
    enabled: body.enabled ? 1 : 0,
    timeout_sec: body.timeout_sec === undefined || body.timeout_sec === '' ? 300 : Number(body.timeout_sec),
    secret_ids: toIdList(body.secret_ids),
  };

  const errors = [];
  if (!values.name) errors.push('Name is required.');
  if (runType === 'script' && !script) errors.push('Choose a script to run.');
  if (runType === 'command' && !values.command) errors.push('Command is required.');
  if (schedule.error) errors.push(schedule.error);
  if (!Number.isInteger(values.timeout_sec) || values.timeout_sec < 1 || values.timeout_sec > MAX_TIMEOUT_SEC) {
    errors.push(`Timeout must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SEC}.`);
  }
  return { values, errors };
}

function validateSecretName(name) {
  const value = String(name || '').trim();
  if (!value) return { value, error: 'Name is required.' };
  if (!ENV_NAME_RE.test(value)) {
    return {
      value,
      error: 'Name must start with a letter or underscore and contain only letters, digits and underscores (it becomes an environment variable).',
    };
  }
  return { value, error: null };
}

module.exports = { validateJob, validateSecretName, ENV_NAME_RE };
