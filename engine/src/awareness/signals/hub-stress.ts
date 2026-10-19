/**
 * Hub stress (EXP14 — codebase is scale-free).
 *
 * EXP14 found that the codebase import graph is scale-free (Gini 0.664)
 * with `integrity.ts`/`errors.ts` as extreme hubs. The "hub stress"
 * signal computes the fan-in / fan-out ratio for the top hub modules:
 * - stressRatio = inDegree / max(1, outDegree)
 * - A high stressRatio (>1) = the module is a "sink" (many importers,
 * few imports) — high blast radius for edits, but low coupling to
 * the rest.
 * - A low stressRatio (<1) = the module is a "source" (many imports,
 * few importers) — depends on many, but few depend on it (likely a
 * leaf feature).
 *
 * The signal emits:
 * - topHubStress: top-5 hub modules with their stressRatio.
 * - meanStress: average stressRatio across all modules.
 * - hubGini: Gini coefficient of inDegrees (the EXP14 Gini=0.664 finding).
 * - isScaleFree: true if hubGini > 0.5 (a power-law-like distribution).
 *
 * `ctx.modules` carry inDegree=0 — the architecture signal computes
 * in/out-degrees locally and does not mutate the records. We re-use
 * `computeArchitecture` to get the hubModules (which have inDegree set).
 */
import type { SignalContext } from "../types.ts";
import { computeArchitecture } from "./architecture.ts";
import { round } from "../../shared/numeric-helpers.ts";

export function computeHubStress(ctx: SignalContext) {
  const archResult = computeArchitecture(ctx);
  const arch = archResult.architecture;
  // Compute in/out-degree for ALL modules (the architecture signal only
  // returns the top-N hubModules, but Gini needs the full distribution).
  const moduleOf = (filePath: string): string | null => {
    let best: string | null = null;
    for (const m of ctx.modules) {
      if (filePath === m.path || filePath.startsWith(m.path + "/") || filePath.startsWith(m.path + "\\")) {
        if (best === null || m.path.length > best.length) best = m.path;
      }
    }
    return best;
  };
  const inAdj = new Map<string, Set<string>>();
  for (const m of ctx.modules) inAdj.set(m.path, new Set());
  for (const fa of ctx.fileAnalyses) {
    const fromMod = moduleOf(fa.filePath);
    if (!fromMod) continue;
    for (const imp of fa.imports) {
      if (!imp.resolvedPath) continue;
      const toMod = moduleOf(imp.resolvedPath);
      if (!toMod || toMod === fromMod) continue;
      inAdj.get(toMod)?.add(fromMod);
    }
  }
  const inDegs = ctx.modules.map(m => inAdj.get(m.path)?.size ?? 0).sort((a, b) => a - b);
  const gini = giniOf(inDegs);
  if (!arch || arch.hubModules.length === 0) {
    return { hubStress: { topHubStress: [], meanStress: 0, hubGini: round(gini, 4), isScaleFree: gini > 0.5 } };
  }
  const stressList = arch.hubModules.map(m => ({
    name: m.name,
    inDegree: m.inDegree,
    outDegree: m.outDegree,
    stressRatio: m.outDegree > 0 ? m.inDegree / m.outDegree : m.inDegree,
  }));
  stressList.sort((a, b) => b.inDegree - a.inDegree);
  const topStress = stressList.slice(0, ctx.config.topN.topHubModules)
    .map(s => ({ name: s.name, inDegree: s.inDegree, outDegree: s.outDegree, stressRatio: Math.round(s.stressRatio * 100) / 100 }));
  const meanStress = stressList.length > 0
    ? stressList.reduce((a, b) => a + b.stressRatio, 0) / stressList.length
    : 0;
  return {
    hubStress: {
      topHubStress: topStress,
      meanStress: round(meanStress, 4),
      hubGini: round(gini, 4),
      isScaleFree: gini > 0.5,
    },
  };
}

function giniOf(sortedArr: number[]): number {
  if (sortedArr.length === 0) return 0;
  const n = sortedArr.length;
  const sum = sortedArr.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let cumWeighted = 0;
  for (let i = 0; i < n; i += 1) cumWeighted += (i + 1) * sortedArr[i]!;
  return (2 * cumWeighted) / (n * sum) - (n + 1) / n;
}
