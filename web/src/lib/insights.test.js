import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInsights } from './insights.js';

const node = (id, label, extra = {}) => ({
  id, l: label, k: 'code', c: 0, a: { path: `${id}.py`, loc: 'L1' }, ...extra,
});

/** Same adjacency shape App builds from edges.json. */
function adjacencyOf(edges) {
  const adj = new Map();
  const push = (a, b, rel, dir) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, rel, conf: 'EXTRACTED', dir });
  };
  for (const [s, t, rel = 'calls'] of edges) {
    push(s, t, rel, 'out');
    push(t, s, rel, 'in');
  }
  return adj;
}

test('hubs rank by inbound usage and exclude externals', () => {
  const nodes = [node('a', 'a()'), node('b', 'b()'), node('c', 'c()'),
    { id: 'os', l: 'os', k: 'external', c: 0, a: {} }];
  const adj = adjacencyOf([['a', 'c'], ['b', 'c'], ['a', 'os'], ['b', 'os'], ['c', 'os']]);
  const { hubs } = computeInsights(nodes, adj);
  assert.equal(hubs[0].label, 'c()');
  assert.ok(!hubs.some((h) => h.label === 'os'), 'externals are not insights');
});

/**
 * Structural edges say how code is FILED, not how it is used. Counting
 * `contains` as usage makes every function look referenced.
 */
test('containment does not count as being used', () => {
  const nodes = [node('file', 'x.py'), node('fn', 'fn()')];
  const adj = adjacencyOf([['file', 'fn', 'contains']]);
  const { unused } = computeInsights(nodes, adj);
  assert.ok(unused.likely.some((u) => u.label === 'fn()'), 'contained but uncalled is still unused');
});

/**
 * A FastAPI route is called by the framework, never by parsed code. Listing
 * handlers as dead was 156 of Aeon's 335 functions — a list nobody would
 * trust, so they are separated rather than mixed in.
 */
test('framework entry points are separated from likely-dead code', () => {
  const nodes = [node('handler', 'list_items()'), node('dead', 'old_helper()')];
  // The decorator @router.get shows up as a reference to a file-scoped verb.
  const adj = adjacencyOf([['handler', 'api_py_get', 'references']]);
  adj.set('dead', adj.get('dead') ?? []);
  const { unused } = computeInsights(nodes, adj);
  assert.deepEqual(unused.likely.map((u) => u.label), ['old_helper()']);
  assert.deepEqual(unused.entryPoints.map((u) => u.label), ['list_items()']);
});

test('dunder and lifecycle methods are not reported as dead', () => {
  const nodes = [node('i', '.__init__()'), node('m', 'main()')];
  const { unused } = computeInsights(nodes, new Map());
  assert.equal(unused.likely.length, 0);
  assert.equal(unused.entryPointTotal, 2);
});

test('only callables are considered for deadness', () => {
  const nodes = [node('f', 'module.py'), node('T', 'Config'), node('fn', 'go()')];
  const { unused } = computeInsights(nodes, new Map());
  assert.deepEqual(unused.likely.map((u) => u.label), ['go()'],
    'a file or a type is not "unused code"');
});

test('finds a dependency cycle', () => {
  const nodes = [node('a', 'a()'), node('b', 'b()'), node('c', 'c()')];
  const adj = adjacencyOf([['a', 'b'], ['b', 'c'], ['c', 'a']]);
  const { cycles } = computeInsights(nodes, adj);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].map((n) => n.label).sort(), ['a()', 'b()', 'c()']);
});

test('an acyclic graph reports no cycles', () => {
  const nodes = [node('a', 'a()'), node('b', 'b()'), node('c', 'c()')];
  const { cycles } = computeInsights(nodes, adjacencyOf([['a', 'b'], ['b', 'c']]));
  assert.deepEqual(cycles, []);
});

/** A recursive Tarjan blows the stack on a real corpus. */
test('deep chains do not overflow the stack', () => {
  const nodes = [], edges = [];
  for (let i = 0; i < 20000; i++) {
    nodes.push(node(`n${i}`, `n${i}()`));
    if (i) edges.push([`n${i - 1}`, `n${i}`]);
  }
  const { cycles } = computeInsights(nodes, adjacencyOf(edges));
  assert.deepEqual(cycles, []);
});

test('coupling finds entities reaching into several subsystems', () => {
  const nodes = [
    node('hub', 'glue()', { c: 0 }),
    node('x', 'x()', { c: 1 }), node('y', 'y()', { c: 2 }), node('z', 'z()', { c: 3 }),
    node('local', 'local()', { c: 0 }),
  ];
  const adj = adjacencyOf([['hub', 'x'], ['hub', 'y'], ['hub', 'z'], ['local', 'hub']]);
  const communities = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }, { id: 3, label: 'three' }];
  const { coupling } = computeInsights(nodes, adj, communities);
  assert.equal(coupling[0].label, 'glue()');
  assert.equal(coupling[0].reaches, 3);
  assert.ok(!coupling.some((c) => c.label === 'local()'), 'one subsystem is not coupling');
});
