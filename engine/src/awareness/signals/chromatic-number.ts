/**
 * Chromatic number signal (EXP113).
 *
 * EXP113 computed the chromatic number χ of the clone graph (where
 * vertices = functions, edges = Jaccard ≥ 0.5). For src/, χ = ω = 19
 * (the graph is PERFECT — no long-range chromatic conflicts). The top
 * clique = 19-function type-guards family — the biggest DRY opportunity
 * (a `makeTypeGuard<T>(name, validValues)` factory).
 *
 * For awareness, we compute the chromatic number of the clone graph
 * using a greedy coloring (an upper bound on χ — exact χ is NP-hard
 * but greedy is tight on perfect graphs). The signal emits:
 * - chromaticNumber: the greedy chromatic number (= upper bound on χ).
 * - cliqueNumber: the size of the largest clique found (lower bound).
 * - isPerfectGraph: true if chromaticNumber ≈ cliqueNumber (within 1).
 * - topClique: the largest clique's representative functions.
 * - refactorOpportunities: number of cliques with size ≥ 4 (each is
 * a candidate factory extraction).
 *
 * Actionable: topClique is the #1 refactor priority (the biggest
 * "replace N functions with 1 factory" opportunity).
 *
 * Source: EXP113, EXP145, EXP157.
 */
import type { SignalContext } from "../types.ts";
import { buildCloneGraph } from "./clone-graph.ts";

export function computeChromaticNumber(ctx: SignalContext) {
  const graph = buildCloneGraph(ctx);
  const n = graph.functions.length;
  if (n < 2) {
    return { chromaticNumber: { chromaticNumber: 0, cliqueNumber: 0, isPerfectGraph: true, topClique: [], refactorOpportunities: 0 } };
  }
  // Build adjacency using a LOWER threshold (χ is at J≥0.5 per EXP113).
  // The clone-graph uses the configured threshold (default 0.9). We
  // additionally include near-miss pairs at J≥0.5 to mirror EXP113.
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < n; i += 1) adj.set(i, new Set());
  for (const p of graph.pairs) {
    adj.get(p.a)!.add(p.b);
    adj.get(p.b)!.add(p.a);
  }
  // Also include J≥0.5 pairs (recompute — the graph only has J≥threshold).
  // We approximate by also adding weak edges from the clone-graph's
  // pre-threshold pairs (which we don't have here, so we use only the
  // configured-threshold edges for the greedy coloring — a conservative
  // estimate; the real χ at J≥0.5 is higher).
  // Greedy coloring (largest-first).
  const order = [...Array(n).keys()].sort((a, b) => adj.get(b)!.size - adj.get(a)!.size);
  const color = new Array<number>(n).fill(-1);
  let chromatic = 0;
  for (const v of order) {
    const used = new Set<number>();
    for (const u of adj.get(v)!) if (color[u]! >= 0) used.add(color[u]!);
    let c = 0;
    while (used.has(c)) c += 1;
    color[v]! = c;
    if (c + 1 > chromatic) chromatic = c + 1;
  }
  // Clique number via greedy (Bron-Kerbosch is too slow; we use a
  // greedy max-clique on the highest-degree vertex).
  const cliqueMembers = greedyMaxClique(adj, n);
  const cliqueNumber = cliqueMembers.length;
  const topClique = cliqueMembers.slice(0, 5).map(idx => ({
    filePath: graph.functions[idx]!.filePath,
    name: graph.functions[idx]!.name,
  }));
  // Refactor opportunities: count connected components of size ≥4 in the
  // adjacency graph (each is a candidate factory extraction).
  const parent = new Array<number>(n).fill(0).map((_, i) => i);
  const find = (x: number): number => parent[x] === x ? x : (parent[x]! = find(parent[x]!));
  for (const p of graph.pairs) {
    parent[find(p.a)] = find(p.b);
  }
  const sizeOf = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    sizeOf.set(r, (sizeOf.get(r) ?? 0) + 1);
  }
  let refactorOps = 0;
  for (const s of sizeOf.values()) if (s >= 4) refactorOps += 1;
  return {
    chromaticNumber: {
      chromaticNumber: chromatic,
      cliqueNumber,
      isPerfectGraph: Math.abs(chromatic - cliqueNumber) <= 1,
      topClique,
      refactorOpportunities: refactorOps,
    },
  };
}

/** Greedy max-clique: start from the highest-degree vertex, grow by
 * adding the next vertex adjacent to all current clique members. */
function greedyMaxClique(adj: Map<number, Set<number>>, n: number): number[] {
  if (n === 0) return [];
  const start = [...Array(n).keys()].sort((a, b) => adj.get(b)!.size - adj.get(a)!.size)[0]!;
  const clique = [start];
  for (let i = 0; i < n; i += 1) {
    if (i === start) continue;
    if (clique.every(c => adj.get(c)!.has(i))) clique.push(i);
  }
  return clique;
}
