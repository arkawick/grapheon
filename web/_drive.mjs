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

// A change set of several entities is one traversal, not a union of separate
// ones: something two hops from each root is two hops away, not six.
const singleTotal = await page.textContent('.tally .big');
await page.click('.chip.add');
await page.waitForTimeout(300);
await page.fill('.search input', 'instances.py');
await page.waitForSelector('.results li', { timeout: 8000 });
await page.click('.results li');
await page.waitForTimeout(300);
await page.click('.chip.add');
await page.waitForTimeout(500);
const multi = await page.evaluate(() => ({
  total: document.querySelector('.tally .big')?.textContent,
  chips: document.querySelectorAll('.change-set .chip:not(.add)').length,
}));
const impactDl = page.waitForEvent('download', { timeout: 15000 });
await page.click('.blast .view-code');
const impactFile = (await impactDl).suggestedFilename();

// --- insights ----------------------------------------------------------------
// Computed, not asked for. The entry-point split is the load-bearing part: raw
// "unreferenced" was 156 of Aeon's 335 callables, a list nobody would trust.
await page.click('.nav a[href="#/insights"]');
await page.waitForSelector('.ins-tabs', { timeout: 15000 });
await page.waitForTimeout(600);
const insights = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('.ins-tabs button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
  topHub: document.querySelector('.ins-row .ins-label')?.textContent,
}));
await page.click('.ins-tabs button:nth-child(2)');
await page.waitForTimeout(250);
insights.excluded = await page.evaluate(() =>
  /(\d+) more look like framework/.exec(document.querySelector('.insights .caveat')?.textContent ?? '')?.[1] ?? '0');
const reportDl = page.waitForEvent('download', { timeout: 15000 });
await page.click('.ins-actions button');
insights.report = (await reportDl).suggestedFilename();
await page.screenshot({ path: 'insights.png' });

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

// --- file explorer -----------------------------------------------------------
// The point of the tree is reaching files the GRAPH never saw — a README has
// no node, and before the explorer existed it was unreachable.
await page.click('.files-toggle');
await page.waitForSelector('.filetree .tree-row', { timeout: 10000 });
await page.fill('.tree-head input', 'README');
await page.waitForTimeout(400);
await page.click('.tree-row.file');
await page.waitForSelector('.code-pane .code-line', { timeout: 10000 });
await page.waitForTimeout(500);
const tree = await page.evaluate(() => ({
  rows: document.querySelectorAll('.tree-row').length,
  mapped: document.querySelectorAll('.tree-dot:not(.unmapped)').length,
  unmapped: document.querySelectorAll('.tree-dot.unmapped').length,
  openedPath: document.querySelector('.code-title .mono')?.textContent,
  total: document.querySelector('.tree-foot')?.textContent?.trim(),
}));
// Dragging the code divider must resize the pane AND reflow the map live —
// the map is a canvas, so nothing about that is automatic.
const beforeDrag = await page.evaluate(() => ({
  code: Math.round(document.querySelector('.code-pane').getBoundingClientRect().width),
  canvas: Math.round(document.querySelector('canvas').getBoundingClientRect().width),
}));
const dividers = await page.$$('.divider');
const dBox = await dividers[dividers.length - 1].boundingBox();
await page.mouse.move(dBox.x + 2, dBox.y + dBox.height / 2);
await page.mouse.down();
await page.mouse.move(dBox.x - 140, dBox.y + dBox.height / 2, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(400);
const afterDrag = await page.evaluate(() => ({
  code: Math.round(document.querySelector('.code-pane').getBoundingClientRect().width),
  canvas: Math.round(document.querySelector('canvas').getBoundingClientRect().width),
}));
const resize = { beforeDrag, afterDrag, count: dividers.length };

await page.screenshot({ path: 'explorer.png' });
await page.click('.code-head .close');
await page.click('.explore-toggles button:nth-child(1)');

// --- cross-file search + tabs ------------------------------------------------
// The question the graph cannot answer: where a literal string appears. Also
// exercises tabs, since each hit opens another file.
await page.click('.explore-toggles button:nth-child(2)');
await page.waitForSelector('.searchpanel input', { timeout: 8000 });
await page.fill('.searchpanel input', 'AZURE_OPENAI_ENDPOINT');
const searchStart = Date.now();
await page.waitForFunction(
  () => (document.querySelector('.searchpanel .tree-foot')?.textContent ?? '').includes('matches in'),
  { timeout: 60000 }
);
const searchMs = Date.now() - searchStart;
const searchFoot = (await page.textContent('.searchpanel .tree-foot')).trim();

// A hit opens its file AT that line.
await page.click('.hit');
await page.waitForSelector('.code-pane .code-line', { timeout: 10000 });
await page.waitForTimeout(400);
const jumped = await page.evaluate(() => ({
  path: document.querySelector('.code-title .mono')?.textContent,
  target: document.querySelector('.code-line.target')?.dataset.line,
}));

// A second file from another group gives us tabs.
const groups = await page.$$('.hit-file');
if (groups.length > 1) {
  await groups[1].$eval('.hit', (el) => el.click());
  await page.waitForTimeout(600);
}
const tabsInfo = await page.evaluate(() => ({
  open: [...document.querySelectorAll('.tab-label')].map((e) => e.textContent),
  active: document.querySelector('.tab.active .tab-label')?.textContent ?? null,
}));
await page.screenshot({ path: 'search-tabs.png' });
await page.click('.code-head .close');
await page.click('.explore-toggles button:nth-child(2)');

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

// --- knowledge base ----------------------------------------------------------
// A second corpus type entirely: documents rather than code, retrieved by
// BM25 rather than traversed. It reuses the same graph pipeline, so this also
// proves the Atlas renders something that is not a codebase.
const mdFiles = repoFiles.length ? [] : [];
{
  const { readdirSync } = await import('node:fs');
  for (const dir of [REPO, join(REPO, 'docs')]) {
    for (const n of readdirSync(dir)) {
      if (/\.md$/i.test(n)) mdFiles.push({ path: n, text: readFileSync(join(dir, n), 'utf8') });
    }
  }
}
// Plus a generated PDF, so the pdf.js path and the font-size heading
// heuristic are exercised on every run.
const { makeTestPdf } = await import('./_fixture-pdf.mjs');
const pdfBytes = [...makeTestPdf()];

// Reproduce an ordinary browser. Playwright's bundled Chromium ships
// Uint8Array.prototype.toHex (ES2025); most real browsers and Android WebViews
// do not, and pdf.js's default build calls it while fingerprinting a document
// — "hashOriginal.toHex is not a function". Removing it here is what makes
// this check able to catch that class of bug at all, instead of passing on a
// browser newer than the users'.
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(300);
const hadToHex = await page.evaluate(() => {
  const had = typeof Uint8Array.prototype.toHex === 'function';
  delete Uint8Array.prototype.toHex;
  return had;
});
await page.evaluate(({ docs, pdf }) => window.__ingestDocuments(
  [...docs, { path: 'retrieval.pdf', data: new Uint8Array(pdf).buffer }],
  'grapheon-docs'
), { docs: mdFiles, pdf: pdfBytes });
await page.waitForFunction(
  () => document.querySelector('.corpus')?.textContent === 'grapheon-docs',
  { timeout: 90000 }
);
await page.click('.nav a[href="#/knowledge"]');
await page.waitForSelector('.kb-query', { timeout: 10000 });
// Query terms that only exist inside the PDF: proves pdf.js text made it all
// the way into the index, not merely that the file was accepted.
await page.fill('.kb-query', 'term saturation length normalisation');
await page.waitForTimeout(500);
const pdfHit = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.kb-hit')]
    .find((e) => e.querySelector('.kb-source')?.textContent.includes('retrieval.pdf'));
  return el && {
    heading: el.querySelector('.kb-heading')?.textContent,
    source: el.querySelector('.kb-source')?.textContent,
  };
});

await page.fill('.kb-query', 'how does blast radius certainty work');
await page.waitForTimeout(500);
const kb = await page.evaluate(() => ({
  stats: document.querySelector('.knowledge .question')?.textContent.replace(/\s+/g, ' ').trim(),
  hits: document.querySelectorAll('.kb-hit').length,
  top: document.querySelector('.kb-heading')?.textContent,
  marks: document.querySelectorAll('.kb-text mark').length,
  nodes: document.querySelector('.sidebar-foot')?.textContent.replace(/\s+/g, ' ').trim(),
}));
// A hit opens its source document at the passage's own line.
await page.click('.kb-hit');
await page.waitForSelector('.code-pane .code-line', { timeout: 10000 });
await page.waitForTimeout(400);
kb.opened = await page.evaluate(() => document.querySelector('.code-title .mono')?.textContent);
await page.screenshot({ path: 'knowledge.png' });
await page.click('.code-head .close');

// --- history -----------------------------------------------------------------
// Two corpora were built above (a code one, then a knowledge one that replaced
// it). Restoring must bring the first back WITH its sources, not just its map.
await page.click('.nav a[href="#/history"]');
await page.waitForSelector('.hist-item', { timeout: 10000 });
// Entries are grouped by corpus now, with the version hash on the row — so
// the NAME lives on the group heading.
const saved = await page.$$eval('.hist-group', (gs) => gs.map((g) => ({
  name: g.querySelector('h3')?.textContent.replace(/\s+/g, ' ').trim(),
  versions: g.querySelectorAll('.hist-item').length,
})));
// Diff needs two builds of ONE corpus. Rebuild grapheon-self with a file
// removed: same name, different content, so history keeps both as versions.
await page.evaluate(({ files }) => window.__loadRepoFiles(files.slice(0, -1), 'grapheon-self'), { files: repoFiles });
await page.waitForFunction(
  () => document.querySelector('.corpus')?.textContent === 'grapheon-self', { timeout: 60000 });
await page.waitForTimeout(600);
await page.click('.nav a[href="#/history"]');
await page.waitForSelector('.hist-item', { timeout: 10000 });
const versionsOfSelf = await page.$$eval('.hist-group', (gs) => {
  const g = gs.find((x) => x.querySelector('h3')?.textContent.includes('grapheon-self'));
  return g ? g.querySelectorAll('.hist-item').length : 0;
});
let diffSummary = 'not run';
if (versionsOfSelf >= 2) {
  const btns = await page.$$('.hist-group:has(h3:text-matches("grapheon-self")) .hist-actions button:nth-child(2)');
  const pick = btns.length >= 2 ? btns : await page.$$('.hist-actions button:nth-child(2)');
  await pick[0].click();
  await pick[1].click();
  await page.waitForTimeout(200);
  await page.click('.history .view-code');
  await page.waitForSelector('.diff-tally', { timeout: 15000 });
  await page.waitForTimeout(300);
  diffSummary = await page.evaluate(() => {
    const t = document.querySelector('.diff-tally')?.textContent.replace(/\s+/g, ' ').trim();
    const drift = document.querySelectorAll('.drift-row').length;
    const removed = [...document.querySelectorAll('.ring h3')]
      .find((h) => h.textContent.includes('Files removed'))?.textContent.replace(/\s+/g, ' ').trim();
    return `${t}; ${drift} drift; ${removed ?? 'no files removed'}`;
  });
  await page.click('.chip.add'); // back to history
  await page.waitForTimeout(300);
}

const restoreStart = Date.now();
await page.click('.hist-item:not(.active) .hist-actions button');
await page.waitForFunction(
  () => document.querySelector('.corpus')?.textContent === 'grapheon-self',
  { timeout: 30000 }
);
const restoreMs = Date.now() - restoreStart;
// Sources must survive the round trip, or "restore" only restored a picture.
await page.click('.nav a[href="#/"]');
await page.fill('.search input', 'AtlasRenderer');
await page.waitForSelector('.results li', { timeout: 8000 });
await page.click('.results li');
await page.waitForSelector('.view-code', { timeout: 8000 });
await page.click('.view-code');
await page.waitForSelector('.code-pane .code-line', { timeout: 10000 });
const restoredSource = await page.evaluate(() => ({
  path: document.querySelector('.code-title .mono')?.textContent,
  lines: document.querySelectorAll('.code-line').length,
}));
await page.click('.code-head .close');

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
await mpage.waitForSelector('.topbar-compact', { timeout: 20000 });
await mpage.waitForTimeout(600);

// The compact bar must not overflow. It once needed 504px inside 390px, which
// pushed "Open a repo .zip…" entirely off-screen — a phone had no way to load
// a repo at all.
const bar = await mpage.evaluate(() => {
  const el = document.querySelector('.topbar-compact');
  return { width: Math.round(el.getBoundingClientRect().width), content: el.scrollWidth };
});
await mpage.screenshot({ path: 'mobile-atlas.png' });

// Everything else lives behind the logo. Assert the upload button is actually
// ON SCREEN, not merely present in the DOM — that distinction was the bug.
await mpage.tap('.menu-btn');
await mpage.waitForTimeout(350);
const drawer = await mpage.evaluate(() => {
  const onScreen = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth;
  };
  return {
    zipVisible: onScreen('.open-repo button.alt'),
    folderVisible: onScreen('.open-repo button:not(.alt)'), // absent on touch
    navCount: document.querySelectorAll('.sidebar.drawer .nav a').length,
  };
});
await mpage.screenshot({ path: 'mobile-drawer.png' });

// Navigating from the drawer closes it.
await mpage.tap('.sidebar.drawer .nav a[href="#/blast"]');
await mpage.waitForSelector('.blast', { timeout: 10000 });
await mpage.waitForTimeout(300);
const drawerClosed = await mpage.evaluate(() => !document.querySelector('.sidebar.drawer.open'));
await mpage.tap('.menu-btn');
await mpage.waitForTimeout(250);
await mpage.tap('.sidebar.drawer .nav a[href="#/"]');
await mpage.waitForTimeout(400);

// Legend opens from its toggle, picking a subsystem closes it and selects.
await mpage.tap('.legend-toggle');
await mpage.waitForSelector('.legend.open', { timeout: 5000 });
await mpage.tap('.communities button');
await mpage.waitForSelector('.detail', { timeout: 10000 });
await mpage.waitForTimeout(700);
await mpage.screenshot({ path: 'mobile-detail.png' });

// Code viewer on a phone: full-screen overlay, and wrap ON by default so
// there is no horizontal scrolling (measured 706px of overflow without it).
await mpage.tap('.view-code');
await mpage.waitForSelector('.code-pane .code-line', { timeout: 15000 });
await mpage.waitForTimeout(700);
const mcode = await mpage.evaluate(() => {
  const pane = document.querySelector('.code-pane').getBoundingClientRect();
  const scroll = document.querySelector('.code-scroll');
  return {
    fullWidth: Math.round(pane.width),
    overflowX: scroll.scrollWidth - scroll.clientWidth,
    lines: document.querySelectorAll('.code-line').length,
  };
});
await mpage.screenshot({ path: 'mobile-code.png' });
await mpage.tap('.code-head .close');
await mpage.waitForTimeout(300);

// Blast page renders as a bottom sheet. Nav lives in the drawer now.
await mpage.tap('.menu-btn');
await mpage.waitForTimeout(250);
await mpage.tap('.sidebar.drawer .nav a[href="#/blast"]');
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
console.log(`insights   : ${insights.tabs.join(' | ')}; top hub ${insights.topHub}; ${insights.excluded} entry points excluded from "unused"; exported ${insights.report}`);
console.log(`blast      : ${tally}`);
console.log(`rings      : ${rings.join(' | ')}`);
console.log(`change set : ${multi.chips} roots took impact ${singleTotal} -> ${multi.total}; exported ${impactFile}`);
console.log(`self-map   : ${selfStats} (${repoFiles.length} files extracted in-browser)`);
console.log(`code       : ${code.lines} lines, ${code.hljs} highlight spans, ${code.marked} gutter marks; map reflowed to ${code.canvasWidth}px`);
console.log(`mobile     : bar ${bar.content}px content in ${bar.width}px (want equal); blast sheet top=${sheet.top}px width=${sheet.width}px`);
console.log(`mobile menu: zip button on-screen=${drawer.zipVisible} (want true), folder=${drawer.folderVisible} (want false on touch), ${drawer.navCount} nav links, closes on navigate=${drawerClosed}`);
console.log(`explorer   : ${tree.total}, ${tree.mapped} mapped / ${tree.unmapped} unmapped dots; opened non-graph file ${tree.openedPath}`);
console.log(`dividers   : ${resize.count} handles; drag -140px took code ${resize.beforeDrag.code}->${resize.afterDrag.code}px and map ${resize.beforeDrag.canvas}->${resize.afterDrag.canvas}px`);
console.log(`search     : ${searchFoot} in ${searchMs}ms (cold); hit jumped to ${jumped.path} line ${jumped.target}`);
console.log(`tabs       : [${tabsInfo.open.join(', ')}] active=${tabsInfo.active}`);
console.log(`knowledge  : ${kb.stats}; ${kb.nodes}; ${kb.hits} hits, ${kb.marks} highlights, top="${kb.top}" -> ${kb.opened}`);
console.log(`history    : ${saved.map((s) => s.name).join(' | ')}; restored in ${restoreMs}ms with sources intact (${restoredSource.path}, ${restoredSource.lines} lines)`);
console.log(`diff       : ${versionsOfSelf} versions of grapheon-self; ${diffSummary}`);
console.log(`pdf        : ${pdfHit ? `indexed, hit "${pdfHit.heading}" at ${pdfHit.source}` : 'NO HIT — pdf text did not reach the index'}`
  + ` (parsed with Uint8Array.toHex removed${hadToHex ? '' : '; runtime lacked it anyway'})`);
console.log(`mobile code: ${mcode.lines} lines full-screen at ${mcode.fullWidth}px, horizontal overflow ${mcode.overflowX}px (want 0)`);
console.log(`screenshots: ${OUT}, blast.png, browser-extract.png, code-view.png, mobile-{atlas,detail,blast,code}.png`);
if (errors.length) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nOK — no console errors.');
