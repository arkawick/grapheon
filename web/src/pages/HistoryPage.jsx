import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGraph } from '../GraphContext.js';
import { listCorpora, loadCorpus, deleteCorpus, clearCorpora } from '../lib/history.js';
import { diffCorpora } from '../lib/diff.js';
import { download } from '../lib/export.js';

const fmtBytes = (n) =>
  n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function HistoryPage() {
  const { restoreCorpus, corpusName, busy } = useGraph();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState([]);   // ids selected for comparison
  const [diff, setDiff] = useState(null);
  const [diffing, setDiffing] = useState(false);

  const refresh = useCallback(() => {
    listCorpora().then(setItems).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(refresh, [refresh, corpusName]);

  // Grouped by corpus, newest first: several builds of one repo are versions
  // of the same thing, not separate entries competing for attention.
  const groups = useMemo(() => {
    const m = new Map();
    for (const it of items ?? []) {
      if (!m.has(it.name)) m.set(it.name, []);
      m.get(it.name).push(it);
    }
    return [...m.entries()];
  }, [items]);

  const toggle = (id) => setPicked((p) => {
    if (p.includes(id)) return p.filter((x) => x !== id);
    // Two at a time; picking a third replaces the older selection.
    return p.length < 2 ? [...p, id] : [p[1], id];
  });

  const compare = async () => {
    setDiffing(true);
    setError(null);
    try {
      const [a, b] = await Promise.all(picked.map(loadCorpus));
      if (!a || !b) throw new Error('One of those builds is no longer stored.');
      // Older is always "before", whichever order they were clicked.
      const metaA = items.find((i) => i.id === picked[0]);
      const metaB = items.find((i) => i.id === picked[1]);
      const [before, after] = metaA.savedAt <= metaB.savedAt ? [a, b] : [b, a];
      const [mBefore, mAfter] = metaA.savedAt <= metaB.savedAt ? [metaA, metaB] : [metaB, metaA];
      setDiff({ ...diffCorpora(before, after), mBefore, mAfter });
    } catch (e) {
      setError(String(e.message ?? e));
    } finally {
      setDiffing(false);
    }
  };

  const total = items?.reduce((a, i) => a + i.bytes, 0) ?? 0;

  if (diff) {
    return <DiffView diff={diff} onBack={() => { setDiff(null); setPicked([]); }} />;
  }

  return (
    <aside className="panel history">
      <h1>History</h1>
      <p className="dim question">
        Corpora built in this browser. Stored on this device only.
      </p>

      {error && <p className="caveat">{error}</p>}
      {!items && <p className="dim empty">Reading…</p>}

      {items?.length === 0 && (
        <p className="dim empty">
          Nothing saved yet. Open a repo or some documents and it will appear
          here, ready to switch back to without re-parsing.
        </p>
      )}

      {picked.length === 2 && (
        <button className="view-code" disabled={diffing} onClick={compare}>
          {diffing ? 'Comparing…' : 'Compare the two selected'}
        </button>
      )}
      {picked.length === 1 && (
        <p className="dim hint-line">Pick a second build to compare against.</p>
      )}

      {groups.map(([name, versions]) => (
        <section key={name} className="hist-group">
          <h3>
            {name} <span className="dim">{versions.length > 1 ? `${versions.length} builds` : ''}</span>
          </h3>
          {versions.map((it) => {
            const active = it.name === corpusName && it === versions[0];
            const sel = picked.includes(it.id);
            return (
              <article key={it.id} className={`hist-item${active ? ' active' : ''}${sel ? ' picked' : ''}`}>
                <header>
                  <span className={`hist-kind ${it.kind}`}>{it.kind}</span>
                  <span className="hist-name mono">{it.version}</span>
                  {active && <span className="hist-current">current</span>}
                </header>
                <div className="hist-meta dim">
                  {it.nodes.toLocaleString()} nodes · {it.communities} subsystems
                  {it.passages ? ` · ${it.passages} passages` : ''}
                  {it.files ? ` · ${it.files} files` : ''}
                  <br />
                  {ago(it.savedAt)} · {fmtBytes(it.bytes)}
                </div>
                <div className="hist-actions">
                  <button disabled={active || !!busy} onClick={() => restoreCorpus(it.id).catch((e) => setError(e.message))}>
                    {active ? 'Loaded' : 'Restore'}
                  </button>
                  <button className={sel ? '' : 'ghost'} onClick={() => toggle(it.id)}>
                    {sel ? 'Selected' : 'Compare'}
                  </button>
                  <button className="ghost" onClick={async () => { await deleteCorpus(it.id); refresh(); }}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      ))}

      {items?.length > 0 && (
        <footer className="hist-foot dim">
          {items.length} saved · {fmtBytes(total)}
          <button className="ghost" onClick={async () => { await clearCorpora(); refresh(); }}>
            Clear all
          </button>
        </footer>
      )}
    </aside>
  );
}

/**
 * The diff. Drift leads because it is the only part that is not obvious from a
 * normal `git diff` — a new dependency between two subsystems is one import
 * line among hundreds, and invisible until something breaks.
 */
function DiffView({ diff, onBack }) {
  const { mBefore, mAfter, nodes, files, edges, drift, subsystems } = diff;

  const report = () => {
    const L = [`# ${mAfter.name} — what changed`, ''];
    L.push(`\`${mBefore.version}\` (${new Date(mBefore.savedAt).toISOString().slice(0, 16).replace('T', ' ')})` +
      ` → \`${mAfter.version}\` (${new Date(mAfter.savedAt).toISOString().slice(0, 16).replace('T', ' ')})`, '');
    L.push(`- entities: +${nodes.addedTotal} / −${nodes.removedTotal}`);
    L.push(`- dependencies: +${edges.addedTotal} / −${edges.removedTotal}`);
    L.push(`- files: +${files.added.length} / −${files.removed.length}`);
    L.push(`- subsystems: ${subsystems.before} → ${subsystems.after}`, '');
    if (drift.length) {
      L.push('## New cross-subsystem dependencies', '');
      for (const d of drift) L.push(`- \`${d.source}\` → \`${d.target}\` (${d.from} → ${d.into}, ${d.rel})`);
      L.push('');
    }
    if (files.added.length) L.push('## Files added', '', ...files.added.map((f) => `- ${f}`), '');
    if (files.removed.length) L.push('## Files removed', '', ...files.removed.map((f) => `- ${f}`), '');
    download(`${mAfter.name}-diff.md`, L.join('\n'));
  };

  return (
    <aside className="panel history">
      <button className="chip add" onClick={onBack}>← back to history</button>
      <h1>What changed</h1>
      <p className="dim question mono">
        {mBefore.version} → {mAfter.version}
      </p>

      <div className="diff-tally">
        <span className="add">+{nodes.addedTotal}</span>
        <span className="rem">−{nodes.removedTotal}</span>
        <span className="dim">entities</span>
        <span className="add">+{edges.addedTotal}</span>
        <span className="rem">−{edges.removedTotal}</span>
        <span className="dim">dependencies</span>
      </div>

      <button className="view-code" onClick={report}>Export diff report</button>

      <section className="ring">
        <h3>New cross-subsystem dependencies <span className="dim">{drift.length}</span></h3>
        {!drift.length && (
          <p className="dim empty">
            None. Existing code did not reach into any subsystem it was not
            already using.
          </p>
        )}
        {drift.map((d, i) => (
          <div key={i} className="drift-row">
            <span className="mono">{d.source}</span>
            <span className="dim"> → </span>
            <span className="mono">{d.target}</span>
            <div className="dim">{d.from} → {d.into} · {d.rel.replace(/_/g, ' ')}</div>
          </div>
        ))}
      </section>

      {[['Files added', files.added, 'add'], ['Files removed', files.removed, 'rem']]
        .filter(([, list]) => list.length)
        .map(([title, list, cls]) => (
          <section key={title} className="ring">
            <h3>{title} <span className="dim">{list.length}</span></h3>
            <ul>{list.slice(0, 40).map((f) => (
              <li key={f}><span className={`mono ${cls}`}>{f}</span></li>
            ))}</ul>
          </section>
        ))}

      <p className="dim empty">
        Subsystems: {subsystems.before} → {subsystems.after}
      </p>
    </aside>
  );
}
