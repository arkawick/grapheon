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

## Part 2: the edge port (extract/)

The hard half — edges — was subsequently ported (`extract/src/extract.js`) and
scored against the same ground truth on (source, target, relation) triples:

```
relation        truth   found  recall   ours  precision
calls             241     232   96.3%    368     63.0%
contains          324     324  100.0%    324    100.0%
imports           155     155  100.0%    172     90.1%
imports_from      203     199   98.0%    203     98.0%
indirect_call      14       0    0.0%      0       n/a
inherits           23      22   95.7%     23     95.7%
method             57      57  100.0%     57    100.0%
rationale_for     123     123  100.0%    123    100.0%
references        198     195   98.5%    205     95.1%
------------------------------------------------------------
TOTAL recall: 1307/1338 (97.7%)
```

It took four scoring rounds, each decoding conventions graphify never
documents: methods labelled with a leading dot; entity-level import edges only
for symbols that are extracted entities; packages vs module files landing in
different relations; calls to internal imports targeting the defining module
but calls to external imports targeting file-scoped reference ids; stdlib calls
getting no edge at all; decorators emitting both `references` and `calls`.

Honest notes:
- `indirect_call` (14 edges, all INFERRED) is deliberately not ported.
- `calls` precision (63%) reflects graphify's own inconsistency as much as
  over-generation — e.g. its `actions.py` decorators produce no calls edges
  while its `ai.py` decorators do, on identical patterns. Our extras are
  mostly plausible edges it fails to emit uniformly.
- Scored on one corpus (Aeon). A second corpus would guard against
  overfitting to graphify-on-Aeon quirks.

## Self-hosting

`node extract/node.mjs . --out data/grapheon/graph.json` then
`node pipeline/build.js --name grapheon` — Grapheon extracts ITSELF and renders
its own map, with zero Python in the chain.

Re-measured 2026-09-12 against a clean `git archive` of `HEAD`:

```
55 files -> 263 nodes, 576 links in 430 ms      (extract)
          -> 293 nodes, 576 edges, 18 communities in 851 ms  (adapt + Louvain + FA2)
```

The 293 vs 263 gap is the adapter materialising 30 external packages as nodes.
The in-browser path agrees exactly: the Playwright drive feeds the same 55
files to the Worker and the sidebar reports **293 nodes · 18 subsystems**.

> **Extract from a clean tree, not the working tree.** `web/public/data/<name>/src/`
> is a mirrored copy of *another repo's* source, and no skip list excludes it —
> so `extract/node.mjs .` on a working tree that has built artifacts in it
> reports **917 nodes from 139 files, 654 of them (71%) Aeon's code, not
> Grapheon's**. Same family as the `android/` and `.claude/worktrees` traps.
> `git archive $(git write-tree) | tar -x -C <dir>` and extract that.

The committed `data/grapheon/graph.canonical.json` (101 nodes, 164 edges, 9
communities) predates most of the app and is due a rebuild.

## Reproduce

```bash
cd bench
npm install
node pack-corpus.mjs        # snapshot corpus -> corpus.json (gitignored)
node parse-bench.mjs        # Node: speed + entity recall
node drive-browser.mjs      # Chromium: same parse, real WASM fetch/init
```

Edge scoring lives in `extract/`, not `bench/`, and takes the extractor output
as its argument — ground truth is resolved automatically:

```bash
node extract/score.mjs extract/graph.extracted.json
```

> `parse-bench.mjs` still points `TRUTH` at `data/aeon/graph.json`, which is
> gitignored and no longer present — it needs repointing at
> `bench/ground-truth/aeon.graphify.canonical.json` (the adapted shape) before
> it will run. `score.mjs` already reads the committed ground truth and was
> re-run clean on 2026-09-12: **1307/1338 (97.7%)**, the table above unchanged.
