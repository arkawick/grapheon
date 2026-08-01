import test from 'node:test';
import assert from 'node:assert/strict';
import { blastRadius, byDepth } from './blast.js';

/**
 * Build an adjacency map the way App.jsx does, from [source, target, rel, conf]
 * tuples. Keeping this in sync with the real builder by construction matters
 * more than sharing the code — the direction convention is the easiest thing
 * in this codebase to get backwards.
 */
function adjacencyOf(edges) {
  const adj = new Map();
  const push = (a, b, rel, conf, dir) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, rel, conf, dir });
  };
  for (const [s, t, rel = 'calls', conf = 'EXTRACTED'] of edges) {
    push(s, t, rel, conf, 'out');
    push(t, s, rel, conf, 'in');
  }
  return adj;
}

// app -> service -> db, i.e. app depends on service depends on db.
const chain = adjacencyOf([
  ['app', 'service'],
  ['service', 'db'],
]);

test("direction 'in' finds dependents, not dependencies", () => {
  const r = blastRadius(chain, 'db', { depth: 5, direction: 'in' });
  assert.deepEqual([...r.keys()].sort(), ['app', 'service']);
  assert.equal(r.get('service').depth, 1);
  assert.equal(r.get('app').depth, 2);
});

test("direction 'out' finds dependencies, not dependents", () => {
  const r = blastRadius(chain, 'app', { depth: 5, direction: 'out' });
  assert.deepEqual([...r.keys()].sort(), ['db', 'service']);
  assert.equal(r.get('db').depth, 2);
});

test('the root is never part of its own radius', () => {
  const r = blastRadius(chain, 'db', { depth: 5, direction: 'in' });
  assert.equal(r.has('db'), false);
});

test('depth caps the traversal', () => {
  const r = blastRadius(chain, 'db', { depth: 1, direction: 'in' });
  assert.deepEqual([...r.keys()], ['service']);
});

test('a leaf has an empty radius', () => {
  const r = blastRadius(chain, 'app', { depth: 5, direction: 'in' });
  assert.equal(r.size, 0);
});

test('cycles terminate', () => {
  const cyclic = adjacencyOf([['a', 'b'], ['b', 'c'], ['c', 'a']]);
  const r = blastRadius(cyclic, 'a', { depth: 10, direction: 'in' });
  assert.deepEqual([...r.keys()].sort(), ['b', 'c']);
});

test('one inferred hop poisons everything downstream of it', () => {
  // app -> service (inferred) -> db.  Changing db certainly affects service,
  // but only maybe affects app, because the service->app link was a guess.
  const adj = adjacencyOf([
    ['app', 'service', 'calls', 'INFERRED'],
    ['service', 'db', 'calls', 'EXTRACTED'],
  ]);
  const r = blastRadius(adj, 'db', { depth: 5, direction: 'in' });
  assert.equal(r.get('service').certain, true);
  assert.equal(r.get('app').certain, false, 'inferred hop must propagate forward');
});

test('an inferred edge does not taint an unrelated branch', () => {
  const adj = adjacencyOf([
    ['solid', 'db', 'calls', 'EXTRACTED'],
    ['shaky', 'db', 'calls', 'INFERRED'],
  ]);
  const r = blastRadius(adj, 'db', { depth: 5, direction: 'in' });
  assert.equal(r.get('solid').certain, true);
  assert.equal(r.get('shaky').certain, false);
});

/**
 * The rule this codebase commits to: a node is CERTAIN if any fully-extracted
 * path reaches it, but its reported DEPTH stays that of the first (shortest)
 * path found. The two are tracked independently on purpose — reporting a node
 * as uncertain merely because the shortest route to it was a guess would
 * understate impact, which is the failure that matters here.
 */
test('certainty upgrades on a later trustworthy path, depth does not change', () => {
  const adj = adjacencyOf([
    ['x', 'db', 'calls', 'INFERRED'],    // shortest route, but a guess
    ['x', 'mid', 'calls', 'EXTRACTED'],
    ['mid', 'db', 'calls', 'EXTRACTED'], // longer route, fully read from source
  ]);
  const r = blastRadius(adj, 'db', { depth: 5, direction: 'in' });
  assert.equal(r.get('x').depth, 1, 'shortest path wins for depth');
  assert.equal(r.get('x').certain, true, 'a certain route anywhere makes it certain');
});

test('byDepth groups into rings, nearest first', () => {
  const r = blastRadius(chain, 'db', { depth: 5, direction: 'in' });
  const rings = byDepth(r);
  assert.deepEqual(rings.map(([d, items]) => [d, items.map((i) => i.id)]), [
    [1, ['service']],
    [2, ['app']],
  ]);
});

test('an unknown root yields nothing rather than throwing', () => {
  const r = blastRadius(chain, 'nope', { depth: 3, direction: 'in' });
  assert.equal(r.size, 0);
});
