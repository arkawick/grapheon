/**
 * Turn a picked/dropped folder or zip into two things:
 *
 *   parseable — [{path, src}] for the extractor. Mirrors extract/node.mjs
 *               exactly (same extensions, same skip list), so the browser and
 *               CLI describe the same graph for the same repo.
 *   readable  — every text file, for the file explorer. A repo is not only its
 *               parseable source: README, package.json, Dockerfile and the
 *               compose/CI YAML are usually the FIRST things you read to
 *               understand an unfamiliar codebase, and filtering them out at
 *               ingest made them permanently invisible.
 *
 * The extra files cost nothing at ingest — they are already in memory; we were
 * simply discarding them.
 */
const PARSEABLE = new Set(['.py', '.js', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

// Readable-but-not-parseable: config, docs, and the shape of the project.
const READABLE = new Set([
  ...PARSEABLE,
  '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.markdown', '.rst', '.txt',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.example',
  '.sh', '.bash', '.ps1', '.bat', '.sql', '.html', '.css', '.scss',
  '.gradle', '.properties', '.xml', '.gitignore', '.dockerignore',
]);
// Extensionless files worth reading, matched on basename.
const READABLE_NAMES = new Set([
  'Dockerfile', 'Makefile', 'LICENSE', 'README', 'CHANGELOG', 'Procfile',
  '.gitignore', '.dockerignore', '.env', '.env.example',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'graphify-out', '__pycache__', 'dist', '.venv', 'venv',
  'build', '.next', '.gradle', 'target', 'coverage', 'out',
  // Tooling scratch space — `.claude/worktrees` holds whole copies of the
  // repo, which would show up as duplicate files throughout the tree.
  '.claude', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.tox', '.cache',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // a 2 MB source file is not source
const PDF_MAX_BYTES = 40 * 1024 * 1024; // PDFs are binary; papers get large

const ext = (name) => {
  const i = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  return i > slash ? name.slice(i) : '';
};
const base = (p) => p.slice(p.lastIndexOf('/') + 1);

const isReadable = (p) => READABLE.has(ext(p)) || READABLE_NAMES.has(base(p));
const isParseable = (p) => PARSEABLE.has(ext(p));
const skipped = (p) => p.split('/').some((seg) => SKIP_DIRS.has(seg));

/**
 * Bundled/minified output masquerading as source. A 470 KB one-line index.js
 * (a synced build artifact) stalled the parser for tens of seconds; no
 * human-written file averages 400 chars per line.
 */
const looksMinified = (src) =>
  src.length > 20000 && src.length / (src.split('\n').length || 1) > 400;

/** Split a readable set into what the extractor should see. */
function partition(files) {
  return {
    files: files.filter((f) => isParseable(f.path)),
    readable: files,
  };
}

/** From an <input webkitdirectory> FileList. */
export async function filesFromFileList(fileList) {
  const out = [];
  for (const f of fileList) {
    // webkitRelativePath is "repoName/sub/dir/file.py"; drop the root segment
    // so paths match what the CLI produces relative to the repo.
    const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/');
    if (!rel || !isReadable(rel) || skipped(rel)) continue;
    if (f.size > MAX_FILE_BYTES) continue;
    const src = await f.text();
    if (looksMinified(src)) continue;
    out.push({ path: rel, src });
  }
  return partition(out);
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
      isReadable(f.name) &&
      !skipped(f.name) &&
      f.originalSize <= MAX_FILE_BYTES,
  });
  const paths = Object.keys(entries);

  // GitHub zips wrap everything in "<repo>-<branch>/"; strip a common root
  // segment when one exists so paths match what the CLI would produce.
  const roots = new Set(paths.map((p) => p.split('/')[0]));
  const strip = roots.size === 1 && paths.every((p) => p.includes('/'));

  const all = paths
    .map((p) => ({
      path: strip ? p.split('/').slice(1).join('/') : p,
      src: strFromU8(entries[p]),
    }))
    .filter((f) => !looksMinified(f.src));
  return partition(all);
}

/** "myrepo-main.zip" -> "myrepo-main". */
export function repoNameFromZip(file) {
  return file.name.replace(/\.zip$/i, '') || 'repo';
}

// --- knowledge base ---------------------------------------------------------

const DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.rst', '.text', '.pdf']);

/**
 * Documents for the knowledge base, from a multi-file picker.
 *
 * Separate from the repo path on purpose: this is a different corpus answering
 * different questions, and mixing a README into a code graph is not the same
 * thing as building a knowledge base out of a folder of specifications.
 */
export async function documentsFromFileList(fileList) {
  const out = [];
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    const dot = rel.lastIndexOf('.');
    const ext = dot === -1 ? '' : rel.slice(dot).toLowerCase();
    if (!DOC_EXTS.has(ext)) continue;
    if (skipped(rel)) continue;
    // PDFs are binary and get a bigger ceiling — a 3 MB PDF is an ordinary
    // paper, whereas a 3 MB "text file" is a data dump.
    if (f.size > (ext === '.pdf' ? PDF_MAX_BYTES : MAX_FILE_BYTES)) continue;
    // Strip a common root folder the way the repo picker does, so paths read
    // as "spec/intro.md" rather than "myfolder/spec/intro.md".
    out.push(ext === '.pdf'
      ? { path: rel, data: await f.arrayBuffer() }
      : { path: rel, text: await f.text() });
  }
  const roots = new Set(out.map((f) => f.path.split('/')[0]));
  if (roots.size === 1 && out.every((f) => f.path.includes('/'))) {
    for (const f of out) f.path = f.path.split('/').slice(1).join('/');
  }
  return out;
}
