/**
 * Architecture signal: module count, hub modules (PageRank), edge count,
 * graph density, and architecture type (monolith/modular/microservices).
 *
 * Architecture type is computed from the structure of the module
 * dependency graph (NOT a hardcoded label):
 * - "monolith" if < 3 modules OR mean modules/file > 0.5 (one big dir).
 * - "microservices" if there are top-level "services" markers (dirs named
 * `service`, `services`, `app`, `apps`) AND ≥ 3 of them.
 * - "modular" otherwise.
 *
 * The "service" markers are NAME patterns observed in the codebase, not
 * a hardcoded category list — they are the literal directory names found
 * by the walker. (The list of name patterns is in the config so callers
 * can extend it; the default set is `service`, `services`, `app`, `apps`,
 * `api`, `worker`, `worker-pool`.)
 *
 * PageRank is computed on the module-level import graph. EXP208 found
 * PageRank weights by caller importance — useful for hub detection.
 */
import type { SignalContext, ModuleRecord } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

const SERVICE_NAME_PATTERNS = ["service", "services", "app", "apps", "api", "worker", "worker-pool"] as const;

export function computeArchitecture(ctx: SignalContext) {
  const modules = ctx.modules;
  if (modules.length === 0) {
    return { architecture: { type: "monolith" as const, hubModules: [], edgeCount: 0, density: 0 } };
  }
  // Build module-level import edges from file-level imports.
  const moduleOf = (filePath: string): string | null => {
    // Match the longest module path that is a prefix of filePath.
    let best: string | null = null;
    for (const m of modules) {
      if (filePath === m.path || filePath.startsWith(m.path + "/") || filePath.startsWith(m.path + "\\")) {
        if (best === null || m.path.length > best.length) best = m.path;
      }
    }
    return best;
  };

  const edges = new Map<string, Set<string>>(); // "from->to"
  const outAdj = new Map<string, Set<string>>();
  const inAdj = new Map<string, Set<string>>();
  for (const m of modules) {
    outAdj.set(m.path, new Set());
    inAdj.set(m.path, new Set());
  }
  for (const fa of ctx.fileAnalyses) {
    const fromMod = moduleOf(fa.filePath);
    if (!fromMod) continue;
    for (const imp of fa.imports) {
      // Only count intra-codebase imports (resolvedPath or relative).
      const toMod = resolveModule(imp, fa.filePath, moduleOf);
      if (!toMod || toMod === fromMod) continue;
      const key = fromMod + "->" + toMod;
      if (!edges.has(key)) edges.set(key, new Set());
      edges.get(key)!.add(imp.specifier);
      outAdj.get(fromMod)!.add(toMod);
      inAdj.get(toMod)!.add(fromMod);
    }
  }
  const edgeCount = edges.size;
  const moduleCount = modules.length;
  const maxEdges = moduleCount * (moduleCount - 1);
  const density = maxEdges > 0 ? edgeCount / maxEdges : 0;

  // PageRank.
  const pagerank = new Map<string, number>();
  for (const m of modules) pagerank.set(m.path, 1 / moduleCount);
  const damping = ctx.config.thresholds.pagerankDamping;
  const iterations = ctx.config.thresholds.pagerankIterations;
  for (let it = 0; it < iterations; it += 1) {
    const next = new Map<string, number>();
    let danglingSum = 0;
    for (const m of modules) {
      const out = outAdj.get(m.path)!;
      if (out.size === 0) danglingSum += pagerank.get(m.path) ?? 0;
    }
    for (const m of modules) {
      let s = (1 - damping) / moduleCount;
      s += damping * danglingSum / moduleCount;
      const inN = inAdj.get(m.path)!;
      for (const fromMod of inN) {
        const fromScore = pagerank.get(fromMod) ?? 0;
        const fromOut = outAdj.get(fromMod)!.size;
        if (fromOut > 0) s += damping * fromScore / fromOut;
      }
      next.set(m.path, s);
    }
    let maxDelta = 0;
    for (const [k, v] of next) maxDelta = Math.max(maxDelta, Math.abs(v - (pagerank.get(k) ?? 0)));
    for (const [k, v] of next) pagerank.set(k, v);
    if (maxDelta < ctx.config.thresholds.pagerankTolerance) break;
  }

  // Annotate modules with pagerank + degrees.
  const annotated: ModuleRecord[] = modules.map(m => ({
    ...m,
    pagerank: pagerank.get(m.path) ?? 0,
    inDegree: inAdj.get(m.path)!.size,
    outDegree: outAdj.get(m.path)!.size,
  }));
  const hubModules = [...annotated].sort((a, b) => b.pagerank - a.pagerank).slice(0, ctx.config.topN.topHubModules);

  // Architecture type.
  let type: "monolith" | "modular" | "microservices";
  const servicePatterns: readonly string[] = SERVICE_NAME_PATTERNS;
  const serviceModules = annotated.filter(m => servicePatterns.includes(m.name));
  if (moduleCount < 3) type = "monolith";
  else if (serviceModules.length >= 3) type = "microservices";
  else type = "modular";

  return {
    architecture: {
      type,
      hubModules: hubModules as readonly ModuleRecord[],
      edgeCount,
      density: round(density, 4),
    },
    // Also return annotated modules so other signals (hotspots, risk) can reuse.
    _annotatedModules: annotated,
  };
}

function resolveModule(imp: { specifier: string; resolvedPath: string | null }, fromPath: string, moduleOf: (p: string) => string | null): string | null {
  // Prefer the engine-resolved path (handles.js→.ts, workspace packages, proper../ normalization).
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
