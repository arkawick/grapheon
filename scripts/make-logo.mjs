#!/usr/bin/env node
/**
 * Build every logo asset from the source art (86.svg).
 *
 *   node scripts/make-logo.mjs
 *
 * Source is a single path with fill="currentColor". This produces:
 *   web/public/logo.svg   natural 1.545:1 mark, blue gradient baked in
 *   web/public/icon.svg   square, padded — favicon and the icon rasteriser
 *   android/.../mipmap-*  launcher PNGs at every density, plus adaptive
 *
 * Rasterising uses the Playwright Chromium we already have rather than adding
 * sharp or a native canvas: one fewer dependency, and it renders the SVG with
 * the same engine that will display it.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../node_modules/playwright/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '86.svg');

// The app's accent family, as a gradient. --accent (#7dd3fc) is the anchor;
// the other two keep it in the same blue register rather than drifting violet.
const STOPS = [
  ['0%', '#7dd3fc'],
  ['55%', '#60a5fa'],
  ['100%', '#818cf8'],
];

const src = readFileSync(SRC, 'utf8');
const d = /<path[^>]*\bd="([^"]+)"/.exec(src)?.[1];
const viewBox = /viewBox="([^"]+)"/.exec(src)?.[1];
if (!d || !viewBox) throw new Error('Could not read the path or viewBox out of 86.svg');
const [, , vbW, vbH] = viewBox.split(/\s+/).map(Number);

const gradient = (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">${
  STOPS.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')
}</linearGradient>`;

/** The mark at its natural proportions — for use in the UI. */
function markSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill-rule="evenodd">
<defs>${gradient('g')}</defs>
<path d="${d}" fill="url(#g)"/>
</svg>\n`;
}

/**
 * Square version.
 *
 * The mark is 1.545:1 and every icon slot is 1:1, so it is centred and scaled
 * to a fraction of the box. `inset` is that fraction: Android adaptive icons
 * crop to a circle and mask aggressively, so their foreground needs far more
 * margin than a favicon does.
 */
function squareSvg({ size = 512, inset = 0.78, bg = null, radius = 0 } = {}) {
  const scale = (size * inset) / vbW;
  const w = vbW * scale;
  const h = vbH * scale;
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill-rule="evenodd">
<defs>${gradient('g')}</defs>
${bg ? `<rect width="${size}" height="${size}" rx="${radius}" fill="${bg}"/>` : ''}
<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(5)})"><path d="${d}" fill="url(#g)"/></g>
</svg>\n`;
}

const out = (rel, content) => {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  console.log(`wrote ${rel}`);
};

out('web/public/logo.svg', markSvg());
// Favicon: dark rounded tile so the light-blue mark has contrast in a browser
// tab, which may sit on white.
out('web/public/icon.svg', squareSvg({ size: 512, inset: 0.74, bg: '#0d0d14', radius: 96 }));

// --- Android launcher icons --------------------------------------------------
const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

const browser = await chromium.launch();
const page = await browser.newPage();

async function raster(svg, size, dest) {
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>
     <img src="${url}">`,
    { waitUntil: 'load' }
  );
  await page.waitForTimeout(60);
  const buf = await page.screenshot({ omitBackground: true });
  const p = join(ROOT, dest);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
}

for (const [density, size] of Object.entries(DENSITIES)) {
  const dir = `android/app/src/main/res/mipmap-${density}`;
  // Legacy icons carry their own tile, since pre-26 Android does not mask.
  await raster(squareSvg({ size, inset: 0.72, bg: '#0d0d14', radius: size * 0.19 }), size, `${dir}/ic_launcher.png`);
  await raster(squareSvg({ size, inset: 0.66, bg: '#0d0d14', radius: size / 2 }), size, `${dir}/ic_launcher_round.png`);
  // Adaptive foreground: transparent, and much smaller — the launcher crops to
  // a circle inside the 108dp square, so anything past the inner ~66% is
  // liable to be cut off.
  const fg = Math.round(size * 2.25); // 108dp foreground for a 48dp icon
  await raster(squareSvg({ size: fg, inset: 0.46 }), fg, `${dir}/ic_launcher_foreground.png`);
  console.log(`wrote ${dir}/ (${size}px, foreground ${fg}px)`);
}

await browser.close();

// The adaptive background is a flat colour resource; match the tile.
out('android/app/src/main/res/values/ic_launcher_background.xml',
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0D0D14</color>
</resources>
`);

console.log('\nDone. Rebuild the APK to pick up the launcher icons.');
