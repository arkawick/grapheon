import { useCallback, useEffect, useState } from 'react';
import { useGraph } from '../GraphContext.js';
import { listCorpora, deleteCorpus, clearCorpora } from '../lib/history.js';

const fmtBytes = (n) =>
  n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Everything built in this browser, restorable without re-parsing.
 *
 * The alternative — re-picking the folder and running extraction again — is
 * seconds to minutes depending on the repo, so this is the difference between
 * comparing two codebases and choosing between them.
 */
export default function HistoryPage() {
  const { restoreCorpus, corpusName, busy } = useGraph();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    listCorpora().then(setItems).catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(refresh, [refresh, corpusName]);

  const onRestore = async (id) => {
    try {
      await restoreCorpus(id);
    } catch (e) {
      setError(String(e.message ?? e));
    }
  };

  const onDelete = async (id) => {
    await deleteCorpus(id);
    refresh();
  };

  const total = items?.reduce((a, i) => a + i.bytes, 0) ?? 0;

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

      {items?.map((it) => {
        const active = it.name === corpusName;
        return (
          <article key={it.id} className={`hist-item${active ? ' active' : ''}`}>
            <header>
              <span className={`hist-kind ${it.kind}`}>{it.kind}</span>
              <span className="hist-name">{it.name}</span>
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
              <button
                disabled={active || !!busy}
                onClick={() => onRestore(it.id)}
              >
                {active ? 'Loaded' : 'Restore'}
              </button>
              <button className="ghost" onClick={() => onDelete(it.id)}>Delete</button>
            </div>
          </article>
        );
      })}

      {items?.length > 0 && (
        <footer className="hist-foot dim">
          {items.length} saved · {fmtBytes(total)}
          <button
            className="ghost"
            onClick={async () => { await clearCorpora(); refresh(); }}
          >
            Clear all
          </button>
        </footer>
      )}
    </aside>
  );
}
