#!/usr/bin/env node
// Local companion. Serves the static app on 127.0.0.1 and adds one optional endpoint that runs the
// `claude` CLI on this machine as the AI reviewer. Zero dependencies. Node 18+.
//
// The hosted version of the app has no server at all; this file exists only for `npm start`.
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REVIEW_SYSTEM_PROMPT, buildReviewInput, parseReview } from './public/review-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4545);
const HOST = '127.0.0.1';
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

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
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
  console.log(`serving ${PUBLIC_DIR}`);
  console.log(`open    http://${HOST}:${PORT}`);
  console.log(`review  local claude CLI (model: ${REVIEW_MODEL}) when available; otherwise your own API key in settings`);
});
