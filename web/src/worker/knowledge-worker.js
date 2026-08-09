/**
 * Knowledge base build, in a Worker: parse -> graph -> layout -> index.
 *
 * Same shape as the code extractor's worker, and for the same reason: chunking
 * a few hundred pages and then running ForceAtlas2 over the result is seconds
 * of pure CPU, and doing it on the main thread would freeze the map mid-gesture.
 *
 * The BM25 index is built HERE and posted back whole. It is plain data (maps of
 * counts), so structured clone handles it, and the alternative — re-tokenising
 * every passage on the main thread — is the expensive half done twice.
 */
import { parseDocument } from '../lib/knowledge/parse.js';
import { buildKnowledgeGraph } from '../lib/knowledge/graph.js';
import { buildIndex } from '../lib/knowledge/bm25.js';
import { build as layout } from '../../../pipeline/layout.js';

const progress = (stage, detail = '') => postMessage({ type: 'progress', stage, detail });

onmessage = async (e) => {
  const { files, name } = e.data;
  try {
    progress('parse', `${files.length} documents`);

    // Paths must be unique before anything else: they are the node ids, and a
    // multi-file picker with no directory info gives every file its bare name
    // — three README.md files from three folders then collide and graphology
    // refuses to build the graph at all.
    const seen = new Set();
    const unique = files.map((f) => {
      let path = f.path;
      if (seen.has(path)) {
        const dot = path.lastIndexOf('.');
        const stem = dot === -1 ? path : path.slice(0, dot);
        const ext = dot === -1 ? '' : path.slice(dot);
        let n = 2;
        while (seen.has(`${stem} (${n})${ext}`)) n++;
        path = `${stem} (${n})${ext}`;
      }
      seen.add(path);
      return { ...f, path };
    });

    // Everything arriving here is already TEXT. PDFs were converted on the
    // main thread (see lib/knowledge/pdf.js for why), so this worker knows
    // nothing about formats.
    const resolved = unique;
    const documents = resolved.map(parseDocument);

    const passages = [];
    for (const d of documents) for (const s of d.sections) passages.push(...s.passages);
    progress('parse', `${documents.length} docs, ${passages.length} passages`);

    if (!passages.length) {
      postMessage({ type: 'error', message: 'No readable text found in those files.' });
      return;
    }

    progress('index', `indexing ${passages.length} passages`);
    const index = buildIndex(passages);

    progress('graph', 'building document graph');
    const canonical = buildKnowledgeGraph(documents, name);
    progress('graph', `${canonical.nodes.length} nodes, ${canonical.edges.length} edges`);

    progress('layout', 'ForceAtlas2');
    const laidOut = layout(canonical, { log: (m) => progress('layout', m.trim()) });

    const edges = canonical.edges.map(([s, t, , rel, conf]) => [s, t, rel, conf]);

    postMessage({
      type: 'result',
      layout: laidOut,
      edges,
      index,
      // Extracted text goes back so the code pane can show a PDF's contents —
      // it cannot render the original, and the line numbers passages point at
      // are lines of THIS text.
      texts: resolved.map(({ path, text }) => ({ path, text })),
      // Sections carry their passages for the query panel; the map only needs
      // the nodes, which are already in `layout`.
      documents: documents.map((d) => ({
        path: d.path,
        title: d.title,
        sections: d.sections.map((s) => ({ id: s.id, heading: s.heading, line: s.line })),
      })),
    });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
