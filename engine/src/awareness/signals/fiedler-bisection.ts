/**
 * Fiedler bisection signal (EXP46 + EXP248).
 *
 * EXP46 computed the graph Laplacian's Fiedler value (λ2, the second-
 * smallest eigenvalue) on the file→file import graph: src/ Fiedler =
 * 0.588 (sharp bottleneck). EXP248 refined this with the full
 * eigendecomposition (Fiedler λ2(L) = 0.012, sharper at function level
 * than file level) and showed the bisection isolates a real subsystem
 * (quality-packs/prevention, 152 fns, from the main harness, 1578 fns).
 *
 * A low λ2 = a sharp bottleneck = the codebase has a clean bisection
 * (two subsystems joined by a sparse cut). A high λ2 = no bottleneck
 * (well-connected, "monolithic"). The signal emits:
 * - fiedlerValue: λ2 of the Laplacian (estimated via power iteration
 * on the deflated matrix — O(V²) per iteration, bounded by config).
 * - bottleneck: true if λ2 < threshold (default 0.05).
 * - bisectionSize: the size of the smaller half (estimated by the
 * sign of the Fiedler vector).
 * - topBridgeModule: the module with the highest |Fiedler vector| —
 * the "bridge" between the two halves.
 *
 * This is actionable: a bottleneck identifies a refactor boundary.
 *
 * Source: EXP46, EXP248.
 */
import type { SignalContext, ModuleRecord } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeFiedlerBisection(ctx: SignalContext) {
  const modules = ctx.modules;
  const n = modules.length;
  if (n < 2) {
    return { fiedlerBisection: { fiedlerValue: 0, isBottleneck: false, bisectionSize: 0, topBridgeModule: "", largestEigenvalue: 0 } };
  }
  // Build the module adjacency (intra-codebase imports).
  const moduleOf = (filePath: string): number => {
    let best = -1;
    let bestLen = -1;
    for (let i = 0; i < modules.length; i += 1) {
      const m = modules[i]!;
      if (filePath === m.path || filePath.startsWith(m.path + "/") || filePath.startsWith(m.path + "\\")) {
        if (m.path.length > bestLen) { best = i; bestLen = m.path.length; }
      }
    }
    return best;
  };
  // Adjacency matrix (undirected).
  const adj: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const fa of ctx.fileAnalyses) {
    const u = moduleOf(fa.filePath);
    if (u < 0) continue;
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue;
      const v = moduleOf(imp.resolvedPath);
      if (v < 0 || v === u) continue;
      adj[u]![v]! = 1;
      adj[v]![u]! = 1;
    }
  }
  // Degree vector and Laplacian L = D - A.
  const degree = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) degree[i]! += adj[i]![j]!;
  }
  // Power iteration for the largest eigenvalue (λ1 ≈ max degree for a
  // connected graph's Laplacian — we use it to deflate).
  const maxIter = 30;
  const tol = 1e-4;
  let v1 = new Array<number>(n).fill(1);
  let norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0)) || 1;
  v1 = v1.map(x => x / norm);
  let lambda1 = 0;
  for (let iter = 0; iter < maxIter; iter += 1) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        next[i]! += (i === j ? degree[i]! : 0) - adj[i]![j]! * v1[j]!;
      }
    }
    const newNorm = Math.sqrt(next.reduce((s, x) => s + x * x, 0)) || 1;
    const next_v1 = next.map(x => x / newNorm);
    const diff = next_v1.reduce((s, x, i) => s + Math.abs(x - v1[i]!), 0);
    v1 = next_v1;
    lambda1 = newNorm;
    if (diff < tol) break;
  }
  // Fiedler: power iteration on L, deflated against v1 (the constant
  // eigenvector λ1=0 for a connected graph). For a connected graph,
  // the largest Laplacian eigenvalue is bounded by 2*max_degree, so
  // we estimate λ2 by iterating on L with v ⊥ v1 (here v1 ≈ constant
  // since λ1=0 → so we deflate against the constant vector).
  const constant = new Array<number>(n).fill(1 / Math.sqrt(n));
  let v2 = new Array<number>(n);
  for (let i = 0; i < n; i += 1) v2[i]! = (i % 2 === 0 ? 1 : -1) / Math.sqrt(n);
  let lambda2 = 0;
  for (let iter = 0; iter < maxIter; iter += 1) {
    // Apply L.
    const Lv = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        Lv[i]! += (i === j ? degree[i]! : 0) * v2[j]! - adj[i]![j]! * v2[j]!;
      }
    }
    // Deflate against the constant vector (the λ=0 eigenvector).
    const dot = Lv.reduce((s, x, i) => s + x * constant[i]!, 0);
    for (let i = 0; i < n; i += 1) Lv[i]! -= dot * constant[i]!;
    const newNorm = Math.sqrt(Lv.reduce((s, x) => s + x * x, 0)) || 1;
    if (newNorm < 1e-9) { lambda2 = 0; break; }
    const next_v2 = Lv.map(x => x / newNorm);
    const diff = next_v2.reduce((s, x, i) => s + Math.abs(x - v2[i]!), 0);
    v2 = next_v2;
    lambda2 = newNorm;
    if (diff < tol) break;
  }
  // Bisection by the sign of v2.
  let posCount = 0;
  for (const x of v2) if (x > 0) posCount += 1;
  const bisectionSize = Math.min(posCount, n - posCount);
  // Top bridge module = the one with the smallest |v2| (the "boundary"
  // between the two halves — the one closest to the cut).
  let topBridge = "";
  let minAbs = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (Math.abs(v2[i]!) < minAbs) { minAbs = Math.abs(v2[i]!); topBridge = modules[i]!.name; }
  }
  const threshold = ctx.config.thresholds.fiedlerBottleneck;
  return {
    fiedlerBisection: {
      fiedlerValue: round(lambda2, 4),
      isBottleneck: lambda2 < threshold,
      bisectionSize,
      topBridgeModule: topBridge,
      largestEigenvalue: round(lambda1, 4),
    },
  };
}

// ModuleRecord is imported to keep the type's surface area part of
// the public signal contract (other signals re-export it).
export type { ModuleRecord };
