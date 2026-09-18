// Line diff for the "what will change" view. Pure functions, used by the app and the tests.
//
// diffLines(a, b) -> { ops, added, removed, changed }
//   ops: [{ type: 'equal' | 'del' | 'add', line }] in order
// hunks(ops, context) -> display groups with collapsed unchanged runs and intra-line highlights

function splitLines(text) {
  if (text === '') return { lines: [], endsWithNewline: false };
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

const MAX_CELLS = 4_000_000;

export function diffLines(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);
  const x = A.lines, y = B.lines;
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const mx = x.slice(pre, x.length - suf);
  const my = y.slice(pre, y.length - suf);
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'equal', line: x[i] });
  if (mx.length && my.length && mx.length * my.length <= MAX_CELLS) {
    // longest common subsequence on the changed middle
    const n = mx.length, m = my.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = mx[i] === my[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) { ops.push({ type: 'equal', line: mx[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', line: mx[i] }); i++; }
      else { ops.push({ type: 'add', line: my[j] }); j++; }
    }
    while (i < n) ops.push({ type: 'del', line: mx[i++] });
    while (j < m) ops.push({ type: 'add', line: my[j++] });
  } else {
    for (const l of mx) ops.push({ type: 'del', line: l });
    for (const l of my) ops.push({ type: 'add', line: l });
  }
  for (let i = x.length - suf; i < x.length; i++) ops.push({ type: 'equal', line: x[i] });
  if (a !== '' && b !== '' && A.endsWithNewline !== B.endsWithNewline) {
    ops.push({ type: A.endsWithNewline ? 'del' : 'add', line: '', note: A.endsWithNewline ? 'final newline removed' : 'final newline added' });
  }
  let added = 0, removed = 0;
  for (const o of ops) { if (o.type === 'add') added++; else if (o.type === 'del') removed++; }
  return { ops, added, removed, changed: added + removed > 0 };
}

// Common prefix/suffix of two strings, for highlighting the changed middle of a replaced line.
function intraline(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return {
    del: { pre: a.slice(0, p), mid: a.slice(p, a.length - s), post: a.slice(a.length - s) },
    add: { pre: b.slice(0, p), mid: b.slice(p, b.length - s), post: b.slice(b.length - s) },
  };
}

// Groups ops into hunks: changed runs with `context` unchanged lines around them, and 'skip'
// entries for collapsed unchanged runs. Equal-length del/add runs are paired for intra-line highlights.
export function hunks(ops, context = 2) {
  const out = [];
  let i = 0;
  const n = ops.length;
  // indices of changed ops
  const changed = [];
  for (let k = 0; k < n; k++) if (ops[k].type !== 'equal') changed.push(k);
  if (!changed.length) return out;
  let cursor = 0;
  let c = 0;
  while (c < changed.length) {
    const start = Math.max(cursor, changed[c] - context);
    if (start > cursor) out.push({ type: 'skip', count: start - cursor });
    let end = changed[c];
    let cc = c;
    // extend the hunk while the next change is within 2*context lines
    while (cc + 1 < changed.length && changed[cc + 1] - end <= 2 * context + 1) { cc++; end = changed[cc]; }
    const stop = Math.min(n, end + context + 1);
    const lines = [];
    for (let k = start; k < stop; k++) lines.push({ ...ops[k] });
    pairRuns(lines);
    out.push({ type: 'hunk', lines });
    cursor = stop;
    c = cc + 1;
  }
  if (cursor < n) out.push({ type: 'skip', count: n - cursor });
  return out;
}

function pairRuns(lines) {
  let k = 0;
  while (k < lines.length) {
    if (lines[k].type !== 'del') { k++; continue; }
    let d = k;
    while (d < lines.length && lines[d].type === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a].type === 'add') a++;
    const dels = d - k, adds = a - d;
    if (dels === adds) {
      for (let t = 0; t < dels; t++) {
        const il = intraline(lines[k + t].line, lines[d + t].line);
        lines[k + t].parts = il.del;
        lines[d + t].parts = il.add;
      }
    }
    k = a;
  }
}
