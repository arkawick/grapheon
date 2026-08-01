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

export class AtlasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.app = null;
    this.viewport = null;
    this.nodes = [];
    this.sprites = new Map();  // id -> Sprite
    this.nodeById = new Map(); // id -> node (O(1) lookups on recolour and focus)
    this.grid = new Map();     // "gx,gy" -> node[]
    this.kindFilter = null;    // Set<kind> | null (null = every kind visible)
    this.highlightIds = null;  // Set<id> | null
    this.onSelect = () => {};
    this.onHover = () => {};
  }

  async init(layout) {
    this.nodes = layout.nodes;
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
