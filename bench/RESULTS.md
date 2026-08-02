# Kill-test: web-tree-sitter (WASM) vs graphify's Python CLI

**Question:** can extraction run in a browser (and therefore in an Android
WebView) — fast enough, and faithful enough to what the Python CLI produces?

**Verdict: PASSED**, on both counts. Measured 2026-08-02, identical corpus
(Project-Aeon source), desktop Chromium via Playwright.

## Fidelity

Simple tree-sitter queries (functions, classes, methods — ~10 lines per
language, deliberately un-tuned) against graphify's `graph.json` as ground
truth:

```
recall: 326/326 entities (100.0%)
```

Every function, class and method graphify found, the WASM queries found.
An earlier run showed 82.5% — entirely an artifact of graphify labelling
methods with a leading dot (`.connect()`); after normalising, zero real misses.

## Speed

| | corpus | time | per file |
|---|---|---|---|
| WASM, Node 22 | 1202 files / 16.6 MB | 10.6 s | 8.8 ms |
| WASM, Chromium | 1202 files / 17 MB | 10.0 s (+188 ms init) | 8.3 ms |
| Python CLI (8 workers) | its own 102-file corpus | 17.5 s | ~171 ms |

Notes on fairness:

- The WASM number is parse + entity query only. The CLI's 17.5 s includes its
  graph assembly (import resolution, edge building) and startup. So the rows
  are not directly comparable — what they establish is that **parsing is not
  the bottleneck**: single-threaded WASM chews through 12x more files in less
  wall-clock than the CLI spends on its corpus.
- WASM engine init is 188 ms — irrelevant.
- The 1202-file walk covers vendored/setup trees graphify's boundary logic
  skips; only ground-truth files count toward recall.

## Phone extrapolation (unmeasured — flagged, not hidden)

Mid-range Android V8 is typically 3–5x slower than desktop: worst case ~35–50 s
for this 17 MB stress corpus, and **2–9 s for a typical 1–3 MB repo**. A real
device test still needs to happen before the Android bet is called safe;
nothing here is that test.

## What this does NOT validate

Entity **names** are the easy half. The port's real work is edges — call
resolution, import linking, the `EXTRACTED`/`INFERRED` judgment — and this
bench does not measure that. It proves the platform is viable, not that the
port is done.

## Reproduce

```bash
cd bench
npm install
node parse-bench.mjs        # Node: speed + recall vs data/aeon/graph.json
node pack-corpus.mjs        # snapshot corpus -> corpus.json (gitignored)
node drive-browser.mjs      # Chromium: same parse, real WASM fetch/init
```
