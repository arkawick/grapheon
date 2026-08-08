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
// `android` matters: Capacitor syncs the BUILT dist (megabytes of minified
// one-line JS) into android/app/src/main/assets, and feeding that back into
// the parser stalls the whole check.
const SKIP = new Set(['.git', 'node_modules', 'dist', 'data', 'bench', 'android']);
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

// --- code viewer -------------------------------------------------------------
// Search rather than clicking the map: a deterministic entity with real source.
await page.click('.nav a[href="#/"]');
await page.fill('.search input', 'llm.py');
await page.waitForSelector('.results li', { timeout: 8000 });
await page.click('.results li');
await page.waitForSelector('.view-code', { timeout: 8000 });
await page.click('.view-code');
await page.waitForSelector('.code-pane .code-line', { timeout: 15000 });
await page.waitForTimeout(700);
const code = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  return {
    lines: document.querySelectorAll('.code-line').length,
    hljs: document.querySelectorAll('.code code span[class^="hljs-"]').length,
    marked: document.querySelectorAll('.code-line.marked').length,
    // The map must SHRINK beside the code, not be covered by it — pixi only
    // watches window resizes, so this asserts the ResizeObserver still works.
    canvasWidth: Math.round(canvas?.getBoundingClientRect().width ?? 0),
  };
});
await page.screenshot({ path: 'code-view.png' });
await page.click('.code-head .close');

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

// --- mobile pass: phone viewport, touch --------------------------------------
// hasTouch flips HAS_DIR_PICKER, so this also exercises the zip-only sidebar
// branch the Android shell ships with.
const mob = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const mpage = await mob.newPage();
mpage.on('console', (m) => { if (m.type() === 'error') errors.push('[mobile] ' + m.text()); });
mpage.on('pageerror', (e) => errors.push('[mobile] ' + String(e)));
await mpage.goto(URL, { waitUntil: 'networkidle' });
await mpage.waitForSelector('.corpus', { timeout: 20000 }); // foot is hidden on mobile
await mpage.waitForTimeout(600);

const folderBtnCount = await mpage.$$eval('.open-repo button:not(.alt)', (b) => b.length);
const zipBtnCount = await mpage.$$eval('.open-repo button.alt', (b) => b.length);
await mpage.screenshot({ path: 'mobile-atlas.png' });

// Legend opens from its toggle, picking a subsystem closes it and selects.
await mpage.tap('.legend-toggle');
await mpage.waitForSelector('.legend.open', { timeout: 5000 });
await mpage.tap('.communities button');
await mpage.waitForSelector('.detail', { timeout: 10000 });
await mpage.waitForTimeout(700);
await mpage.screenshot({ path: 'mobile-detail.png' });

// Blast page renders as a bottom sheet.
await mpage.tap('.nav a[href="#/blast"]');
await mpage.waitForSelector('.blast', { timeout: 10000 });
const sheet = await mpage.$eval('.blast', (el) => {
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), width: Math.round(r.width) };
});
await mpage.waitForTimeout(500);
await mpage.screenshot({ path: 'mobile-blast.png' });
await mob.close();

await browser.close();

console.log(`sidebar    : ${status.replace(/\s+/g, ' ').trim()}`);
console.log(`selected   : ${selected}`);
console.log(`connections: ${connections}`);
console.log(`blast      : ${tally}`);
console.log(`rings      : ${rings.join(' | ')}`);
console.log(`self-map   : ${selfStats} (${repoFiles.length} files extracted in-browser)`);
console.log(`code       : ${code.lines} lines, ${code.hljs} highlight spans, ${code.marked} gutter marks; map reflowed to ${code.canvasWidth}px`);
console.log(`mobile     : folder-btn=${folderBtnCount} (want 0) zip-btn=${zipBtnCount} (want 1); blast sheet top=${sheet.top}px width=${sheet.width}px`);
console.log(`screenshots: ${OUT}, blast.png, browser-extract.png, code-view.png, mobile-{atlas,detail,blast}.png`);
if (errors.length) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK — no console errors.');
