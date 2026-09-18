// Rebuilds public/vendor/editor-bundle.js from the pinned devDependencies. Deterministic for the
// same package versions and esbuild version, so `npm ci && npm run build:editor` reproduces the
// committed file byte for byte (CI checks this).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const versions = Object.entries(pkg.devDependencies).filter(([n]) => n !== 'esbuild').map(([n, v]) => `${n}@${v}`).join(', ');

await build({
  entryPoints: [path.join(root, 'scripts', 'editor-entry.js')],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: 'inline',
  outfile: path.join(root, 'public', 'vendor', 'editor-bundle.js'),
  banner: { js: `// Built by scripts/build-editor.mjs with esbuild ${pkg.devDependencies.esbuild} from: ${versions}\n// Do not edit; rebuild with: npm ci && npm run build:editor` },
  logLevel: 'warning',
});
fs.copyFileSync(path.join(root, 'node_modules', 'prosemirror-view', 'style', 'prosemirror.css'), path.join(root, 'public', 'vendor', 'prosemirror.css'));
console.log('built public/vendor/editor-bundle.js and copied prosemirror.css');
