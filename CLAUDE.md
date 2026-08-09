# Grapheon — Claude Code Context

Graph-native code intelligence. **Graphify extracts, the Atlas renders.** Point it at a
codebase, get a navigable WebGL map plus real transitive impact analysis. Named for its
two parents: **graph** + **aeon**.

It is NOT a fork or merge of Project-Aeon. It is a third thing that borrows from both:
extraction from [Graphify](https://github.com/Graphify-Labs/graphify), the renderer and
layout pass from Project-Kagami's Atlas, the feature vocabulary from Project-Aeon.
**The property worth protecting is that it runs on any repo with no infrastructure** —
no backend, no database, no API key. Do not trade that away casually.

## Stack & layout

- **extract/** — the JS/WASM extraction port (web-tree-sitter). ESM, pure core,
  runs identically in Node and a browser Worker.
- **pipeline/** — ESM. graphology + Louvain + ForceAtlas2. No browser-only code,
  but the browser bundles it (that is WHY it is ESM).
- **web/** — Vite + React 18 + PixiJS 8 + pixi-viewport. Static; no server calls.
- **android/** — Capacitor 8 shell around `web/dist`; deliberately at the ROOT,
  fully separated from web/. Release builds happen in Docker (`android/docker/`).
- **docker/** — Dockerfile (multi-stage: deps → source → dev | build → prod)
  and nginx.conf for the WEB app. Entirely separate from `android/docker/`,
  which is a toolchain image for the APK; they share nothing.
- **bench/** — the measured evidence (RESULTS.md) behind the JS port.
- npm workspaces (extract, pipeline, web). Node 22. Capacitor config at repo
  root (`capacitor.config.json`, webDir `web/dist`); @capacitor/* are root
  devDependencies. **No Python needed anywhere**; the graphify CLI is optional.

## Running it

```bash
# Docker (no host toolchain needed)
docker compose up web                      # nginx + static build -> :8090
docker compose up dev                      # vite hot reload      -> :5180

# Host
npm install
node extract/node.mjs <repo> --out data/<name>/graph.json   # JS extractor (+sources)
node pipeline/collect-sources.js --name <n> --repo <path>   # sources for a graphify corpus
npm run build:graph -- --name <name>       # adapt + Louvain + FA2 + sources
npm run dev                                # http://localhost:5180

npm test                                   # blast.js + corpus.js unit tests
npm run drive --workspace web              # Playwright: desktop + mobile pass
npm run sync:android                       # web build + capacitor sync
```

The graphify CLI route (`graphify update <repo> --no-cluster`, copy
graphify-out/graph.json into data/<name>/) still works and is the fidelity
reference the JS extractor is scored against.

## The three passes

```
extract (Node CLI | browser Worker | graphify CLI)
      -> graph.json -> graph.canonical.json -> <name>.layout.json -> browser
        (raw)         (adapters/)            (layout.js)         (AtlasRenderer)
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
sidebar shell, **in-browser extraction** (folder pick on desktop, zip on mobile,
Worker-based), **responsive phone UI** (top bar, bottom sheets, legend toggle —
asserted by the drive's mobile pass at 390x844/touch), and a **debug APK** built
and content-verified. Production build verified serving statically. 15 unit
tests; the drive checks desktop + mobile + in-browser extraction on every run.

## JS extraction (extract/ + bench/)

Extraction is fully ported to JS — see `bench/RESULTS.md` for both halves.
Entities: **100% recall** at 8.3 ms/file in Chromium. Edges
(`extract/src/extract.js`): **97.7% link recall** vs graphify's ground truth,
with per-relation conventions decoded the hard way (documented in the file
header — read it before touching resolution logic). `indirect_call` is
deliberately not ported. The extractor emits graphify's exact raw shape, so
the existing adapter and pipeline consume it unchanged:

```bash
node extract/node.mjs <repo> --out data/<name>/graph.json
node pipeline/build.js --name <name>
```

Self-hosting works (Grapheon maps itself, zero Python). Still unproven:
real-device Android performance, and fidelity on a second corpus — the scoring
is against graphify-on-Aeon and may inherit its quirks.

**The same pipeline runs IN THE BROWSER** (`web/src/worker/extract-worker.js`):
folder pick (sidebar) or `window.__loadRepoFiles(files, name)` → module Worker
(WASM parse → adapt → FA2) → corpus swap. `pipeline/` is ESM for this reason.
Gotchas that cost time here:
- Vite workers need `worker: { format: 'es' }` or the production build dies
  with "IIFE not supported for code-splitting builds" — dev works, build fails.
- A worker that fails to LOAD posts nothing: without `worker.onerror` the UI
  hangs on "starting" with zero diagnostics anywhere.
- Workspace deps must be declared where they're IMPORTED FROM: web's worker
  imports web-tree-sitter, so web/package.json declares it. A package installed
  standalone before joining the workspace never got hoisted (500 from Vite,
  "Failed to resolve import").
- WASM binaries reach the bundle via `?url` imports; `server.fs.allow: ['..']`
  lets dev serve `extract/` and `pipeline/` source directly.

**Android** (`android/` at the ROOT — deliberately separated from `web/`;
Capacitor 8, config at repo root, webDir `web/dist`). The release build runs
in Docker: `./android/docker-build.sh` (toolchain image: Node 22 + Temurin 21
+ SDK 36; repo volume-mounted so the keystore never enters an image layer).
Signing reads `android/keystore.properties` -> `android/keystore/` (both
gitignored — losing them loses the app identity; absent, release builds come
out unsigned instead of failing). Host debug path still works:
`npm run sync:android && cd android && gradlew assembleDebug`
(JAVA_HOME -> JDK 21 at `C:/Program Files/Java/jdk-21`, ANDROID_HOME ->
`%LOCALAPPDATA%/Android/Sdk`). Gotchas:
- **Mobile has NO `webkitdirectory`** — the folder picker silently degrades to
  a file picker on Android. The zip path (`filesFromZip`, fflate) is the only
  working mobile ingestion; the sidebar hides the folder button on touch.
- **`cap sync` copies the BUILT dist into `android/app/src/main/assets/public`**
  — megabytes of minified one-line JS *inside the repo tree*. Any corpus walk
  that doesn't skip `android/` feeds bundles back into the parser and stalls
  for tens of seconds (bit `_drive.mjs`, then would have bit `extract/node.mjs`).
  `corpus.js` also has a `looksMinified` guard (>400 chars/line average).
- The synced assets are gitignored; the android/ project itself is committed.
- **Capacitor plugins must be declared in the ROOT package.json**, not in
  `web/`. The CLI reads the root manifest to register native plugins, and a
  plugin installed in a workspace syncs with no warning and no
  "Found N Capacitor plugins" line — the JS import resolves via hoisting, so
  it looks fine on the web and silently does nothing on the device. Third
  workspace-hoisting trap in this repo; check that line after any plugin add.
- **A running Vite dev server holds watcher handles on the whole `web/` tree**
  — moving `web/android` out failed with "Device or resource busy" until every
  vite process (including one orphaned from a killed npm wrapper a day earlier)
  was found BY LISTENING PORT and killed. Don't kill node.exe blindly: Claude
  Code itself runs on node.
- **Docker Desktop's engine can be up-but-wedged** — processes running since
  days ago, WSL distro "Running", yet every `docker` CLI call hangs forever.
  Fix: kill Docker Desktop + com.docker.backend, `wsl -t docker-desktop`,
  relaunch. Do NOT `wsl --shutdown` (kills the user's Ubuntu distro too).

**Web app in Docker** (`docker/`, `docker-compose.yml`) — **verified**:
`docker compose up web` → :8090, and the full Playwright drive passes against
the container (in-browser WASM extraction and mobile pass included).
- **NEVER add a `types { ... }` block to nginx.conf's server context.** It
  REPLACES the whole inherited map, so declaring `application/wasm wasm` alone
  downgrades every other file — JS bundles included — to octet-stream, and a
  module script with that type is refused. I shipped exactly this bug; the
  tell was `content_type: application/octet-stream` on a `.js` asset.
  `nginx:1.27-alpine`'s stock mime.types **already** has both wasm and js.
- **Port 8080 is a trap on this machine.** `wslrelay` owns loopback:8080 for a
  distro-side service and WSL's localhost forwarding beats Docker's binding:
  requests reach the wrong server, you get a bare 404, and nginx's access log
  stays EMPTY (that silence is the diagnostic). Compose publishes 8090.
- **Vite in a container needs `--host 0.0.0.0`** or it binds loopback inside
  the container and the published port answers nothing.
- **git-bash mangles container paths**: `docker exec ... ls /etc/nginx` becomes
  `C:/Program Files/Git/etc/nginx`. Prefix with `MSYS_NO_PATHCONV=1`.
- The image **regenerates layout artifacts** from the committed canonical
  graphs (`data/*/graph.canonical.json`) rather than copying the host's —
  `web/public/data` is in `.dockerignore` for that reason. Fresh clone → works.
- `.dockerignore` excludes `android/` (separate build, megabytes of synced
  minified bundles) and anything matching `keystore*`.

## IN FLIGHT: signed Android release (resume here)

Where this stands as of 2026-08-02:

- **Done & verified**: android/ separated to root (git renames), capacitor
  config at root, `npx cap sync android` works from root, web app fully green
  after the move (drive: desktop + mobile + in-browser extraction).
- **Done, NOT yet verified**: release signing. The keystore was GENERATED
  (`android/keystore/grapheon-release.keystore`, alias `grapheon`, random
  password in `android/keystore.properties`; both gitignored — **tell the user
  to back these two files up**, they are the app identity). `app/build.gradle`
  signs release builds when keystore.properties exists, silently skips
  signing when absent.
- **Broken**: the Docker toolchain image build
  (`docker build -t grapheon-android-build android/docker`) failed at the
  sdkmanager RUN step, exit 1, error invisible because the step piped to
  /dev/null — that suppression is now removed, so re-running will show the
  real error. Suspects: sdkmanager/JDK interaction, or a licenses prompt.
- **Next actions**: (1) re-run the image build and read the actual error,
  (2) `./android/docker-build.sh` for the signed APK,
  (3) verify the signature (`apksigner verify --print-certs` from
  build-tools, or `jarsigner -verify`),
  (4) the debug-APK-on-real-phone perf test is still owed.

## Code viewer

`web/src/CodePane.jsx` + `lib/sources.js`. A split MODE (sibling of `.stage`),
not a route — the map must stay visible beside it and it works on every page.
highlight.js, python + javascript only.
- **Highlight the whole file, THEN split into lines.** Per-line highlighting
  restarts the lexer mid-docstring and mis-colours everything below. Splitting
  after means hljs's spans get cut at line boundaries, so `CodePane` re-opens
  them per line — that's what `trackOpenSpans` is for, not premature cleverness.
- **Pixi's `resizeTo` only watches the WINDOW.** Opening the pane shrinks the
  map's container without a window resize, so the canvas kept its old width
  and the map was silently cropped (measured: container 750px, canvas 1392px).
  `AtlasRenderer` now holds a `ResizeObserver` on its container.
- Sources are served **per file** from a mirrored tree, never as one blob —
  see `docs/CONTRACT.md` §4 for why (Aeon's corpus is 18 MB of text).
- **Mobile**: full-screen overlay, wrap ON by default (without it llm.py needs
  706px of horizontal scroll in a 390px viewport). The drive asserts
  `overflowX === 0` on the phone pass.
- **Android back button** (`lib/backButton.js`, `@capacitor/app`) dismisses the
  code pane, then the selection, before exiting. Registered as a stack so
  future overlays can join it. Dynamic-imported, so the web build is unaffected.

## File explorer

`web/src/FileTree.jsx` + `lib/filetree.js`. The repo as a directory, beside the
repo as a graph. Opens ANY readable file, not just graph nodes — that gap was
the whole reason it exists: a dropped folder's README/compose/CI files have no
nodes and were unreachable.
- `corpus.js` now returns `{files, readable}`: `files` is what the extractor
  parses (.py/.js/.jsx, mirroring extract/node.mjs exactly), `readable` is
  every text file. Keep them in step or the browser and CLI graphs diverge.
- `openPath` is separate state from `selected` on purpose. Most readable files
  have no node, so routing them through the selection would mean inventing
  graph entities that do not exist.
- **Capture docs by FILENAME, not extension.** An extension whitelist
  (.json/.txt/.yml) looked reasonable and pulled 17.6 MB of fixtures and data
  dumps out of Aeon's setup trees — enough to quadruple the APK. Name patterns
  plus a 2 MB budget give 142 files / 0.96 MB. Graph files are never budgeted out.
- **Skip `.claude/`** (and `.idea`, `.vscode`, `.tox`): `.claude/worktrees`
  holds whole COPIES of the repo, so the tree showed four identical README.md
  rows and the top hit was a one-line worktree stub.
- **Tabs** live in App (`tabs` = open set, `openPath` = which is showing); each
  tab remembers the line it was opened at so returning to a search hit lands
  where you left it. The bar hides at one tab by design — the drive asserting
  `tabs: []` after a close is that, not a bug.
- **Resizable dividers** (`components/Divider.jsx`, `lib/usePanelWidths.js`):
  pointer events + `setPointerCapture` so a drag survives outrunning the 5px
  handle, widths persisted in localStorage and clamped ON READ (a stored
  1200px pane from a wide session would otherwise swallow a laptop screen).
  Two traps:
  - **Inline width BEATS the media query.** Passing a width on a phone pinned
    the full-screen code pane to the desktop's last drag (560px on a 390px
    screen). `usePanelWidths` reports null below 720px so no inline style is
    set; the drive's mobile pass asserts the 390px width.
  - The canvas resize is **rAF-coalesced** — `_applyLOD` walks every sprite
    (1038 on Aeon) and running it per ResizeObserver callback made the drag
    stutter.
- **Cross-file search fetches in BATCHES of 12** (`lib/search.js`). Awaiting
  each file sequentially made a cold search take **25 SECONDS** over 142 files
  — one round trip each, plus a per-file `setTimeout(0)` browsers clamp to
  ~4ms. Batched: ~3s cold, ~110ms warm. If search ever feels slow again,
  check the concurrency before anything else.

## Ground truth (bench/ground-truth/)

`bench/ground-truth/aeon.graphify.canonical.json` is the COMMITTED graphify
output that `extract/score.mjs` scores against. It lives there, not in
`data/aeon/`, because **data/ is a working directory**: re-extracting a corpus
overwrites it, and this file was once clobbered exactly that way — after which
score.mjs cheerfully reported **100% recall while comparing our output to
itself**. A benchmark you can silently overwrite is not a benchmark. If a
recall number ever looks suspiciously perfect, check what TRUTH points at.

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
