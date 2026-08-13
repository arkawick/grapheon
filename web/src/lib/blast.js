/**
 * Blast radius: transitive impact over the code graph.
 *
 * This is the feature Graphify makes honest. Aeon computes the same idea from
 * GitHub PR file paths and a `_classify_file` heuristic; here it is an actual
 * traversal of edges a parser read out of the source.
 *
 * Direction matters and is easy to get backwards:
 *
 *   'in'  — who depends on this. Follows edges pointing AT the root, so it
 *           answers "what breaks if I change this?". This is blast radius.
 *   'out' — what this depends on. Answers "what would I need to understand to
 *           change this?".
 *
 * Certainty propagates along the path, it is not per-edge. Graphify tags each
 * edge EXTRACTED (read from source) or INFERRED (resolved by analysis), and a
 * chain is only as trustworthy as its weakest link — one inferred hop anywhere
 * upstream makes everything past it a maybe. Reporting that honestly is the
 * whole point of carrying the tag through the pipeline.
 */

/**
 * @param {Map<string, Array>} adjacency  id -> [{ id, rel, conf, dir }]
 * @param {string|string[]} root  one entity, or the SET you are changing.
 *   Multiple roots are the real question — "I am touching these three files,
 *   what breaks?" — and answering it as a single traversal rather than a union
 *   of separate ones matters: an entity two hops from each of three roots is
 *   two hops away, not six.
 * @param {{depth?: number, direction?: 'in'|'out'}} opts
 * @returns {Map<string, {depth: number, certain: boolean, via: string, from: string}>}
 */
export function blastRadius(adjacency, root, { depth = 3, direction = 'in' } = {}) {
  const roots = Array.isArray(root) ? root : [root];
  const reached = new Map();
  for (const r of roots) reached.set(r, { depth: 0, certain: true, via: null, from: null });

  let frontier = [...roots];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      const here = reached.get(id);
      for (const link of adjacency.get(id) ?? []) {
        if (link.dir !== direction) continue;
        const certain = here.certain && link.conf !== 'INFERRED';

        const prev = reached.get(link.id);
        if (prev) {
          // Already reached, but possibly by a less trustworthy route. A node
          // is certain if ANY fully-extracted path reaches it, so upgrade
          // rather than skipping outright.
          if (certain && !prev.certain) prev.certain = true;
          continue;
        }

        reached.set(link.id, { depth: d, certain, via: link.rel, from: id });
        next.push(link.id);
      }
    }
    frontier = next;
  }

  // The roots are what you changed, not what the change reached.
  for (const r of roots) reached.delete(r);
  return reached;
}

/** Group a blast result into rings, nearest first. */
export function byDepth(reached) {
  const rings = new Map();
  for (const [id, info] of reached) {
    if (!rings.has(info.depth)) rings.set(info.depth, []);
    rings.get(info.depth).push({ id, ...info });
  }
  return [...rings.entries()].sort((a, b) => a[0] - b[0]);
}
