// Guard and parser tests. Run with: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard, applyFixes } from './public/guard.js';
import { parseReview, buildReviewInput } from './public/review-core.js';
import { decodeBytes, encodeText, bytesEqual, isMarkdownName } from './public/fs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(here, 'public', 'samples');
const orig = fs.readFileSync(path.join(samplesDir, 'on-keeping-a-notebook.md'), 'utf8');
let fails = 0;
function ok(cond, name, extra = '') {
  if (!cond) fails++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '   ' + extra));
}
function t(name, edited, expectVerdict, expectSubstr) {
  const g = guard(orig, edited);
  const hit = !expectSubstr || g.issues.some((i) => i.what.includes(expectSubstr));
  ok(g.verdict === expectVerdict && hit, name.padEnd(40) + ' -> ' + g.verdict.padEnd(6) + ' ' + g.summary, JSON.stringify(g.issues));
}

console.log('== guard ==');
t('prose edit', orig.replace('nobody reads it.', 'nobody ever reads it.'), 'clean');
t('unchanged', orig, 'clean');
t('front matter broken', orig.replace(/^---\n/, '--\n'), 'damage', 'front matter');
t('front matter key removed', orig.replace(/^date:.*\n/m, ''), 'damage', 'keys removed');
t('heading "##what"', orig.replace('## what goes in', '##what goes in'), 'damage', 'heading');
t('heading demoted', orig.replace('## what goes in', '### what goes in'), 'damage', 'level changed');
t('H1 deleted', orig.replace(/^# .*\n/m, ''), 'damage', 'H1');
t('blockquote lost', orig.replace(/^> /m, ''), 'warn', 'blockquote');
t('straight double quotes', orig.replace('“a notebook is a room with the door closed.”', '"a notebook is a room with the door closed."'), 'warn', 'straight double');
t('apostrophe edit is clean', orig.replace('nobody reads it.', "nobody reads it, and that's fine."), 'clean');
t('curly apostrophe is info', orig.replace('nobody reads it.', 'nobody reads it, and that’s fine.'), 'clean', 'curly apostrophes');
t('doubled blank lines', orig.replace('value lives.\n\n', 'value lives.\n\n\n'), 'warn', 'doubled blank');
t('final newline lost', orig.replace(/\n$/, ''), 'warn', 'final newline');
t('crlf introduced', orig.replace(/\n/g, '\r\n'), 'damage', 'CRLF');
t('unbalanced bold', orig.replace('nobody reads it.', '**nobody reads it.'), 'damage', 'bold');
t('half deleted', orig.slice(0, Math.floor(orig.length / 3)), 'damage', 'shrank');
t('TODO artifact', orig.replace('nobody reads it.', 'nobody reads it. TODO tighten'), 'warn', 'artifact');
t('capital start is info', orig.replace('nobody reads it.', 'Nobody reads it.'), 'clean', 'capitalized');
t('one merged paragraph is info', orig.replace('nobody reads it. that\'s the whole trick.', 'nobody reads it. that\'s the whole trick. '), 'clean');
t('trailing whitespace', orig.replace('value lives.', 'value lives.   '), 'warn', 'trailing whitespace');
t('title no longer matches H1', orig.replace('# on keeping a notebook', '# on keeping a diary'), 'warn', 'no longer matches');
const broken = orig.replace(/\n/g, '\r\n').replace(/\r\n$/, '') + ' \t';
ok(applyFixes(broken, ['crlf', 'trailing-ws', 'final-newline']) === orig, 'applyFixes restores the original byte for byte');
ok(applyFixes('a  \nb \n```\ncode   \n```\nc\t\n', ['trailing-ws']) === 'a  \nb\n```\ncode   \n```\nc\n', 'trailing-ws fix skips hard breaks and fenced code');
ok(applyFixes('text\n\n\n', ['final-newline']) === 'text\n' && applyFixes('text', ['final-newline']) === 'text\n', 'final-newline fix trims only newlines');
ok(guard(orig, orig.replace('value lives.', 'value lives.  ')).verdict === 'clean', 'a two-space hard break is not trailing whitespace');

let allClean = true;
for (const f of fs.readdirSync(samplesDir).filter((n) => n.endsWith('.md'))) {
  const c = fs.readFileSync(path.join(samplesDir, f), 'utf8');
  const body = c.indexOf('\n\n', c.indexOf('\n# ')) + 2;
  const g1 = guard(c, c);
  const g2 = guard(c, c.slice(0, body) + c.slice(body).replace(/\bthe\b/, 'a'));
  if (g1.verdict !== 'clean' || g2.verdict !== 'clean') { allClean = false; console.log('   not clean:', f, g1.verdict, g2.verdict, JSON.stringify(g2.issues)); }
}
ok(allClean, 'every sample: self-compare and a tiny prose edit are clean');

console.log('== review parser ==');
const good = '{"verdict":"warn","issues":[{"severity":"warn","where":"x","what":"y"}],"summary":"s"}';
ok(parseReview(good).verdict === 'warn', 'strict JSON');
ok(parseReview('sure:\n```json\n' + good + '\n```').verdict === 'warn', 'fenced JSON');
const malformed = '{"verdict":"damage","issues":[{"severity":"error","where":"line\nbreak","what":"w"}],"summary":"sum"}';
const salvaged = parseReview(malformed);
ok(salvaged && salvaged.verdict === 'damage' && salvaged.issues.length === 1 && salvaged.summary.includes('salvaged'), 'malformed JSON is salvaged');
ok(parseReview('nothing here') === null, 'garbage returns null');
ok(parseReview('{"verdict":"maybe","issues":[]}') === null, 'unknown verdict returns null');
const hostile = parseReview('{"verdict":"clean","issues":[{"severity":"root","where":5,"what":"' + 'x'.repeat(2000) + '"}],"summary":"ok"}');
ok(hostile.issues[0].severity === 'info' && hostile.issues[0].where === '' && hostile.issues[0].what.length === 500, 'issue fields are normalized and capped');
ok(buildReviewInput({ name: 'a.md', original: 'o', edited: 'e', styleNotes: ' notes ' }).startsWith('===== AUTHOR STYLE NOTES =====\nnotes'), 'style notes are prepended');

console.log('== bytes ==');
const enc = new TextEncoder();
const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('hi\r\nthere\r\n')]);
const d = decodeBytes(bomBytes);
ok(d.bom && d.eol === 'crlf' && d.text === 'hi\nthere\n' && d.valid, 'BOM + CRLF detected and normalized for editing');
ok(bytesEqual(encodeText(d.text, { bom: d.bom, eol: d.eol }), bomBytes), 'BOM + CRLF restored on encode');
ok(decodeBytes(new Uint8Array([0xff, 0xfe, 0x41])).valid === false, 'invalid UTF-8 is flagged');
const mixed = decodeBytes(enc.encode('a\r\nb\nc\rd'));
ok(mixed.mixed === true && mixed.eol === 'lf' && mixed.text === 'a\nb\nc\nd', 'mixed and lone-CR endings are flagged and normalized');
ok(decodeBytes(enc.encode('a\nb\n')).mixed === false && decodeBytes(enc.encode('a\nb\n')).eol === 'lf', 'plain LF is neither crlf nor mixed');
ok(isMarkdownName('essay.md') && !isMarkdownName('.hidden.md') && !isMarkdownName('a/b.md') && !isMarkdownName('notes.txt'), 'markdown name rules');

console.log(fails ? `\n${fails} FAILED` : '\nall tests passed');
process.exit(fails ? 1 : 0);
