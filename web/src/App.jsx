import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AtlasRenderer } from './AtlasRenderer.js';
import { GraphContext } from './GraphContext.js';
import Sidebar from './components/Sidebar.jsx';
import AtlasPage from './pages/AtlasPage.jsx';
import BlastRadiusPage from './pages/BlastRadiusPage.jsx';
import KnowledgePage from './pages/KnowledgePage.jsx';
import CodePane from './CodePane.jsx';
import FileTree from './FileTree.jsx';
import SearchPanel from './SearchPanel.jsx';
import Divider from './components/Divider.jsx';
import { usePanelWidths, LIMITS } from './lib/usePanelWidths.js';
import { fetchedSources, inMemorySources, lineOf } from './lib/sources.js';
import { onBackButton } from './lib/backButton.js';

const DEFAULT_CORPUS = 'aeon';

// Below this, edges are drawn on the map and fetched before first paint so it
// is never briefly edgeless; above it they stay lazy (the renderer won't draw
// them anyway). `meta.counts.edges` decides without fetching the file.
const EAGER_EDGE_LIMIT = 20000;

/**
 * Unwrap a fetched edges.json and refuse to mix it with a layout from a
 * different build — a cached layout against fresh edges silently shrinks
 * every blast radius. Only applies to the FETCHED pair; a worker result is
 * born consistent.
 */
function readEdges(doc, layout) {
  const got = doc?.meta?.buildId;
  const want = layout?.meta?.buildId;
  if (want && got && got !== want) {
    throw new Error(
      `edges.json is from a different build (${got} vs layout ${want}) — hard-refresh, or re-run npm run build:graph`
    );
  }
  return doc.edges;
}

function buildAdjacency(edges) {
  const adj = new Map();
  const push = (a, b, rel, conf, dir) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, rel, conf, dir });
  };
  for (const [s, t, rel, conf] of edges) {
    push(s, t, rel, conf, 'out'); // s depends on t
    push(t, s, rel, conf, 'in');  // t is depended upon by s
  }
  return adj;
}

export default function App() {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const workerRef = useRef(null);

  // One corpus at a time: the statically-built default, or a repo extracted
  // in the browser. `edges` may be null for a big fetched corpus (lazy).
  const [corpus, setCorpus] = useState(null); // { name, layout, edges|null }
  const [busy, setBusy] = useState(null);     // { stage, detail } while extracting
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [sources, setSources] = useState(null);   // source-text origin, or null
  const [codeOpen, setCodeOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Phone-only nav drawer. At 390px the top bar needed 504px to lay out its
  // items, so they overlapped and "Open a repo .zip…" sat entirely off-screen
  // — there was literally no way to load a repo on a phone.
  const [menuOpen, setMenuOpen] = useState(false);
  // The knowledge base, when one is loaded: BM25 index + passage/doc metadata.
  // Its GRAPH goes through `corpus` like any other, so the Atlas, file tree and
  // code pane render it with no changes — a corpus is a corpus.
  const [knowledge, setKnowledge] = useState(null);
  // Files opened from the TREE or SEARCH rather than from a graph node. Kept
  // separate from `selected` because most readable files (README, compose.yml)
  // have no node at all, and forcing them through the selection would mean
  // inventing graph entities that do not exist.
  //
  // A list, not a single path: `tabs` is the open set, `openPath` is which one
  // is showing. A tab remembers the line it was opened at, so returning to a
  // search hit lands where you left it.
  const [tabs, setTabs] = useState([]);   // [{path, line}]
  const [openPath, setOpenPath] = useState(null);
  const { widths, raw: rawWidths, narrow, set: setWidth, reset: resetWidth } = usePanelWidths();

  // --- default corpus ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/data/${DEFAULT_CORPUS}.layout.json`);
        if (!res.ok) throw new Error(`layout fetch failed: ${res.status}`);
        const layout = await res.json();
        let edges = null;
        if ((layout.meta?.counts?.edges ?? Infinity) <= EAGER_EDGE_LIMIT) {
          const er = await fetch(`/data/${DEFAULT_CORPUS}.edges.json`);
          if (er.ok) edges = readEdges(await er.json(), layout);
        }
        if (!cancelled) setCorpus({ name: DEFAULT_CORPUS, layout, edges });

        // Source manifest is optional — a corpus built without it simply has
        // no code viewer, so a 404 here is not an error.
        const sr = await fetch(`/data/${DEFAULT_CORPUS}.sources.json`);
        if (!cancelled && sr.ok) setSources(fetchedSources(await sr.json()));
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // --- renderer lifecycle: rebuilt whenever the corpus changes -------------
  useEffect(() => {
    if (!corpus) return;
    let cancelled = false;
    let renderer = null;
    (async () => {
      renderer = new AtlasRenderer(containerRef.current);
      await renderer.init(corpus.layout, corpus.edges);
      if (cancelled) { renderer.destroy(); return; }
      rendererRef.current = renderer;
      renderer.onSelect = (n) => setSelected(n);
    })().catch((err) => setError(err.message));
    return () => {
      cancelled = true;
      setSelected(null);
      rendererRef.current?.destroy();
      rendererRef.current = null;
      if (renderer && renderer !== rendererRef.current) renderer.destroy?.();
    };
  }, [corpus]);

  // --- adjacency -----------------------------------------------------------
  const adjacency = useMemo(
    () => (corpus?.edges ? buildAdjacency(corpus.edges) : null),
    [corpus]
  );

  const ensureAdjacency = useCallback(async () => {
    if (adjacency) return adjacency;
    // Only the fetched default corpus can be missing edges (lazy path).
    const res = await fetch(`/data/${corpus.name}.edges.json`);
    if (!res.ok) throw new Error(`edges fetch failed: ${res.status}`);
    const edges = readEdges(await res.json(), corpus.layout);
    setCorpus((c) => ({ ...c, edges }));
    return buildAdjacency(edges);
  }, [adjacency, corpus]);

  // --- in-browser extraction ----------------------------------------------
  const extractRepo = useCallback((input, name) => {
    // Accepts either a bare file list (the automation hook) or the
    // {files, readable} split the pickers produce.
    const files = Array.isArray(input) ? input : input.files;
    const readable = Array.isArray(input) ? input : input.readable;
    if (!files.length) {
      setError('No parseable files found (looked for .py, .js, .jsx).');
      return;
    }
    workerRef.current?.terminate();
    setError(null);
    setBusy({ stage: 'starting', detail: `${files.length} files` });
    const w = new Worker(new URL('./worker/extract-worker.js', import.meta.url), { type: 'module' });
    workerRef.current = w;
    // A worker that fails to LOAD never posts a message — without this the UI
    // sits on "starting" forever and the failure is invisible.
    w.onerror = (ev) => {
      setBusy(null);
      setError(`Extraction worker failed: ${ev.message ?? 'failed to load'}`);
      w.terminate();
      workerRef.current = null;
    };
    w.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') setBusy({ stage: msg.stage, detail: msg.detail });
      else if (msg.type === 'result') {
        setBusy(null);
        setCorpus({ name, layout: msg.layout, edges: msg.edges });
        // Already in memory — the worker just parsed them — so the code viewer
        // costs nothing here. `readable` is the wider set: every text file,
        // including the ones the extractor never parsed.
        setSources(inMemorySources(readable));
        w.terminate();
        workerRef.current = null;
      } else if (msg.type === 'error') {
        setBusy(null);
        setError(`Extraction failed: ${msg.message}`);
        w.terminate();
        workerRef.current = null;
      }
    };
    w.postMessage({ files, name });
  }, []);

  /** Build a knowledge base from dropped .md/.txt/.rst files. */
  const ingestDocuments = useCallback((files, name) => {
    if (!files.length) {
      setError('No readable documents found (looked for .md, .txt, .rst).');
      return;
    }
    workerRef.current?.terminate();
    setError(null);
    setBusy({ stage: 'starting', detail: `${files.length} documents` });
    const w = new Worker(new URL('./worker/knowledge-worker.js', import.meta.url), { type: 'module' });
    workerRef.current = w;
    w.onerror = (ev) => {
      setBusy(null);
      setError(`Knowledge worker failed: ${ev.message ?? 'failed to load'}`);
      w.terminate();
      workerRef.current = null;
    };
    w.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') setBusy({ stage: msg.stage, detail: msg.detail });
      else if (msg.type === 'result') {
        setBusy(null);
        setCorpus({ name, layout: msg.layout, edges: msg.edges });
        setKnowledge({
          index: msg.index,
          documents: msg.documents,
          stats: { documents: msg.documents.length, passages: msg.index.size },
        });
        // The documents ARE the sources, so the file tree and code pane show
        // them with no extra work.
        setSources(inMemorySources(files.map((f) => ({ path: f.path, src: f.text }))));
        w.terminate();
        workerRef.current = null;
      } else if (msg.type === 'error') {
        setBusy(null);
        setError(`Knowledge build failed: ${msg.message}`);
        w.terminate();
        workerRef.current = null;
      }
    };
    w.postMessage({ files, name });
  }, []);

  useEffect(() => () => workerRef.current?.terminate(), []);

  // Android back dismisses the top layer — code, then tree, then selection —
  // before it is allowed to leave the app.
  useEffect(() => onBackButton(() => {
    if (menuOpen) { setMenuOpen(false); return true; }
    if (codeOpen) { setCodeOpen(false); setOpenPath(null); setTabs([]); return true; }
    if (searchOpen) { setSearchOpen(false); return true; }
    if (treeOpen) { setTreeOpen(false); return true; }
    if (selected) { setSelected(null); return true; }
    return false;
  }), [menuOpen, codeOpen, searchOpen, treeOpen, selected]);

  // Deterministic entry point for automation (and a handy console API):
  // window.__loadRepoFiles([{path, src}], 'name') drives the exact same path
  // as the folder picker, minus the picker.
  useEffect(() => {
    window.__loadRepoFiles = (files, name = 'repo') => extractRepo(files, name);
    window.__ingestDocuments = (docs, name = 'documents') => ingestDocuments(docs, name);
    return () => {
      delete window.__loadRepoFiles;
      delete window.__ingestDocuments;
    };
  }, [extractRepo, ingestDocuments]);

  const nodeById = useMemo(() => {
    if (!corpus) return new Map();
    return new Map(corpus.layout.nodes.map((n) => [n.id, n]));
  }, [corpus]);

  const focus = useCallback((node) => {
    setSelected(node);
    rendererRef.current?.focus(node.id);
  }, []);

  const highlight = useCallback((ids) => {
    rendererRef.current?.highlight(ids);
  }, []);

  const setKindFilter = useCallback((kinds) => {
    rendererRef.current?.setKindFilter(kinds);
  }, []);

  // Entities from the same file as the selection, so the code gutter can mark
  // where its neighbours are defined.
  const relatedInFile = useMemo(() => {
    if (!selected?.a?.path || !adjacency) return [];
    // Gutter marks only make sense when the open file is the selection's file;
    // browsing away to a README shouldn't carry another file's markers.
    const out = [];
    for (const link of adjacency.get(selected.id) ?? []) {
      const n = nodeById.get(link.id);
      if (n?.a?.path) out.push({ path: n.a.path, loc: n.a.loc, label: n.l, rel: link.rel });
    }
    return out;
  }, [selected, adjacency, nodeById]);

  // One file node per path, for the tree's colour dots and for jumping from a
  // file back onto the map. Prefer the FILE node (loc L1) over an entity that
  // merely lives in the same file.
  const nodeByPath = useMemo(() => {
    const m = new Map();
    for (const n of corpus?.layout.nodes ?? []) {
      const p = n.a?.path;
      if (!p) continue;
      const existing = m.get(p);
      if (!existing || lineOf(n.a?.loc) === 1) m.set(p, n);
    }
    return m;
  }, [corpus]);

  /** Open a file from the tree or a search hit — no graph node required. */
  const openFile = useCallback((path, line = null) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.path === path);
      if (i === -1) return [...prev, { path, line }];
      // Re-opening at a new line (a different search hit) should move there.
      if (line == null || prev[i].line === line) return prev;
      const next = [...prev];
      next[i] = { path, line };
      return next;
    });
    setOpenPath(path);
    setCodeOpen(true);
  }, []);

  const closeTab = useCallback((path) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.path === path);
      const next = prev.filter((t) => t.path !== path);
      setOpenPath((cur) => {
        if (cur !== path) return cur;
        // Fall back to the neighbour on the left, the way editors do.
        return next.length ? next[Math.max(0, i - 1)].path : null;
      });
      if (!next.length) setCodeOpen(false);
      return next;
    });
  }, []);

  // What the code pane shows: a tree-opened file wins while it is set,
  // otherwise the selected node's file.
  const openedFile = useMemo(() => {
    if (openPath) {
      const n = nodeByPath.get(openPath);
      const tab = tabs.find((t) => t.path === openPath);
      return {
        path: openPath,
        title: openPath.slice(openPath.lastIndexOf('/') + 1),
        line: tab?.line ?? null,
        hue: n?.h ?? null,
      };
    }
    if (selected?.a?.path) {
      return { path: selected.a.path, title: selected.l, line: lineOf(selected.a.loc), hue: selected.h };
    }
    return null;
  }, [openPath, tabs, selected, nodeByPath]);

  const value = useMemo(() => ({
    layout: corpus?.layout ?? null,
    corpusName: corpus?.name ?? null,
    adjacency, ensureAdjacency, nodeById, nodeByPath,
    selected, setSelected, focus, highlight, setKindFilter,
    extractRepo, busy,
    sources, codeOpen, setCodeOpen, treeOpen, setTreeOpen, openFile,
    searchOpen, setSearchOpen, menuOpen, setMenuOpen, narrow,
    knowledge, ingestDocuments,
  }), [corpus, adjacency, ensureAdjacency, nodeById, nodeByPath, selected, focus, highlight,
       setKindFilter, extractRepo, busy, sources, codeOpen, treeOpen, openFile,
       searchOpen, menuOpen, narrow, knowledge, ingestDocuments]);

  const layout = corpus?.layout;

  return (
    <HashRouter>
      <GraphContext.Provider value={value}>
        <div className={`app${codeOpen && openedFile ? ' code-open' : ''}${treeOpen ? ' tree-open' : ''}`}>
          {/* Order is nav rail -> file tree -> map -> code: the same left-to-right
              reading order every editor uses, so the layout needs no learning. */}
          <Sidebar />

          {treeOpen && sources && (
            <>
              <FileTree
                width={widths.side}
                paths={[...sources.paths].sort()}
                nodeByPath={nodeByPath}
                current={openedFile?.path ?? null}
                onPick={openFile}
                onClose={() => setTreeOpen(false)}
              />
              {!narrow && (
                <Divider
                  side="left" label="File tree width"
                  width={rawWidths.side} min={LIMITS.side.min} max={LIMITS.side.max}
                  onResize={(w) => setWidth('side', w)}
                  onReset={() => resetWidth('side')}
                />
              )}
            </>
          )}

          {searchOpen && sources && (
            <>
              <SearchPanel
                width={widths.side}
                sources={sources}
                onOpen={openFile}
                onClose={() => setSearchOpen(false)}
              />
              {!narrow && (
                <Divider
                  side="left" label="Search panel width"
                  width={rawWidths.side} min={LIMITS.side.min} max={LIMITS.side.max}
                  onResize={(w) => setWidth('side', w)}
                  onReset={() => resetWidth('side')}
                />
              )}
            </>
          )}

          <main className="stage">
            {/*
              The canvas lives ABOVE the router on purpose. Routing it would
              tear down and rebuild the WebGL context on every navigation —
              ~0.5-1.5s each time, and rapid create/destroy cycles are exactly
              what caused the init race we already fixed. Pages render as
              panels over a map that never unmounts (it is only rebuilt when
              the CORPUS changes, which genuinely is a new map).
            */}
            <div className="canvas-wrap" ref={containerRef} />

            {!layout && !error && <div className="status">Loading atlas…</div>}
            {error && (
              <div className="status error">
                {error}
                <div className="hint">Run: npm run build:graph</div>
              </div>
            )}

            {busy && (
              <div className="status busy">
                <div className="stage-name">{busy.stage}</div>
                <div className="hint">{busy.detail}</div>
              </div>
            )}

            {layout && (
              <Routes>
                <Route path="/" element={<AtlasPage />} />
                <Route path="/blast" element={<BlastRadiusPage />} />
                <Route path="/knowledge" element={<KnowledgePage />} />
              </Routes>
            )}
          </main>

          {/* Sibling of the stage, not a route: the code pane is a layout mode
              that works on every page, and the map must stay visible beside
              it — that side-by-side is the entire point. */}
          {codeOpen && openedFile && (
            <>
              {!narrow && (
                <Divider
                  side="right" label="Code pane width"
                  width={rawWidths.code} min={LIMITS.code.min} max={LIMITS.code.max}
                  onResize={(w) => setWidth('code', w)}
                  onReset={() => resetWidth('code')}
                />
              )}
              <CodePane
                width={widths.code}
                file={openedFile}
              sources={sources}
              related={relatedInFile}
              tabs={tabs}
                onSelectTab={setOpenPath}
                onCloseTab={closeTab}
                onClose={() => { setCodeOpen(false); setOpenPath(null); setTabs([]); }}
              />
            </>
          )}
        </div>
      </GraphContext.Provider>
    </HashRouter>
  );
}
