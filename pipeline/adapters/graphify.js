/**
 * Graphify (graphify-out/graph.json) -> canonical graph.
 *
 * Produce it with:  graphify update <repo> --no-cluster
 *
 * `--no-cluster` is deliberate. Graphify's own clustering runs Leiden and then
 * asks an LLM to name the communities; we run Louvain in layout.js and name
 * communities deterministically from their most-connected member. Skipping it
 * keeps the whole pipeline reproducible and free of API keys.
 */

// Graphify's file_type, mapped to our `kind`. These are the four it emits:
//   code      - a file, function, class or symbol parsed from source
//   document  - prose (markdown, rst, plain text)
//   rationale - a docstring or comment block, linked to what it documents
//   concept   - a declared dependency (package.json / pyproject entries)
const KIND_BY_FILE_TYPE = {
  code: 'code',
  document: 'document',
  rationale: 'rationale',
  concept: 'concept',
};

/**
 * How hard each relation pulls in the layout.
 *
 * Graphify emits `weight: 1.0` on every single link, so relation type is the
 * ONLY signal available to differentiate them — without this table the layout
 * treats "this file contains this function" and "this file imports os" as
 * equally strong, and the map collapses around stdlib hubs.
 *
 * Containment and inheritance are the real skeleton; imports of external
 * modules are the weakest thing here, because every Python file importing
 * `typing` says nothing about how the codebase is organised.
 */
const RELATION_WEIGHT = {
  contains: 1.0,       // file -> its own functions/classes
  method: 1.0,         // class -> its methods
  inherits: 1.0,       // subclass -> base
  calls: 0.9,          // real call edges: the most informative non-structural signal
  rationale_for: 0.6,  // docstring -> the thing it documents
  references: 0.5,     // named mention, weaker than a call
  indirect_call: 0.4,  // resolved through a variable; a guess by nature
  imports_from: 0.35,
  imports: 0.35,
};
const DEFAULT_RELATION_WEIGHT = 0.5;

// Graphify tags every link EXTRACTED (literally present in the source) or
// INFERRED (resolved by analysis). An inferred edge is a hypothesis, so it
// gets half the pull of one the parser actually read.
const INFERRED_FACTOR = 0.5;

/**
 * @param {object} raw   parsed graphify-out/graph.json
 * @param {string} name  corpus name, e.g. "aeon"
 * @returns {{meta: object, nodes: object[], edges: Array}}
 */
function adapt(raw, name) {
  // Graphify calls them `links`, not `edges`. Guard explicitly: a silent
  // undefined here produces an empty graph and a layout of 991 orphans.
  const links = raw.links;
  if (!Array.isArray(links)) {
    throw new Error("graph.json has no `links` array — is this really graphify output?");
  }
  if (!Array.isArray(raw.nodes)) {
    throw new Error('graph.json has no `nodes` array');
  }

  const nodes = raw.nodes.map((n) => ({
    id: n.id,
    label: n.label ?? n.id,
    kind: KIND_BY_FILE_TYPE[n.file_type] ?? 'other',
    weight: 0, // filled in from degree by layout.js
    attrs: {
      path: n.source_file ?? null,
      loc: n.source_location ?? null,
    },
  }));

  // ~12% of Graphify's links point at something that is not a node: stdlib and
  // third-party modules (`os`, `typing`, `uuid`) get imported but never parsed,
  // so nothing declares them.
  //
  // Kagami's layout pruned edges with a missing endpoint, because a bare node
  // had no properties to position. Here we materialise them instead, as kind
  // `external`. Dropping them would throw away every dependency edge in the
  // corpus, and "which parts of this codebase touch the network" is exactly the
  // sort of question the map should answer. They stay a separate kind so the UI
  // can filter them out when they get in the way.
  const known = new Set(nodes.map((n) => n.id));
  const external = new Map();
  for (const l of links) {
    for (const endpoint of [l.source, l.target]) {
      if (!known.has(endpoint) && !external.has(endpoint)) {
        external.set(endpoint, {
          id: endpoint,
          label: endpoint,
          kind: 'external',
          weight: 0,
          attrs: { path: null, loc: null },
        });
      }
    }
  }
  nodes.push(...external.values());

  const edges = links.map((l) => {
    const base = RELATION_WEIGHT[l.relation] ?? DEFAULT_RELATION_WEIGHT;
    const w = l.confidence === 'INFERRED' ? base * INFERRED_FACTOR : base;
    return [l.source, l.target, w, l.relation ?? 'related', l.confidence ?? 'EXTRACTED'];
  });

  return {
    meta: {
      source: 'graphify',
      name,
      directed: raw.directed === true,
      generated_at: new Date().toISOString(),
      counts: {
        nodes: nodes.length,
        edges: edges.length,
        materialised_external: external.size,
      },
    },
    nodes,
    edges,
  };
}

module.exports = { adapt, RELATION_WEIGHT, KIND_BY_FILE_TYPE };
