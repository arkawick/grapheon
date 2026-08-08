import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { filesFromZip, repoNameFromZip } from './corpus.js';

// Node >= 20 has File; fflate runs anywhere. This exercises the exact path the
// Android build depends on, since mobile has no directory picker at all.
const zipFile = (entries, name = 'repo-main.zip') => {
  const packed = zipSync(
    Object.fromEntries(Object.entries(entries).map(([p, s]) => [p, strToU8(s)]))
  );
  return new File([packed], name, { type: 'application/zip' });
};

const paths = (arr) => arr.map((f) => f.path).sort();

test('unpacks parseable files and strips the GitHub root folder', async () => {
  const f = zipFile({
    'myrepo-main/src/a.py': 'def f(): pass\n',
    'myrepo-main/src/b.jsx': 'export default function B() {}\n',
  });
  const { files } = await filesFromZip(f);
  assert.deepEqual(paths(files), ['src/a.py', 'src/b.jsx']);
  assert.match(files.find((x) => x.path === 'src/a.py').src, /def f/);
});

/**
 * The split that makes the file explorer possible: `files` is what the
 * extractor parses, `readable` is everything a human might open. A README has
 * no graph node, and before this it was discarded at ingest and therefore
 * unreachable even though the user had handed us the whole folder.
 */
test('readable includes docs and configs; files stays parseable-only', async () => {
  const f = zipFile({
    'r/app.py': 'x = 1\n',
    'r/README.md': '# hello\n',
    'r/package.json': '{}\n',
    'r/docker-compose.yml': 'services: {}\n',
  });
  const { files, readable } = await filesFromZip(f);
  assert.deepEqual(paths(files), ['app.py'], 'extractor sees only parseable source');
  assert.deepEqual(
    paths(readable),
    ['README.md', 'app.py', 'docker-compose.yml', 'package.json'],
    'explorer sees everything readable'
  );
});

test('skips vendored and tooling directories inside the zip', async () => {
  const f = zipFile({
    'r/app.py': 'x = 1\n',
    'r/node_modules/dep/index.js': 'evil\n',
    'r/.git/hooks/x.py': 'evil\n',
    'r/__pycache__/app.py': 'evil\n',
    // .claude/worktrees holds whole COPIES of a repo — without this the tree
    // fills with duplicate README rows from scratch worktrees.
    'r/.claude/worktrees/w1/README.md': 'stub\n',
  });
  const { readable } = await filesFromZip(f);
  assert.deepEqual(paths(readable), ['app.py']);
});

test('keeps paths intact when there is no single root', async () => {
  const f = zipFile({ 'a.py': 'x = 1\n', 'lib/b.py': 'y = 2\n' });
  const { files } = await filesFromZip(f);
  assert.deepEqual(paths(files), ['a.py', 'lib/b.py']);
});

test('repo name comes from the zip filename', () => {
  assert.equal(repoNameFromZip(new File([], 'grapheon-main.zip')), 'grapheon-main');
});
