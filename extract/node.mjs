#!/usr/bin/env node
/**
 * Node CLI for the JS extractor.
 *
 *   node extract/node.mjs <repoDir> [--out graph.json]
 *
 * Walks the repo, parses .py/.js/.jsx with WASM tree-sitter, writes
 * graphify-shaped {nodes, links} JSON.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import { extractCorpus } from './src/extract.js';

// Resolve the grammar directory rather than assuming extract/node_modules:
// npm workspaces HOIST a dependency to the root when another workspace
// declares it too, so the hardcoded path breaks the moment web/ shares it.
const require = createRequire(import.meta.url);
const WASM = dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm'));
// `android` matters here too: cap sync copies the built dist (minified
// one-line bundles) into android/app/src/main/assets, and parsing those
// stalls the extractor — the same trap that bit the Playwright drive.
const SKIP = new Set(['.git', 'node_modules', 'graphify-out', '__pycache__', 'dist', '.venv', 'venv', 'android']);
// .tsx needs the TSX grammar specifically: the plain TypeScript grammar parses
// `<T>(x)` as a type assertion, so every JSX element in a .tsx file becomes a
// parse error and the file yields almost nothing.
const EXTS = {
  '.py': 'tree-sitter-python.wasm',
  '.js': 'tree-sitter-javascript.wasm',
  '.jsx': 'tree-sitter-javascript.wasm',
  '.ts': 'tree-sitter-typescript.wasm',
  '.mts': 'tree-sitter-typescript.wasm',
  '.cts': 'tree-sitter-typescript.wasm',
  '.tsx': 'tree-sitter-tsx.wasm',
};

const root = process.argv[2];
if (!root) { console.error('usage: node extract/node.mjs <repoDir> [--out file]'); process.exit(1); }
const outIdx = process.argv.indexOf('--out');
const out = outIdx !== -1 ? process.argv[outIdx + 1] : 'graph.extracted.json';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS[extname(p)]) yield p;
  }
}

await Parser.init();
const loaded = {};
const langs = {};
for (const [ext, wasm] of Object.entries(EXTS)) {
  if (!loaded[wasm]) {
    const language = await Language.load(join(WASM, wasm));
    const parser = new Parser();
    parser.setLanguage(language);
    loaded[wasm] = { language, parser };
  }
  langs[ext] = loaded[wasm];
}

const files = [];
for (const p of walk(root)) {
  files.push({ path: relative(root, p).replaceAll('\\', '/'), src: readFileSync(p, 'utf8') });
}

const t0 = performance.now();
const graph = extractCorpus(files, langs);
const ms = performance.now() - t0;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(graph));
console.log(`${files.length} files -> ${graph.nodes.length} nodes, ${graph.links.length} links in ${ms.toFixed(0)} ms`);
console.log(`wrote ${out}`);

// Source text for the code viewer, written beside the graph.
//
// Only files the graph actually references — a repo's parseable files and its
// *mapped* files are not the same set, and shipping the difference is dead
// weight. This is the one moment the text is in hand: the CLI has already read
// every file, and by the time pipeline/build.js runs it only has the graph.
const referenced = new Set(
  graph.nodes.map((n) => n.source_file).filter(Boolean)
);
const sources = {};
for (const f of files) {
  if (referenced.has(f.path)) sources[f.path] = f.src;
}
const srcOut = join(dirname(out), 'sources.json');
writeFileSync(srcOut, JSON.stringify(sources));
const mb = (statSync(srcOut).size / 1e6).toFixed(2);
console.log(`wrote ${srcOut} (${Object.keys(sources).length} files, ${mb} MB)`);
