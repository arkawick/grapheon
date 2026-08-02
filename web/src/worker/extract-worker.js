/**
 * The whole pipeline, in a Worker: parse -> extract -> adapt -> layout.
 *
 * A worker because both ends are CPU-bound — WASM parsing runs ~8 ms/file and
 * ForceAtlas2 is seconds of pure math; on the main thread either would freeze
 * the Atlas mid-gesture.
 *
 * Receives { files: [{path, src}], name }, posts { type: 'progress' } events
 * and finally { type: 'result', layout, edges } — the same two artifacts
 * `pipeline/build.js` writes to disk, minus the disk.
 *
 * The ?url imports make Vite serve the WASM binaries as assets; nothing here
 * fetches from anywhere but our own origin.
 */
import { Parser, Language } from 'web-tree-sitter';
import { extractCorpus } from '../../../extract/src/extract.js';
import { adapt } from '../../../pipeline/adapters/graphify.js';
import { build } from '../../../pipeline/layout.js';

import engineWasm from 'web-tree-sitter/web-tree-sitter.wasm?url';
import pythonWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url';
import javascriptWasm from '@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm?url';

const progress = (stage, detail = '') => postMessage({ type: 'progress', stage, detail });

let ready = null;
async function init() {
  await Parser.init({ locateFile: () => engineWasm });
  const py = await Language.load(pythonWasm);
  const js = await Language.load(javascriptWasm);
  const mk = (language) => {
    const parser = new Parser();
    parser.setLanguage(language);
    return { language, parser };
  };
  const pyLang = mk(py);
  const jsLang = mk(js);
  return { '.py': pyLang, '.js': jsLang, '.jsx': jsLang };
}

onmessage = async (e) => {
  const { files, name } = e.data;
  try {
    progress('init', 'loading parsers');
    const langs = await (ready ??= init());

    progress('extract', `parsing ${files.length} files`);
    const t0 = performance.now();
    const raw = extractCorpus(files, langs);
    progress('extract', `${raw.nodes.length} nodes, ${raw.links.length} links in ${Math.round(performance.now() - t0)} ms`);

    const canonical = adapt(raw, name, 'in-browser wasm');

    progress('layout', `ForceAtlas2 over ${canonical.nodes.length} nodes`);
    const t1 = performance.now();
    const layout = build(canonical, { log: (m) => progress('layout', m.trim()) });
    progress('layout', `done in ${Math.round(performance.now() - t1)} ms`);

    // Same shape the static .edges.json carries; weight was a layout input.
    const edges = canonical.edges.map(([s, t, , rel, conf]) => [s, t, rel, conf]);

    postMessage({ type: 'result', layout, edges });
  } catch (err) {
    postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
