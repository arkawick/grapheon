/**
 * Ranking for the command palette.
 *
 * One box over three very different things — graph entities, readable files,
 * and commands — because "I want to get to X" is one intent, and making the
 * user first decide *which kind of thing* X is defeats the point.
 *
 * Pure over its inputs so it tests without a browser, like every other lib/
 * module here.
 */

export const LIMITS = { recent: 6, entities: 8, files: 8, commands: 6 };

/**
 * How much a matching command is favoured over matching content.
 *
 * Not a thumb on the scale for its own sake: there are eight commands and a
 * thousand entities, and every entity is *also* reachable from the map, the
 * tree and two search boxes. The palette is the only way to reach a command,
 * so burying one costs more than burying one of six near-identical headings.
 *
 * Deliberately smaller than the gap between tiers, so a command can outrank
 * content that matched equally well but can never jump a whole tier — a
 * substring command match still loses to a prefix match on a real entity.
 */
const COMMAND_BIAS = 120;

/**
 * Score `text` against a lowercased `term`, or null for no match.
 *
 * The tiers matter more than the numbers: an exact hit must always beat a
 * prefix, and a prefix must always beat a match buried mid-word, or typing a
 * full filename ranks it below something that merely contains it. Within a
 * tier, shorter text wins — `llm.py` over `llm_provider_registry.py` — but by
 * less than a tier is worth, so the ordering between tiers is never disturbed.
 */
export function scoreMatch(text, term) {
  if (!text || !term) return null;
  const hay = text.toLowerCase();
  const i = hay.indexOf(term);
  if (i === -1) return null;

  let tier;
  if (hay === term) tier = 1000;
  else if (i === 0) tier = 700;
  // A boundary is where a human would consider a new word to start. Paths and
  // identifiers both matter here: `core/llm.py` and `parseDocument` should both
  // be findable by their second word.
  else if (isBoundary(text, i)) tier = 500;
  else tier = 200;

  return tier + Math.max(0, 60 - text.length);
}

function isBoundary(text, i) {
  const prev = text[i - 1];
  if ('/._- :'.includes(prev)) return true;
  // camelCase: a lowercase letter followed by the uppercase we matched at.
  return /[a-z0-9]/.test(prev) && /[A-Z]/.test(text[i]);
}

/** Best score across several fields, so a path hit counts as much as a label hit. */
function best(term, ...fields) {
  let top = null;
  for (const f of fields) {
    const s = scoreMatch(f, term);
    if (s != null && (top == null || s > top)) top = s;
  }
  return top;
}

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Build the palette's sections for a query.
 *
 * Sections are ordered by their BEST item rather than by a fixed precedence:
 * typing "blast" should offer the Blast Radius page first, and typing "llm.py"
 * should offer the file first, and no fixed order gets both right.
 *
 * An empty query is not an empty palette — it is the case worth optimising,
 * because "reopen what I was just looking at" is the most common reason to
 * press the key at all.
 */
export function rankPalette({
  query = '', nodes = [], paths = [], commands = [], recent = [], limits = LIMITS,
} = {}) {
  const term = query.trim().toLowerCase();
  const sections = [];

  if (!term) {
    if (recent.length) {
      sections.push({
        group: 'Recent files',
        items: recent.slice(0, limits.recent).map((r) => ({
          type: 'file', id: `file:${r.path}`, label: basename(r.path),
          sub: r.path, path: r.path, line: r.line ?? null,
        })),
      });
    }
    // Every command, uncapped: the list is short and deliberate, and the empty
    // palette is the only place it is ever shown in full. The limit exists to
    // stop a broad *query* flooding the list, which is a different problem.
    sections.push({ group: 'Commands', items: commands.map(toCommandItem) });
    return sections.filter((s) => s.items.length);
  }

  const scored = (items, limit) =>
    items.filter((x) => x.score != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

  const entities = scored(nodes.map((n) => ({
    type: 'node', id: `node:${n.id}`, node: n,
    label: n.l, sub: n.a?.path ?? n.k, hue: n.h, kind: n.k,
    // Degree is baked into the radius, so hubs surface ahead of leaves that
    // match equally well.
    score: addScore(best(term, n.l, n.a?.path), n.r ?? 0),
  })), limits.entities);

  const files = scored(paths.map((p) => ({
    type: 'file', id: `file:${p}`, label: basename(p), sub: p, path: p, line: null,
    score: best(term, basename(p), p),
  })), limits.files);

  // `keywords` is what the command is ABOUT, as opposed to what its label
  // reads like: nobody types "go to blast radius", they type "blast radius",
  // and matching only the label makes that a mid-string hit two tiers down.
  const cmds = scored(commands.map((c) => ({
    ...toCommandItem(c),
    score: addScore(best(term, c.keywords, c.label, c.hint), COMMAND_BIAS),
  })), limits.commands);

  for (const [group, items] of [['Entities', entities], ['Files', files], ['Commands', cmds]]) {
    if (items.length) sections.push({ group, items, top: items[0].score });
  }
  return sections.sort((a, b) => b.top - a.top);
}

function addScore(score, bonus) {
  return score == null ? null : score + bonus;
}

function toCommandItem(c) {
  return { type: 'command', id: `cmd:${c.id}`, label: c.label, sub: c.hint ?? '', run: c.run };
}

/** Flatten sections into the keyboard-navigable order the list is rendered in. */
export function flatten(sections) {
  return sections.flatMap((s) => s.items);
}
