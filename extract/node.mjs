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
import { Parser, Language } from 'web-tree-sitter';
import { extractCorpus } from './src/extract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
const SKIP = new Set(['.git', 'node_modules', 'graphify-out', '__pycache__', 'dist', '.venv', 'venv']);
const EXTS = { '.py': 'tree-sitter-python.wasm', '.js': 'tree-sitter-javascript.wasm', '.jsx': 'tree-sitter-javascript.wasm' };

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
