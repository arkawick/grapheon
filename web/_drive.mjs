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

const URL = process.env.GRAPHEON_URL || 'http://localhost:5180';
const OUT = 'atlas.png';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });

// The status bar only renders once the layout has parsed and the renderer is up.
await page.waitForSelector('.statusbar', { timeout: 20000 });
const status = await page.textContent('.statusbar');

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

await browser.close();

console.log(`status bar : ${status.replace(/\s+/g, ' ').trim()}`);
console.log(`selected   : ${selected}`);
console.log(`connections: ${connections}`);
console.log(`screenshot : ${OUT}`);
if (errors.length) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK — no console errors.');
