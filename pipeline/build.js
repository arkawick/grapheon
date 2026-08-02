#!/usr/bin/env node
/**
 * Grapheon build: extractor output -> canonical graph -> layout artifact.
 *
 *   node pipeline/build.js --source graphify --in data/aeon/graph.json --name aeon
 *
 * Writes two files:
 *   data/<name>/graph.canonical.json   portable, committed, extractor-agnostic
 *   web/public/data/<name>.layout.json positioned nodes, the only thing the app loads
 *
 * The canonical file is written even though only the layout is served, because
 * it is the seam: swapping extractors means writing one adapter, and having the
 * intermediate on disk is what makes that claim checkable rather than aspirational.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from './layout.js';
import * as graphifyAdapter from './adapters/graphify.js';

/**
 * Identifies a build by its INPUTS, so two reproducible runs produce the same
 * id and a changed corpus produces a different one.
 *
 * Stamped into both output files. The app refuses to mix them when the ids
 * disagree — without that, a browser holding a cached layout.json against a
 * fresh edges.json resolves fewer node ids and quietly returns a SMALLER blast
 * radius. A wrong impact number that looks plausible is worse than an error.
 */
function buildId(canonical, iterations, seed) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(canonical.nodes))
    .update(JSON.stringify(canonical.edges))
    .update(`${iterations}:${seed}`)
    .digest('hex')
    .slice(0, 12);
}

const ADAPTERS = {
  graphify: graphifyAdapter,
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback) {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  if (i !== -1 && a[i + 1]) return a[i + 1];
  const eq = a.find((x) => x.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  return fallback;
}

function main() {
  const source = arg('--source', 'graphify');
  const name = arg('--name', 'aeon');
  const input = arg('--in', path.join('data', name, 'graph.json'));
  const iterations = Number(arg('--iterations', 600));

  const adapter = ADAPTERS[source];
  if (!adapter) {
    throw new Error(`Unknown --source "${source}". Available: ${Object.keys(ADAPTERS).join(', ')}`);
  }

  const inPath = path.isAbsolute(input) ? input : path.join(ROOT, input);
  if (!fs.existsSync(inPath)) {
    throw new Error(`No extractor output at ${inPath}\nRun:  graphify update <repo> --no-cluster`);
  }

  console.log(`Reading ${source} output from ${inPath} ...`);
  const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));

  const canonical = adapter.adapt(raw, name);
  const c = canonical.meta.counts;
  console.log(`  ${c.nodes} nodes, ${c.edges} edges (${c.materialised_external} external endpoints materialised)`);

  const canonPath = path.join(ROOT, 'data', name, 'graph.canonical.json');
  fs.mkdirSync(path.dirname(canonPath), { recursive: true });
  fs.writeFileSync(canonPath, JSON.stringify(canonical));

  const seed = Number(arg('--seed', 1));
  const layout = build(canonical, { iterations, seed, log: (m) => console.log(m) });

  const id = buildId(canonical, iterations, seed);
  layout.meta.buildId = id;

  const outPath = path.join(ROOT, 'web', 'public', 'data', `${name}.layout.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(layout));

  // Edges ship SEPARATELY from the layout, and the app fetches them lazily on
  // the first node click. The map itself never draws them (see layout.js), so
  // making the first paint wait on them would be paying for something nobody
  // sees. They exist so that selecting a node can light up its neighbourhood —
  // the Blast Radius primitive — with no backend involved.
  //
  // Weight is dropped here: it was a layout input, and the UI cares about the
  // relation and its EXTRACTED/INFERRED provenance instead.
  const edgePath = path.join(ROOT, 'web', 'public', 'data', `${name}.edges.json`);
  const edges = canonical.edges.map(([s, t, , rel, conf]) => [s, t, rel, conf]);
  fs.writeFileSync(edgePath, JSON.stringify({ meta: { buildId: id }, edges }));
  const ekb = (fs.statSync(edgePath).size / 1e3).toFixed(0);
  console.log(`Wrote ${path.relative(ROOT, edgePath)} (${edges.length} edges, ${ekb} KB, lazy-loaded)`);

  const mb = (fs.statSync(outPath).size / 1e6).toFixed(2);
  console.log(`\nWrote ${path.relative(ROOT, outPath)} (${layout.nodes.length} nodes, ${mb} MB)`);
  console.log(`  ${layout.communities.length} communities, kinds: ${layout.kinds.join(', ')}`);
  console.log('\nTop communities:');
  for (const cm of layout.communities.slice(0, 8)) {
    console.log(`  ${String(cm.size).padStart(4)}  ${cm.label}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
}
