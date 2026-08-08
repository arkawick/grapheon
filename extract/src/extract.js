/**
 * JS port of graphify's code extraction.
 *
 * Emits the SAME raw shape as graphify-out/graph.json — `{nodes, links,
 * directed}` with graphify's id scheme — so `pipeline/adapters/graphify.js`
 * and everything downstream consume it unchanged, and fidelity is directly
 * diffable against the Python CLI's output on identical input.
 *
 * The id scheme, decoded from ground truth (each rule was verified against
 * data/aeon/graph.json, not guessed):
 *   - sanitise: lowercase, non-alphanumeric runs -> "_", trimmed
 *   - file id: relative path minus extension     aeon/backend/core/llm.py -> aeon_backend_core_llm
 *   - entity:  fileId + "_" + name               ..._llm_complete
 *   - method:  fileId + "_" + class + "_" + name ..._chroma_store_chromastore_init
 *   - rationale (docstring): fileId + "_rationale_" + line
 *   - file-scoped symbol reference: file id WITH extension + "_" + name
 *     (annotation types, imported-symbol calls, decorator verbs:
 *      ..._chroma_store_py_any, ..._api_ai_py_post)
 *   - external python module: full dotted, sanitised  "os", "urllib_parse"
 *   - external js module: "ref_" + sanitised          "ref_axios"
 *
 * Conventions that were NOT guessable and cost a scoring round each:
 *   - `from <internal-module> import sym` emits BOTH an imports_from edge to
 *     the module file AND an `imports` edge to `<moduleFileId>_<sym>` — same
 *     double-edge pattern as JS default imports.
 *   - calls to imported symbols land on file-scoped reference ids, not on the
 *     defining module: `AsyncClient()` -> `<thisFileWithExt>_asyncclient`.
 *   - `@router.get(...)` decorators are `references` to `<fileWithExt>_get`.
 *   - JS top-level consts with object/array values are entities (no "()").
 *
 * Pure and IO-free: takes [{path, src}] plus initialised languages, returns
 * the graph. Runs identically in Node and a browser/WebView.
 */

const sanitise = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const stripExt = (p) => p.replace(/\.[^./]+$/, '');

// Python stdlib-ish modules whose imported symbols graphify leaves as bare
// inherit targets (`typeddict`) instead of file-scoped references.
const PY_STDLIB = new Set([
  'typing', 'abc', 'enum', 'collections', 'dataclasses', 'os', 'sys', 'json',
  're', 'time', 'datetime', 'asyncio', 'uuid', 'pathlib', 'functools',
  'itertools', 'threading', 'subprocess', 'logging', 'argparse',
]);

export function extractCorpus(files, langs) {
  const nodes = [];
  const links = [];
  const seenLink = new Set();

  // Edges whose validity depends on the TARGET being a real extracted entity —
  // `from x import some_function` links to the function, but `from x import
  // SOME_CONSTANT` links to nothing, because graphify never made the constant
  // a node. Emitted after all files are processed, filtered against the node
  // set. (Verified: core.instances' module-level singletons get no entity
  // edges; orchestrator's functions do.)
  const deferred = [];
  const deferLink = (source, target, relation, file, line, opts) =>
    deferred.push([source, target, relation, file, line, opts]);

  // Ids are derived from names, and names repeat legitimately: a Python
  // @property and its @x.setter are two definitions of one name, as are
  // overloads and re-definitions under different branches. First declaration
  // wins — emitting both would make ids non-unique and graphology refuses to
  // build the graph at all ("node already exist").
  const seenNodeId = new Set();
  const addNode = (n) => {
    if (seenNodeId.has(n.id)) return;
    seenNodeId.add(n.id);
    nodes.push({ _origin: 'ast', ...n });
  };
  const addLink = (source, target, relation, file, line, opts = {}) => {
    if (!source || !target || source === target) return;
    const key = `${source}\x00${target}\x00${relation}`;
    if (seenLink.has(key)) return; // graphify dedupes repeat call/import sites
    seenLink.add(key);
    links.push({
      source, target, relation,
      ...(opts.context ? { context: opts.context } : {}),
      confidence: opts.inferred ? 'INFERRED' : 'EXTRACTED',
      source_file: file, source_location: `L${line}`,
      weight: 1.0, _origin: 'ast',
    });
  };

  // --- corpus index, for resolving imports to internal files ---------------
  const byPath = new Map();   // exact relative path -> fileId
  const bySuffix = new Map(); // "a/b/c" (no ext) -> [relPathNoExt]
  for (const f of files) {
    const noExt = stripExt(f.path);
    byPath.set(f.path, sanitise(noExt));
    const parts = noExt.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
      bySuffix.get(suffix).push(noExt);
    }
  }

  /**
   * Choose among candidate paths by proximity to the importer: the corpus can
   * contain the same module path twice (a vendored tree), and "core.llm" from
   * aeon/backend/ must mean aeon/backend/core/llm, not the vendored copy.
   */
  const nearest = (candidates, importerPath) => {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return sanitise(candidates[0]);
    const importerParts = importerPath.split('/');
    let best = null, bestShared = -1, tie = false;
    for (const c of candidates) {
      const parts = c.split('/');
      let shared = 0;
      while (shared < parts.length && importerParts[shared] === parts[shared]) shared++;
      if (shared > bestShared) { bestShared = shared; best = c; tie = false; }
      else if (shared === bestShared) tie = true;
    }
    return tie ? null : sanitise(best);
  };

  /**
   * python "core.instances" -> { id, isPkg }, if resolvable. isPkg matters:
   * `from <package> import x` records the package under `imports`, while
   * `from <module-file> import x` records the module under `imports_from`.
   */
  const resolvePyModule = (dotted, importerPath) => {
    const rel = dotted.replaceAll('.', '/');
    const asModule = nearest(bySuffix.get(rel), importerPath);
    if (asModule) return { id: asModule, isPkg: false, rel };
    const asPkg = nearest(bySuffix.get(rel + '/__init__'), importerPath);
    if (asPkg) return { id: asPkg, isPkg: true, rel };
    return null;
  };

  /** js "./Sidebar" relative to importer -> {id, synthetic}. */
  const resolveJsModule = (spec, importerPath) => {
    if (!spec.startsWith('.')) return null;
    const base = importerPath.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue;
      else if (seg === '..') base.pop();
      else base.push(seg);
    }
    const stem = base.join('/');
    for (const cand of [stem, `${stem}.js`, `${stem}.jsx`, `${stem}/index.js`, `${stem}/index.jsx`]) {
      if (byPath.has(cand)) return { id: byPath.get(cand), internal: true };
    }
    for (const [p, id] of byPath) if (stripExt(p) === stem) return { id, internal: true };
    // Relative but not in the corpus (a stylesheet, an asset): graphify still
    // records the edge, against the extension-stripped path id.
    return { id: sanitise(stripExt(stem)), internal: false };
  };

  const text = (node) => node.text;
  const line = (node) => node.startPosition.row + 1;

  // ==========================================================================
  for (const f of files) {
    const ext = f.path.slice(f.path.lastIndexOf('.'));
    const lang = langs[ext];
    if (!lang) continue;

    const fileId = sanitise(stripExt(f.path));
    const fileIdWithExt = sanitise(f.path); // file-scoped reference prefix
    const base = f.path.split('/').pop();
    addNode({ id: fileId, label: base, file_type: 'code', source_file: f.path, source_location: 'L1' });

    const tree = lang.parser.parse(f.src);
    try {
      if (ext === '.py') extractPython(tree.rootNode, f.path, fileId, fileIdWithExt);
      else extractJs(tree.rootNode, f.path, fileId);
    } finally {
      tree.delete();
    }
  }

  // Deferred edges: only those whose target turned out to be a real entity.
  for (const [source, target, relation, file, line, opts] of deferred) {
    if (seenNodeId.has(target)) addLink(source, target, relation, file, line, opts);
  }

  return { input_tokens: 0, output_tokens: 0, nodes, links, directed: false };

  // ==========================================================================
  // Python
  // ==========================================================================
  function extractPython(root, file, fileId, fileIdWithExt) {
    const localEntities = new Map(); // top-level def/class name -> id
    const importedFrom = new Map();  // symbol -> {module, resolved|null}
    const plainImports = new Map();  // binding name -> dotted module
    const subModules = new Map();    // `from core import llm` -> llm's fileId

    // --- imports first: bodies need the symbol tables ----------------------
    visit(root, (n) => {
      if (n.type === 'import_statement') {
        for (const c of n.namedChildren) {
          const nameNode = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
          const dotted = text(nameNode);
          const binding = c.type === 'aliased_import'
            ? text(c.childForFieldName('alias'))
            : dotted.split('.')[0];
          plainImports.set(binding, dotted);
          const resolved = resolvePyModule(dotted, file);
          // External dotted modules keep the FULL path: urllib.parse -> urllib_parse.
          addLink(fileId, resolved?.id ?? sanitise(dotted), 'imports', file, line(n), { context: 'import' });
        }
      } else if (n.type === 'import_from_statement') {
        const mod = n.childForFieldName('module_name');
        if (!mod) return;
        const dotted = text(mod);
        const resolved = dotted.startsWith('.')
          ? resolveRelative(dotted, file)
          : resolvePyModule(dotted, file);
        // A package (resolved via __init__) is recorded under `imports`; a
        // module file under `imports_from`. Verified against main.py vs the
        // ordinary `from core.instances import ...` case.
        addLink(fileId, resolved?.id ?? sanitise(dotted),
          resolved?.isPkg ? 'imports' : 'imports_from', file, line(n), { context: 'import' });
        for (const c of n.namedChildren) {
          if (c === mod) continue;
          const sym = c.type === 'aliased_import' ? text(c.childForFieldName('name')) : text(c);
          if (!sym || !/^[A-Za-z_]\w*$/.test(sym)) continue;
          importedFrom.set(sym, { module: dotted, resolved: resolved?.id ?? null });
          if (!resolved) continue;
          // `from pkg import submodule` links the submodule FILE under
          // imports_from; `from module import entity` links the entity under
          // imports — but only if it is a real extracted entity (deferred).
          const sub = nearest(bySuffix.get(`${resolved.rel}/${sym}`), file);
          if (sub) {
            subModules.set(sym, sub); // `llm.complete()` needs this later
            addLink(fileId, sub, 'imports_from', file, line(n), { context: 'import' });
          } else {
            deferLink(fileId, sanitise(`${resolved.id}_${sym}`), 'imports', file, line(n), { context: 'import' });
          }
        }
      }
    });

    // module docstring
    docstring(root, file, (rid) => addLink(rid, fileId, 'rationale_for', file, 1));

    // --- entities (pass 1, so calls can resolve forward references) --------
    const defs = [];
    for (const child of root.namedChildren) {
      const stmt = child.type === 'decorated_definition'
        ? child.namedChildren.find((c) => c.type.endsWith('_definition')) ?? child
        : child;
      if (stmt.type === 'function_definition' || stmt.type === 'class_definition') {
        const name = text(stmt.childForFieldName('name'));
        const id = sanitise(`${fileId}_${name}`);
        localEntities.set(name, id);
        defs.push({ stmt, name, id, decl: child });
      }
    }

    const ctxBase = { localEntities, importedFrom, plainImports, subModules, fileIdWithExt, file };

    for (const { stmt, name, id, decl } of defs) {
      const isClass = stmt.type === 'class_definition';
      addNode({
        id, label: isClass ? name : `${name}()`, file_type: 'code',
        source_file: file, source_location: `L${line(decl)}`,
      });
      addLink(fileId, id, 'contains', file, line(decl));
      docstring(stmt.childForFieldName('body'), file, (rid) =>
        addLink(rid, id, 'rationale_for', file, line(stmt)));
      decoratorRefs(decl, id, ctxBase);

      if (isClass) {
        const sup = stmt.childForFieldName('superclasses');
        if (sup) {
          for (const b of sup.namedChildren) {
            const bname = b.type === 'identifier' ? text(b)
              : b.type === 'attribute' ? text(b.childForFieldName('attribute'))
              : null;
            if (!bname) continue;
            const target = localEntities.get(bname)
              ?? inheritTarget(bname, importedFrom, fileIdWithExt);
            addLink(id, target, 'inherits', file, line(b));
          }
        }
        const body = stmt.childForFieldName('body');
        const methods = new Map();
        const methodDefs = [];
        for (const m of body?.namedChildren ?? []) {
          const mdef = m.type === 'decorated_definition'
            ? m.namedChildren.find((c) => c.type === 'function_definition')
            : m.type === 'function_definition' ? m : null;
          if (!mdef) continue;
          const mname = text(mdef.childForFieldName('name'));
          const mid = sanitise(`${id}_${mname}`);
          methods.set(mname, mid);
          methodDefs.push({ m, mdef, mid });
          addNode({
            id: mid, label: `.${mname}()`, file_type: 'code',
            source_file: file, source_location: `L${line(m)}`,
          });
          addLink(id, mid, 'method', file, line(m));
          docstring(mdef.childForFieldName('body'), file, (rid) =>
            addLink(rid, mid, 'rationale_for', file, line(mdef)));
        }
        for (const { m, mdef, mid } of methodDefs) {
          decoratorRefs(m, mid, ctxBase);
          walkPyBody(mdef, mid, { ...ctxBase, methods });
        }
      } else {
        walkPyBody(stmt, id, { ...ctxBase, methods: null });
      }
    }
  }

  function resolveRelative(dotted, importerPath) {
    const m = dotted.match(/^(\.+)(.*)$/);
    const ups = m[1].length;
    const rest = m[2];
    const dir = importerPath.split('/').slice(0, -ups);
    const rel = [...dir, ...rest.split('.').filter(Boolean)].join('/');
    const asModule = nearest(bySuffix.get(rel), importerPath);
    if (asModule) return { id: asModule, isPkg: false, rel };
    const asPkg = nearest(bySuffix.get(rel + '/__init__'), importerPath);
    if (asPkg) return { id: asPkg, isPkg: true, rel };
    return null;
  }

  function inheritTarget(bname, importedFrom, fileIdWithExt) {
    const imp = importedFrom.get(bname);
    if (imp && PY_STDLIB.has(imp.module.split('.')[0])) return sanitise(bname);
    if (imp) return sanitise(`${fileIdWithExt}_${bname}`);
    return sanitise(bname);
  }

  function docstring(bodyNode, file, link) {
    const first = bodyNode?.namedChildren?.[0];
    if (first?.type !== 'expression_statement') return;
    const s = first.namedChildren[0];
    if (s?.type !== 'string') return;
    const ln = line(s);
    const fid = sanitise(stripExt(file));
    const id = `${fid}_rationale_${ln}`;
    const raw = text(s).replace(/^[rbuf]*['"]{1,3}|['"]{1,3}$/g, '').trim();
    const firstLine = raw.split('\n')[0].trim();
    addNode({
      id, label: firstLine.length > 77 ? firstLine.slice(0, 77) + '…' : firstLine,
      file_type: 'rationale', source_file: file, source_location: `L${ln}`,
    });
    link(id);
  }

  /**
   * `@router.get("/x")` on a definition. A decorator is both a mention and an
   * invocation, and graphify records it as BOTH: a `references` edge and a
   * `calls` edge, each to the file-scoped <fileWithExt>_get.
   */
  function decoratorRefs(declNode, ownerId, ctx) {
    if (declNode.type !== 'decorated_definition') return;
    for (const d of declNode.namedChildren) {
      if (d.type !== 'decorator') continue;
      const expr = d.namedChildren[0];
      if (expr?.type !== 'call') continue;
      const fn = expr.childForFieldName('function');
      if (fn?.type !== 'attribute') continue;
      const attr = text(fn.childForFieldName('attribute'));
      const target = sanitise(`${ctx.fileIdWithExt}_${attr}`);
      addLink(ownerId, target, 'references', ctx.file, line(d));
      addLink(ownerId, target, 'calls', ctx.file, line(d));
    }
  }

  /** calls + annotation references inside one entity's body. */
  function walkPyBody(defNode, ownerId, ctx) {
    // --- annotation references: parameter types and return type ------------
    const annNames = new Set();
    const collectAnn = (n) => visit(n, (x) => {
      if (x.type === 'identifier') annNames.add(text(x));
    });
    const params = defNode.childForFieldName('parameters');
    if (params) {
      for (const p of params.namedChildren) {
        const t = p.childForFieldName?.('type');
        if (t) collectAnn(t);
      }
    }
    const ret = defNode.childForFieldName('return_type');
    if (ret) collectAnn(ret);
    for (const name of annNames) {
      const local = ctx.localEntities.get(name);
      if (local) {
        // A locally-defined class in an annotation references the entity itself.
        addLink(ownerId, local, 'references', ctx.file, line(defNode));
        continue;
      }
      if (!ctx.importedFrom.has(name) && !/^[A-Z]/.test(name)) continue;
      addLink(ownerId, sanitise(`${ctx.fileIdWithExt}_${name}`), 'references', ctx.file, line(defNode));
    }

    // --- calls --------------------------------------------------------------
    visit(defNode.childForFieldName('body') ?? defNode, (n) => {
      if (n.type !== 'call') return;
      const fn = n.childForFieldName('function');
      if (!fn) return;
      if (fn.type === 'identifier') {
        const name = text(fn);
        const local = ctx.localEntities.get(name);
        if (local) { addLink(ownerId, local, 'calls', ctx.file, line(n)); return; }
        const imp = ctx.importedFrom.get(name);
        if (!imp) return;
        if (imp.resolved) {
          // A call to a symbol imported from an INTERNAL module targets the
          // defining module's entity (orchestrator.analyze -> graph_run_graph)
          // — but only if it is a real entity there, hence deferred.
          deferLink(ownerId, sanitise(`${imp.resolved}_${name}`), 'calls', ctx.file, line(n));
        } else if (!PY_STDLIB.has(imp.module.split('.')[0])) {
          // External non-stdlib import lands on the file-scoped reference id
          // (AsyncClient() -> <thisFile>_py_asyncclient). Stdlib calls
          // (uuid4, loads) get NO edge — verified absent from ground truth.
          addLink(ownerId, sanitise(`${ctx.fileIdWithExt}_${name}`), 'calls', ctx.file, line(n));
        }
      } else if (fn.type === 'attribute') {
        const obj = fn.childForFieldName('object');
        const attr = text(fn.childForFieldName('attribute'));
        if (obj?.type === 'identifier') {
          const objName = text(obj);
          if ((objName === 'self' || objName === 'cls') && ctx.methods?.get(attr)) {
            addLink(ownerId, ctx.methods.get(attr), 'calls', ctx.file, line(n));
            return;
          }
          const sub = ctx.subModules.get(objName);
          if (sub) {
            // `from core import llm` then `llm.complete(...)` — an attribute
            // call on an imported SUBMODULE targets that module's entity.
            deferLink(ownerId, sanitise(`${sub}_${attr}`), 'calls', ctx.file, line(n));
            return;
          }
          const dotted = ctx.plainImports.get(objName);
          if (dotted !== undefined) {
            // httpx.get(...) -> <thisFile>_py_get; json.dumps(...) -> nothing
            // (stdlib module-attribute calls are absent from ground truth).
            if (!PY_STDLIB.has(dotted.split('.')[0])) {
              addLink(ownerId, sanitise(`${ctx.fileIdWithExt}_${attr}`), 'calls', ctx.file, line(n));
            }
            return;
          }
        }
        // Deep attribute chains: graphify credits `self._collection.count()`
        // to the current class's .count() method purely by name match.
        if (ctx.methods?.get(attr)) {
          addLink(ownerId, ctx.methods.get(attr), 'calls', ctx.file, line(n));
        }
      }
    });
  }

  // ==========================================================================
  // JavaScript / JSX
  // ==========================================================================
  function extractJs(root, file, fileId) {
    const localEntities = new Map();

    const declare = (name, node, label = `${name}()`) => {
      const id = sanitise(`${fileId}_${name}`);
      if (localEntities.has(name)) return id;
      localEntities.set(name, id);
      addNode({
        id, label, file_type: 'code',
        source_file: file, source_location: `L${line(node)}`,
      });
      addLink(fileId, id, 'contains', file, line(node));
      return id;
    };

    // --- pass 1: top-level entities ----------------------------------------
    const bodies = []; // [entityId, bodyNode]
    for (const child of root.namedChildren) {
      let stmt = child;
      if (stmt.type === 'export_statement') {
        stmt = stmt.namedChildren.find((c) => c.type !== 'export_clause') ?? stmt;
      }
      if (stmt.type === 'function_declaration' || stmt.type === 'generator_function_declaration') {
        const name = text(stmt.childForFieldName('name'));
        bodies.push([declare(name, child), stmt]);
      } else if (stmt.type === 'class_declaration') {
        const name = text(stmt.childForFieldName('name'));
        const cid = declare(name, child, name);
        const heritage = stmt.namedChildren.find((c) => c.type === 'class_heritage');
        if (heritage) {
          const base = heritage.namedChildren?.[0];
          if (base?.type === 'identifier') {
            const bname = text(base);
            addLink(cid, localEntities.get(bname) ?? sanitise(bname), 'inherits', file, line(heritage));
          }
        }
        for (const m of stmt.childForFieldName('body')?.namedChildren ?? []) {
          if (m.type !== 'method_definition') continue;
          const mname = text(m.childForFieldName('name'));
          const mid = sanitise(`${cid}_${mname}`);
          addNode({ id: mid, label: `.${mname}()`, file_type: 'code', source_file: file, source_location: `L${line(m)}` });
          addLink(cid, mid, 'method', file, line(m));
          bodies.push([mid, m]);
        }
      } else if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
        for (const d of stmt.namedChildren) {
          if (d.type !== 'variable_declarator') continue;
          const nameNode = d.childForFieldName('name');
          const value = d.childForFieldName('value');
          if (nameNode?.type !== 'identifier' || !value) continue;
          const name = text(nameNode);
          if (value.type === 'arrow_function' || value.type === 'function_expression') {
            bodies.push([declare(name, child), value]);
          } else if (['call_expression', 'new_expression', 'object', 'array'].includes(value.type)) {
            // `const NODE_COLORS = {...}` / `const api = axios.create(...)` —
            // plain consts are entities too (label without parens).
            declare(name, child, name);
          }
        }
      }
    }

    // --- imports ------------------------------------------------------------
    const importedJs = new Map(); // binding name -> internal module fileId
    for (const child of root.namedChildren) {
      if (child.type !== 'import_statement') continue;
      const srcNode = child.childForFieldName('source');
      if (!srcNode) continue;
      const spec = text(srcNode).slice(1, -1);
      const resolved = resolveJsModule(spec, file);
      const moduleTarget = resolved ? resolved.id : `ref_${sanitise(spec)}`;
      addLink(fileId, moduleTarget, 'imports_from', file, line(child), { context: 'import' });
      if (resolved?.internal) {
        // each imported binding also links to the entity inside that file
        visit(child, (n) => {
          if (n.type === 'import_specifier') {
            const nm = text(n.childForFieldName('name'));
            importedJs.set(nm, resolved.id);
            addLink(fileId, sanitise(`${resolved.id}_${nm}`), 'imports', file, line(child), { context: 'import' });
          } else if (n.type === 'import_clause') {
            const def = n.namedChildren.find((c) => c.type === 'identifier');
            if (def) {
              importedJs.set(text(def), resolved.id);
              addLink(fileId, sanitise(`${resolved.id}_${text(def)}`), 'imports', file, line(child), { context: 'import' });
            }
          }
        });
      }
    }

    // --- calls --------------------------------------------------------------
    const callTarget = (name, ownerId) => {
      const local = localEntities.get(name);
      if (local && local !== ownerId) return { id: local, sure: true };
      const mod = importedJs.get(name);
      // Imported entity: cross-file call, valid only if it really is an
      // entity over there (deferred, like the python case).
      if (mod) return { id: sanitise(`${mod}_${name}`), sure: false };
      return null;
    };
    for (const [ownerId, body] of bodies) {
      visit(body, (n) => {
        let name = null;
        if (n.type === 'call_expression') {
          const fn = n.childForFieldName('function');
          if (fn?.type === 'identifier') name = text(fn);
        } else if (n.type === 'jsx_opening_element' || n.type === 'jsx_self_closing_element') {
          // JSX usage of a component is a call-like dependency
          const nameNode = n.childForFieldName('name');
          if (nameNode?.type === 'identifier') name = text(nameNode);
        }
        if (!name) return;
        // JSX elements only count against LOCAL components — rendering an
        // imported one is already covered by its imports edge, and graphify
        // does not double it as a call.
        const jsx = n.type !== 'call_expression';
        const t = callTarget(name, ownerId);
        if (!t || (jsx && !t.sure)) return;
        if (t.sure) addLink(ownerId, t.id, 'calls', file, line(n));
        else deferLink(ownerId, t.id, 'calls', file, line(n));
      });
    }
  }

  // --- generic ---------------------------------------------------------------
  function visit(node, fn) {
    fn(node);
    for (const c of node.namedChildren) visit(c, fn);
  }
}
