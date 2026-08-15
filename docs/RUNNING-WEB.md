# Running the web app

Everything you need to get Grapheon rendering a codebase, from three different
starting points, plus what each command actually does and what to do when it
misbehaves.

**The short version:** if you just want to look at it, `docker compose up web`
and open <http://localhost:8090>. If you want to edit it, `npm install &&
npm run dev`. Everything below is detail.

---

## Contents

- [What you are running](#what-you-are-running)
- [Prerequisites](#prerequisites)
- [Route 1 — Docker (nothing to install but Docker)](#route-1--docker-nothing-to-install-but-docker)
- [Route 2 — On the host](#route-2--on-the-host)
- [Route 3 — No install at all: extract in the browser](#route-3--no-install-at-all-extract-in-the-browser)
- [Loading your own codebase](#loading-your-own-codebase)
- [Every script, explained](#every-script-explained)
- [What lands on disk](#what-lands-on-disk)
- [Verifying it works](#verifying-it-works)
- [Deploying it](#deploying-it)
- [Troubleshooting](#troubleshooting)

---

## What you are running

A **static site**. No backend, no database, no API key, no telemetry. The
browser downloads pre-computed JSON and draws it with WebGL. When you point it
at your own repo, the parsing happens in a Web Worker **on your machine** —
there is no server to upload anything to.

That constraint is deliberate and load-bearing: it is why the same build runs
from `file://`, from nginx, from GitHub Pages, and inside an Android WebView
with no changes.

```
your repo ──▶ extract ──▶ canonical graph ──▶ layout ──▶ browser draws it
             (tree-sitter)   (JSON)        (Louvain+FA2)   (PixiJS)
```

Three passes, explained in [ARCHITECTURE.md](ARCHITECTURE.md). For running it,
all you need to know is that passes 1 and 2 produce JSON files, and the browser
consumes them.

---

## Prerequisites

Pick **one** column. You do not need both.

| | Docker route | Host route |
|---|---|---|
| Required | Docker Desktop (or Docker Engine + Compose v2) | Node.js **22+** and npm |
| Disk | ~1.5 GB for images | ~400 MB for `node_modules` |
| Python? | No | No |
| API key? | No | No |
| Android SDK? | No | No |

**Node 22 is a real requirement**, not a suggestion — the code uses `node --test`
and modern ESM resolution. Check with `node --version`.

There is **no Python anywhere** in Grapheon. The original Graphify CLI is
Python and still works as an alternative extractor, but nothing needs it.

---

## Route 1 — Docker (nothing to install but Docker)

Two services, defined in `docker-compose.yml`.

### Production shape

```bash
docker compose up web
```

→ <http://localhost:8090>

This is **the honest deployment shape**: a static build served by nginx. What
you see locally is byte-for-byte what a deploy serves. First run builds the
image (a few minutes); afterwards it starts in about a second.

Run it detached and stop it with:

```bash
docker compose up -d web      # background
docker compose logs -f web    # follow nginx's log
docker compose down           # stop and remove
```

### Development shape

```bash
docker compose up dev
```

→ <http://localhost:5180>, with hot reload.

Your `extract/`, `pipeline/`, `web/` and `data/` directories are mounted into
the container, so edits on the host reload in the browser. `node_modules` and
`dist` are **anonymous volumes**, deliberately masking the host's — a Windows
host's `node_modules` contains the wrong platform's binaries and would break
the Linux container instantly. (This is the same class of bug that broke the
Android build; see [RUNNING-ANDROID.md](RUNNING-ANDROID.md#the-node_modules-trap).)

### Why port 8090 and not 8080

On a machine running WSL, `wslrelay` can already own `loopback:8080` for a
distro-side service, and **WSL's localhost forwarding beats Docker's port
binding**. Requests then reach the wrong server: you get a bare 404 and
nginx's access log stays completely empty. That silence is the diagnostic, and
it costs an hour if you don't know to look for it. 8090 sidesteps it.

To use a different port, change the left-hand side only:

```yaml
ports:
  - "9000:80"     # host:container
```

### What the image does that a bare clone doesn't

Layout artifacts (`*.layout.json`, `*.edges.json`) are **not committed** —
they're regenerable in seconds and would be noisy diffs. The image therefore
runs `pipeline/build.js` for each corpus during the build, from the canonical
graphs that *are* committed. A fresh clone → `docker compose up web` → working
app, with no setup step.

`web/public/data` is in `.dockerignore` for exactly this reason: the image must
regenerate, never inherit, the host's artifacts.

---

## Route 2 — On the host

### First run

```bash
npm install                   # installs all three workspaces at once
npm run build:graph -- --name aeon
npm run dev                   # http://localhost:5180
```

`npm install` at the **root** is correct — this is an npm workspaces monorepo
(`extract`, `pipeline`, `web`). Do not `cd web && npm install`; that produces a
half-installed tree, and packages installed inside a workspace before it joined
the workspace never get hoisted, which shows up later as a Vite
`Failed to resolve import` 500.

`npm run build:graph -- --name aeon` regenerates the layout artifacts from the
committed canonical graph. Without it the app loads and immediately shows
`layout fetch failed: 404`.

> The `--` before `--name` is required. It tells npm to pass the flag to the
> script rather than consume it itself.

### Subsequent runs

```bash
npm run dev
```

The dev server is Vite on **port 5180** (set in `web/vite.config.js`, not the
default 5173). Two settings there matter:

- `worker: { format: 'es' }` — the extraction worker is a module worker with
  imports of its own, and Vite's default IIFE worker format cannot code-split
  that. Without it, `npm run dev` works and `npm run build` dies with *"IIFE is
  not supported for code-splitting builds"*.
- `server.fs.allow: ['..']` — the worker imports `extract/` and `pipeline/`
  source **directly**, one implementation with no copies. Vite has to be
  allowed to serve files from outside `web/`.

---

## Route 3 — No install at all: extract in the browser

You don't need the CLI to analyse a repo. Start the app by any route above,
then in the sidebar:

- **Open a repo…** — a folder picker (desktop browsers only)
- **Open a repo .zip…** — a zip file (works everywhere, including phones)
- **Open documents…** — `.md` / `.txt` / `.rst` / `.pdf`, builds a searchable
  knowledge base instead of a code graph

The entire pipeline — WASM tree-sitter parse → adapt → Louvain → ForceAtlas2 —
runs in a Web Worker on your machine, then swaps the map in place. The WASM
grammars ship as static assets, so **this works in the production build too**.
That is what makes Grapheon deployable as a plain static site that can still
ingest new repositories.

For automation or the console, the same code path minus the picker:

```js
window.__loadRepoFiles([{ path: 'a/b.py', src: '...' }], 'my-corpus');
window.__ingestDocuments([{ path: 'README.md', text: '...' }], 'my-docs');
```

**Mobile browsers have no folder picker.** `webkitdirectory` is silently
ignored and degrades to a single-file picker, so the zip path is the only one
that works on a phone. The sidebar hides the folder button on touch devices
rather than offering something broken. GitHub → **Code** → **Download ZIP**
feeds it directly.

---

## Loading your own codebase

### Via the CLI (repeatable, commits a corpus)

```bash
# 1. Extract. Languages: Python, JavaScript/JSX, TypeScript/TSX.
node extract/node.mjs ../some-repo --out data/somerepo/graph.json

# 2. Adapt + lay out.
npm run build:graph -- --name somerepo

# 3. Serve.
npm run dev
```

Step 1 writes raw extractor output (gitignored — large and regenerable).
Step 2 writes:

- `data/somerepo/graph.canonical.json` — **committed**; small, portable, the
  single source of truth
- `web/public/data/somerepo.layout.json` + `.edges.json` + `.sources.json` —
  gitignored, regenerated in seconds

### Via the original Graphify CLI

Still supported, and it's the fidelity reference the JS extractor is scored
against:

```bash
graphify update <repo> --no-cluster
cp graphify-out/graph.json data/<name>/graph.json
npm run build:graph -- --name <name>
```

`--no-cluster` skips Graphify's Leiden pass and its LLM-based community
naming. Grapheon runs its own seeded Louvain and names communities
deterministically, so this is not a downgrade — it removes the only step that
would have needed an API key.

> Note: Graphify's README documents an `extract` subcommand that **does not
> exist** in the CLI (v0.9.32). The code-only path is `graphify update <path>`.

The JS extractor scores **97.7% link recall** against Graphify's output —
`bench/RESULTS.md` has the full comparison.

### Which corpus loads by default

`DEFAULT_CORPUS` in `web/src/App.jsx` (currently `'aeon'`). Anything else is
loaded at runtime through the pickers or the **History** page.

---

## Every script, explained

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `npm install` | Installs all three workspaces. Root only. |
| `npm run dev` | Vite dev server on :5180, hot reload. |
| `npm run build` | Production build → `web/dist/`. |
| `npm run build:graph -- --name <n>` | Adapt + Louvain + ForceAtlas2 → layout artifacts. |
| `npm test` | 86 unit tests: 77 over `web/src/lib`, 9 over the extractor. |
| `npm run drive --workspace web` | Playwright end-to-end pass. Needs a dev server already running. |
| `npm run sync:android` | Production build, then copies `web/dist` into the Android project. |
| `node extract/node.mjs <dir> --out <file>` | Standalone extraction, no browser. |

### `build:graph` flags

| Flag | Default | Meaning |
|---|---|---|
| `--name` | `aeon` | Corpus name; decides every input and output path. |
| `--source` | `graphify` | Which adapter to use. Registered in `ADAPTERS` in `pipeline/build.js`. |
| `--in` | `data/<name>/graph.json` | Raw extractor output to read. |
| `--iterations` | `600` | ForceAtlas2 iterations. |

**Do not raise `--iterations` to fix a bad-looking layout.** 600 and 1200
score identically here, which is the signature of a force-balance problem
rather than an unconverged one. The constants that actually matter scale with
graph density and live in `pipeline/layout.js`.

---

## What lands on disk

```
data/<name>/graph.json              raw extractor output      gitignored
data/<name>/graph.canonical.json    canonical graph           COMMITTED
data/<name>/sources.json            captured source text      gitignored
web/public/data/<name>.layout.json  node positions + colours  gitignored
web/public/data/<name>.edges.json   edge list                 gitignored
web/public/data/<name>.sources.json source manifest           gitignored
web/public/data/<name>/src/…        mirrored source tree      gitignored
web/dist/                           production build          gitignored
```

The rule: **the canonical graph is committed, everything derived from it is
not.** Derived files regenerate in seconds and would otherwise be enormous,
churning diffs. Both intermediate shapes are specified in
[CONTRACT.md](CONTRACT.md).

`layout.json` and `edges.json` are stamped with a shared `buildId`, and the app
refuses to mix builds. Without that check, a cached layout resolves fewer ids
against fresh edges and silently returns a *smaller* blast radius — a
plausible-looking wrong answer, which is the worst kind.

Source text is served **per file** from the mirrored tree, never as one blob:
Aeon's corpus is 18 MB of text and nobody should download that to read one
function.

---

## Verifying it works

```bash
npm test                        # 86 unit tests, ~1s, no browser needed
npm run dev                     # in one terminal
npm run drive --workspace web   # in another
```

The drive is a Playwright pass over the whole app: desktop and mobile
viewports, in-browser extraction, the code viewer, file explorer, cross-file
search, knowledge base, PDF ingestion, history, corpus diff, the command
palette, and the standalone HTML export opened from `file://`. It **fails the
run on any console error**, and it prints a line per feature with real numbers.

To drive a container instead of a host dev server:

```bash
GRAPHEON_URL=http://localhost:8090 npm run drive --workspace web
```

Two rules the drive encodes, both learned the hard way:

- **Never verify the map by sampling canvas pixels.** Without
  `preserveDrawingBuffer`, drawing a WebGL canvas into a 2D one always reads
  back blank, so a perfectly good map reports as a failure. Trust the
  screenshot.
- **Screenshot the resting map, not a selected one.** Selecting dims every
  non-neighbour to alpha 0.06, which against `#0a0a0f` is invisible.

---

## Deploying it

The production build is pure static files. Any static host works — GitHub
Pages, Netlify, Cloudflare Pages, S3, nginx, a USB stick.

```bash
npm run build          # -> web/dist
```

Two requirements:

1. **Serve `.wasm` with `application/wasm`.** The tree-sitter grammars are
   WASM; a wrong MIME type breaks in-browser extraction only, so the app looks
   fine until someone opens a repo.
2. **The router is `HashRouter`.** URLs look like `/#/blast`. This is
   deliberate — deep links must survive on a static host with no rewrite rules.
   Do not "fix" it to `BrowserRouter` without adding a catch-all rewrite.

> **nginx warning.** Never add a `types { ... }` block to the server context.
> It **replaces** the whole inherited MIME map, so declaring
> `application/wasm wasm` alone silently downgrades every other file — JS
> bundles included — to `application/octet-stream`, and browsers refuse a
> module script with that type. `nginx:1.27-alpine`'s stock `mime.types`
> already has both `wasm` and `js`. This bug shipped once here; the tell was
> `content_type: application/octet-stream` on a `.js` asset.

---

## Troubleshooting

### The app is stuck on "Loading atlas…"

Usually the layout artifacts are missing. Run:

```bash
npm run build:graph -- --name aeon
```

If it persists and you're on the host, open DevTools. A `404` on
`/data/aeon.layout.json` confirms it. If instead you see nothing in the console
and the app simply never finishes, see the next entry.

### The app wedges on load, but only on some machines

Each renderer creates its own canvas, React StrictMode double-mounts, and
`destroy()` cannot run until the first `init()` resolves — so two PixiJS
Applications briefly race for one WebGL context. This is already handled, but
if you're modifying `AtlasRenderer` lifecycle code, know that **it does not
reproduce in headless Chromium**, so the Playwright drive will not catch a
regression here. Test in a real browser.

### `layout fetch failed` / `edges.json is from a different build`

The build-id guard is doing its job. You have a cached layout against fresh
edges. Hard-refresh, or re-run `npm run build:graph`.

### `npm run build` fails with "IIFE is not supported for code-splitting"

`worker: { format: 'es' }` has been removed from `web/vite.config.js`. Dev
works without it; the production build does not.

### Vite returns 500, "Failed to resolve import"

A dependency is declared in the wrong workspace. **Dependencies must be
declared where they are imported from** — `web/`'s worker imports
`web-tree-sitter`, so `web/package.json` must declare it. npm hoists to the
root `node_modules`, so it *looks* fine until it isn't. Re-run `npm install`
from the root.

### `node --test <dir>` fails with MODULE_NOT_FOUND

Known on Node 22 here. Point it at files, not directories — which is what the
`test` script already does.

### The file picker gives me a file, not a folder

You're on a mobile browser or a touch device. There is no folder picker
outside desktop; use **Open a repo .zip…**.

### Cross-file search feels slow

It shouldn't — ~3s cold over 142 files, ~110ms warm. Search fetches in
**batches of 12**; awaiting each file sequentially made a cold search take
**25 seconds**, one round trip each plus a per-file `setTimeout(0)` that
browsers clamp to ~4ms. If it regresses, check the concurrency in
`web/src/lib/search.js` before anything else.

### A TypeScript project renders as disconnected dots

Check import resolution before anything else. Path aliases (`@/lib/utils`) and
`baseUrl` imports are the norm in TS projects; treating them as npm packages
left a real 79-file repo with **5 of 138 imports resolved** — a graph that
parsed perfectly and meant nothing. `resolveAlias` in `extract/src/extract.js`
suffix-matches against the corpus and took that to 107/158.

### Docker: every `docker` command hangs forever

Docker Desktop's engine can be up-but-wedged — processes running for days, the
WSL distro reporting `Running`, and yet every CLI call hangs. Fix:

```powershell
# Kill Docker Desktop and com.docker.backend, then:
wsl -t docker-desktop
# relaunch Docker Desktop
```

**Do not run `wsl --shutdown`** — that kills every distro including your
Ubuntu. Check `docker info` responds *before* concluding a Dockerfile is
broken; a wedged engine makes healthy images look broken.

### Docker dev server starts but the port answers nothing

Vite bound to loopback inside the container. It needs `--host 0.0.0.0`, which
the compose file and Dockerfile already pass.

### git-bash mangles container paths

`docker exec … ls /etc/nginx` becomes `C:/Program Files/Git/etc/nginx`. Prefix
the command with `MSYS_NO_PATHCONV=1`.

---

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the three passes work and why
- [RUNNING-ANDROID.md](RUNNING-ANDROID.md) — the phone app
- [CONTRACT.md](CONTRACT.md) — the two JSON shapes everything meets at
- [../bench/RESULTS.md](../bench/RESULTS.md) — extractor fidelity measurements
