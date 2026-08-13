import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { extractCorpus } from './src/extract.js';

/**
 * Extraction tests, TypeScript-focused.
 *
 * These load the real WASM grammars rather than stubbing a parser: the whole
 * risk in this code is what the grammar actually names its nodes
 * (`interface_declaration` vs `interface`, TSX vs TS), and a stub would just
 * encode my assumptions and agree with them.
 */
const require = createRequire(import.meta.url);
const WASM = dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm'));

await Parser.init();
const mk = async (file) => {
  const language = await Language.load(join(WASM, file));
  const parser = new Parser();
  parser.setLanguage(language);
  return { language, parser };
};
const ts = await mk('tree-sitter-typescript.wasm');
const tsx = await mk('tree-sitter-tsx.wasm');
const js = await mk('tree-sitter-javascript.wasm');
const py = await mk('tree-sitter-python.wasm');
const LANGS = { '.ts': ts, '.tsx': tsx, '.js': js, '.jsx': js, '.py': py };

const run = (files) => extractCorpus(files, LANGS);
const labels = (g, file) => g.nodes.filter((n) => n.source_file === file).map((n) => n.label);
const rels = (g, relation) => g.links.filter((l) => l.relation === relation);

test('interfaces, their members, type aliases and enums become entities', () => {
  const g = run([{ path: 'types.ts', src: `
export interface User {
  id: string;
  rename(next: string): void;
}
export type Id = string | number;
export enum Role { Admin, Viewer }
` }]);
  const l = labels(g, 'types.ts');
  assert.ok(l.includes('User'), l.join(','));
  assert.ok(l.includes('Id'));
  assert.ok(l.includes('Role'));
  assert.ok(l.includes('.rename'), 'interface members are its shape');
  assert.ok(l.includes('.id'));
});

test('interface extends is an inherits edge', () => {
  const g = run([{ path: 'a.ts', src: 'interface Base { x: number }\ninterface Kid extends Base { y: number }\n' }]);
  const inherits = rels(g, 'inherits');
  assert.equal(inherits.length, 1);
  assert.match(inherits[0].target, /base/);
});

/**
 * `import type` disappears from the emitted JavaScript. It is a real
 * dependency for a reader and none at runtime, so it must be distinguishable —
 * otherwise a types-only barrel file lays out as the hub of the app.
 */
test('import type is recorded separately from a runtime import', () => {
  const g = run([
    { path: 'types.ts', src: 'export interface User { id: string }\n' },
    { path: 'api.ts', src: 'export function load() { return 1 }\n' },
    { path: 'app.ts', src: "import type { User } from './types';\nimport { load } from './api';\n" },
  ]);
  const typeEdges = rels(g, 'imports_type');
  const runtime = rels(g, 'imports_from');
  assert.ok(typeEdges.some((l) => /types/.test(l.target)), 'type import tagged');
  assert.ok(runtime.some((l) => /api/.test(l.target)), 'runtime import untagged');
  assert.ok(!runtime.some((l) => /types/.test(l.target)), 'type import is NOT a runtime edge');
});

test('inline type specifiers are separated too', () => {
  const g = run([
    { path: 'types.ts', src: 'export interface User { id: string }\nexport const HELPER = 1;\n' },
    { path: 'app.ts', src: "import { type User, HELPER } from './types';\n" },
  ]);
  assert.ok(rels(g, 'imports_type').some((l) => /user/.test(l.target)));
  assert.ok(rels(g, 'imports').some((l) => /helper/.test(l.target)));
});

/**
 * Path aliases are the norm in TypeScript projects. Treating them as npm
 * packages left a real 79-file repo with 5 of 138 imports resolved — a graph
 * of disconnected dots.
 */
test('alias imports resolve to internal files', () => {
  const g = run([
    { path: 'src/lib/utils.ts', src: 'export function cn() { return 1 }\n' },
    { path: 'src/app.tsx', src: "import { cn } from '@/lib/utils';\nexport function App() { return cn(); }\n" },
  ]);
  const edge = rels(g, 'imports_from').find((l) => l.source_file === 'src/app.tsx');
  assert.ok(edge, 'import edge exists');
  assert.match(edge.target, /src_lib_utils/, `resolved internally, got ${edge.target}`);
});

test('baseUrl-style multi-segment imports resolve, bare package names never do', () => {
  const g = run([
    { path: 'src/components/ui/card.tsx', src: 'export function Card() {}\n' },
    { path: 'src/react.ts', src: 'export const decoy = 1;\n' },
    { path: 'src/app.tsx', src: "import { Card } from 'components/ui/card';\nimport React from 'react';\n" },
  ]);
  const targets = rels(g, 'imports_from').filter((l) => l.source_file === 'src/app.tsx').map((l) => l.target);
  assert.ok(targets.some((t) => /components_ui_card/.test(t)), 'multi-segment resolves');
  assert.ok(targets.includes('ref_react'), `bare "react" must stay external, got ${targets.join(',')}`);
});

/**
 * TypeScript's NodeNext resolution has you import './foo.js' for a file that
 * is actually foo.ts — the specifier names the compiled output.
 */
test('a .js specifier resolves to the .ts file it will compile to', () => {
  const g = run([
    { path: 'src/helper.ts', src: 'export const x = 1;\n' },
    { path: 'src/main.ts', src: "import { x } from './helper.js';\n" },
  ]);
  const edge = rels(g, 'imports_from').find((l) => l.source_file === 'src/main.ts');
  assert.match(edge.target, /src_helper/);
});

/** The plain TS grammar reads `<div>` as a type assertion and mangles TSX. */
test('tsx parses JSX rather than choking on it', () => {
  const g = run([{ path: 'c.tsx', src: `
interface Props { title: string }
export function Card({ title }: Props) {
  return <div className="card"><span>{title}</span></div>;
}
` }]);
  const l = labels(g, 'c.tsx');
  assert.ok(l.includes('Card()'), l.join(','));
  assert.ok(l.includes('Props'));
});

test('python and javascript are unaffected by the typescript work', () => {
  const g = run([
    { path: 'm.py', src: 'def f():\n    return 1\n\nclass C:\n    def m(self):\n        return f()\n' },
    { path: 'm.js', src: 'export function g() {}\nexport class K { go() {} }\n' },
  ]);
  assert.ok(labels(g, 'm.py').includes('f()'));
  assert.ok(labels(g, 'm.py').includes('C'));
  assert.ok(labels(g, 'm.js').includes('g()'));
  assert.ok(labels(g, 'm.js').includes('K'));
});
