import test from 'node:test';
import assert from 'node:assert/strict';
import { mapHtml } from './exportHtml.js';

const n = (id, l, extra = {}) => ({
  id, l, k: 'code', c: 0, h: 200, r: 4, x: 10, y: 20, a: { path: `${id}.py` }, ...extra,
});
const layout = (nodes, communities = [{ id: 0, hue: 200, size: nodes.length, label: 'core.py' }]) => ({
  nodes, communities, bounds: { width: 100, height: 100 },
});

test('embeds every node and edge', () => {
  const html = mapHtml({
    name: 'demo', layout: layout([n('a', 'a()'), n('b', 'b()')]), edges: [['a', 'b']],
  });
  const data = JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.nodes.length, 2);
  assert.deepEqual(data.links, [['a', 'b']]);
  assert.equal(data.nodes[0].p, 'a.py');
});

test('is self-contained: no external URLs', () => {
  const html = mapHtml({ name: 'demo', layout: layout([n('a', 'a()')]), edges: [] });
  assert.equal(/(src|href)\s*=\s*["']https?:/.test(html), false);
  assert.equal(html.includes('//cdn'), false);
});

/**
 * The two bugs that make an embedded-JSON page unopenable. A label containing
 * `</script>` would end the block early, and U+2028/U+2029 are line terminators
 * in JavaScript source, so an unescaped one truncates the data literal.
 */
test('a label containing </script> cannot break out of the data block', () => {
  const html = mapHtml({ name: 'demo', layout: layout([n('a', 'x</script><img>')]), edges: [] });
  const blocks = html.match(/<\/script>/g) ?? [];
  assert.equal(blocks.length, 2, 'exactly the two real script closers');
  const data = JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.nodes[0].l, 'x</script><img>', 'and the label survives intact');
});

test('line separators in labels are escaped, not embedded raw', () => {
  // Written as escapes, never as literals: a raw U+2028 in this file would
  // break this file too.
  const label = 'x' + '\u2028' + 'y' + '\u2029' + 'z';
  const html = mapHtml({ name: 'demo', layout: layout([n('a', label)]), edges: [] });
  assert.equal(html.includes('\u2028'), false, 'no raw U+2028 in the output');
  assert.equal(html.includes('\u2029'), false, 'no raw U+2029 in the output');
  const data = JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.nodes[0].l, label, 'and it round-trips through JSON.parse');
});

test('the corpus name is escaped in the title', () => {
  const html = mapHtml({ name: '<img onerror=1>', layout: layout([n('a', 'a()')]), edges: [] });
  assert.equal(html.includes('<img onerror'), false);
  assert.ok(html.includes('&lt;img onerror=1&gt;'));
});

/**
 * A graph too dense to draw is also too dense to embed — the edges would dwarf
 * the positions. The nodes still ship, so the map still opens.
 */
test('drops edges past the embedding ceiling rather than shipping a huge file', () => {
  const edges = Array.from({ length: 20001 }, () => ['a', 'b']);
  const html = mapHtml({ name: 'demo', layout: layout([n('a', 'a()'), n('b', 'b()')]), edges });
  const data = JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.links, []);
  assert.equal(data.nodes.length, 2);
});

test('reports the true subsystem count even when the legend is truncated', () => {
  const communities = Array.from({ length: 40 }, (_, i) => ({
    id: i, hue: i * 9, size: 40 - i, label: `c${i}.py`,
  }));
  const html = mapHtml({ name: 'demo', layout: layout([n('a', 'a()')], communities), edges: [] });
  const data = JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.communities.length, 24);
  assert.equal(data.communityTotal, 40);
});

test('survives a corpus with no edges and no communities', () => {
  const html = mapHtml({ name: 'demo', layout: layout([n('a', 'a()')], []), edges: null });
  const data = JSON.parse(html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data.links, []);
  assert.deepEqual(data.communities, []);
});
