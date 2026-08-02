/**
 * Turn a picked/dropped folder into the worker's input: [{path, src}].
 *
 * Filters mirror extract/node.mjs — same extensions, same skip list — so the
 * browser and CLI paths describe the same corpus for the same repo.
 */
const EXTS = new Set(['.py', '.js', '.jsx']);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'graphify-out', '__pycache__', 'dist', '.venv', 'venv',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // a 2 MB source file is not source

const ext = (name) => name.slice(name.lastIndexOf('.'));

/**
 * Bundled/minified output masquerading as source. A 470 KB one-line index.js
 * (a synced build artifact) stalled the parser for tens of seconds; no
 * human-written file averages 400 chars per line.
 */
const looksMinified = (src) =>
  src.length > 20000 && src.length / (src.split('\n').length || 1) > 400;

/** From an <input webkitdirectory> FileList. */
export async function filesFromFileList(fileList) {
  const out = [];
  for (const f of fileList) {
    // webkitRelativePath is "repoName/sub/dir/file.py"; drop the root segment
    // so paths match what the CLI produces relative to the repo.
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/');
    if (!rel || !EXTS.has(ext(rel))) continue;
    if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    if (f.size > MAX_FILE_BYTES) continue;
    const src = await f.text();
    if (looksMinified(src)) continue;
    out.push({ path: rel, src });
  }
  return out;
}

/** Repo name guess from the FileList (the folder the user picked). */
export function repoNameFromFileList(fileList) {
  const first = fileList[0]?.webkitRelativePath;
  return first ? first.split('/')[0] : 'repo';
}

/**
 * From a .zip File — the mobile ingestion path. `webkitdirectory` simply does
 * not exist on Android WebViews, so on a phone the way in is a zip: GitHub's
 * "Download ZIP" of any repo drops straight into this.
 */
export async function filesFromZip(file) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buf, {
    filter: (f) =>
      !f.name.endsWith('/') &&
      EXTS.has(ext(f.name)) &&
      !f.name.split('/').some((seg) => SKIP_DIRS.has(seg)) &&
      f.originalSize <= MAX_FILE_BYTES,
  });
  const paths = Object.keys(entries);

  // GitHub zips wrap everything in "<repo>-<branch>/"; strip a common root
  // segment when one exists so paths match what the CLI would produce.
  const roots = new Set(paths.map((p) => p.split('/')[0]));
  const strip = roots.size === 1 && paths.every((p) => p.includes('/'));

  return paths
    .map((p) => ({
      path: strip ? p.split('/').slice(1).join('/') : p,
      src: strFromU8(entries[p]),
    }))
    .filter((f) => !looksMinified(f.src));
}

/** "myrepo-main.zip" -> "myrepo-main". */
export function repoNameFromZip(file) {
  return file.name.replace(/\.zip$/i, '') || 'repo';
}
