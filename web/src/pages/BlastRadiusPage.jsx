import { useEffect, useMemo, useState } from 'react';
import { useGraph } from '../GraphContext.js';
import SearchBox from '../SearchBox.jsx';
import { blastRadius, byDepth } from '../lib/blast.js';
import { blastMarkdown, download } from '../lib/export.js';

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
  const {
    layout, adjacency, ensureAdjacency, nodeById, selected, focus, highlight, corpusName,
  } = useGraph();

  const [depth, setDepth] = useState(3);
  const [direction, setDirection] = useState('in');
  const [adj, setAdj] = useState(adjacency);
  // Entities pinned into the change set. Empty means "just whatever is
  // selected", which keeps the single-node flow exactly as it was.
  const [pinned, setPinned] = useState([]);

  useEffect(() => {
    if (adj) return;
    let stale = false;
    ensureAdjacency().then((a) => { if (!stale) setAdj(a); });
    return () => { stale = true; };
  }, [adj, ensureAdjacency]);

  // Changing corpus invalidates every pinned id.
  useEffect(() => setPinned([]), [corpusName]);

  const roots = useMemo(() => {
    if (pinned.length) return pinned;
    return selected ? [selected] : [];
  }, [pinned, selected]);

  const result = useMemo(() => {
    if (!adj || !roots.length) return null;
    return blastRadius(adj, roots.map((r) => r.id), { depth, direction });
  }, [adj, roots, depth, direction]);

  useEffect(() => {
    if (!result || !roots.length) { highlight(null); return; }
    highlight([...roots.map((r) => r.id), ...result.keys()]);
  }, [result, roots, highlight]);

  useEffect(() => () => highlight(null), [highlight]);

  const rings = result ? byDepth(result) : [];
  const total = result ? result.size : 0;
  const uncertain = result ? [...result.values()].filter((r) => !r.certain).length : 0;
  const dir = DIRECTIONS[direction];

  const pin = (node) => {
    if (!node) return;
    setPinned((p) => (p.some((x) => x.id === node.id) ? p : [...p, node]));
  };

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

        {adj && !roots.length && (
          <p className="dim empty">
            Search above or click a node on the map to pick a starting point.
          </p>
        )}

        {adj && roots.length > 0 && (
          <>
            {/* The change set. Real changes touch several things at once, and
                asking about them together is not the same as asking three
                separate questions — an entity two hops from each root is two
                hops away, not six. */}
            <div className="change-set">
              {roots.map((r) => (
                <span key={r.id} className="chip" title={r.a?.path}>
                  <span className="dot" style={{ background: `hsl(${r.h} 68% 62%)` }} />
                  {r.l}
                  {pinned.length > 0 && (
                    <button
                      aria-label={`Remove ${r.l}`}
                      onClick={() => setPinned((p) => p.filter((x) => x.id !== r.id))}
                    >×</button>
                  )}
                </span>
              ))}
              {selected && !roots.some((r) => r.id === selected.id) && (
                <button className="chip add" onClick={() => pin(selected)}>+ {selected.l}</button>
              )}
              {!pinned.length && selected && (
                <button className="chip add" onClick={() => pin(selected)}>+ add to set</button>
              )}
            </div>

            <div className="tally">
              <div className="big">{total}</div>
              <div className="dim">
                {direction === 'in' ? 'entities affected' : 'entities depended on'}
                <br />
                within {depth} hop{depth > 1 ? 's' : ''}
                {roots.length > 1 ? ` of ${roots.length} changes` : ''}
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

            {total > 0 && (
              <button
                className="view-code"
                onClick={() => download(
                  `${corpusName}-impact.md`,
                  blastMarkdown(corpusName, roots, rings, direction, depth, nodeById)
                )}
              >
                Export impact report
              </button>
            )}

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
