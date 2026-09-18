#!/usr/bin/env node
// Picks a port that nothing on this machine appears to be listening on. Used by `npm start`, by the
// /vbt-review-markdown skill, and on its own: `npm run port` or `node scripts/free-port.mjs`.
//
// Three checks, because each alone has blind spots:
//   1. `lsof` (listening sockets of processes this user can see)
//   2. `netstat` / `ss` (listening sockets of every user, where the tool exists)
//   3. an actual bind on 127.0.0.1 and on ::1, which is authoritative for the addresses we use
// Candidates start at 4545 (a memorable 4-digit port outside the crowded 3000/5173/8000 ranges)
// and walk upward until one passes every check. Nothing here can see a port another process is
// about to take a millisecond later, so the server also retries if listen() still fails.
import net from 'node:net';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_START = 4545;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Ports with a listening socket, from whichever tools exist. Best effort; missing tools are skipped.
export async function listeningPorts() {
  const set = new Set();
  const lsof = await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']);
  if (lsof) for (const m of lsof.matchAll(/[:.](\d+)\s+\(LISTEN\)/g)) set.add(Number(m[1]));
  const netstat = await run('netstat', process.platform === 'darwin' ? ['-an', '-p', 'tcp'] : ['-lnt']);
  if (netstat) for (const line of netstat.split('\n')) if (/LISTEN/.test(line)) { const m = line.match(/[:.](\d+)\s+(?:[*\d.:]+\s+)?(?:LISTEN|\S+\s+LISTEN)/); if (m) set.add(Number(m[1])); }
  const ss = process.platform === 'linux' ? await run('ss', ['-lnt']) : null;
  if (ss) for (const m of ss.matchAll(/[:\]](\d+)\s/g)) set.add(Number(m[1]));
  return set;
}

// True when a listener can be created on host:port right now. Any error other than "this address
// family is not available" counts as taken.
export function canBind(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', (e) => resolve(e && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

export async function findFreePort({ start = DEFAULT_START, host = '127.0.0.1', limit = 300 } = {}) {
  const taken = await listeningPorts();
  const first = Number.isInteger(start) && start > 0 && start < 65536 ? start : DEFAULT_START;
  for (let p = first; p < Math.min(65536, first + limit); p++) {
    if (taken.has(p)) continue;
    if (!(await canBind(p, host))) continue;
    if (host === '127.0.0.1' && !(await canBind(p, '::1'))) continue; // localhost may resolve to ::1
    return p;
  }
  throw new Error(`no free port found between ${first} and ${first + limit - 1}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.find((a) => a.startsWith('--start='));
  const start = arg ? Number(arg.split('=')[1]) : DEFAULT_START;
  findFreePort({ start }).then((p) => { process.stdout.write(String(p) + '\n'); }, (e) => { console.error(e.message); process.exit(1); });
}
