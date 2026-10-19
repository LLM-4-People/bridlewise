/**
 * Risk signal: functions with high complexity AND high call count.
 *
 * A risk indicator = a function that is BOTH complex (complexity ≥
 * `complexityHotspot`) and highly-called (call-count ≥
 * `riskCallCountThreshold`). These are the prime refactoring targets.
 *
 * The call count is computed from the import graph (count of files
 * that import the function's name).
 */
import type { SignalContext } from "../types.ts";

export function computeRisk(ctx: SignalContext, _prior: { complexity?: { hotspotCount: number } | null }) {
  const threshold = ctx.config.thresholds.riskCallCountThreshold;
  const complexityThreshold = ctx.config.thresholds.complexityHotspot;
  // Count how many files import each name.
  const importCountByName = new Map<string, number>();
  for (const fa of ctx.fileAnalyses) {
    const names = new Set<string>();
    for (const imp of fa.imports) {
      for (const n of imp.importedNames) names.add(n);
    }
    for (const n of names) importCountByName.set(n, (importCountByName.get(n) ?? 0) + 1);
  }
  // Find functions that are both complex and called.
  const risks: Array<{ filePath: string; name: string; complexity: number; callCount: number; riskScore: number }> = [];
  for (const fa of ctx.fileAnalyses) {
    for (const f of fa.functions) {
      if (f.complexity < complexityThreshold) continue;
      const callCount = importCountByName.get(f.name) ?? 0;
      if (callCount < threshold) continue;
      const riskScore = f.complexity * callCount;
      risks.push({ filePath: f.filePath, name: f.name, complexity: f.complexity, callCount, riskScore });
    }
  }
  risks.sort((a, b) => b.riskScore - a.riskScore);
  const topRisks = risks.slice(0, ctx.config.topN.topRiskHotspots);
  return {
    risk: {
      topRisks: topRisks as readonly Readonly<{ filePath: string; name: string; complexity: number; callCount: number; riskScore: number }>[],
    },
  };
}
