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

Verify it painted:

```bash
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

## Current state

Extracted from Project-Aeon: **1038 nodes, 1678 edges, 48 communities**. The top
communities Louvain finds are `api.js`, `graph.py` (the LangGraph agent),
`blast_radius_service.py`, `llm.py` — i.e. it recovers Aeon's actual architecture.

Working: the map, search over labels and paths, kind filters, subsystem legend,
click-to-select with neighbourhood spotlight and an EXTRACTED/INFERRED-tagged
relation list.

Not built yet: the agent layer, Neo4j push, and the Kagami adapter (the second
domain pack that proves the pipeline is not code-specific).

## Known rough edges

- Node extent is roughly circular inside a square world box, so the map leaves
  dead space in the corners at the default fit.
- Community labels are the most-connected member, which is a good name for a
  subsystem about 80% of the time and an arbitrary one otherwise.
- `graphify update` warned that 12 JSON files (n8n workflow definitions)
  produced zero nodes and are absent from the graph.
