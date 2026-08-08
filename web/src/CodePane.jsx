import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import 'highlight.js/styles/github-dark.css';
import { lineOf } from './lib/sources.js';

hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);

const LANG_BY_EXT = { '.py': 'python', '.js': 'javascript', '.jsx': 'javascript' };

/**
 * Highlight the whole file, then split into lines.
 *
 * Splitting AFTER highlighting is what makes this correct: a docstring or
 * template literal spans lines, so highlighting line-by-line would restart the
 * lexer mid-string and mis-colour everything below it. The cost is that hljs's
 * open spans get cut at the line boundaries, so we re-open them per line —
 * standard technique, and the reason this isn't just `.split('\n')`.
 */
function highlightLines(text, language) {
  let html;
  try {
    html = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
  } catch {
    html = escapeHtml(text);
  }
  const lines = html.split('\n');
  const out = [];
  let open = [];
  for (const line of lines) {
    const prefix = open.map((c) => `<span class="${c}">`).join('');
    out.push(prefix + line + '</span>'.repeat(open.length));
    open = trackOpenSpans(line, open);
  }
  return out;
}

/** Track which hljs classes are still open at the end of a line. */
function trackOpenSpans(line, open) {
  const stack = [...open];
  const re = /<span class="([^"]*)">|<\/span>/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) stack.push(m[1]);
    else stack.pop();
  }
  return stack;
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

export default function CodePane({ node, sources, onClose, related = [] }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const path = node?.a?.path ?? null;
  const line = lineOf(node?.a?.loc);

  useEffect(() => {
    if (!path || !sources) { setText(null); return; }
    let stale = false;
    setError(null);
    setText(null);
    sources.get(path).then((t) => {
      if (stale) return;
      if (t == null) setError(`No source captured for ${path}`);
      else setText(t);
    }).catch((e) => { if (!stale) setError(String(e.message ?? e)); });
    return () => { stale = true; };
  }, [path, sources]);

  const lines = useMemo(() => {
    if (text == null) return null;
    const ext = path.slice(path.lastIndexOf('.'));
    return highlightLines(text, LANG_BY_EXT[ext]);
  }, [text, path]);

  // Lines that other entities in this same file start on — the graph knows
  // where its neighbours live, so the gutter can point at them.
  const marks = useMemo(() => {
    const m = new Map();
    for (const r of related) {
      if (r.path !== path) continue;
      const l = lineOf(r.loc);
      if (l) m.set(l, r);
    }
    return m;
  }, [related, path]);

  // Scroll the target line to about a third down — centred hides the context
  // above, which is usually the signature and docstring you want.
  useEffect(() => {
    if (!lines || !line || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-line="${line}"]`);
    if (el) {
      const box = scrollRef.current;
      box.scrollTop = el.offsetTop - box.clientHeight / 3;
    }
  }, [lines, line]);

  if (!node) return null;

  return (
    <section className="code-pane">
      <header className="code-head">
        <div className="code-title">
          <span className="dot" style={{ background: `hsl(${node.h} 68% 62%)` }} />
          <strong>{node.l}</strong>
          {path && <span className="mono dim">{path}{line ? `:${line}` : ''}</span>}
        </div>
        <button className="close" onClick={onClose} aria-label="Close code">×</button>
      </header>

      {!path && <p className="dim empty">This node has no file — it's an external module.</p>}
      {path && !text && !error && <p className="dim empty">Loading source…</p>}
      {error && <p className="dim empty">{error}</p>}

      {lines && (
        <div className="code-scroll" ref={scrollRef}>
          <pre className="code">
            {lines.map((html, i) => {
              const n = i + 1;
              const mark = marks.get(n);
              return (
                <div
                  key={n}
                  data-line={n}
                  className={`code-line${n === line ? ' target' : ''}${mark ? ' marked' : ''}`}
                  title={mark ? `${mark.rel.replace(/_/g, ' ')} → ${mark.label}` : undefined}
                >
                  <span className="ln">{n}</span>
                  <code dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </section>
  );
}
