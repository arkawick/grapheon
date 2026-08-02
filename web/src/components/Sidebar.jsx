import { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useGraph } from '../GraphContext.js';
import { filesFromFileList, repoNameFromFileList } from '../lib/corpus.js';

const NAV = [
  { to: '/', label: 'Atlas', hint: 'the map' },
  { to: '/blast', label: 'Blast Radius', hint: 'what breaks if this changes' },
];

export default function Sidebar() {
  const { layout, corpusName, extractRepo, busy } = useGraph();
  const pickerRef = useRef(null);

  const onPick = async (e) => {
    const fileList = e.target.files;
    if (!fileList?.length) return;
    const name = repoNameFromFileList(fileList);
    const files = await filesFromFileList(fileList);
    e.target.value = ''; // allow re-picking the same folder
    extractRepo(files, name);
  };

  return (
    <nav className="sidebar">
      <div className="brand">
        Grapheon
        {corpusName && <span className="corpus">{corpusName}</span>}
      </div>

      <ul className="nav">
        {NAV.map((n) => (
          <li key={n.to}>
            <NavLink to={n.to} end={n.to === '/'}>
              <span className="nav-label">{n.label}</span>
              <span className="nav-hint">{n.hint}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="open-repo">
        <button disabled={!!busy} onClick={() => pickerRef.current?.click()}>
          {busy ? 'Extracting…' : 'Open a repo…'}
        </button>
        <div className="nav-hint">
          Parsed in your browser. Nothing is uploaded anywhere.
        </div>
        {/*
          webkitdirectory is non-standard but universal in practice; it is the
          only folder picker that works without a backend. File System Access
          API would be nicer but is Chromium-only.
        */}
        <input
          ref={pickerRef}
          type="file"
          webkitdirectory=""
          multiple
          style={{ display: 'none' }}
          onChange={onPick}
        />
      </div>

      {layout && (
        <div className="sidebar-foot">
          <div>{layout.nodes.length.toLocaleString()} nodes</div>
          <div>{layout.communities.length} subsystems</div>
          <div className="dim">via {layout.meta.source}</div>
        </div>
      )}
    </nav>
  );
}
