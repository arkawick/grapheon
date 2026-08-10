/**
 * Saved corpora, in IndexedDB.
 *
 * Extracting a repo replaces whatever was loaded, and until now that was
 * destructive: opening a second project meant the first was gone, re-pickable
 * only by finding the folder again and re-parsing it. This keeps the built
 * artifacts so switching back is instant.
 *
 * IndexedDB rather than localStorage because these are megabytes, not strings,
 * and because structured clone stores the BM25 index's Maps as-is — serialising
 * those to JSON and back would be both slow and lossy.
 *
 * Two object stores on purpose: `meta` is tiny and is what the History page
 * lists, `data` holds the payloads. Listing must not deserialise every corpus
 * to show a list of names.
 */
const DB = 'grapheon';
const VERSION = 1;
const META = 'meta';
const DATA = 'data';

// Keep the store bounded. Corpora are large and regenerable; an unbounded
// cache eventually hits the browser's quota and fails at write time, which is
// the worst moment to discover it.
const MAX_ENTRIES = 8;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  return {
    t,
    done: new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }),
  };
}

const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/** Rough payload size, for the budget and for showing the user. */
function estimateBytes(payload) {
  let n = 0;
  for (const [path, text] of Object.entries(payload.sources ?? {})) n += path.length + text.length;
  n += (payload.layout?.nodes?.length ?? 0) * 180;
  n += (payload.edges?.length ?? 0) * 90;
  n += (payload.knowledge?.index?.size ?? 0) * 400;
  return n;
}

/**
 * @param {{name, kind, layout, edges, sources, knowledge}} entry
 * @returns {Promise<string>} id
 */
export async function saveCorpus(entry) {
  const db = await open();
  const id = `${entry.kind}:${entry.name}`;
  const bytes = estimateBytes(entry);
  const meta = {
    id,
    name: entry.name,
    kind: entry.kind,
    savedAt: Date.now(),
    bytes,
    nodes: entry.layout?.nodes?.length ?? 0,
    communities: entry.layout?.communities?.length ?? 0,
    files: Object.keys(entry.sources ?? {}).length,
    passages: entry.knowledge?.index?.size ?? 0,
  };

  {
    const { t, done } = tx(db, [META, DATA], 'readwrite');
    // Same name overwrites rather than accumulating duplicates: re-extracting
    // a repo means the newer build supersedes the older one.
    t.objectStore(META).put(meta);
    t.objectStore(DATA).put(entry, id);
    await done;
  }

  await evict(db);
  db.close();
  return id;
}

/** Drop the oldest entries until the store is within both limits. */
async function evict(db) {
  const { t } = tx(db, [META], 'readonly');
  const all = await wrap(t.objectStore(META).getAll());
  all.sort((a, b) => b.savedAt - a.savedAt); // newest first

  const doomed = [];
  let total = 0;
  all.forEach((m, i) => {
    total += m.bytes;
    if (i >= MAX_ENTRIES || total > MAX_TOTAL_BYTES) doomed.push(m.id);
  });
  if (!doomed.length) return;

  const { t: t2, done } = tx(db, [META, DATA], 'readwrite');
  for (const id of doomed) {
    t2.objectStore(META).delete(id);
    t2.objectStore(DATA).delete(id);
  }
  await done;
}

/** Metadata only — never loads a payload. Newest first. */
export async function listCorpora() {
  const db = await open();
  const { t } = tx(db, [META], 'readonly');
  const all = await wrap(t.objectStore(META).getAll());
  db.close();
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function loadCorpus(id) {
  const db = await open();
  const { t } = tx(db, [DATA], 'readonly');
  const payload = await wrap(t.objectStore(DATA).get(id));
  db.close();
  return payload ?? null;
}

export async function deleteCorpus(id) {
  const db = await open();
  const { t, done } = tx(db, [META, DATA], 'readwrite');
  t.objectStore(META).delete(id);
  t.objectStore(DATA).delete(id);
  await done;
  db.close();
}

export async function clearCorpora() {
  const db = await open();
  const { t, done } = tx(db, [META, DATA], 'readwrite');
  t.objectStore(META).clear();
  t.objectStore(DATA).clear();
  await done;
  db.close();
}

// --- recent queries ----------------------------------------------------------
// Small and per-corpus, so localStorage is the right size of tool here.

const Q_KEY = 'grapheon.queries.v1';
const MAX_QUERIES = 8;

export function recentQueries(corpus) {
  try {
    return JSON.parse(localStorage.getItem(Q_KEY) ?? '{}')[corpus] ?? [];
  } catch {
    return [];
  }
}

export function rememberQuery(corpus, query) {
  const q = query.trim();
  if (q.length < 2) return;
  try {
    const all = JSON.parse(localStorage.getItem(Q_KEY) ?? '{}');
    const list = [q, ...(all[corpus] ?? []).filter((x) => x !== q)].slice(0, MAX_QUERIES);
    localStorage.setItem(Q_KEY, JSON.stringify({ ...all, [corpus]: list }));
  } catch { /* private mode */ }
}
