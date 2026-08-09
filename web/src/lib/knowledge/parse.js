/**
 * Documents -> a structure the graph and the retriever both use.
 *
 *   document -> section (a heading and its body) -> passage (a retrieval unit)
 *
 * Sections become graph nodes; passages are what search ranks. Keeping them
 * separate matters: a map with one node per paragraph is unreadable, and a
 * retriever that can only return whole documents is useless. Sections are the
 * unit a human names, passages are the unit a human reads.
 *
 * No LLM anywhere. Headings are `#{1,6}` or an underline, and prose splits on
 * blank lines — deterministic, and the same structure Graphify's own
 * document nodes carry (its 292 doc nodes on Aeon are exactly this).
 */

// Under this a passage is a fragment (a stray line, a list item) and gets
// merged forward; over it, retrieval returns more than anyone reads.
const MIN_PASSAGE = 220;
const MAX_PASSAGE = 1600;

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * @param {{path: string, text: string}} file
 * @returns {{path, title, sections: Array}}
 */
export function parseDocument({ path, text }) {
  const lines = text.split('\n');
  const isMd = /\.(md|markdown|rst)$/i.test(path);

  const sections = [];
  let current = null;
  // Headings repeat inside a document — "Usage" under three different
  // features is normal prose, not a mistake — so the slug alone is not a key.
  const usedIds = new Set();
  const uniqueId = (base) => {
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  const push = () => {
    if (!current) return;
    current.body = current.lines.map((l) => l.text).join('\n').trim();
    current.rawLines = current.lines;
    delete current.lines;
    if (current.body || current.heading) sections.push(current);
  };

  const open = (heading, level, line) => {
    push();
    current = {
      id: uniqueId(`${path}#${slug(heading) || `s${sections.length}`}`),
      heading,
      level,
      line,
      lines: [],
    };
  };

  // Everything before the first heading still belongs somewhere.
  open('', 0, 1);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (isMd) {
      const atx = /^(#{1,6})\s+(.*?)\s*#*$/.exec(raw);
      if (atx) { open(atx[2].trim(), atx[1].length, i + 1); continue; }

      // Setext: a line underlined with === or ---, which rst uses too.
      const next = lines[i + 1];
      if (raw.trim() && next && /^([=\-~^"])\1{2,}\s*$/.test(next) && !/^\s*[-*+]\s/.test(raw)) {
        open(raw.trim(), next.trim()[0] === '=' ? 1 : 2, i + 1);
        i++; // consume the underline
        continue;
      }
    }
    // Carry the source line with each line of body: a passage's location is
    // the only way "open this result" lands anywhere useful, and once the body
    // is joined into a string that information is gone.
    current.lines.push({ text: raw, line: i + 1 });
  }
  push();

  // A leading section with no heading and no body is an artefact of always
  // opening one; drop it rather than showing an empty node.
  const kept = sections.filter((s) => s.heading || s.body);

  const title = kept.find((s) => s.level === 1)?.heading
    || path.slice(path.lastIndexOf('/') + 1);

  for (const s of kept) s.passages = splitPassages(s);

  return { path, title, sections: kept };
}

/**
 * Body -> passages, merged to a readable size, never mid-paragraph.
 *
 * Blocks are built from the LINE records rather than by splitting the joined
 * body, so every passage knows the line it starts on. Without that, each
 * passage inherited the section's line: results from the same section looked
 * identical and all of them opened at the heading instead of at the text.
 */
function splitPassages(section) {
  // Group consecutive non-blank lines into blocks, keeping the first line no.
  const blocks = [];
  let block = null;
  for (const { text, line } of section.rawLines ?? []) {
    if (text.trim()) {
      if (!block) block = { line, text: [] };
      block.text.push(text);
    } else if (block) {
      blocks.push({ line: block.line, text: block.text.join('\n').trim() });
      block = null;
    }
  }
  if (block) blocks.push({ line: block.line, text: block.text.join('\n').trim() });

  const out = [];
  let buf = '';
  let startLine = section.line;

  const flush = () => {
    if (!buf) return;
    out.push({
      id: `${section.id}:${out.length}`,
      sectionId: section.id,
      heading: section.heading,
      line: startLine,
      text: buf,
    });
    buf = '';
  };

  for (const b of blocks) {
    if (!buf) startLine = b.line;
    if (b.text.length > MAX_PASSAGE) {
      // A wall of text (a table, a long code block) — take it whole rather
      // than slicing mid-sentence, but cap what we index.
      flush();
      startLine = b.line;
      buf = b.text.slice(0, MAX_PASSAGE);
      flush();
      continue;
    }
    buf = buf ? `${buf}\n\n${b.text}` : b.text;
    if (buf.length >= MIN_PASSAGE) flush();
  }
  flush();

  // Drop passages with no actual prose. A markdown `---` rule or a bare code
  // fence is a real block of text and BM25 will happily rank it, producing
  // results whose entire content is "---". Require some words.
  const meaty = out.filter((p) => (p.text.match(/[A-Za-z0-9]/g) ?? []).length >= 15);
  if (meaty.length) return renumber(meaty, section);

  // A heading with no body is still worth returning as a hit — it names
  // something, and the map has a node for it.
  if (!out.length && section.heading) {
    out.push({
      id: `${section.id}:0`, sectionId: section.id,
      heading: section.heading, line: section.line, text: section.heading,
    });
  }
  return renumber(out, section);
}

/** Ids encode position, so they must be reassigned after any filtering. */
function renumber(passages, section) {
  return passages.map((p, i) => ({ ...p, id: `${section.id}:${i}` }));
}

export { slug };
