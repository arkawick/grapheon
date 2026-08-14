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
            Python, JavaScript/JSX, TypeScript/TSX
pipeline/   canonical graph -> Louvain -> ForceAtlas2 -> layout artifacts
web/        the desktop/browser app: Vite + React + PixiJS. No backend.
android/    the phone app: a Capacitor shell around web/dist, built in Docker
docker/     Dockerfile + nginx.conf for the web app (see docker-compose.yml)
scripts/    make-logo.mjs — every logo asset, generated from 86.svg
bench/      the kill-test evidence (RESULTS.md) that justified the JS port
data/       one directory per extracted corpus
docs/       CONTRACT.md — the two JSON shapes everything meets at
```

Two independent Docker setups, on purpose: `docker/` builds and serves the web
app; `android/docker/` is a toolchain image that produces an APK. They share
nothing.

Desktop and Android are deliberately separated: `web/` never references
`android/`, and the only thing crossing the boundary is `web/dist`, copied in
by `npx cap sync android` (config at the repo root, `capacitor.config.json`).

## Run it

### With Docker (nothing to install but Docker)

```bash
docker compose up web     # production build  -> http://localhost:8090
docker compose up dev     # vite + hot reload -> http://localhost:5180
```

`web` is the honest deployment shape: a static build served by nginx, no
backend, nothing to configure. Layout artifacts aren't committed, so the image
regenerates them from the committed canonical graphs — a fresh clone works
with no setup step. `dev` mounts the source for hot reload.

Verified end to end against the container: the full Playwright drive passes
through nginx, including in-browser WASM extraction (20 files → 101 nodes) and
the mobile pass.

Port 8090 rather than 8080 on purpose — on a WSL machine `wslrelay` can
already own loopback:8080 for a distro-side service, and WSL's forwarding
beats Docker's binding. The symptom is a bare 404 with *nothing* in nginx's
log, which is a confusing hour if you don't know to look.

### On the host

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

## Insights

The one page that talks first. Everything else answers a question you have to
know to ask; **Insights** computes what the graph already noticed:

- **Most depended-upon** — change these and the most breaks
- **Possibly unused** — callables nothing references
- **Cycles** — groups that depend on each other
- **Coupling** — entities reaching across several subsystems

The unused list is the one that needed care. Raw "no inbound reference" was
**156 of Aeon's 335 callables** — a number nobody would trust, because a
FastAPI route is called by the framework, not by code the parser can see. Entry
points are detected from the graph itself (a `@router.get` decorator shows up
as a reference to a file-scoped verb) and held back separately: **96 likely
unused, 60 excluded as entry points or runtime hooks**.

**Export report** writes it all as markdown; **Map as PNG** exports the Atlas.

## History

Loading a corpus used to *destroy* the previous one — opening a second repo
meant re-picking the folder and re-parsing to get the first back. Every build
is now saved to IndexedDB, and **History** lists them for instant restore
(measured: **261 ms**, versus seconds of re-extraction), with sources, edges
and the knowledge index all intact.

Builds are **versioned**: re-extracting a changed repo keeps the previous
build rather than overwriting it (identical content refreshes in place instead
of hoarding duplicates). Up to 3 versions per corpus, and old versions of one
corpus are evicted before other corpora are.

**Compare** any two builds to see what changed:

- entities and dependencies added/removed
- files added/removed
- **new cross-subsystem dependencies** — the headline. A module reaching into
  a part of the system it previously had nothing to do with is architecture
  drift, and it's invisible in a normal `git diff`: one import line among
  hundreds. Edges from brand-new files are excluded — a new file has to
  connect to something; drift is *old* code reaching somewhere new.

Diffs export as markdown too.

Stored on the device only. Bounded to 8 corpora / 120 MB, oldest evicted
first — they're large and always regenerable, and an unbounded cache would
eventually fail at write time, which is the worst moment to find out.

The Knowledge query box also keeps your recent questions, per corpus.

## Knowledge base

A second, separate use case: point it at documents instead of code.
**Open documents…** takes `.md` / `.txt` / `.rst` / **`.pdf`**, and
**Knowledge** in the sidebar lets you query them.

**PDFs** are converted to markdown-ish text by pdf.js before anything else
sees them — headings are detected by font size relative to the document's
median, so the rest of the pipeline treats a PDF exactly like a `.md` file.
pdf.js is loaded only when a PDF is actually present.

One real limit: a **scanned PDF has no text layer** — it's images of text —
and is skipped with a message saying so rather than silently contributing
nothing. Extracting it would need OCR, which is a different project.

(The *legacy* pdf.js build is used deliberately: the default one calls
`Uint8Array.prototype.toHex()`, an ES2025 method that many browsers and
Android WebViews don't have yet.)

- Documents are split **document → section → passage**. Sections become graph
  nodes; passages are what search ranks. One node per paragraph would make an
  unreadable map, and a retriever that only returns whole documents is useless.
- Retrieval is **BM25** — real ranking with term saturation and length
  normalisation, no model, no download, no key. Matching terms are highlighted
  and each hit opens its source document at that passage's own line.
- **The same Atlas renders it.** The document graph goes through the identical
  pipeline (Louvain → ForceAtlas2), so your documents become a map clustered
  by shared vocabulary — 18 of Aeon's markdown files give 284 nodes in 7
  topic clusters. Section-to-section similarity edges are tagged `INFERRED`,
  because word overlap is a guess where a heading hierarchy is a fact.

What it deliberately does **not** do is write prose answers — that needs an
LLM. You get ranked evidence with its source, which for a base you're trying
to trust is the more useful half. PDF support and optional on-device
embeddings are the natural next steps.

## Linking code and documents

The two corpora describe the same system. **Link** in History holds a second
corpus alongside the active one and finds where prose names real code:

- a code entity's panel shows **Documented in** — the passages that discuss it
- a Knowledge result shows the **code it mentions**, clickable straight to the
  source

No model. Matching is deliberately conservative, because a join that links
every "get" and "data" is worse than none: generic identifiers are refused
outright, undistinctive ones only count inside backticks (an explicit "this is
code" from the writer), a form shared by two entities is dropped rather than
guessed, and a term appearing in a fifth of all passages is treated as
vocabulary rather than a reference.

On Aeon that gives 218 mentions — `Neo4jStore` correctly resolving to the one
passage that discusses it, in "Hard-won gotchas".

## File explorer

**Files** in the sidebar opens the repo as a directory tree beside the map.
Every readable file is there — including the ones the extractor never parsed,
which is the point: a README, `package.json`, `docker-compose.yml` or a CI
workflow has no graph node, and before the explorer they were unreachable
even though you had just handed the app the whole folder.

Files that *are* on the map carry a dot in their community's colour; files
that aren't get a hollow one. So the tree and the graph are visibly the same
repository seen two ways, and selecting a node reveals it in the tree.

Reading order is nav rail → tree → map → code, the same left-to-right layout
every editor uses. **Drag the dividers** to rebalance — the map reflows live
(it's a canvas, so that isn't automatic), widths persist across reloads, and
double-clicking a divider resets it. The map keeps a 200px floor whatever the
dividers say. **Tabs** appear once a second file is open (a lone tab is
noise above a header that already names the file), and closing one falls back
to its left neighbour.

**Search** scans the contents of every readable file — the question the graph
can't answer, like *where does `AZURE_OPENAI_ENDPOINT` appear*. Results stream
in grouped by file with the match highlighted; clicking a hit opens that file
at that line. A cold search over Aeon's 142 files takes ~3s (each file is
fetched once), and every search after that is ~100ms.

For a dropped folder or zip this costs nothing — those files were already in
memory and were simply being discarded. For prebuilt corpora, docs and
manifests are captured up to a **2 MB budget** on top of the graph's own
files, chosen by filename rather than extension (an extension whitelist looked
sensible and swept in 17.6 MB of data dumps).

## Code viewer

Select any entity and hit **View code** — the map shrinks left, the source
opens right, scrolled to that entity's lines with its range highlighted.
Syntax highlighting via highlight.js.

It's a split *mode*, not a page, deliberately: the map has to stay visible
beside the code (that's the point), it works from Blast Radius as well as the
Atlas, and code is always *about a selection* rather than a destination.

The gutter is graph-aware — lines where a neighbour of the selection is
defined get a marker, so the relations in the panel and the lines in the file
are the same information seen two ways.

Source text is captured at extraction time and served **per file** from a
mirrored tree (`/data/<name>/src/…`). Not one blob: the full Aeon corpus is
18 MB of text, and opening one function shouldn't download that. For a corpus
extracted in the browser it's free — the worker still holds every file.

**On a phone**, the header collapses to a tappable **Grapheon** logo that opens
a drawer holding everything: navigation, Files, Search, and the repo/zip
upload. Flat, they needed 504px of row inside a 390px screen — items
overlapped and the upload button sat entirely off-screen, so there was no way
to load a repo at all.

The code pane goes full-screen over the map, and **word wrap is on by
default** — a 390px screen shows ~45 columns, and without it `llm.py` needs
706px of horizontal scrolling to read one line. Toggle it off from the header.
Android's **back button closes the code pane** (then clears the selection)
before it will leave the app.

A corpus without captured sources simply has no code viewer. To add it to one
built by the graphify CLI:

```bash
node pipeline/collect-sources.js --name aeon --repo ../Project-Aeon
npm run build:graph -- --name aeon
```

## Pages

**Atlas** — the map. Search over labels and paths, filter by kind, jump to a
subsystem from the legend, click any node to spotlight its neighbourhood and
list its relations, each tagged EXTRACTED or INFERRED.

The legend **collapses to a pill** on any screen, and the choice is
remembered. It defaults open on a desktop, where it is useful context, and
closed on a phone, where it would cover the whole map.

**Blast Radius** — transitive impact, in both directions:

- *Impact* — what breaks if this changes (follows edges pointing at the root)
- *Dependencies* — what you'd need to understand to change it

It takes a **change set**, not just one node — real changes touch several
things at once, and asking about them together is not three separate
questions: something two hops from each of three roots is two hops away, not
six. Results export as a markdown report you can paste into a PR.

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
