// Deterministic formatting guard (ES module, runs in the browser and in Node). Compares the structural skeleton of the
// original and edited markdown and reports anything that looks like accidental
// damage. It never blocks; the UI decides. Pure function, no I/O.

function splitFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return { fm: null, body: text, fmRaw: null };
  return { fm: m[1], body: text.slice(m[0].length), fmRaw: m[0] };
}

function fmKeys(fm) {
  if (fm == null) return null;
  return fm
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Za-z_][\w-]*):/))
    .filter(Boolean)
    .map((m) => m[1]);
}

function fmValue(fm, key) {
  if (fm == null) return null;
  const m = fm.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'));
  return m ? m[1].trim() : null;
}

export function skeleton(text) {
  const { fm, body } = splitFrontMatter(text);
  const lines = body.split('\n');
  const s = {
    hasFrontMatter: fm != null,
    fmKeys: fmKeys(fm),
    fmTitle: fmValue(fm, 'title'),
    fmTags: fmValue(fm, 'tags'),
    headings: [],
    badHeadings: [],
    blockquoteLines: 0,
    listItems: 0,
    fenceLines: 0,
    links: 0,
    images: 0,
    hr: 0,
    paragraphs: 0,
    blankRuns: 0, // runs of 2+ blank lines
    trailingWs: 0,
    tabs: 0,
    straightDouble: 0,
    straightSingle: 0,
    curly: 0,
    curlySingle: 0,
    capitalStarts: 0,
    boldMarkers: 0,
    italicMarkers: 0,
    artifacts: [],
    crlf: (text.match(/\r\n/g) || []).length,
    endsWithNewline: text.endsWith('\n'),
    endsWithMultiNewline: /\n\n$/.test(text),
    h1Text: null,
  };

  let inFence = false;
  let blankStreak = 0;
  let inPara = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      s.fenceLines++;
      inFence = !inFence;
      blankStreak = 0;
      inPara = false;
      continue;
    }
    if (inFence) continue;

    if (line.trim() === '') {
      blankStreak++;
      if (blankStreak === 2) s.blankRuns++;
      inPara = false;
      continue;
    }
    blankStreak = 0;

    // Exactly two trailing spaces after text is a markdown hard line break, not junk.
    if (/[ \t]+$/.test(line) && !/\S  $/.test(line)) s.trailingWs++;
    if (/\t/.test(line)) s.tabs++;

    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      s.headings.push({ level: h[1].length, text: h[2].trim(), line: i + 1 });
      if (h[1].length === 1 && s.h1Text == null) s.h1Text = h[2].trim();
      continue;
    }
    if (/^#{1,6}[^#\s]/.test(line) || /^#{1,6}\s{2,}\S/.test(line)) {
      s.badHeadings.push({ line: i + 1, text: line.slice(0, 60) });
    }
    if (/^\s*>/.test(line)) s.blockquoteLines++;
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) s.listItems++;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      s.hr++;
      continue;
    }
    if (!inPara) {
      s.paragraphs++;
      inPara = true;
    }

    s.links += (line.match(/\[[^\]]*\]\([^)]*\)/g) || []).length;
    s.images += (line.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;
    s.straightDouble += (line.match(/"/g) || []).length;
    s.straightSingle += (line.match(/'/g) || []).length;
    s.curly += (line.match(/[“”]/g) || []).length;
    s.curlySingle += (line.match(/[‘’]/g) || []).length;
    s.boldMarkers += (line.match(/\*\*|__/g) || []).length;
    const stripped = line.replace(/\*\*|__/g, '');
    s.italicMarkers += (stripped.match(/(^|[^\w*])\*(?=\S)|(?<=\S)\*(?=[^\w*]|$)|(^|[^\w_])_(?=\S)|(?<=\S)_(?=[^\w_]|$)/g) || []).length;

    const first = line.replace(/^(\s*>\s*|\s*([-*+]|\d+[.)])\s+)/, '').trim();
    if (/^[A-Z]/.test(first)) s.capitalStarts++;

    if (/\b(TODO|FIXME|XXX|TK|TBD)\b/.test(line) || /\[\[|\]\]|\{\{|\}\}/.test(line) || /^\s*(<<<<<<<|=======|>>>>>>>)/.test(line)) {
      s.artifacts.push({ line: i + 1, text: line.slice(0, 80) });
    }
  }
  s.fenceBalanced = !inFence;
  return s;
}

export function guard(original, edited) {
  const a = skeleton(original);
  const b = skeleton(edited);
  const issues = [];
  const push = (severity, what, detail) => issues.push({ severity, what, detail: detail || null });

  if (original === edited) {
    return { verdict: 'clean', issues: [], fixes: [], summary: 'no changes' };
  }

  // Front matter
  if (a.hasFrontMatter && !b.hasFrontMatter) push('error', 'front matter is missing or its --- delimiters are broken');
  if (a.hasFrontMatter && b.hasFrontMatter) {
    const missing = a.fmKeys.filter((k) => !b.fmKeys.includes(k));
    const added = b.fmKeys.filter((k) => !a.fmKeys.includes(k));
    if (missing.length) push('error', 'front matter keys removed: ' + missing.join(', '));
    if (added.length) push('warn', 'front matter keys added: ' + added.join(', '));
    if (a.fmTags && b.fmTags && !/^\[.*\]$/.test(b.fmTags)) push('error', 'tags is no longer an array', b.fmTags);
    if (b.fmTitle != null && b.h1Text != null) {
      const norm = (t) => (t || '').replace(/^"|"$/g, '').trim();
      if (norm(a.fmTitle) === a.h1Text && norm(b.fmTitle) !== b.h1Text) {
        push('warn', 'title in front matter no longer matches the H1', `front matter: ${norm(b.fmTitle)} | h1: ${b.h1Text}`);
      }
    }
  }

  // Headings
  const aH1 = a.headings.filter((h) => h.level === 1).length;
  const bH1 = b.headings.filter((h) => h.level === 1).length;
  if (aH1 === 1 && bH1 !== 1) push('error', `expected exactly one H1, found ${bH1}`);
  if (a.headings.length !== b.headings.length) {
    push(
      Math.abs(a.headings.length - b.headings.length) > 1 ? 'error' : 'warn',
      `heading count changed ${a.headings.length} → ${b.headings.length}`,
      diffHeadings(a.headings, b.headings)
    );
  } else {
    for (let i = 0; i < a.headings.length; i++) {
      if (a.headings[i].level !== b.headings[i].level) {
        push('error', `heading level changed at "${b.headings[i].text}"`, `H${a.headings[i].level} → H${b.headings[i].level}`);
      }
    }
  }
  for (const bad of b.badHeadings) {
    if (!a.badHeadings.some((x) => x.text === bad.text)) push('error', 'malformed heading marker', `line ${bad.line}: ${bad.text}`);
  }

  // Blocks
  if (!b.fenceBalanced) push('error', 'unclosed code fence');
  if (a.blockquoteLines !== b.blockquoteLines) push(b.blockquoteLines < a.blockquoteLines ? 'warn' : 'info', `blockquote lines ${a.blockquoteLines} → ${b.blockquoteLines}`);
  if (a.listItems !== b.listItems) push('info', `list items ${a.listItems} → ${b.listItems}`);
  if (a.links !== b.links) push(b.links < a.links ? 'warn' : 'info', `links ${a.links} → ${b.links}`);
  if (a.images !== b.images) push('warn', `images ${a.images} → ${b.images}`);
  if (a.hr !== b.hr) push('info', `horizontal rules ${a.hr} → ${b.hr}`);

  // Paragraph shape
  const pDelta = b.paragraphs - a.paragraphs;
  if (pDelta <= -3) push('warn', `paragraph count dropped ${a.paragraphs} → ${b.paragraphs} (merged or deleted?)`);
  else if (pDelta !== 0) push('info', `paragraphs ${a.paragraphs} → ${b.paragraphs}`);
  if (b.blankRuns > a.blankRuns) push('warn', `doubled blank lines introduced (${b.blankRuns - a.blankRuns} new run${b.blankRuns - a.blankRuns > 1 ? 's' : ''})`);

  // Inline markers
  if (b.boldMarkers % 2 !== 0 && a.boldMarkers % 2 === 0) push('error', 'unbalanced bold markers (** or __)');
  if (b.italicMarkers % 2 !== 0 && a.italicMarkers % 2 === 0) push('warn', 'possibly unbalanced italic markers (* or _)');

  // House style
  const fixes = [];
  if (b.crlf > a.crlf) {
    push('error', 'Windows line endings (CRLF) introduced');
    fixes.push('crlf');
  } else if (b.crlf < a.crlf) {
    push('info', 'mixed line endings were normalized to LF');
  }
  if (b.tabs > a.tabs) push('warn', `tab characters introduced (${b.tabs - a.tabs})`);
  if (b.trailingWs > a.trailingWs) {
    push('warn', `trailing whitespace on ${b.trailingWs - a.trailingWs} line${b.trailingWs - a.trailingWs > 1 ? 's' : ''}`);
    fixes.push('trailing-ws');
  }
  if (a.endsWithNewline && !b.endsWithNewline) {
    push('warn', 'final newline lost');
    fixes.push('final-newline');
  }
  if (!a.endsWithMultiNewline && b.endsWithMultiNewline) {
    push('info', 'extra blank line at end of file');
    fixes.push('final-newline');
  }
  // House quote style: quoted phrases use curly “ ”; apostrophes are straight '.
  if (b.straightDouble > a.straightDouble && (a.straightDouble === 0 || a.curly > 0)) push('warn', `straight double quotes introduced (${b.straightDouble - a.straightDouble}); this collection uses curly “ ”`);
  if (b.curlySingle > a.curlySingle && a.curlySingle === 0) push('info', `curly apostrophes ‘ ’ introduced (${b.curlySingle - a.curlySingle}); this collection uses straight '`);
  if (b.capitalStarts > a.capitalStarts) push('info', `capitalized sentence/line starts ${a.capitalStarts} → ${b.capitalStarts} (house style is lowercase)`);

  for (const art of b.artifacts) {
    if (!a.artifacts.some((x) => x.text === art.text)) push('warn', 'possible editing artifact', `line ${art.line}: ${art.text}`);
  }

  // Size sanity
  const aLen = original.length;
  const bLen = edited.length;
  if (aLen > 0 && bLen < aLen * 0.5) push('error', `file shrank by more than half (${aLen} → ${bLen} chars)`);
  if (bLen === 0) push('error', 'file is empty');

  const worst = issues.some((i) => i.severity === 'error') ? 'damage' : issues.some((i) => i.severity === 'warn') ? 'warn' : 'clean';
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const summary =
    worst === 'clean'
      ? issues.length
        ? `structure preserved (${counts.info} informational note${counts.info > 1 ? 's' : ''})`
        : 'structure preserved'
      : `${counts.error} error${counts.error !== 1 ? 's' : ''}, ${counts.warn} warning${counts.warn !== 1 ? 's' : ''}`;
  return { verdict: worst, issues, fixes: [...new Set(fixes)], summary, stats: { before: pick(a), after: pick(b) } };
}

function diffHeadings(a, b) {
  const at = a.map((h) => '#'.repeat(h.level) + ' ' + h.text);
  const bt = b.map((h) => '#'.repeat(h.level) + ' ' + h.text);
  const removed = at.filter((x) => !bt.includes(x));
  const added = bt.filter((x) => !at.includes(x));
  const parts = [];
  if (removed.length) parts.push('removed: ' + removed.join(' | '));
  if (added.length) parts.push('added: ' + added.join(' | '));
  return parts.join('\n') || null;
}

function pick(s) {
  return {
    headings: s.headings.length,
    paragraphs: s.paragraphs,
    blockquotes: s.blockquoteLines,
    links: s.links,
    capitalStarts: s.capitalStarts,
  };
}

// Safe mechanical fixes the user can apply with one click. They never touch fenced code blocks
// and never remove a deliberate two-space hard line break.
export function applyFixes(text, fixes) {
  let t = text;
  if (fixes.includes('crlf')) t = t.replace(/\r\n/g, '\n');
  if (fixes.includes('trailing-ws')) {
    let inFence = false;
    t = t
      .split('\n')
      .map((line) => {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
        if (inFence) return line;
        if (/\S  $/.test(line)) return line;
        return line.replace(/[ \t]+$/, '');
      })
      .join('\n');
  }
  if (fixes.includes('final-newline')) t = t.replace(/\n+$/, '') + '\n';
  return t;
}

