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
const mapped = [...new Set(
  canonical.nodes.map((n) => n.attrs?.path).filter(Boolean)
)];

// Beyond the files the GRAPH references, capture the ones a reader needs to
// understand the repo at all: README, package.json, the compose file, CI YAML.
// The extractor never parses these, so they have no nodes — and before the
// file explorer existed they were simply invisible.
//
// Matched by NAME, not extension. An extension whitelist looked reasonable and
// pulled in 17.6 MB of data dumps and fixtures from Aeon's setup trees — an
// APK-doubling amount of text nobody would ever open. "Which files explain
// this project" is a question about filenames, not suffixes.
const DOC_PATTERNS = [
  /^readme/i, /^changelog/i, /^contributing/i, /^license/i, /^architecture/i,
  /^claude\.md$/i, /^agents\.md$/i, /\.md$/i, /\.rst$/i,
];
const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'setup.cfg', 'requirements.txt',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'Gemfile',
  'tsconfig.json', 'vite.config.js', 'Makefile', 'Procfile',
  '.env.example', 'env.example',
]);
const CONTAINER_CI = [
  /^dockerfile/i, /^docker-compose.*\.ya?ml$/i, /^jenkinsfile$/i,
  /^\.gitlab-ci\.ya?ml$/i, /^capacitor\.config\.json$/i,
];
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'graphify-out', '__pycache__', 'dist', '.venv',
  'venv', 'build', 'target', '.gradle', '.next', 'coverage', 'out',
  // Tooling scratch space. `.claude/worktrees` in particular holds whole
  // COPIES of the repo, so without this the tree shows four identical
  // README.md rows and the top hit is a one-line stub from a worktree.
  '.claude', '.idea', '.vscode', '.pytest_cache', '.mypy_cache',
  'site-packages', '.tox', '.cache',
]);
const MAX_BYTES = 512 * 1024;          // a doc larger than this is a data file
const EXTRA_BUDGET = 2 * 1024 * 1024;  // total for non-graph files

const isWorkflow = (rel) => /(^|\/)\.github\/workflows\/.+\.ya?ml$/i.test(rel);
const isInteresting = (rel) => {
  const b = path.basename(rel);
  return DOC_PATTERNS.some((r) => r.test(b))
    || MANIFEST_NAMES.has(b)
    || CONTAINER_CI.some((r) => r.test(b))
    || isWorkflow(rel);
};

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const mappedSet = new Set(mapped);
const extra = [];
for (const abs of walk(repo)) {
  const rel = path.relative(repo, abs).replaceAll('\\', '/');
  if (mappedSet.has(rel) || !isInteresting(rel)) continue;
  extra.push(rel);
}
// Shallowest first: a repo's top-level README explains more than the twelfth
// one buried in a vendored subtree, and the budget should spend there.
extra.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

const sources = {};
let bytes = 0, extraBytes = 0, missing = 0, skipped = 0;

const take = (rel, budgeted) => {
  const abs = path.join(repo, rel);
  try {
    const st = fs.statSync(abs);
    if (st.size > MAX_BYTES) { skipped++; return; }
    if (budgeted && extraBytes + st.size > EXTRA_BUDGET) { skipped++; return; }
    const text = fs.readFileSync(abs, 'utf8');
    // Minified bundles are technically text and useless to read.
    if (text.length > 20000 && text.length / (text.split('\n').length || 1) > 400) { skipped++; return; }
    sources[rel] = text;
    const n = Buffer.byteLength(text);
    bytes += n;
    if (budgeted) extraBytes += n;
  } catch {
    missing++; // moved, deleted, or not valid UTF-8; the viewer just won't offer it
  }
};

for (const rel of mapped) take(rel, false); // graph files are never budgeted out
for (const rel of extra) take(rel, true);

const out = path.join(ROOT, 'data', name, 'sources.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(sources));
const total = Object.keys(sources).length;
console.log(
  `${total} files captured, ${(bytes / 1e6).toFixed(2)} MB — ` +
  `${mapped.length} on the graph, ${total - mapped.length} docs/manifests ` +
  `(${(extraBytes / 1e6).toFixed(2)} MB of ${(EXTRA_BUDGET / 1e6).toFixed(0)} MB budget)`
);
if (skipped) console.log(`  ${skipped} too large / over budget / minified — skipped`);
if (missing) console.log(`  ${missing} unreadable/missing — skipped`);
console.log(`wrote ${path.relative(ROOT, out)}`);
