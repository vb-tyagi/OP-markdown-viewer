import { APP_NAME, APP_SLUG, APP_VERSION, REPO_URL, BACKUP_DIR_NAME } from './config.js';
import { guard, applyFixes } from './guard.js';
import * as FS from './fs.js';
import { MODELS, DEFAULT_MODEL, looksLikeKey, reviewWithAnthropic, probeCli, reviewWithCli } from './review.js';
import { createEditor } from './mdeditor.js';
import { diffLines, hunks } from './diff.js';

const $ = (id) => document.getElementById(id);
const els = {
  main: $('main'), list: $('list'), panel: $('panel'), status: $('status'), meta: $('meta'), toast: $('toast'),
  welcome: $('welcome'), toolbar: $('toolbar'), fmtToolbar: $('fmtToolbar'),
  docArea: $('docArea'), fmCard: $('fmCard'), fmEdit: $('fmEdit'), pm: $('pm'), source: $('source'), srcText: $('srcText'),
  folderChip: $('folderChip'), folderName: $('folderName'), count: $('count'), doneCount: $('doneCount'),
  filePicker: $('filePicker'), settings: $('settings'), banner: $('banner'), sidebar: $('sidebar'), blockType: $('blockType'), lockEdit: $('lockEdit'),
  findBar: $('findBar'), findInput: $('findInput'), findCase: $('findCase'), findCount: $('findCount'), replaceInput: $('replaceInput'), fileFilter: $('fileFilter'),
  popover: $('popover'), popView: $('popView'), popHref: $('popHref'), popLinkForm: $('popLinkForm'), popUrl: $('popUrl'), popText: $('popText'), popTextLabel: $('popTextLabel'),
  popLinkError: $('popLinkError'), popImageForm: $('popImageForm'), popImgUrl: $('popImgUrl'), popImgAlt: $('popImgAlt'), popImgError: $('popImgError'),
};

// ---------- persistent settings ----------
const SETTINGS_KEY = `${APP_SLUG}.settings`;
const KEY_NAME = `${APP_SLUG}.anthropic-key`;
const DONE_KEY = `${APP_SLUG}.done`;
// Both optional features are off until the user opts in: direct folder saving is chosen per session on the
// start screen, and the AI reviewer is a setting (`ai`) that defaults to false.
const DEFAULTS = { ai: false, provider: 'auto', model: DEFAULT_MODEL, styleNotes: '', backups: true, reviewOnSave: false, source: false, images: true };
let settings = { ...DEFAULTS, ...loadJSON(SETTINGS_KEY, {}) };

function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function getKey() { try { return sessionStorage.getItem(KEY_NAME) || localStorage.getItem(KEY_NAME) || ''; } catch { return ''; } }
function keyRemembered() { try { return !!localStorage.getItem(KEY_NAME); } catch { return false; } }
function setKey(k, remember) {
  try {
    sessionStorage.removeItem(KEY_NAME);
    localStorage.removeItem(KEY_NAME);
    if (k) (remember ? localStorage : sessionStorage).setItem(KEY_NAME, k);
  } catch {}
}

// ---------- state ----------
let folder = null;
let files = [];
let cur = null; // { name, text, bom, eol, mixed, valid, lastModified }
let cliInfo = null;
let done = loadJSON(DONE_KEY, {});
let samples = null;
let reviewAbort = null;
let saving = false;
let lockedByUser = false;
let sessionInfo = null; // files served by the local companion, if it was started with --dir or --files
let syncTimer = null;
let srcTimer = null;

// ---------- small helpers ----------
function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(els.toast._t);
  els.toast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
}
function setStatus(s) { els.status.textContent = s; }
function currentMarkdown() { return editor.getMarkdown(); }
function isDirty() { return !!cur && currentMarkdown() !== cur.text; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function doneKey(name) { return `${folder ? folder.name : ''}/${name}`; }
function stripFrontMatter(t) { return t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); }
function wordCount(t) { return (stripFrontMatter(t).match(/\S+/g) || []).length; }
function titleFrom(content, fallback) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const t = fm[1].match(/^title:\s*"?(.*?)"?\s*$/m);
    if (t) return t[1];
  }
  const h1 = content.match(/^#\s+(.+)$/m);
  return h1 ? h1[1] : fallback.replace(/\.(md|markdown)$/i, '');
}
function showBanner(text) { els.banner.textContent = text; els.banner.hidden = !text; }
function folderBanner() {
  if (!folder) return '';
  if (folder.kind === 'files') {
    return FS.supportsSavePicker()
      ? 'files mode: saving opens a save dialog, so you choose where each copy goes. your originals stay untouched unless you pick them. to save straight into a folder instead, use “open a folder for direct saving” on the start screen.'
      : 'files mode: saving downloads the edited copy. your originals stay untouched.';
  }
  if (folder.kind === 'sandbox') return 'demo sandbox: these sample files live inside your browser, not on your disk. everything else works exactly like direct folder saving.';
  if (folder.kind === 'session') return `opened from your terminal: ${folder.root}. saves write straight back to these files, with a backup copy first.`;
  return '';
}
function applyAiVisibility() {
  $('review').hidden = !settings.ai;
  $('aiOnSaveLabel').hidden = !settings.ai || !folder;
}

// ---------- sanitizer (shared by the editor for pasted HTML and passthrough blocks) ----------
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
// id/name/class are forbidden so a hostile file cannot clobber lookups or impersonate the app's own UI.
const PURIFY_CFG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'base', 'template'],
  FORBID_ATTR: ['style', 'id', 'name', 'class'],
  ALLOW_DATA_ATTR: false,
};
const sanitize = (html) => DOMPurify.sanitize(html, PURIFY_CFG);
const inPanel = (id) => els.panel.querySelector('#' + id);

// ---------- the editor ----------
const editor = createEditor({
  mount: els.pm,
  sanitize,
  onChange: ({ origin }) => {
    updateMeta();
    refreshActive();
    if (!els.findBar.hidden) updateFindCount();
    if (els.panel.classList.contains('show') && !reviewAbort) hidePanel();
    if (origin !== 'source') scheduleSourceSync();
  },
  onUpdate: updateToolbar,
  onLinkRequest: ({ existing, selectedText, coords }) => openPopover('link', { existing, selectedText, coords }),
  onImageRequest: ({ coords }) => openPopover('image', { coords }),
  loadRemoteImages: () => settings.images,
});

// ---------- link and image popover ----------
let popMode = null; // 'view' | 'link' | 'image'
function placePopover(coords) {
  const area = els.docArea;
  const rect = area.getBoundingClientRect();
  els.popover.hidden = false;
  const w = els.popover.offsetWidth;
  let left = coords.left - rect.left + area.scrollLeft;
  const maxLeft = area.scrollLeft + area.clientWidth - w - 8;
  left = Math.max(area.scrollLeft + 8, Math.min(left, maxLeft));
  const top = coords.bottom - rect.top + area.scrollTop + 8;
  els.popover.style.left = `${Math.round(left)}px`;
  els.popover.style.top = `${Math.round(top)}px`;
}
function openPopover(mode, { existing = null, selectedText = '', coords } = {}) {
  popMode = mode;
  els.popView.hidden = mode !== 'view';
  els.popLinkForm.hidden = mode !== 'link';
  els.popImageForm.hidden = mode !== 'image';
  els.popLinkError.hidden = true;
  els.popImgError.hidden = true;
  if (mode === 'view') {
    els.popHref.textContent = existing.href;
    els.popHref.href = existing.href;
  } else if (mode === 'link') {
    els.popUrl.value = existing ? existing.href : '';
    els.popTextLabel.hidden = !!existing || !!selectedText;
    els.popText.value = '';
  } else {
    els.popImgUrl.value = '';
    els.popImgAlt.value = '';
  }
  placePopover(coords || editor.selectionCoords());
  if (mode === 'link') { els.popUrl.focus(); els.popUrl.select(); }
  if (mode === 'image') els.popImgUrl.focus();
}
function closePopover(refocus = false) {
  if (!popMode) return;
  popMode = null;
  els.popover.hidden = true;
  if (refocus) editor.focus();
}
els.popLinkForm.onsubmit = (e) => {
  e.preventDefault();
  const href = els.popUrl.value.trim();
  const text = els.popText.value.trim();
  if (!href) { editor.run('unlink'); closePopover(true); return; }
  if (!editor.applyLink(href, els.popTextLabel.hidden ? '' : (text || href))) {
    els.popLinkError.textContent = 'only http, https, mailto and tel links are allowed';
    els.popLinkError.hidden = false;
    return;
  }
  closePopover(true);
  updateToolbar(editor.status());
};
els.popImageForm.onsubmit = (e) => {
  e.preventDefault();
  const src = els.popImgUrl.value.trim();
  if (!src || !editor.insertImage(src, els.popImgAlt.value.trim())) {
    els.popImgError.textContent = 'only http, https or relative image URLs are allowed';
    els.popImgError.hidden = false;
    return;
  }
  closePopover(true);
};
$('popLinkCancel').onclick = () => closePopover(true);
$('popImgCancel').onclick = () => closePopover(true);
$('popEdit').onmousedown = (e) => e.preventDefault();
$('popEdit').onclick = () => editor.run('link');
$('popRemove').onmousedown = (e) => e.preventDefault();
$('popRemove').onclick = () => { editor.run('unlink'); closePopover(true); };
for (const inp of [els.popUrl, els.popText, els.popImgUrl, els.popImgAlt]) inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePopover(true); } });
// Clicking into the document dismisses any popover.
els.pm.addEventListener('mousedown', () => closePopover(false));

function updateMeta() {
  if (!cur) { els.meta.textContent = ''; return; }
  const bits = [cur.name, `${wordCount(currentMarkdown())} words`];
  if (isDirty()) bits.push('unsaved');
  if (!cur.valid) bits.push('read-only: not valid UTF-8');
  els.meta.textContent = bits.join(' · ');
}
function refreshFmCard() {
  const inner = editor.frontMatter();
  els.fmCard.hidden = inner == null;
  if (inner != null && els.fmEdit.value !== inner) els.fmEdit.value = inner;
  els.fmEdit.rows = Math.min(14, Math.max(2, (els.fmEdit.value.match(/\n/g) || []).length + 1));
}
function updateToolbar(st) {
  for (const b of els.fmtToolbar.querySelectorAll('button[data-cmd]')) {
    const c = b.dataset.cmd;
    const active = c === 'strong' ? st.strong : c === 'em' ? st.em : c === 'strike' ? st.strike : c === 'code' ? st.code
      : c === 'bullet' ? st.list === 'bullet' : c === 'ordered' ? st.list === 'ordered' : c === 'quote' ? st.quote : c === 'codeblock' ? st.block === 'code' : false;
    b.classList.toggle('active', !!active);
    if (c === 'undo') b.disabled = !st.canUndo;
    if (c === 'redo') b.disabled = !st.canRedo;
  }
  els.blockType.value = ['p', 'h1', 'h2', 'h3'].includes(st.block) ? st.block : 'other';
  els.fmtToolbar.classList.toggle('locked', st.locked);
  els.lockEdit.textContent = st.locked ? 'editing off' : 'read only';
  els.lockEdit.classList.toggle('on', st.locked);
  if (popMode === 'link' || popMode === 'image') return; // a form is open; leave it alone
  if (st.link && !st.locked) {
    if (popMode !== 'view' || els.popHref.href !== st.link.href) openPopover('view', { existing: st.link });
  } else if (popMode === 'view') {
    closePopover(false);
  }
}

// ---------- markdown source pane (two-way) ----------
function applySource() {
  const show = settings.source && !!folder;
  els.main.classList.toggle('with-source', show);
  els.source.hidden = !show;
  if (show) syncSourceFromEditor(true);
}
function scheduleSourceSync() {
  if (!settings.source || !folder) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncSourceFromEditor(false), 150);
}
function syncSourceFromEditor(force) {
  if (!force && document.activeElement === els.srcText) return;
  const t = currentMarkdown();
  if (els.srcText.value !== t) els.srcText.value = t;
}
els.srcText.addEventListener('input', () => {
  clearTimeout(srcTimer);
  srcTimer = setTimeout(() => {
    if (!cur) return;
    editor.setMarkdown(els.srcText.value, { fresh: false, origin: 'source' });
    refreshFmCard();
  }, 250);
});
els.fmEdit.addEventListener('input', () => {
  editor.setFrontMatter(els.fmEdit.value);
  els.fmEdit.rows = Math.min(14, Math.max(2, (els.fmEdit.value.match(/\n/g) || []).length + 1));
});

// ---------- sidebar ----------
function fileMatchesFilter(f) {
  const q = els.fileFilter.value.trim().toLowerCase();
  return !q || f.name.toLowerCase().includes(q) || f.title.toLowerCase().includes(q);
}
function renderList() {
  els.list.innerHTML = '';
  let d = 0;
  let shown = 0;
  files.forEach((f, i) => {
    const li = document.createElement('li');
    li.dataset.name = f.name;
    if (!fileMatchesFilter(f)) li.hidden = true; else shown++;
    if (done[doneKey(f.name)]) { li.classList.add('done'); d++; }
    if (cur && cur.name === f.name) { li.classList.add('active'); if (isDirty()) li.classList.add('dirty'); }
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1).padStart(2, '0');
    const t = document.createElement('span'); t.className = 't'; t.textContent = f.title;
    const w = document.createElement('span'); w.className = 'w'; w.textContent = `${f.words}w`;
    li.append(n, t, w);
    li.onclick = () => open(f.name);
    els.list.appendChild(li);
  });
  els.count.textContent = shown === files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : `${shown} of ${files.length} files`;
  els.doneCount.textContent = `${d} done`;
}
els.fileFilter.addEventListener('input', renderList);
els.fileFilter.addEventListener('keydown', (e) => { if (e.key === 'Escape') { els.fileFilter.value = ''; renderList(); els.fileFilter.blur(); } });

// ---------- find & replace ----------
function updateFindCount() {
  const s = editor.find.state();
  els.findCount.textContent = !s.query ? '' : s.count ? `${s.current + 1} of ${s.count}` : 'no matches';
}
function openFind() {
  if (!cur) return;
  els.findBar.hidden = false;
  const selText = editor.view.state.doc.textBetween(editor.view.state.selection.from, editor.view.state.selection.to, ' ');
  if (selText && !selText.includes('\n') && selText.length < 200) els.findInput.value = selText;
  els.findInput.focus();
  els.findInput.select();
  editor.find.set(els.findInput.value, els.findCase.checked);
  updateFindCount();
}
function closeFind() {
  els.findBar.hidden = true;
  editor.find.close();
  updateFindCount();
  editor.focus();
}
els.findInput.addEventListener('input', () => { editor.find.set(els.findInput.value, els.findCase.checked); updateFindCount(); });
els.findCase.addEventListener('change', () => { editor.find.set(els.findInput.value, els.findCase.checked); updateFindCount(); });
els.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? editor.find.prev() : editor.find.next(); updateFindCount(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
els.replaceInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); editor.find.replace(els.replaceInput.value); updateFindCount(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('findNext').onclick = () => { editor.find.next(); updateFindCount(); };
$('findPrev').onclick = () => { editor.find.prev(); updateFindCount(); };
$('replaceOne').onclick = () => { editor.find.replace(els.replaceInput.value); updateFindCount(); };
$('replaceAll').onclick = () => { const n = editor.find.replaceAll(els.replaceInput.value); updateFindCount(); toast(n ? `replaced ${n} occurrence${n === 1 ? '' : 's'}` : 'nothing to replace'); };
$('findClose').onclick = closeFind;
$('findOpen').onclick = openFind;
function refreshActive() {
  for (const li of els.list.children) {
    const active = !!cur && li.dataset.name === cur.name;
    li.classList.toggle('active', active);
    li.classList.toggle('dirty', active && isDirty());
  }
}

// ---------- folder lifecycle ----------
async function mountFolder(f) {
  folder = f;
  cur = null;
  hidePanel();
  const listed = await folder.list();
  files = [];
  for (const it of listed) {
    let title = it.name.replace(/\.(md|markdown)$/i, '');
    let words = 0;
    try { const r = await folder.read(it.name); title = titleFrom(r.text, it.name); words = wordCount(r.text); } catch {}
    files.push({ ...it, title, words });
  }
  els.main.classList.remove('no-folder');
  els.welcome.hidden = true;
  els.toolbar.hidden = false;
  els.fmtToolbar.hidden = false;
  els.docArea.hidden = false;
  els.sidebar.hidden = false;
  els.folderChip.hidden = false;
  $('toggleFiles').hidden = !window.matchMedia('(max-width: 900px)').matches;
  els.folderName.textContent = folder.kind === 'sandbox' ? 'demo sandbox' : folder.kind === 'files' ? `${files.length} file${files.length === 1 ? '' : 's'} (copies)` : folder.kind === 'session' ? `${folder.name} (terminal)` : `${folder.name} (direct)`;
  $('saveLabel').textContent = folder.canWrite ? 'save' : 'save a copy';
  $('toggleSource').hidden = false;
  applyAiVisibility();
  $('resetDemo').hidden = folder.kind !== 'sandbox';
  applySource();
  showBanner(folderBanner());
  renderList();
  if (!files.length) { setStatus('no markdown files found'); showBanner('no .md files were found. in files mode, pick one or more .md files; in direct mode, the folder must contain .md files at its top level.'); return; }
  let h = '';
  try { h = decodeURIComponent(location.hash.slice(1)); } catch {}
  await open(files.some((x) => x.name === h) ? h : files[0].name);
  setStatus('ready');
}

async function open(name) {
  if (!folder) return;
  if (cur && cur.name === name) return;
  if (isDirty() && !confirm('you have unsaved changes. discard them?')) return;
  if (reviewAbort) reviewAbort.abort();
  let r;
  try { r = await folder.read(name); } catch (e) { alert('could not read the file: ' + e.message); return; }
  cur = { name, text: r.text, bom: r.bom, eol: r.eol, mixed: r.mixed, valid: r.valid, lastModified: r.lastModified };
  editor.setMarkdown(r.text, { fresh: true });
  editor.setLocked(lockedByUser || !r.valid);
  refreshFmCard();
  els.srcText.value = r.text;
  els.docArea.scrollTop = 0;
  hidePanel();
  renderList();
  updateMeta();
  history.replaceState(null, '', '#' + encodeURIComponent(name));
  if (document.body.classList.contains('drawer-open')) setDrawer(false);
  $('markDone').textContent = done[doneKey(name)] ? 'unmark done' : 'mark done';
  setStatus(r.valid ? 'loaded' : 'opened read-only: the file is not valid UTF-8');
  showBanner(r.mixed ? 'this file has mixed line endings. the editor shows it with LF endings, and saving will write LF throughout.' : folderBanner());
}
function idx() { return cur ? files.findIndex((f) => f.name === cur.name) : -1; }
function go(delta) { const n = files[idx() + delta]; if (n) open(n.name); }

// ---------- guard panel ----------
function hidePanel() { els.panel.classList.remove('show'); els.panel.innerHTML = ''; els.panel.dataset.kind = ''; }
function issueList(issues) {
  if (!issues.length) return '<ul><li class="info"><span class="sev">ok</span>nothing flagged</li></ul>';
  return '<ul>' + issues.map((i) =>
    `<li class="${esc(i.severity)}"><span class="sev">${esc(i.severity)}</span>${esc(i.what)}` +
    (i.detail ? `<span class="detail">${esc(i.detail)}</span>` : '') +
    (i.where ? `<span class="detail">${esc(i.where)}</span>` : '') + '</li>').join('') + '</ul>';
}
function aiHtml(ai) {
  if (ai.pending) return `<div class="row"><span class="badge pending">AI reviewer</span><span class="spin"></span><span>reading original and edited versions${ai.estimate ? ` (${esc(ai.estimate)})` : ''}…</span><button id="cancelReview" class="small">cancel</button></div>`;
  if (ai.none) return `<div class="row"><span class="badge pending">AI reviewer</span><span>not configured. add your Anthropic API key in settings, or run the local companion.</span><button id="openSettingsInline" class="small">settings</button></div>`;
  if (!ai.ok) return `<div class="row"><span class="badge warn">AI reviewer</span><span>${esc(ai.error)}</span></div>`;
  const r = ai.review;
  const cost = ai.costUsd != null ? ` · ~$${ai.costUsd.toFixed(3)}` : '';
  const via = ai.provider === 'cli' ? 'local claude CLI' : ai.model;
  return `<div class="row"><span class="badge ${esc(r.verdict)}">AI reviewer · ${esc(r.verdict)}</span><span>${esc(r.summary)}</span><span class="fine">${esc(via)} · ${(ai.ms / 1000).toFixed(1)}s${cost}</span></div>` + issueList(r.issues);
}
function wireAiButtons() {
  const c = inPanel('cancelReview'); if (c) c.onclick = () => { if (reviewAbort) reviewAbort.abort(); };
  const s = inPanel('openSettingsInline'); if (s) s.onclick = () => openSettings(false);
}
// "What will change": a line diff between the file as loaded and what would be written.
const DIFF_MAX_LINES = 400;
function diffElement(before, after) {
  const d = diffLines(before, after);
  const details = document.createElement('details');
  details.className = 'diff';
  const summary = document.createElement('summary');
  if (!d.changed) {
    summary.textContent = 'what will change: nothing, the file is identical';
    details.appendChild(summary);
    return details;
  }
  summary.textContent = `what will change: ${d.added} line${d.added === 1 ? '' : 's'} added, ${d.removed} removed`;
  details.appendChild(summary);
  details.open = true;
  const pre = document.createElement('div');
  pre.className = 'diff-body';
  let shown = 0;
  for (const h of hunks(d.ops, 2)) {
    if (h.type === 'skip') {
      const s = document.createElement('div');
      s.className = 'diff-skip';
      s.textContent = `… ${h.count} unchanged line${h.count === 1 ? '' : 's'} …`;
      pre.appendChild(s);
      continue;
    }
    for (const l of h.lines) {
      if (shown++ > DIFF_MAX_LINES) break;
      const row = document.createElement('div');
      row.className = 'diff-line ' + l.type;
      const sign = document.createElement('span');
      sign.className = 'diff-sign';
      sign.textContent = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
      row.appendChild(sign);
      const text = document.createElement('span');
      text.className = 'diff-text';
      if (l.note) {
        text.textContent = `(${l.note})`;
      } else if (l.parts) {
        text.append(l.parts.pre);
        const mid = document.createElement('mark');
        mid.textContent = l.parts.mid;
        text.append(mid, l.parts.post);
      } else {
        text.textContent = l.line;
      }
      row.appendChild(text);
      pre.appendChild(row);
    }
  }
  if (shown > DIFF_MAX_LINES) {
    const more = document.createElement('div');
    more.className = 'diff-skip';
    more.textContent = `… only the first ${DIFF_MAX_LINES} changed lines are shown …`;
    pre.appendChild(more);
  }
  details.appendChild(pre);
  return details;
}

function showGuard(g, { forSave = false, ai = null } = {}) {
  els.panel.dataset.kind = 'guard';
  const label = g.verdict === 'clean' ? 'formatting preserved' : g.verdict === 'warn' ? 'warnings' : 'damage detected';
  let html = `<div class="row"><span class="badge ${esc(g.verdict)}">${label}</span><span>${esc(g.summary)}</span></div>`;
  html += '<div id="diffSlot"></div>';
  html += issueList(g.issues);
  html += '<div class="actions">';
  if (g.fixes && g.fixes.length) html += `<button id="applyFixes">apply safe fixes (${esc(g.fixes.join(', '))})</button>`;
  if (forSave) {
    html += `<button id="confirmSave" class="primary">${g.verdict === 'clean' ? 'save' : 'save anyway'}</button>`;
    html += '<button id="cancelSave">cancel</button>';
  }
  html += '</div>';
  if (ai) html += `<div class="section" id="aiSection">${aiHtml(ai)}</div>`;
  els.panel.innerHTML = html;
  els.panel.classList.add('show');
  if (cur) inPanel('diffSlot').replaceWith(diffElement(cur.text, currentMarkdown()));
  const af = inPanel('applyFixes');
  if (af) af.onclick = () => {
    editor.setMarkdown(applyFixes(currentMarkdown(), g.fixes), { fresh: false, origin: 'fix' });
    refreshFmCard(); updateMeta(); refreshActive(); toast('fixes applied');
    forSave ? saveFlow() : runCheck();
  };
  const cs = inPanel('confirmSave');
  if (cs) cs.onclick = () => {
    // The text may have changed since the verdict was shown; never save on a stale verdict.
    const now = guard(cur.text, currentMarkdown());
    if (JSON.stringify(now.issues) !== JSON.stringify(g.issues)) {
      showGuard(now, { forSave: true });
      toast('the text changed, so it was checked again');
      return;
    }
    doSave();
  };
  const cc = inPanel('cancelSave'); if (cc) cc.onclick = hidePanel;
  wireAiButtons();
}
function setAiSection(ai) { const sec = inPanel('aiSection'); if (sec) { sec.innerHTML = aiHtml(ai); wireAiButtons(); } }

function runCheck() {
  if (!cur) return null;
  const g = guard(cur.text, currentMarkdown());
  showGuard(g);
  setStatus('checked');
  return g;
}

function resolveProvider() {
  if (!settings.ai) return null; // the reviewer is opt-in
  const p = settings.provider;
  if (p === 'off') return null;
  if (p === 'cli') return cliInfo ? 'cli' : null;
  if (p === 'anthropic') return getKey() ? 'anthropic' : null;
  if (cliInfo) return 'cli';
  if (getKey()) return 'anthropic';
  return null;
}

function reviewEstimate(provider) {
  const chars = cur.text.length + currentMarkdown().length;
  const kb = (chars / 1024).toFixed(0);
  if (provider !== 'anthropic') return `${kb} KB via local CLI`;
  const m = MODELS.find((x) => x.id === settings.model) || MODELS[0];
  const usd = ((chars / 4) * m.input) / 1e6 + (300 * m.output) / 1e6;
  return `${kb} KB to ${m.id}, about $${usd.toFixed(3)}`;
}

async function runReviewInto(g, forSave) {
  if (reviewAbort) reviewAbort.abort();
  const provider = resolveProvider();
  showGuard(g, { forSave, ai: provider ? { pending: true, estimate: reviewEstimate(provider) } : { none: true } });
  if (!provider) { setStatus('no reviewer configured'); return null; }
  setStatus('AI reviewing…');
  reviewAbort = new AbortController();
  const args = { name: cur.name, original: cur.text, edited: currentMarkdown(), styleNotes: settings.styleNotes, signal: reviewAbort.signal };
  let ai;
  try {
    const r = provider === 'cli' ? await reviewWithCli(args) : await reviewWithAnthropic({ ...args, apiKey: getKey(), model: settings.model });
    ai = { ok: true, ...r };
  } catch (e) {
    ai = { ok: false, error: e.name === 'AbortError' ? 'cancelled' : e.message };
  }
  reviewAbort = null;
  setAiSection(ai);
  setStatus(ai.ok ? 'AI review done' : 'AI review failed');
  return ai;
}

// ---------- save ----------
async function saveFlow() {
  if (!cur || saving) return;
  if (!isDirty()) { toast('no changes'); return; }
  if (!cur.valid) { alert('this file is not valid UTF-8 and was opened read-only.'); return; }
  const g = guard(cur.text, currentMarkdown());
  if (settings.ai && settings.reviewOnSave) { await runReviewInto(g, true); return; } // the user confirms in the panel
  if (g.verdict === 'clean') return doSave();
  showGuard(g, { forSave: true });
  setStatus('needs your call');
}

async function doSave(force = false) {
  if (!cur || saving) return;
  saving = true;
  $('save').disabled = true;
  setStatus('saving…');
  const text = currentMarkdown();
  const opts = { bom: cur.bom, eol: cur.eol };
  try {
    if (!folder.canWrite) {
      // files mode: never touch the original; the user picks where the copy goes.
      let r;
      try {
        r = await FS.saveCopy(cur.name, text, opts);
      } catch (e) {
        if (e && e.name === 'AbortError') { setStatus('save cancelled'); return; }
        throw e;
      }
      cur.text = text;
      editor.rebase(text);
      finishSave(r.method === 'save-as' ? `saved a copy as ${r.name} (${r.bytes} bytes)` : `downloaded ${r.name} (${r.bytes} bytes)`);
      toast(r.method === 'save-as' ? 'copy saved ✓' : 'downloaded ✓');
      return;
    }
    if (!force) {
      let st = null;
      try { st = await folder.stat(cur.name); } catch {}
      if (st && st.lastModified !== cur.lastModified) {
        saving = false; $('save').disabled = false;
        if (confirm('this file changed on disk since you opened it (another program saved it). overwrite the disk version with yours?')) return doSave(true);
        setStatus('save cancelled');
        return;
      }
    }
    let backupLabel = null;
    if (settings.backups && folder.canBackup && !folder.serverBackups) {
      try {
        backupLabel = await folder.backup(cur.name, cur.text, opts);
      } catch (e) {
        saving = false; $('save').disabled = false;
        if (!confirm(`the backup copy could not be written (${e.message}). save without a backup?`)) { setStatus('save cancelled'); return; }
        saving = true; $('save').disabled = true;
      }
    }
    const r = await folder.write(cur.name, text, { ...opts, backup: settings.backups, expectMtime: cur.lastModified, force });
    cur.text = text;
    cur.lastModified = r.lastModified;
    editor.rebase(text);
    backupLabel = backupLabel || r.backup || null;
    finishSave(`saved ${r.bytes} bytes${backupLabel ? ' · backup kept' : ''}`);
    toast('saved to disk ✓');
  } catch (e) {
    if (e && e.conflict) {
      saving = false; $('save').disabled = false;
      if (confirm('this file changed on disk since you opened it (another program saved it). overwrite the disk version with yours?')) return doSave(true);
      setStatus('save cancelled');
      return;
    }
    setStatus('save FAILED');
    alert('save failed: ' + e.message);
  } finally {
    saving = false;
    $('save').disabled = false;
  }
}
function finishSave(status) {
  const f = files.find((x) => x.name === cur.name);
  if (f) { f.words = wordCount(cur.text); f.title = titleFrom(cur.text, cur.name); }
  hidePanel(); renderList(); updateMeta(); refreshFmCard(); syncSourceFromEditor(true); setStatus(status);
}

// ---------- settings dialog ----------
const S = Object.fromEntries(["sAiEnabled", "sAiFields", "sBackupDir", "sBackups", "sCancel", "sCliNote", "sForget", "sImages", "sKey", "sModel", "sMode", "sNotes", "sProvider", "sProviderCli", "sRemember", "sReviewOnSave", "sVersion"].map((id) => [id, $(id)]));
function openSettings(focusAi = false) {
  S.sAiEnabled.checked = focusAi ? true : settings.ai;
  S.sAiFields.hidden = !S.sAiEnabled.checked;
  S.sMode.textContent = !folder ? 'no files open yet.' : folder.kind === 'files' ? 'current mode: files. saving writes a copy where you choose; originals are untouched.' : folder.kind === 'sandbox' ? 'current mode: demo sandbox (behaves like direct saving).' : folder.kind === 'session' ? `current mode: files opened from your terminal (${folder.root}); saves write in place through the local companion.` : `current mode: direct saving into “${folder.name}”.`;
  S.sProvider.value = settings.provider;
  S.sProviderCli.hidden = !cliInfo;
  S.sProviderCli.disabled = !cliInfo;
  S.sKey.value = getKey();
  S.sRemember.checked = keyRemembered();
  const sm = S.sModel; sm.innerHTML = '';
  for (const m of MODELS) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; sm.appendChild(o); }
  sm.value = settings.model;
  S.sNotes.value = settings.styleNotes;
  S.sReviewOnSave.checked = settings.reviewOnSave;
  S.sBackups.checked = settings.backups;
  S.sImages.checked = settings.images;
  S.sBackupDir.textContent = BACKUP_DIR_NAME;
  S.sCliNote.hidden = !cliInfo;
  if (cliInfo) S.sCliNote.textContent = `local companion detected: reviews can run through your claude CLI (model: ${cliInfo.model}).`;
  S.sVersion.textContent = `${APP_NAME} v${APP_VERSION}`;
  els.settings.showModal();
}
function saveSettings() {
  const imagesBefore = settings.images;
  const key = S.sKey.value.trim();
  if (key && !looksLikeKey(key) && !confirm('that does not look like an Anthropic API key (they start with sk-ant-). keep it anyway?')) return false;
  setKey(key, S.sRemember.checked);
  settings = {
    ...settings,
    ai: S.sAiEnabled.checked,
    provider: S.sProvider.value || 'auto',
    model: MODELS.some((m) => m.id === S.sModel.value) ? S.sModel.value : (settings.model || DEFAULT_MODEL),
    styleNotes: S.sNotes.value,
    reviewOnSave: S.sReviewOnSave.checked,
    backups: S.sBackups.checked,
    images: S.sImages.checked,
  };
  const imagesChanged = imagesBefore !== settings.images;
  saveJSON(SETTINGS_KEY, settings);
  if (imagesChanged) editor.redraw(); // image nodes pick up the new policy
  $('aiOnSave').checked = settings.reviewOnSave;
  applyAiVisibility();
  toast(settings.ai ? 'settings saved · AI reviewer on' : 'settings saved');
  return true;
}

// ---------- welcome ----------
async function loadSamples() {
  if (samples) return samples;
  const names = await (await fetch('./samples/index.json', { credentials: 'omit' })).json();
  samples = [];
  for (const n of names) {
    if (!FS.isMarkdownName(n)) continue;
    samples.push({ name: n, text: await (await fetch(`./samples/${encodeURIComponent(n)}`, { credentials: 'omit' })).text() });
  }
  return samples;
}
async function showWelcome() {
  const supported = FS.supportsDirectoryPicker();
  $('openFolder').hidden = !supported;
  $('unsupportedNote').hidden = supported;
  $('tryDemo').hidden = !FS.supportsSandbox();
  const last = supported ? await FS.lastFolderName() : null;
  $('reopenFolder').hidden = !last;
  if (last) $('reopenFolder').textContent = `reopen “${last}”`;
  $('backupDirName').textContent = BACKUP_DIR_NAME;
  $('enableAi').textContent = settings.ai ? 'AI reviewer: on (settings)' : 'turn on the AI reviewer';
  $('saveCopyHow').textContent = FS.supportsSavePicker() ? 'a save dialog lets you choose where each copy goes.' : 'each copy is downloaded.';
  const os = $('openSession');
  os.hidden = !sessionInfo;
  if (sessionInfo) os.textContent = `open ${sessionInfo.label} from your terminal (${sessionInfo.files.length} file${sessionInfo.files.length === 1 ? '' : 's'})`;
}
async function tryOpen(fn, label) {
  setStatus(label);
  try {
    const f = await fn();
    if (f) await mountFolder(f);
    else setStatus('ready');
  } catch (e) {
    if (e && e.name === 'AbortError') { setStatus('ready'); return; }
    setStatus('could not open');
    alert(`could not open: ${e.message}`);
  }
}

// ---------- wiring ----------
document.title = APP_NAME;
$('brand').textContent = APP_NAME;
$('welcomeTitle').textContent = APP_NAME;
$('repoLink').href = REPO_URL;
$('aiOnSave').checked = settings.reviewOnSave;

$('openFolder').onclick = () => tryOpen(FS.openFolder, 'choose a folder…');
$('openSession').onclick = () => { if (sessionInfo) tryOpen(async () => FS.openSession(sessionInfo), 'opening your files…'); };
$('reopenFolder').onclick = () => tryOpen(FS.reopenLastFolder, 'reopening…');
$('tryDemo').onclick = () => tryOpen(async () => FS.openSandbox(await loadSamples()), 'loading the demo…');
$('resetDemo').onclick = () => { if (confirm('reset the demo sandbox to the original sample files?')) tryOpen(async () => FS.resetSandbox(await loadSamples()), 'resetting…'); };
function openFileList(list) {
  if (!list || !list.length) return;
  tryOpen(async () => {
    const f = FS.folderFromFiles(list, 'files');
    if (!(await f.list()).length) throw new Error('none of the selected files is a .md or .markdown file');
    return f;
  }, 'reading files…');
}
els.filePicker.onchange = () => { openFileList(els.filePicker.files); els.filePicker.value = ''; };
// Drag files onto the start screen: the same no-permission files mode.
els.welcome.addEventListener('dragover', (e) => { e.preventDefault(); els.welcome.classList.add('drop'); });
els.welcome.addEventListener('dragleave', () => els.welcome.classList.remove('drop'));
els.welcome.addEventListener('drop', (e) => { e.preventDefault(); els.welcome.classList.remove('drop'); openFileList(e.dataTransfer && e.dataTransfer.files); });
$('enableAi').onclick = () => openSettings(!settings.ai);
// narrow screens: the file list is a drawer, the markdown pane is an overlay
const narrow = window.matchMedia('(max-width: 900px)');
function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  $('drawerBackdrop').hidden = !open;
}
$('toggleFiles').onclick = () => setDrawer(!document.body.classList.contains('drawer-open'));
$('drawerBackdrop').onclick = () => setDrawer(false);
$('closeSource').onclick = () => { settings.source = false; saveJSON(SETTINGS_KEY, settings); applySource(); };
narrow.addEventListener('change', () => { if (!narrow.matches) setDrawer(false); $('toggleFiles').hidden = !narrow.matches || !folder; });
// (i) explainers: fixed map, never an arbitrary id from the DOM.
const INFO = { folder: $('infoFolder'), ai: $('infoAi') };
for (const b of document.querySelectorAll('.info-btn')) {
  const d = INFO[b.dataset.info];
  if (d) b.onclick = (e) => { e.preventDefault(); d.showModal(); };
}
for (const d of Object.values(INFO)) d.querySelector('.closeInfo').onclick = () => d.close();
S.sAiEnabled.onchange = () => { S.sAiFields.hidden = !S.sAiEnabled.checked; };
$('changeFolder').onclick = () => {
  if (isDirty() && !confirm('you have unsaved changes. discard them?')) return;
  if (reviewAbort) reviewAbort.abort();
  folder = null; cur = null; files = [];
  editor.setMarkdown('', { fresh: true });
  els.main.classList.add('no-folder');
  els.welcome.hidden = false; els.toolbar.hidden = true; els.fmtToolbar.hidden = true; els.docArea.hidden = true; els.sidebar.hidden = true;
  els.folderChip.hidden = true; $('toggleSource').hidden = true; $('toggleFiles').hidden = true; setDrawer(false); applyAiVisibility(); applySource();
  els.findBar.hidden = true; els.fileFilter.value = '';
  showBanner(''); hidePanel(); updateMeta(); history.replaceState(null, '', location.pathname);
  showWelcome(); setStatus('ready');
};

// formatting toolbar
for (const b of els.fmtToolbar.querySelectorAll('button[data-cmd]')) {
  b.onmousedown = (e) => e.preventDefault(); // keep the editor selection
  b.onclick = () => { if (cur) editor.run(b.dataset.cmd); };
}
els.blockType.onchange = () => { const v = els.blockType.value; if (cur && ['p', 'h1', 'h2', 'h3'].includes(v)) editor.run(v === 'p' ? 'paragraph' : v); };
els.lockEdit.onclick = () => { lockedByUser = !lockedByUser; editor.setLocked(lockedByUser || (cur && !cur.valid)); toast(lockedByUser ? 'reading mode: editing is off' : 'editing is on'); };

$('save').onclick = saveFlow;
$('check').onclick = runCheck;
$('review').onclick = () => { if (cur) runReviewInto(guard(cur.text, currentMarkdown()), false); };
$('prev').onclick = () => go(-1);
$('next').onclick = () => go(1);
$('revert').onclick = () => { if (cur && isDirty() && confirm('discard unsaved changes?')) { editor.setMarkdown(cur.text, { fresh: false, origin: 'revert' }); refreshFmCard(); updateMeta(); refreshActive(); hidePanel(); } };
$('markDone').onclick = () => {
  if (!cur) return;
  const k = doneKey(cur.name);
  done[k] = !done[k];
  if (!done[k]) delete done[k];
  saveJSON(DONE_KEY, done);
  $('markDone').textContent = done[k] ? 'unmark done' : 'mark done';
  renderList();
};
$('aiOnSave').onchange = (e) => { settings.reviewOnSave = e.target.checked; saveJSON(SETTINGS_KEY, settings); };
$('toggleSource').onclick = () => { settings.source = !settings.source; saveJSON(SETTINGS_KEY, settings); applySource(); };
$('openSettings').onclick = () => openSettings(false);
S.sCancel.onclick = () => els.settings.close();
S.sForget.onclick = () => { setKey('', false); S.sKey.value = ''; S.sRemember.checked = false; toast('key forgotten'); };
$('settingsForm').onsubmit = (e) => { e.preventDefault(); if (saveSettings()) els.settings.close(); };

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveFlow(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); if (folder) { els.fileFilter.focus(); els.fileFilter.select(); } }
  else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
  else if (e.key === 'Escape' && !els.findBar.hidden && (document.activeElement === els.findInput || document.activeElement === els.replaceInput)) { e.preventDefault(); closeFind(); }
  else if (mod && e.key === ']') { e.preventDefault(); go(1); }
  else if (mod && e.key === '[') { e.preventDefault(); go(-1); }
  else if (mod && e.key === '/') { e.preventDefault(); if (folder) $('toggleSource').click(); }
  else if (e.key === 'Escape' && els.panel.classList.contains('show') && !els.settings.open) hidePanel();
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- boot ----------
(async () => {
  applyAiVisibility();
  sessionInfo = await FS.probeSession();
  await showWelcome();
  cliInfo = await probeCli();
  setStatus('ready');
  // Files handed over by the terminal (or the /vbt-review-markdown skill) open straight away.
  if (sessionInfo && !folder) await tryOpen(async () => FS.openSession(sessionInfo), 'opening your files…');
})();
