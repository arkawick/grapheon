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
    out.push({ path: rel, src: await f.text() });
  }
  return out;
}

/** Repo name guess from the FileList (the folder the user picked). */
export function repoNameFromFileList(fileList) {
  const first = fileList[0]?.webkitRelativePath;
  return first ? first.split('/')[0] : 'repo';
}
