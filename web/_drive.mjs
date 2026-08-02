/**
 * Visual smoke test for the Atlas.
 *
 * Usage:  npm run dev        (in one shell)
 *         npm run drive      (in another)
 *
 * Deliberately verifies via SCREENSHOT plus DOM state, and never by sampling
 * canvas pixels. Kagami learned this the expensive way: you cannot check that a
 * WebGL canvas painted by drawImage-ing it into a 2D canvas — without
 * `preserveDrawingBuffer` the readback is always blank, so a perfectly good map
 * reads as a failure. Trust the screenshot.
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const URL = process.env.GRAPHEON_URL || 'http://localhost:5180';
const OUT = 'atlas.png';

// A small real corpus for the in-browser extraction check: this repo itself.
const REPO = join(process.cwd(), '..');
const SKIP = new Set(['.git', 'node_modules', 'dist', 'data', 'bench']);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (['.py', '.js', '.jsx'].includes(extname(p))) yield p;
  }
}
const repoFiles = [...walk(REPO)].map((p) => ({
  path: relative(REPO, p).replaceAll('\\', '/'),
  src: readFileSync(p, 'utf8'),
}));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });

// The sidebar footer only renders once the layout has parsed.
await page.waitForSelector('.sidebar-foot', { timeout: 20000 });
const status = await page.textContent('.sidebar-foot');

const failed = await page.$('.status.error');
if (failed) {
  console.error('FAIL: app rendered its error state:', await failed.textContent());
  await browser.close();
  process.exit(1);
}

// Capture the RESTING map first. Selecting anything dims every non-neighbour
// to alpha 0.06, which against a near-black background is invisible — so a
// post-selection screenshot tells you nothing about whether the layout is good.
await page.waitForTimeout(600);
await page.screenshot({ path: 'atlas-resting.png' });

// Click the biggest subsystem in the legend: exercises focus(), the lazy edge
// fetch, adjacency building, and the detail panel in one gesture.
await page.click('.communities button');
await page.waitForSelector('.detail', { timeout: 10000 });
const selected = await page.textContent('.detail-head h2');
const connections = await page.textContent('.detail .meta dd:last-of-type');

await page.waitForTimeout(900); // let the focus animation settle before capture
await page.screenshot({ path: OUT });

// Navigate to Blast Radius. The selection must survive the route change, and
// the canvas must NOT be rebuilt — that is the whole point of mounting it
// above the router.
await page.click('.nav a[href="#/blast"]');
await page.waitForSelector('.blast', { timeout: 10000 });
await page.waitForTimeout(700);
const tally = (await page.textContent('.tally'))?.replace(/\s+/g, ' ').trim();
const rings = await page.$$eval('.ring h3', (hs) => hs.map((h) => h.textContent.trim()));
await page.screenshot({ path: 'blast.png' });

// --- in-browser extraction: the whole pipeline in a worker -----------------
// Drives the exact code path the folder picker uses, minus the picker.
await page.click('.nav a[href="#/"]');
await page.evaluate(
  ({ files }) => window.__loadRepoFiles(files, 'grapheon-self'),
  { files: repoFiles }
);
// The corpus badge flips when the worker's layout replaces the default one.
await page.waitForFunction(
  () => document.querySelector('.corpus')?.textContent === 'grapheon-self',
  { timeout: 60000 }
);
await page.waitForTimeout(800); // let the fresh map settle
const selfStats = (await page.textContent('.sidebar-foot')).replace(/\s+/g, ' ').trim();
await page.screenshot({ path: 'browser-extract.png' });

await browser.close();

console.log(`sidebar    : ${status.replace(/\s+/g, ' ').trim()}`);
console.log(`selected   : ${selected}`);
console.log(`connections: ${connections}`);
console.log(`blast      : ${tally}`);
console.log(`rings      : ${rings.join(' | ')}`);
console.log(`self-map   : ${selfStats} (${repoFiles.length} files extracted in-browser)`);
console.log(`screenshots: ${OUT}, blast.png, browser-extract.png`);
if (errors.length) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK — no console errors.');
