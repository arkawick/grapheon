# Grapheon — Claude Code Context

Graph-native code intelligence. **Graphify extracts, the Atlas renders.** Point it at a
codebase, get a navigable WebGL map plus real transitive impact analysis. Named for its
two parents: **graph** + **aeon**.

It is NOT a fork or merge of Project-Aeon. It is a third thing that borrows from both:
extraction from [Graphify](https://github.com/Graphify-Labs/graphify), the renderer and
layout pass from Project-Kagami's Atlas, the feature vocabulary from Project-Aeon.
**The property worth protecting is that it runs on any repo with no infrastructure** —
no backend, no database, no API key. Do not trade that away casually.

## Stack

- **pipeline/** — Node, CommonJS. graphology + Louvain + ForceAtlas2. No browser code.
- **web/** — Vite + React 18 + PixiJS 8 + pixi-viewport. Static; no server calls.
- npm workspaces. Node 22. **No Docker, no Python** (beyond the Graphify CLI itself).

## Running it

```bash
graphify update <repo> --no-cluster        # AST extract, deterministic, no LLM
cp <repo>/graphify-out/graph.json data/<name>/graph.json
npm install
npm run build:graph -- --name <name>       # adapt + Louvain + FA2
npm run dev                                # http://localhost:5180

npm test                                   # blast.js unit tests
npm run drive --workspace web              # Playwright screenshot + console check
```

## The three passes

```
graphify update  ->  graph.json  ->  graph.canonical.json  ->  <name>.layout.json  ->  browser
                    (raw)          (adapters/)             (layout.js)          (AtlasRenderer)
```

`docs/CONTRACT.md` specifies both intermediate files. **The extractor is pluggable**:
adding one means writing an `adapt()` function and registering it in `ADAPTERS`. That
seam is the whole design — Graphify serves the code domain, Kagami's AniList crawl would
serve the media domain, everything downstream is shared.

Collapsing any two passes would force the expensive one to run at the frequency of the
cheap one. The browser receives coordinates and **never runs physics**.

## Key files

- `pipeline/adapters/graphify.js` — the only place that knows Graphify's shape
- `pipeline/layout.js` — Louvain + seeded FA2 + world box. Ported from Kagami's
  `scripts/generate-layout.js`; read that file's comments before changing this one.
- `pipeline/build.js` — CLI, writes both artifacts and stamps them with a `buildId`
- `web/src/AtlasRenderer.js` — PixiJS map. Sprites + tint, spatial-hash hit testing.
- `web/src/lib/blast.js` — transitive impact. Pure, tested, no React.
- `web/src/App.jsx` — data loading, renderer lifecycle, router. Canvas lives here.

## Architecture rules

- **No backend.** If something seems to need one, check whether it can be precomputed
  into the build or done client-side first. A server is warranted only by: an LLM key,
  cross-session persistence, or a corpus too large to ship to the browser (>~50k edges).
- **The canvas is mounted ABOVE the router, never inside a route.** Routing it rebuilds
  the WebGL context on every navigation (~0.5–1.5s) and re-triggers the init race below.
  Pages render as panels over a map that never unmounts; shared state goes through
  `GraphContext`.
- **HashRouter, not BrowserRouter.** Deep links must survive on a static host with no
  rewrite rules.
- **Carry Graphify's EXTRACTED/INFERRED tag through every stage.** It is the one thing
  no comparable tool has, and it is what lets Blast Radius distinguish "this will break"
  from "this might break."
- Builds must stay **reproducible** — see the seeding gotcha.

## Hard-won gotchas (each cost real debugging time here)

- **Graphify's graph.json calls them `links`, not `edges`,** and the top-level shape is
  `{nodes, links, directed}`. The README documents an `extract` subcommand that **does
  not exist** in the CLI (v0.9.32) — the code-only path is `graphify update <path>`.
  `--no-cluster` skips their Leiden pass and its LLM community naming; we run our own
  Louvain and name communities deterministically, so it is not a downgrade.
- **~12% of links point at nodes that do not exist** (`os`, `typing`, `uuid` — imported,
  never declared). The adapter **materialises** them as kind `external` rather than
  pruning, because dependency edges are exactly what a code map should show. They are a
  filterable kind so they can be hidden.
- **Graphify emits `weight: 1.0` on every link**, so relation type is the only signal
  available. `RELATION_WEIGHT` in the adapter is what stops "file contains function" and
  "file imports os" from pulling equally hard.
- **Do NOT port Kagami's `log1p` edge-weight compression.** It is essential there
  (weights span 1..6000, a heavy tail) and actively harmful here (bounded 0.35..1.0, no
  tail) — compressing destroys real distinctions.
- **FA2 constants must scale with graph density.** Kagami's (scalingRatio 12, gravity
  0.4) assume average degree ~25. Aeon's code graph is ~3.2, where that repulsion flings
  nodes out of their own community: measured, **11.9%** of intra-community edges spanned
  >20% of the map, rendering as bright spikes. Re-tuned to (2, 1.5) → **0.6%**. 600 and
  1200 iterations score identically, which is the signature of a force-balance problem
  rather than an unconverged one — **do not "fix" a bad layout by adding iterations.**
- **The world box scales with node count** (`worldSize`, calibrated so Kagami's
  8000→20000 pair is unchanged). A fixed box makes a small corpus render as dust.
- **Louvain and orphan jitter are seeded** (`mulberry32`). Left on `Math.random`, two
  runs over identical input gave 48 then 47 communities — meaning the committed
  canonical graph did not pin the map derived from it. Verify with the layout hash, not
  the file hash: `meta.laid_out_at` is a timestamp and always differs.
- **Each renderer creates its own canvas.** StrictMode double-mounts, and `destroy()`
  cannot run until the first `init()` resolves — so two Applications briefly race for
  one WebGL context. That wedges the app in its loading state **on some machines and
  never in headless**, so it will not reproduce in `_drive.mjs`.
- **Never verify the map by sampling canvas pixels.** Without `preserveDrawingBuffer`,
  drawImage-ing a WebGL canvas into a 2D one always reads back blank. Trust the
  Playwright screenshot. (Inherited from Kagami; still true.)
- **Screenshot the RESTING map, not a selected one.** Selecting dims every non-neighbour
  to alpha 0.06, which against `#0a0a0f` is invisible — a post-selection screenshot says
  nothing about whether the layout is any good.
- **`node --test <dir>` fails** with MODULE_NOT_FOUND on Node 22 here; point it at the
  file (`node --test src/lib/blast.test.js`).
- **graphify labels methods with a leading dot** (`.connect()`) while functions
  are bare (`connect()`). Any name comparison against its output must strip
  both the dot and the `()` — this artifact alone turned a true 100% recall
  into an apparent 82.5% in the WASM kill-test.
- **npm workspaces hoist devDependencies to the repo root** — `playwright`
  lives in `node_modules/`, not `web/node_modules/`. Scripts outside the
  workspaces (e.g. `bench/`) must import from the root.
- **Blast Radius direction is easy to invert.** `'in'` follows edges pointing AT the
  root = dependents = "what breaks if I change this". `'out'` = dependencies. The
  adjacency stores both directions per edge; the tests pin the convention.
- **Certainty is a property of the PATH, not the edge.** One INFERRED hop upstream makes
  everything past it uncertain. A node is certain if *any* fully-extracted path reaches
  it, but its reported depth stays the shortest path's — the two are tracked
  independently on purpose.
- **`layout.json` and `edges.json` are stamped with a shared `buildId`** and the app
  refuses to mix builds. Without it a cached layout resolves fewer ids and silently
  returns a *smaller* blast radius — a plausible-looking wrong number.

## State

Extracted from Project-Aeon: **1038 nodes, 1678 edges, 48 communities**. Louvain
recovers the real architecture (`api.js`, `graph.py`, `blast_radius_service.py`,
`llm.py`) without being told anything about it.

Working: Atlas (map, search, kind filters, subsystem legend, click-to-select with
neighbourhood spotlight), Blast Radius (both directions, depth 1–6, path-certainty),
sidebar shell. Production build verified serving statically.

## WASM extraction (bench/)

The kill-test for browser/Android extraction **passed** — see `bench/RESULTS.md`.
web-tree-sitter + @vscode/tree-sitter-wasm (prebuilt grammars) hit **100%
entity recall** vs graphify's ground truth at **8.3 ms/file in Chromium**.
What remains unproven: edge extraction (call/import resolution — the actual
hard part of a port) and real-device Android performance. The strategic point:
extraction-in-JS makes Grapheon zero-install in a browser, and Android becomes
a thin Capacitor shell over the same code rather than a separate bet.

## Known gaps

- **`CORPUS` is hardcoded to `'aeon'`** in `App.jsx`. Multi-corpus is the next feature;
  the natural second is Kagami's *source* (a normal Python+JS codebase Graphify can
  extract directly) — **not** its AniList API, which needs Docker and a backend on :8100.
- **The `contains` anomaly is uninvestigated**: 43 edges separate a file from functions
  it contains, meaning Louvain sometimes splits them. Containment should be
  near-unbreakable — likely wants a weight above 1.0. Correctness smell, not cosmetic.
- The INFERRED caveat UI is **built but unexercised** — Aeon has only 14 inferred edges
  and none appear in the `api.js` example.
- No guard for a blast radius that returns most of the graph on a dense corpus.
- Only `blast.js` is tested. The adapter and layout pass are verified by eye and by the
  Playwright drive.
- `pipeline/layout.js` is a **copy** of Kagami's, not a shared import, and has diverged
  (string ids, no log-compression, density-adaptive physics, seeding). Improvements do
  not flow back.
- 12 n8n workflow JSON files in Aeon produced zero nodes and are absent from the graph.
