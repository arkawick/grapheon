/**
 * Build a directory tree from a flat path list.
 *
 * Collapses single-child directory chains ("aeon/backend/api" as one row
 * rather than three) — the same thing VS Code and GitHub do, because an
 * unfolded tree of a Python project is mostly indentation.
 */
export function buildTree(paths) {
  const root = { name: '', path: '', dir: true, children: new Map() };

  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          dir: !last,
          children: new Map(),
        });
      }
      node = node.children.get(part);
    });
  }

  const toArray = (node) => {
    const kids = [...node.children.values()].map(toArray);
    // Directories first, then alphabetical — the ordering every file browser
    // uses, because "where are the folders" is the first question.
    kids.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ...node, children: kids };
  };

  const collapse = (node) => {
    let n = { ...node, children: node.children.map(collapse) };
    while (n.dir && n.children.length === 1 && n.children[0].dir) {
      const only = n.children[0];
      n = { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };

  return collapse(toArray(root)).children;
}

/** Directories that must be open for `path` to be visible. */
export function ancestorsOf(path) {
  const parts = path.split('/');
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}
