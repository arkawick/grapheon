/**
 * The map as a self-contained, interactive HTML file.
 *
 * A PNG of a graph is close to worthless: the whole value of the map is that
 * you can move around it, and a picture of 1,000 dots is a picture of 1,000
 * dots. This produces one file you can email, commit, or open on a machine
 * that has never heard of this app — pan, zoom, search, click, offline, no
 * network, no dependencies.
 *
 * The renderer here is a plain 2D canvas rather than the app's PixiJS one.
 * Inlining Pixi would add ~470 KB to every exported file to redraw circles
 * whose positions are already computed; a few hundred lines of canvas does the
 * same job and keeps the export roughly the size of its own data.
 */

// Embedding every edge of a huge graph would dwarf the positions, and the app
// itself refuses to draw that many. Same threshold, same reasoning.
const MAX_EMBEDDED_EDGES = 20000;

/**
 * `</script>` inside embedded JSON would end the block whatever the JSON says,
 * so `<` is escaped. U+2028 and U+2029 are written as ESCAPE SEQUENCES here and
 * never as literals: those characters are line terminators in JavaScript
 * source, so a literal one inside a regex breaks the regex itself.
 */
const safeJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) =>
      (c === '\u2028' ? '\\u2028' : '\\u2029'));

export function mapHtml({ name, layout, edges, source }) {
  // Slim the payload: the export needs to draw and identify, nothing else.
  const nodes = layout.nodes.map((n) => ({
    i: n.id, l: n.l, k: n.k, c: n.c, h: n.h,
    r: n.r, x: n.x, y: n.y, p: n.a?.path ?? null,
  }));
  const useEdges = Array.isArray(edges) && edges.length <= MAX_EMBEDDED_EDGES;
  const links = useEdges ? edges.map(([s, t]) => [s, t]) : [];

  const data = {
    name,
    source: source ?? 'grapheon',
    generated: new Date().toISOString().slice(0, 10),
    bounds: layout.bounds,
    // Only the largest are named — the tail is single-digit clusters that would
    // turn the legend into a scrollbar. The total is kept honest separately.
    communities: (layout.communities ?? []).slice(0, 24),
    communityTotal: (layout.communities ?? []).length,
    nodes,
    links,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)} — code map</title>
<style>
  :root { --bg:#0a0a0f; --panel:rgba(18,18,26,.94); --border:rgba(255,255,255,.09);
          --text:#e8e8f0; --dim:#8b8b9e; --accent:#7dd3fc; color-scheme:dark; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--text);
    font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; overflow:hidden; }
  canvas { display:block; width:100%; height:100%; touch-action:none; cursor:grab; }
  canvas.drag { cursor:grabbing; }
  .bar { position:absolute; top:0; left:0; right:0; display:flex; align-items:center;
    gap:12px; padding:12px 16px; pointer-events:none; }
  .bar > * { pointer-events:auto; }
  .title { font-weight:600; white-space:nowrap; }
  .title span { font-weight:400; color:var(--dim); font-size:11px;
    border:1px solid var(--border); border-radius:999px; padding:1px 8px; margin-left:8px; }
  input { flex:1; max-width:340px; padding:7px 12px; background:var(--panel); color:var(--text);
    border:1px solid var(--border); border-radius:8px; outline:none; font:inherit; }
  input:focus { border-color:var(--accent); }
  .side { position:absolute; right:16px; top:56px; width:250px; max-height:calc(100% - 90px);
    overflow:auto; padding:12px; background:var(--panel); border:1px solid var(--border);
    border-radius:10px; }
  .side h2 { margin:0 0 2px; font-size:14px; word-break:break-word; }
  .side .path { font:11px ui-monospace,monospace; color:var(--dim); word-break:break-all; }
  .side h3 { margin:14px 0 6px; font-size:10px; text-transform:uppercase;
    letter-spacing:.08em; color:var(--dim); }
  .row { display:flex; align-items:center; gap:8px; padding:2px 0; font-size:12px; }
  .dot { width:9px; height:9px; border-radius:50%; flex-shrink:0; }
  .row span:nth-child(2) { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .n { color:var(--dim); font-size:11px; }
  .hits { position:absolute; left:16px; top:52px; width:280px; max-height:50%; overflow:auto;
    background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:4px; }
  .hits button { display:flex; gap:8px; width:100%; padding:5px 8px; background:none; border:0;
    border-radius:6px; color:var(--text); font:inherit; font-size:12px; text-align:left; cursor:pointer; }
  .hits button:hover { background:rgba(255,255,255,.07); }
  .legend summary { cursor:pointer; font-size:10px; text-transform:uppercase;
    letter-spacing:.08em; color:var(--dim); list-style:none; }
  .legend summary::-webkit-details-marker { display:none; }
  .legend summary::after { content:' −'; }
  .legend:not([open]) summary::after { content:' +'; }
  .legend:not([open]) { width:auto; }
  .legend #legend-body { margin-top:8px; }
  .legend .row { cursor:pointer; border-radius:4px; padding:2px 4px; }
  .legend .row:hover { background:rgba(255,255,255,.07); }
  .legend .row.off span:nth-child(2) { color:var(--dim); text-decoration:line-through; }
  .foot { position:absolute; left:16px; bottom:12px; font-size:11px; color:var(--dim); }
  .close { position:absolute; top:6px; right:8px; background:none; border:0; color:var(--dim);
    font-size:18px; line-height:1; cursor:pointer; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div class="bar">
  <div class="title">${escapeHtml(name)}<span id="count"></span></div>
  <input id="q" placeholder="Search…" autocomplete="off">
</div>
<div id="hits" class="hits" hidden></div>
<details id="legend" class="side legend" open>
  <summary>Subsystems</summary>
  <div id="legend-body"></div>
</details>
<div id="side" class="side" hidden></div>
<div class="foot" id="foot"></div>
<script id="data" type="application/json">${safeJson(data)}</script>
<script>
(function () {
  const D = JSON.parse(document.getElementById('data').textContent);
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');
  const byId = new Map(D.nodes.map(n => [n.i, n]));

  // Adjacency, built once, so clicking a node can show what touches it.
  const adj = new Map();
  for (const [s, t] of D.links) {
    if (!adj.has(s)) adj.set(s, []);
    if (!adj.has(t)) adj.set(t, []);
    adj.get(s).push(t); adj.get(t).push(s);
  }

  let scale = 1, ox = 0, oy = 0, dpr = 1, sel = null, hi = null;

  function fit() {
    dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr;
    cv.height = cv.clientHeight * dpr;
    const s = Math.min(cv.clientWidth / D.bounds.width, cv.clientHeight / D.bounds.height) * 0.92;
    scale = s;
    ox = (cv.clientWidth - D.bounds.width * s) / 2;
    oy = (cv.clientHeight - D.bounds.height * s) / 2;
    draw();
  }

  const hsl = h => 'hsl(' + h + ' 68% 62%)';

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    if (D.links.length) {
      ctx.lineWidth = 0.7 / scale;
      ctx.strokeStyle = 'rgba(139,139,158,.18)';
      ctx.beginPath();
      for (const [s, t] of D.links) {
        const a = byId.get(s), b = byId.get(t);
        if (!a || !b) continue;
        if (hi && !(hi.has(s) && hi.has(t))) continue;
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }

    // Nodes are drawn largest-first so small ones stay visible on top, and
    // clamped to a minimum on-screen radius — at overview zoom a radius-3 dot
    // is sub-pixel and the whole map reads as dust.
    const minR = 1.6 / scale;
    for (const n of D.nodes) {
      const dim = hi && !hi.has(n.i);
      ctx.globalAlpha = dim ? 0.07 : 0.92;
      ctx.fillStyle = hsl(n.h);
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(n.r, minR), 0, 6.284);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (sel) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 / scale;
      ctx.beginPath();
      ctx.arc(sel.x, sel.y, Math.max(sel.r, minR) + 4 / scale, 0, 6.284);
      ctx.stroke();
    }
    ctx.restore();
  }

  function at(px, py) {
    const x = (px - ox) / scale, y = (py - oy) / scale;
    let best = null, bd = Infinity;
    for (const n of D.nodes) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      const hit = Math.max(n.r, 12 / scale) ** 2;
      if (d < hit && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  const side = document.getElementById('side');
  const legend = document.getElementById('legend');
  function select(n) {
    sel = n;
    // The legend and the detail panel want the same corner; the detail panel
    // wins while something is selected.
    legend.hidden = !!n;
    if (!n) { side.hidden = true; hi = iso == null ? null : isoSet(iso); draw(); return; }
    iso = null;
    paintLegend();
    const near = (adj.get(n.i) || []);
    hi = new Set([n.i, ...near]);
    side.hidden = false;
    side.innerHTML =
      '<button class="close" aria-label="Close">&times;</button>' +
      '<h2>' + esc(n.l) + '</h2>' +
      (n.p ? '<div class="path">' + esc(n.p) + '</div>' : '') +
      '<h3>Kind</h3><div class="row"><span class="dot" style="background:' + hsl(n.h) + '"></span><span>' + esc(n.k) + '</span></div>' +
      '<h3>Connections ' + near.length + '</h3>' +
      near.slice(0, 40).map(function (id) {
        const m = byId.get(id);
        return m ? '<div class="row"><span class="dot" style="background:' + hsl(m.h) + '"></span><span>' + esc(m.l) + '</span></div>' : '';
      }).join('');
    side.querySelector('.close').onclick = function () { select(null); };
    draw();
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // --- legend
  // Colour without a key is decoration. Clicking a subsystem isolates it, which
  // is the one question a coloured map invites: "what is all the purple?"
  let iso = null;
  const isoSet = (id) => new Set(D.nodes.filter(n => n.c === id).map(n => n.i));
  const legendBody = document.getElementById('legend-body');

  function paintLegend() {
    legendBody.innerHTML = D.communities.map(function (c) {
      return '<div class="row' + (iso != null && iso !== c.id ? ' off' : '') +
        '" data-c="' + c.id + '">' +
        '<span class="dot" style="background:' + hsl(c.hue) + '"></span>' +
        '<span>' + esc(c.label) + '</span><span class="n">' + c.size + '</span></div>';
    }).join('') + (D.communityTotal > D.communities.length
      ? '<div class="row n">…and ' + (D.communityTotal - D.communities.length) + ' smaller</div>'
      : '');
    Array.prototype.forEach.call(legendBody.querySelectorAll('[data-c]'), function (row) {
      row.onclick = function () {
        const id = Number(row.dataset.c);
        iso = iso === id ? null : id;
        hi = iso == null ? null : isoSet(iso);
        paintLegend();
        draw();
      };
    });
  }

  // --- interaction
  let drag = null;
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, ox, oy, moved: 0 };
    cv.classList.add('drag');
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    ox = drag.ox + (e.clientX - drag.x);
    oy = drag.oy + (e.clientY - drag.y);
    draw();
  });
  cv.addEventListener('pointerup', e => {
    cv.classList.remove('drag');
    const d = drag; drag = null;
    if (d && d.moved < 6) {
      const r = cv.getBoundingClientRect();
      select(at(e.clientX - r.left, e.clientY - r.top));
    }
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    // Zoom toward the cursor: scaling around the origin instead makes the
    // point you are aiming at run away from you.
    ox = mx - (mx - ox) * f;
    oy = my - (my - oy) * f;
    scale *= f;
    draw();
  }, { passive: false });

  // --- search
  const q = document.getElementById('q');
  const hits = document.getElementById('hits');
  q.addEventListener('input', function () {
    const term = q.value.trim().toLowerCase();
    if (term.length < 2) { hits.hidden = true; return; }
    const found = D.nodes.filter(n =>
      (n.l || '').toLowerCase().includes(term) || (n.p || '').toLowerCase().includes(term)
    ).sort((a, b) => b.r - a.r).slice(0, 12);
    hits.hidden = !found.length;
    hits.innerHTML = found.map((n, i) =>
      '<button data-i="' + i + '"><span class="dot" style="background:' + hsl(n.h) + '"></span>' +
      '<span>' + esc(n.l) + '</span></button>').join('');
    Array.prototype.forEach.call(hits.querySelectorAll('button'), function (b, i) {
      b.onclick = function () {
        const n = found[i];
        scale = Math.max(scale, 0.4);
        ox = cv.clientWidth / 2 - n.x * scale;
        oy = cv.clientHeight / 2 - n.y * scale;
        select(n);
        hits.hidden = true;
      };
    });
  });

  document.getElementById('count').textContent =
    D.nodes.length.toLocaleString() + ' nodes';
  document.getElementById('foot').textContent =
    D.communityTotal + ' subsystems · ' + D.links.length.toLocaleString() +
    ' edges · via ' + D.source + ' · ' + D.generated;

  paintLegend();
  window.addEventListener('resize', fit);
  fit();
})();
</script>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
