// Tests for the markdown core: parse → edit → serialize fidelity. Run with: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorState } from './public/vendor/editor-bundle.js';
import { schema, parseMarkdown, serializeMarkdown, detectConventions, splitFrontMatter, safeHref } from './public/mdcore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(here, 'public', 'samples');
let fails = 0;
function ok(cond, name, extra = '') {
  if (!cond) fails++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '\n      ' + String(extra).slice(0, 600)));
}
const roundTrip = (text) => { const p = parseMarkdown(text); return serializeMarkdown(p.doc, p.baseline, p.fmRaw); };
function blockPos(doc, index) { let pos = 0; for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize; return pos; }
// Append text at the end of the last textblock inside top-level block `index`.
function appendTo(p, index, text) {
  const st = EditorState.create({ doc: p.doc });
  const node = p.doc.child(index);
  const pos = blockPos(p.doc, index);
  let end = pos + node.nodeSize - 1;
  if (!node.isTextblock) node.descendants((n, offset) => { if (n.isTextblock) end = pos + 1 + offset + n.nodeSize - 1; });
  return st.apply(st.tr.insertText(text, end)).doc;
}
function out(p, doc) { return serializeMarkdown(doc, p.baseline, p.fmRaw); }
function fixpoint(text) { const a = parseMarkdown(text); const b = parseMarkdown(serializeMarkdown(a.doc, a.baseline, a.fmRaw)); return a.doc.eq(b.doc); }

console.log('== samples round-trip unchanged ==');
for (const f of fs.readdirSync(samplesDir).filter((n) => n.endsWith('.md'))) {
  const text = fs.readFileSync(path.join(samplesDir, f), 'utf8');
  const p = parseMarkdown(text);
  ok(p.baseline.blocks !== null, `${f}: block map established (${p.doc.childCount} blocks)`);
  ok(roundTrip(text) === text, `${f}: unchanged document serializes byte for byte`);
}

console.log('== single-block edits keep everything else byte-identical ==');
const notebook = fs.readFileSync(path.join(samplesDir, 'on-keeping-a-notebook.md'), 'utf8');
{
  const p = parseMarkdown(notebook);
  const idx = 1; // second block: first paragraph after the H1
  const raw = p.baseline.blocks[idx].raw;
  const doc = appendTo(p, idx, ' extra words');
  const result = out(p, doc);
  ok(result === notebook.replace(raw, raw + ' extra words'), 'appending to one paragraph changes only that paragraph', result);
  ok(result.startsWith(p.fmRaw), 'front matter preserved exactly');
  ok(fixpoint(result), 'edited output re-parses to the same document');
}
{
  const p = parseMarkdown(notebook);
  const st = EditorState.create({ doc: p.doc });
  const doc = st.apply(st.tr.delete(blockPos(p.doc, 2), blockPos(p.doc, 3))).doc; // remove the third block
  const raw = p.baseline.blocks[2].raw;
  ok(out(p, doc) === notebook.replace(raw + '\n\n', ''), 'deleting a block removes it and one blank-line gap');
}
{
  const p = parseMarkdown(notebook);
  const st = EditorState.create({ doc: p.doc });
  const para = schema.nodes.paragraph.create(null, schema.text('a brand new paragraph.'));
  const doc = st.apply(st.tr.insert(blockPos(p.doc, 2), para)).doc;
  const raw = p.baseline.blocks[2].raw;
  ok(out(p, doc) === notebook.replace(raw, 'a brand new paragraph.\n\n' + raw), 'inserting a paragraph adds it with standard spacing');
}

console.log('== conventions of the file are reused for rewritten blocks ==');
{
  const text = 'intro with _emphasis_ and __strong__ words.\n\n- one\n- two\n\nend.\n';
  const conv = detectConventions(text);
  ok(conv.em === '_' && conv.strong === '__' && conv.bullet === '-', 'detects _ / __ / -', JSON.stringify(conv));
  const p = parseMarkdown(text);
  const st = EditorState.create({ doc: p.doc });
  // add emphasis to "end" and strong to "words", and edit the list
  let tr = st.tr;
  const endPos = blockPos(p.doc, 2) + 1;
  tr = tr.addMark(endPos, endPos + 3, schema.marks.em.create());
  const doc1 = st.apply(tr).doc;
  const r1 = out(p, doc1);
  ok(r1.includes('_end_.'), 'new emphasis uses the file\'s _ delimiter', r1);
  const p2 = parseMarkdown(text);
  const doc2 = appendTo(p2, 1, ' more');   // list block is index 1; appends to the last item text
  const r2 = out(p2, doc2);
  ok(r2 === 'intro with _emphasis_ and __strong__ words.\n\n- one\n- two more\n\nend.\n', 'edited list keeps - markers and tightness', r2);
}
{
  const text = 'first\n\n* star bullets\n* here\n';
  const p = parseMarkdown(text);
  const doc = appendTo(p, 1, '!');
  ok(out(p, doc) === 'first\n\n* star bullets\n* here!\n', 'star bullets stay star bullets', out(p, doc));
}

console.log('== inline HTML passthrough ==');
{
  const text = 'a line with <u>underlined</u> text and <br> a break.\n';
  const p = parseMarkdown(text);
  const para = p.doc.child(0);
  const hasHtmlMark = para.textContent.includes('underlined') && para.child(1) && para.child(1).marks.some((m) => m.type.name === 'html' && m.attrs.tag === 'u');
  ok(hasHtmlMark, '<u>…</u> becomes an html mark on the text', para.toString());
  ok(roundTrip(text) === text, 'unchanged inline HTML round-trips');
  const doc = appendTo(p, 0, ' edited');
  ok(out(p, doc) === 'a line with <u>underlined</u> text and <br> a break. edited\n', 'edited paragraph keeps <u> pair and lone <br>', out(p, doc));
  ok(fixpoint(out(p, doc)), 'inline html output re-parses identically');
}

console.log('== blocks the editor does not model pass through ==');
{
  const table = '| a | b |\n|---|---|\n| 1 | 2 |';
  const html = '<div class="x">\nraw html block\n</div>';
  const text = `para one.\n\n${table}\n\n${html}\n\npara two.\n`;
  const p = parseMarkdown(text);
  ok(p.doc.child(1).type.name === 'opaque' && p.doc.child(1).attrs.kind === 'table', 'table parses as an opaque block', p.doc.child(1).type.name);
  ok(p.doc.child(2).type.name === 'opaque' && p.doc.child(2).attrs.kind === 'html', 'html block parses as an opaque block');
  ok(roundTrip(text) === text, 'unchanged table and html round-trip');
  const doc = appendTo(p, 0, ' edited');
  ok(out(p, doc) === text.replace('para one.', 'para one. edited'), 'editing a neighbour leaves the table and html untouched', out(p, doc));
  // move the table to the top: it must be re-emitted verbatim from its raw attr
  const st = EditorState.create({ doc: p.doc });
  const tableNode = p.doc.child(1);
  const moved = st.apply(st.tr.delete(blockPos(p.doc, 1), blockPos(p.doc, 2)).insert(0, tableNode)).doc;
  ok(out(p, moved) === `${table}\n\npara one.\n\n${html}\n\npara two.\n`, 'a moved table is emitted verbatim', out(p, moved));
}

console.log('== marks and escaping ==');
{
  const text = 'strike ~~this~~ and keep ~5 dollars, a literal * star and [sic] brackets.\n';
  const p = parseMarkdown(text);
  ok(roundTrip(text) === text, 'strikethrough and literal characters round-trip unchanged');
  const doc = appendTo(p, 0, ' ok');
  const r = out(p, doc);
  ok(r === 'strike ~~this~~ and keep ~5 dollars, a literal \\* star and \\[sic\\] brackets. ok\n', 'rewritten block escapes only what markdown needs', r);
  ok(fixpoint(r), 'escaped output re-parses identically');
}
{
  const text = 'line one  \nline two\n';
  const p = parseMarkdown(text);
  const doc = appendTo(p, 0, '!');
  ok(out(p, doc) === 'line one  \nline two!\n', 'two-space hard breaks are kept as two spaces', out(p, doc));
  const text2 = 'line one\\\nline two\n';
  const p2 = parseMarkdown(text2);
  const doc2 = appendTo(p2, 0, '!');
  ok(out(p2, doc2) === 'line one\\\nline two!\n', 'backslash hard breaks are kept as backslashes', out(p2, doc2));
}
{
  const text = 'a paragraph\nwrapped over\nthree lines.\n\n## heading\n';
  const p = parseMarkdown(text);
  ok(roundTrip(text) === text, 'soft-wrapped paragraph round-trips unchanged');
  const doc = appendTo(p, 1, ' two');
  ok(out(p, doc) === 'a paragraph\nwrapped over\nthree lines.\n\n## heading two\n', 'editing the heading leaves the wrapped paragraph alone', out(p, doc));
}

console.log('== front matter and misc ==');
{
  ok(splitFrontMatter('---\na: 1\n---\nbody\n').fmInner === 'a: 1', 'front matter split');
  ok(splitFrontMatter('no front matter\n').fmInner === null, 'no front matter');
  ok(safeHref('https://x.y') === 'https://x.y' && safeHref('javascript:alert(1)') === null && safeHref('mailto:a@b.c') && safeHref('../rel.md') === '../rel.md', 'href safety');
  const p = parseMarkdown('[x](javascript:alert(1)) and ![i](https://e.com/i.png)\n');
  ok(!p.doc.child(0).firstChild.marks.some((m) => m.type.name === 'link'), 'javascript: link is not parsed as a link');
  const empty = parseMarkdown('');
  ok(serializeMarkdown(empty.doc, empty.baseline, empty.fmRaw) === '', 'empty document serializes to empty', JSON.stringify(serializeMarkdown(empty.doc, empty.baseline, empty.fmRaw)));
  const ws = parseMarkdown('\n\n');
  ok(serializeMarkdown(ws.doc, ws.baseline, ws.fmRaw) === '\n\n', 'whitespace-only document round-trips');
  const pe = parseMarkdown('one\n');
  const stE = EditorState.create({ doc: pe.doc });
  const withEmpty = stE.apply(stE.tr.insert(pe.doc.content.size, schema.nodes.paragraph.create())).doc;
  ok(serializeMarkdown(withEmpty, pe.baseline, pe.fmRaw) === 'one\n', 'a trailing empty paragraph adds nothing');
}

console.log(fails ? `\n${fails} FAILED` : '\nall editor tests passed');
process.exit(fails ? 1 : 0);
