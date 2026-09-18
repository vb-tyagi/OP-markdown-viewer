// Markdown core: schema, parser, serializer, conventions and the block splicer.
// No DOM needed, so the same code runs in the browser and in the tests.
//
// Fidelity rule: a document is parsed into top-level blocks that remember their exact source text.
// When serializing, every block that is unchanged is emitted from that original text, byte for byte,
// along with the original blank lines around it. Only blocks the user changed are rewritten, and
// those follow the conventions detected in the file itself (emphasis and bullet markers, hard breaks).
import {
  Schema, MarkdownParser, MarkdownSerializer, MarkdownSerializerState,
  defaultMarkdownParser, defaultMarkdownSerializer, markdownSchema, markdownit,
} from './vendor/editor-bundle.js';

// ---------- links ----------
const SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel'];
export function safeHref(href) {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  if (!h) return null;
  const m = h.match(/^([a-z][a-z0-9+.-]*):/i);
  if (m && !SAFE_SCHEMES.includes(m[1].toLowerCase())) return null;
  return h;
}

// ---------- schema ----------
// Inline HTML tags that become a real mark when they appear as a matched pair in markdown, so that
// <u>text</u> renders underlined and round-trips unchanged. Anything else stays an inert tag atom.
export const HTML_MARK_TAGS = ['u', 'sub', 'sup', 'kbd', 'mark', 'small', 'ins', 'span'];

const baseNodes = markdownSchema.spec.nodes;
const baseMarks = markdownSchema.spec.marks;
const imageSpec = baseNodes.get('image');
const linkSpec = baseMarks.get('link');

export const schema = new Schema({
  nodes: baseNodes
    .update('image', {
      ...imageSpec,
      parseDOM: [{ tag: 'img[src]', getAttrs: (dom) => { const src = safeHref(dom.getAttribute('src')); return src ? { src, title: dom.getAttribute('title'), alt: dom.getAttribute('alt') } : false; } }],
    })
    .append({
      // A block the editor does not model (table, raw HTML). Rendered read-only, serialized verbatim.
      opaque: {
        group: 'block', atom: true, selectable: true, draggable: false,
        attrs: { raw: {}, kind: { default: 'html' } },
        toDOM: (node) => ['div', { class: 'opaque', 'data-kind': node.attrs.kind }, node.attrs.raw],
        parseDOM: [],
      },
      // A line break inside a paragraph in the source (a soft wrap). Shown as a space, written back
      // as the original newline, so hard-wrapped files keep their wrapping when edited.
      soft_break: {
        group: 'inline', inline: true, selectable: false,
        toDOM: () => ['span', { class: 'softbreak' }, ' '],
        parseDOM: [{ tag: 'span.softbreak' }],
      },
      // An unpaired inline HTML tag, kept as an inert atom so it passes through untouched.
      html_inline: {
        group: 'inline', inline: true, atom: true, selectable: true,
        attrs: { raw: {} },
        toDOM: (node) => ['span', { class: 'htmltag' }, node.attrs.raw],
        parseDOM: [],
      },
    }),
  marks: baseMarks
    .update('link', {
      ...linkSpec,
      parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => { const href = safeHref(dom.getAttribute('href')); return href ? { href, title: dom.getAttribute('title') } : false; } }],
      toDOM: (mark) => ['a', { href: safeHref(mark.attrs.href) || '#', title: mark.attrs.title || undefined }, 0],
    })
    .append({
      strikethrough: {
        parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
        toDOM: () => ['s', 0],
      },
      html: {
        attrs: { tag: {} },
        parseDOM: HTML_MARK_TAGS.map((tag) => ({ tag, getAttrs: () => ({ tag }) })),
        toDOM: (mark) => [HTML_MARK_TAGS.includes(mark.attrs.tag) ? mark.attrs.tag : 'span', 0],
      },
    }),
});

// ---------- markdown-it ----------
// CommonMark plus strikethrough and tables; raw HTML allowed so it can pass through; no typographer,
// so quotes and dashes are never rewritten.
export const md = markdownit('commonmark', { html: true, linkify: false, typographer: false }).enable(['strikethrough', 'table']);

function lineOffsets(src) {
  const offs = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') offs.push(i + 1);
  return offs;
}
function rawFromMap(map, src, offs) {
  const from = offs[map[0]] ?? src.length;
  let to = map[1] < offs.length ? offs[map[1]] : src.length;
  while (to > from && src[to - 1] === '\n') to--;
  return { from, to, raw: src.slice(from, to) };
}
function cloneToken(tok, patch) {
  return Object.assign(Object.create(Object.getPrototypeOf(tok)), tok, patch);
}

// Collapse unsupported constructs into opaque tokens and pair simple inline HTML tags into marks.
export function transformTokens(tokens, src) {
  const offs = lineOffsets(src);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'table_open') {
      let j = i + 1;
      while (j < tokens.length && !(tokens[j].type === 'table_close' && tokens[j].level === tok.level)) j++;
      const { raw } = rawFromMap(tok.map, src, offs);
      out.push(cloneToken(tok, { type: 'opaque', tag: '', nesting: 0, content: raw, children: null, meta: { kind: 'table' } }));
      i = j;
      continue;
    }
    if (tok.type === 'html_block') {
      out.push(cloneToken(tok, { type: 'opaque', nesting: 0, content: tok.content.replace(/\n+$/, ''), meta: { kind: 'html' } }));
      continue;
    }
    if (tok.type === 'inline' && tok.children) {
      pairInlineHtml(tok.children);
    }
    out.push(tok);
  }
  return out;
}

function pairInlineHtml(children) {
  const openRe = new RegExp(`^<(${HTML_MARK_TAGS.join('|')})>$`, 'i');
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type !== 'html_inline') continue;
    const m = c.content.match(openRe);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    const closeRe = new RegExp(`^</${tag}>$`, 'i');
    let depth = 0;
    for (let j = i + 1; j < children.length; j++) {
      const d = children[j];
      if (d.type !== 'html_inline') continue;
      if (openRe.test(d.content) && d.content.slice(1, -1).toLowerCase() === tag) depth++;
      else if (closeRe.test(d.content)) {
        if (depth === 0) {
          children[i] = cloneToken(c, { type: 'htmltag_open', nesting: 1, meta: { tag } });
          children[j] = cloneToken(d, { type: 'htmltag_close', nesting: -1, meta: { tag } });
          break;
        }
        depth--;
      }
    }
  }
}

const tokenizer = { parse: (src, env) => transformTokens(md.parse(src, env), src) };

export const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  s: { mark: 'strikethrough' },
  softbreak: { node: 'soft_break' },
  htmltag: { mark: 'html', getAttrs: (tok) => ({ tag: tok.meta.tag }) },
  html_inline: { node: 'html_inline', getAttrs: (tok) => ({ raw: tok.content }) },
  opaque: { node: 'opaque', getAttrs: (tok) => ({ raw: tok.content, kind: tok.meta.kind }) },
});

// ---------- front matter ----------
export function splitFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) return { fmRaw: '', fmInner: null, body: text };
  return { fmRaw: m[0], fmInner: m[1], body: text.slice(m[0].length) };
}
export function joinFrontMatter(fmInner, body) {
  return fmInner == null ? body : `---\n${fmInner}\n---\n${body}`;
}

// ---------- conventions ----------
export function detectConventions(body) {
  const count = (re) => (body.match(re) || []).length;
  const emStar = count(/(^|[^*\w\\])\*(?!\*)[^*\n]+?\*(?!\*)/g);
  const emUnder = count(/(^|[^_\w\\])_(?!_)[^_\n]+?_(?![_\w])/g);
  const strongStar = count(/\*\*[^*\n]+?\*\*/g);
  const strongUnder = count(/__[^_\n]+?__/g);
  const bullets = { '-': 0, '*': 0, '+': 0 };
  for (const m of body.matchAll(/^ {0,3}([-*+]) +\S/gm)) bullets[m[1]]++;
  const bullet = Object.entries(bullets).sort((a, b) => b[1] - a[1])[0];
  const twoSpace = count(/ {2,}\n(?=[^\n])/g);
  const backslash = count(/\\\n/g);
  return {
    em: emUnder > emStar ? '_' : '*',
    strong: strongUnder > strongStar ? '__' : '**',
    bullet: bullet[1] > 0 ? bullet[0] : '-',
    hardBreak: twoSpace > backslash ? '  \n' : '\\\n',
    fence: count(/^~~~/gm) > count(/^```/gm) ? '~~~' : '```',
  };
}

// ---------- serializer ----------
// A lone ~ in prose is not markdown; only ~~ is. Keep single tildes unescaped.
const origEsc = MarkdownSerializerState.prototype.esc;
MarkdownSerializerState.prototype.esc = function (str, startOfLine) {
  return origEsc.call(this, str, startOfLine).replace(/\\~/g, (m, i, s) =>
    (s.startsWith('\\~', i + 2) || (i >= 2 && s.startsWith('\\~', i - 2))) ? m : '~');
};

const serializerCache = new Map();
export function makeSerializer(conv) {
  const key = JSON.stringify(conv);
  if (serializerCache.has(key)) return serializerCache.get(key);
  const nodes = {
    ...defaultMarkdownSerializer.nodes,
    bullet_list(state, node) { state.renderList(node, '  ', () => conv.bullet + ' '); },
    hard_break(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) if (parent.child(i).type !== node.type) { state.write(conv.hardBreak); return; }
    },
    opaque(state, node) { state.text(node.attrs.raw, false); state.closeBlock(node); },
    html_inline(state, node) { state.write(node.attrs.raw); },
    soft_break(state) { state.text('\n', false); },
    // Text that starts a new source line after a soft break gets start-of-line escaping, so an
    // edited continuation line can never turn into a heading, list, or quote by accident.
    text(state, node, parent, index) {
      if (index > 0 && parent.child(index - 1).type === schema.nodes.soft_break && !state.inAutolink) state.atBlockStart = true;
      state.text(node.text, !state.inAutolink);
    },
  };
  if (conv.fence === '~~~') {
    nodes.code_block = (state, node) => {
      state.write('~~~' + (node.attrs.params || '') + '\n');
      state.text(node.textContent, false);
      state.write('\n~~~');
      state.closeBlock(node);
    };
  }
  const marks = {
    ...defaultMarkdownSerializer.marks,
    em: { open: conv.em, close: conv.em, mixable: true, expelEnclosingWhitespace: true },
    strong: { open: conv.strong, close: conv.strong, mixable: true, expelEnclosingWhitespace: true },
    strikethrough: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    html: { open: (_s, mark) => `<${mark.attrs.tag}>`, close: (_s, mark) => `</${mark.attrs.tag}>`, mixable: true },
  };
  const ser = new MarkdownSerializer(nodes, marks, { strict: false });
  serializerCache.set(key, ser);
  return ser;
}

// ---------- parse with block map ----------
// Returns the document plus a baseline: the exact source text of every top-level block and the
// blank lines between them. `blocks` is null when the map could not be established (then the whole
// document is re-serialized on save, which still produces valid markdown).
export function parseBody(body) {
  const tokens = tokenizer.parse(body, {});
  const doc = parser.parse(body);
  const offs = lineOffsets(body);
  const blocks = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level !== 0) continue;
    if (t.nesting === 1) {
      let j = i + 1;
      while (j < tokens.length && !(tokens[j].nesting === -1 && tokens[j].level === 0)) j++;
      if (t.map) blocks.push(rawFromMap(t.map, body, offs));
      i = j;
    } else if (t.nesting === 0 && t.map) {
      blocks.push(rawFromMap(t.map, body, offs));
    }
  }
  // A document with no blocks still has one empty paragraph in ProseMirror.
  const emptyDoc = doc.childCount === 1 && doc.firstChild.type === schema.nodes.paragraph && doc.firstChild.content.size === 0;
  let baseline;
  if (blocks.length === (emptyDoc ? 0 : doc.childCount)) {
    for (let i = 0; i < blocks.length; i++) blocks[i].node = doc.child(i);
    baseline = {
      body,
      blocks,
      leading: blocks.length ? body.slice(0, blocks[0].from) : body,
      gaps: blocks.map((b, i) => (i === 0 ? '' : body.slice(blocks[i - 1].to, b.from))),
      trailing: blocks.length ? body.slice(blocks[blocks.length - 1].to) : '',
      conv: detectConventions(body),
    };
  } else {
    baseline = { body, blocks: null, leading: '', gaps: [], trailing: '\n', conv: detectConventions(body) };
  }
  return { doc, baseline };
}

// Longest common subsequence alignment of the current top-level nodes against the baseline blocks.
function align(blocks, kids) {
  const n = blocks.length, m = kids.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = blocks[i].node.eq(kids[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const match = new Array(m).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (blocks[i].node.eq(kids[j])) { match[j] = i; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return match;
}

export function serializeBody(doc, baseline) {
  const conv = (baseline && baseline.conv) || detectConventions('');
  const ser = makeSerializer(conv);
  const one = (node) => ser.serialize(schema.node('doc', null, [node])).replace(/\n+$/, '');
  // Empty top-level paragraphs are editing artifacts, never markdown content.
  const kids = [];
  doc.forEach((n) => { if (!(n.type === schema.nodes.paragraph && n.content.size === 0)) kids.push(n); });
  if (!kids.length) return baseline && baseline.blocks && baseline.blocks.length === 0 ? baseline.body : '';
  if (!baseline || !baseline.blocks) return kids.map(one).join('\n\n') + '\n';
  const B = baseline.blocks;
  const match = align(B, kids);
  let out = baseline.leading;
  for (let j = 0; j < kids.length; j++) {
    const i = match[j];
    if (j > 0) out += (i >= 0 && match[j - 1] === i - 1) ? baseline.gaps[i] : '\n\n';
    out += i >= 0 ? B[i].raw : one(kids[j]);
  }
  const lastMatched = match[kids.length - 1] === B.length - 1;
  out += lastMatched || !B.length ? baseline.trailing : (baseline.trailing.length ? baseline.trailing : '\n');
  if (!/\n$/.test(out) && /\n$/.test(baseline.body)) out += '\n';
  return out;
}

// Full round trip helpers used by the editor.
export function parseMarkdown(text) {
  const { fmRaw, fmInner, body } = splitFrontMatter(text);
  const { doc, baseline } = parseBody(body);
  return { fmRaw, fmInner, doc, baseline };
}
export function serializeMarkdown(doc, baseline, fmRaw) {
  return fmRaw + serializeBody(doc, baseline);
}

// ---------- find ----------
// All occurrences of `query` in the document's text blocks, as document positions. Text is matched
// across mark boundaries; inline leaf nodes count as one character (a soft break as a space).
export function findMatches(doc, query, caseSensitive = false) {
  if (!query) return [];
  const q = caseSensitive ? query : query.toLowerCase();
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const map = [];
    node.forEach((child, offset) => {
      const base = pos + 1 + offset;
      if (child.isText) {
        for (let i = 0; i < child.text.length; i++) map.push(base + i);
        text += child.text;
      } else {
        map.push(base);
        text += child.type.name === 'soft_break' ? ' ' : '\uFFFC';
      }
    });
    map.push(pos + 1 + node.content.size);
    const hay = caseSensitive ? text : text.toLowerCase();
    let i = 0;
    while ((i = hay.indexOf(q, i)) !== -1) {
      out.push({ from: map[i], to: map[i + q.length] });
      i += q.length;
    }
    return false;
  });
  return out;
}
