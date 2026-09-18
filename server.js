#!/usr/bin/env node
// Local companion. Serves the static app on 127.0.0.1 and adds two optional things:
//   - an endpoint that runs the `claude` CLI on this machine as the AI reviewer
//   - a "session": markdown files named on the command line (--dir or --files) that the page can
//     open and save through this server, so any browser can save in place. Only those files, ever.
// Zero dependencies. Node 18+. The hosted version of the app has no server at all.
//
//   npm start                        serve the app on the first free port from 4545 upward
//   npm start -- --dir ~/essays      also open every .md in that folder as a session
//   npm start -- --files a.md b.md   or specific files
//   npm start -- --open              open the browser once listening
//   PORT=4600 npm start              ask for a port; if it is busy the next free one is used
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { REVIEW_SYSTEM_PROMPT, buildReviewInput, parseReview } from './public/review-core.js';
import { BACKUP_DIR_NAME } from './public/config.js';
import { findFreePort, DEFAULT_START } from './scripts/free-port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = '127.0.0.1';
const MAX_FILE = 20 * 1024 * 1024;
const MAX_BACKUPS = 30;
// Every /api/* call must carry the key that is printed in the URL at startup. This keeps other
// processes on the same machine (other users on a shared host, sandboxes, WSL) out of the API;
// the same-origin checks below keep other web pages out.
const SESSION_TOKEN = crypto.randomBytes(16).toString('hex');
function hasToken(req) {
  const t = req.headers['x-session-token'];
  return typeof t === 'string' && t.length === SESSION_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(SESSION_TOKEN));
}
const REVIEW_MODEL = process.env.REVIEW_MODEL || 'sonnet';
const REVIEW_TIMEOUT_MS = 120_000;
const MAX_BODY = 2 * 1024 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https://api.anthropic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new Error('expected application/json'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.pause();
        reject(Object.assign(new Error('body too large (2 MB max)'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('invalid JSON')); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new Error('expected a JSON object'));
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

// Only the page served by this process may call the review endpoint: the Host must be loopback
// (defeats DNS rebinding), and any Origin / Sec-Fetch-Site the browser sends must be same-origin.
function sameOrigin(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) return false;
  const origin = req.headers.origin;
  if (origin && origin.toLowerCase() !== `http://${host.toLowerCase()}`) return false;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin') return false;
  return true;
}

function which(cmd) {
  return new Promise((resolve) => {
    const c = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('error', () => resolve(null));
    c.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] : null));
  });
}

let inflight = false;
let currentChild = null;
function runCliReview({ name, original, edited, styleNotes }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
    // Fixed argument list, no shell. --tools '' removes the built-in tools, --strict-mcp-config removes
    // every MCP server (none is passed), --safe-mode drops CLAUDE.md, hooks, plugins and skills,
    // --setting-sources '' skips settings files, and nothing is persisted.
    const args = ['-p', '--model', REVIEW_MODEL, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--safe-mode', '--setting-sources', '', '--system-prompt', REVIEW_SYSTEM_PROMPT];
    const started = Date.now();
    let out = '';
    let err = '';
    let done = false;
    const child = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    currentChild = child;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (currentChild === child) currentChild = null; resolve(v); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `AI review timed out after ${REVIEW_TIMEOUT_MS / 1000}s` }); }, REVIEW_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ ok: false, error: 'could not start the claude CLI: ' + e.message }));
    child.on('close', (code) => {
      const ms = Date.now() - started;
      if (code !== 0) return finish({ ok: false, error: `claude exited ${code}: ${(err || out).slice(0, 300)}`, ms });
      let wrapper = null;
      try { wrapper = JSON.parse(out); } catch {}
      const text = wrapper && typeof wrapper.result === 'string' ? wrapper.result : out;
      const review = parseReview(text);
      if (!review) return finish({ ok: false, error: 'could not parse the reviewer reply: ' + text.slice(0, 300), ms });
      finish({ ok: true, review, ms, model: REVIEW_MODEL, costUsd: wrapper && typeof wrapper.total_cost_usd === 'number' ? wrapper.total_cost_usd : null });
    });
    child.stdin.end(buildReviewInput({ name, original, edited, styleNotes }));
  });
}

// ---------- command line ----------
function usage() {
  console.log('usage: node server.js [--dir <folder> | --files <a.md> <b.md> ...] [--port <n>] [--open]');
}
function parseArgs(argv) {
  const out = { dir: null, files: [], open: false, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.files.push(...argv.slice(i + 1)); break; } // everything after -- is a file name
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--files' || a === '--file') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]); }
    else if (a === '--open') out.open = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`unknown option: ${a} (a file name that starts with -- goes after a bare --)`); usage(); process.exit(2); }
  }
  if (out.dir && out.files.length) { console.error('use either --dir or --files, not both'); process.exit(2); }
  return out;
}
// Under `npm start -- …` the process cwd is the package root; resolve user paths from where npm was run.
const USER_CWD = process.env.INIT_CWD || process.cwd();
const isMdName = (n) => /^[^/\\\x00]+\.(md|markdown)$/i.test(n) && !n.startsWith('.');

// ---------- session: the files named on the command line ----------
async function buildSession(args) {
  if (!args.dir && !args.files.length) return null;
  const files = new Map();
  let root, label, kind;
  const skipped = [];
  if (args.dir) {
    root = path.resolve(USER_CWD, args.dir);
    const st = await fsp.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`--dir is not a folder: ${root}`);
    root = await fsp.realpath(root);
    for (const e of await fsp.readdir(root, { withFileTypes: true })) {
      if (!isMdName(e.name)) continue;
      if (e.isFile()) files.set(e.name, path.join(root, e.name));
      else if (e.isSymbolicLink()) skipped.push(e.name);
    }
    label = path.basename(root);
    kind = 'dir';
  } else {
    for (const f of args.files) {
      const abs = path.resolve(USER_CWD, f);
      const st = await fsp.lstat(abs).catch(() => null);
      if (!st) throw new Error(`not found: ${abs}`);
      if (st.isSymbolicLink()) throw new Error(`${abs} is a symbolic link; pass the real file instead`);
      if (!st.isFile()) throw new Error(`not a file: ${abs}`);
      const name = path.basename(abs);
      if (!isMdName(name)) throw new Error(`not a markdown file: ${abs}`);
      if (files.has(name)) throw new Error(`two files are both called ${name}; use --dir, or rename one`);
      files.set(name, abs);
    }
    root = path.dirname([...files.values()][0]);
    label = `${files.size} file${files.size === 1 ? '' : 's'}`;
    kind = 'files';
  }
  if (skipped.length) console.warn(`skipped ${skipped.length} symbolic link${skipped.length === 1 ? '' : 's'}: ${skipped.join(', ')}`);
  if (!files.size) throw new Error(`no .md or .markdown files found in ${root}`);
  return { root, label, kind, files };
}

function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] || '')) return reject(new Error('expected application/octet-stream'));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { req.pause(); return reject(Object.assign(new Error('file too large (20 MB max)'), { status: 413 })); }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.pause(); reject(Object.assign(new Error('file too large (20 MB max)'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function writeBackup(abs, bytes, mode) {
  const dir = path.join(path.dirname(abs), BACKUP_DIR_NAME, path.basename(abs).replace(/\.(md|markdown)$/i, ''));
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = `${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  await fsp.writeFile(path.join(dir, file), bytes, { mode: mode & 0o777 });
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  for (const n of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) await fsp.rm(path.join(dir, n)).catch(() => {});
  return path.join(BACKUP_DIR_NAME, path.basename(dir), file);
}

// The file must still be the same ordinary file we checked a moment ago: not a symlink, not
// replaced (same inode), and not modified behind our back.
async function checkRegular(abs, before) {
  const st = await fsp.lstat(abs);
  if (!st.isFile()) throw Object.assign(new Error('the file is no longer an ordinary file (a link or a folder is in its place); refusing to touch it'), { status: 409 });
  if (before && (st.ino !== before.ino || Math.abs(st.mtimeMs - before.mtimeMs) > 1)) throw Object.assign(new Error('the file changed on disk while saving; nothing was written'), { status: 409, conflict: true, mtimeMs: st.mtimeMs });
  return st;
}
// Write through a temporary file in the same folder (created exclusively, with an unguessable
// name and the original's permissions), flush it, re-check the target, then rename it into place.
async function atomicWrite(abs, bytes, before) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'wx', before.mode & 0o777);
    await fh.chmod(before.mode & 0o777).catch(() => {});
    await fh.writeFile(bytes);
    await fh.sync();
    await fh.close();
    fh = null;
    await checkRegular(abs, before);
    await fsp.rename(tmp, abs);
    try { const dh = await fsp.open(dir, 'r'); await dh.sync().catch(() => {}); await dh.close(); } catch {}
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function handleSession(req, res, url, session) {
  if (url.pathname === '/api/session') {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    const files = [];
    for (const [name, abs] of session.files) {
      const st = await fsp.lstat(abs).catch(() => null);
      if (st && st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return send(res, 200, { ok: true, label: session.label, kind: session.kind, root: session.root, files });
  }
  const name = url.searchParams.get('name');
  const abs = session.files.get(name);
  if (!abs) return send(res, 404, { error: 'not part of this session' });
  if (req.method === 'GET') {
    const st = await checkRegular(abs);
    const buf = await fsp.readFile(abs);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Mtime-Ms': String(st.mtimeMs) });
    return res.end(buf);
  }
  if (req.method === 'PUT') {
    const body = await readBytes(req, MAX_FILE);
    const mtimeParam = url.searchParams.get('mtime');
    const force = url.searchParams.get('force') === '1';
    const backup = url.searchParams.get('backup') !== '0';
    if (!force && (mtimeParam == null || mtimeParam === '' || !Number.isFinite(Number(mtimeParam)))) return send(res, 400, { ok: false, error: 'mtime is required: the modification time the file had when it was opened' });
    const st = await checkRegular(abs);
    if (!force && Math.abs(st.mtimeMs - Number(mtimeParam)) > 1) return send(res, 409, { ok: false, conflict: true, mtimeMs: st.mtimeMs, error: 'the file changed on disk since it was opened' });
    const current = await fsp.readFile(abs);
    if (current.equals(body)) return send(res, 200, { ok: true, unchanged: true, mtimeMs: st.mtimeMs, bytes: body.length, backup: null });
    let backupLabel = null;
    if (backup) {
      try { backupLabel = await writeBackup(abs, current, st.mode); }
      catch (e) { throw Object.assign(new Error(`the backup copy could not be written (${e.code || 'error'}); nothing was changed. turn backups off in settings to save without one`), { status: 500 }); }
    }
    await atomicWrite(abs, body, st);
    const back = await fsp.readFile(abs);
    if (!back.equals(body)) return send(res, 500, { ok: false, error: 'verification failed: the file on disk does not match what was written' + (backupLabel ? `; previous version kept at ${backupLabel}` : '') });
    const st2 = await fsp.lstat(abs);
    return send(res, 200, { ok: true, mtimeMs: st2.mtimeMs, bytes: body.length, backup: backupLabel });
  }
  return send(res, 405, { error: 'method not allowed' });
}

async function serveStatic(req, res, urlPath) {
  let p;
  try { p = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath); } catch { return send(res, 400, { error: 'bad path' }); }
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || path.basename(full).startsWith('.')) return send(res, 404, { error: 'not found' });
  try {
    const data = await fsp.readFile(full);
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const args = parseArgs(process.argv.slice(2));
let session = null;
try { session = await buildSession(args); } catch (e) { console.error(e.message); process.exit(2); }
const rawPort = Number.isInteger(args.port) ? String(args.port) : (process.env.PORT || '');
const validPort = /^\d{1,5}$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535;
if (rawPort && !validPort) console.warn(`ignoring invalid port "${rawPort}"; ports are whole numbers from 1 to 65535`);
const requested = validPort ? Number(rawPort) : null;
let PORT = await findFreePort({ start: requested || DEFAULT_START, host: HOST });
if (requested && PORT !== requested) {
  if (process.env.STRICT_PORT === '1') { console.error(`port ${requested} is already in use`); process.exit(3); }
  console.warn(`port ${requested} is already in use; using ${PORT} instead`);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    if (typeof req.url !== 'string' || !/^\/(?!\/)/.test(req.url)) return send(res, 400, { error: 'bad request target' });
    url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      if (!hasToken(req)) return send(res, 401, { error: 'unauthorized: open the exact URL the server printed (it contains this session\'s key)' });
    }
    if (session && (url.pathname === '/api/session' || url.pathname === '/api/session/file')) return await handleSession(req, res, url, session);
    if (url.pathname === '/api/cli-status' && req.method === 'GET') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      const found = await which('claude');
      return send(res, 200, found ? { ok: true, model: REVIEW_MODEL } : { ok: false, error: 'claude CLI not found on PATH' });
    }
    if (url.pathname === '/api/cli-review' && req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      if (inflight) return send(res, 429, { ok: false, error: 'a review is already running' });
      const body = await readJson(req);
      const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
      const name = str(body.name, 300);
      const original = str(body.original, MAX_BODY);
      const edited = str(body.edited, MAX_BODY);
      if (name == null || original == null || edited == null) return send(res, 400, { ok: false, error: 'name, original and edited must be strings' });
      if (original === edited) return send(res, 200, { ok: true, review: { verdict: 'clean', issues: [], summary: 'no changes to review' }, ms: 0, model: REVIEW_MODEL });
      inflight = true;
      req.on('close', () => { if (!res.writableEnded && currentChild) currentChild.kill('SIGKILL'); });
      try {
        const r = await runCliReview({ name, original, edited, styleNotes: str(body.styleNotes, 4000) || '' });
        return send(res, r.ok ? 200 : 502, r);
      } finally {
        inflight = false;
      }
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'unknown endpoint' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e && e.status ? e.status : (e && e.code && /^E[A-Z]+$/.test(e.code) ? 500 : 400);
    let message = e && e.message ? e.message : 'bad request';
    if (session) message = message.split(session.root).join('<folder>'); // never echo absolute paths
    send(res, status, { ok: false, error: message, ...(e && e.conflict ? { conflict: true, mtimeMs: e.mtimeMs } : {}) });
    if (status === 413) res.once('finish', () => req.destroy());
  }
});

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message ? e.message : e));

// If the port is taken between the probe and listen(), move on to the next free one instead of dying.
let attempts = 0;
server.on('error', async (e) => {
  if (e && e.code === 'EADDRINUSE' && attempts++ < 20) {
    const next = await findFreePort({ start: PORT + 1, host: HOST });
    console.warn(`port ${PORT} was taken just now; trying ${next}`);
    PORT = next;
    server.listen(PORT, HOST);
    return;
  }
  console.error(`could not listen: ${e && e.message ? e.message : e}`);
  process.exit(3);
});
server.on('listening', () => {
  const urlStr = `http://${HOST}:${PORT}/?t=${SESSION_TOKEN}`;
  console.log(`serving ${PUBLIC_DIR}`);
  console.log(`open    ${urlStr}`);
  if (session) {
    const names = [...session.files.keys()];
    console.log(`files   ${session.label}: ${session.root} (${names.length} markdown file${names.length === 1 ? '' : 's'}; saves write in place, backups in ${BACKUP_DIR_NAME}/)`);
    console.log(`        ${names.slice(0, 20).join(', ')}${names.length > 20 ? `, … and ${names.length - 20} more` : ''}`);
  }
  console.log(`review  local claude CLI (model: ${REVIEW_MODEL}) when available; otherwise your own API key in settings`);
  console.log('key     the ?t= part of the URL is this session\'s key: the page needs it to talk to this server. keep the URL exact');
  if (args.open || process.env.OPEN === '1') {
    const cmd = process.platform === 'darwin' ? ['open', [urlStr]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', urlStr]] : ['xdg-open', [urlStr]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
});
server.listen(PORT, HOST);
