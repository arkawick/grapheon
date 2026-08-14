/**
 * Linking prose to code.
 *
 * A design doc that says "ChromaStore handles recall" is talking about a class
 * that exists in the graph, and until now the two corpora had no idea about
 * each other. This finds those mentions — no model, just careful matching.
 *
 * The whole difficulty is PRECISION. A join that links every occurrence of
 * "get" or "data" produces noise that makes the feature worse than nothing, so
 * the rules below are deliberately conservative: an ambiguous mention is
 * dropped rather than guessed.
 */

// Identifiers too generic to mean anything on their own. Matching these would
// link half the documentation to half the codebase.
const TOO_GENERIC = new Set(`get set run main init app api index test tests data
config setup start stop build make load save read write list add new open close
call send post put delete update create remove find item items name value type
file files path paths node nodes edge edges key keys size count total result
results error errors state status page next prev use util utils lib src`.split(/\s+/));

// A bare word is only accepted as a mention if it is distinctive: CamelCase,
// snake_case, dotted, or simply long. "handler" is not evidence; "ChromaStore"
// and "blast_radius_service" are.
const isDistinctive = (name) =>
  /[a-z][A-Z]/.test(name) || /[_.]/.test(name) || name.length >= 9;

/**
 * A code node's mentionable forms, strongest first.
 *
 * Path forms come ONLY from the file's own node. Every function in llm.py
 * carries that path too, so emitting it for all of them made the path
 * ambiguous against its own file and dropped the strongest signal there is.
 * A reader writing "core/llm.py" means the file, not one function inside it.
 */
function formsOf(node) {
  const out = [];
  const path = node.a?.path ?? null;
  const label = node.l ?? '';
  const basename = path ? path.slice(path.lastIndexOf('/') + 1) : null;
  const isFileNode = basename && label === basename;

  if (path && isFileNode) {
    out.push({ text: path, kind: 'path' });
    // "core/llm.py" — specific enough to be unambiguous, without requiring the
    // reader to have written the full repo-relative path.
    const parts = path.split('/');
    if (parts.length > 1) out.push({ text: parts.slice(-2).join('/'), kind: 'path' });
    out.push({ text: basename, kind: 'file' });
  }
  // Labels are "name()", ".method()" or a bare class/type name.
  const bare = label.replace(/\(\)$/, '').replace(/^\./, '');
  if (bare && !isFileNode) out.push({ text: bare, kind: 'identifier' });
  return out.filter((f) => f.text.length >= 4);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {Array} codeNodes    layout nodes of a CODE corpus
 * @param {Array} passages     [{id, sectionId, heading, line, text}]
 * @param {{maxPerPassage?: number, docFrequencyCeiling?: number}} opts
 * @returns {{byPassage: Map, byNode: Map, total: number}}
 */
export function joinDocsToCode(codeNodes, passages, opts = {}) {
  const { maxPerPassage = 8, docFrequencyCeiling = 0.2 } = opts;

  // form -> [nodeId]. Several nodes can share a form (two files named
  // `index.ts`, a method name reused); those are dropped, because pointing at
  // the wrong definition is worse than pointing at none.
  const byForm = new Map();
  for (const n of codeNodes) {
    if (n.k === 'external') continue;
    for (const f of formsOf(n)) {
      const key = f.text.toLowerCase();
      if (!byForm.has(key)) byForm.set(key, { kind: f.kind, text: f.text, ids: new Set() });
      byForm.get(key).ids.add(n.id);
    }
  }

  const candidates = [];
  for (const [key, v] of byForm) {
    if (v.ids.size !== 1) continue;                       // ambiguous
    let fencedOnly = false;
    if (v.kind === 'identifier') {
      if (TOO_GENERIC.has(key)) continue;
      // An undistinctive name is not dropped outright — it is admitted only
      // when the writer marked it as code with backticks. Filtering it here
      // instead meant `complete()` in a code span could never match, because
      // the candidate was gone before the text was ever examined.
      if (!isDistinctive(v.text)) fencedOnly = true;
    }
    candidates.push({ key, ...v, id: [...v.ids][0], fencedOnly });
  }

  // Longest first: "core/llm.py" should win over "llm.py" in the same span,
  // and the longer match is the more specific claim.
  candidates.sort((a, b) => b.key.length - a.key.length);

  const rawByPassage = new Map();
  const passageCount = new Map(); // candidate key -> how many passages mention it

  for (const p of passages) {
    const hay = p.text.toLowerCase();
    const hits = [];
    const consumed = [];

    for (const c of candidates) {
      const at = hay.indexOf(c.key);
      if (at === -1) continue;
      // Skip a match that sits inside an already-claimed, longer span.
      if (consumed.some(([s, e]) => at >= s && at < e)) continue;

      // Word boundaries, so "api" does not match inside "rapid" and
      // "complete" does not match inside "incomplete".
      const re = new RegExp(`(?<![\\w.])${escapeRe(c.key)}(?![\\w])`, 'i');
      const m = re.exec(p.text);
      if (!m) continue;

      // Backticks or a code fence are an explicit claim that this is code,
      // which upgrades even a weak identifier to a confident match.
      // A backticked span is the writer explicitly saying "this is code",
      // which is stronger evidence than any heuristic about the name itself.
      // `complete()` in prose includes the parens, so allow them inside.
      const before = p.text.slice(Math.max(0, m.index - 1), m.index);
      const rest = p.text.slice(m.index + m[0].length);
      const fenced = before === '`' && /^(\(\))?`/.test(rest);
      if (c.fencedOnly && !fenced) continue;

      hits.push({
        nodeId: c.id,
        text: m[0],
        kind: c.kind,
        confidence: fenced || c.kind === 'path' ? 'high' : c.kind === 'file' ? 'medium' : 'low',
        key: c.key,
      });
      consumed.push([m.index, m.index + m[0].length]);
      if (hits.length >= maxPerPassage) break;
    }

    if (!hits.length) continue;
    rawByPassage.set(p.id, { passage: p, hits });
    for (const h of hits) passageCount.set(h.key, (passageCount.get(h.key) ?? 0) + 1);
  }

  // A term mentioned in a fifth of all passages is vocabulary, not a
  // reference — the same reasoning that keeps common words out of the
  // knowledge graph's similarity edges.
  const ceiling = Math.max(3, Math.floor(passages.length * docFrequencyCeiling));
  const byPassage = new Map();
  const byNode = new Map();
  let total = 0;

  for (const [pid, entry] of rawByPassage) {
    const kept = entry.hits.filter((h) => (passageCount.get(h.key) ?? 0) <= ceiling);
    if (!kept.length) continue;
    byPassage.set(pid, { ...entry, hits: kept });
    for (const h of kept) {
      if (!byNode.has(h.nodeId)) byNode.set(h.nodeId, []);
      byNode.get(h.nodeId).push({
        passageId: pid,
        sectionId: entry.passage.sectionId,
        heading: entry.passage.heading,
        line: entry.passage.line,
        text: entry.passage.text,
        confidence: h.confidence,
        matched: h.text,
      });
      total++;
    }
  }

  return { byPassage, byNode, total };
}

/** Every passage of a knowledge corpus, from the stored document metadata. */
export function passagesOf(knowledge) {
  return (knowledge?.index?.docs ?? []).map((d) => d.ref);
}
