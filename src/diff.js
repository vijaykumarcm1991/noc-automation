'use strict';

// Minimal line diff (LCS) for comparing script versions.
// Returns hunks of { type: 'same' | 'add' | 'del' | 'skip', text, oldNo, newNo }.

const MAX_CELLS = 4_000_000;

function diffLines(oldText, newText, context = 3) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length * b.length > MAX_CELLS) return null; // too large to diff here

  // LCS table, built from the end so we can walk forward.
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) {
      // Prefer showing removals before additions on ties, like `diff -u`.
      lines.push({ type: 'add', text: b[j], newNo: j + 1 });
      j++;
    } else {
      lines.push({ type: 'del', text: a[i], oldNo: i + 1 });
      i++;
    }
  }

  // Collapse long runs of unchanged lines, keeping `context` lines around changes.
  const changed = lines.map((l) => l.type !== 'same');
  const keep = lines.map((_, idx) => {
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      if (changed[k]) return true;
    }
    return false;
  });
  const out = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) out.push({ type: 'skip', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
      skipped = 0;
      out.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: 'skip', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });

  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;
  return { lines: out, added, removed };
}

module.exports = { diffLines };
