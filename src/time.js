'use strict';

// Display/scheduling time zone. The DB keeps UTC timestamps (SQLite
// datetime('now')); everything shown to users is converted to this zone.
const APP_TZ = process.env.APP_TZ || 'Asia/Kolkata';

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: APP_TZ,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const clockFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: APP_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const zoneNameFmt = new Intl.DateTimeFormat('en-IN', { timeZone: APP_TZ, timeZoneName: 'short' });

// Short zone label, e.g. "IST" for Asia/Kolkata.
function zoneLabel() {
  if (APP_TZ === 'Asia/Kolkata') return 'IST';
  const part = zoneNameFmt.formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
  return part ? part.value : APP_TZ;
}

// Parse a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") or Date into a Date.
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

// "12 Oct 2026, 15:42:50"
function formatTime(value) {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : '—';
}

// "15:42"
function formatClock(value) {
  const d = toDate(value);
  return d ? clockFmt.format(d) : '—';
}

// "5m ago", "in 2h", "just now"
function relativeTime(value, now = Date.now()) {
  const d = toDate(value);
  if (!d) return '';
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return diffSec >= 0 ? 'in a few seconds' : 'just now';
  const units = [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      return diffSec >= 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
    }
  }
  return '';
}

// Human duration between two timestamps (end defaults to now): "1m 05s".
function formatDuration(start, end) {
  const s = toDate(start);
  if (!s) return '—';
  const e = toDate(end) || new Date();
  let sec = Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  sec -= m * 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

module.exports = { APP_TZ, zoneLabel, toDate, formatTime, formatClock, relativeTime, formatDuration };
