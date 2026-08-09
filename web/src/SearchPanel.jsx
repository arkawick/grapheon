import { useCallback, useEffect, useRef, useState } from 'react';
import { searchCorpus } from './lib/search.js';

/**
 * Text search across every readable file — the question the graph cannot
 * answer ("where does AZURE_OPENAI_ENDPOINT appear").
 *
 * Results stream in per file rather than arriving at the end, because on a
 * fetched corpus the first search pulls each file over the network and the
 * user should see hits appear rather than a spinner.
 */
export default function SearchPanel({ sources, onOpen, onClose, width }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [stats, setStats] = useState(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef(null);

  const run = useCallback(async (q) => {
    abortRef.current?.abort();
    if (q.trim().length < 2) { setResults([]); setStats(null); setBusy(false); return; }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setResults([]);

    const found = [];
    const summary = await searchCorpus(sources, q.trim(), (r) => {
      found.push(r);
      // Copy on push: React needs a new array identity to re-render, and
      // streaming is the whole point of doing this per file.
      if (!ctrl.signal.aborted) setResults([...found]);
    }, { signal: ctrl.signal });

    if (!ctrl.signal.aborted) { setStats(summary); setBusy(false); }
  }, [sources]);

  // Debounce: every keystroke would otherwise restart a corpus-wide scan.
  useEffect(() => {
    const t = setTimeout(() => run(query), 250);
    return () => clearTimeout(t);
  }, [query, run]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <aside className="searchpanel" style={width ? { width } : undefined}>
      <header className="tree-head">
        <input
          autoFocus
          value={query}
          placeholder="Search in files…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="close" onClick={onClose} aria-label="Close search">×</button>
      </header>

      <div className="tree-scroll">
        {results.map((r) => (
          <section key={r.path} className="hit-file">
            <div className="hit-path mono" title={r.path}>{r.path}</div>
            {r.hits.map((h, i) => (
              <button
                key={i}
                className="hit"
                onClick={() => onOpen(r.path, h.line)}
                title={`line ${h.line}`}
              >
                <span className="hit-line">{h.line}</span>
                <span className="hit-text mono">
                  {h.text.before}
                  <mark>{h.text.match}</mark>
                  {h.text.after}
                </span>
              </button>
            ))}
          </section>
        ))}

        {!busy && query.trim().length >= 2 && !results.length && (
          <p className="dim empty">No matches.</p>
        )}
        {query.trim().length < 2 && (
          <p className="dim empty">Type at least two characters.</p>
        )}
      </div>

      <footer className="tree-foot dim">
        {busy && 'Searching…'}
        {!busy && stats && `${stats.matches} matches in ${stats.files} files${stats.truncated ? ' (truncated)' : ''}`}
      </footer>
    </aside>
  );
}
