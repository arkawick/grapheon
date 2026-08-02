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

test('unpacks parseable files and strips the GitHub root folder', async () => {
  const f = zipFile({
    'myrepo-main/src/a.py': 'def f(): pass\n',
    'myrepo-main/src/b.jsx': 'export default function B() {}\n',
    'myrepo-main/README.md': 'nope\n',
  });
  const files = await filesFromZip(f);
  assert.deepEqual(
    files.map((x) => x.path).sort(),
    ['src/a.py', 'src/b.jsx']
  );
  assert.match(files.find((x) => x.path === 'src/a.py').src, /def f/);
});

test('skips vendored directories inside the zip', async () => {
  const f = zipFile({
    'r/app.py': 'x = 1\n',
    'r/node_modules/dep/index.js': 'evil\n',
    'r/.git/hooks/x.py': 'evil\n',
    'r/__pycache__/app.py': 'evil\n',
  });
  const files = await filesFromZip(f);
  assert.deepEqual(files.map((x) => x.path), ['app.py']);
});

test('keeps paths intact when there is no single root', async () => {
  const f = zipFile({ 'a.py': 'x = 1\n', 'lib/b.py': 'y = 2\n' });
  const files = await filesFromZip(f);
  assert.deepEqual(files.map((x) => x.path).sort(), ['a.py', 'lib/b.py']);
});

test('repo name comes from the zip filename', () => {
  assert.equal(repoNameFromZip(new File([], 'grapheon-main.zip')), 'grapheon-main');
});
