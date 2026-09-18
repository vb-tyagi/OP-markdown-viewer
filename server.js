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
import { REVIEW_SYSTEM_PROMPT, buildReviewInput, parseReview } from './public/review-core.js';
import { BACKUP_DIR_NAME } from './public/config.js';
import { findFreePort, DEFAULT_START } from './scripts/free-port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = '127.0.0.1';
const MAX_FILE = 20 * 1024 * 1024;
const MAX_BACKUPS = 30;
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
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--files' || a === '--file') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]); }
    else if (a === '--open') out.open = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`unknown option: ${a}`); usage(); process.exit(2); }
  }
  if (out.dir && out.files.length) { console.error('use either --dir or --files, not both'); process.exit(2); }
  return out;
}
const isMdName = (n) => /^[^/\\\x00]+\.(md|markdown)$/i.test(n) && !n.startsWith('.');

// ---------- session: the files named on the command line ----------
async function buildSession(args) {
  if (!args.dir && !args.files.length) return null;
  const files = new Map();
  let root, label, kind;
  if (args.dir) {
    root = path.resolve(args.dir);
    const st = await fsp.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`--dir is not a folder: ${root}`);
    for (const e of await fsp.readdir(root, { withFileTypes: true })) if (e.isFile() && isMdName(e.name)) files.set(e.name, path.join(root, e.name));
    label = path.basename(root);
    kind = 'dir';
  } else {
    for (const f of args.files) {
      const abs = path.resolve(f);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) throw new Error(`not a file: ${abs}`);
      const name = path.basename(abs);
      if (!isMdName(name)) throw new Error(`not a markdown file: ${abs}`);
      if (files.has(name)) throw new Error(`two files are both called ${name}; use --dir, or rename one`);
      files.set(name, abs);
    }
    root = path.dirname([...files.values()][0]);
    label = `${files.size} file${files.size === 1 ? '' : 's'}`;
    kind = 'files';
  }
  if (!files.size) throw new Error(`no .md or .markdown files found in ${root}`);
  return { root, label, kind, files };
}

function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/octet-stream\b/i.test(req.headers['content-type'] || '')) return reject(new Error('expected application/octet-stream'));
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

async function writeBackup(abs, bytes) {
  const dir = path.join(path.dirname(abs), BACKUP_DIR_NAME, path.basename(abs).replace(/\.(md|markdown)$/i, ''));
  await fsp.mkdir(dir, { recursive: true });
  const file = `${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  await fsp.writeFile(path.join(dir, file), bytes);
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  for (const n of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) await fsp.rm(path.join(dir, n)).catch(() => {});
  return path.join(BACKUP_DIR_NAME, path.basename(dir), file);
}

// Write through a temporary file in the same folder, flush it, then rename over the original.
async function atomicWrite(abs, bytes) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, abs);
}

async function handleSession(req, res, url, session) {
  if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
  if (url.pathname === '/api/session') {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    const files = [];
    for (const [name, abs] of session.files) {
      const st = await fsp.stat(abs).catch(() => null);
      if (st && st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return send(res, 200, { ok: true, label: session.label, kind: session.kind, root: session.root, files });
  }
  const name = url.searchParams.get('name');
  const abs = session.files.get(name);
  if (!abs) return send(res, 404, { error: 'not part of this session' });
  if (req.method === 'GET') {
    const buf = await fsp.readFile(abs);
    const st = await fsp.stat(abs);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Mtime-Ms': String(st.mtimeMs) });
    return res.end(buf);
  }
  if (req.method === 'PUT') {
    const body = await readBytes(req, MAX_FILE);
    const expected = Number(url.searchParams.get('mtime'));
    const force = url.searchParams.get('force') === '1';
    const backup = url.searchParams.get('backup') !== '0';
    const st = await fsp.stat(abs);
    if (!force && Number.isFinite(expected) && Math.abs(st.mtimeMs - expected) > 1) return send(res, 409, { ok: false, conflict: true, mtimeMs: st.mtimeMs, error: 'the file changed on disk since it was opened' });
    const current = await fsp.readFile(abs);
    if (current.equals(body)) return send(res, 200, { ok: true, unchanged: true, mtimeMs: st.mtimeMs, bytes: body.length, backup: null });
    const backupLabel = backup ? await writeBackup(abs, current) : null;
    await atomicWrite(abs, body);
    const back = await fsp.readFile(abs);
    if (!back.equals(body)) return send(res, 500, { ok: false, error: 'verification failed: the file on disk does not match what was written' + (backupLabel ? `; previous version kept at ${backupLabel}` : '') });
    const st2 = await fsp.stat(abs);
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
const requested = Number.isInteger(args.port) ? args.port : (process.env.PORT ? Number(process.env.PORT) : null);
const PORT = await findFreePort({ start: requested || DEFAULT_START, host: HOST });
if (requested && PORT !== requested) {
  if (process.env.STRICT_PORT === '1') { console.error(`port ${requested} is already in use`); process.exit(3); }
  console.warn(`port ${requested} is already in use; using ${PORT} instead`);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
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
    const status = e && e.status ? e.status : 400;
    if (status === 413) res.setHeader('Connection', 'close');
    send(res, status, { error: e && e.message ? e.message : 'bad request' });
    if (status === 413) res.once('finish', () => req.destroy());
  }
});

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message ? e.message : e));

server.listen(PORT, HOST, () => {
  const urlStr = `http://${HOST}:${PORT}`;
  console.log(`serving ${PUBLIC_DIR}`);
  console.log(`open    ${urlStr}`);
  if (session) console.log(`files   ${session.label}: ${session.root} (${session.files.size} markdown file${session.files.size === 1 ? '' : 's'}; saves write in place, backups in ${BACKUP_DIR_NAME}/)`);
  console.log(`review  local claude CLI (model: ${REVIEW_MODEL}) when available; otherwise your own API key in settings`);
  if (args.open || process.env.OPEN === '1') {
    const cmd = process.platform === 'darwin' ? ['open', [urlStr]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', urlStr]] : ['xdg-open', [urlStr]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
});
