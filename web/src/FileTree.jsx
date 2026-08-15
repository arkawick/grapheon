import { useEffect, useMemo, useState } from 'react';
import { buildTree, ancestorsOf } from './lib/filetree.js';

/**
 * The repo as a tree, not as a graph.
 *
 * Every readable file appears here, including the ones the extractor never
 * parsed — README, package.json, the compose file. A file that DID become a
 * graph node carries a dot in its community's colour, so the tree and the map
 * are visibly the same repository seen two ways.
 */
function Row({ node, depth, openDirs, toggle, onPick, current, nodeByPath }) {
  const isOpen = openDirs.has(node.path);
  const pad = { paddingLeft: 6 + depth * 11 };

  if (node.dir) {
    return (
      <>
        <button className="tree-row dir" style={pad} onClick={() => toggle(node.path)}>
          <span className="caret">{isOpen ? '▾' : '▸'}</span>
          <span className="label">{node.name}</span>
        </button>
        {isOpen && node.children.map((c) => (
          <Row
            key={c.path} node={c} depth={depth + 1}
            openDirs={openDirs} toggle={toggle} onPick={onPick}
            current={current} nodeByPath={nodeByPath}
          />
        ))}
      </>
    );
  }

  const mapped = nodeByPath.get(node.path);
  return (
    <button
      className={`tree-row file${current === node.path ? ' current' : ''}`}
      style={pad}
      onClick={() => onPick(node.path)}
      title={node.path}
    >
      <span
        className={`tree-dot${mapped ? '' : ' unmapped'}`}
        style={mapped ? { background: `hsl(${mapped.h} 68% 62%)` } : undefined}
        title={mapped ? 'on the map' : 'not in the graph'}
      />
      <span className="label">{node.name}</span>
    </button>
  );
}

export default function FileTree({ paths, nodeByPath, current, onPick, onClose, width, recent = [] }) {
  const [filter, setFilter] = useState('');
  const [openDirs, setOpenDirs] = useState(() => new Set());

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? paths.filter((p) => p.toLowerCase().includes(q)) : paths;
  }, [paths, filter]);

  const tree = useMemo(() => buildTree(shown), [shown]);

  // Filtering is useless if the matches stay collapsed, so a filtered tree is
  // fully expanded; the unfiltered one opens only the top level.
  useEffect(() => {
    if (filter.trim()) {
      const all = new Set();
      for (const p of shown) for (const a of ancestorsOf(p)) all.add(a);
      setOpenDirs(all);
    } else {
      setOpenDirs(new Set(tree.filter((n) => n.dir).map((n) => n.path)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, paths]);

  // Reveal whatever the map selected, so tree and map never disagree.
  useEffect(() => {
    if (!current) return;
    setOpenDirs((prev) => {
      const next = new Set(prev);
      for (const a of ancestorsOf(current)) next.add(a);
      return next;
    });
  }, [current]);

  const toggle = (path) => setOpenDirs((prev) => {
    const next = new Set(prev);
    next.has(path) ? next.delete(path) : next.add(path);
    return next;
  });

  return (
    <aside className="filetree" style={width ? { width } : undefined}>
      <header className="tree-head">
        <input
          value={filter}
          placeholder="Filter files…"
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="close" onClick={onClose} aria-label="Close files">×</button>
      </header>
      <div className="tree-scroll">
        {/* Only when unfiltered: a filter is an explicit question, and answering
            it with files you happened to open earlier is noise. */}
        {!filter.trim() && recent.length > 0 && (
          <section className="tree-recent">
            <h4>Recent</h4>
            {recent.slice(0, 5).map((r) => {
              const mapped = nodeByPath.get(r.path);
              return (
                <button
                  key={r.path}
                  className={`tree-row file${current === r.path ? ' current' : ''}`}
                  style={{ paddingLeft: 6 }}
                  onClick={() => onPick(r.path, r.line)}
                  title={r.path}
                >
                  <span
                    className={`tree-dot${mapped ? '' : ' unmapped'}`}
                    style={mapped ? { background: `hsl(${mapped.h} 68% 62%)` } : undefined}
                  />
                  <span className="label">{r.path.slice(r.path.lastIndexOf('/') + 1)}</span>
                </button>
              );
            })}
          </section>
        )}
        {tree.map((n) => (
          <Row
            key={n.path} node={n} depth={0}
            openDirs={openDirs} toggle={toggle} onPick={onPick}
            current={current} nodeByPath={nodeByPath}
          />
        ))}
        {!shown.length && <p className="dim empty">No files match.</p>}
      </div>
      <footer className="tree-foot dim">
        {shown.length} of {paths.length} files
      </footer>
    </aside>
  );
}
