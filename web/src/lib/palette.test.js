import test from 'node:test';
import assert from 'node:assert/strict';
import { rankPalette, scoreMatch, flatten } from './palette.js';

const node = (id, l, path, r = 4) => ({ id, l, k: 'code', h: 200, r, a: { path } });
const cmd = (id, label, hint = '', keywords = '') => ({ id, label, hint, keywords, run: () => {} });

const NODES = [
  node('llm', 'llm.py', 'aeon/backend/core/llm.py', 9),
  node('complete', 'complete()', 'aeon/backend/core/llm.py', 3),
  node('blast', 'blast_radius_service.py', 'aeon/backend/services/blast_radius_service.py', 7),
];
const PATHS = ['aeon/backend/core/llm.py', 'README.md', 'docs/llm-notes.md'];
const CMDS = [cmd('blastpage', 'Go to Blast Radius', 'what breaks if this changes', 'blast radius'),
               cmd('atlas', 'Go to Atlas', 'the map', 'atlas map')];

const group = (sections, name) => sections.find((s) => s.group === name);
const labels = (section) => (section?.items ?? []).map((i) => i.label);

test('an exact match outranks a prefix, which outranks a substring', () => {
  assert.ok(scoreMatch('llm', 'llm') > scoreMatch('llm.py', 'llm'));
  assert.ok(scoreMatch('llm.py', 'llm') > scoreMatch('core/llm.py', 'llm'));
  assert.ok(scoreMatch('core/llm.py', 'llm') > scoreMatch('allmine.py', 'llm'));
  assert.equal(scoreMatch('nothing', 'zzz'), null);
});

/**
 * A shorter name is a tighter match, but only as a tiebreak: the bonus must
 * never be large enough to lift a substring hit above a prefix hit.
 */
test('length only breaks ties within a tier', () => {
  assert.ok(scoreMatch('llm.py', 'llm') > scoreMatch('llm_provider_registry.py', 'llm'));
  assert.ok(scoreMatch('a_very_long_name_that_starts_with_llm_here.py', 'llm')
    < scoreMatch('llm.py', 'llm'));
});

test('a path segment counts as a word boundary', () => {
  assert.ok(scoreMatch('core/llm.py', 'llm') > scoreMatch('xllmx', 'llm'));
  assert.ok(scoreMatch('parseDocument', 'document') > scoreMatch('xdocumentx', 'document'));
});

test('an empty query offers recent files and commands, not nothing', () => {
  const sections = rankPalette({
    nodes: NODES, paths: PATHS, commands: CMDS,
    recent: [{ path: 'aeon/backend/core/llm.py', line: 25 }],
  });
  assert.deepEqual(labels(group(sections, 'Recent files')), ['llm.py']);
  assert.equal(group(sections, 'Recent files').items[0].line, 25, 'and reopens at the same line');
  assert.ok(group(sections, 'Commands').items.length);
  assert.equal(group(sections, 'Entities'), undefined, 'no entity dump with no query');
});

test('with no recents the empty palette is still the command list', () => {
  const sections = rankPalette({ nodes: NODES, paths: PATHS, commands: CMDS, recent: [] });
  assert.deepEqual(sections.map((s) => s.group), ['Commands']);
});

/**
 * The per-section cap is there to stop a broad query flooding the list. The
 * empty palette is the one place the whole command list is shown, and silently
 * hiding the last two commands there makes them undiscoverable.
 */
test('the empty palette shows every command, cap or not', () => {
  const commands = Array.from({ length: 9 }, (_, i) => cmd(`c${i}`, `Command ${i}`));
  const sections = rankPalette({ commands, recent: [] });
  assert.equal(group(sections, 'Commands').items.length, 9);
});

test('entities, files and commands are searched together', () => {
  const sections = rankPalette({ query: 'llm', nodes: NODES, paths: PATHS, commands: CMDS });
  assert.ok(labels(group(sections, 'Entities')).includes('llm.py'));
  assert.ok(labels(group(sections, 'Files')).includes('llm.py'));
  assert.ok(labels(group(sections, 'Files')).includes('llm-notes.md'));
  assert.equal(group(sections, 'Commands'), undefined, 'no command mentions llm');
});

/**
 * Sections sort by their best match rather than by a fixed precedence. "blast"
 * should reach the page; a filename should reach the file. A fixed order can
 * only ever get one of those right.
 */
test('the section that matched best comes first', () => {
  const forPage = rankPalette({ query: 'go to blast', nodes: NODES, paths: PATHS, commands: CMDS });
  assert.equal(forPage[0].group, 'Commands');

  const forFile = rankPalette({ query: 'README', nodes: NODES, paths: PATHS, commands: CMDS });
  assert.equal(forFile[0].group, 'Files');
});

/**
 * Aeon's corpus contains its own documentation, so "Blast Radius" is an exact
 * entity match six times over — and the command to open the page was buried
 * under all of them. The bias fixes that without letting a weak command match
 * jump ahead of a strong content one.
 */
test('a command beats content that matched it equally well', () => {
  const nodes = [node('doc', 'Blast Radius', 'AEON_README.md', 5),
                 node('doc2', 'Blast Radius', 'docs/PAGES.md', 4)];
  const sections = rankPalette({ query: 'blast radius', nodes, paths: [], commands: CMDS });
  assert.equal(sections[0].group, 'Commands');
  assert.equal(sections[0].items[0].label, 'Go to Blast Radius');
  assert.equal(sections[1].group, 'Entities', 'and the headings are still right below');
});

test('but the bias never lifts a command over a whole tier', () => {
  // 'radius' is a weak mid-word hit on the command, a prefix hit on the file.
  const sections = rankPalette({
    query: 'radius',
    nodes: [], paths: ['radius_helpers.py'],
    commands: [cmd('c', 'Blast Radius Report', '', 'xxblastradiusxx')],
  });
  assert.equal(sections[0].group, 'Files');
});

test('hubs outrank leaves that match equally well', () => {
  const nodes = [node('small', 'llm_helper.py', 'a/llm_helper.py', 1),
                 node('big', 'llm_helper.py', 'b/llm_helper.py', 20)];
  const sections = rankPalette({ query: 'llm', nodes, paths: [], commands: [] });
  assert.equal(group(sections, 'Entities').items[0].id, 'node:big');
});

test('every result carries what running it needs', () => {
  const sections = rankPalette({ query: 'llm', nodes: NODES, paths: PATHS, commands: CMDS });
  for (const item of flatten(sections)) {
    if (item.type === 'node') assert.ok(item.node, 'a node result carries its node');
    if (item.type === 'file') assert.ok(item.path, 'a file result carries its path');
    if (item.type === 'command') assert.equal(typeof item.run, 'function');
  }
});

test('results are capped per section', () => {
  const many = Array.from({ length: 50 }, (_, i) => node(`n${i}`, `llm${i}.py`, `x/llm${i}.py`));
  const sections = rankPalette({ query: 'llm', nodes: many, paths: [], commands: [] });
  assert.equal(group(sections, 'Entities').items.length, 8);
});

test('a query matching nothing produces no sections rather than throwing', () => {
  assert.deepEqual(rankPalette({ query: 'zzzzz', nodes: NODES, paths: PATHS, commands: CMDS }), []);
  assert.deepEqual(rankPalette(), [{ group: 'Commands', items: [] }].filter((s) => s.items.length));
});

test('flatten gives the order the keyboard walks', () => {
  const sections = rankPalette({ query: 'llm', nodes: NODES, paths: PATHS, commands: CMDS });
  const flat = flatten(sections);
  assert.equal(flat.length, sections.reduce((n, s) => n + s.items.length, 0));
  assert.equal(flat[0].label, sections[0].items[0].label);
});
