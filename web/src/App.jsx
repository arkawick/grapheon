import { useEffect, useRef, useState, useCallback } from 'react';
import { AtlasRenderer } from './AtlasRenderer.js';
import SearchBox from './SearchBox.jsx';
import DetailPanel from './DetailPanel.jsx';
import Legend from './Legend.jsx';

const CORPUS = 'aeon';

// Below this, edges are worth drawing and we fetch them before first paint so
// the map is never briefly edgeless. Above it the renderer won't draw them
// anyway, so they stay lazy and only load when something is selected.
// `meta.counts.edges` lets us decide without fetching the file first.
const EAGER_EDGE_LIMIT = 20000;

export default function App() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const adjacencyRef = useRef(null); // built once, on the first selection
  const edgesRef = useRef(null);     // set eagerly when the corpus is small

  const [layout, setLayout] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [neighbours, setNeighbours] = useState([]);
  const [hidden, setHidden] = useState(() => new Set());

  // React StrictMode mounts effects twice in dev. A WebGL context is not free
  // and the second init would leak the first one, so the teardown is real.
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
          if (er.ok) {
            edges = await er.json();
            edgesRef.current = edges; // reused by loadAdjacency; don't fetch twice
          }
          if (cancelled) return;
        }

        renderer = new AtlasRenderer(canvasRef.current);
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

  // Edges are fetched once, on the first selection, and cached. The map never
  // draws them; they exist only to answer "what touches this?".
  const loadAdjacency = useCallback(async () => {
    if (adjacencyRef.current) return adjacencyRef.current;
    let edges = edgesRef.current;
    if (!edges) {
      const res = await fetch(`/data/${CORPUS}.edges.json`);
      if (!res.ok) throw new Error(`edges fetch failed: ${res.status}`);
      edges = await res.json();
      edgesRef.current = edges;
    }
    const adj = new Map();
    const push = (a, b, rel, conf, dir) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ id: b, rel, conf, dir });
    };
    for (const [s, t, rel, conf] of edges) {
      push(s, t, rel, conf, 'out');
      push(t, s, rel, conf, 'in');
    }
    adjacencyRef.current = adj;
    return adj;
  }, []);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (!selected) {
      setNeighbours([]);
      r.highlight(null);
      return;
    }
    let stale = false;
    (async () => {
      const adj = await loadAdjacency();
      if (stale) return;
      const links = adj.get(selected.id) ?? [];
      setNeighbours(links);
      // Spotlight the selection plus its immediate neighbourhood.
      r.highlight([selected.id, ...links.map((l) => l.id)]);
    })();
    return () => { stale = true; };
  }, [selected, loadAdjacency]);

  const toggleKind = useCallback((kind) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      const visible = layout.kinds.filter((k) => !next.has(k));
      // null means "no filter" — cheaper than a Set containing everything.
      rendererRef.current?.setKindFilter(
        visible.length === layout.kinds.length ? null : visible
      );
      return next;
    });
  }, [layout]);

  const goTo = useCallback((node) => {
    setSelected(node);
    rendererRef.current?.focus(node.id);
  }, []);

  return (
    <div className="app">
      <div className="canvas-wrap">
        <canvas ref={canvasRef} />
      </div>

      <header className="topbar">
        <div className="brand">
          Grapheon
          <span className="corpus">{layout?.meta?.name ?? CORPUS}</span>
        </div>
        {layout && (
          <SearchBox nodes={layout.nodes} onPick={goTo} />
        )}
      </header>

      {layout && (
        <Legend
          communities={layout.communities}
          kinds={layout.kinds}
          hidden={hidden}
          onToggleKind={toggleKind}
          onPickCommunity={(c) => {
            const node = layout.nodes.find((n) => n.c === c.id && n.l === c.label);
            if (node) goTo(node);
          }}
        />
      )}

      {selected && (
        <DetailPanel
          node={selected}
          neighbours={neighbours}
          communities={layout?.communities ?? []}
          onClose={() => setSelected(null)}
          onPick={(id) => {
            const n = layout.nodes.find((x) => x.id === id);
            if (n) goTo(n);
          }}
        />
      )}

      {!layout && !error && <div className="status">Loading atlas…</div>}
      {error && (
        <div className="status error">
          {error}
          <div className="hint">Run: npm run build:graph</div>
        </div>
      )}

      {layout && (
        <footer className="statusbar">
          {layout.nodes.length.toLocaleString()} nodes ·{' '}
          {layout.communities.length} communities · extracted by{' '}
          {layout.meta.source}
        </footer>
      )}
    </div>
  );
}
