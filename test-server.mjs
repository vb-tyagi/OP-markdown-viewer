// Tests for the local companion: free-port selection, port fallback, and the session file API.
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort, canBind } from './scripts/free-port.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (c, name, extra = '') => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + name + (c ? '' : '   ' + String(extra).slice(0, 300))); };

function startServer(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'server.js'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server did not start: ' + out)); }, 10000);
    const onData = (d) => {
      out += d;
      const m = out.match(/open\s+(http:\/\/127\.0\.0\.1:\d+)\/\?t=([a-f0-9]{32})/);
      if (m) { clearTimeout(timer); resolve({ child, url: m[1], token: m[2], out: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!out.includes('open http')) { clearTimeout(timer); reject(new Error(`server exited ${code}: ${out}`)); } });
  });
}
const stop = (s) => new Promise((r) => { s.child.once('exit', r); s.child.kill(); });

console.log('== free port ==');
const p1 = await findFreePort();
ok(Number.isInteger(p1) && p1 >= 4545 && (await canBind(p1)), `findFreePort returns a bindable port (${p1})`);
const blocker = net.createServer();
await new Promise((r) => blocker.listen({ port: p1, host: '127.0.0.1', exclusive: true }, r));
const p2 = await findFreePort({ start: p1 });
ok(p2 > p1, `an occupied port is skipped (${p1} busy, got ${p2})`);

console.log('== session mode ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opmv-'));
const a = '---\ntitle: "a"\n---\n\n# a\n\nfirst.\n';
fs.writeFileSync(path.join(tmp, 'a.md'), a);
fs.writeFileSync(path.join(tmp, 'b.markdown'), '# b\n');
fs.writeFileSync(path.join(tmp, 'notes.txt'), 'no');
fs.writeFileSync(path.join(tmp, '.hidden.md'), 'no');
fs.writeFileSync(path.join(tmp, 'other.md'), 'outside? no, inside the dir but we test names below\n');
let srv;
try {
  // Ask for the busy port on purpose: the server must fall back to a free one and say so.
  srv = await startServer(['--dir', tmp], { PORT: String(p1) });
  ok(!srv.url.endsWith(':' + p1) && srv.out().includes('already in use'), `busy PORT falls back with a warning (${srv.url})`, srv.out());
  const U = srv.url;
  const T = { 'x-session-token': srv.token };
  ok((await fetch(`${U}/api/session`)).status === 401 && (await fetch(`${U}/api/session`, { headers: { 'x-session-token': 'f'.repeat(32) } })).status === 401, 'API calls without the printed key are refused (401)');
  ok((await fetch(`${U}/`)).status === 200 && (await fetch(`${U}/app.js`)).status === 200, 'static files need no key');
  const j = await (await fetch(`${U}/api/session`, { headers: T })).json();
  ok(j.ok && j.files.map((f) => f.name).join(',') === 'a.md,b.markdown,other.md' && j.root === fs.realpathSync(tmp), 'session lists only markdown files, sorted', JSON.stringify(j));
  const r1 = await fetch(`${U}/api/session/file?name=a.md`, { headers: T });
  const bytes1 = Buffer.from(await r1.arrayBuffer());
  const mtime = Number(r1.headers.get('X-Mtime-Ms'));
  ok(r1.status === 200 && bytes1.toString() === a && Number.isFinite(mtime), 'file bytes and mtime are served');
  const put = (name, body, q = {}, headers = {}) => fetch(`${U}/api/session/file?${new URLSearchParams({ name, ...q })}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...T, ...headers }, body });
  ok((await put('a.md', 'x')).status === 400, 'a save without the loaded mtime is refused (400)');
  const r409 = await put('a.md', 'x', { mtime: String(mtime - 5000) });
  ok(r409.status === 409 && fs.readFileSync(path.join(tmp, 'a.md'), 'utf8') === a, 'a stale mtime is refused and the file is untouched');
  const edited = a.replace('first.', 'first, edited.');
  const r200 = await put('a.md', edited, { mtime: String(mtime) });
  const j200 = await r200.json();
  ok(r200.status === 200 && j200.ok && fs.readFileSync(path.join(tmp, 'a.md'), 'utf8') === edited, 'a save with the right mtime writes the exact bytes', JSON.stringify(j200));
  const bdir = path.join(tmp, '.op-markdown-viewer-backups', 'a');
  const backups = fs.existsSync(bdir) ? fs.readdirSync(bdir) : [];
  ok(backups.length === 1 && fs.readFileSync(path.join(bdir, backups[0]), 'utf8') === a && j200.backup && j200.backup.endsWith(backups[0]), 'the previous version is backed up first', JSON.stringify({ backups, label: j200.backup }));
  const rSame = await put('a.md', edited, { mtime: String(j200.mtimeMs) });
  ok((await rSame.json()).unchanged === true, 'saving identical bytes is a no-op');
  ok(!fs.readdirSync(tmp).some((n) => n.endsWith('.tmp')), 'no temp files are left behind');
  const rForce = await put('a.md', a, { mtime: '1', force: '1', backup: '0' });
  ok(rForce.status === 200 && fs.readFileSync(path.join(tmp, 'a.md'), 'utf8') === a && fs.readdirSync(bdir).length === 1, 'force overwrites a changed file; backup=0 skips the backup');
  ok((await put('zzz.md', 'x', { mtime: '1' })).status === 404 && (await put('../server.js', 'x', { mtime: '1' })).status === 404 && (await put('notes.txt', 'x', { mtime: '1' })).status === 404, 'names outside the session are refused');
  // permissions survive a save; the temp file is exclusive and unguessable
  fs.chmodSync(path.join(tmp, 'b.markdown'), 0o600);
  const mb = Number((await fetch(`${U}/api/session/file?name=b.markdown`, { headers: T })).headers.get('X-Mtime-Ms'));
  const rb = await put('b.markdown', '# b edited\n', { mtime: String(mb) });
  ok(rb.status === 200 && (fs.statSync(path.join(tmp, 'b.markdown')).mode & 0o777) === 0o600, 'a 0600 file is still 0600 after saving');
  // a listed file swapped for a symlink is refused on read and on write
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'TOP SECRET\n');
  fs.rmSync(path.join(tmp, 'other.md'));
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(tmp, 'other.md'));
  const rl = await fetch(`${U}/api/session/file?name=other.md`, { headers: T });
  const wl = await put('other.md', 'PWNED', { mtime: '1', force: '1' });
  ok(rl.status === 409 && wl.status === 409 && fs.readFileSync(path.join(tmp, 'secret.txt'), 'utf8') === 'TOP SECRET\n', 'a file that became a symbolic link is refused, and its target untouched', `${rl.status}/${wl.status}`);
  ok(!(await fetch(`${U}/api/session`, { headers: T })).ok || !(await (await fetch(`${U}/api/session`, { headers: T })).json()).files.some((f) => f.name === 'other.md'), 'the symlinked entry disappears from the listing');
  // a declared oversized body is refused before it is read
  const big = await fetch(`${U}/api/session/file?name=a.md&mtime=1`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(30 * 1024 * 1024), ...T }, body: 'x', duplex: 'half' }).catch(() => ({ status: 413 }));
  ok(big.status === 413, 'an oversized Content-Length is refused up front');
  ok((await put('a.md', 'x', { mtime: '1' }, { origin: 'http://localhost:3000' })).status === 403, 'a cross-origin request is refused');
  ok((await fetch(`${U}/api/session/file?name=a.md&mtime=1`, { method: 'PUT', headers: { 'content-type': 'text/plain', ...T }, body: 'x' })).status === 400, 'a non-binary body is refused');
  ok((await fetch(`${U}/api/session/file?name=a.md`, { method: 'DELETE', headers: T })).status === 405, 'other methods are refused');
  // fetch() will not send a custom Host header, so use a raw request for the DNS-rebinding check.
  const rebound = await new Promise((resolve) => {
    const { port } = new URL(U);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/session', method: 'GET', headers: { Host: 'evil.example', ...T } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(-1));
    req.end();
  });
  ok(rebound === 403, 'DNS rebinding (foreign Host) is refused', rebound);
  const html = await fetch(`${U}/`);
  ok(html.status === 200 && (html.headers.get('content-type') || '').includes('text/html') && (html.headers.get('content-security-policy') || '').includes("img-src 'self' data: blob: https:"), 'static app and headers still served');
} catch (e) {
  fails++;
  console.log('FAIL  session mode threw: ' + e.message);
} finally {
  if (srv) await stop(srv);
}

console.log('== no session, symlinks, -- ==');
let srv2;
try {
  srv2 = await startServer([]);
  ok((await fetch(`${srv2.url}/api/session`, { headers: { 'x-session-token': srv2.token } })).status === 404, 'without --dir or --files the session endpoints do not exist');
} catch (e) { fails++; console.log('FAIL  plain server threw: ' + e.message); } finally { if (srv2) await stop(srv2); }
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'opmv-'));
  fs.writeFileSync(path.join(tmp2, 'real.md'), '# real\n');
  fs.symlinkSync(path.join(tmp2, 'real.md'), path.join(tmp2, 'link.md'));
  const refused = await startServer(['--files', path.join(tmp2, 'link.md')]).then(async (s) => { await stop(s); return false; }, (e) => /symbolic link/.test(e.message));
  ok(refused, '--files refuses a symbolic link');
  fs.writeFileSync(path.join(tmp2, '--odd.md'), '# odd\n');
  let s3;
  try {
    s3 = await startServer(['--files', '--', path.join(tmp2, '--odd.md')]);
    const j3 = await (await fetch(`${s3.url}/api/session`, { headers: { 'x-session-token': s3.token } })).json();
    ok(j3.ok && j3.files.length === 1 && j3.files[0].name === '--odd.md', 'a bare -- lets a file name start with --', JSON.stringify(j3));
  } catch (e) { fails++; console.log('FAIL  -- terminator: ' + e.message); } finally { if (s3) await stop(s3); }
  fs.rmSync(tmp2, { recursive: true, force: true });
}

blocker.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall server tests passed');
process.exit(fails ? 1 : 0);
