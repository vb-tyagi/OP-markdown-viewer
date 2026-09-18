#!/usr/bin/env node
// Picks a port that nothing on this machine is listening on. Used by `npm start`, by the
// /vbt-review-markdown skill, and available on its own: `npm run port` or `node scripts/free-port.mjs`.
//
// Two checks, because either one alone can miss a clash:
//   1. the list of listening sockets (lsof), which also catches servers bound to every interface
//   2. an actual bind on 127.0.0.1, which is authoritative for the port we are about to use
// Candidates start at 4545 (a memorable 4-digit port outside the crowded 3000/5173/8000 ranges)
// and walk upward until one passes both checks.
import net from 'node:net';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_START = 4545;

export function listeningPorts() {
  return new Promise((resolve) => {
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { timeout: 4000 }, (err, stdout) => {
      const set = new Set();
      if (!err && stdout) for (const m of stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g)) set.add(Number(m[1]));
      resolve(set);
    });
  });
}

export function canBind(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

export async function findFreePort({ start = DEFAULT_START, host = '127.0.0.1', limit = 300 } = {}) {
  const taken = await listeningPorts();
  const first = Number.isInteger(start) && start > 0 && start < 65536 ? start : DEFAULT_START;
  for (let p = first; p < Math.min(65536, first + limit); p++) {
    if (taken.has(p)) continue;
    if (await canBind(p, host)) return p;
  }
  throw new Error(`no free port found between ${first} and ${first + limit - 1}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.find((a) => a.startsWith('--start='));
  const start = arg ? Number(arg.split('=')[1]) : DEFAULT_START;
  findFreePort({ start }).then((p) => { process.stdout.write(String(p) + '\n'); }, (e) => { console.error(e.message); process.exit(1); });
}
