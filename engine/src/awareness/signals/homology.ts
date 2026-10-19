/**
 * Homology signal (EXP51 + EXP101 + EXP190).
 *
 * EXP51 applied Vietoris-Rips persistent homology to the function-token
 * point cloud: H0 (connected components) finds outlier functions, H1
 * (1-cycles) finds DRY candidates (loops in the similarity graph =
 * hidden clones). EXP101 simplified H1 to triangle enumeration (3
 * mutually-similar functions where one pair has Jaccard < 0.9 — a
 * hidden clone candidate). EXP190 confirmed H² doesn't add anything
 * H0/H1 misses.
 *
 * For awareness, we compute a SIMPLIFIED homology on the clone graph:
 * - h0: number of connected components in the clone-graph (where
 * edges = Jaccard ≥ threshold). h0 > 1 = isolated clone clusters
 * (e.g. parallel implementations in different modules).
 * - h1: number of independent 1-cycles (triangles where one edge
 * has J < threshold — the "missing witness" that signals a hidden
 * DRY violation). EXP101 found 1867 such candidates on src/.
 *
 * Actionable: h1 count = potential hidden DRY violations to review.
 *
 * Source: EXP51, EXP101, EXP190.
 */
import type { SignalContext } from "../types.ts";
import { buildCloneGraph, type ClonePair } from "./clone-graph.ts";

export function computeHomology(ctx: SignalContext) {
  const allFns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (allFns.length < 3) {
    return { homology: { h0: 0, h1: 0, h0Components: 0, h1Candidates: 0 } };
  }
  const graph = buildCloneGraph(ctx);
  const threshold = ctx.config.thresholds.cloneJaccardThreshold;
  // H0 = connected components of the "edge = Jaccard >= threshold" graph.
  const parent = new Array<number>(graph.functions.length).fill(0).map((_, i) => i);
  const find = (x: number): number => parent[x] === x ? x : (parent[x]! = find(parent[x]!));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (const p of graph.pairs) {
    if (p.jaccard >= threshold) union(p.a, p.b);
  }
  const componentOf = new Set<number>();
  for (let i = 0; i < parent.length; i += 1) componentOf.add(find(i));
  const h0 = componentOf.size;
  // H1 = triangles (a,b,c) where at least 2 edges are >= threshold and
  // the third is < threshold. These are "almost-cliques" — the missing
  // edge is a hidden DRY candidate.
  const adj = new Map<number, Set<number>>();
  const weakAdj = new Map<number, Set<number>>();
  for (let i = 0; i < graph.functions.length; i += 1) {
    adj.set(i, new Set());
    weakAdj.set(i, new Set());
  }
  for (const p of graph.pairs) {
    if (p.jaccard >= threshold) {
      adj.get(p.a)!.add(p.b);
      adj.get(p.b)!.add(p.a);
    } else if (p.jaccard >= threshold * 0.5) {
      weakAdj.get(p.a)!.add(p.b);
      weakAdj.get(p.b)!.add(p.a);
    }
  }
  let h1 = 0;
  const seen = new Set<string>();
  for (const pair of graph.pairs) {
    if (pair.jaccard < threshold) continue;
    const a = pair.a;
    const b = pair.b;
    // Common neighbors in the strong-adjacency graph.
    const aNeigh = adj.get(a)!;
    const bNeigh = adj.get(b)!;
    for (const c of aNeigh) {
      if (c === a || c === b) continue;
      if (!bNeigh.has(c)) continue;
      // Triangle (a,b,c) all strong — a clique, not a cycle.
      // Skip if we've seen this triangle.
      const key = [a, b, c].sort((x, y) => x - y).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      // Check if any edge of this triangle is "weak" (J < threshold but
      // J >= threshold*0.5 — a near-miss edge that the H1 cycle wraps).
      const ac = graph.pairs.find(p => (p.a === a && p.b === c) || (p.a === c && p.b === a));
      const bc = graph.pairs.find(p => (p.a === b && p.b === c) || (p.a === c && p.b === b));
      if (ac && bc) {
        if (ac.jaccard < threshold || bc.jaccard < threshold) {
          h1 += 1;
        }
      }
    }
  }
  // h1 / 6 = number of distinct triangles (each triangle counted 6×).
  h1 = Math.floor(h1 / 6);
  return {
    homology: {
      h0,
      h1,
      h0Components: h0,
      h1Candidates: h1,
    },
  };
}

// ClonePair re-exported for typing consistency.
export type { ClonePair };
