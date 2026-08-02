/**
 * Kill-test, part 1: can web-tree-sitter (WASM) replace graphify's Python
 * extraction?
 *
 * Parses the SAME corpus graphify extracted (Project-Aeon) and measures:
 *   - wall-clock parse + query time (the speed half of the verdict)
 *   - entity fidelity against graphify's graph.json ground truth: of the
 *     functions/classes graphify found, how many does a straightforward
 *     tree-sitter query find? (the fidelity half)
 *
 * Node and browser share the same WASM engine, so this file is the harness for
 * both: `node parse-bench.mjs` runs it directly; browser.html loads it via a
 * tiny shim that supplies file contents over fetch.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { Parser, Language, Query } from 'web-tree-sitter';

const AEON = 'C:/Users/Arkajyoti/Downloads/Project-Aeon';
const TRUTH = 'C:/Users/Arkajyoti/Downloads/App/data/aeon/graph.json';
const WASM_DIR = new URL('./node_modules/@vscode/tree-sitter-wasm/wasm/', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1'); // strip the leading slash Windows file URLs get

const SKIP_DIRS = new Set(['.git', 'node_modules', 'graphify-out', '__pycache__', 'dist']);

// Language -> { wasm, entity query }. The queries are deliberately SIMPLE —
// the point is to measure what a straightforward port achieves, not to
// hand-tune until the numbers look good.
const LANGS = {
  '.py': {
    wasm: 'tree-sitter-python.wasm',
    query: `
      (function_definition name: (identifier) @entity)
      (class_definition name: (identifier) @entity)
    `,
  },
  '.js': {
    wasm: 'tree-sitter-javascript.wasm',
    query: `
      (function_declaration name: (identifier) @entity)
      (class_declaration name: (identifier) @entity)
      (method_definition name: (property_identifier) @entity)
      (variable_declarator name: (identifier) @entity value: (arrow_function))
      (variable_declarator name: (identifier) @entity value: (function_expression))
    `,
  },
};
LANGS['.jsx'] = LANGS['.js'];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    // Aeon's odysseus model cache contains entries that stat() cannot touch
    // (junction into a locked HuggingFace cache). Unreadable = not part of the
    // corpus; the Python CLI skipped these too.
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (LANGS[extname(p)]) yield p;
  }
}

// --- Ground truth ------------------------------------------------------------
const truth = JSON.parse(readFileSync(TRUTH, 'utf8'));
const truthByFile = new Map();
for (const n of truth.nodes) {
  if (n.file_type !== 'code') continue;
  const file = n.source_file.replaceAll('\\', '/');
  if (!truthByFile.has(file)) truthByFile.set(file, new Set());
  // Entities are labelled "name()" — and methods as ".name()", with a leading
  // dot. Strip both; the file's own node (its basename) matches neither.
  if (n.label.endsWith('()')) {
    truthByFile.get(file).add(n.label.slice(0, -2).replace(/^\./, ''));
  }
}

// --- Parse -------------------------------------------------------------------
await Parser.init();
const languages = {};
for (const [ext, cfg] of Object.entries(LANGS)) {
  if (!languages[cfg.wasm]) {
    languages[cfg.wasm] = await Language.load(join(WASM_DIR, cfg.wasm));
  }
  cfg.lang = languages[cfg.wasm];
  cfg.q = new Query(cfg.lang, cfg.query);
}

const parser = new Parser();
let files = 0, bytes = 0, entities = 0;
let truthTotal = 0, found = 0;
const misses = [];

const t0 = performance.now();
for (const path of walk(AEON)) {
  const cfg = LANGS[extname(path)];
  const src = readFileSync(path, 'utf8');
  parser.setLanguage(cfg.lang);
  const tree = parser.parse(src);
  const names = new Set(
    cfg.q.captures(tree.rootNode).map((c) => c.node.text)
  );
  tree.delete();

  files++;
  bytes += src.length;
  entities += names.size;

  const rel = relative(AEON, path).replaceAll('\\', '/');
  const expected = truthByFile.get(rel);
  if (expected) {
    truthTotal += expected.size;
    for (const e of expected) {
      if (names.has(e)) found++;
      else misses.push(`${rel} :: ${e}`);
    }
  }
}
const ms = performance.now() - t0;

// --- Report ------------------------------------------------------------------
console.log(`files parsed   : ${files} (${(bytes / 1024).toFixed(0)} KB)`);
console.log(`entities found : ${entities}`);
console.log(`time           : ${ms.toFixed(0)} ms total, ${(ms / files).toFixed(1)} ms/file`);
console.log(`recall vs graphify: ${found}/${truthTotal} (${((found / truthTotal) * 100).toFixed(1)}%)`);
if (misses.length) {
  console.log(`\nmissed (${misses.length}):`);
  for (const m of misses.slice(0, 15)) console.log('  ' + m);
  if (misses.length > 15) console.log(`  … ${misses.length - 15} more`);
}
