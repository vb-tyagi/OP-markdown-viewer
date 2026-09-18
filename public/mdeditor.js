// The rich editor: a ProseMirror view over the markdown schema, with keymap, input rules,
// node views and the commands the toolbar uses. Markdown in, markdown out (see mdcore.js).
import {
  EditorState, EditorView, TextSelection, NodeSelection, Plugin, PluginKey, Decoration, DecorationSet,
  history, undo, redo, undoDepth, redoDepth, keymap, baseKeymap,
  toggleMark, setBlockType, wrapIn, lift, chainCommands, exitCode,
  inputRules, wrappingInputRule, textblockTypeInputRule, undoInputRule,
  wrapInList, splitListItem, liftListItem, sinkListItem,
} from './vendor/editor-bundle.js';
import { schema, md, parseMarkdown, serializeBody, safeHref, findMatches } from './mdcore.js';

const N = schema.nodes;
const M = schema.marks;

// ---------- helpers ----------
function markActive(state, type) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}
function ancestor(state, pred) {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (pred(node)) return { node, depth: d, pos: $from.before(d) };
  }
  return null;
}
// The extent of the mark instance of `type` around $pos, if any.
function markRange($pos, type) {
  const parent = $pos.parent;
  let idx = $pos.index();
  const after = parent.maybeChild(idx);
  const before = idx > 0 ? parent.maybeChild(idx - 1) : null;
  let mark = after && type.isInSet(after.marks);
  if (!mark && before && $pos.textOffset === 0) { mark = type.isInSet(before.marks); idx = idx - 1; }
  if (!mark) return null;
  let startIndex = idx, endIndex = idx + 1;
  while (startIndex > 0 && mark.isInSet(parent.child(startIndex - 1).marks)) startIndex--;
  while (endIndex < parent.childCount && mark.isInSet(parent.child(endIndex).marks)) endIndex++;
  let from = $pos.start();
  for (let i = 0; i < startIndex; i++) from += parent.child(i).nodeSize;
  let to = from;
  for (let i = startIndex; i < endIndex; i++) to += parent.child(i).nodeSize;
  return { from, to, mark };
}
function linkAt(state) {
  const r = markRange(state.selection.$from, M.link);
  return r ? { href: r.mark.attrs.href, title: r.mark.attrs.title, from: r.from, to: r.to } : null;
}

// ---------- commands ----------
function toggleList(listType) {
  return (state, dispatch) => {
    const list = ancestor(state, (n) => n.type === N.bullet_list || n.type === N.ordered_list);
    if (!list) return wrapInList(listType)(state, dispatch);
    if (list.node.type === listType) return liftListItem(N.list_item)(state, dispatch);
    if (dispatch) {
      const attrs = listType === N.ordered_list ? { order: 1, tight: list.node.attrs.tight } : { tight: list.node.attrs.tight };
      dispatch(state.tr.setNodeMarkup(list.pos, listType, attrs).scrollIntoView());
    }
    return true;
  };
}
const toggleQuote = (state, dispatch) => (ancestor(state, (n) => n.type === N.blockquote) ? lift(state, dispatch) : wrapIn(N.blockquote)(state, dispatch));
const toggleCodeBlock = (state, dispatch) => (state.selection.$from.parent.type === N.code_block ? setBlockType(N.paragraph)(state, dispatch) : setBlockType(N.code_block)(state, dispatch));
const insertHr = (state, dispatch) => { if (dispatch) dispatch(state.tr.replaceSelectionWith(N.horizontal_rule.create()).scrollIntoView()); return true; };
const hardBreak = chainCommands(exitCode, (state, dispatch) => { if (dispatch) dispatch(state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView()); return true; });
function insertImage(src, alt) {
  return (state, dispatch) => {
    const href = safeHref(src);
    if (!href) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(N.image.create({ src: href, alt: alt || null })).scrollIntoView());
    return true;
  };
}
function setLink(href) {
  return (state, dispatch) => {
    const clean = safeHref(href);
    const existing = linkAt(state);
    const { from, to, empty } = state.selection;
    let tr = state.tr;
    if (existing) {
      tr = tr.removeMark(existing.from, existing.to, M.link);
      if (clean) tr = tr.addMark(existing.from, existing.to, M.link.create({ href: clean }));
    } else if (!clean) {
      return false;
    } else if (empty) {
      tr = tr.insertText(clean, from).addMark(from, from + clean.length, M.link.create({ href: clean }));
    } else {
      tr = tr.addMark(from, to, M.link.create({ href: clean }));
    }
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}
const clearFormatting = (state, dispatch) => {
  const { from, to, $from } = state.selection;
  let tr = state.tr.removeMark(from, to);
  if ($from.parent.type === N.heading || $from.parent.type === N.code_block) tr = tr.setBlockType(from, to, N.paragraph);
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
};

// ---------- input rules (markdown shortcuts while typing; no smart quotes on purpose) ----------
const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^(#{1,6})\s$/, N.heading, (m) => ({ level: m[1].length })),
    wrappingInputRule(/^\s*([-+*])\s$/, N.bullet_list),
    wrappingInputRule(/^(\d+)\.\s$/, N.ordered_list, (m) => ({ order: +m[1] }), (m, node) => node.childCount + node.attrs.order === +m[1]),
    wrappingInputRule(/^\s*>\s$/, N.blockquote),
    textblockTypeInputRule(/^```$/, N.code_block),
  ],
});

// ---------- find & replace ----------
const findKey = new PluginKey('find');
const findPlugin = new Plugin({
  key: findKey,
  state: {
    init: () => ({ query: '', caseSensitive: false, matches: [], current: -1 }),
    apply(tr, prev, _old, newState) {
      const meta = tr.getMeta(findKey);
      if (!meta && !tr.docChanged) return prev;
      const next = { ...prev, ...(meta || {}) };
      if (!next.query) return { query: '', caseSensitive: next.caseSensitive, matches: [], current: -1 };
      const matches = findMatches(newState.doc, next.query, next.caseSensitive);
      let current = next.current;
      if (meta && typeof meta.current === 'number') current = meta.current;
      else if (tr.docChanged && prev.matches[prev.current]) {
        const p = tr.mapping.map(prev.matches[prev.current].from);
        current = matches.findIndex((m) => m.from >= p);
      }
      if (!matches.length) current = -1;
      else if (current < 0 || current >= matches.length) current = 0;
      return { ...next, matches, current };
    },
  },
  props: {
    decorations(state) {
      const s = findKey.getState(state);
      if (!s || !s.matches.length) return null;
      return DecorationSet.create(state.doc, s.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === s.current ? 'find-match find-current' : 'find-match' })));
    },
  },
});

// ---------- node views ----------
class ImageView {
  constructor(node) {
    this.dom = document.createElement('span');
    this.dom.className = 'img-wrap';
    const img = document.createElement('img');
    img.src = node.attrs.src;
    if (node.attrs.alt) img.alt = node.attrs.alt;
    if (node.attrs.title) img.title = node.attrs.title;
    img.addEventListener('error', () => {
      const s = document.createElement('span');
      s.className = 'img-missing';
      s.textContent = `image: ${node.attrs.alt || '(no alt)'} · ${node.attrs.src}`;
      img.replaceWith(s);
    });
    this.dom.appendChild(img);
  }
  stopEvent() { return false; }
}
class OpaqueView {
  constructor(node, sanitize) {
    this.dom = document.createElement('div');
    this.dom.className = 'opaque';
    this.dom.contentEditable = 'false';
    const label = document.createElement('span');
    label.className = 'opaque-label';
    label.textContent = node.attrs.kind === 'table' ? 'table · edit in the markdown pane' : 'html · edit in the markdown pane';
    const body = document.createElement('div');
    body.className = 'opaque-body';
    const html = node.attrs.kind === 'table' ? md.render(node.attrs.raw) : node.attrs.raw;
    body.innerHTML = sanitize ? sanitize(html) : '';
    this.dom.append(label, body);
  }
  ignoreMutation() { return true; }
  stopEvent() { return false; }
}

// ---------- editor ----------
export function createEditor({ mount, sanitize, onChange, onUpdate, onLinkRequest, onImageRequest }) {
  let locked = false;
  let base = { fmRaw: '', fmInner: null, baseline: null };
  let fmInner = null;
  const cache = { doc: null, fm: null, text: '' };

  const plugins = () => [
    history(),
    findPlugin,
    rules,
    keymap({
      'Mod-b': toggleMark(M.strong),
      'Mod-i': toggleMark(M.em),
      'Mod-e': toggleMark(M.code),
      'Mod-Shift-s': toggleMark(M.strikethrough),
      'Mod-k': (state, dispatch, view) => promptLink(view),
      'Mod-Shift-8': toggleList(N.bullet_list),
      'Mod-Shift-7': toggleList(N.ordered_list),
      'Mod-Shift-9': toggleQuote,
      'Mod-Alt-c': toggleCodeBlock,
      'Mod-Alt-0': setBlockType(N.paragraph),
      'Mod-Alt-1': setBlockType(N.heading, { level: 1 }),
      'Mod-Alt-2': setBlockType(N.heading, { level: 2 }),
      'Mod-Alt-3': setBlockType(N.heading, { level: 3 }),
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
      Backspace: undoInputRule,
      Enter: splitListItem(N.list_item),
      Tab: sinkListItem(N.list_item),
      'Shift-Tab': liftListItem(N.list_item),
      'Shift-Enter': hardBreak,
      'Mod-Enter': hardBreak,
    }),
    keymap(baseKeymap),
  ];

  const view = new EditorView(mount, {
    state: EditorState.create({ schema, plugins: plugins() }),
    editable: () => !locked,
    attributes: { class: 'doc-body', spellcheck: 'true' },
    nodeViews: {
      image: (node) => new ImageView(node),
      opaque: (node) => new OpaqueView(node, sanitize),
    },
    transformPastedHTML: (html) => (sanitize ? sanitize(html) : html),
    dispatchTransaction(tr) {
      const next = view.state.apply(tr);
      view.updateState(next);
      if (tr.docChanged && onChange) onChange({ origin: tr.getMeta('origin') || 'editor' });
      if (onUpdate) onUpdate(status());
    },
  });

  function selectionCoords(v) {
    const { from, to } = v.state.selection;
    const a = v.coordsAtPos(from);
    const b = v.coordsAtPos(to);
    return { left: a.left, top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), right: b.right };
  }
  function promptLink(v) {
    const existing = linkAt(v.state);
    if (onLinkRequest) {
      const { from, to } = v.state.selection;
      onLinkRequest({ existing, selectedText: v.state.doc.textBetween(from, to, ' '), coords: selectionCoords(v) });
      return true;
    }
    const href = window.prompt(existing ? 'edit link URL (empty removes the link)' : 'link URL', existing ? existing.href : 'https://');
    if (href === null) return true;
    if (!existing && !href.trim()) return true;
    if (!existing && !safeHref(href)) { window.alert('only http, https, mailto and tel links are allowed'); return true; }
    setLink(href.trim())(v.state, v.dispatch);
    v.focus();
    return true;
  }
  function promptImage(v) {
    if (onImageRequest) { onImageRequest({ coords: selectionCoords(v) }); return; }
    const src = window.prompt('image URL');
    if (!src) return;
    if (!safeHref(src)) { window.alert('only http, https or relative image URLs are allowed'); return; }
    const alt = window.prompt('alt text (describes the image)', '') || '';
    insertImage(src.trim(), alt)(v.state, v.dispatch);
    v.focus();
  }

  const commands = {
    strong: toggleMark(M.strong), em: toggleMark(M.em), strike: toggleMark(M.strikethrough), code: toggleMark(M.code),
    paragraph: setBlockType(N.paragraph),
    h1: setBlockType(N.heading, { level: 1 }), h2: setBlockType(N.heading, { level: 2 }), h3: setBlockType(N.heading, { level: 3 }),
    bullet: toggleList(N.bullet_list), ordered: toggleList(N.ordered_list), quote: toggleQuote, codeblock: toggleCodeBlock,
    hr: insertHr, clear: clearFormatting, undo, redo,
    link: (s, d, v) => promptLink(v), unlink: setLink(''), image: (s, d, v) => { promptImage(v); return true; },
  };
  // Used by the app's popover once the user has typed a URL.
  const direct = {
    applyLink: (href, text) => {
      const st = view.state;
      if (text && st.selection.empty && !linkAt(st)) {
        const clean = safeHref(href);
        if (!clean) return false;
        const from = st.selection.from;
        view.dispatch(st.tr.insertText(text, from).addMark(from, from + text.length, M.link.create({ href: clean })).scrollIntoView());
        view.focus();
        return true;
      }
      const ok = setLink(href)(st, view.dispatch);
      view.focus();
      return ok;
    },
    insertImage: (src, alt) => { const ok = insertImage(src, alt)(view.state, view.dispatch); view.focus(); return ok; },
  };

  function status() {
    const st = view.state;
    const parent = st.selection.$from.parent;
    const list = ancestor(st, (n) => n.type === N.bullet_list || n.type === N.ordered_list);
    return {
      strong: markActive(st, M.strong), em: markActive(st, M.em), strike: markActive(st, M.strikethrough), code: markActive(st, M.code),
      block: parent.type === N.heading ? `h${parent.attrs.level}` : parent.type === N.code_block ? 'code' : parent.type === N.paragraph ? 'p' : 'other',
      list: list ? (list.node.type === N.bullet_list ? 'bullet' : 'ordered') : null,
      quote: !!ancestor(st, (n) => n.type === N.blockquote),
      link: linkAt(st),
      canUndo: undoDepth(st) > 0, canRedo: redoDepth(st) > 0,
      locked, empty: st.doc.childCount === 1 && st.doc.firstChild.content.size === 0,
    };
  }

  function currentFmRaw() {
    if (fmInner === base.fmInner) return base.fmRaw;
    return fmInner == null ? '' : `---\n${fmInner}\n---\n`;
  }

  const api = {
    view,
    // Load a document. fresh=true starts a new undo history (opening a file); fresh=false replaces
    // the content as an undoable step (source-pane edits, safe fixes).
    setMarkdown(text, { fresh = true, origin = 'load' } = {}) {
      const parsed = parseMarkdown(text);
      base = { fmRaw: parsed.fmRaw, fmInner: parsed.fmInner, baseline: parsed.baseline };
      fmInner = parsed.fmInner;
      if (fresh) {
        view.updateState(EditorState.create({ schema, doc: parsed.doc, plugins: plugins() }));
        if (onUpdate) onUpdate(status());
      } else {
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.doc.content).setMeta('origin', origin);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(view.state.selection.from, tr.doc.content.size))));
        view.dispatch(tr);
      }
    },
    getMarkdown() {
      const doc = view.state.doc;
      if (cache.doc === doc && cache.fm === fmInner) return cache.text;
      const text = currentFmRaw() + serializeBody(doc, base.baseline);
      cache.doc = doc; cache.fm = fmInner; cache.text = text;
      return text;
    },
    // After a save: make the saved text the new baseline without touching the document, when possible.
    rebase(text) {
      const parsed = parseMarkdown(text);
      if (parsed.doc.eq(view.state.doc)) {
        base = { fmRaw: parsed.fmRaw, fmInner: parsed.fmInner, baseline: parsed.baseline };
        fmInner = parsed.fmInner;
        cache.doc = null;
        return true;
      }
      api.setMarkdown(text, { fresh: false, origin: 'rebase' });
      return false;
    },
    frontMatter() { return fmInner; },
    setFrontMatter(inner) { fmInner = inner; cache.doc = null; if (onChange) onChange({ origin: 'frontmatter' }); },
    setLocked(v) { locked = !!v; view.setProps({ editable: () => !locked }); if (onUpdate) onUpdate(status()); },
    run(name) {
      const c = commands[name];
      if (!c || locked) return false;
      const ok = c(view.state, view.dispatch, view);
      // link and image hand focus to the popover; everything else keeps the caret in the document
      if (!((name === 'link' && onLinkRequest) || (name === 'image' && onImageRequest))) view.focus();
      return ok;
    },
    status, focus: () => view.focus(),
    destroy: () => view.destroy(),
    applyLink: direct.applyLink,
    insertImage: direct.insertImage,
    selectionCoords: () => selectionCoords(view),
    find: {
      state() {
        const s = findKey.getState(view.state);
        return { query: s.query, count: s.matches.length, current: s.current };
      },
      // Set the query; the current match becomes the first one at or after the selection.
      set(query, caseSensitive = false) {
        const st = view.state;
        const probe = findMatches(st.doc, query, caseSensitive);
        const from = st.selection.from;
        let current = probe.findIndex((m) => m.from >= from);
        if (current < 0) current = probe.length ? 0 : -1;
        view.dispatch(st.tr.setMeta(findKey, { query, caseSensitive, current }));
        return api.find.state();
      },
      step(delta) {
        const s = findKey.getState(view.state);
        if (!s.matches.length) return api.find.state();
        const current = (s.current + delta + s.matches.length) % s.matches.length;
        const m = s.matches[current];
        view.dispatch(view.state.tr.setMeta(findKey, { current }).setSelection(TextSelection.create(view.state.doc, m.from, m.to)).scrollIntoView());
        return api.find.state();
      },
      next() { return api.find.step(1); },
      prev() { return api.find.step(-1); },
      replace(text) {
        const s = findKey.getState(view.state);
        const m = s.matches[s.current];
        if (!m || locked) return api.find.state();
        view.dispatch(view.state.tr.insertText(text, m.from, m.to).scrollIntoView());
        return api.find.state();
      },
      replaceAll(text) {
        const s = findKey.getState(view.state);
        if (!s.matches.length || locked) return 0;
        let tr = view.state.tr;
        for (let i = s.matches.length - 1; i >= 0; i--) tr = tr.insertText(text, s.matches[i].from, s.matches[i].to);
        view.dispatch(tr.setMeta(findKey, { current: -1 }));
        return s.matches.length;
      },
      close() { view.dispatch(view.state.tr.setMeta(findKey, { query: '', current: -1 })); },
    },
  };
  return api;
}
