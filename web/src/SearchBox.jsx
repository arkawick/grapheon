import { useMemo, useState } from 'react';

const MAX_RESULTS = 12;

export default function SearchBox({ nodes, onPick }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    const out = [];
    for (const n of nodes) {
      const label = n.l?.toLowerCase() ?? '';
      const path = n.a?.path?.toLowerCase() ?? '';
      if (label.includes(term) || path.includes(term)) {
        // Rank exact prefix matches above substring hits, then bigger nodes
        // first — degree is baked into r, so this surfaces hubs.
        out.push({ node: n, score: (label.startsWith(term) ? 100 : 0) + n.r });
      }
      if (out.length > 400) break; // enough to rank well without scanning everything
    }
    return out.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map((x) => x.node);
  }, [q, nodes]);

  return (
    <div className="search">
      <input
        value={q}
        placeholder="Search entities and paths…"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) { onPick(results[0]); setOpen(false); }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <ul className="results">
          {results.map((n) => (
            <li key={n.id} onMouseDown={() => { onPick(n); setOpen(false); }}>
              <span className="dot" style={{ background: `hsl(${n.h} 68% 62%)` }} />
              <span className="label">{n.l}</span>
              <span className="kind">{n.k}</span>
              {n.a?.path && <span className="path">{n.a.path}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
