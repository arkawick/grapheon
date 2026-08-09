/**
 * Search across the contents of every readable file in the corpus.
 *
 * The graph can answer "which entity is called llm" but not "where does the
 * string AZURE_OPENAI_ENDPOINT appear" — that lives in config, docstrings and
 * YAML the extractor never turned into nodes. This is the other half of
 * knowing a repo.
 *
 * Runs against whatever the sources origin holds. For an in-memory corpus
 * (dropped folder/zip) every file is already there. For a fetched one each
 * file is pulled once and cached by the origin, so the first search is the
 * expensive one and every later search is instant — which is why results
 * stream through a callback instead of resolving all at once.
 */

const MAX_MATCHES_PER_FILE = 20;
const CONTEXT_CHARS = 120;

/**
 * Files fetched at once on a cold corpus.
 *
 * Sequentially awaiting each file made a first search take 25 SECONDS over
 * 142 files — one round trip apiece, plus a per-file `setTimeout(0)` that
 * browsers clamp to ~4ms. Batching drops it to a couple of seconds; a warm
 * search is ~100ms either way because the origin caches. 12 is comfortably
 * under the ~6-connection-per-host limit's pain point while keeping the
 * pipeline full.
 */
const BATCH = 12;

/**
 * @param {object} sources         origin from lib/sources.js
 * @param {string} query           literal text (not a regex — users type paths
 *                                 and dotted names, and escaping them by hand
 *                                 is a worse default than losing regex power)
 * @param {(fileResult) => void} onResult   called per file that has matches
 * @param {{signal?: AbortSignal, limit?: number}} opts
 * @returns {Promise<{files: number, matches: number, truncated: boolean}>}
 */
export async function searchCorpus(sources, query, onResult, opts = {}) {
  const { signal, limit = 300 } = opts;
  const needle = query.toLowerCase();
  let files = 0, matches = 0, truncated = false;

  const all = sources.paths;
  for (let start = 0; start < all.length; start += BATCH) {
    if (signal?.aborted) break;
    if (matches >= limit) { truncated = true; break; }

    const batch = all.slice(start, start + BATCH);
    const texts = await Promise.all(batch.map((p) => sources.get(p).catch(() => null)));
    if (signal?.aborted) break;

    // Reported in path order within the batch, so results don't jump around
    // as fetches resolve out of order.
    for (let i = 0; i < batch.length; i++) {
      const text = texts[i];
      if (!text) continue;

      // Cheap reject before splitting into lines — most files don't match, and
      // one indexOf over the whole string beats scanning line by line.
      if (!text.toLowerCase().includes(needle)) continue;

      const lines = text.split('\n');
      const hits = [];
      for (let n = 0; n < lines.length && hits.length < MAX_MATCHES_PER_FILE; n++) {
        const idx = lines[n].toLowerCase().indexOf(needle);
        if (idx === -1) continue;
        hits.push({ line: n + 1, col: idx, text: trim(lines[n], idx, needle.length) });
      }
      if (!hits.length) continue;

      files++;
      matches += hits.length;
      onResult({ path: batch[i], hits });
    }

    // One yield per batch, not per file: the point is to let React paint
    // streamed results, and doing it 142 times was pure overhead.
    await new Promise((r) => setTimeout(r, 0));
  }

  return { files, matches, truncated };
}

/** Keep a window around the match so long minified-ish lines stay readable. */
function trim(line, idx, len) {
  if (line.length <= CONTEXT_CHARS) return { before: line.slice(0, idx), match: line.slice(idx, idx + len), after: line.slice(idx + len) };
  const start = Math.max(0, idx - 30);
  const end = Math.min(line.length, idx + len + CONTEXT_CHARS - 30);
  return {
    before: (start ? '…' : '') + line.slice(start, idx),
    match: line.slice(idx, idx + len),
    after: line.slice(idx + len, end) + (end < line.length ? '…' : ''),
  };
}
