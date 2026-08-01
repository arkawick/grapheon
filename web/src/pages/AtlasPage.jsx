import { useEffect, useState, useCallback } from 'react';
import { useGraph } from '../GraphContext.js';
import SearchBox from '../SearchBox.jsx';
import DetailPanel from '../DetailPanel.jsx';
import Legend from '../Legend.jsx';

export default function AtlasPage() {
  const {
    layout, adjacency, ensureAdjacency, nodeById,
    selected, setSelected, focus, highlight, setKindFilter,
  } = useGraph();

  const [hidden, setHidden] = useState(() => new Set());
  const [neighbours, setNeighbours] = useState([]);

  // Spotlight the selection and its immediate neighbourhood.
  useEffect(() => {
    if (!selected) {
      setNeighbours([]);
      highlight(null);
      return;
    }
    let stale = false;
    (async () => {
      const adj = adjacency ?? (await ensureAdjacency());
      if (stale) return;
      const links = adj.get(selected.id) ?? [];
      setNeighbours(links);
      highlight([selected.id, ...links.map((l) => l.id)]);
    })();
    return () => { stale = true; };
  }, [selected, adjacency, ensureAdjacency, highlight]);

  // Leaving the page shouldn't leave the map dimmed.
  useEffect(() => () => highlight(null), [highlight]);

  const toggleKind = useCallback((kind) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      const visible = layout.kinds.filter((k) => !next.has(k));
      // null means "no filter" — cheaper than a Set containing everything.
      setKindFilter(visible.length === layout.kinds.length ? null : visible);
      return next;
    });
  }, [layout, setKindFilter]);

  return (
    <>
      <header className="page-bar">
        <SearchBox nodes={layout.nodes} onPick={focus} />
      </header>

      <Legend
        communities={layout.communities}
        kinds={layout.kinds}
        hidden={hidden}
        onToggleKind={toggleKind}
        onPickCommunity={(c) => {
          const node = layout.nodes.find((n) => n.c === c.id && n.l === c.label);
          if (node) focus(node);
        }}
      />

      {selected && (
        <DetailPanel
          node={selected}
          neighbours={neighbours}
          communities={layout.communities}
          onClose={() => setSelected(null)}
          onPick={(id) => {
            const n = nodeById.get(id);
            if (n) focus(n);
          }}
        />
      )}
    </>
  );
}
