# Grapheon

Graph-native code intelligence. **Graphify extracts, the Atlas renders.**

Point it at a codebase and get a navigable WebGL map of it: entities positioned
by ForceAtlas2, coloured by Louvain community, with every relation tagged as
read-from-source or inferred.

Named for its two parents: **graph** + **aeon**. The extraction layer comes from
[Graphify](https://github.com/Graphify-Labs/graphify); the renderer is ported
from Project-Kagami's Atlas; the feature vocabulary comes from Project-Aeon.

## Layout

```
extract/    JS/WASM port of graphify's extraction (runs in Node AND browser)
pipeline/   canonical graph -> Louvain -> ForceAtlas2 -> layout artifacts
web/        the desktop/browser app: Vite + React + PixiJS. No backend.
android/    the phone app: a Capacitor shell around web/dist, built in Docker
bench/      the kill-test evidence (RESULTS.md) that justified the JS port
data/       one directory per extracted corpus
docs/       CONTRACT.md — the two JSON shapes everything meets at
```

Desktop and Android are deliberately separated: `web/` never references
`android/`, and the only thing crossing the boundary is `web/dist`, copied in
by `npx cap sync android` (config at the repo root, `capacitor.config.json`).

## Run it

```bash
npm install

# 1. extract — the JS/WASM extractor, no Python, no API key
node extract/node.mjs ../some-repo --out data/somerepo/graph.json

# 2. adapt + lay out
npm run build:graph -- --name somerepo

# 3. serve
npm run dev            # http://localhost:5180
```

(The original Python route still works and produces the same shape:
`graphify update <repo> --no-cluster`, then copy `graphify-out/graph.json`
into `data/<name>/`. The JS extractor scores 97.7% link recall against it —
`bench/RESULTS.md` has the full comparison.)

Or skip the CLI entirely: `npm run dev`, then **Open a repo…** in the sidebar
extracts in the browser.

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

## Zero-install: open a repo in the browser

The sidebar's **Open a repo…** picks a local folder and runs the whole
pipeline client-side — WASM tree-sitter parse, adapt, Louvain, ForceAtlas2 —
in a Web Worker, then swaps the map in place. Nothing is uploaded anywhere;
there is no server to upload to. The same flow works in the production build
(the WASM grammars ship as static assets), which is what makes Grapheon
deployable as a plain static site that can still ingest new repos.

Automation/console entry point: `window.__loadRepoFiles([{path, src}], name)`
drives the identical code path minus the picker.

**On a phone there is no folder picker** — mobile WebViews don't implement
`webkitdirectory` — so the mobile path is **Open a repo .zip…** (GitHub →
Code → Download ZIP feeds it directly). Zips are unpacked client-side with
fflate; the same filters apply, plus a minified-file guard.

## Android (Capacitor, built in Docker)

`android/` is a Capacitor shell around the same `web/dist`. The release build
runs **inside Docker** — the image carries the whole toolchain (Node 22,
Temurin JDK 21, Android SDK 36), so nothing Android-related needs installing
on the host:

```bash
./android/docker-build.sh
# -> android/app/build/outputs/apk/release/app-release.apk  (signed)
```

The repo is volume-mounted into the container, which is what keeps the
keystore out of image layers — signing material is never baked into anything
that could be pushed.

**Signing** reads `android/keystore.properties` (gitignored) pointing at
`android/keystore/` (gitignored). Without them, release builds come out
unsigned rather than failing. **Back both files up somewhere safe** — losing
the keystore means losing the app identity for updates.

Debug builds on the host still work if you have a JDK + SDK:
`npm run sync:android && cd android && ./gradlew assembleDebug`.

The app is the static site verbatim — extraction runs in the WebView's
worker, on-device, offline.

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

Production build verified serving statically — ~470 KB JS (145 KB gzip) plus
363 KB of data, no backend. The same build runs in-browser extraction (WASM
grammars ship as assets) and is what the Android shell wraps: a debug APK is
built and verified, with a responsive phone UI checked by Playwright at
390x844 with touch on every drive run.

Not built yet: multi-corpus UI, the agent layer, Neo4j push, and the Kagami
adapter.

**In flight — signed Android release.** The keystore exists
(`android/keystore/` + `android/keystore.properties`, both gitignored —
**back them up**; losing them loses the app identity), gradle signs when they
are present, and the Docker toolchain image (`android/docker/`) is written but
its first build failed at the SDK-install step with the error swallowed by a
`> /dev/null` (since removed, so the next run will say what's wrong). Resume
with: `./android/docker-build.sh`.

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
