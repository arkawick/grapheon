import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from './parse.js';
import { buildIndex, search, tokenize } from './bm25.js';
import { buildKnowledgeGraph } from './graph.js';

const DOC = `# Merge Gate

The gate forecasts whether a pull request will pass CI.

## Usage

Open the predict page and enter a repository and a pull request number.
The forecast fuses incident memory with co-change hanging points.

## Usage

A second section with a repeated heading, which markdown allows.

---
`;

test('headings become sections, prose becomes passages', () => {
  const d = parseDocument({ path: 'gate.md', text: DOC });
  assert.equal(d.title, 'Merge Gate');
  assert.deepEqual(d.sections.map((s) => s.heading), ['Merge Gate', 'Usage', 'Usage']);
  assert.ok(d.sections[1].passages.length >= 1);
});

/** Repeated headings are normal prose; colliding ids break the whole graph. */
test('repeated headings get distinct section ids', () => {
  const d = parseDocument({ path: 'gate.md', text: DOC });
  const ids = d.sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, ids.join(', '));
});

/**
 * Every passage must know where it starts. They all used to inherit the
 * SECTION's line, so results from one section looked identical and each opened
 * at the heading rather than at the text.
 */
test('passages carry their own start line', () => {
  const d = parseDocument({ path: 'gate.md', text: DOC });
  const usage = d.sections.find((s) => s.heading === 'Usage');
  assert.ok(usage.passages[0].line > usage.line, 'passage starts after its heading');
});

test('separator-only blocks are not indexable passages', () => {
  const d = parseDocument({ path: 'x.md', text: '# T\n\n---\n\n```\n' });
  const texts = d.sections.flatMap((s) => s.passages).map((p) => p.text);
  assert.ok(!texts.includes('---'), `got ${JSON.stringify(texts)}`);
});

test('tokenizer keeps dotted identifiers whole and also splits them', () => {
  const t = tokenize('core.llm handles blast_radius');
  assert.ok(t.includes('core.llm'), 'whole identifier kept');
  assert.ok(t.includes('llm'), 'parts indexed too, so "llm" finds "core.llm"');
  assert.ok(!t.includes('the'), 'stopwords dropped');
});

test('BM25 ranks the passage that answers the question first', () => {
  const d = parseDocument({ path: 'gate.md', text: DOC });
  const passages = d.sections.flatMap((s) => s.passages);
  const idx = buildIndex(passages);
  const hits = search(idx, 'pull request forecast');
  assert.ok(hits.length);
  assert.match(hits[0].passage.text, /forecast|pull request/i);
});

test('a query of only stopwords returns nothing rather than everything', () => {
  const idx = buildIndex(parseDocument({ path: 'a.md', text: DOC }).sections.flatMap((s) => s.passages));
  assert.deepEqual(search(idx, 'the and of'), []);
});

test('graph emits document + section nodes with unique ids', () => {
  const d = parseDocument({ path: 'gate.md', text: DOC });
  const g = buildKnowledgeGraph([d], 'kb');
  const ids = g.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(g.nodes.some((n) => n.kind === 'document'));
  assert.ok(g.nodes.some((n) => n.kind === 'section'));
  // Nesting: H2s sit under the H1.
  assert.ok(g.edges.some(([, , , rel]) => rel === 'subsection'));
});

test('inferred similarity edges are tagged as such', () => {
  const a = parseDocument({ path: 'a.md', text: '# A\n\n## Retrieval\n\nchroma vector recall rerank blended score threshold\n' });
  const b = parseDocument({ path: 'b.md', text: '# B\n\n## Memory\n\nchroma vector recall rerank blended score threshold\n' });
  const g = buildKnowledgeGraph([a, b], 'kb');
  const related = g.edges.filter(([, , , rel]) => rel === 'related');
  for (const e of related) assert.equal(e[4], 'INFERRED');
});
