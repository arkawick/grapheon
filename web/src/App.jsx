import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AtlasRenderer } from './AtlasRenderer.js';
import { GraphContext } from './GraphContext.js';
import Sidebar from './components/Sidebar.jsx';
import AtlasPage from './pages/AtlasPage.jsx';
import BlastRadiusPage from './pages/BlastRadiusPage.jsx';

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
  const extractRepo = useCallback((files, name) => {
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

  useEffect(() => () => workerRef.current?.terminate(), []);

  // Deterministic entry point for automation (and a handy console API):
  // window.__loadRepoFiles([{path, src}], 'name') drives the exact same path
  // as the folder picker, minus the picker.
  useEffect(() => {
    window.__loadRepoFiles = (files, name = 'repo') => extractRepo(files, name);
    return () => { delete window.__loadRepoFiles; };
  }, [extractRepo]);

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

  const value = useMemo(() => ({
    layout: corpus?.layout ?? null,
    corpusName: corpus?.name ?? null,
    adjacency, ensureAdjacency, nodeById,
    selected, setSelected, focus, highlight, setKindFilter,
    extractRepo, busy,
  }), [corpus, adjacency, ensureAdjacency, nodeById, selected, focus, highlight, setKindFilter, extractRepo, busy]);

  const layout = corpus?.layout;

  return (
    <HashRouter>
      <GraphContext.Provider value={value}>
        <div className="app">
          <Sidebar />

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
              </Routes>
            )}
          </main>
        </div>
      </GraphContext.Provider>
    </HashRouter>
  );
}
