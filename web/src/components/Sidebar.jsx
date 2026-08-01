import { NavLink } from 'react-router-dom';
import { useGraph } from '../GraphContext.js';

const NAV = [
  { to: '/', label: 'Atlas', hint: 'the map' },
  { to: '/blast', label: 'Blast Radius', hint: 'what breaks if this changes' },
];

export default function Sidebar() {
  const { layout } = useGraph();

  return (
    <nav className="sidebar">
      <div className="brand">
        Grapheon
        {layout && <span className="corpus">{layout.meta.name}</span>}
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
