/**
 * Ollivier-Ricci curvature (EXP322).
 *
 * EXP322 found that graph curvature identifies "bridges" — modules that
 * connect otherwise-disparate parts of the codebase. We compute a
 * simplified Ollivier-Ricci curvature on the module-level import graph:
 * for each edge (u,v), the curvature is
 * κ(u,v) = 1 - d(u,v) - d(u,v)
 * where d(x,y) is the lazy-random-walk Earth Mover's Distance (EMD)
 * between the one-step neighborhoods of u and v. A positive κ means
 * the edge is a "bridge" (curving toward more-connected regions); a
 * negative κ means the edge is a "bottleneck" (curving away).
 *
 * For a fast deterministic approximation, we use:
 * κ(u,v) ≈ 1 - |N(u) Δ N(v)| / (|N(u)| + |N(v)|)
 * where N(x) is the set of modules x imports + modules that import x,
 * and Δ is the symmetric difference. This is the Jaccard-based curvature
 * proxy: a high κ means u and v have very similar neighborhoods (so they
 * are "redundant" — low curvature variance); a low/negative κ means they
 * are bridges.
 *
 * The signal emits:
 * - meanCurvature: average κ across all edges.
 * - minCurvature: the most "bridge-like" edge's κ.
 * - bridgeCount: edges with κ < bridgeThreshold (default 0.0).
 * - hubCount: edges with κ > hubThreshold (default 0.5).
 */
import type { SignalContext, ModuleRecord } from "../types.ts";
import { computeArchitecture } from "./architecture.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeRicciCurvature(ctx: SignalContext) {
  // Re-use the architecture signal's module graph.
  const archResult = computeArchitecture(ctx);
  const arch = archResult.architecture;
  if (!arch || arch.edgeCount === 0) {
    return { ricciCurvature: { meanCurvature: 0, minCurvature: 0, bridgeCount: 0, hubCount: 0, edgeCount: 0 } };
  }
  // Build the module-level adjacency from file imports.
  const moduleEdges = buildModuleEdges(ctx);
  if (moduleEdges.length === 0) {
    return { ricciCurvature: { meanCurvature: 0, minCurvature: 0, bridgeCount: 0, hubCount: 0, edgeCount: 0 } };
  }
  // Build adjacency maps.
  const neighbors = new Map<string, Set<string>>();
  for (const e of moduleEdges) {
    if (!neighbors.has(e.a)) neighbors.set(e.a, new Set());
    if (!neighbors.has(e.b)) neighbors.set(e.b, new Set());
    neighbors.get(e.a)!.add(e.b);
    neighbors.get(e.b)!.add(e.a);
  }
  const bridgeThreshold = ctx.config.thresholds.ricciBridgeThreshold;
  const hubThreshold = ctx.config.thresholds.ricciHubThreshold;
  let sum = 0;
  let min = 1;
  let bridges = 0;
  let hubs = 0;
  for (const e of moduleEdges) {
    const na = neighbors.get(e.a) ?? new Set<string>();
    const nb = neighbors.get(e.b) ?? new Set<string>();
    // Jaccard of (N(u) ∪ {u}) and (N(v) ∪ {v}) — including the nodes themselves
    // to handle the degenerate case where u, v share all neighbors.
    const A = new Set(na); A.add(e.a);
    const B = new Set(nb); B.add(e.b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter += 1;
    const u = A.size + B.size - inter;
    const jacc = u === 0 ? 0 : inter / u;
    // Curvature κ = 1 - W1(d_u, d_v), with W1 ≈ 1 - jaccard (lazy random walk).
    const kappa = 2 * jacc - 1;
    sum += kappa;
    if (kappa < min) min = kappa;
    if (kappa < bridgeThreshold) bridges += 1;
    if (kappa > hubThreshold) hubs += 1;
  }
  const mean = sum / moduleEdges.length;
  return {
    ricciCurvature: {
      meanCurvature: round(mean, 4),
      minCurvature: round(min, 4),
      bridgeCount: bridges,
      hubCount: hubs,
      edgeCount: moduleEdges.length,
    },
  };
}

/** Build the module-level edge list (deduplicated, undirected). */
function buildModuleEdges(ctx: SignalContext): Array<{ a: string; b: string }> {
  const moduleOf = new Map<string, string>();
  for (const m of ctx.modules) {
    for (const fa of ctx.fileAnalyses) {
      if (fa.filePath.startsWith(m.path + "/") || fa.filePath === m.path) {
        moduleOf.set(fa.filePath, m.name);
      }
    }
  }
  const edges = new Set<string>();
  const out: Array<{ a: string; b: string }> = [];
  for (const fa of ctx.fileAnalyses) {
    const aMod = moduleOf.get(fa.filePath) ?? "(unknown)";
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue;
      const bMod = moduleOf.get(imp.resolvedPath) ?? "(unknown)";
      if (aMod === bMod) continue;
      const key = aMod < bMod ? `${aMod}|${bMod}` : `${bMod}|${aMod}`;
      if (edges.has(key)) continue;
      edges.add(key);
      out.push({ a: aMod, b: bMod });
    }
  }
  return out;
}

/** Suppress unused re-export warning. */
export type { ModuleRecord };
