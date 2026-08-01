# Grapheon

Graph-native code intelligence. **Graphify extracts, the Atlas renders.**

Point it at a codebase and get a navigable WebGL map of it: entities positioned
by ForceAtlas2, coloured by Louvain community, with every relation tagged as
read-from-source or inferred.

Named for its two parents: **graph** + **aeon**. The extraction layer comes from
[Graphify](https://github.com/Graphify-Labs/graphify); the renderer is ported
from Project-Kagami's Atlas; the feature vocabulary comes from Project-Aeon.

## Run it

```bash
# 1. extract (deterministic, local, no API key, no LLM credits)
graphify update ../Project-Aeon --no-cluster
cp ../Project-Aeon/graphify-out/graph.json data/aeon/graph.json

# 2. adapt + lay out
npm install
npm run build:graph -- --name aeon

# 3. serve
npm run dev            # http://localhost:5180
```

Verify it:

```bash
npm test                         # blast.js unit tests
npm run drive --workspace web    # Playwright screenshot + console-error check
```

## How it fits together

```
graphify update       AST parse, 36 languages, zero LLM
      |
      v  graphify-out/graph.json
pipeline/adapters/    -> canonical graph      (swap this to swap extractor)
      |
      v  data/<name>/graph.canonical.json
pipeline/layout.js    Louvain -> seeded ForceAtlas2 -> world box
      |
      v  web/public/data/<name>.layout.json  +  <name>.edges.json
web/                  PixiJS WebGL Atlas
```

`docs/CONTRACT.md` specifies both intermediate files. Adding an extractor means
writing one `adapt()` function and registering it — that seam is the whole
design.

## Why three passes

Extraction is deterministic and slow-ish, layout is a batch physics job, and
rendering must hold 60fps. Collapsing any two of them would force the expensive
one to run at the frequency of the cheap one. The browser receives coordinates
and never runs physics.

It also means **no backend**: the app loads static JSON, so the whole thing
deploys to any static host.

## Pages

**Atlas** — the map. Search over labels and paths, filter by kind, jump to a
subsystem from the legend, click any node to spotlight its neighbourhood and
list its relations, each tagged EXTRACTED or INFERRED.

**Blast Radius** — transitive impact, in both directions:

- *Impact* — what breaks if this changes (follows edges pointing at the root)
- *Dependencies* — what you'd need to understand to change it

Depth is adjustable 1–6, and results are grouped into rings by distance.
**Certainty propagates along the path, not per edge** — one inferred hop
anywhere upstream makes everything past it a maybe, and the panel says how many.

This is the feature Graphify makes honest: Aeon computes the same idea from
GitHub PR file paths and a `_classify_file` heuristic, while this traverses
edges a parser actually read.

## Current state

Extracted from Project-Aeon: **1038 nodes, 1678 edges, 48 communities**. The top
communities Louvain finds are `api.js`, `graph.py` (the LangGraph agent),
`blast_radius_service.py`, `llm.py` — i.e. it recovers Aeon's actual
architecture without being told anything about it.

Blast Radius on `aeon/frontend/src/lib/api.js` returns the real dependency
chain: all 10 pages that import it, then `App.jsx` at 2 hops, `main.jsx` at 3.

Production build verified serving statically — 470 KB JS (144 KB gzip) plus
363 KB of data, no backend.

Not built yet: multi-corpus, the agent layer, Neo4j push, and the Kagami adapter.

## Known rough edges

- **`CORPUS` is hardcoded** to `'aeon'` in `App.jsx`; multi-corpus is next.
- **The `contains` anomaly is uninvestigated** — 43 edges separate a file from
  functions it contains, meaning Louvain sometimes splits them. Containment
  should be near-unbreakable, so this is a correctness smell.
- Community labels are the most-connected member, which is a good subsystem
  name about 80% of the time and an arbitrary one otherwise.
- The inferred-path caveat is built but unexercised: Aeon has only 14 INFERRED
  edges and none appear in the `api.js` example.
- No guard for a blast radius that returns most of a dense graph.
- Only `blast.js` has tests. The adapter and layout pass are verified by eye and
  by the Playwright drive.
- `graphify update` warned that 12 JSON files (n8n workflow definitions)
  produced zero nodes and are absent from the graph.
