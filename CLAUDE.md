# Grapheon — Claude Code Context

Graph-native code intelligence. **Graphify extracts, the Atlas renders.** Point it at a
codebase, get a navigable WebGL map plus real transitive impact analysis. Named for its
two parents: **graph** + **aeon**.

It is NOT a fork or merge of Project-Aeon. It is a third thing that borrows from both:
extraction from [Graphify](https://github.com/Graphify-Labs/graphify), the renderer and
layout pass from Project-Kagami's Atlas, the feature vocabulary from Project-Aeon.
**The property worth protecting is that it runs on any repo with no infrastructure** —
no backend, no database, no API key. Do not trade that away casually.

## Docs

Human-facing documentation lives in `docs/` — keep it in step when behaviour
changes, and prefer sending users there over re-explaining in chat:

- `docs/RUNNING-WEB.md` — every route to running the web app, all flags, troubleshooting
- `docs/RUNNING-ANDROID.md` — build/sign/install/debug the APK, and the traps
- `docs/ARCHITECTURE.md` — the three passes and the reasoning behind each decision
- `docs/CONTRACT.md` — the two intermediate JSON shapes
- `README.md` — overview, quickstart, feature tour, current state

This file (CLAUDE.md) stays the agent-facing one: gotchas, invariants and the
things that cost debugging time. It deliberately overlaps with docs/ — the
audience differs.

## CI (.github/workflows/)

Pushed to `origin` (GitHub). Three workflows, all on push to `main`:

- `test.yml` — 86 unit tests, then the full drive against the PRODUCTION build
  via `vite preview`. The drive fails the run on any console error, so it is
  the real regression net.
- `pages.yml` — deploys the demo. Sets `GRAPHEON_BASE` from
  `actions/configure-pages`, because a project site is served from a subpath.
- `android.yml` — debug APK as a run artifact. Debug, not release: an unsigned
  release APK installs nowhere. Signing stays local; the workflow ends with a
  commented recipe for enabling it.

Two invariants for anything running on a Linux runner:
- **`sh gradlew`, never `./gradlew`** — the wrapper is committed 100644.
- **`vite preview --host 127.0.0.1`** — it otherwise binds the *name*
  `localhost`, which can resolve IPv6-only, and the drive gets ECONNREFUSED
  against a server that is plainly running.

**A local build proves nothing about CI.** Both use the working tree; CI uses
what git ships. To reproduce a CI-only failure:
`git archive $(git write-tree) | tar -x -C <dir>` and build *that*. A clean
checkout also has NO `data/*/sources.json` (gitignored), so CI artifacts and
the Pages demo carry the corpus graphs but no source text — no code viewer,
file explorer or file search for the bundled corpora. Not a bug; surprising
from the outside.

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

npm test                                   # 86 unit tests (77 web + 9 extract)
npm run drive --workspace web              # Playwright: desktop + mobile pass
npm run sync:android                       # web build + capacitor sync
./android/docker-build.sh                  # signed release APK, all in Docker
```

The graphify CLI route (`graphify update <repo> --no-cluster`, copy
graphify-out/graph.json into data/<name>/) still works and is the fidelity
reference the JS extractor is scored against.

Full guides with flags, failure modes and troubleshooting live in
`docs/RUNNING-WEB.md` and `docs/RUNNING-ANDROID.md`.

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
asserted by the drive's mobile pass at 390x844/touch), a **command palette** (⌘K over
entities, files and commands, with per-corpus recent files), and a **signed
release APK** built in Docker and verified (apksigner: CN=Grapheon, RSA 2048,
v2 scheme; bundled assets confirmed to be the current build). Production build
verified serving statically. **86 unit tests** (77 web + 9 extract); the drive
checks desktop + mobile + in-browser extraction, the standalone HTML export and
the palette on every run.

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
- **The phone header is a DRAWER, not a row** (`Sidebar.jsx`, `narrow` from
  `usePanelWidths`). Laid out flat it needed 504px inside 390px: nav, Files,
  Search and two upload buttons overlapped, and "Open a repo .zip…" was pushed
  fully off-screen — the phone build could not load a repo at all, and nothing
  reported an error because the element existed. The drive now asserts the bar
  does not overflow AND that the zip button is **on screen**, not merely in the
  DOM; "present in the DOM" is exactly what hid this.
- **`cap sync` copies the BUILT dist into `android/app/src/main/assets/public`**
  — megabytes of minified one-line JS *inside the repo tree*. Any corpus walk
  that doesn't skip `android/` feeds bundles back into the parser and stalls
  for tens of seconds (bit `_drive.mjs`, then would have bit `extract/node.mjs`).
  `corpus.js` also has a `looksMinified` guard (>400 chars/line average).
- The synced assets are gitignored; the android/ project itself is committed.
- **NEVER put a blanket `*.png` in .gitignore.** The rule for the drive's
  verification screenshots swallowed all **26 Android resource PNGs** — every
  launcher icon and every splash density. Locally the files were on disk, so
  every build passed for weeks; it failed only in CI, on a fresh checkout:
  `error: resource drawable/splash (aka app.grapheon:drawable/splash) not
  found`. Screenshot rules are now scoped by location (`/*.png`, `/web/*.png`).
  When a build is green locally and red in CI, diff the working tree against
  what git actually ships — `git write-tree` + `git archive` gives you exactly
  what CI checks out, and building THAT is the only real proof.
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
- **`.mjs` is NOT in nginx's stock mime.types** — only `js` is. pdf.js ships
  its worker as a `.mjs` chunk, so it fell through to
  `default_type application/octet-stream` and the browser refused the module
  script: **PDF import broken on the served build, fine under vite.** Fixed
  with a location-scoped `default_type`, which adds one type without touching
  the inherited map (see the next point for why that matters). Found only
  because a static-server experiment reproduced it — the drive against the
  container had never exercised a `.mjs` chunk.
- **Deploy base is `GRAPHEON_BASE`** (vite `base`, default `/`). Every runtime
  URL goes through `assetUrl()` in `web/src/lib/asset.js` and the sources
  manifest stores a RELATIVE base, because GitHub Pages serves a project site
  from a subpath where absolute `/data/...` hits the domain root and 404s —
  symptom is "Loading atlas…" forever. Verified by serving a subpath build from
  an actual subpath and running the full drive against it.
- **git-bash rewrites env values that look like paths.**
  `GRAPHEON_BASE=/grapheon/` became `/Program Files/Git/grapheon/` in the built
  asset URLs. Same `MSYS_NO_PATHCONV=1` fix as the docker paths.
- **`vite preview` binds the NAME `localhost`**, which can resolve IPv6-only;
  the drive then gets ECONNREFUSED against a server that is plainly running.
  Pass `--host 127.0.0.1`. (Same family as the `--host 0.0.0.0` rule in Docker
  and the `localhost` vs `127.0.0.1` split that hid a working static server.)
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

## Signed Android release (DONE, verified 2026-08-15)

`./android/docker-build.sh` produces a **signed 5.4 MB app-release.apk**,
verified with `apksigner verify --print-certs`: one signer,
`CN=Grapheon, OU=Dev, O=Grapheon, C=IN`, RSA 2048, **APK Signature Scheme v2**.
Contents checked too — the bundled `assets/public` carries the current web
build (palette + HTML export strings present) and both corpora.

- **Back up `android/keystore/grapheon-release.keystore` and
  `android/keystore.properties`.** Both gitignored, so no commit protects
  them; losing them loses the app identity permanently. `app/build.gradle`
  signs when keystore.properties exists and silently ships UNSIGNED when it
  does not — absent signing material is not a build failure.
- **The image build was never actually broken.** The sdkmanager step
  (cmdline-tools 11076708, licences via `yes |`) completes fine; the earlier
  exit-1 was Docker's engine in the wedged state described above, which makes
  every CLI call hang or fail with no useful output. Check `docker info`
  responds *before* debugging a Dockerfile.
- **`npm ci` must never see the host's node_modules.** The repo is bind-mounted
  from Windows, so `/work/node_modules` held `@esbuild/win32-x64/esbuild.exe`;
  `npm ci` deletes node_modules first and died on `EIO: unlink` over the mount
  — after having already removed `node_modules/esbuild`, which broke
  `npm run build` ON THE HOST. Had the unlink succeeded it would have replaced
  the whole host install with Linux binaries. `docker-build.sh` now masks every
  workspace's node_modules with a **named volume**, which both fixes the
  failure and keeps the two platforms' installs apart. If the host toolchain
  ever breaks right after an APK build, run `npm install` at the root.
- **Named volumes, not anonymous ones**, so npm and Gradle caches survive
  between runs (`GRADLE_USER_HOME=/gradle-home`). First build ~12.5 min, mostly
  Gradle over the Windows bind mount. `docker volume rm grapheon-android-*`
  forces a clean install.
- **`bash -c`, never `bash -lc`, in the image CMD.** A login shell re-sources
  /etc/profile and REPLACES the PATH the image set, so `$JAVA_HOME/bin` and the
  SDK tools disappear. The build survived it (Gradle finds java through
  JAVA_HOME) which is precisely why it went unnoticed — `apksigner` run the
  same way failed with `exec: java: not found`.
- Still owed: the **debug-APK-on-real-phone perf test**. Also worth
  considering: `enableV3Signing` is off, so the APK is v2-only — v3 is what
  supports key rotation, which matters if the keystore ever has to change.

## TypeScript

`.ts/.mts/.cts` use the TypeScript grammar, `.tsx` uses the **TSX** grammar —
the plain TS grammar reads `<div>` as a type assertion, so every JSX element
becomes a parse error and a .tsx file yields almost nothing. Interfaces, their
members, type aliases, enums, `function_signature` and
`abstract_class_declaration` are all entities; `interface extends` is an
`inherits` edge.
- **Path aliases were the whole ballgame.** `@/lib/utils` and baseUrl imports
  (`components/ui/card`) are the norm in TS projects, and treating them as npm
  packages left a real 79-file repo with **5 of 138 imports resolved** — a map
  of disconnected dots that parsed perfectly. `resolveAlias` suffix-matches
  against the corpus; that took it to 107/158, with every remaining external a
  genuine package. If a TS graph ever looks sparse, check resolution before
  anything else.
- **Never suffix-match a bare single-segment specifier**: a local `utils.ts`
  would swallow the npm package `utils`. Requires an alias prefix or a `/`.
  Ambiguous matches resolve to nothing — a wrong edge is worse than none.
- **`./foo.js` may mean `foo.ts`** (TS NodeNext names the compiled output).
- **`import type` is a separate relation** (`imports_type`, weight 0.18): it
  vanishes from the emitted JS, so it is real for a reader and absent at
  runtime. Without the distinction a types-only barrel file lays out as the
  hub of the application. Per-specifier `{ type X }` counts too.
- `extract/extract.test.js` loads the REAL grammars rather than stubbing —
  the risk here is what the grammar actually names its nodes, and a stub would
  only encode my assumptions.

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

## Insights (lib/insights.js) + export (lib/export.js)

Computed from data already in memory; pure over (nodes, adjacency) so it tests
without a browser.
- **Structural edges are not usage.** `contains`/`method`/`rationale_for` say
  how code is FILED. Count them and every function looks referenced.
- **Entry points must be separated from dead code, or the feature is
  worthless.** Raw "no inbound reference" was 156 of Aeon's 335 callables —
  mostly FastAPI handlers the framework calls. Detected from the GRAPH (a
  `@router.get` decorator appears as an outbound reference to a file-scoped
  verb like `api_py_get`), not from naming conventions. Result: 96 likely, 60
  held back. If that split ever collapses, check `ENTRY_VERBS` first.
- **Tarjan is iterative on purpose** — the recursive form blows the stack on a
  real corpus, and a test pins it at 20k nodes.

## Interactive map export (lib/exportHtml.js)

`mapHtml()` returns one self-contained HTML file: slimmed node records, edges,
and a plain 2D-canvas renderer, all inline. Replaced a PNG export — a static
picture of a graph carries almost none of the graph's value.

- **U+2028 and U+2029 must be written as escape sequences, never as literals.**
  They are line terminators in JavaScript *source*, so a literal one inside a
  regex ends the regex and the file will not parse — the failure is
  `SyntaxError: Invalid regular expression: missing /`, which points nowhere
  near the real cause. This bit this file during development. Editors and tools
  that string-match will not find them either; patch such a line by rewriting it
  programmatically. `exportHtml.test.js` asserts no raw ones reach the output.
- **`<` is escaped in the embedded JSON** — a node labelled `</script>` would
  otherwise close the data block regardless of what JSON thinks, and everything
  after it becomes markup. Tested.
- **Pixi is deliberately NOT inlined**: ~470 KB per exported file to draw
  circles at positions already computed. Plain canvas keeps the export roughly
  the size of its own data (0.31 MB for 1,038 nodes).
- **Nodes get a minimum on-screen radius** (`1.6 / scale`). At overview zoom a
  radius-3 dot is sub-pixel and the whole map reads as dust.
- **Zoom translates toward the cursor** before scaling. Scaling around the
  origin instead makes the point you are aiming at run away from you.
- **The legend shows the top 24 subsystems but reports the true total** in the
  footer — Aeon has 48, and the tail is single-digit clusters that would turn
  the legend into a scrollbar.
- **The drive opens the export from `file://` and fails on any non-`file:`
  request.** "Self-contained" is a claim that has to be enforced, not asserted;
  one CDN font would break every offline use without breaking any test.

## History (lib/history.js)

Saved corpora in IndexedDB — `pages/HistoryPage.jsx`, restored via
`restoreCorpus` in App. Before this, building a corpus destroyed the previous
one outright.
- **IndexedDB, not localStorage**: megabytes, and structured clone stores the
  BM25 index's Maps as-is. JSON would be lossy and slow.
- **Two object stores.** `meta` is tiny and is what the page lists; `data`
  holds payloads. Listing must never deserialise every corpus to show names.
- **Entries are VERSIONED** (`kind:name:contentHash`). They used to key on the
  name alone, so re-extracting silently replaced the only copy you could have
  compared against — diff was impossible by construction. The hash is over
  sorted node ids + edge count, so an unchanged repo re-saves in place rather
  than creating a duplicate version.
- **Old versions of one corpus evict before other corpora do** — keeping ten
  builds of one repo while dropping a different project is not a history.
- **Bounded** to 8 entries / 120 MB (and 3 versions per name), oldest evicted. Unbounded, it eventually
  hits the browser quota and fails at WRITE time — after the user has waited
  through a build.
- **Saving must never fail a build.** The corpus is loaded and usable whether
  or not it persisted, so a full quota or private mode logs a warning and is
  otherwise ignored.
- **Restoring clears selection, tabs and openPath first** — they hold ids from
  the outgoing corpus and would point at nodes the new layout does not have.
- Recent queries are per-corpus in localStorage, written on a 1.2s pause, not
  per keystroke (otherwise the list fills with prefixes of one question).

## Code ↔ docs join (lib/join.js)

Links doc passages to the code entities they name. `linked` in App holds a
SECOND corpus purely to cross-reference — it is never rendered, so the map
stays one corpus. Surfaced in DetailPanel ("Documented in") and on Knowledge
results.

Precision is everything; a noisy join is worse than none. The rules:
- generic identifiers (`get`, `data`, `config`…) are refused outright;
- undistinctive names only match inside **backticks** — but they stay
  candidates until the text is examined, because filtering them at build time
  meant `` `complete()` `` could never match no matter how it was written;
- **path forms come only from the FILE's own node.** Every function in llm.py
  carries that path, so emitting it for all of them made the path ambiguous
  against its own file and killed the strongest signal available;
- a form shared by two entities is dropped, not guessed;
- a term in >20% of passages is vocabulary, not a reference.

**The CLI and browser skip lists must stay in step.** They drifted once:
`extract/node.mjs` still walked `.claude/worktrees`, which holds whole COPIES
of a repo, so every class existed twice and the join refused to link
`ChromaStore` as ambiguous. The rule was right; the corpus was wrong.

Also: when a join finds nothing, check the docs actually use that name before
suspecting the matcher. Aeon's docs say "ChromaDB" 56 times and "ChromaStore"
zero, so a zero there is correct.

## Corpus diff (lib/diff.js)

Two builds of one corpus -> what changed. The headline is **drift**: a new
dependency crossing a subsystem boundary, which a `git diff` cannot show
because it is one import line among hundreds.
- **Structural edges are excluded** (`contains`/`method`): a file gaining a
  function is not a new dependency, and counting it buries the real ones.
- **Edges from NEW entities are not drift.** A new file must connect to
  something; drift is old code reaching somewhere new. Without this filter
  every added file reads as an architecture violation.
- **Community ids are recomputed per build and mean nothing across two** —
  compare through the labels, never the numeric `c`.

## Knowledge base (lib/knowledge/)

Second corpus type: documents, retrieved rather than traversed. `parse.js`
(doc → section → passage), `bm25.js` (index + search), `graph.js` (canonical
graph), `worker/knowledge-worker.js`, `pages/KnowledgePage.jsx`.
- **It emits the SAME canonical shape as the code adapter**, so Louvain, FA2,
  the Atlas, the file tree and the code pane all work unchanged. Keep that
  true — it is the reason this was a day's work and not a rewrite.
- **Node ids must be unique and are derived from text**, which repeats. Two
  fixes, both load-bearing: repeated headings inside a document get `-2`
  suffixes, and duplicate file basenames get `(2)` in the worker. A multi-file
  picker gives every file its bare name, so three `README.md`s collide and
  graphology refuses to build the graph at all.
- **Passages must carry their OWN start line.** They originally inherited the
  section's, so every result from one section looked identical and opened at
  the heading instead of the text. `parse.js` keeps line numbers per line for
  exactly this; a test pins it.
- **Filter passages with no prose** (<15 alphanumerics). A markdown `---` rule
  is a real block and BM25 will rank it, producing a result whose entire
  content is "---". Cost 70 of 439 passages on Aeon's docs, all noise.
- BM25 not TF-IDF: term saturation and length normalisation are what make
  uneven prose rank sensibly. The index has a `vector` field per passage,
  unused — that is where MiniLM embeddings go without a rewrite.
- `related` edges are **INFERRED** (word overlap is a guess); `contains` and
  `subsection` are EXTRACTED (the document says so).

**PDF** (`lib/knowledge/pdf.js`) converts to markdown-ish text — headings by
font size vs the document's median — so `parseDocument` handles a PDF exactly
like a `.md`. Three traps, each cost a round:
- **Use the LEGACY pdf.js build** (`pdfjs-dist/legacy/build/...`). The default
  one calls `Uint8Array.prototype.toHex()` when fingerprinting a document — an
  ES2025 method — and dies with "hashOriginal.toHex is not a function" on any
  browser that lacks it. Legacy ships the polyfill; it costs 56 KB.
  **This passed every test and still broke for the user**: Playwright's bundled
  Chromium is newer than most real browsers and than many Android WebViews, so
  the feature was present in CI and absent in reality. The drive now DELETES
  `Uint8Array.prototype.toHex` before parsing the PDF fixture, which is the
  only reason that check can catch this class of bug. Assume the test browser
  is more modern than your users' and prefer legacy/transpiled builds.
- **pdf.js must run on the MAIN THREAD.** It spawns a worker of its own, and
  nesting that inside the knowledge worker made `getDocument()` hang forever
  with no error — the promise simply never settled. App converts PDFs, then
  hands text to the worker.
- **`parseDocument` needs `markdownish: true` passed explicitly.** It decides
  on the file extension otherwise, so a `.pdf` path ignored every `#` heading
  pdf.js had just detected and the whole document collapsed into one untitled
  passage.
- In pdf.js 6 the document proxy has **no `destroy()`** — keep the loading
  task and destroy that, or the worker and the file's buffers leak.
- Scanned PDFs have no text layer and are reported, not silently dropped.
  Verified against a real one: `AEON_poster.pdf` yields 0 text items.
- The drive's fixture is a **hand-built PDF** (`web/_fixture-pdf.mjs`) with two
  font sizes, so the heading heuristic is actually exercised. Real PDFs on this
  machine are an image-only poster and a personal CV; neither belongs in a repo.

## Command palette (lib/palette.js + components/Palette.jsx)

⌘/Ctrl+K over entities, files and commands at once. Ranking is pure and tested
(`palette.test.js`); the component is keyboard handling and markup.
- **Sections sort by their best item, not by a fixed precedence.** `blast
  radius` wants the page, `llm.py` wants the file, and no fixed order gets both.
- **Commands need a `keywords` field.** Nobody types "go to blast radius" — they
  type "blast radius", which is a mid-string hit inside the label and two tiers
  down. `keywords` is what the command is ABOUT.
- **`COMMAND_BIAS` is 120 and must stay under 200**, the smallest gap between
  match tiers. It exists because Aeon's corpus contains its own docs, so
  "Blast Radius" is an exact entity match six times over and buried the command
  to open the page. Under the tier gap, it can reorder equals but never lift a
  weak command match over a strong content one — a test pins both halves.
- **The empty palette is uncapped.** `LIMITS.commands` stops a broad *query*
  flooding the list; applying it to the empty state silently hid the last two
  commands, which are otherwise undiscoverable.
- **Recents are per corpus AND filtered through `sources.has`.** A path stored
  from a previous build of the same repo still resolves by name, so an unfiltered
  list offers a click that opens an empty pane with no error.
- **`.pal-label` needs `min-width: 0` *and* `max-width`.** A flex item will not
  shrink below its content width without min-width:0, and a node label can be a
  whole docstring line — with only min-width:0 it still squeezed the path to
  29px. Both, or the row is useless.
- The palette is z-index 40: above the phone drawer (20) and its scrim (19),
  because it is reachable from every layer. It also joins the Android back
  stack ahead of the drawer.

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

## Logo

`86.svg` at the repo root is the SOURCE ART — an interlocking 86 monogram,
one path, `fill="currentColor"`. Everything else is generated:

```bash
node scripts/make-logo.mjs      # then rebuild the APK for launcher icons
```

It writes `web/public/logo.svg` (natural 1.545:1, gradient baked in),
`web/public/icon.svg` (square, dark tile, favicon) and every
`android/.../mipmap-*` launcher PNG including the adaptive foreground.
- **The mark is 1.545:1 and every icon slot is 1:1**, so the square variants
  centre and inset it. Adaptive foregrounds get a much bigger margin (0.46 vs
  0.74) because launchers crop to a circle inside the 108dp square.
- Rasterising uses the **Playwright Chromium already installed**, not sharp or
  node-canvas — one fewer dependency, and the same engine that renders it.
- The gradient is `#7dd3fc → #60a5fa → #818cf8`, anchored on `--accent`.
  Change it in one place (`STOPS`) and regenerate.
- The favicon carries its own dark tile: the mark is light blue and a browser
  tab strip may be white.

## Ground truth (bench/ground-truth/)

`bench/ground-truth/aeon.graphify.canonical.json` is the COMMITTED graphify
output that `extract/score.mjs` scores against. It lives there, not in
`data/aeon/`, because **data/ is a working directory**: re-extracting a corpus
overwrites it, and this file was once clobbered exactly that way — after which
score.mjs cheerfully reported **100% recall while comparing our output to
itself**. A benchmark you can silently overwrite is not a benchmark. If a
recall number ever looks suspiciously perfect, check what TRUTH points at.

## Known gaps

- **`DEFAULT_CORPUS` is hardcoded to `'aeon'`** in `App.jsx`. Multi-corpus is the next feature;
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
