#!/usr/bin/env node
/**
 * Score the JS extractor's links against graphify's, per relation.
 *
 *   node extract/score.mjs graph.extracted.json
 *
 * Compares (source, target, relation) triples over the file types both sides
 * parse (.py/.js/.jsx). Recall = of graphify's links, how many we produced.
 * Precision = of ours, how many graphify agrees with. Precision here is soft —
 * a link graphify lacks is not automatically wrong — but a low number flags
 * over-generation.
 */
import { readFileSync } from 'node:fs';

const TRUTH = 'C:/Users/Arkajyoti/Downloads/App/data/aeon/graph.json';
const OURS = process.argv[2] ?? 'graph.extracted.json';
const CODE_EXT = /\.(py|jsx?)$/;

const truth = JSON.parse(readFileSync(TRUTH, 'utf8'));
const ours = JSON.parse(readFileSync(OURS, 'utf8'));

const key = (l) => `${l.source}\x00${l.target}\x00${l.relation}`;

const inScope = (l) => CODE_EXT.test(l.source_file ?? '');
const truthLinks = truth.links.filter(inScope);

// Precision is only meaningful over files graphify actually processed — our
// walk covers ~12x more files (vendored/setup trees its boundary skips), and
// links from those are unknowable to it, not wrong.
const truthFiles = new Set(truthLinks.map((l) => l.source_file));
const ourLinks = ours.links.filter((l) => truthFiles.has(l.source_file));

const truthSet = new Set(truthLinks.map(key));
const ourSet = new Set(ourLinks.map(key));

const relations = [...new Set(truthLinks.map((l) => l.relation))].sort();
console.log('relation        truth   found  recall   ours  precision');
let tTotal = 0, tFound = 0;
for (const rel of relations) {
  const t = truthLinks.filter((l) => l.relation === rel);
  const o = ourLinks.filter((l) => l.relation === rel);
  const found = t.filter((l) => ourSet.has(key(l))).length;
  const agreed = o.filter((l) => truthSet.has(key(l))).length;
  tTotal += t.length; tFound += found;
  console.log(
    rel.padEnd(15),
    String(t.length).padStart(5),
    String(found).padStart(7),
    `${((found / t.length) * 100).toFixed(1)}%`.padStart(7),
    String(o.length).padStart(6),
    o.length ? `${((agreed / o.length) * 100).toFixed(1)}%`.padStart(9) : '      n/a'
  );
}
console.log('-'.repeat(60));
console.log(`TOTAL recall: ${tFound}/${tTotal} (${((tFound / tTotal) * 100).toFixed(1)}%)`);

// Top misses per relation, for iteration.
const relArg = process.argv[3];
if (relArg) {
  console.log(`\nmisses for ${relArg}:`);
  let n = 0;
  for (const l of truthLinks) {
    if (l.relation !== relArg || ourSet.has(key(l))) continue;
    console.log(`  ${l.source} -> ${l.target}  (${l.source_file} ${l.source_location})`);
    if (++n >= 25) break;
  }
}
