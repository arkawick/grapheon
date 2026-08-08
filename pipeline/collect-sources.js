#!/usr/bin/env node
/**
 * Capture source text for the code viewer, for a corpus whose graph came from
 * somewhere that didn't keep it — the graphify CLI, or an older extraction.
 *
 *   node pipeline/collect-sources.js --name aeon --repo ../Project-Aeon
 *
 * Reads data/<name>/graph.canonical.json, collects the files its nodes
 * reference, and writes data/<name>/sources.json — the same artifact
 * extract/node.mjs emits inline, so `npm run build:graph` treats both the
 * same way.
 *
 * Only referenced files: a repo's parseable files and its *mapped* files are
 * different sets, and shipping the difference is dead weight.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, fallback) {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  if (i !== -1 && a[i + 1]) return a[i + 1];
  const eq = a.find((x) => x.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : fallback;
}

const name = arg('--name');
const repo = arg('--repo');
if (!name || !repo) {
  console.error('usage: node pipeline/collect-sources.js --name <corpus> --repo <path>');
  process.exit(1);
}

const canonPath = path.join(ROOT, 'data', name, 'graph.canonical.json');
if (!fs.existsSync(canonPath)) {
  console.error(`No canonical graph at ${canonPath}`);
  process.exit(1);
}

const canonical = JSON.parse(fs.readFileSync(canonPath, 'utf8'));
const paths = [...new Set(
  canonical.nodes.map((n) => n.attrs?.path).filter(Boolean)
)];

const sources = {};
let bytes = 0, missing = 0;
for (const rel of paths) {
  const abs = path.join(repo, rel);
  try {
    const text = fs.readFileSync(abs, 'utf8');
    sources[rel] = text;
    bytes += Buffer.byteLength(text);
  } catch {
    missing++; // file moved or deleted since extraction; the viewer just won't offer it
  }
}

const out = path.join(ROOT, 'data', name, 'sources.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(sources));
console.log(`${Object.keys(sources).length}/${paths.length} referenced files captured (${(bytes / 1e6).toFixed(2)} MB)`);
if (missing) console.log(`  ${missing} unreadable/missing — skipped`);
console.log(`wrote ${path.relative(ROOT, out)}`);
