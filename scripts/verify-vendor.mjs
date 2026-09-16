// Recomputes the SHA-256 of each vendored file and compares it with vendor/HASHES.txt.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor');
const lines = fs.readFileSync(path.join(dir, 'HASHES.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
let bad = 0;
for (const line of lines) {
  const [name, version, file, expected] = line.trim().split(/\s+/);
  const actual = createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
  const okay = actual === expected;
  if (!okay) bad++;
  console.log(`${okay ? 'OK  ' : 'FAIL'} ${name}@${version} ${file}`);
}
console.log(bad ? `${bad} mismatch(es)` : 'all vendored files match HASHES.txt');
process.exit(bad ? 1 : 0);
