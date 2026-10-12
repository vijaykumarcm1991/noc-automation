'use strict';

// Friendly schedule builder <-> cron expression.
//
// The job form posts structured fields (schedule_type, time, days, ...); this
// module turns them into the cron expression the scheduler stores, parses a
// stored expression back into form fields for editing, and describes any
// expression in plain English for the UI.

const cron = require('node-cron');
const { APP_TZ } = require('./time');

const TYPES = ['manual', 'minutes', 'hourly', 'daily', 'weekly', 'monthly', 'custom'];
const MINUTE_INTERVALS = [1, 2, 5, 10, 15, 20, 30];
const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n) => String(n).padStart(2, '0');
const isInt = (s) => /^\d+$/.test(String(s));

function defaultFields() {
  return {
    type: 'manual',
    interval_min: 15,
    interval_hours: 1,
    at_minute: 0,
    time: '09:00',
    days: [1, 2, 3, 4, 5],
    month_day: '1',
    custom: '',
  };
}

function parseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, min } : null;
}

function toDays(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value];
  return [...new Set(list.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

// Form body -> { fields, cron, error }. cron is null for manual-only jobs.
function buildFromForm(body = {}) {
  // Plain API/legacy posts that only send cron_schedule are treated as custom.
  let type = TYPES.includes(body.schedule_type) ? body.schedule_type : null;
  if (!type) type = String(body.cron_schedule || '').trim() ? 'custom' : 'manual';

  const fields = {
    ...defaultFields(),
    type,
    interval_min: Number(body.interval_min) || 15,
    interval_hours: Number(body.interval_hours) || 1,
    at_minute: body.at_minute === undefined || body.at_minute === '' ? 0 : Number(body.at_minute),
    time: String(body.time || '09:00'),
    days: toDays(body.days),
    month_day: String(body.month_day || '1'),
    custom: String(body.schedule_custom || body.cron_schedule || '').trim(),
  };

  const t = parseTime(fields.time);
  let expr = null;
  let error = null;

  switch (type) {
    case 'manual':
      break;
    case 'minutes':
      if (!MINUTE_INTERVALS.includes(fields.interval_min)) error = 'Choose a valid minute interval.';
      else expr = fields.interval_min === 1 ? '* * * * *' : `*/${fields.interval_min} * * * *`;
      break;
    case 'hourly':
      if (!HOUR_INTERVALS.includes(fields.interval_hours)) error = 'Choose a valid hour interval.';
      else if (!Number.isInteger(fields.at_minute) || fields.at_minute < 0 || fields.at_minute > 59)
        error = 'Minute past the hour must be between 0 and 59.';
      else expr = `${fields.at_minute} ${fields.interval_hours === 1 ? '*' : '*/' + fields.interval_hours} * * *`;
      break;
    case 'daily':
      if (!t) error = 'Enter a valid time (HH:MM).';
      else expr = `${t.min} ${t.h} * * *`;
      break;
    case 'weekly':
      if (!t) error = 'Enter a valid time (HH:MM).';
      else if (!fields.days.length) error = 'Pick at least one day of the week.';
      else expr = `${t.min} ${t.h} * * ${fields.days.join(',')}`;
      break;
    case 'monthly': {
      const d = fields.month_day;
      if (!t) error = 'Enter a valid time (HH:MM).';
      else if (!(d === 'L' || (isInt(d) && Number(d) >= 1 && Number(d) <= 31))) error = 'Choose a day of the month.';
      else expr = `${t.min} ${t.h} ${d} * *`;
      break;
    }
    case 'custom':
      if (!fields.custom) error = 'Enter a cron expression, or pick another schedule type.';
      else if (!cron.validate(fields.custom)) error = `"${fields.custom}" is not a valid cron expression.`;
      else expr = fields.custom;
      break;
  }

  if (expr && !error && !cron.validate(expr)) error = 'That schedule could not be converted to a valid cron expression.';
  return { fields, cron: error ? null : expr, error };
}

// Expand a day-of-week field like "1-5" or "1,3,5" or "MON" into [1..5]; null if unsupported.
function parseDowField(field) {
  const names = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const days = new Set();
  for (const part of field.toLowerCase().split(',')) {
    const toNum = (s) => (isInt(s) ? Number(s) % 7 : names[s]);
    const range = part.split('-');
    if (range.length === 2) {
      const a = toNum(range[0]);
      const b = toNum(range[1]);
      if (a === undefined || b === undefined || a > b) return null;
      for (let i = a; i <= b; i++) days.add(i);
    } else {
      const n = toNum(part);
      if (n === undefined || Number(part) > 7) return null;
      days.add(n);
    }
  }
  return [...days].sort((a, b) => a - b);
}

// Cron expression -> form fields, falling back to 'custom' for anything the builder can't express.
function parseToFields(expr) {
  const fields = defaultFields();
  const value = String(expr || '').trim();
  if (!value) return fields;

  const parts = value.split(/\s+/);
  const custom = { ...fields, type: 'custom', custom: value };
  if (parts.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = parts;
  if (mon !== '*') return custom;

  const step = (f) => (f === '*' ? 1 : /^\*\/(\d+)$/.test(f) ? Number(f.slice(2)) : null);

  // Every N minutes
  if (hour === '*' && dom === '*' && dow === '*' && step(min) && MINUTE_INTERVALS.includes(step(min))) {
    return { ...fields, type: 'minutes', interval_min: step(min) };
  }
  if (!isInt(min) || Number(min) > 59) return custom;

  // Every N hours at minute M
  if (dom === '*' && dow === '*' && step(hour) && HOUR_INTERVALS.includes(step(hour))) {
    return { ...fields, type: 'hourly', interval_hours: step(hour), at_minute: Number(min) };
  }
  if (!isInt(hour) || Number(hour) > 23) return custom;
  const time = `${pad(hour)}:${pad(min)}`;

  if (dom === '*' && dow === '*') return { ...fields, type: 'daily', time };
  if (dom === '*') {
    const days = parseDowField(dow);
    return days && days.length ? { ...fields, type: 'weekly', time, days } : custom;
  }
  if (dow === '*' && (dom === 'L' || (isInt(dom) && Number(dom) >= 1 && Number(dom) <= 31))) {
    return { ...fields, type: 'monthly', time, month_day: dom };
  }
  return custom;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describeDays(days) {
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

// Plain-English description of a cron expression ("Every day at 09:00").
function describe(expr) {
  if (!expr) return 'Manual only';
  const f = parseToFields(expr);
  switch (f.type) {
    case 'minutes':
      return f.interval_min === 1 ? 'Every minute' : `Every ${f.interval_min} minutes`;
    case 'hourly':
      return f.interval_hours === 1
        ? f.at_minute === 0
          ? 'Every hour, on the hour'
          : `Every hour at :${pad(f.at_minute)}`
        : `Every ${f.interval_hours} hours at :${pad(f.at_minute)}`;
    case 'daily':
      return `Every day at ${f.time}`;
    case 'weekly':
      return `${describeDays(f.days)} at ${f.time}`;
    case 'monthly':
      return `Monthly on the ${f.month_day === 'L' ? 'last day' : ordinal(Number(f.month_day))} at ${f.time}`;
    default:
      return `Custom: ${expr}`;
  }
}

// Next `count` run times (Dates) for an expression in the app time zone.
function nextRuns(expr, count = 3) {
  if (!expr || !cron.validate(expr)) return [];
  const task = cron.createTask(expr, () => {}, { timezone: APP_TZ });
  try {
    return task.getNextRuns(count);
  } finally {
    task.destroy();
  }
}

module.exports = {
  TYPES,
  MINUTE_INTERVALS,
  HOUR_INTERVALS,
  DAY_NAMES,
  defaultFields,
  buildFromForm,
  parseToFields,
  describe,
  nextRuns,
};
