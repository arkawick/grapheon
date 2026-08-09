import { useMemo, useState } from 'react';
import { useGraph } from '../GraphContext.js';
import { search } from '../lib/knowledge/bm25.js';

/**
 * Ask the knowledge base a question, get the passages that answer it.
 *
 * Passages, not prose. Generating an answer needs a model; ranking the
 * evidence does not — and for a base you are trying to trust, being shown the
 * source beats being told a summary you then have to go and verify.
 */
export default function KnowledgePage() {
  const { knowledge, nodeById, focus, openFile, layout } = useGraph();
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    if (!knowledge?.index || query.trim().length < 2) return [];
    return search(knowledge.index, query.trim(), 25);
  }, [knowledge, query]);

  if (!knowledge) {
    return (
      <aside className="panel knowledge">
        <h1>Knowledge</h1>
        <p className="dim">
          Load documents from the menu — <strong>Open documents…</strong> takes
          <code> .md</code>, <code>.txt</code> and <code>.rst</code> files.
        </p>
      </aside>
    );
  }

  /** Jump to the section on the map and open the document at that line. */
  const go = (passage) => {
    const node = nodeById.get(passage.sectionId);
    if (node) focus(node);
    const path = passage.sectionId.split('#')[0];
    openFile(path, passage.line);
  };

  return (
    <aside className="panel knowledge">
      <h1>Knowledge</h1>
      <p className="dim question">
        {knowledge.stats.documents} documents · {knowledge.stats.passages} passages
      </p>

      <input
        className="kb-query"
        autoFocus
        value={query}
        placeholder="Ask a question…"
        onChange={(e) => setQuery(e.target.value)}
      />

      {query.trim().length >= 2 && !results.length && (
        <p className="dim empty">Nothing matches. Try different words.</p>
      )}
      {query.trim().length < 2 && (
        <p className="dim empty">
          Ranked by BM25 over every passage. Matching terms are highlighted;
          click a result to open its source.
        </p>
      )}

      {results.map((r, i) => (
        <article key={r.passage.id} className="kb-hit" onClick={() => go(r.passage)}>
          <header>
            <span className="kb-rank">{i + 1}</span>
            <span className="kb-heading">{r.passage.heading || 'untitled section'}</span>
          </header>
          <div className="kb-source mono dim">
            {r.passage.sectionId.split('#')[0]}:{r.passage.line}
          </div>
          <p className="kb-text">{highlight(r.passage.text, r.terms)}</p>
        </article>
      ))}

      {layout && !results.length && query.trim().length < 2 && (
        <p className="dim empty">
          The map shows the same documents: headings as nodes, clustered by
          shared vocabulary.
        </p>
      )}
    </aside>
  );
}

/** Wrap matched terms in <mark>, longest first so substrings don't win. */
function highlight(text, terms) {
  const snippet = text.length > 420 ? `${text.slice(0, 420)}…` : text;
  if (!terms.length) return snippet;
  const escaped = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(${escaped.join('|')})`, 'gi');
  const parts = snippet.split(re);
  return parts.map((p, i) =>
    re.test(p) && i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>
  );
}
