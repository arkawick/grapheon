import { useEffect, useMemo, useState } from 'react';
import { useGraph } from '../GraphContext.js';
import SearchBox from '../SearchBox.jsx';
import { blastRadius, byDepth } from '../lib/blast.js';

const DIRECTIONS = {
  in: {
    label: 'Impact',
    question: 'What breaks if this changes?',
    empty: 'Nothing depends on this — changing it is contained.',
  },
  out: {
    label: 'Dependencies',
    question: 'What does this rely on?',
    empty: 'This depends on nothing else in the corpus.',
  },
};

export default function BlastRadiusPage() {
  const { layout, adjacency, ensureAdjacency, nodeById, selected, focus, highlight } = useGraph();

  const [depth, setDepth] = useState(3);
  const [direction, setDirection] = useState('in');
  const [adj, setAdj] = useState(adjacency);

  useEffect(() => {
    if (adj) return;
    let stale = false;
    ensureAdjacency().then((a) => { if (!stale) setAdj(a); });
    return () => { stale = true; };
  }, [adj, ensureAdjacency]);

  const result = useMemo(() => {
    if (!adj || !selected) return null;
    return blastRadius(adj, selected.id, { depth, direction });
  }, [adj, selected, depth, direction]);

  // Light up the whole radius on the map, not just direct neighbours.
  useEffect(() => {
    if (!result || !selected) { highlight(null); return; }
    highlight([selected.id, ...result.keys()]);
  }, [result, selected, highlight]);

  useEffect(() => () => highlight(null), [highlight]);

  const rings = result ? byDepth(result) : [];
  const total = result ? result.size : 0;
  const uncertain = result ? [...result.values()].filter((r) => !r.certain).length : 0;
  const dir = DIRECTIONS[direction];

  return (
    <>
      <header className="page-bar">
        <SearchBox nodes={layout.nodes} onPick={focus} />
      </header>

      <aside className="panel blast">
        <h1>Blast Radius</h1>
        <p className="dim question">{dir.question}</p>

        <div className="controls">
          <div className="seg">
            {Object.entries(DIRECTIONS).map(([key, d]) => (
              <button
                key={key}
                className={key === direction ? 'on' : ''}
                onClick={() => setDirection(key)}
              >
                {d.label}
              </button>
            ))}
          </div>

          <label className="depth">
            Depth <strong>{depth}</strong>
            <input
              type="range" min="1" max="6" value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
            />
          </label>
        </div>

        {!adj && <p className="dim">Loading edges…</p>}

        {adj && !selected && (
          <p className="dim empty">
            Search above or click a node on the map to pick a starting point.
          </p>
        )}

        {adj && selected && (
          <>
            <div className="root">
              <span className="dot lg" style={{ background: `hsl(${selected.h} 68% 62%)` }} />
              <div>
                <div className="root-label">{selected.l}</div>
                {selected.a?.path && <div className="mono dim">{selected.a.path}</div>}
              </div>
            </div>

            <div className="tally">
              <div className="big">{total}</div>
              <div className="dim">
                {direction === 'in' ? 'entities affected' : 'entities depended on'}
                <br />
                within {depth} hop{depth > 1 ? 's' : ''}
              </div>
            </div>

            {/*
              Certainty is a property of the PATH, not the edge: one inferred
              hop anywhere upstream makes everything past it a maybe. Surfacing
              the count is the honest version of an impact number.
            */}
            {uncertain > 0 && (
              <p className="caveat">
                {uncertain} of these are reached only through an inferred edge —
                treat them as possible, not certain.
              </p>
            )}

            {total === 0 && <p className="dim empty">{dir.empty}</p>}

            {rings.map(([d, items]) => (
              <section key={d} className="ring">
                <h3>
                  {d === 1 ? 'direct' : `${d} hops`} <span className="dim">{items.length}</span>
                </h3>
                <ul>
                  {items
                    .sort((a, b) => (nodeById.get(b.id)?.r ?? 0) - (nodeById.get(a.id)?.r ?? 0))
                    .map((item) => {
                      const n = nodeById.get(item.id);
                      return (
                        <li key={item.id}>
                          <button onClick={() => n && focus(n)} title={item.id}>
                            {n?.l ?? item.id}
                          </button>
                          <span className="via dim">{item.via?.replace(/_/g, ' ')}</span>
                          {!item.certain && <span className="tag inferred">inferred</span>}
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))}
          </>
        )}
      </aside>
    </>
  );
}
