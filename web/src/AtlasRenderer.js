/**
 * WebGL renderer for the Atlas.
 *
 * Ported from Project-Kagami. One thing makes it fast enough for thousands of
 * nodes: every dot is the SAME white circle texture, drawn as a sprite and
 * TINTED per node. Identical base textures let PIXI batch the whole map into a
 * handful of draw calls, and tint is free. Colour therefore encodes community
 * (the Louvain hue from the layout pass) and size encodes degree — both baked
 * offline, so the browser only positions and tints.
 *
 * Hover/click hit-testing does NOT walk the sprite list. A uniform spatial grid
 * keyed on world coordinates turns "what's under the cursor" into an O(1)
 * bucket lookup, which is what keeps interaction smooth regardless of node count.
 *
 * Generalised from the Kagami original in three places: node ids are strings
 * here rather than numeric AniList ids (so no Number() coercion anywhere), and
 * the filter reads `k` (kind) rather than `m` (media type).
 */
import { Application, Container, Sprite, Graphics } from 'pixi.js';
import { Viewport } from 'pixi-viewport';

const BG = 0x0a0a0f;
const GRID_CELL = 600; // world units per spatial-hash bucket

/**
 * Above this many edges, don't draw them at all.
 *
 * Kagami's "edges become a grey haze that hides the clusters" finding was
 * measured at ~290k edges, and it is correct there. At Aeon's ~1.7k it is
 * exactly backwards: the edges ARE the structure, and without them the map is
 * a pretty scatter you cannot trace a dependency through. So the choice is made
 * per corpus rather than baked in.
 */
const MAX_DRAWN_EDGES = 20000;

// Target on-screen thickness in CSS pixels. Edges are redrawn on zoom to hold
// this, because a fixed world-unit width is either invisible when zoomed out or
// thicker than the nodes when zoomed in.
const EDGE_PX = 0.7;
const EDGE_ALPHA = 0.34;      // within a community
const EDGE_ALPHA_BRIDGE = 0.07; // between communities
const EDGE_ALPHA_DIM = 0.03;
const EDGE_ALPHA_HOT = 0.85;

export class AtlasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.app = null;
    this.viewport = null;
    this.nodes = [];
    this.edges = [];           // [source, target, relation, confidence][]
    this.edgeLayer = null;     // Graphics | null (null when the corpus is too big)
    this.sprites = new Map();  // id -> Sprite
    this.nodeById = new Map(); // id -> node (O(1) lookups on recolour and focus)
    this.grid = new Map();     // "gx,gy" -> node[]
    this.kindFilter = null;    // Set<kind> | null (null = every kind visible)
    this.highlightIds = null;  // Set<id> | null
    this.onSelect = () => {};
    this.onHover = () => {};
  }

  /**
   * @param {object} layout  the .layout.json payload
   * @param {Array=} edges   the .edges.json payload; omit to render nodes only
   */
  async init(layout, edges = null) {
    this.nodes = layout.nodes;
    this.edges = Array.isArray(edges) ? edges : [];
    const { width, height } = layout.bounds;

    this.app = new Application();
    await this.app.init({
      canvas: this.canvas,
      background: BG,
      antialias: true,
      resizeTo: this.canvas.parentElement,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    this.viewport = new Viewport({
      worldWidth: width,
      worldHeight: height,
      events: this.app.renderer.events,
    });
    this.viewport.drag().pinch().wheel({ smooth: 3 }).decelerate();
    this.viewport.clampZoom({ minScale: 0.03, maxScale: 6 });
    this.app.stage.addChild(this.viewport);

    // Edges go in first so they render beneath every node. Kept null when the
    // corpus is too dense to draw legibly — see MAX_DRAWN_EDGES.
    if (this.edges.length && this.edges.length <= MAX_DRAWN_EDGES) {
      this.edgeLayer = new Graphics();
      this.viewport.addChild(this.edgeLayer);
    }

    const circle = this._circleTexture();

    // Draw largest-first so hub nodes sit visually beneath and small ones stay
    // clickable on top.
    const ordered = [...this.nodes].sort((a, b) => b.r - a.r);
    const layer = new Container();
    for (const n of ordered) {
      const s = new Sprite(circle);
      s.anchor.set(0.5);
      s.position.set(n.x, n.y);
      s.width = s.height = n.r * 2;
      s.tint = this._hueToRgb(n.h);
      s.alpha = 0.92;
      s._r = n.r; // base world radius, for zoom-aware rescaling
      layer.addChild(s);
      this.sprites.set(n.id, s);
      this.nodeById.set(n.id, n);
      this._index(n);
    }
    this.viewport.addChild(layer);

    // Fit the world to the viewport rather than hardcoding a zoom. The Kagami
    // original used setZoom(0.09), which is only correct for a 20000-unit world
    // in a particular window; the world box now scales with node count, so a
    // fixed zoom would frame every corpus differently. 0.92 leaves a margin so
    // edge clusters aren't flush against the chrome.
    this.viewport.moveCenter(width / 2, height / 2);
    this.viewport.fit(true, width, height);
    this.viewport.setZoom(this.viewport.scaled * 0.92, true);

    // Zoomed out, a radius-3..17 node is a fraction of a pixel — the whole map
    // reads as faint dust and the cluster structure is invisible. Clamp every
    // node to a minimum on-screen radius; zoomed in past the threshold, true
    // relative sizes take over untouched.
    const MIN_SCREEN_R = 2.2;
    this._applyLOD = () => {
      const minWorld = MIN_SCREEN_R / this.viewport.scaled;
      for (const s of this.sprites.values()) {
        const r = Math.max(s._r, minWorld);
        s.width = s.height = r * 2;
      }
      // Line thickness is specified in world units, so holding a constant
      // on-screen weight means redrawing whenever the zoom changes.
      this._redrawEdges();
    };
    this.viewport.on('zoomed-end', this._applyLOD);
    this._applyLOD();

    this._wireInteraction();
    return this;
  }

  _circleTexture() {
    // A single white disc, drawn once at high resolution and reused everywhere.
    const g = new Graphics().circle(0, 0, 64).fill(0xffffff);
    return this.app.renderer.generateTexture({ target: g, resolution: 2 });
  }

  _hueToRgb(h) {
    // HSL(h, 68%, 62%) -> packed RGB. Saturation/lightness fixed so the map
    // reads as one palette and only hue (community) varies.
    const s = 0.68, l = 0.62;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return (
      (Math.round((r + m) * 255) << 16) |
      (Math.round((g + m) * 255) << 8) |
      Math.round((b + m) * 255)
    );
  }

  /**
   * Repaint every edge for the current zoom, filter and highlight state.
   *
   * Batched by colour: all segments sharing a hue are accumulated into one path
   * and stroked once, so ~1.7k edges cost roughly as many stroke calls as there
   * are communities, not as there are edges. Cheap enough to redo on zoom.
   *
   * An edge takes the hue of its SOURCE node, which makes a community's
   * internal wiring read as one colour and its outbound dependencies read as
   * intrusions of that colour into a neighbour — the thing you actually want to
   * spot on a code map.
   */
  _redrawEdges() {
    const g = this.edgeLayer;
    if (!g) return;
    g.clear();

    const width = EDGE_PX / this.viewport.scaled;
    const kf = this.kindFilter;
    const hl = this.highlightIds;

    // Because the layout separates communities in space, a cross-community edge
    // is long BY CONSTRUCTION — ~8% of Aeon's edges span more than a third of
    // the map, and at equal weight those few dozen lines visually dominate the
    // thousand short ones that describe the actual local structure. Drawing
    // them as faint grey bridges keeps the information (you can still see that
    // a subsystem reaches across the map) without letting it drown the rest.
    const normal = new Map(); // hue -> [a, b][]  (within one community)
    const bridge = [];        // between communities
    const dim = [];
    const hot = [];

    for (const [s, t] of this.edges) {
      const a = this.nodeById.get(s);
      const b = this.nodeById.get(t);
      if (!a || !b) continue;

      const visible = !kf || (kf.has(a.k) && kf.has(b.k));
      if (!visible) { dim.push([a, b]); continue; }

      if (hl) {
        if (hl.has(s) && hl.has(t)) hot.push([a, b]);
        else dim.push([a, b]);
        continue;
      }
      if (a.c !== b.c) { bridge.push([a, b]); continue; }
      if (!normal.has(a.h)) normal.set(a.h, []);
      normal.get(a.h).push([a, b]);
    }

    const stroke = (pairs, color, alpha) => {
      if (!pairs.length) return;
      for (const [a, b] of pairs) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); }
      g.stroke({ color, width, alpha });
    };

    // Painted back to front: dimmed, then bridges, then each community's own
    // wiring, then the selection.
    stroke(dim, 0x8b8b9e, EDGE_ALPHA_DIM);
    stroke(bridge, 0x8b8b9e, EDGE_ALPHA_BRIDGE);
    for (const [hue, pairs] of normal) stroke(pairs, this._hueToRgb(hue), EDGE_ALPHA);
    stroke(hot, 0xffffff, EDGE_ALPHA_HOT);
  }

  _index(n) {
    const key = `${Math.floor(n.x / GRID_CELL)},${Math.floor(n.y / GRID_CELL)}`;
    if (!this.grid.has(key)) this.grid.set(key, []);
    this.grid.get(key).push(n);
  }

  _nodeAt(worldX, worldY) {
    // Search the cursor's bucket and its 8 neighbours — a node's clickable
    // radius never exceeds one cell, so this is exhaustive without scanning.
    const gx = Math.floor(worldX / GRID_CELL);
    const gy = Math.floor(worldY / GRID_CELL);
    let best = null;
    let bestDist = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.grid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const n of bucket) {
          const d = (n.x - worldX) ** 2 + (n.y - worldY) ** 2;
          const hit = Math.max(n.r, 12) ** 2; // floor so tiny nodes stay clickable
          if (d < hit && d < bestDist) {
            best = n;
            bestDist = d;
          }
        }
      }
    }
    return best;
  }

  _wireInteraction() {
    this.viewport.eventMode = 'static';

    this.viewport.on('pointermove', (e) => {
      const w = this.viewport.toWorld(e.global);
      const n = this._nodeAt(w.x, w.y);
      this.canvas.style.cursor = n ? 'pointer' : 'grab';
      this.onHover(n, e.global);
    });

    // Distinguish click from drag: only a genuine click (little movement)
    // should select.
    let down = null;
    this.viewport.on('pointerdown', (e) => (down = { x: e.global.x, y: e.global.y }));
    this.viewport.on('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.global.x - down.x, e.global.y - down.y);
      down = null;
      if (moved > 6) return;
      const w = this.viewport.toWorld(e.global);
      const n = this._nodeAt(w.x, w.y);
      this.onSelect(n || null);
    });
  }

  /** Spotlight a set of ids — dim everything else. Composes with the kind
   *  filter (a filtered-out kind stays dim even if it is in the highlight). */
  highlight(ids) {
    this.highlightIds = ids ? new Set(ids) : null;
    this._applyVisibility();
  }

  /** Restrict the map to a set of kinds, or null to show them all. */
  setKindFilter(kinds) {
    this.kindFilter = kinds ? new Set(kinds) : null;
    this._applyVisibility();
  }

  /** Single source of truth for every sprite's alpha: kind filter first (hard
   *  dim), then highlight spotlight, then the resting state. */
  _applyVisibility() {
    const kf = this.kindFilter;
    const hl = this.highlightIds;
    for (const [id, s] of this.sprites) {
      if (kf && !kf.has(this.nodeById.get(id)?.k)) { s.alpha = 0.04; continue; }
      if (hl) s.alpha = hl.has(id) ? 1 : 0.06;
      else s.alpha = 0.92;
    }
    this._redrawEdges();
  }

  focus(id, zoom = 0.6) {
    const n = this.nodeById.get(id);
    if (!n) return;
    this.viewport.animate({
      time: 600,
      position: { x: n.x, y: n.y },
      scale: zoom,
      ease: 'easeInOutSine',
    });
  }

  destroy() {
    this.app?.destroy(true, { children: true, texture: true });
  }
}
