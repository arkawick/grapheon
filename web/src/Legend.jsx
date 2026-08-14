import { useEffect, useState } from 'react';
import { useGraph } from './GraphContext.js';

const TOP_COMMUNITIES = 10;
const KEY = 'grapheon.legend.open';

export default function Legend({ communities, kinds, hidden, onToggleKind, onPickCommunity }) {
  const { narrow } = useGraph();

  // Remembered, and defaulted per form factor: on a desktop the legend is
  // useful context and starts open; on a phone it covers the entire map, so it
  // starts closed. A stored preference wins over both.
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(KEY);
    if (saved !== null) return saved === '1';
    return !narrow;
  });

  useEffect(() => {
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* private mode */ }
  }, [open]);

  if (!open) {
    return (
      <button className="legend-toggle" onClick={() => setOpen(true)} aria-expanded="false">
        Legend
      </button>
    );
  }

  return (
    <aside className="legend open">
      <header className="legend-head">
        <span>Legend</span>
        <button onClick={() => setOpen(false)} aria-label="Collapse legend">×</button>
      </header>

      <section>
        <h3>Kinds</h3>
        <ul className="kinds">
          {kinds.map((k) => (
            <li key={k}>
              <label>
                <input
                  type="checkbox"
                  checked={!hidden.has(k)}
                  onChange={() => onToggleKind(k)}
                />
                {k}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Subsystems</h3>
        <ul className="communities">
          {communities.slice(0, TOP_COMMUNITIES).map((c) => (
            <li key={c.id}>
              <button
                onClick={() => {
                  onPickCommunity(c);
                  // On a phone the panel covers the very map it just moved.
                  if (narrow) setOpen(false);
                }}
              >
                <span className="dot" style={{ background: `hsl(${c.hue} 68% 62%)` }} />
                <span className="label">{c.label}</span>
                <span className="dim">{c.size}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
