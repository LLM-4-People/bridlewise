/**
 * EXP462 diversity/similarity signals (5 signals).
 *
 * - Sørensen-Dice: clone similarity (2|A∩B| / (|A|+|B|)).
 * - Simpson diversity: 1 - Σ p² (probability two random items differ).
 * - Shannon evenness: H / log(S) (equality of distribution).
 * - Gini coefficient: inequality of complexity distribution.
 * - Berger-Parker dominance: largest share.
 */
import type { SignalContext } from "../types.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeSorensenDice(ctx: SignalContext) {
  // Sørensen-Dice between consecutive functions' token sets (clone proxy).
  const fns = ctx.fileAnalyses.flatMap(fa => fa.functions).slice(0, 200);
  if (fns.length < 2) return { sorensenDice: { meanSimilarity: 0, maxSimilarity: 0, clonePairs: 0, totalPairs: 0 } };
  let totalSim = 0, maxSim = 0, clonePairs = 0, total = 0;
  for (let i = 0; i < fns.length - 1; i++) {
    const si = new Set(fns[i]!.tokens);
    const sj = new Set(fns[i + 1]!.tokens);
    let inter = 0;
    for (const t of si) if (sj.has(t)) inter += 1;
    const dice = (2 * inter) / (si.size + sj.size || 1);
    total += 1;
    totalSim += dice;
    if (dice > maxSim) maxSim = dice;
    if (dice >= ctx.config.thresholds.cloneJaccardThreshold) clonePairs += 1;
  }
  return { sorensenDice: { meanSimilarity: round(totalSim / (total || 1), 4), maxSimilarity: round(maxSim, 4), clonePairs, totalPairs: total } };
}

export function computeSimpsonDiversity(ctx: SignalContext) {
  // 1 - Σ p² over module function-counts.
  const moduleFuncs = ctx.modules.map(m => m.functionCount);
  const total = moduleFuncs.reduce((a, b) => a + b, 0);
  if (total === 0) return { simpsonDiversity: { simpson: 0, dominantShare: 0, moduleCount: ctx.modules.length } };
  let sumSq = 0;
  for (const c of moduleFuncs) sumSq += (c / total) ** 2;
  const dominant = Math.max(...moduleFuncs) / total;
  return { simpsonDiversity: { simpson: round(1 - sumSq, 4), dominantShare: round(dominant, 4), moduleCount: ctx.modules.length } };
}

export function computeShannonEvenness(ctx: SignalContext) {
  // J = H / log(S) over module function-counts.
  const moduleFuncs = ctx.modules.map(m => m.functionCount);
  const total = moduleFuncs.reduce((a, b) => a + b, 0);
  const S = moduleFuncs.length;
  if (total === 0 || S === 0) return { shannonEvenness: { evenness: 0, shannon: 0, maxShannon: 0, totalModules: S } };
  let H = 0;
  for (const c of moduleFuncs) {
    if (c === 0) continue;
    const p = c / total;
    H -= p * Math.log2(p);
  }
  const maxH = Math.log2(S);
  return { shannonEvenness: { evenness: round(maxH > 0 ? H / maxH : 0, 4), shannon: round(H, 4), maxShannon: round(maxH, 4), totalModules: S } };
}

export function computeGiniCoefficient(ctx: SignalContext) {
  // Gini of function complexity distribution.
  const complexities = ctx.fileAnalyses.flatMap(fa => fa.functions).map(f => f.complexity).sort((a, b) => a - b);
  const n = complexities.length;
  if (n === 0) return { giniCoefficient: { gini: 0, meanComplexity: 0, maxComplexity: 0, totalFunctions: 0 } };
  const sum = complexities.reduce((a, b) => a + b, 0);
  let cumWeighted = 0;
  for (let i = 0; i < n; i++) cumWeighted += (i + 1) * complexities[i]!;
  const gini = (2 * cumWeighted) / (n * sum) - (n + 1) / n;
  return {
    giniCoefficient: {
      gini: round(Math.max(0, gini), 4),
      meanComplexity: round(sum / n, 4),
      maxComplexity: complexities[n - 1] ?? 0,
      totalFunctions: n,
    },
  };
}

export function computeBergerParker(ctx: SignalContext) {
  // Berger-Parker = max share = n_max / N.
  const moduleFuncs = ctx.modules.map(m => ({ name: m.name, count: m.functionCount }));
  if (moduleFuncs.length === 0) return { bergerParker: { dominance: 0, dominantModule: "", dominantShare: 0 } };
  moduleFuncs.sort((a, b) => b.count - a.count);
  const total = moduleFuncs.reduce((s, m) => s + m.count, 0) || 1;
  const dominant = moduleFuncs[0]!;
  return { bergerParker: { dominance: round(dominant.count / total, 4), dominantModule: dominant.name, dominantShare: round(dominant.count / total, 4) } };
}
