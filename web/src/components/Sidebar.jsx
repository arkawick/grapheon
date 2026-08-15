import { useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useGraph } from '../GraphContext.js';
import Logo from './Logo.jsx';
import {
  filesFromFileList, repoNameFromFileList,
  filesFromZip, repoNameFromZip, documentsFromFileList,
} from '../lib/corpus.js';

// Android WebViews (and mobile browsers generally) have no directory picker —
// webkitdirectory silently opens a FILE picker instead. On touch devices the
// zip path is the only one that works, so it leads.
const HAS_DIR_PICKER = !('ontouchstart' in window) || navigator.maxTouchPoints === 0;

// Only for the label on the shortcut hint — the handler accepts both.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const NAV = [
  { to: '/', label: 'Atlas', hint: 'the map' },
  { to: '/insights', label: 'Insights', hint: 'what the graph noticed' },
  { to: '/blast', label: 'Blast Radius', hint: 'what breaks if this changes' },
  { to: '/knowledge', label: 'Knowledge', hint: 'ask your documents' },
  { to: '/history', label: 'History', hint: 'switch back without re-parsing' },
];

export default function Sidebar() {
  const {
    layout, corpusName, extractRepo, busy, sources,
    treeOpen, setTreeOpen, searchOpen, setSearchOpen,
    menuOpen, setMenuOpen, narrow, ingestDocuments, openPalette,
  } = useGraph();
  const pickerRef = useRef(null);
  const zipRef = useRef(null);
  const docsRef = useRef(null);
  const { pathname } = useLocation();

  const close = () => setMenuOpen(false);

  const onPick = async (e) => {
    const fileList = e.target.files;
    if (!fileList?.length) return;
    const name = repoNameFromFileList(fileList);
    const picked = await filesFromFileList(fileList);
    e.target.value = ''; // allow re-picking the same folder
    close();
    extractRepo(picked, name);
  };

  const onZip = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    close();
    extractRepo(await filesFromZip(file), repoNameFromZip(file));
  };

  const onDocs = async (e) => {
    const fileList = e.target.files;
    if (!fileList?.length) return;
    const first = fileList[0].webkitRelativePath || fileList[0].name;
    const name = first.includes('/') ? first.split('/')[0] : 'documents';
    const docs = await documentsFromFileList(fileList);
    e.target.value = '';
    close();
    ingestDocuments(docs, name);
  };

  // On a phone the bar collapses to a menu button; everything below lives in
  // the drawer. Cramming nav + Files + Search + two upload buttons into one
  // 390px row put the upload entirely off-screen.
  const current = NAV.find((n) => n.to === pathname) ?? NAV[0];

  return (
    <>
      {narrow && (
        <header className="topbar-compact">
          <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <span className="menu-icon" aria-hidden="true"><i /><i /><i /></span>
            <Logo height={18} />
          </button>
          <span className="current-page">{current.label}</span>
          {corpusName && <span className="corpus">{corpusName}</span>}
        </header>
      )}

      {narrow && menuOpen && <div className="scrim" onClick={close} />}

      <nav className={`sidebar${narrow ? ' drawer' : ''}${menuOpen ? ' open' : ''}`}>
        <div className="brand">
          <Logo height={22} />
          {corpusName && <span className="corpus">{corpusName}</span>}
          {narrow && (
            <button className="close drawer-close" onClick={close} aria-label="Close menu">×</button>
          )}
        </div>

        {/* The shortcut is the fast path, but a shortcut nobody is told about
            does not exist — and a phone has no Cmd key at all. */}
        <button
          className="palette-open"
          onClick={() => { openPalette(); close(); }}
        >
          <span>Search everything</span>
          <kbd>{IS_MAC ? '⌘' : 'Ctrl'} K</kbd>
        </button>

        <ul className="nav">
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.to === '/'} onClick={close}>
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
              onClick={() => { setTreeOpen((o) => !o); close(); }}
            >
              Files <span className="dim">{sources.count}</span>
            </button>
            <button
              className={`files-toggle${searchOpen ? ' on' : ''}`}
              onClick={() => { setSearchOpen((o) => !o); close(); }}
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
          <button className="alt" disabled={!!busy} onClick={() => docsRef.current?.click()}>
            Open documents…
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
          {/* Multiple files rather than a directory: a knowledge base is
              usually a handful of specs you choose, not a whole tree — and
              this is the one picker that works on a phone. */}
          <input
            ref={docsRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,.rst,.text,.pdf"
            style={{ display: 'none' }}
            onChange={onDocs}
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
    </>
  );
}
