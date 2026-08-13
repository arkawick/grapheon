import { useMemo, useState } from 'react';
import { useGraph } from '../GraphContext.js';
import { computeInsights } from '../lib/insights.js';
import { insightsMarkdown, download, mapPng } from '../lib/export.js';

/**
 * What the graph noticed without being asked.
 *
 * Every other page answers a question you have to already know to ask. This is
 * the one that talks first — and for a new user it is also the answer to
 * "what am I looking at".
 */
export default function InsightsPage() {
  const { layout, adjacency, ensureAdjacency, nodeById, focus, corpusName, renderer } = useGraph();
  const [adj, setAdj] = useState(adjacency);
  const [tab, setTab] = useState('hubs');

  useMemo(() => {
    if (!adj) ensureAdjacency().then(setAdj).catch(() => {});
  }, [adj, ensureAdjacency]);

  const insights = useMemo(() => {
    if (!adj || !layout) return null;
    return computeInsights(layout.nodes, adj, layout.communities);
  }, [adj, layout]);

  const go = (id) => {
    const n = nodeById.get(id);
    if (n) focus(n);
  };

  if (!insights) {
    return (
      <aside className="panel insights">
        <h1>Insights</h1>
        <p className="dim empty">Reading the graph…</p>
      </aside>
    );
  }

  const { hubs, unused, cycles, coupling, totals } = insights;
  const TABS = [
    ['hubs', 'Depended on', hubs.length],
    ['unused', 'Unused', unused.likelyTotal],
    ['cycles', 'Cycles', cycles.length],
    ['coupling', 'Coupling', coupling.length],
  ];

  return (
    <aside className="panel insights">
      <h1>Insights</h1>
      <p className="dim question">
        {totals.nodes.toLocaleString()} entities · {totals.callables} callables ·{' '}
        {totals.communities} subsystems
      </p>

      <div className="ins-actions">
        <button onClick={() => download(
          `${corpusName}-report.md`, insightsMarkdown(corpusName, insights, layout)
        )}>Export report</button>
        <button className="ghost" onClick={async () => {
          try {
            download(`${corpusName}-map.png`, await mapPng(renderer?.current), 'image/png');
          } catch (e) { alert(e.message); }
        }}>Map as PNG</button>
      </div>

      <div className="seg ins-tabs">
        {TABS.map(([key, label, n]) => (
          <button key={key} className={key === tab ? 'on' : ''} onClick={() => setTab(key)}>
            {label} <span className="dim">{n}</span>
          </button>
        ))}
      </div>

      {tab === 'hubs' && (
        <>
          <p className="dim hint-line">Change these and the most breaks.</p>
          {hubs.map((h) => (
            <button key={h.id} className="ins-row" onClick={() => go(h.id)}>
              <span className="ins-count">{h.count}</span>
              <span className="ins-label">{h.label}</span>
              <span className="ins-path mono dim">{h.path}</span>
            </button>
          ))}
        </>
      )}

      {tab === 'unused' && (
        <>
          <p className="dim hint-line">
            Callables with no inbound reference anywhere in this corpus.
          </p>
          {/* Entry points are held back on purpose: a framework calls them, so
              listing them as dead would make the whole list untrustworthy. */}
          {unused.entryPointTotal > 0 && (
            <p className="caveat">
              {unused.entryPointTotal} more look like framework entry points or
              runtime hooks — called by something the parser cannot see, so
              they are excluded rather than reported as dead.
            </p>
          )}
          {!unused.likely.length && <p className="dim empty">Everything is referenced.</p>}
          {unused.likely.map((u) => (
            <button key={u.id} className="ins-row" onClick={() => go(u.id)}>
              <span className="ins-label">{u.label}</span>
              <span className="ins-path mono dim">{u.path}</span>
            </button>
          ))}
          {unused.likelyTotal > unused.likely.length && (
            <p className="dim empty">…and {unused.likelyTotal - unused.likely.length} more.</p>
          )}
        </>
      )}

      {tab === 'cycles' && (
        <>
          <p className="dim hint-line">Groups that depend on each other, directly or not.</p>
          {!cycles.length && <p className="dim empty">No dependency cycles.</p>}
          {cycles.map((cyc, i) => (
            <section key={i} className="ins-cycle">
              <h3>{cyc.length} entities</h3>
              {cyc.map((n) => (
                <button key={n.id} className="ins-row" onClick={() => go(n.id)}>
                  <span className="ins-label">{n.label}</span>
                  <span className="ins-path mono dim">{n.path}</span>
                </button>
              ))}
            </section>
          ))}
        </>
      )}

      {tab === 'coupling' && (
        <>
          <p className="dim hint-line">Reaches into several subsystems at once.</p>
          {!coupling.length && <p className="dim empty">Nothing spans multiple subsystems.</p>}
          {coupling.map((c) => (
            <button key={c.id} className="ins-row wrap" onClick={() => go(c.id)}>
              <span className="ins-count">{c.reaches}</span>
              <span className="ins-label">{c.label}</span>
              <span className="ins-path mono dim">{c.into.join(' · ')}</span>
            </button>
          ))}
        </>
      )}
    </aside>
  );
}
