import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGraph } from '../GraphContext.js';
import { rankPalette, flatten } from '../lib/palette.js';

/**
 * Cmd/Ctrl+K — one box for everything.
 *
 * The app grew five pages, a file tree, a code viewer and two search boxes,
 * and every one of them is a different place to type a name into. This is the
 * one that does not care what kind of thing you are after: entities, files and
 * commands are ranked together and the sections sort by what actually matched.
 *
 * Ranking lives in lib/palette.js so it can be tested; this file is keyboard
 * handling and markup.
 */
export default function Palette({ open, onClose }) {
  const {
    layout, sources, focus, openFile, recent,
    setTreeOpen, setSearchOpen, setCodeOpen, setSelected, narrow,
  } = useGraph();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  // A fresh palette every time. Reopening onto a stale query is a small thing
  // that makes the shortcut feel unreliable.
  useEffect(() => {
    if (open) { setQuery(''); setActive(0); }
  }, [open]);

  const commands = useMemo(() => {
    const go = (to) => () => { navigate(to); };
    // `keywords` is the term someone would actually type. Without it "blast
    // radius" scores as a mid-string hit inside "Go to Blast Radius" and loses
    // to any document heading that happens to say the same words.
    const list = [
      { id: 'atlas', label: 'Go to Atlas', keywords: 'atlas map', hint: 'the map', run: go('/') },
      { id: 'insights', label: 'Go to Insights', keywords: 'insights', hint: 'what the graph noticed', run: go('/insights') },
      { id: 'blast', label: 'Go to Blast Radius', keywords: 'blast radius', hint: 'what breaks if this changes', run: go('/blast') },
      { id: 'knowledge', label: 'Go to Knowledge', keywords: 'knowledge docs', hint: 'ask your documents', run: go('/knowledge') },
      { id: 'history', label: 'Go to History', keywords: 'history', hint: 'switch corpus without re-parsing', run: go('/history') },
    ];
    if (sources) {
      list.push(
        { id: 'files', label: 'Toggle file tree', keywords: 'files tree explorer', hint: 'browse the repo', run: () => setTreeOpen((o) => !o) },
        { id: 'search', label: 'Search in files', keywords: 'search grep find', hint: 'text across every file', run: () => setSearchOpen(true) },
      );
    }
    list.push({
      id: 'clear',
      label: 'Clear selection',
      keywords: 'clear deselect reset',
      hint: 'un-dim the map and close the code pane',
      run: () => { setSelected(null); setCodeOpen(false); },
    });
    return list;
  }, [navigate, sources, setTreeOpen, setSearchOpen, setSelected, setCodeOpen]);

  const sections = useMemo(() => rankPalette({
    query,
    nodes: layout?.nodes ?? [],
    paths: sources?.paths ?? [],
    commands,
    recent,
  }), [query, layout, sources, commands, recent]);

  const items = useMemo(() => flatten(sections), [sections]);

  // The active row can outrun a shrinking result list as the query narrows.
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, items.length - 1))); }, [items.length]);

  const run = (item) => {
    if (!item) return;
    onClose();
    if (item.type === 'command') item.run();
    else if (item.type === 'file') openFile(item.path, item.line);
    else if (item.type === 'node') focus(item.node);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Keep the active row visible when the keyboard, not the mouse, is driving.
  useEffect(() => {
    listRef.current?.querySelector('.pal-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  let index = -1;
  return (
    <div className="pal-scrim" onMouseDown={onClose}>
      <div
        className={`palette${narrow ? ' narrow' : ''}`}
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="pal-input"
          value={query}
          placeholder="Search entities, files and commands…"
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
        />
        <div className="pal-list" ref={listRef}>
          {sections.map((s) => (
            <section key={s.group}>
              <h4>{s.group}</h4>
              {s.items.map((item) => {
                index += 1;
                const i = index;
                return (
                  <button
                    key={item.id}
                    className={`pal-row${i === active ? ' active' : ''}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(item)}
                  >
                    <span
                      className={`pal-dot ${item.type}`}
                      style={item.hue != null ? { background: `hsl(${item.hue} 68% 62%)` } : undefined}
                    />
                    <span className="pal-label">{item.label}</span>
                    {item.sub && <span className="pal-sub mono dim">{item.sub}</span>}
                  </button>
                );
              })}
            </section>
          ))}
          {!items.length && <p className="dim empty">Nothing matches.</p>}
        </div>
        <footer className="pal-foot dim">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}
