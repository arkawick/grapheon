/**
 * Offline layout pass.
 *
 *   canonical graph -> Louvain communities -> ForceAtlas2 -> positioned nodes
 *
 * Ported from Project-Kagami's scripts/generate-layout.js, which earned every
 * non-obvious step below the hard way. Generalised off that project's two
 * domain assumptions: node ids are strings here (not numeric AniList ids), and
 * node size comes from degree (not catalog popularity).
 *
 * This stays in Node because graphology's ForceAtlas2 with Barnes-Hut is the
 * best implementation available at this size; rewriting it in Python would be
 * a downgrade for no gain.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2 from 'graphology-layout-forceatlas2';

/**
 * The world box scales with node count so that DENSITY stays constant across
 * corpora. Kagami hardcoded 20000 for its 8000-node catalog; reusing that
 * number for Aeon's 1038 nodes spreads them 8x thinner and the map reads as
 * dust rather than structure. sqrt keeps nodes-per-area fixed, and calibrating
 * on Kagami's proven pair (8000 nodes -> 20000 units) means that map is
 * unchanged by this generalisation.
 */
function worldSize(nodeCount) {
  return Math.round(20000 * Math.sqrt(nodeCount / 8000));
}

/**
 * ForceAtlas2 repulsion and gravity, scaled to graph density.
 *
 * Kagami's constants (scalingRatio 12, gravity 0.4) are tuned for a graph with
 * average degree ~25. Aeon's code graph averages ~3.2, where that much
 * repulsion overwhelms the attraction and flings nodes clean out of their own
 * community: measured, 11.9% of intra-community edges ended up spanning more
 * than a fifth of the map, which renders as bright spikes across it.
 *
 * Re-tuning to (2, 1.5) drops that to 0.6% — a 20x improvement — and more
 * iterations do not help (600 and 1200 score identically), which is the
 * signature of a force-balance problem rather than an unconverged one.
 *
 * Interpolated between those two measured points so both corpora stay correct.
 */
function fa2Settings(avgDegree) {
  const SPARSE = { deg: 3.2, scalingRatio: 2, gravity: 1.5 };  // Aeon
  const DENSE = { deg: 25, scalingRatio: 12, gravity: 0.4 };   // Kagami
  const t = Math.max(0, Math.min(1, (avgDegree - SPARSE.deg) / (DENSE.deg - SPARSE.deg)));
  return {
    scalingRatio: SPARSE.scalingRatio + t * (DENSE.scalingRatio - SPARSE.scalingRatio),
    gravity: SPARSE.gravity + t * (DENSE.gravity - SPARSE.gravity),
  };
}

/**
 * Seeded PRNG (mulberry32), so a build is reproducible.
 *
 * Two things here are randomised: Louvain visits nodes in random order, and
 * orphan parking jitters positions. Left on Math.random, two runs over
 * identical input produced 48 and then 47 communities, which means the
 * committed canonical graph does NOT pin the map you get from it. Seeding is
 * what makes "deterministic" true rather than merely plausible.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Degree is heavy-tailed — in Aeon the agent graph has 56 edges while the
 * median node has 2. A linear radius makes one node a continent and everything
 * else a speck, so sqrt compresses it into a range the eye can compare.
 */
function radius(degree, maxDegree) {
  const norm = maxDegree > 0 ? Math.sqrt(degree / maxDegree) : 0;
  return 3 + norm * 14;
}

function build(canonical, { iterations = 600, log = () => {}, fa2 = {}, seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const { nodes, edges } = canonical;
  if (!nodes.length) throw new Error('Empty graph — nothing to lay out.');

  const graph = new Graph({ type: 'undirected' });

  // ForceAtlas2 reads x/y as its starting point and writes back in place — it
  // does NOT seed positions itself. Nodes added without x/y produce null
  // coordinates (forces computed against undefined never recover). Real seeding
  // happens per-community below; these are just well-formed placeholders.
  for (const n of nodes) {
    graph.addNode(n.id, { ...n, x: 0, y: 0 });
  }

  // Collapse parallel edges, keeping the strongest. Graphify emits several
  // links between the same pair (a file both `contains` and `calls` a
  // function), and an undirected graphology graph rejects duplicates outright.
  // Its own `graphify diagnose multigraph` command exists for this same reason.
  //
  // NOTE: deliberately NO log compression here, unlike the Kagami original.
  // There, weights were raw recommendation counts spanning 1..~6000 and a
  // handful of mega-edges supplied all the attraction, so log1p was essential.
  // Our weights are bounded relation constants in 0.35..1.0 with no tail at
  // all — compressing them would only squash real distinctions.
  let dropped = 0;
  for (const [s, t, w] of edges) {
    if (s === t) { dropped++; continue; } // self-loops carry no layout information
    if (!graph.hasNode(s) || !graph.hasNode(t)) { dropped++; continue; }
    if (graph.hasEdge(s, t)) {
      if (w > graph.getEdgeAttribute(s, t, 'weight')) {
        graph.setEdgeAttribute(s, t, 'weight', w);
      }
    } else {
      graph.addEdge(s, t, { weight: w });
    }
  }
  log(`  ${graph.size} unique edges after collapsing parallels (${dropped} skipped)`);

  // --- Size by degree ---------------------------------------------------------
  let maxDegree = 0;
  graph.forEachNode((id) => { maxDegree = Math.max(maxDegree, graph.degree(id)); });

  // --- Communities ------------------------------------------------------------
  louvain.assign(graph, { resolution: 1.0, getEdgeWeight: 'weight', rng });
  const communities = new Set();
  graph.forEachNode((_, attr) => communities.add(attr.community));
  log(`  ${communities.size} communities detected (Louvain)`);

  // Deterministic hue per community, spread by the golden angle so neighbouring
  // community ids don't land on near-identical colours.
  const hues = new Map();
  [...communities].sort((a, b) => a - b).forEach((c, i) => {
    hues.set(c, Math.round((i * 137.508) % 360));
  });

  // --- Seed positions by community --------------------------------------------
  // A community-blind seed (ring, grid, random) never recovers: linLog
  // attraction grows with log(distance), far too weak to pull a community
  // together across thousands of world units. So hand FA2 the answer's shape up
  // front — each community starts as a tight blob on a phyllotaxis spiral — and
  // the physics only has to refine spacing, not discover the clustering.
  const members = new Map();
  graph.forEachNode((id, a) => {
    if (!members.has(a.community)) members.set(a.community, []);
    members.get(a.community).push(id);
  });
  const bySize = [...members.entries()].sort((a, b) => b[1].length - a[1].length);
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  // Centre spacing must grow with the AREA already placed. Spacing by index
  // instead puts the biggest blobs (placed first, radii in the thousands) on the
  // near-zero inner turns of the spiral, where they start superimposed and never
  // unmix.
  let cumArea = 0;
  bySize.forEach(([, ids], i) => {
    const blob = 60 + Math.sqrt(ids.length) * 55;
    cumArea += Math.PI * blob * blob;
    const cr = i === 0 ? 0 : 1.35 * Math.sqrt(cumArea / Math.PI);
    const ca = i * GOLDEN;
    const cx = Math.cos(ca) * cr;
    const cy = Math.sin(ca) * cr;
    ids.forEach((id, j) => {
      const r = blob * Math.sqrt((j + 0.5) / ids.length);
      const a = j * GOLDEN;
      graph.setNodeAttribute(id, 'x', cx + Math.cos(a) * r);
      graph.setNodeAttribute(id, 'y', cy + Math.sin(a) * r);
    });
  });

  // --- Layout -----------------------------------------------------------------
  const avgDegree = (2 * graph.size) / graph.order;
  const tuned = fa2Settings(avgDegree);
  log(`  average degree ${avgDegree.toFixed(1)} -> scalingRatio ` +
      `${tuned.scalingRatio.toFixed(1)}, gravity ${tuned.gravity.toFixed(2)}`);
  log(`Running ForceAtlas2 (${iterations} iterations, Barnes-Hut) ...`);
  const t0 = Date.now();
  forceAtlas2.assign(graph, {
    iterations,
    settings: {
      barnesHutOptimize: true, // O(n log n); without it this is minutes -> hours
      barnesHutTheta: 0.6,
      slowDown: 4,
      ...tuned,
      ...fa2, // explicit caller override, used by the tuning sweep
      strongGravityMode: false,
      edgeWeightInfluence: 0.5,
      linLogMode: true, // tightens clusters, widens the gaps between them
      outboundAttractionDistribution: true,
    },
  });
  log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Degree-0 nodes have no attraction anywhere, so gravity vs repulsion parks
  // them in a neat ring around the barycenter: a crop circle in the middle of
  // the map. Move them past the edge instead — visually "unmapped territory",
  // which is what they are.
  let bx = 0, by = 0, bn = 0;
  graph.forEachNode((id, a) => {
    if (graph.degree(id) > 0) { bx += a.x; by += a.y; bn++; }
  });
  bx /= bn || 1; by /= bn || 1;
  const connectedR = [];
  graph.forEachNode((id, a) => {
    if (graph.degree(id) > 0) connectedR.push(Math.hypot(a.x - bx, a.y - by));
  });
  connectedR.sort((a, b) => a - b);
  const edgeR = (connectedR[Math.floor(connectedR.length * 0.99)] || 1) * 1.08;
  const orphans = graph.filterNodes((id) => graph.degree(id) === 0);
  orphans.forEach((id, i) => {
    const a = (i / orphans.length) * 2 * Math.PI;
    const jitter = 1 + (rng() - 0.5) * 0.06;
    graph.setNodeAttribute(id, 'x', bx + Math.cos(a) * edgeR * jitter);
    graph.setNodeAttribute(id, 'y', by + Math.sin(a) * edgeR * jitter);
  });
  if (orphans.length) log(`  parked ${orphans.length} unconnected nodes outside the map edge`);

  // A single non-finite coordinate poisons minX/scale and every node rounds to
  // NaN -> JSON null. Fail loudly now, not 2 MB of nulls later.
  let broken = 0;
  graph.forEachNode((_, a) => { if (!isFinite(a.x) || !isFinite(a.y)) broken++; });
  if (broken) {
    throw new Error(`ForceAtlas2 produced ${broken} non-finite coordinates — refusing to write layout`);
  }

  // --- Normalise into a fixed world box ----------------------------------------
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  graph.forEachNode((_, a) => {
    minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
    minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
  });
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const world = worldSize(graph.order);
  const scale = world / span;

  // Name each community after its most-connected member — for code, a community
  // is a subsystem, and "core/llm" reads as something where "Community 7" does
  // not. Deterministic, and no LLM involved (which is why --no-cluster is safe).
  const label = new Map();
  for (const [c, ids] of members) {
    let best = null, bestDeg = -1;
    for (const id of ids) {
      const d = graph.degree(id);
      if (d > bestDeg) { bestDeg = d; best = id; }
    }
    label.set(c, graph.getNodeAttribute(best, 'label') ?? String(best));
  }

  const out = [];
  graph.forEachNode((id, a) => {
    out.push({
      id,
      l: a.label,
      k: a.kind,
      c: a.community,
      h: hues.get(a.community),
      r: Number(radius(graph.degree(id), maxDegree).toFixed(2)),
      x: Math.round((a.x - minX) * scale),
      y: Math.round((a.y - minY) * scale),
      a: a.attrs,
    });
  });

  // Edges are NOT shipped to the browser. Thousands of lines at 60fps buys a
  // grey haze that hides the very clusters the layout just worked to reveal; the
  // map reads better as pure position, and connections surface on click instead.
  // It is also what makes this deployable as a static file with no backend.
  return {
    meta: { ...canonical.meta, laid_out_at: new Date().toISOString(), iterations },
    nodes: out,
    bounds: { width: world, height: world },
    communities: [...communities]
      .map((c) => ({ id: c, hue: hues.get(c), size: members.get(c).length, label: label.get(c) }))
      .sort((a, b) => b.size - a.size),
    kinds: [...new Set(out.map((n) => n.k))].sort(),
  };
}

export { build, worldSize };
