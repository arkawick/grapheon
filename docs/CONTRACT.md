# The contract

Grapheon is three passes with two JSON files between them:

```
extractor  ->  graph.canonical.json  ->  <name>.layout.json  ->  browser
             (adapter)              (layout.js)            (AtlasRenderer)
```

The point of the split is that **the extractor is pluggable**. Graphify is the
extractor for the code domain; Kagami's AniList crawl would be the extractor for
the media domain. Everything downstream of the canonical file is shared.

---

## 1. Canonical graph — `data/<name>/graph.canonical.json`

Extractor-agnostic. Written by `pipeline/adapters/*.js`, committed to git.

```json
{
  "meta": {
    "source": "graphify",
    "name": "aeon",
    "directed": false,
    "generated_at": "2026-08-01T…Z",
    "counts": { "nodes": 1038, "edges": 1678, "materialised_external": 47 }
  },
  "nodes": [
    { "id": "aeon_backend_core_llm",
      "label": "llm.py",
      "kind": "code",
      "weight": 0,
      "attrs": { "path": "aeon/backend/core/llm.py", "loc": "L1" } }
  ],
  "edges": [
    ["aeon_backend_core_llm", "os", 0.35, "imports", "EXTRACTED"]
  ]
}
```

**Nodes.** `id` is a string and must be unique. `kind` drives the UI filter and
is adapter-defined (`code`, `document`, `rationale`, `concept`, `external`).
`weight: 0` means "derive it" — the layout pass fills in degree.

**Edges** are positional arrays: `[source, target, weight, relation, confidence]`.
At edge counts in the thousands the key names cost more than the data.

- `weight` is a layout hint in roughly `0..1`, not a measured quantity.
- `confidence` is `EXTRACTED` (literally present in the source) or `INFERRED`
  (resolved by analysis). Inferred edges get half the layout pull, and the UI
  tags them, because a reader deserves to know which claims were read and which
  were guessed.

### Writing a new adapter

Export `adapt(raw, name)` returning the shape above, register it in
`ADAPTERS` in `pipeline/build.js`. That is the entire integration surface.

---

## 2. Layout artifact — `web/public/data/<name>.layout.json`

Written by `pipeline/layout.js`. Gitignored (regenerable). The **only** file the
app needs for first paint, which is what makes a backendless static deploy work.

```json
{
  "meta":   { "source": "graphify", "name": "aeon", "laid_out_at": "…",
              "iterations": 600, "buildId": "3f9a2c1b8de4" },
  "nodes":  [{ "id": "…", "l": "llm.py", "k": "code", "c": 7, "h": 210,
               "r": 9.4, "x": 4021, "y": 2887, "a": { "path": "…", "loc": "L1" } }],
  "bounds": { "width": 7203, "height": 7203 },
  "communities": [{ "id": 7, "hue": 210, "size": 38, "label": "llm.py" }],
  "kinds":  ["code", "concept", "document", "external", "rationale"]
}
```

Single-letter keys are deliberate: Kagami's 8000-node layout is 2.4 MB *with*
them.

- `c` / `h` — Louvain community and its deterministic hue. Colour encodes
  community; **size (`r`) encodes degree**.
- `bounds` scales with node count so density stays constant across corpora
  (see `worldSize()`); the renderer fits the viewport to it rather than assuming
  a zoom level.
- `communities[].label` is the most-connected member of the community. For code
  a community is a subsystem, and "llm.py" reads as something where
  "Community 7" does not. No LLM involved.
- `buildId` identifies the build by its **inputs** (canonical nodes + edges +
  iterations + seed), so reproducible runs share an id and a changed corpus
  gets a new one.

**Builds are reproducible.** Louvain visits nodes in random order and orphan
parking jitters positions, so both draw from a seeded PRNG — otherwise two runs
over identical input give different community counts, and the committed
canonical graph would not pin the map derived from it. Compare the `nodes` /
`communities` / `bounds` payload, not the whole file: `laid_out_at` is a
timestamp and always differs.

**There are no edges in this file, on purpose.** Thousands of lines at 60fps buy
a grey haze that hides the clusters the layout just worked to reveal. The map
reads as pure position.

---

## 3. Edges — `web/public/data/<name>.edges.json`

```json
{
  "meta":  { "buildId": "3f9a2c1b8de4" },
  "edges": [["aeon_backend_core_llm", "os", "imports", "EXTRACTED"]]
}
```

Fetched **before first paint when the corpus is small enough to draw edges**
(`meta.counts.edges` decides, without fetching the file), and lazily on first
selection otherwise. They power the neighbourhood spotlight and Blast Radius,
with no backend involved.

`weight` is dropped here: it was a layout input, and the UI cares about the
relation and its provenance instead.

---

## 4. Source text — `web/public/data/<name>.sources.json` + `<name>/src/…`

Optional. Present only when the extractor captured source text
(`extract/node.mjs` does inline; `pipeline/collect-sources.js` adds it to a
corpus built by the graphify CLI). A corpus without it simply has no code
viewer — nothing else degrades.

The manifest is small and eagerly fetched:

```json
{
  "meta":  { "buildId": "3f9a2c1b8de4" },
  "base":  "/data/aeon/src",
  "paths": ["aeon/backend/core/llm.py", "…"]
}
```

The text itself is a **mirrored tree**, one file per source file, fetched
individually on demand: `/data/aeon/src/aeon/backend/core/llm.py`.

Deliberately not one blob. Aeon's full corpus is 18 MB of text; a reader
opening one function should download the ~4 KB they are reading, not the
repository. Only files the graph actually references are captured — a repo's
parseable files and its *mapped* files are different sets.

For a corpus extracted in the browser there is no fetch at all: the worker
still holds every file in memory, so the viewer reads from there.

**`buildId` must match the layout's**, and the app throws if it doesn't. A
cached layout against a fresh edge file resolves fewer node ids and silently
returns a *smaller* blast radius — a plausible-looking wrong number is worse
than an error.
