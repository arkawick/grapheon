import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);

import { lineOf } from './lib/sources.js';

// Everything else renders as plain text — readable, just uncoloured. Adding
// languages means importing more hljs grammars, which is a size decision, not
// a correctness one.
const LANG_BY_EXT = {
  '.py': 'python',
  '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json',
};

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

/**
 * @param {{path: string, title?: string, line?: number|null, hue?: number|null}} file
 *   A file to display. `line` and `hue` come from the graph when a node was
 *   selected, and are simply absent when the file was opened from the tree —
 *   plain files (README, compose.yml) have no entity to jump to, and that is
 *   a normal case rather than a degraded one.
 */
export default function CodePane({
  file, sources, onClose, related = [], width,
  tabs = [], onSelectTab, onCloseTab,
}) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  // Wrapping defaults ON for narrow screens: a phone shows ~45 columns, and
  // this file needs 706px of horizontal scroll to read one line otherwise.
  const [wrap, setWrap] = useState(() => window.innerWidth <= 720);
  const scrollRef = useRef(null);
  const path = file?.path ?? null;
  const line = file?.line ?? null;

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

  if (!file) return null;

  return (
    <section className="code-pane" style={width ? { width } : undefined}>
      {/* Tabs only appear once more than one file is open — a single tab is
          noise above a header that already names the file. */}
      {tabs.length > 1 && (
        <div className="tabs" role="tablist">
          {tabs.map((t) => {
            const name = t.path.slice(t.path.lastIndexOf('/') + 1);
            const active = t.path === file.path;
            return (
              <div key={t.path} className={`tab${active ? ' active' : ''}`}>
                <button
                  className="tab-label"
                  role="tab"
                  aria-selected={active}
                  title={t.path}
                  onClick={() => onSelectTab?.(t.path)}
                >
                  {name}
                </button>
                <button
                  className="tab-close"
                  aria-label={`Close ${name}`}
                  onClick={() => onCloseTab?.(t.path)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <header className="code-head">
        <div className="code-title">
          <span
            className={`dot${file.hue == null ? ' unmapped' : ''}`}
            style={file.hue != null ? { background: `hsl(${file.hue} 68% 62%)` } : undefined}
          />
          <strong>{file.title ?? path.slice(path.lastIndexOf('/') + 1)}</strong>
          {path && <span className="mono dim">{path}{line ? `:${line}` : ''}</span>}
        </div>
        <button
          className={`wrap-toggle${wrap ? ' on' : ''}`}
          onClick={() => setWrap((w) => !w)}
          title={wrap ? 'Disable word wrap' : 'Enable word wrap'}
        >
          wrap
        </button>
        <button className="close" onClick={onClose} aria-label="Close code">×</button>
      </header>

      {path && !text && !error && <p className="dim empty">Loading source…</p>}
      {error && <p className="dim empty">{error}</p>}

      {lines && (
        <div className="code-scroll" ref={scrollRef}>
          <pre className={`code${wrap ? ' wrap' : ''}`}>
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
