import { useState } from 'react';

const TOP_COMMUNITIES = 10;

export default function Legend({ communities, kinds, hidden, onToggleKind, onPickCommunity }) {
  // Collapsed by default on small screens (CSS decides visibility; on desktop
  // the panel always shows and the toggle button is hidden).
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="legend-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? '× Legend' : 'Legend'}
      </button>

      <aside className={`legend${open ? ' open' : ''}`}>
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
                    setOpen(false); // on mobile the panel covers the map it just moved
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
    </>
  );
}
