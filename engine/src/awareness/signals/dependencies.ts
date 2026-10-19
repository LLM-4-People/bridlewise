/**
 * Dependencies signal: circular dependency count, import graph density,
 * and missing-symbol count.
 *
 * Cycles are computed via Tarjan's SCC on the module-level import graph
 * (reusing the architecture signal's edges). Missing symbols are
 * `import { X } from "Y"` where Y does not export X — computed by
 * joining imports against the export map.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeDependencies(ctx: SignalContext) {
  // Build module-of lookup.
  const modules = ctx.modules;
  const moduleOf = (filePath: string): string | null => {
    let best: string | null = null;
    for (const m of modules) {
      if (filePath === m.path || filePath.startsWith(m.path + "/")) {
        if (best === null || m.path.length > best.length) best = m.path;
      }
    }
    return best;
  };
  // Module-level edges.
  const adj = new Map<string, Set<string>>();
  for (const m of modules) adj.set(m.path, new Set());
  for (const fa of ctx.fileAnalyses) {
    const fromMod = moduleOf(fa.filePath);
    if (!fromMod) continue;
    for (const imp of fa.imports) {
      const toMod = resolveModule(imp, fa.filePath, moduleOf);
      if (!toMod || toMod === fromMod) continue;
      adj.get(fromMod)!.add(toMod);
    }
  }
  // Tarjan SCC for cycles.
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const sccs: string[][] = [];
  function strongconnect(v: string) {
    indices.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, indices.get(w) ?? 0));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w !== undefined) { onStack.delete(w); comp.push(w); }
      } while (w !== v && stack.length > 0);
      if (comp.length > 1) sccs.push(comp);
    }
  }
  for (const m of modules) {
    if (!indices.has(m.path)) strongconnect(m.path);
  }
  const circularCount = sccs.length;
  // Graph density.
  const edgeCount = (() => { let n = 0; for (const s of adj.values()) n += s.size; return n; })();
  const maxEdges = modules.length * (modules.length - 1);
  const density = maxEdges > 0 ? edgeCount / maxEdges : 0;

  // Missing symbols: intra-codebase import where the imported name is
  // not in the target file's exports.
  const exportMap = new Map<string, Set<string>>(); // filePath → exported names
  for (const fa of ctx.fileAnalyses) {
    const names = new Set<string>();
    for (const e of fa.exports) names.add(e.name);
    exportMap.set(fa.filePath, names);
  }
  let missingSymbolCount = 0;
  for (const fa of ctx.fileAnalyses) {
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue; // external or unresolved
      const exports = exportMap.get(imp.resolvedPath);
      if (!exports) continue;
      for (const n of imp.importedNames) {
        if (!exports.has(n)) missingSymbolCount += 1;
      }
    }
  }
  return {
    dependencies: {
      circularCount,
      cycles: sccs as ReadonlyArray<readonly string[]>,
      graphDensity: round(density, 4),
      missingSymbolCount,
    },
  };
}

function resolveModule(imp: { specifier: string; resolvedPath: string | null }, fromPath: string, moduleOf: (p: string) => string | null): string | null {
  // Prefer the engine-resolved path.
  if (imp.resolvedPath) return moduleOf(imp.resolvedPath);
  // Fallback: relative import with proper path normalization.
  if (imp.specifier.startsWith("./") || imp.specifier.startsWith("../")) {
    const base = fromPath.split("/").slice(0, -1).join("/");
    const joined = (base + "/" + imp.specifier).replace(/\/+/g, "/");
    const parts = joined.split("/");
    const out: string[] = [];
    for (const p of parts) {
      if (p === ".") continue;
      if (p === "..") { out.pop(); continue; }
      out.push(p);
    }
    return moduleOf(out.join("/"));
  }
  return null;
}
