/** Serve bench/ statically, open browser.html in Chromium, scrape the result. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Hoisted by npm workspaces to the repo root.
import { chromium } from '../node_modules/playwright/index.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm',
};

const server = createServer((req, res) => {
  try {
    const path = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(5199, r));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5199/browser.html');
await page.waitForFunction(() => window.__result, { timeout: 120000 });
const result = await page.evaluate(() => window.__result);
await browser.close();
server.close();

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
