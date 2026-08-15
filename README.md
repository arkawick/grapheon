# Grapheon

Graph-native code intelligence. **Graphify extracts, the Atlas renders.**

Point it at a codebase and get a navigable WebGL map of it: entities positioned
by ForceAtlas2, coloured by Louvain community, with every relation tagged as
read-from-source or inferred.

**It runs on any repo with no infrastructure** — no backend, no database, no
API key, no account. Parsing happens on your machine, in a Web Worker. The same
build serves from nginx, from a static host, from `file://`, and inside an
Android WebView, offline.

Named for its two parents: **graph** + **aeon**. The extraction layer comes from
[Graphify](https://github.com/Graphify-Labs/graphify); the renderer is ported
from Project-Kagami's Atlas; the feature vocabulary comes from Project-Aeon.

---

## Documentation

| Guide | What's in it |
|---|---|
| **[docs/RUNNING-WEB.md](docs/RUNNING-WEB.md)** | Running the web app: Docker, host, and no-install routes; loading your own code; every script explained; troubleshooting |
| **[docs/RUNNING-ANDROID.md](docs/RUNNING-ANDROID.md)** | Building, signing, installing and debugging the Android app |
| **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** | How the three passes work and why each decision was made |
| **[docs/CONTRACT.md](docs/CONTRACT.md)** | The two JSON shapes everything meets at |
| **[bench/RESULTS.md](bench/RESULTS.md)** | Measured extractor fidelity behind the JS port |

**Continuous integration** (`.github/workflows/`): `test.yml` runs the 86 unit
tests and the full Playwright drive against the production build on every push;
`pages.yml` deploys the live demo to GitHub Pages; `android.yml` builds a debug
APK and attaches it to the run. Release signing stays local by design — the
keystore never enters CI.

---

## Quickstart

**With Docker** — nothing to install but Docker:

```bash
docker compose up web     # production build  -> http://localhost:8090
docker compose up dev     # vite + hot reload -> http://localhost:5180
```

**On the host** — Node 22+, no Python, no API key:

```bash
npm install
npm run build:graph -- --name aeon    # regenerate layout artifacts
npm run dev                           # http://localhost:5180
```

**Your own codebase** — either use the sidebar's **Open a repo…** (no CLI at
all), or:

```bash
node extract/node.mjs ../some-repo --out data/somerepo/graph.json
npm run build:graph -- --name somerepo
npm run dev
```

**Android** — a signed APK with no Android toolchain on your machine:

```bash
./android/docker-build.sh
# -> android/app/build/outputs/apk/release/app-release.apk
```

Full detail, flags and failure modes: [RUNNING-WEB.md](docs/RUNNING-WEB.md) and
[RUNNING-ANDROID.md](docs/RUNNING-ANDROID.md).

---

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
docs/       the guides above, plus CONTRACT.md
```

Two independent Docker setups, on purpose: `docker/` builds and serves the web
app; `android/docker/` is a toolchain image that produces an APK. They share
nothing.

Desktop and Android are deliberately separated: `web/` never references
`android/`, and the only thing crossing the boundary is `web/dist`, copied in
by `npx cap sync android` (config at the repo root, `capacitor.config.json`).

---

## How it fits together

```
extract (Node CLI | browser Worker | graphify CLI)
      |
      v  data/<name>/graph.json
pipeline/adapters/    -> canonical graph      (swap this to swap extractor)
      |
      v  data/<name>/graph.canonical.json
pipeline/layout.js    Louvain -> seeded ForceAtlas2 -> world box
      |
      v  web/public/data/<name>.layout.json  +  <name>.edges.json
web/                  PixiJS WebGL Atlas
```

Extraction is deterministic and slow-ish, layout is a batch physics job, and
rendering must hold 60fps. **Collapsing any two would force the expensive one
to run at the frequency of the cheap one**, so the browser receives coordinates
and never runs physics. It also means no backend: the app loads static JSON.

Adding an extractor means writing one `adapt()` function and registering it —
that seam is the whole design. [ARCHITECTURE.md](docs/ARCHITECTURE.md) explains
the reasoning in full.

---

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

---

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

**Insights** — the one page that talks first. Everything else answers a
question you have to know to ask; this computes what the graph already noticed:
most-depended-on entities, unused callables, dependency cycles, and cross-
subsystem coupling.

The unused list is the one that needed care. Raw "no inbound reference" was
**156 of Aeon's 335 callables** — a number nobody would trust, because a
FastAPI route is called by the framework, not by code the parser can see. Entry
points are detected from the graph itself (a `@router.get` decorator shows up
as a reference to a file-scoped verb) and held back separately: **96 likely
unused, 60 excluded as entry points or runtime hooks**.

**Knowledge** — query documents instead of code (see below).

**History** — saved corpora, restored without re-parsing (see below).

---

## Command palette (⌘K / Ctrl+K)

By the time the app had five pages, a file tree, a code viewer and two search
boxes, there were four different places to type a name into and you had to
know which kind of thing you were after before you could start. **⌘K** is the
one box that doesn't care: entities, files and commands are searched together
and ranked side by side. Arrow keys move, Enter opens, Escape closes.

Sections are ordered by their *best* match rather than by a fixed precedence,
because no fixed order gets both cases right — typing `blast radius` should
offer the page, typing `llm.py` should offer the file. Commands carry the
words someone would actually type and get a modest bias: there are eight
commands and a thousand entities, every entity is *also* reachable from the
map, the tree and two search boxes, and the palette is the only route to a
command. The bias is smaller than the gap between match tiers, so a weak
command match can never jump ahead of a strong one on real content.

Opening it with an empty box is the case worth optimising, because *"reopen
what I was just looking at"* is the most common reason to press the key at
all — so it lists **recent files** first, each reopening at the line you left
it on. Recents are per corpus and are filtered against what the corpus
actually has: a path stored from a previous build of the same repo is dropped
rather than offered as a click that opens an empty pane. The file tree grows
a **Recent** section from the same store.

There's no ⌘ key on a phone, so the drawer carries a **Search everything**
button, and the palette sits higher on a narrow screen — a vertically centred
one would have its results hidden behind the on-screen keyboard.

---

## Interactive map export

**Interactive map** on the Insights page writes the Atlas as a single
self-contained HTML file — **0.31 MB** for Aeon's 1,038 nodes and 1,678 edges.
Open it from `file://` on a machine that has never heard of Grapheon and you
can still pan, zoom to the cursor, search, click a node to see its neighbours,
and click a subsystem in the legend to isolate it. No server, no network, no
dependencies: the drive treats any non-`file:` request from the exported page
as a failure.

This replaced a PNG export. A picture of a thousand dots is a picture of a
thousand dots — the entire value of the map is being able to move around it. The
renderer inside the export is a few hundred lines of plain 2D canvas rather than
the app's PixiJS one, which would have added ~470 KB to every file to redraw
circles whose positions are already computed.

---

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

---

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
to trust is the more useful half. Optional on-device embeddings are the
natural next step.

---

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

---

## File explorer and code viewer

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
double-clicking a divider resets it. **Tabs** appear once a second file is
open, and closing one falls back to its left neighbour.

**Search** scans the contents of every readable file — the question the graph
can't answer, like *where does `AZURE_OPENAI_ENDPOINT` appear*. Results stream
in grouped by file with the match highlighted; clicking a hit opens that file
at that line. A cold search over Aeon's 142 files takes ~3s (each file is
fetched once), and every search after that is ~110ms.

Select any entity and hit **View code** — the map shrinks left, the source
opens right, scrolled to that entity's lines with its range highlighted.
Syntax highlighting via highlight.js. On a phone the code pane goes
full-screen with **word wrap on by default** — a 390px screen shows ~45
columns, and without it `llm.py` needs 706px of horizontal scrolling to read
one line.

A corpus without captured sources simply has no code viewer. To add it to one
built by the graphify CLI:

```bash
node pipeline/collect-sources.js --name aeon --repo ../Project-Aeon
npm run build:graph -- --name aeon
```

---

## Current state

Extracted from Project-Aeon: **1038 nodes, 1678 edges, 48 communities**. The top
communities Louvain finds are `api.js`, `graph.py` (the LangGraph agent),
`blast_radius_service.py`, `llm.py` — i.e. it recovers Aeon's actual
architecture without being told anything about it.

Blast Radius on `aeon/frontend/src/lib/api.js` returns the real dependency
chain: all 10 pages that import it, then `App.jsx` at 2 hops, `main.jsx` at 3.

Production build verified serving statically — no backend, and the same build
runs in-browser extraction (WASM grammars ship as assets). Verified against the
container too: the full Playwright drive passes through nginx.

**86 unit tests** (77 over the web libraries, 9 over the extractor), plus a
Playwright drive that checks desktop and mobile
viewports, in-browser extraction, the code viewer, file explorer, cross-file
search, knowledge base, PDF ingestion, history, corpus diff, the command
palette and the standalone HTML export — failing the run on any console error.

**Live demo and CI.** Three workflows run on every push: unit tests plus the
full drive against the production build, a GitHub Pages deploy, and a debug APK
artifact. One thing to know about anything built from a clean checkout —
including the demo: `data/*/sources.json` is gitignored, so the bundled corpora
ship as graphs with **no source text**. The map, Blast Radius, Insights and the
HTML export all work; the code viewer, file explorer and cross-file search are
available only for a repo you open yourself.

**Android: signed release APK, verified.** `./android/docker-build.sh` produces
a 5.4 MB `app-release.apk`; `apksigner verify` reports one signer,
`CN=Grapheon`, RSA 2048, APK Signature Scheme v2, and the bundled assets are
confirmed to be the current web build. Cold build 12m31s, warm 4m30s.

> **If you fork or clone this:** release signing needs
> `android/keystore.properties` and `android/keystore/`, both gitignored. Without
> them the build **succeeds and produces an unsigned APK** rather than failing —
> so always confirm with `apksigner verify`. If you have the keystore, back both
> files up off the machine; losing them means never being able to update the app.

Not built yet: multi-corpus UI, the agent layer, Neo4j push, and the Kagami
adapter.

---

## Known rough edges

- **`DEFAULT_CORPUS` is hardcoded** to `'aeon'` in `App.jsx` — other corpora
  load at runtime through the pickers or History, but there is no multi-corpus
  UI yet.
- **The `contains` anomaly is uninvestigated** — 43 edges separate a file from
  functions it contains, meaning Louvain sometimes splits them. Containment
  should be near-unbreakable, so this is a correctness smell.
- Community labels are the most-connected member, which is a good subsystem
  name about 80% of the time and an arbitrary one otherwise.
- The inferred-path caveat is built but unexercised: Aeon has only 14 INFERRED
  edges and none appear in the `api.js` example.
- No guard for a blast radius that returns most of a dense graph.
- The adapter and layout pass have no unit tests — they're verified by eye and
  by the Playwright drive.
- `pipeline/layout.js` is a *copy* of Kagami's, not a shared import, and has
  diverged. Improvements don't flow back.
- **Real-device Android performance is still unmeasured.** The APK is built,
  signed and content-verified, but has not been profiled on a phone.
- v3 APK signing is not enabled, so the APK is v2-only. v3 is what supports
  key rotation.
- `graphify update` warned that 12 JSON files (n8n workflow definitions)
  produced zero nodes and are absent from the graph.
