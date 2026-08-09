/**
 * BM25 retrieval over passages.
 *
 * BM25 rather than raw TF-IDF because it is what actually works on prose of
 * uneven length: term saturation stops one word repeated twenty times from
 * dominating, and length normalisation stops a 20-line passage losing to a
 * 2-line one that happens to mention the word once.
 *
 * No model, no download, no key — a real retriever that runs the moment the
 * files are parsed. The index is shaped to hold a `vector` per passage later,
 * so adding MiniLM embeddings is an added field and a re-rank, not a rewrite.
 */

const K1 = 1.2;  // term-frequency saturation
const B = 0.75;  // length normalisation strength

// Removing these costs nothing and stops "the" scoring anything. Deliberately
// short: aggressive stoplists break phrase-ish queries like "how to run".
const STOP = new Set(`a an and are as at be but by for from has have how i if in
is it its of on or that the their then there these they this to was were what
when where which who will with you your`.split(/\s+/));

export function tokenize(text) {
  const out = [];
  // Keep dotted/underscored identifiers whole: "core.llm" and "blast_radius"
  // are single terms in this domain, and splitting them loses the query.
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) ?? []) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (!t || t.length < 2 || STOP.has(t)) continue;
    out.push(t);
    // Also index the parts, so "llm" finds "core.llm".
    if (/[._-]/.test(t)) {
      for (const part of t.split(/[._-]+/)) {
        if (part.length > 1 && !STOP.has(part)) out.push(part);
      }
    }
  }
  return out;
}

/**
 * @param {Array<{id, text, ...}>} passages
 */
export function buildIndex(passages) {
  const docs = [];
  const df = new Map();

  for (const p of passages) {
    const terms = tokenize(`${p.heading ?? ''} ${p.text}`);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ ref: p, tf, len: terms.length, vector: null });
  }

  const N = docs.length || 1;
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / N;

  // Precomputed IDF: constant per term, and recomputing it inside the scoring
  // loop is the usual way this gets slow.
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));

  return { docs, idf, avgLen, size: docs.length };
}

/**
 * @returns {Array<{passage, score, terms: string[]}>} best first
 */
export function search(index, query, limit = 30) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return [];

  const scored = [];
  for (const d of index.docs) {
    let score = 0;
    const hit = [];
    for (const t of qTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = index.idf.get(t) ?? 0;
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgLen))));
      hit.push(t);
    }
    if (!score) continue;
    // Reward covering more of the question. Without this a passage that says
    // one query word ten times outranks one that says every word once, which
    // is precisely backwards for a question.
    score *= 1 + 0.35 * ((hit.length - 1) / qTerms.length);
    scored.push({ passage: d.ref, score, terms: hit });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
