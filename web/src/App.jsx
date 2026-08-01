import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { AtlasRenderer } from './AtlasRenderer.js';
import { GraphContext } from './GraphContext.js';
import Sidebar from './components/Sidebar.jsx';
import AtlasPage from './pages/AtlasPage.jsx';
import BlastRadiusPage from './pages/BlastRadiusPage.jsx';

const CORPUS = 'aeon';

// Below this, edges are worth drawing and we fetch them before first paint so
// the map is never briefly edgeless. Above it the renderer won't draw them
// anyway, so they stay lazy and only load when something needs them.
// `meta.counts.edges` lets us decide without fetching the file first.
const EAGER_EDGE_LIMIT = 20000;

/**
 * Unwrap edges.json and refuse to mix it with a layout from a different build.
 *
 * A cached layout against a fresh edge file resolves fewer ids and silently
 * returns a SMALLER blast radius — a plausible-looking wrong number. Loud
 * failure is the only safe behaviour here.
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
  const edgesRef = useRef(null);

  const [layout, setLayout] = useState(null);
  const [adjacency, setAdjacency] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let renderer = null;

    (async () => {
      try {
        const res = await fetch(`/data/${CORPUS}.layout.json`);
        if (!res.ok) throw new Error(`layout fetch failed: ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setLayout(data);

        let edges = null;
        if ((data.meta?.counts?.edges ?? Infinity) <= EAGER_EDGE_LIMIT) {
          const er = await fetch(`/data/${CORPUS}.edges.json`);
          if (cancelled) return;
          if (er.ok) {
            edges = readEdges(await er.json(), data);
            edgesRef.current = edges;
            setAdjacency(buildAdjacency(edges));
          }
        }

        renderer = new AtlasRenderer(containerRef.current);
        await renderer.init(data, edges);
        if (cancelled) { renderer.destroy(); return; }
        rendererRef.current = renderer;
        renderer.onSelect = (n) => setSelected(n);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();

    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  /** Fetch + index edges on demand, for corpora too big to load eagerly. */
  const ensureAdjacency = useCallback(async () => {
    if (adjacency) return adjacency;
    let edges = edgesRef.current;
    if (!edges) {
      const res = await fetch(`/data/${CORPUS}.edges.json`);
      if (!res.ok) throw new Error(`edges fetch failed: ${res.status}`);
      edges = readEdges(await res.json(), layout);
      edgesRef.current = edges;
    }
    const adj = buildAdjacency(edges);
    setAdjacency(adj);
    return adj;
  }, [adjacency, layout]);

  const nodeById = useMemo(() => {
    if (!layout) return new Map();
    return new Map(layout.nodes.map((n) => [n.id, n]));
  }, [layout]);

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
    layout, adjacency, ensureAdjacency, nodeById,
    selected, setSelected, focus, highlight, setKindFilter,
  }), [layout, adjacency, ensureAdjacency, nodeById, selected, focus, highlight, setKindFilter]);

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
              panels over a map that never unmounts.
            */}
            <div className="canvas-wrap" ref={containerRef} />

            {!layout && !error && <div className="status">Loading atlas…</div>}
            {error && (
              <div className="status error">
                {error}
                <div className="hint">Run: npm run build:graph</div>
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
