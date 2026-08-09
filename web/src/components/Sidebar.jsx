import { useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useGraph } from '../GraphContext.js';
import {
  filesFromFileList, repoNameFromFileList,
  filesFromZip, repoNameFromZip,
} from '../lib/corpus.js';

// Android WebViews (and mobile browsers generally) have no directory picker —
// webkitdirectory silently opens a FILE picker instead. On touch devices the
// zip path is the only one that works, so it leads.
const HAS_DIR_PICKER = !('ontouchstart' in window) || navigator.maxTouchPoints === 0;

const NAV = [
  { to: '/', label: 'Atlas', hint: 'the map' },
  { to: '/blast', label: 'Blast Radius', hint: 'what breaks if this changes' },
];

export default function Sidebar() {
  const {
    layout, corpusName, extractRepo, busy, sources,
    treeOpen, setTreeOpen, searchOpen, setSearchOpen,
  } = useGraph();
  const pickerRef = useRef(null);
  const zipRef = useRef(null);

  const onPick = async (e) => {
    const fileList = e.target.files;
    if (!fileList?.length) return;
    const name = repoNameFromFileList(fileList);
    const files = await filesFromFileList(fileList);
    e.target.value = ''; // allow re-picking the same folder
    extractRepo(files, name);
  };

  const onZip = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    extractRepo(await filesFromZip(file), repoNameFromZip(file));
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

      {sources && (
        <div className="explore-toggles">
          <button
            className={`files-toggle${treeOpen ? ' on' : ''}`}
            onClick={() => setTreeOpen((o) => !o)}
          >
            Files <span className="dim">{sources.count}</span>
          </button>
          <button
            className={`files-toggle${searchOpen ? ' on' : ''}`}
            onClick={() => setSearchOpen((o) => !o)}
            title="Search across file contents"
          >
            Search
          </button>
        </div>
      )}

      <div className="open-repo">
        {HAS_DIR_PICKER && (
          <button disabled={!!busy} onClick={() => pickerRef.current?.click()}>
            {busy ? 'Extracting…' : 'Open a repo…'}
          </button>
        )}
        <button className="alt" disabled={!!busy} onClick={() => zipRef.current?.click()}>
          {busy && !HAS_DIR_PICKER ? 'Extracting…' : 'Open a repo .zip…'}
        </button>
        <div className="nav-hint">
          Parsed on this device. Nothing is uploaded anywhere.
          {!HAS_DIR_PICKER && ' Tip: GitHub → Code → Download ZIP.'}
        </div>
        {/*
          webkitdirectory is non-standard but universal on desktop; it is the
          only folder picker that works without a backend. File System Access
          API would be nicer but is Chromium-only. Neither exists on mobile,
          hence the zip input.
        */}
        <input
          ref={pickerRef}
          type="file"
          webkitdirectory=""
          multiple
          style={{ display: 'none' }}
          onChange={onPick}
        />
        <input
          ref={zipRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={onZip}
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
