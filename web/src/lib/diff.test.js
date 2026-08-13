import test from 'node:test';
import assert from 'node:assert/strict';
import { diffCorpora } from './diff.js';

const n = (id, label, c = 0, path = `${id}.py`) => ({ id, l: label, k: 'code', c, a: { path } });
const build = (nodes, edges, communities = []) => ({ layout: { nodes, communities }, edges });

test('reports entities added and removed', () => {
  const before = build([n('a', 'a()'), n('b', 'b()')], []);
  const after = build([n('a', 'a()'), n('c', 'c()')], []);
  const d = diffCorpora(before, after);
  assert.deepEqual(d.nodes.added.map((x) => x.l), ['c()']);
  assert.deepEqual(d.nodes.removed.map((x) => x.l), ['b()']);
});

test('reports files added and removed', () => {
  const before = build([n('a', 'a()', 0, 'old.py')], []);
  const after = build([n('b', 'b()', 0, 'new.py')], []);
  const d = diffCorpora(before, after);
  assert.deepEqual(d.files.added, ['new.py']);
  assert.deepEqual(d.files.removed, ['old.py']);
});

/**
 * A file gaining a function adds a `contains` edge. That is not a new
 * dependency, and counting it would bury the real ones.
 */
test('structural edges are not dependency changes', () => {
  const nodes = [n('f', 'x.py'), n('g', 'g()')];
  const before = build(nodes, []);
  const after = build(nodes, [['f', 'g', 'contains', 'EXTRACTED']]);
  const d = diffCorpora(before, after);
  assert.equal(d.edges.addedTotal, 0);
});

test('a new call is a dependency change', () => {
  const nodes = [n('a', 'a()'), n('b', 'b()')];
  const d = diffCorpora(build(nodes, []), build(nodes, [['a', 'b', 'calls', 'EXTRACTED']]));
  assert.equal(d.edges.addedTotal, 1);
  assert.equal(d.edges.added[0].rel, 'calls');
});

/**
 * The headline signal: existing code reaching into a subsystem it previously
 * had nothing to do with.
 */
test('drift catches a new edge across subsystems', () => {
  const nodes = [n('a', 'a()', 0), n('b', 'b()', 1)];
  const communities = [{ id: 0, label: 'api' }, { id: 1, label: 'storage' }];
  const d = diffCorpora(
    build(nodes, [], communities),
    build(nodes, [['a', 'b', 'calls', 'EXTRACTED']], communities)
  );
  assert.equal(d.drift.length, 1);
  assert.equal(d.drift[0].from, 'api');
  assert.equal(d.drift[0].into, 'storage');
});

test('a new edge inside one subsystem is not drift', () => {
  const nodes = [n('a', 'a()', 0), n('b', 'b()', 0)];
  const d = diffCorpora(build(nodes, []), build(nodes, [['a', 'b', 'calls', 'EXTRACTED']]));
  assert.equal(d.drift.length, 0);
});

/**
 * A brand-new file has to connect to something; that is expected work, not
 * drift. Drift is OLD code reaching somewhere new.
 */
test('edges from newly added entities are not drift', () => {
  const before = build([n('b', 'b()', 1)], []);
  const after = build([n('new', 'new()', 0), n('b', 'b()', 1)], [['new', 'b', 'calls', 'EXTRACTED']]);
  const d = diffCorpora(before, after);
  assert.equal(d.edges.addedTotal, 1, 'still a dependency change');
  assert.equal(d.drift.length, 0, 'but not drift');
});

test('edges into externals are not drift', () => {
  const nodes = [n('a', 'a()', 0), { id: 'os', l: 'os', k: 'external', c: 1, a: {} }];
  const d = diffCorpora(build(nodes, []), build(nodes, [['a', 'os', 'imports', 'EXTRACTED']]));
  assert.equal(d.drift.length, 0, 'importing a library is not architecture drift');
});

test('identical builds produce an empty diff', () => {
  const nodes = [n('a', 'a()'), n('b', 'b()')];
  const edges = [['a', 'b', 'calls', 'EXTRACTED']];
  const d = diffCorpora(build(nodes, edges), build(nodes, edges));
  assert.equal(d.nodes.addedTotal + d.nodes.removedTotal, 0);
  assert.equal(d.edges.addedTotal + d.edges.removedTotal, 0);
  assert.equal(d.drift.length, 0);
});
