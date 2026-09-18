import { diffLines, hunks } from './public/diff.js';
let fails = 0;
const ok = (c, name, extra = '') => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + name + (c ? '' : '   ' + extra)); };
const seq = (ops) => ops.map((o) => o.type[0] + ':' + o.line).join('|');

console.log('== diff ==');
ok(!diffLines('a\nb\n', 'a\nb\n').changed, 'identical text has no changes');
{
  const d = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  ok(d.added === 1 && d.removed === 1 && seq(d.ops) === 'e:a|d:b|a:B|e:c', 'single line replaced', seq(d.ops));
}
{
  const d = diffLines('a\nc\n', 'a\nb\nc\n');
  ok(seq(d.ops) === 'e:a|a:b|e:c', 'inserted line', seq(d.ops));
  const e = diffLines('a\nb\nc\n', 'a\nc\n');
  ok(seq(e.ops) === 'e:a|d:b|e:c', 'deleted line', seq(e.ops));
}
{
  const d = diffLines('a\nb', 'a\nb\n');
  ok(d.ops.some((o) => o.note === 'final newline added') && d.added === 1, 'final newline change is reported');
}
{
  const d = diffLines('', 'x\n');
  ok(seq(d.ops) === 'a:x' && d.added === 1, 'from empty', seq(d.ops));
}
{
  const big = Array.from({ length: 5000 }, (_, i) => 'line ' + i).join('\n') + '\n';
  const t = Date.now();
  const d = diffLines(big, big.replace('line 2500', 'line 2500 changed').replace('line 4000\n', ''));
  ok(d.added === 1 && d.removed === 2 && Date.now() - t < 500, 'large file diff is fast and exact', `${d.added}/${d.removed} in ${Date.now() - t}ms`);
}
{
  const a = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
  const b = a.replace('three', 'THREE').replace('nine', 'NINE');
  const h = hunks(diffLines(a, b).ops, 1);
  const shape = h.map((x) => x.type === 'skip' ? `skip${x.count}` : `hunk${x.lines.length}`).join(',');
  ok(shape === 'skip1,hunk4,skip3,hunk4', 'hunks collapse unchanged runs with context', shape);
  const first = h[1].lines.find((l) => l.type === 'del');
  ok(first.parts && first.parts.mid === 'three' && h[1].lines.find((l) => l.type === 'add').parts.mid === 'THREE', 'paired lines carry intra-line highlight parts', JSON.stringify(first.parts));
}
{
  const h = hunks(diffLines('a\nb\n', 'a\nb\n').ops);
  ok(h.length === 0, 'no hunks for identical text');
}
console.log(fails ? `\n${fails} FAILED` : '\nall diff tests passed');
process.exit(fails ? 1 : 0);
