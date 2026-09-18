// Folder providers. Every provider exposes the same small interface:
//   kind, name, canWrite, canBackup
//   list()                         -> [{ name, size, lastModified }]
//   read(name)                     -> { text, bom, eol, mixed, valid, lastModified, size }
//   stat(name)                     -> { lastModified, size }
//   write(name, text, {bom, eol})  -> { lastModified, bytes }   atomic, then verified byte for byte
//   backup(name, text, {bom, eol}) -> label
//   listBackups(name) / readBackup(name, stamp)
//
// "fsa"      a real folder on disk via the File System Access API (Chromium browsers)
// "sandbox"  the browser's private origin file system, seeded with sample essays (the demo)
// "fallback" files picked with <input type=file>; saving downloads an edited copy
import { APP_SLUG, BACKUP_DIR_NAME } from './config.js';

const MD_NAME = /^[^/\\\x00]+\.(md|markdown)$/i;
export function isMarkdownName(name) {
  return typeof name === 'string' && MD_NAME.test(name) && !name.startsWith('.');
}

// ---------- bytes <-> text ----------
// Files are handled as bytes so a BOM, CRLF endings, and invalid UTF-8 never get altered silently.
export function decodeBytes(bytes) {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let valid = true;
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    valid = false;
    raw = new TextDecoder('utf-8').decode(bytes);
  }
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/\n/g) || []).length;
  const cr = (raw.match(/\r/g) || []).length;
  // 'crlf' only when every line break is CRLF; that gets restored on save. Anything else with a
  // CR in it is "mixed": the editor normalizes it to LF and the app says so before saving.
  const eol = lf > 0 && crlf === lf && cr === crlf ? 'crlf' : 'lf';
  const mixed = cr > 0 && eol !== 'crlf';
  const text = cr > 0 ? raw.replace(/\r\n?/g, '\n') : raw;
  return { text, bom, eol, mixed, valid };
}

export function encodeText(text, { bom = false, eol = 'lf' } = {}) {
  const out = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
  const body = new TextEncoder().encode(out);
  if (!bom) return body;
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(body, 3);
  return withBom;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function readHandle(fh) {
  const file = await fh.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { ...decodeBytes(bytes), lastModified: file.lastModified, size: file.size };
}

function slugOf(name) {
  return name.replace(/\.(md|markdown)$/i, '');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ---------- directory-handle backed folders (real folder or sandbox) ----------
class HandleFolder {
  constructor(dir, { kind, name }) {
    this.dir = dir;
    this.kind = kind;
    this.name = name;
    this.canWrite = true;
    this.canBackup = true;
  }
  async list() {
    const out = [];
    for await (const [name, handle] of this.dir.entries()) {
      if (handle.kind !== 'file' || !isMarkdownName(name)) continue;
      const f = await handle.getFile();
      out.push({ name, size: f.size, lastModified: f.lastModified });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  async handle(name) {
    if (!isMarkdownName(name)) throw new Error('not a markdown file name');
    return this.dir.getFileHandle(name); // never { create: true }: this tool only edits files that already exist
  }
  async read(name) {
    return readHandle(await this.handle(name));
  }
  async stat(name) {
    const f = await (await this.handle(name)).getFile();
    return { lastModified: f.lastModified, size: f.size };
  }
  async write(name, text, opts) {
    const fh = await this.handle(name);
    const bytes = encodeText(text, opts);
    // createWritable writes to a temporary swap file; close() replaces the original in one step.
    const w = await fh.createWritable();
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch {}
      throw e;
    }
    const f = await fh.getFile();
    const back = new Uint8Array(await f.arrayBuffer());
    if (!bytesEqual(back, bytes)) throw new Error('verification failed: the file on disk does not match what was written');
    return { lastModified: f.lastModified, bytes: bytes.length };
  }
  async backup(name, text, opts) {
    const bdir = await this.dir.getDirectoryHandle(BACKUP_DIR_NAME, { create: true });
    const sub = await bdir.getDirectoryHandle(slugOf(name), { create: true });
    const file = `${stamp()}.md`;
    const fh = await sub.getFileHandle(file, { create: true });
    const w = await fh.createWritable();
    await w.write(encodeText(text, opts));
    await w.close();
    await pruneBackups(sub);
    return `${BACKUP_DIR_NAME}/${slugOf(name)}/${file}`;
  }
  async listBackups(name) {
    try {
      const bdir = await this.dir.getDirectoryHandle(BACKUP_DIR_NAME);
      const sub = await bdir.getDirectoryHandle(slugOf(name));
      const out = [];
      for await (const [n, h] of sub.entries()) {
        if (h.kind === 'file' && n.endsWith('.md')) out.push({ stamp: n.replace(/\.md$/, '') });
      }
      return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
    } catch {
      return [];
    }
  }
  async readBackup(name, stampId) {
    const bdir = await this.dir.getDirectoryHandle(BACKUP_DIR_NAME);
    const sub = await bdir.getDirectoryHandle(slugOf(name));
    return (await readHandle(await sub.getFileHandle(`${stampId}.md`))).text;
  }
}

// Keep the newest MAX_BACKUPS copies per file so the folder cannot grow without bound.
export const MAX_BACKUPS = 30;
async function pruneBackups(sub) {
  const names = [];
  for await (const [n, h] of sub.entries()) if (h.kind === 'file' && n.endsWith('.md')) names.push(n);
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
    try { await sub.removeEntry(n); } catch {}
  }
}

// ---------- files mode: plain File objects picked without any permission; saving writes a copy ----------
class FallbackFolder {
  constructor(fileList, name) {
    this.kind = 'files';
    this.name = name;
    this.canWrite = false;
    this.canBackup = false;
    this.files = new Map();
    for (const f of fileList) {
      const rel = f.webkitRelativePath || '';
      const depth = rel ? rel.split('/').length - 1 : 0; // "folder/file.md" is depth 1
      if (depth > 1 || !isMarkdownName(f.name)) continue;
      this.files.set(f.name, f);
    }
  }
  async list() {
    return [...this.files.values()]
      .map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  file(name) {
    const f = this.files.get(name);
    if (!f) throw new Error('unknown file');
    return f;
  }
  async read(name) {
    const f = this.file(name);
    const bytes = new Uint8Array(await f.arrayBuffer());
    return { ...decodeBytes(bytes), lastModified: f.lastModified, size: f.size };
  }
  async stat(name) {
    const f = this.file(name);
    return { lastModified: f.lastModified, size: f.size };
  }
  async write() {
    throw new Error('files mode never writes to the originals; use saveCopy instead');
  }
  async backup() {
    return null;
  }
  async listBackups() {
    return [];
  }
}

export function folderFromFiles(fileList, name) {
  return new FallbackFolder(fileList, name);
}

// Save a copy wherever the user chooses: a native "save as" dialog where the browser has one,
// otherwise a plain download. Writing to the picked file is verified byte for byte.
export function supportsSavePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}
export async function saveCopy(name, text, opts) {
  const bytes = encodeText(text, opts);
  if (supportsSavePicker()) {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      id: `${APP_SLUG}-save`,
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
    });
    const w = await handle.createWritable();
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch {}
      throw e;
    }
    const f = await handle.getFile();
    const back = new Uint8Array(await f.arrayBuffer());
    if (!bytesEqual(back, bytes)) throw new Error('verification failed: the saved file does not match the editor');
    return { method: 'save-as', name: handle.name, bytes: bytes.length };
  }
  download(name, text, opts);
  return { method: 'download', name, bytes: bytes.length };
}

export function download(name, text, opts) {
  const blob = new Blob([encodeText(text, opts)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- real folders (File System Access API) ----------
export function supportsDirectoryPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function openFolder() {
  const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: `${APP_SLUG}-folder` });
  await idbSet('lastDir', dir);
  return new HandleFolder(dir, { kind: 'fsa', name: dir.name });
}

export async function lastFolderName() {
  const dir = await idbGet('lastDir');
  return dir ? dir.name : null;
}

// Must be called from a user gesture (a click) because it may prompt for permission.
export async function reopenLastFolder() {
  const dir = await idbGet('lastDir');
  if (!dir) return null;
  let p = await dir.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted') p = await dir.requestPermission({ mode: 'readwrite' });
  if (p !== 'granted') throw new Error('permission to the folder was not granted');
  return new HandleFolder(dir, { kind: 'fsa', name: dir.name });
}

export async function forgetLastFolder() {
  await idbDel('lastDir');
}

// ---------- sandbox (origin private file system) ----------
export function supportsSandbox() {
  return typeof navigator !== 'undefined' && !!(navigator.storage && navigator.storage.getDirectory);
}

async function seed(dir, seedFiles) {
  for (const { name, text } of seedFiles) {
    if (!isMarkdownName(name)) continue;
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new TextEncoder().encode(text));
    await w.close();
  }
}

export async function openSandbox(seedFiles) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('sandbox', { create: true });
  const folder = new HandleFolder(dir, { kind: 'sandbox', name: 'demo sandbox' });
  if ((await folder.list()).length === 0) await seed(dir, seedFiles);
  return folder;
}

export async function resetSandbox(seedFiles) {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sandbox', { recursive: true }); } catch {}
  return openSandbox(seedFiles);
}

// ---------- tiny IndexedDB key/value store (directory handles are structured-cloneable) ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(APP_SLUG, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      t.onsuccess = () => resolve(t.result ?? null);
      t.onerror = () => reject(t.error);
    });
  } catch {
    return null;
  }
}
async function idbSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
      t.onsuccess = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {}
}
async function idbDel(key) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readwrite').objectStore('kv').delete(key);
      t.onsuccess = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch {}
}
