/**
 * Source-text access for the code viewer.
 *
 * Two very different origins, one interface:
 *   - a PREBUILT corpus fetches one file at a time from the mirrored tree the
 *     build wrote (`/data/<name>/src/<path>`). Per-file, because Aeon's full
 *     corpus is 18 MB of text and nobody should download that to read one
 *     function.
 *   - a corpus extracted IN THE BROWSER already holds every file in memory —
 *     the worker parsed them seconds ago — so it costs nothing.
 *
 * Callers just await getSource(path).
 */

/** Origin backed by the mirrored tree a build produced. */
export function fetchedSources(manifest) {
  const cache = new Map();
  const available = new Set(manifest.paths);
  return {
    has: (p) => available.has(p),
    count: available.size,
    async get(path) {
      if (cache.has(path)) return cache.get(path);
      if (!available.has(path)) return null;
      // Each segment is encoded separately: slashes are real path structure
      // and must survive, but '#' or '?' in a filename would truncate the URL.
      const url = `${manifest.base}/${path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url);
      const text = res.ok ? await res.text() : null;
      cache.set(path, text);
      return text;
    },
  };
}

/** Origin backed by files still in memory from an in-browser extraction. */
export function inMemorySources(files) {
  const map = new Map(files.map((f) => [f.path, f.src]));
  return {
    has: (p) => map.has(p),
    count: map.size,
    async get(path) {
      return map.get(path) ?? null;
    },
  };
}

/**
 * Parse graphify's `source_location` ("L214") into a 1-based line number.
 * Returns null for anything unexpected rather than guessing — a wrong jump is
 * worse than no jump.
 */
export function lineOf(loc) {
  const m = /^L(\d+)$/.exec(loc ?? '');
  return m ? Number(m[1]) : null;
}
