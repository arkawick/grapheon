import test from 'node:test';
import assert from 'node:assert/strict';
import { joinDocsToCode } from './join.js';

const codeNode = (id, label, path) => ({ id, l: label, k: 'code', a: { path, loc: 'L1' } });
const passage = (id, text) => ({ id, sectionId: `${id}#s`, heading: 'H', line: 1, text });

const nodes = [
  codeNode('chroma', 'ChromaStore', 'aeon/backend/memory/chroma_store.py'),
  codeNode('llm', 'llm.py', 'aeon/backend/core/llm.py'),
  codeNode('complete', 'complete()', 'aeon/backend/core/llm.py'),
  codeNode('get', 'get()', 'aeon/backend/api/util.py'),
  codeNode('handler', 'handler()', 'aeon/backend/api/h.py'),
];

test('a class named in prose links to its node', () => {
  const { byPassage, byNode } = joinDocsToCode(nodes,
    [passage('p1', 'The ChromaStore handles recall and never blocks.')]);
  assert.equal(byPassage.get('p1').hits[0].nodeId, 'chroma');
  assert.ok(byNode.has('chroma'));
});

test('a file path is a high-confidence mention', () => {
  const { byPassage } = joinDocsToCode(nodes,
    [passage('p1', 'Everything routes through aeon/backend/core/llm.py instead.')]);
  const hit = byPassage.get('p1').hits[0];
  assert.equal(hit.confidence, 'high');
  assert.equal(hit.kind, 'path');
});

/**
 * A join that links every "get" and "data" is worse than no join: the noise
 * makes the real links unfindable.
 */
test('generic identifiers are never matched', () => {
  const { byPassage } = joinDocsToCode(nodes,
    [passage('p1', 'You can get the data and set the config from the api.')]);
  assert.equal(byPassage.size, 0);
});

test('short or undistinctive identifiers are not matched bare', () => {
  const { byPassage } = joinDocsToCode(nodes,
    [passage('p1', 'The handler runs first.')]);
  assert.equal(byPassage.size, 0, '"handler" is not evidence of anything');
});

/** Backticks are an explicit claim that the word is code. */
test('backticks upgrade a weak identifier to a confident match', () => {
  const { byPassage } = joinDocsToCode(nodes,
    [passage('p1', 'Call `complete()` from the service layer.')]);
  const hits = byPassage.get('p1')?.hits ?? [];
  assert.equal(hits[0]?.nodeId, 'complete');
  assert.equal(hits[0]?.confidence, 'high');
});

test('word boundaries are respected', () => {
  const { byPassage } = joinDocsToCode(nodes,
    [passage('p1', 'The incomplete migration is unrelated.')]);
  assert.equal(byPassage.size, 0, '"complete" must not match inside "incomplete"');
});

/** Pointing at the wrong definition is worse than pointing at none. */
test('a form shared by two nodes is dropped as ambiguous', () => {
  const dupes = [
    codeNode('a', 'index.ts', 'web/a/index.ts'),
    codeNode('b', 'index.ts', 'web/b/index.ts'),
  ];
  const { byPassage } = joinDocsToCode(dupes, [passage('p1', 'See index.ts for details.')]);
  assert.equal(byPassage.size, 0);
});

test('the longer, more specific form wins in one span', () => {
  const { byPassage } = joinDocsToCode(nodes,
    [passage('p1', 'Defined in aeon/backend/core/llm.py near the top.')]);
  const hits = byPassage.get('p1').hits;
  assert.equal(hits.length, 1, 'llm.py must not also match inside the full path');
  assert.equal(hits[0].kind, 'path');
});

/**
 * A term in a fifth of all passages is vocabulary, not a reference — the same
 * reasoning that keeps common words out of the knowledge graph's edges.
 */
test('a term mentioned everywhere is treated as vocabulary', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    passage(`p${i}`, 'ChromaStore appears in every single passage here.'));
  const { byNode } = joinDocsToCode(nodes, many);
  assert.ok(!byNode.has('chroma'), 'ubiquitous mentions carry no information');
});

test('externals are never linked', () => {
  const withExt = [...nodes, { id: 'react', l: 'react', k: 'external', a: {} }];
  const { byPassage } = joinDocsToCode(withExt, [passage('p1', 'We use react everywhere.')]);
  assert.equal(byPassage.size, 0);
});

test('both directions are produced', () => {
  const { byPassage, byNode, total } = joinDocsToCode(nodes, [
    passage('p1', 'ChromaStore is described here.'),
    passage('p2', 'And ChromaStore again, differently.'),
  ]);
  assert.equal(byPassage.size, 2, 'doc -> code');
  assert.equal(byNode.get('chroma').length, 2, 'code -> docs');
  assert.equal(total, 2);
});
