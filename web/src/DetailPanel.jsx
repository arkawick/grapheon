/**
 * The selected entity and everything that touches it.
 *
 * Neighbours are grouped by relation and each one carries Graphify's
 * EXTRACTED / INFERRED tag. That distinction is the point: an inferred edge is
 * the extractor's hypothesis, and a reader deserves to know which claims are
 * read straight out of the source and which were resolved by analysis.
 */
export default function DetailPanel({ node, neighbours, communities, onClose, onPick }) {
  const community = communities.find((c) => c.id === node.c);

  const grouped = neighbours.reduce((acc, n) => {
    (acc[n.rel] ??= []).push(n);
    return acc;
  }, {});
  const relations = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);

  return (
    <aside className="detail">
      <button className="close" onClick={onClose} aria-label="Close">×</button>

      <div className="detail-head">
        <span className="dot lg" style={{ background: `hsl(${node.h} 68% 62%)` }} />
        <h2>{node.l}</h2>
      </div>

      <dl className="meta">
        <dt>Kind</dt><dd>{node.k}</dd>
        {node.a?.path && <><dt>Path</dt><dd className="mono">{node.a.path}</dd></>}
        {node.a?.loc && <><dt>Location</dt><dd className="mono">{node.a.loc}</dd></>}
        {community && (
          <>
            <dt>Community</dt>
            <dd>{community.label} <span className="dim">({community.size} nodes)</span></dd>
          </>
        )}
        <dt>Connections</dt><dd>{neighbours.length}</dd>
      </dl>

      {relations.length === 0 && (
        <p className="dim empty">Nothing links to this node.</p>
      )}

      {relations.map(([rel, items]) => (
        <section key={rel} className="rel-group">
          <h3>{rel.replace(/_/g, ' ')} <span className="dim">{items.length}</span></h3>
          <ul>
            {items.map((n, i) => (
              <li key={`${n.id}-${i}`}>
                <button onClick={() => onPick(n.id)}>{n.id}</button>
                <span className={`tag ${n.conf === 'INFERRED' ? 'inferred' : 'extracted'}`}>
                  {n.conf === 'INFERRED' ? 'inferred' : 'extracted'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
