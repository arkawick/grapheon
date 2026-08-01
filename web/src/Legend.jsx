const TOP_COMMUNITIES = 10;

export default function Legend({ communities, kinds, hidden, onToggleKind, onPickCommunity }) {
  return (
    <aside className="legend">
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
              <button onClick={() => onPickCommunity(c)}>
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
