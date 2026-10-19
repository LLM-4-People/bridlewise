/**
 * Function-level statistics — averages, arity distribution, max/min,
 * Lie-algebra hub (idNum-style arity-0 hub).
 *
 * EXP306 found that the idNum function is the abelian hub of the
 * codebase — the single function that all other functions "commute
 * through" (i.e. its arity-0 signature appears as a sub-signature in
 * the most other functions). The signal approximates the idNum hub as
 * the most-common arity (function parameter count). If many functions
 * share the same arity, that arity is the "abelian hub" — any function
 * can substitute for any other at that arity (a commutative-diagram
 * property).
 *
 * The signal also computes:
 * - meanLength: average function body length (LOC).
 * - medianLength: median body length.
 * - maxLength: longest function (LOC).
 * - arityDistribution: histogram of parameter counts [0,1,2,3,4,5+].
 * - idNumArity: the most-common arity (the Lie-algebra hub).
 * - idNumHubCount: number of functions at the most-common arity.
 * - lieCommutativity: fraction of functions at the most-common arity.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeFunctionStats(ctx: SignalContext) {
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (fns.length === 0) {
    return { functionStats: { meanLength: 0, medianLength: 0, maxLength: 0, arityDistribution: [0, 0, 0, 0, 0, 0], idNumArity: 0, idNumHubCount: 0, lieCommutativity: 0 } };
  }
  const lengths = fns.map(f => f.bodyLines).sort((a, b) => a - b);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const max = lengths.length > 0 ? lengths[lengths.length - 1]! : 0;
  // Arity distribution: [0, 1, 2, 3, 4, 5+].
  const arityDist = [0, 0, 0, 0, 0, 0];
  const arityCount = new Map<number, number>();
  for (const f of fns) {
    const a = f.parameterCount;
    if (a <= 4) arityDist[a] = (arityDist[a] ?? 0) + 1;
    else arityDist[5] = (arityDist[5] ?? 0) + 1;
    arityCount.set(a, (arityCount.get(a) ?? 0) + 1);
  }
  // idNum = most common arity.
  let idNumArity = 0;
  let idNumHubCount = 0;
  for (const [a, c] of arityCount) {
    if (c > idNumHubCount) { idNumHubCount = c; idNumArity = a; }
  }
  const lieCommutativity = fns.length > 0 ? idNumHubCount / fns.length : 0;
  return {
    functionStats: {
      meanLength: round(mean, 2),
      medianLength: median,
      maxLength: max,
      arityDistribution: arityDist,
      idNumArity,
      idNumHubCount,
      lieCommutativity: round(lieCommutativity, 4),
    },
  };
}
