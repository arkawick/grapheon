# Architecture

Why Grapheon is shaped the way it is. This is the "detailed explanation"
document: what each layer does, what it deliberately does *not* do, and the
reasoning behind the decisions that would otherwise look arbitrary.

For commands, see [RUNNING-WEB.md](RUNNING-WEB.md) and
[RUNNING-ANDROID.md](RUNNING-ANDROID.md). For the exact JSON shapes, see
[CONTRACT.md](CONTRACT.md).

---

## Contents

- [The one property worth protecting](#the-one-property-worth-protecting)
- [The three passes](#the-three-passes)
- [Pass 1 — extraction](#pass-1--extraction)
- [Pass 2 — layout](#pass-2--layout)
- [Pass 3 — rendering](#pass-3--rendering)
- [The extractor seam](#the-extractor-seam)
- [Why there is no backend](#why-there-is-no-backend)
- [Certainty: EXTRACTED vs INFERRED](#certainty-extracted-vs-inferred)
- [The features, and what each one had to solve](#the-features-and-what-each-one-had-to-solve)
- [Reproducibility](#reproducibility)
- [Repository layout](#repository-layout)

---

## The one property worth protecting

**Grapheon runs on any repo with no infrastructure.** No backend, no database,
no API key, no account. Point it at a folder and it works; deploy it to a
static host and it still works; put it in an APK and it still works, offline.

Almost every design decision below follows from defending that property. When
something seems to need a server, the first question is whether it can be
precomputed into the build or done client-side. A server would only be
warranted by an LLM key, cross-session persistence across devices, or a corpus
too large to ship to a browser (>~50k edges).

Grapheon is not a fork of anything. It borrows extraction from
[Graphify](https://github.com/Graphify-Labs/graphify), the renderer and layout
pass from Project-Kagami's Atlas, and the feature vocabulary from Project-Aeon
— and is a third thing.

---

## The three passes

```
extract                 adapt              layout               render
─────────────────────   ────────────────   ──────────────────   ──────────────
tree-sitter parse   →   canonical graph →  Louvain + FA2    →   PixiJS WebGL
(Node CLI | Worker      (adapters/)        (layout.js)          (AtlasRenderer)
 | graphify CLI)
                        graph.canonical    <name>.layout.json
                        .json              <name>.edges.json
```

Each arrow is a **JSON file with a specified shape**, not a function call.
That is the whole design.

### Why not collapse them

The three have wildly different cost profiles:

| Pass | Cost | Frequency it wants |
|---|---|---|
| Extraction | slow-ish, deterministic | once per code change |
| Layout | batch physics job | once per graph change |
| Rendering | must hold 60 fps | 60× per second |

**Collapsing any two forces the expensive one to run at the frequency of the
cheap one.** Fusing layout into rendering would mean running ForceAtlas2 every
frame; fusing extraction into layout would mean re-parsing on every relayout.

So the browser receives **coordinates** and never runs physics. It also means
the app is static files, which is what makes the no-backend property possible
at all.

---

## Pass 1 — extraction

Turns source code into `{nodes, links}`. Three interchangeable implementations,
all emitting the same raw shape:

1. **`extract/node.mjs`** — the JS/WASM extractor as a CLI
2. **`web/src/worker/extract-worker.js`** — the same core in a browser Worker
3. **the Graphify CLI** — the original Python tool, still supported

Languages: Python, JavaScript/JSX, TypeScript/TSX. `.ts/.mts/.cts` use the
TypeScript grammar; **`.tsx` uses the TSX grammar** — the plain TS grammar
reads `<div>` as a type assertion, so every JSX element becomes a parse error
and a `.tsx` file yields almost nothing.

The JS extractor scores **97.7% link recall** and **100% entity recall**
against Graphify's output (`bench/RESULTS.md`). `indirect_call` is deliberately
not ported.

### Two findings that shaped the adapter

**~12% of links point at nodes that don't exist** — `os`, `typing`, `uuid`:
imported but never declared in the corpus. The adapter **materialises** them as
kind `external` rather than pruning them, because dependency edges are exactly
what a code map should show. They're a filterable kind so they can be hidden.

**Graphify emits `weight: 1.0` on every link**, so relation *type* is the only
available signal. `RELATION_WEIGHT` in the adapter is what stops "file contains
function" and "file imports os" from pulling equally hard in the layout.

### Path aliases were the whole ballgame for TypeScript

`@/lib/utils` and `baseUrl` imports are the norm in TS projects. Treating them
as npm packages left a real 79-file repo with **5 of 138 imports resolved** — a
map of disconnected dots that parsed perfectly and meant nothing.
`resolveAlias` suffix-matches against the corpus, taking it to 107/158, with
every remaining external a genuine package.

The guard rail: **never suffix-match a bare single-segment specifier.** A local
`utils.ts` would otherwise swallow the npm package `utils`. Ambiguous matches
resolve to nothing — a wrong edge is worse than no edge.

---

## Pass 2 — layout

`pipeline/layout.js`: Louvain community detection, then seeded ForceAtlas2,
then a world box. Ported from Kagami's layout script and since diverged.

### Force constants must scale with graph density

Kagami's constants (`scalingRatio 12`, `gravity 0.4`) assume an average degree
of ~25. A code graph is ~3.2, where that repulsion flings nodes out of their
own community. Measured: **11.9%** of intra-community edges spanned >20% of the
map, rendering as bright spikes across the view. Re-tuned to `(2, 1.5)` →
**0.6%**.

**600 and 1200 iterations score identically**, which is the signature of a
force-balance problem rather than an unconverged one. Do not "fix" a bad layout
by adding iterations.

### Two things deliberately not ported

- **`log1p` edge-weight compression.** Essential in Kagami (weights span
  1..6000, a heavy tail), actively harmful here (bounded 0.35..1.0, no tail) —
  compressing destroys real distinctions.
- **A fixed world box.** `worldSize` scales with node count, calibrated so
  Kagami's 8000→20000 pair is unchanged. A fixed box makes a small corpus
  render as dust.

---

## Pass 3 — rendering

`web/src/AtlasRenderer.js`: PixiJS 8 + pixi-viewport. Sprites with tint rather
than individual graphics objects, and spatial-hash hit testing.

### The canvas is mounted above the router

Never inside a route. Routing the canvas would tear down and rebuild the WebGL
context on every navigation — 0.5–1.5s each time — and re-trigger an
initialisation race. **Pages render as panels over a map that never unmounts**;
shared state goes through `GraphContext`. The map is rebuilt only when the
*corpus* changes, which genuinely is a new map.

### HashRouter, not BrowserRouter

Deep links must survive on a static host with no rewrite rules. URLs look like
`/#/blast`. This is not an oversight.

### The renderer owns its canvas

React StrictMode double-mounts, and `destroy()` cannot run until the first
`init()` resolves — so two Applications briefly race for one WebGL context.
Giving each renderer its own canvas fixes it. Note that this **wedges the app
on some machines and never in headless**, so the Playwright drive cannot catch
a regression here.

---

## The extractor seam

Adding an extractor means writing one `adapt()` function and registering it in
`ADAPTERS` in `pipeline/build.js`:

```js
const ADAPTERS = {
  graphify: graphifyAdapter,
};
```

`pipeline/adapters/graphify.js` is **the only file that knows Graphify's
shape** — including that it calls them `links`, not `edges`. Everything
downstream consumes the canonical graph.

That seam is the entire design premise: Graphify serves the code domain,
Kagami's AniList crawl would serve the media domain, and everything after the
adapter is shared. The knowledge base proves it — `lib/knowledge/graph.js`
emits the *same canonical shape* from documents, so Louvain, ForceAtlas2, the
Atlas, the file tree and the code viewer all work on prose with no changes.
That is why it was a day's work rather than a rewrite.

---

## Why there is no backend

Because it isn't needed, and having one would cost the property that makes this
interesting.

| Thing that usually needs a server | How it's done here |
|---|---|
| Parsing source | WASM tree-sitter in a Web Worker |
| Graph layout | precomputed into the build, or in the Worker |
| Full-text search | BM25 index built client-side |
| Persistence | IndexedDB |
| Sharing a map | a self-contained HTML file you can email |

The cost is real but bounded: a corpus above ~50k edges is too large to ship to
a browser, and there is no cross-device sync.

---

## Certainty: EXTRACTED vs INFERRED

Every edge carries a tag saying whether it was read from the source or guessed.
This is carried through **every stage** — extraction, adapter, layout, renderer,
blast radius. It's the one thing comparable tools don't have, and it's what
lets Blast Radius distinguish *"this will break"* from *"this might break."*

**Certainty is a property of the path, not the edge.** One INFERRED hop
upstream makes everything past it uncertain. A node is certain if *any*
fully-extracted path reaches it — but its reported depth stays the shortest
path's. The two are tracked independently, on purpose.

**Direction is easy to invert**, so the tests pin the convention:
`'in'` follows edges pointing *at* the root = dependents = "what breaks if I
change this". `'out'` = dependencies. The adjacency stores both directions per
edge.

---

## The features, and what each one had to solve

Each of these exists because a simpler version was tried and produced something
misleading.

### Insights

**Structural edges are not usage.** `contains` / `method` / `rationale_for`
describe how code is *filed*, not what calls what. Count them and every
function looks referenced.

**Entry points must be separated from dead code, or the feature is worthless.**
Raw "no inbound reference" flagged **156 of Aeon's 335 callables** — mostly
FastAPI handlers the framework calls, a list nobody would trust. Entry points
are detected *from the graph* (a `@router.get` decorator appears as an outbound
reference to a file-scoped verb), not from naming conventions. Result: **96
likely unused, 60 held back**.

Tarjan's SCC is iterative on purpose — the recursive form blows the stack on a
real corpus, and a test pins it at 20k nodes.

### Knowledge base

BM25, not TF-IDF: term saturation and length normalisation are what make uneven
prose rank sensibly.

**Passages must carry their own start line.** They originally inherited the
section's, so every result from one section looked identical and opened at the
heading instead of the text.

**Filter passages with no prose** (<15 alphanumerics). A markdown `---` rule is
a real block and BM25 will happily rank it, producing a result whose entire
content is `---`. That was 70 of 439 passages on one corpus, all noise.

PDFs are converted on the **main thread** — pdf.js spawns a worker of its own,
and nesting that inside the knowledge worker made `getDocument()` hang forever
with no error, the promise simply never settling.

### Code ↔ docs join

Precision is everything; a noisy join is worse than none.

- generic identifiers (`get`, `data`, `config`) are refused outright
- undistinctive names only match inside backticks — but stay *candidates* until
  the text is examined, because filtering them at build time meant
  `` `complete()` `` could never match however it was written
- **path forms come only from the file's own node.** Every function in `llm.py`
  carries that path, so emitting it for all of them made the path ambiguous
  against its own file and killed the strongest signal available
- a form shared by two entities is dropped, not guessed
- a term in >20% of passages is vocabulary, not a reference

### Corpus diff

The headline is **drift**: a new dependency crossing a subsystem boundary,
which `git diff` cannot show because it's one import line among hundreds.

**Edges from new entities are not drift.** A new file must connect to
something; drift is *old* code reaching somewhere new. Without that filter every
added file reads as an architecture violation.

**Community ids are recomputed per build and mean nothing across two** —
compare through labels, never the numeric id.

### History

IndexedDB, not localStorage: megabytes, and structured clone stores the BM25
index's `Map`s as-is.

**Entries are versioned** (`kind:name:contentHash`). Keying on the name alone
meant re-extracting silently replaced the only copy you could have compared
against — diff was impossible by construction.

**Saving must never fail a build.** The corpus is loaded and usable whether or
not it persisted, so a full quota or private mode logs a warning and is
otherwise ignored.

### Interactive map export

Replaced a PNG export, because a static picture of a graph carries almost none
of the graph's value.

Pixi is deliberately **not** inlined: ~470 KB per exported file to draw circles
at positions already computed. Plain 2D canvas keeps the export roughly the
size of its own data — 0.31 MB for 1,038 nodes.

Two escaping traps, both tested: `<` is escaped so a node labelled `</script>`
cannot close the data block, and U+2028/U+2029 are written as escape sequences
— they are line terminators in JavaScript *source*, and a literal one inside a
regex breaks the file with a `SyntaxError` that points nowhere near the cause.

### Command palette

Sections sort by their **best match** rather than a fixed precedence, because
no fixed order gets both `blast radius` (wants the page) and `llm.py` (wants
the file) right.

Commands carry the words someone would actually type and get a bias smaller
than the gap between match tiers — so a command can outrank content that
matched equally well, but a weak command match can never jump a strong one.
Without it, Aeon's own docs made "Blast Radius" an exact entity match six times
over and buried the command to open the page.

---

## Reproducibility

Builds must be reproducible, and this took explicit work.

**Louvain and orphan jitter are seeded** with `mulberry32`. Left on
`Math.random`, two runs over identical input gave 48 then 47 communities —
meaning the committed canonical graph did not pin the map derived from it.

Verify with the **layout hash, not the file hash**: `meta.laid_out_at` is a
timestamp and always differs.

`layout.json` and `edges.json` are stamped with a shared **`buildId`** and the
app refuses to mix builds. Without it, a cached layout resolves fewer ids
against fresh edges and silently returns a *smaller* blast radius — a
plausible-looking wrong number, which is worse than an error.

---

## Repository layout

```
extract/     JS/WASM port of graphify's extraction. ESM, pure core,
             runs identically in Node and a browser Worker.
pipeline/    canonical graph -> Louvain -> ForceAtlas2 -> layout artifacts.
             ESM specifically so the browser can bundle it.
web/         the app: Vite + React 18 + PixiJS 8. Static, no server calls.
android/     Capacitor 8 shell around web/dist. At the ROOT, fully separated
             from web/. Release builds happen in android/docker/.
docker/      Dockerfile + nginx.conf for the WEB app. Entirely separate from
             android/docker/ — they share nothing.
bench/       measured evidence (RESULTS.md) behind the JS port, plus the
             committed ground truth the extractor is scored against.
data/        one directory per corpus. A working directory.
docs/        this file, CONTRACT.md, and the two running guides.
scripts/     make-logo.mjs — every logo asset, generated from 86.svg.
```

### Key files

| File | Role |
|---|---|
| `pipeline/adapters/graphify.js` | the only place that knows Graphify's shape |
| `pipeline/layout.js` | Louvain + seeded FA2 + world box |
| `pipeline/build.js` | CLI; writes both artifacts, stamps the `buildId` |
| `web/src/AtlasRenderer.js` | the PixiJS map |
| `web/src/App.jsx` | data loading, renderer lifecycle, router; the canvas lives here |
| `web/src/lib/blast.js` | transitive impact — pure, tested, no React |

### Why `bench/ground-truth/` is not in `data/`

Because **`data/` is a working directory**: re-extracting a corpus overwrites
it. The ground-truth file was once clobbered exactly that way, after which the
scoring script cheerfully reported **100% recall while comparing our output to
itself**. A benchmark you can silently overwrite is not a benchmark.

If a recall number ever looks suspiciously perfect, check what truth points at.
