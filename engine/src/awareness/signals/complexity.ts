/**
 * Complexity signal: cyclomatic complexity distribution.
 *
 * Aggregates per-function complexity from the language adapters and
 * computes mean, median, p95, max, hotspot count (functions at/above
 * `thresholds.complexityHotspot`), and the top-N most complex functions.
 *
 * EXP324 found complexity has the highest Fisher information (767 —
 * most sensitive to codebase identity). This signal is the single
 * richest "codebase fingerprint" for awareness.
 */
import type { SignalContext, FunctionRecord } from "../types.ts";
import { round, percentile } from "../../shared/numeric-helpers.ts";

export function computeComplexity(ctx: SignalContext) {
  const all = ctx.fileAnalyses.flatMap(fa => fa.functions);
  if (all.length === 0) {
    return { complexity: { mean: 0, median: 0, p95: 0, max: 0, hotspotCount: 0, distribution: [0, 0, 0, 0, 0, 0], topFunctions: [] } };
  }
  const complexities = all.map(f => f.complexity).sort((a, b) => a - b);
  const sum = complexities.reduce((a, b) => a + b, 0);
  const mean = sum / complexities.length;
  const median = percentile(complexities, 0.5);
  const p95 = percentile(complexities, 0.95);
  const max = complexities[complexities.length - 1] ?? 0;
  const threshold = ctx.config.thresholds.complexityHotspot;
  const hotspotCount = complexities.filter(c => c >= threshold).length;
  // Distribution histogram: [1, 2-5, 6-10, 11-15, 16-25, 26+].
  const buckets = [0, 0, 0, 0, 0, 0];
  for (const c of complexities) {
    if (c <= 1) buckets[0]! += 1;
    else if (c <= 5) buckets[1]! += 1;
    else if (c <= 10) buckets[2]! += 1;
    else if (c <= 15) buckets[3]! += 1;
    else if (c <= 25) buckets[4]! += 1;
    else buckets[5]! += 1;
  }
  const top = [...all].sort((a, b) => b.complexity - a.complexity).slice(0, ctx.config.topN.topComplexFunctions);
  return {
    complexity: {
      mean: round(mean, 2),
      median,
      p95,
      max,
      hotspotCount,
      distribution: buckets,
      topFunctions: top as readonly FunctionRecord[],
    },
  };
}
