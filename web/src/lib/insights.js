/**
 * Things the graph already knows but never says.
 *
 * Every feature until now answered a question you had to know to ask. These
 * are computed without being asked, from data already in memory.
 *
 * Pure over (nodes, adjacency) so it is testable without a browser.
 */

/**
 * Structural edges describe how code is FILED, not how it is USED: a file
 * "contains" its functions whether or not anything calls them. Counting them
 * as usage would make every function look referenced and the whole analysis
 * meaningless.
 */
const STRUCTURAL = new Set(['contains', 'method', 'rationale_for', 'subsection']);

/**
 * Framework entry points, detected from the graph rather than guessed by name.
 *
 * A FastAPI route is never called by code the parser can see — the framework
 * calls it — so a naive "unreferenced" list flags every handler in the app.
 * On Aeon that was 156 of 335 functions, which is a list nobody would trust.
 *
 * The tell is an OUTBOUND edge to a file-scoped decorator verb: `@router.get`
 * becomes a reference to `<file>_py_get`. That is real evidence in the data,
 * not a naming convention.
 */
const ENTRY_VERBS = /_(get|post|put|patch|delete|route|command|task|middleware|websocket|on_event|fixture|test)$/;

const isUsage = (rel) => !STRUCTURAL.has(rel);

/** Callable entities — functions and methods, not files, types or modules. */
const isCallable = (n) => n.k === 'code' && /\(\)$/.test(n.l ?? '');

export function computeInsights(nodes, adjacency, communities = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inUsage = new Map();  // id -> [{from, rel}]
  const outUsage = new Map();

  for (const [id, links] of adjacency) {
    for (const l of links) {
      if (!isUsage(l.rel)) continue;
      if (l.dir === 'in') {
        if (!inUsage.has(id)) inUsage.set(id, []);
        inUsage.get(id).push(l);
      } else {
        if (!outUsage.has(id)) outUsage.set(id, []);
        outUsage.get(id).push(l);
      }
    }
  }

  return {
    hubs: hubs(byId, inUsage),
    unused: unused(nodes, byId, inUsage, outUsage),
    cycles: cycles(byId, outUsage),
    coupling: coupling(byId, outUsage, communities),
    totals: {
      nodes: nodes.length,
      callables: nodes.filter(isCallable).length,
      communities: communities.length,
    },
  };
}

/** Most depended-upon INTERNAL entities. Externals would fill the list. */
function hubs(byId, inUsage) {
  const out = [];
  for (const [id, links] of inUsage) {
    const n = byId.get(id);
    if (!n || n.k === 'external' || !n.a?.path) continue;
    out.push({ id, label: n.l, path: n.a.path, count: links.length, kind: n.k });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 15);
}

/**
 * Callables nothing references.
 *
 * Split by CONFIDENCE rather than presented as fact: an entry point and a
 * genuinely dead function look identical from inside one repository, and a
 * list that mixes them teaches people to ignore it.
 */
function unused(nodes, byId, inUsage, outUsage) {
  const likely = [];
  const entryPoints = [];

  for (const n of nodes) {
    if (!isCallable(n) || !n.a?.path) continue;
    if ((inUsage.get(n.id) ?? []).length) continue;

    const outbound = outUsage.get(n.id) ?? [];
    const entry = outbound.some((l) => ENTRY_VERBS.test(l.id));
    // A dunder or a lifecycle hook is called by the language or the runtime.
    const magic = /^\.?__\w+__\(\)$/.test(n.l) || /^\.?(main|setup|teardown)\(\)$/.test(n.l);

    const row = { id: n.id, label: n.l, path: n.a.path, line: n.a.loc };
    if (entry || magic) entryPoints.push({ ...row, why: entry ? 'framework entry point' : 'runtime hook' });
    else likely.push(row);
  }

  return {
    likely: likely.slice(0, 40),
    likelyTotal: likely.length,
    entryPoints: entryPoints.slice(0, 20),
    entryPointTotal: entryPoints.length,
  };
}

/**
 * Dependency cycles, as strongly connected components of size > 1.
 *
 * Tarjan, iterative: a recursive version blows the stack on a real corpus,
 * and "the insights page crashed" is a poor way to learn that.
 */
function cycles(byId, outUsage) {
  let index = 0;
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const found = [];

  for (const root of byId.keys()) {
    if (idx.has(root)) continue;
    const work = [[root, 0]];

    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;

      if (i === 0) {
        idx.set(v, index); low.set(v, index); index++;
        stack.push(v); onStack.add(v);
      }

      const edges = outUsage.get(v) ?? [];
      if (i < edges.length) {
        frame[1]++;
        const w = edges[i].id;
        if (!byId.has(w)) continue;
        if (!idx.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
        continue;
      }

      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) {
          found.push(comp.map((id) => ({
            id, label: byId.get(id)?.l ?? id, path: byId.get(id)?.a?.path ?? null,
          })));
        }
      }
    }
  }
  return found.sort((a, b) => b.length - a.length).slice(0, 10);
}

/**
 * Entities that reach across subsystem boundaries most.
 *
 * High cross-community degree is where a change is most likely to surprise
 * someone — the layout already separates communities in space, so these are
 * the long edges you see on the map.
 */
function coupling(byId, outUsage, communities) {
  const label = new Map(communities.map((c) => [c.id, c.label]));
  const out = [];
  for (const [id, links] of outUsage) {
    const n = byId.get(id);
    if (!n || !n.a?.path || n.k === 'external') continue;
    const others = new Set();
    for (const l of links) {
      const t = byId.get(l.id);
      if (t && t.k !== 'external' && t.c !== n.c) others.add(t.c);
    }
    if (others.size < 2) continue;
    out.push({
      id, label: n.l, path: n.a.path, reaches: others.size,
      into: [...others].map((c) => label.get(c) ?? `#${c}`).slice(0, 4),
    });
  }
  return out.sort((a, b) => b.reaches - a.reaches).slice(0, 12);
}
