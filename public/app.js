import { APP_NAME, APP_SLUG, APP_VERSION, REPO_URL, BACKUP_DIR_NAME } from './config.js';
import { guard, applyFixes } from './guard.js';
import * as FS from './fs.js';
import { MODELS, DEFAULT_MODEL, looksLikeKey, reviewWithAnthropic, probeCli, reviewWithCli } from './review.js';

const $ = (id) => document.getElementById(id);
const els = {
  main: $('main'), list: $('list'), ta: $('ta'), panel: $('panel'), status: $('status'), meta: $('meta'), toast: $('toast'),
  welcome: $('welcome'), toolbar: $('toolbar'), preview: $('preview'), fm: $('fm'), article: $('article'),
  folderChip: $('folderChip'), folderName: $('folderName'), count: $('count'), doneCount: $('doneCount'),
  filePicker: $('filePicker'), settings: $('settings'), banner: $('banner'), sidebar: $('sidebar'),
};

// ---------- persistent settings ----------
const SETTINGS_KEY = `${APP_SLUG}.settings`;
const KEY_NAME = `${APP_SLUG}.anthropic-key`;
const DONE_KEY = `${APP_SLUG}.done`;
const DEFAULTS = { provider: 'auto', model: DEFAULT_MODEL, styleNotes: '', backups: true, reviewOnSave: false, preview: true };
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

// ---------- small helpers ----------
function toast(msg, ms = 2200) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(els.toast._t);
  els.toast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
}
function setStatus(s) { els.status.textContent = s; }
function isDirty() { return !!cur && els.ta.value !== cur.text; }
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
  return h1 ? h1[1] : fallback.replace(/\.md$/i, '');
}
function showBanner(text) { els.banner.textContent = text; els.banner.hidden = !text; }
function folderBanner() {
  if (!folder) return '';
  if (folder.kind === 'fallback') return 'read-only browser mode: this browser cannot write to your folder, so "save" downloads the edited copy instead. Chrome, Edge, Brave, and Arc can save in place.';
  if (folder.kind === 'sandbox') return 'demo sandbox: these sample files live inside your browser, not on your disk. everything else works exactly like a real folder.';
  return '';
}

// ---------- preview ----------
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
const inPanel = (id) => els.panel.querySelector('#' + id);
let renderTimer;
function render() {
  const raw = els.ta.value;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) { els.fm.hidden = false; els.fm.textContent = m[1]; } else { els.fm.hidden = true; }
  const body = m ? raw.slice(m[0].length) : raw;
  let html = '';
  try { html = marked.parse(body, { gfm: true, breaks: false }); } catch { html = `<pre>${esc(body)}</pre>`; }
  els.article.innerHTML = DOMPurify.sanitize(html, PURIFY_CFG);
}
function applyPreview() {
  els.main.classList.toggle('no-preview', !settings.preview);
  els.preview.hidden = !settings.preview || !folder;
}
function updateMeta() {
  if (!cur) { els.meta.textContent = ''; return; }
  const bits = [cur.name, `${wordCount(els.ta.value)} words`];
  if (isDirty()) bits.push('unsaved');
  if (!cur.valid) bits.push('read-only: not valid UTF-8');
  els.meta.textContent = bits.join(' · ');
}

// ---------- sidebar ----------
function renderList() {
  els.list.innerHTML = '';
  let d = 0;
  files.forEach((f, i) => {
    const li = document.createElement('li');
    li.dataset.name = f.name;
    if (done[doneKey(f.name)]) { li.classList.add('done'); d++; }
    if (cur && cur.name === f.name) { li.classList.add('active'); if (isDirty()) li.classList.add('dirty'); }
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1).padStart(2, '0');
    const t = document.createElement('span'); t.className = 't'; t.textContent = f.title;
    const w = document.createElement('span'); w.className = 'w'; w.textContent = `${f.words}w`;
    li.append(n, t, w);
    li.onclick = () => open(f.name);
    els.list.appendChild(li);
  });
  els.count.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
  els.doneCount.textContent = `${d} done`;
}
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
  els.ta.value = '';
  hidePanel();
  const listed = await folder.list();
  files = [];
  for (const it of listed) {
    let title = it.name.replace(/\.md$/i, '');
    let words = 0;
    try { const r = await folder.read(it.name); title = titleFrom(r.text, it.name); words = wordCount(r.text); } catch {}
    files.push({ ...it, title, words });
  }
  els.main.classList.remove('no-folder');
  els.welcome.hidden = true;
  els.toolbar.hidden = false;
  els.ta.hidden = false;
  els.sidebar.hidden = false;
  els.folderChip.hidden = false;
  els.folderName.textContent = folder.kind === 'sandbox' ? 'demo sandbox' : folder.name;
  $('togglePreview').hidden = false;
  $('aiOnSaveLabel').hidden = false;
  $('resetDemo').hidden = folder.kind !== 'sandbox';
  applyPreview();
  showBanner(folderBanner());
  renderList();
  if (!files.length) { setStatus('no .md files in this folder'); return; }
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
  els.ta.value = r.text;
  els.ta.readOnly = !r.valid;
  els.ta.scrollTop = 0;
  hidePanel();
  render();
  renderList();
  updateMeta();
  history.replaceState(null, '', '#' + encodeURIComponent(name));
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
  const s = inPanel('openSettingsInline'); if (s) s.onclick = openSettings;
}
function showGuard(g, { forSave = false, ai = null } = {}) {
  els.panel.dataset.kind = 'guard';
  const label = g.verdict === 'clean' ? 'formatting preserved' : g.verdict === 'warn' ? 'warnings' : 'damage detected';
  let html = `<div class="row"><span class="badge ${esc(g.verdict)}">${label}</span><span>${esc(g.summary)}</span></div>`;
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
  const af = inPanel('applyFixes');
  if (af) af.onclick = () => {
    els.ta.value = applyFixes(els.ta.value, g.fixes);
    render(); updateMeta(); refreshActive(); toast('fixes applied');
    forSave ? saveFlow() : runCheck();
  };
  const cs = inPanel('confirmSave');
  if (cs) cs.onclick = () => {
    // F6: the text may have changed since the verdict was shown; never save on a stale verdict.
    const now = guard(cur.text, els.ta.value);
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
  const g = guard(cur.text, els.ta.value);
  showGuard(g);
  setStatus('checked');
  return g;
}

function resolveProvider() {
  const p = settings.provider;
  if (p === 'off') return null;
  if (p === 'cli') return cliInfo ? 'cli' : null;
  if (p === 'anthropic') return getKey() ? 'anthropic' : null;
  if (cliInfo) return 'cli';
  if (getKey()) return 'anthropic';
  return null;
}

function reviewEstimate(provider) {
  const chars = cur.text.length + els.ta.value.length;
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
  const args = { name: cur.name, original: cur.text, edited: els.ta.value, styleNotes: settings.styleNotes, signal: reviewAbort.signal };
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
  const g = guard(cur.text, els.ta.value);
  if (settings.reviewOnSave) { await runReviewInto(g, true); return; } // the user confirms in the panel
  if (g.verdict === 'clean') return doSave();
  showGuard(g, { forSave: true });
  setStatus('needs your call');
}

async function doSave(force = false) {
  if (!cur || saving) return;
  saving = true;
  $('save').disabled = true;
  setStatus('saving…');
  const text = els.ta.value;
  const opts = { bom: cur.bom, eol: cur.eol };
  try {
    if (!folder.canWrite) {
      FS.download(cur.name, text, opts);
      cur.text = text;
      finishSave('downloaded the edited copy');
      toast('downloaded ✓');
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
    if (settings.backups && folder.canBackup) {
      try {
        backupLabel = await folder.backup(cur.name, cur.text, opts);
      } catch (e) {
        saving = false; $('save').disabled = false;
        if (!confirm(`the backup copy could not be written (${e.message}). save without a backup?`)) { setStatus('save cancelled'); return; }
        saving = true; $('save').disabled = true;
      }
    }
    const r = await folder.write(cur.name, text, opts);
    cur.text = text;
    cur.lastModified = r.lastModified;
    finishSave(`saved ${r.bytes} bytes${backupLabel ? ' · backup kept' : ''}`);
    toast('saved to disk ✓');
  } catch (e) {
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
  hidePanel(); renderList(); updateMeta(); setStatus(status);
}

// ---------- settings dialog ----------
const S = Object.fromEntries(["sBackupDir", "sBackups", "sCancel", "sCliNote", "sForget", "sKey", "sModel", "sNotes", "sProvider", "sProviderCli", "sRemember", "sReviewOnSave", "sVersion"].map((id) => [id, $(id)]));
function openSettings() {
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
  S.sBackupDir.textContent = BACKUP_DIR_NAME;
  S.sCliNote.hidden = !cliInfo;
  if (cliInfo) S.sCliNote.textContent = `local companion detected: reviews can run through your claude CLI (model: ${cliInfo.model}).`;
  S.sVersion.textContent = `${APP_NAME} v${APP_VERSION}`;
  els.settings.showModal();
}
function saveSettings() {
  const key = S.sKey.value.trim();
  if (key && !looksLikeKey(key) && !confirm('that does not look like an Anthropic API key (they start with sk-ant-). keep it anyway?')) return false;
  setKey(key, S.sRemember.checked);
  settings = {
    ...settings,
    provider: S.sProvider.value,
    model: S.sModel.value,
    styleNotes: S.sNotes.value,
    reviewOnSave: S.sReviewOnSave.checked,
    backups: S.sBackups.checked,
  };
  saveJSON(SETTINGS_KEY, settings);
  $('aiOnSave').checked = settings.reviewOnSave;
  toast('settings saved');
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
  $('pickFilesLabel').hidden = supported;
  $('unsupportedNote').hidden = supported;
  $('tryDemo').hidden = !FS.supportsSandbox();
  const last = supported ? await FS.lastFolderName() : null;
  $('reopenFolder').hidden = !last;
  if (last) $('reopenFolder').textContent = `reopen “${last}”`;
  $('backupDirName').textContent = BACKUP_DIR_NAME;
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
$('reopenFolder').onclick = () => tryOpen(FS.reopenLastFolder, 'reopening…');
$('tryDemo').onclick = () => tryOpen(async () => FS.openSandbox(await loadSamples()), 'loading the demo…');
$('resetDemo').onclick = () => { if (confirm('reset the demo sandbox to the original sample files?')) tryOpen(async () => FS.resetSandbox(await loadSamples()), 'resetting…'); };
els.filePicker.onchange = () => {
  const list = els.filePicker.files;
  if (!list || !list.length) return;
  const first = list[0].webkitRelativePath || '';
  const name = first.includes('/') ? first.split('/')[0] : 'selected files';
  tryOpen(async () => FS.folderFromFiles(list, name), 'reading files…');
  els.filePicker.value = '';
};
$('changeFolder').onclick = () => {
  if (isDirty() && !confirm('you have unsaved changes. discard them?')) return;
  if (reviewAbort) reviewAbort.abort();
  folder = null; cur = null; files = [];
  els.ta.value = ''; els.article.innerHTML = ''; els.fm.hidden = true;
  els.main.classList.add('no-folder');
  els.welcome.hidden = false; els.toolbar.hidden = true; els.ta.hidden = true; els.preview.hidden = true; els.sidebar.hidden = true;
  els.folderChip.hidden = true; $('togglePreview').hidden = true; $('aiOnSaveLabel').hidden = true;
  showBanner(''); hidePanel(); updateMeta(); history.replaceState(null, '', location.pathname);
  showWelcome(); setStatus('ready');
};

$('save').onclick = saveFlow;
$('check').onclick = runCheck;
$('review').onclick = () => { if (cur) runReviewInto(guard(cur.text, els.ta.value), false); };
$('prev').onclick = () => go(-1);
$('next').onclick = () => go(1);
$('revert').onclick = () => { if (cur && isDirty() && confirm('discard unsaved changes?')) { els.ta.value = cur.text; render(); updateMeta(); refreshActive(); hidePanel(); } };
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
$('togglePreview').onclick = () => { settings.preview = !settings.preview; saveJSON(SETTINGS_KEY, settings); applyPreview(); };
$('openSettings').onclick = openSettings;
S.sCancel.onclick = () => els.settings.close();
S.sForget.onclick = () => { setKey('', false); S.sKey.value = ''; S.sRemember.checked = false; toast('key forgotten'); };
$('settingsForm').onsubmit = (e) => { e.preventDefault(); if (saveSettings()) els.settings.close(); };

els.ta.addEventListener('input', () => {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 120);
  updateMeta();
  refreshActive();
  if (els.panel.classList.contains('show') && !reviewAbort) hidePanel();
});
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveFlow(); }
  else if (mod && e.key === ']') { e.preventDefault(); go(1); }
  else if (mod && e.key === '[') { e.preventDefault(); go(-1); }
  else if (e.key === 'Escape' && els.panel.classList.contains('show') && !els.settings.open) hidePanel();
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- boot ----------
(async () => {
  applyPreview();
  await showWelcome();
  cliInfo = await probeCli();
  setStatus('ready');
})();
