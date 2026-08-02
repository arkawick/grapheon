/** Pack the Aeon corpus into corpus.json so the browser harness can fetch it. */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const AEON = 'C:/Users/Arkajyoti/Downloads/Project-Aeon';
const EXTS = new Set(['.py', '.js', '.jsx']);
const SKIP = new Set(['.git', 'node_modules', 'graphify-out', '__pycache__', 'dist']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(p))) yield p;
  }
}

const files = [];
for (const p of walk(AEON)) {
  files.push({ path: relative(AEON, p).replaceAll('\\', '/'), ext: extname(p), src: readFileSync(p, 'utf8') });
}
writeFileSync(new URL('./corpus.json', import.meta.url), JSON.stringify(files));
console.log(`packed ${files.length} files, ${(files.reduce((a, f) => a + f.src.length, 0) / 1e6).toFixed(1)} MB`);
